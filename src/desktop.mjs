import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  realpathSync,
  rmdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, readKey } from "./config.mjs";
import { launch, verifyBinary } from "./launch.mjs";
import { DESKTOP_FLAGS, withDesktopConfig } from "./desktop-config.mjs";

const LABEL = "io.github.miuuyy.astra-ares.desktop";
const ENV_KEYS = ["CODEX_CLI_PATH", "CODEX_HOME"];
const digest = (text) => createHash("sha256").update(text).digest("hex");
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const xml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const entry = fileURLToPath(
  new URL("../bin/ares-desktop.mjs", import.meta.url),
);

function atomicWrite(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readDesktopReceipt(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Cannot read the desktop installation receipt: ${file}`);
  }
  return validateReceipt(value, file);
}

function validateReceipt(value, file) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    ![
      "configPath",
      "dataHome",
      "codexHome",
      "binaryPath",
      "nodePath",
      "entryPath",
    ].every(
      (key) =>
        typeof value[key] === "string" &&
        isAbsolute(value[key]) &&
        !/[\x00-\x1f]/.test(value[key]),
    ) ||
    !DESKTOP_FLAGS.every(
      (key) =>
        value.flags?.[key] === null || typeof value.flags?.[key] === "boolean",
    ) ||
    !ENV_KEYS.every(
      (key) =>
        value.previous?.[key] === null ||
        typeof value.previous?.[key] === "string",
    ) ||
    !["launcher", "plist"].every((key) =>
      /^[a-f0-9]{64}$/.test(value.files?.[key] ?? ""),
    )
  )
    throw new Error(`Invalid desktop installation receipt: ${file}`);
  return value;
}

export function desktopConfig(state) {
  // Resolve from the saved installation, never the GUI's inherited ARES_* values.
  const config = loadConfig({
    ARES_CONFIG: state.configPath,
    ARES_HOME: state.dataHome,
  });
  if (config.apiKeyEnv)
    throw new Error(
      "Desktop requires apiKey or apiKeyFile; shell-only apiKeyEnv is not supported. Run ares configure.",
    );
  readKey(config, {});
  return config;
}

export async function launchDesktop(args, receipt) {
  const state = readDesktopReceipt(receipt);
  return launch(args, desktopConfig(state), {
    codexHome: state.codexHome,
    initializeProfile: false,
  });
}

export class DesktopIntegration {
  constructor({
    userHome = homedir(),
    env = process.env,
    platform = process.platform,
    exec = execFileSync,
    verify = verifyBinary,
    configSession = withDesktopConfig,
    nodePath = realpathSync(process.execPath),
    entryPath = entry,
    uid = process.getuid?.(),
  } = {}) {
    if (platform !== "darwin")
      throw new Error(
        "Desktop integration currently requires macOS; the CLI also supports Linux and Windows.",
      );
    if (!Number.isInteger(uid))
      throw new Error("Cannot resolve the macOS user session");
    Object.assign(this, {
      userHome,
      env,
      exec,
      verify,
      configSession,
      nodePath,
      entryPath,
    });
    this.domain = `gui/${uid}`;
    const root = join(
      userHome,
      "Library/Application Support/Astra-Ares/desktop",
    );
    this.paths = {
      root,
      state: join(root, "installation.json"),
      launcher: join(root, "codex"),
      plist: join(userHome, "Library/LaunchAgents", `${LABEL}.plist`),
      log: join(root, "activation.log"),
      lock: `${root}.lock`,
    };
  }

  ctl(args, absentStatus) {
    try {
      return this.exec("/bin/launchctl", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).replace(/\r?\n$/, "");
    } catch (error) {
      if (absentStatus !== undefined && error.status === absentStatus)
        return null;
      throw new Error(
        `launchctl ${args[0]} failed; desktop state was not silently ignored`,
        { cause: error },
      );
    }
  }

  environment() {
    return Object.fromEntries(
      ENV_KEYS.map((key) => [key, this.ctl(["getenv", key], 1) || null]),
    );
  }

  loaded() {
    return this.ctl(["print", `${this.domain}/${LABEL}`], 113) !== null;
  }
  owned(state) {
    return { CODEX_CLI_PATH: this.paths.launcher, CODEX_HOME: state.codexHome };
  }
  save(state) {
    validateReceipt(state, this.paths.state);
    atomicWrite(this.paths.state, JSON.stringify(state, null, 2) + "\n");
  }

  async locked(action) {
    mkdirSync(dirname(this.paths.root), { recursive: true, mode: 0o700 });
    try {
      mkdirSync(this.paths.lock, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST")
        throw new Error(
          `A desktop operation is already running. If it was interrupted, inspect ${this.paths.lock} before removing it.`,
        );
      throw error;
    }
    try {
      return await action();
    } finally {
      rmdirSync(this.paths.lock);
    }
  }

  checkFiles(state, allowMissing = false) {
    for (const key of ["launcher", "plist"]) {
      const file = this.paths[key];
      if (allowMissing && !existsSync(file)) continue;
      if (!existsSync(file) || digest(readFileSync(file)) !== state.files[key])
        throw new Error(
          `Desktop file changed outside Ares; leaving it untouched: ${file}`,
        );
    }
  }

  setEnvironment(state) {
    const current = this.environment(),
      owned = this.owned(state);
    for (const key of ENV_KEYS)
      if (
        current[key] !== null &&
        current[key] !== owned[key] &&
        current[key] !== state.previous[key]
      )
        throw new Error(
          `${key} changed outside Ares. Resolve that override before activating desktop integration.`,
        );
    const applied = [];
    try {
      for (const key of ENV_KEYS) {
        this.ctl(["setenv", key, owned[key]]);
        applied.push(key);
      }
      const actual = this.environment();
      if (ENV_KEYS.some((key) => actual[key] !== owned[key]))
        throw new Error(
          "Desktop environment readback did not match the installation",
        );
    } catch (error) {
      for (const key of applied) {
        if ((this.ctl(["getenv", key], 1) || null) === owned[key])
          this.ctl(
            current[key] === null
              ? ["unsetenv", key]
              : ["setenv", key, current[key]],
          );
      }
      throw error;
    }
  }

  restoreEnvironment(state) {
    const current = this.environment(),
      owned = this.owned(state),
      preserved = [];
    for (const key of ENV_KEYS) {
      if (current[key] !== owned[key]) {
        if (current[key] !== state.previous[key]) preserved.push(key);
        continue;
      }
      this.ctl(
        state.previous[key] === null
          ? ["unsetenv", key]
          : ["setenv", key, state.previous[key]],
      );
    }
    return preserved;
  }

  async restoreFlags(state) {
    await this.configSession(
      state.binaryPath,
      state.codexHome,
      async ({ read, write }) => {
        const current = await read();
        const values = Object.fromEntries(
          DESKTOP_FLAGS.filter((key) => current.flags[key] === true).map(
            (key) => [key, state.flags[key]],
          ),
        );
        await write(values, current);
      },
    );
  }

  async activate() {
    const state = readDesktopReceipt(this.paths.state);
    this.checkFiles(state);
    this.setEnvironment(state);
    return state;
  }

  async install({ codexHome } = {}) {
    return this.locked(async () => {
      const previousState = existsSync(this.paths.state)
        ? readDesktopReceipt(this.paths.state)
        : null;
      const config = loadConfig(this.env);
      const binary = config.codexBinary ?? config.paths.binary;
      this.verify(binary);
      const previous = previousState?.previous ?? this.environment();
      const state = previousState ?? {
        version: 1,
        configPath: resolve(config.paths.config),
        dataHome: resolve(config.paths.home),
        binaryPath: resolve(binary),
        codexHome: resolve(
          codexHome ??
            config.codexHome ??
            this.env.CODEX_HOME ??
            previous.CODEX_HOME ??
            join(this.userHome, ".codex"),
        ),
        nodePath: this.nodePath,
        entryPath: this.entryPath,
        previous,
      };
      if (previousState) {
        this.checkFiles(state);
        if (
          state.configPath !== resolve(config.paths.config) ||
          state.dataHome !== resolve(config.paths.home) ||
          (codexHome && state.codexHome !== resolve(codexHome)) ||
          state.nodePath !== this.nodePath ||
          state.entryPath !== this.entryPath
        )
          throw new Error(
            "A different desktop installation already exists. Uninstall it before changing its paths.",
          );
        desktopConfig(state);
        await this.configSession(binary, state.codexHome, async ({ read }) => {
          const current = await read();
          if (DESKTOP_FLAGS.some((key) => current.effective?.[key] !== true))
            throw new Error(
              "Required desktop feature flags changed. Uninstall before installing again.",
            );
        });
        this.setEnvironment(state);
        if (!this.loaded())
          this.ctl(["bootstrap", this.domain, this.paths.plist]);
        return this.status();
      }
      desktopConfig(state);
      if (
        existsSync(this.paths.launcher) ||
        existsSync(this.paths.plist) ||
        this.loaded()
      )
        throw new Error(
          "Desktop installation files or a LaunchAgent already exist without an Ares receipt; refusing to overwrite them.",
        );
      const launcher = `#!/bin/sh\nexec ${quote(state.nodePath)} ${quote(state.entryPath)} ${quote(this.paths.state)} run "$@"\n`;
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${[state.nodePath, state.entryPath, this.paths.state, "activate"].map((s) => `<string>${xml(s)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(this.paths.log)}</string>
<key>StandardErrorPath</key><string>${xml(this.paths.log)}</string>
</dict></plist>\n`;
      state.files = { launcher: digest(launcher), plist: digest(plist) };
      await this.configSession(
        binary,
        state.codexHome,
        async ({ read, write }) => {
          const before = await read();
          state.flags = before.flags;
          this.save(state); // Recovery information precedes every external mutation.
          try {
            const after = await write(
              Object.fromEntries(DESKTOP_FLAGS.map((key) => [key, true])),
              before,
            );
            if (DESKTOP_FLAGS.some((key) => after.effective?.[key] !== true))
              throw new Error(
                "Another Codex configuration layer disables required desktop feature flags",
              );
            atomicWrite(this.paths.launcher, launcher, 0o700);
            atomicWrite(this.paths.plist, plist);
            this.setEnvironment(state);
            this.ctl(["bootstrap", this.domain, this.paths.plist]);
          } catch (error) {
            // Keep the receipt if rollback fails, so uninstall can recover explicitly.
            try {
              if (this.loaded())
                this.ctl(["bootout", `${this.domain}/${LABEL}`]);
              this.restoreEnvironment(state);
              const current = await read();
              await write(
                Object.fromEntries(
                  DESKTOP_FLAGS.filter(
                    (key) => current.flags[key] === true,
                  ).map((key) => [key, state.flags[key]]),
                ),
                current,
              );
              this.removeFiles(state);
            } catch (rollback) {
              throw new AggregateError(
                [error, rollback],
                `Desktop installation failed and needs recovery with ares desktop uninstall. Receipt: ${this.paths.state}`,
              );
            }
            throw error;
          }
        },
      );
      return this.status();
    });
  }

  removeFiles(state) {
    this.checkFiles(state, true);
    for (const key of ["launcher", "plist", "state"])
      rmSync(this.paths[key], { force: true });
    // Keep activation diagnostics and any user-added files, along with all Ares data.
    try {
      rmdirSync(this.paths.root);
    } catch (error) {
      if (error.code !== "ENOTEMPTY") throw error;
    }
  }

  async uninstall() {
    return this.locked(async () => {
      if (!existsSync(this.paths.state))
        throw new Error("No managed desktop installation found");
      const state = readDesktopReceipt(this.paths.state);
      this.checkFiles(state, true);
      if (this.loaded()) this.ctl(["bootout", `${this.domain}/${LABEL}`]);
      const preserved = this.restoreEnvironment(state);
      await this.restoreFlags(state);
      this.removeFiles(state);
      return { installed: false, preservedExternalOverrides: preserved };
    });
  }

  status() {
    if (!existsSync(this.paths.state)) return { installed: false };
    const state = readDesktopReceipt(this.paths.state);
    const owned = this.owned(state),
      current = this.environment();
    return {
      installed: true,
      configPath: state.configPath,
      dataHome: state.dataHome,
      codexHome: state.codexHome,
      launcher: this.paths.launcher,
      filesMatch: ["launcher", "plist"].every(
        (key) =>
          existsSync(this.paths[key]) &&
          digest(readFileSync(this.paths[key])) === state.files[key],
      ),
      environmentMatches: ENV_KEYS.every((key) => current[key] === owned[key]),
      loginAgentLoaded: this.loaded(),
    };
  }

  async open(app) {
    if (!app || !isAbsolute(app) || !app.endsWith(".app") || !existsSync(app))
      throw new Error(
        "Specify an installed application: ares desktop open --app /Applications/ChatGPT.app",
      );
    await this.activate();
    this.exec("/usr/bin/open", ["-a", app], { stdio: "ignore" });
  }
}
