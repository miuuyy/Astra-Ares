import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
const cli = resolve("bin/ares.mjs");
function invoke(args, env, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
}
for (const provider of ["vercel", "openrouter"])
  test(`${provider} configure accepts a piped key, keeps it private and prints no secret`, () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-config-"));
    const file = join(dir, "config.json");
    const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
    try {
      const key = "vck_private_fixture_value";
      const r = invoke(
        ["configure", "--provider", provider, "--key-stdin"],
        env,
        key + "\n",
      );
      assert.equal(r.status, 0, r.stderr);
      assert(!r.stdout.includes(key));
      assert(!r.stderr.includes(key));
      assert.equal(JSON.parse(readFileSync(file, "utf8")).apiKey, key);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).provider, provider);
      // Windows chmod sets no ACL; the user-profile directory ACL applies there.
      if (process.platform !== "win32")
        assert.equal(statSync(file).mode & 0o777, 0o600);
      const doctor = invoke(["doctor"], env);
      assert.equal(doctor.status, 1);
      assert.match(doctor.stderr, /Patched Codex is missing/);
      assert(!doctor.stderr.includes(key));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test("unknown CLI options fail visibly", () => {
  const r = invoke(["setup", "--mystery"], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown/);
});
test("new configurations default to OpenRouter; replacing a key preserves an explicit provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-default-provider-"));
  const file = join(dir, "config.json");
  const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
  try {
    const first = invoke(["configure", "--key-stdin"], env, "fixture-first\n");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).provider, "openrouter");
    const change = invoke(
      ["configure", "--provider", "typesafe", "--key-stdin"],
      env,
      "fixture-second\n",
    );
    assert.equal(change.status, 0, change.stderr);
    const replace = invoke(
      ["configure", "--key-stdin"],
      env,
      "fixture-third\n",
    );
    assert.equal(replace.status, 0, replace.stderr);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.provider, "typesafe");
    assert.equal(saved.apiKey, "fixture-third");
    const location = invoke(["config-path"], env);
    assert.equal(location.status, 0, location.stderr);
    assert.equal(location.stdout.trim(), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("configuration parse failures never echo credential fragments", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-invalid-config-"));
  const file = join(dir, "config.json");
  const secret = "vck_private_invalid_json_fixture";
  try {
    writeFileSync(file, '{"apiKey":"' + secret + '", invalid}');
    for (const command of ["setup", "configure", "doctor"]) {
      const result = invoke([command], { ARES_CONFIG: file });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /valid JSON configuration/);
      assert(!result.stderr.includes(secret));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("options for a different command fail instead of being ignored", () => {
  const result = invoke(["doctor", "--provider", "typesafe"], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not supported by doctor/);
});

test("setup rejects an adopted Astra-only binary without overwriting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-old-binary-"));
  const binary = join(dir, "codex");
  const file = join(dir, "config.json");
  const old =
    "CODEX_STEP_CONTROLLER_CONTEXT_V3\nAstra-Jev requires its bridge\n";
  try {
    writeFileSync(binary, old);
    writeFileSync(
      file,
      JSON.stringify({ provider: "openrouter", codexBinary: binary }),
    );
    const result = invoke(["setup"], {
      ARES_CONFIG: file,
      ARES_HOME: join(dir, "data"),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configured codexBinary is incompatible/);
    assert.match(result.stderr, /setup --binary/);
    assert.equal(readFileSync(binary, "utf8"), old);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provider changes never carry hosted credentials to a local service", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-provider-switch-"));
  const file = join(dir, "config.json");
  const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
  const args = [
    "configure",
    "--provider",
    "local",
    "--base-url",
    "http://127.0.0.1:8890/",
    "--decision-model",
    "fixture-reader",
    "--context-token-limit",
    "7000",
  ];
  try {
    for (const credential of [
      { apiKey: "fixture-hosted-secret" },
      { apiKeyEnv: "HOSTED_SECRET" },
      { apiKeyFile: join(dir, "hosted.key") },
    ]) {
      const original = JSON.stringify({
        provider: "openrouter",
        ...credential,
      });
      writeFileSync(file, original);
      const missingInput = invoke(args, env);
      assert.equal(missingInput.status, 1);
      assert.match(missingInput.stderr, /Use --key-stdin/);
      assert.equal(readFileSync(file, "utf8"), original);
      const local = invoke([...args, "--key-stdin"], env, "\n");
      assert.equal(local.status, 0, local.stderr);
      const stored = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(stored.baseUrl, "http://127.0.0.1:8890");
      assert.equal(stored.contextTokenLimit, 7000);
      for (const field of ["apiKey", "apiKeyEnv", "apiKeyFile"])
        assert.equal(stored[field], undefined);
      const back = invoke(
        ["configure", "--provider", "openrouter", "--key-stdin"],
        env,
        "fixture-new-hosted-key\n",
      );
      assert.equal(back.status, 0, back.stderr);
      const hosted = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(hosted.apiKey, "fixture-new-hosted-key");
      for (const field of ["baseUrl", "decisionModel", "contextTokenLimit"])
        assert.equal(hosted[field], undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("changing a custom decision model requires a new explicit context budget", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-model-budget-"));
  const file = join(dir, "config.json");
  const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
  try {
    const configured = invoke(
      [
        "configure",
        "--decision-model",
        "cloudflare/clef-flash",
        "--context-token-limit",
        "60000",
        "--key-stdin",
      ],
      env,
      "fixture-key\n",
    );
    assert.equal(configured.status, 0, configured.stderr);
    const original = readFileSync(file, "utf8");
    const changed = invoke(
      ["configure", "--decision-model", "jaredpalmer/kev-4b", "--key-stdin"],
      env,
      "fixture-key\n",
    );
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /explicit contextTokenLimit/);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const fails of [false, true]) {
  test(`configure changes survive a concurrent ${fails ? "failed" : "successful"} setup build`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ares-concurrent-setup-"));
    const file = join(dir, "config.json");
    const home = join(dir, "data");
    mkdirSync(home);
    const env = { ARES_CONFIG: file, ARES_HOME: home };
    const loader = new URL("./fixtures/setup-loader.mjs", import.meta.url);
    const preload = `import { register } from "node:module"; register(${JSON.stringify(loader.href)});`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        cli,
        "setup",
      ],
      {
        env: {
          ...process.env,
          ...env,
          ARES_TEST_BUILD_FAIL: fails ? "1" : "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (output.includes("FIXTURE_BUILD_WAITING")) resolve();
        });
        exited.then(
          () => reject(new Error(`Setup exited before build: ${errors}`)),
          reject,
        );
      });
      const key = "fixture-concurrently-saved-key";
      const configured = invoke(
        ["configure", "--provider", "typesafe", "--key-stdin"],
        env,
        key + "\n",
      );
      assert.equal(configured.status, 0, configured.stderr);
      const saved = readFileSync(file, "utf8");
      writeFileSync(join(home, "continue-build"), "");
      assert.equal(await exited, fails ? 1 : 0, errors);
      assert.equal(readFileSync(file, "utf8"), saved);
      assert.equal(JSON.parse(saved).apiKey, key);
      assert.equal(JSON.parse(saved).provider, "typesafe");
      assert(!output.includes(key));
      assert(!errors.includes(key));
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
