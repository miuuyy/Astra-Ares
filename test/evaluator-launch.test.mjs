import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exe } from "../src/config.mjs";
import { launch } from "../src/launch.mjs";

test("evaluator credentials stay out of the native Codex child environment", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ares-child-env-"));
  const binary = join(dir, `codex${exe}`);
  const variables = [
    "ARES_LOCAL_API_KEY",
    "ARES_TEST_PRIVATE_KEY",
    "OPENROUTER_API_KEY",
  ];
  const saved = variables.map((name) => [name, process.env[name]]);
  writeFileSync(
    binary,
    "CODEX_STEP_CONTROLLER_CONTEXT_V3 Jev requires its bridge Astra Ares Luna Ares Sol Ares",
  );
  writeFileSync(join(dir, `codex-code-mode-host${exe}`), "");
  let spawned = false;
  try {
    for (const name of variables) process.env[name] = "fixture-secret";
    t.mock.method(childProcess, "execFileSync", (_binary, args) => {
      assert.deepEqual(args, ["--version"]);
      return "codex-cli 0.155.0-alpha.9.2\n";
    });
    t.mock.method(childProcess, "spawn", (program, args, options) => {
      assert.equal(program, binary);
      assert(args.includes("--version"));
      for (const name of variables) assert.equal(options.env[name], undefined);
      assert(options.env.CODEX_STEP_CONTROLLER_SOCKET);
      spawned = true;
      const child = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => child.emit("exit", 0));
      return child;
    });
    syncBuiltinESMExports();
    assert.equal(
      await launch(["--version"], {
        provider: "local",
        baseUrl: "http://127.0.0.1:8890",
        decisionModel: "fixture",
        contextTokenLimit: 7000,
        apiKeyEnv: "ARES_TEST_PRIVATE_KEY",
        maxLeaseSteps: 1,
        codexBinary: binary,
        paths: {
          home: dir,
          codexHome: join(dir, "profile"),
          runs: join(dir, "runs"),
        },
      }),
      0,
    );
    assert(spawned);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
