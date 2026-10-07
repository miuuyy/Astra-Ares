import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  DesktopIntegration,
  desktopConfig,
  readDesktopReceipt,
} from "../src/desktop.mjs";
import { DESKTOP_FLAGS, withDesktopConfig } from "../src/desktop-config.mjs";

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ares-desktop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "User's $HOME & profile");
  const env = {
    ARES_CONFIG: join(dir, "private.json"),
    ARES_HOME: join(dir, "custom-data"),
  };
  const binary = join(dir, "native-codex");
  writeFileSync(
    env.ARES_CONFIG,
    JSON.stringify({
      provider: "local",
      baseUrl: "http://127.0.0.1:8890",
      decisionModel: "fixture",
      contextTokenLimit: 7000,
      codexBinary: binary,
    }),
  );
  const runtime = {
    env: {
      CODEX_CLI_PATH: "/previous/codex",
      CODEX_HOME: join(dir, "previous-home"),
    },
    flags: { step_model_switching: null, reasoning_effort_override: false },
    version: 0,
    loaded: false,
    commands: [],
    ...options,
  };
  const exec = (command, args) => {
    runtime.commands.push([command, ...args]);
    if (command === "/usr/bin/open") return "";
    assert.equal(command, "/bin/launchctl");
    const [action, key, value] = args;
    if (action === "getenv") return runtime.env[key] ?? "";
    if (action === "setenv") {
      if (runtime.failSet === key)
        throw Object.assign(new Error("fixture setenv failure"), { status: 5 });
      runtime.env[key] = value;
      return "";
    }
    if (action === "unsetenv") {
      delete runtime.env[key];
      return "";
    }
    if (action === "print") {
      if (!runtime.loaded)
        throw Object.assign(new Error("not loaded"), { status: 113 });
      return "loaded";
    }
    if (action === "bootstrap") {
      if (runtime.failBootstrap)
        throw Object.assign(new Error("fixture failure"), { status: 5 });
      runtime.loaded = true;
      return "";
    }
    if (action === "bootout") {
      runtime.loaded = false;
      return "";
    }
    throw new Error(`Unexpected launchctl action ${action}`);
  };
  const configSession = async (_binary, _home, action) =>
    action({
      read: async () => ({
        flags: { ...runtime.flags },
        effective: { ...runtime.flags },
        version: runtime.version,
      }),
      write: async (values, before) => {
        assert.equal(before.version, runtime.version);
        Object.assign(runtime.flags, values);
        runtime.version++;
        return {
          flags: { ...runtime.flags },
          effective: { ...runtime.flags },
          version: runtime.version,
        };
      },
    });
  const settings = {
    userHome: home,
    env,
    platform: "darwin",
    uid: 501,
    exec,
    configSession,
    verify: (path) => assert.equal(path, binary),
  };
  const manager = new DesktopIntegration(settings);
  return { dir, home, env, binary, runtime, settings, manager };
}

test("desktop installation pins paths, survives a GUI environment and restores prior ownership", async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.runtime);
  const profile = join(f.dir, "Desktop profile");
  const result = await f.manager.install({ codexHome: profile });
  assert(
    result.filesMatch && result.environmentMatches && result.loginAgentLoaded,
  );
  const state = readDesktopReceipt(f.manager.paths.state);
  assert.equal(state.configPath, f.env.ARES_CONFIG);
  assert.equal(state.dataHome, f.env.ARES_HOME);
  assert.equal(state.codexHome, profile);
  assert.equal(desktopConfig(state).paths.config, f.env.ARES_CONFIG);
  const plist = readFileSync(f.manager.paths.plist, "utf8");
  assert(plist.includes(state.nodePath));
  assert(plist.includes("User's $HOME &amp; profile"));
  // After login, neither the terminal's ARES_* settings nor its PATH is available.
  f.runtime.env = {};
  const gui = new DesktopIntegration({ ...f.settings, env: {} });
  await gui.activate();
  assert.equal(gui.status().configPath, f.env.ARES_CONFIG);
  assert.equal(f.runtime.env.CODEX_HOME, profile);
  await f.manager.install();
  assert.deepEqual(
    readDesktopReceipt(f.manager.paths.state).previous,
    before.env,
  );
  const app = join(f.dir, "Example.app");
  mkdirSync(app);
  await gui.open(app);
  assert.deepEqual(f.runtime.commands.at(-1), ["/usr/bin/open", "-a", app]);
  assert.equal(readDesktopReceipt(gui.paths.state).codexHome, profile);
  await gui.uninstall();
  assert.deepEqual(f.runtime.env, before.env);
  assert.deepEqual(f.runtime.flags, before.flags);
  assert(!f.runtime.loaded);
  assert(!existsSync(gui.paths.state));
  assert(existsSync(f.env.ARES_CONFIG));
});

test("uninstall preserves external changes and works after the Ares config is removed", async (t) => {
  const f = fixture(t, { env: {} });
  await f.manager.install();
  f.runtime.env.CODEX_CLI_PATH = "/another/tool";
  f.runtime.flags.reasoning_effort_override = false;
  rmSync(f.env.ARES_CONFIG);
  const result = await f.manager.uninstall();
  assert.deepEqual(result.preservedExternalOverrides, ["CODEX_CLI_PATH"]);
  assert.equal(f.runtime.env.CODEX_CLI_PATH, "/another/tool");
  assert.equal(f.runtime.env.CODEX_HOME, undefined);
  assert.deepEqual(f.runtime.flags, {
    step_model_switching: null,
    reasoning_effort_override: false,
  });
});

test("failed installation rolls back launch settings, feature flags and owned files", async (t) => {
  const f = fixture(t, { failBootstrap: true });
  const before = structuredClone(f.runtime);
  await assert.rejects(f.manager.install(), /bootstrap failed/);
  assert.deepEqual(f.runtime.env, before.env);
  assert.deepEqual(f.runtime.flags, before.flags);
  assert(!existsSync(f.manager.paths.state));
  assert(!existsSync(f.manager.paths.plist));
  assert(!existsSync(f.manager.paths.launcher));
});

test("foreign files, changed launch overrides and competing installs fail explicitly", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(f.manager.paths.plist, "foreign file");
  await assert.rejects(f.manager.install(), /refusing to overwrite/);
  assert.equal(readFileSync(f.manager.paths.plist, "utf8"), "foreign file");
  rmSync(f.manager.paths.plist);
  await f.manager.install();
  await assert.rejects(
    f.manager.install({ codexHome: join(f.dir, "other") }),
    /different desktop installation/,
  );
  f.runtime.env.CODEX_CLI_PATH = "/external/change";
  await assert.rejects(f.manager.activate(), /changed outside Ares/);
  writeFileSync(f.manager.paths.launcher, "external edit");
  await assert.rejects(f.manager.uninstall(), /leaving it untouched/);
  assert.equal(readFileSync(f.manager.paths.launcher, "utf8"), "external edit");
  mkdirSync(f.manager.paths.lock);
  await assert.rejects(f.manager.install(), /already running/);
});

test("desktop rejects shell-only credentials without persisting secrets or changing launch state", async (t) => {
  const f = fixture(t);
  writeFileSync(
    f.env.ARES_CONFIG,
    JSON.stringify({
      provider: "openrouter",
      apiKeyEnv: "PRIVATE_KEY",
      codexBinary: f.binary,
    }),
  );
  const before = { ...f.runtime.env };
  await assert.rejects(f.manager.install(), /shell-only apiKeyEnv/);
  assert.deepEqual(f.runtime.env, before);
  assert(!existsSync(f.manager.paths.state));
});

test("uninstall and reinstall preserve activation logs", async (t) => {
  const f = fixture(t);
  await f.manager.install();
  writeFileSync(f.manager.paths.log, "fixture diagnostic\n");
  await f.manager.uninstall();
  assert.equal(
    readFileSync(f.manager.paths.log, "utf8"),
    "fixture diagnostic\n",
  );
  await f.manager.install();
  assert(f.manager.status().installed);
});

test(
  "generated launcher uses its saved config with minimal PATH and clean protocol output",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    writeFileSync(
      f.binary,
      `#!${process.execPath}
// CODEX_STEP_CONTROLLER_CONTEXT_V3 Jev requires its bridge Astra Ares Luna Ares Sol Ares
if(process.argv.includes('--version')) console.log('codex-cli 0.155.0-alpha.9.2');
else console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,socket:!!process.env.CODEX_STEP_CONTROLLER_SOCKET,key:process.env.ARES_LOCAL_API_KEY}));
`,
      { mode: 0o700 },
    );
    writeFileSync(join(f.dir, "codex-code-mode-host"), "fixture");
    const profile = join(f.dir, "Selected profile");
    mkdirSync(profile);
    writeFileSync(join(profile, "config.toml"), "# unchanged by runtime\n");
    await f.manager.install({ codexHome: profile });
    const literal = "quotes ' and $(never-run)";
    const result = spawnSync(
      f.manager.paths.launcher,
      ["exec", "--", literal],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: f.home,
          ARES_CONFIG: "/wrong/config",
          ARES_LOCAL_API_KEY: "fixture-secret",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const message = JSON.parse(result.stdout);
    assert.equal(message.home, profile);
    assert(message.socket);
    assert.equal(message.key, undefined);
    assert.deepEqual(message.args.slice(-3), ["exec", "--", literal]);
    assert.equal(
      readFileSync(join(profile, "config.toml"), "utf8"),
      "# unchanged by runtime\n",
    );
    assert(!existsSync(join(profile, "auth.json")));
    const missing = spawnSync(
      process.execPath,
      [
        resolve("bin/ares-desktop.mjs"),
        join(f.dir, "missing.json"),
        "run",
        "--version",
      ],
      { encoding: "utf8" },
    );
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(
      missing.stderr,
      /Cannot read the desktop installation receipt/,
    );
  },
);

test("desktop commands report their platform requirement", () => {
  assert.throws(
    () => new DesktopIntegration({ platform: "win32" }),
    /requires macOS/,
  );
  assert.throws(
    () => new DesktopIntegration({ platform: "linux" }),
    /requires macOS/,
  );
  assert.deepEqual(DESKTOP_FLAGS, [
    "step_model_switching",
    "reasoning_effort_override",
  ]);
});

test("activation rolls back a partially applied environment", async (t) => {
  const f = fixture(t, { env: {} });
  await f.manager.install();
  f.runtime.env = {};
  f.runtime.failSet = "CODEX_HOME";
  await assert.rejects(f.manager.activate(), /setenv failed/);
  assert.deepEqual(f.runtime.env, {});
});

test("older native editors cannot modify desktop configuration", async (t) => {
  const f = fixture(t);
  writeFileSync(f.binary, "old native binary without the safe editor");
  const profile = join(f.dir, "profile");
  mkdirSync(profile);
  const file = join(profile, "config.toml");
  const original = "# keep\nfeatures = { reasoning_effort_override = false }\n";
  writeFileSync(file, original);
  await assert.rejects(
    withDesktopConfig(f.binary, profile, () => assert.fail()),
    /current native config editor/,
  );
  assert.equal(readFileSync(file, "utf8"), original);
});

test("launchctl readback preserves whitespace in installed and prior paths", async (t) => {
  const f = fixture(t);
  f.runtime.env.CODEX_CLI_PATH = "/previous/codex ";
  const previous = { ...f.runtime.env };
  const manager = new DesktopIntegration({
    ...f.settings,
    exec(command, args, options) {
      const result = f.settings.exec(command, args, options);
      return args[0] === "getenv" ? `${result}\n` : result;
    },
  });
  const profile = join(f.dir, "profile with trailing space ");
  assert((await manager.install({ codexHome: profile })).environmentMatches);
  assert.equal(f.runtime.env.CODEX_HOME, profile);
  await manager.uninstall();
  assert.deepEqual(f.runtime.env, previous);
});
