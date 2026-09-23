import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalCliArgs } from "../src/cli-args.mjs";
import { CodexRpc } from "./native/rpc.mjs";
import { launch } from "../src/launch.mjs";
import { locations } from "../src/config.mjs";
import { makeFakeCodex } from "./fixtures/fake-codex.mjs";

test("literal prompt and option values are not transport flags or commands", () => {
  for (const args of [
    ["exec", "--", "--remote=foo"],
    ["--", "--remote"],
    ["--", "update"],
    ["-p", "agents", "exec", "--", "--remote=foo"],
    ["--config", "--remote=foo", "exec", "task"],
    ["-cmodel=agents", "exec", "task"],
    ["--image", "first.png", "update"],
    ["--image=first.png", "update"],
    ["exec", "--output-last-message", "--remote=foo", "task"],
    ["resume", "--", "--remote=foo"],
  ])
    assert.doesNotThrow(() => assertLocalCliArgs(args), JSON.stringify(args));
});

test("actual remote options and unsupported commands remain blocked", () => {
  for (const args of [
    ["--remote=ws://example.invalid"],
    ["-p", "default", "--remote", "ws://example.invalid"],
    ["resume", "--last", "--remote=ws://example.invalid"],
    ["fork", "--remote", "ws://example.invalid"],
    ["Review this project", "--remote=ws://example.invalid"],
    ["agents"],
    ["--config", "model=example", "agents"],
    ["--profile", "default", "update"],
    ["--no-alt-screen", "app"],
    ["remote-control"],
  ])
    assert.throws(() => assertLocalCliArgs(args), /Use local CLI sessions/);
});

test(
  "missing RPC executable rejects all pending and future calls immediately",
  { timeout: 2000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ares-rpc-missing-"));
    const rpc = new CodexRpc(join(dir, "missing-codex"), [], process.env);
    try {
      const results = await Promise.allSettled([
        rpc.call("initialize", {}),
        rpc.call("thread/list", {}),
      ]);
      for (const result of results) {
        assert.equal(result.status, "rejected");
        assert.equal(result.reason.code, "ENOENT");
      }
      assert.equal(rpc.pending.size, 0);
      await assert.rejects(rpc.call("initialize", {}), { code: "ENOENT" });
    } finally {
      rpc.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
test(
  "launch strips every Jev credential variable from the Codex environment",
  { skip: !["darwin", "linux"].includes(process.platform) },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "ares-launch-env-"));
    const names = [
      "AI_GATEWAY_API_KEY",
      "TYPESAFE_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENJEV_API_KEY",
      "CUSTOM_JEV_KEY",
    ];
    const saved = Object.fromEntries(
      [...names, "FAKE_CODEX_ENV_OUT", "CODEX_HOME"].map((n) => [
        n,
        process.env[n],
      ]),
    );
    try {
      for (const name of names) process.env[name] = `secret-${name}`;
      process.env.FAKE_CODEX_ENV_OUT = join(dir, "env.txt");
      process.env.CODEX_HOME = join(dir, "user-codex");
      const code = await launch(["exec", "hello"], {
        provider: "openjev",
        baseUrl: "http://127.0.0.1:1",
        apiKeyEnv: "CUSTOM_JEV_KEY",
        maxLeaseSteps: 10,
        codexBinary: makeFakeCodex(dir),
        paths: locations({
          ARES_HOME: join(dir, "data"),
          ARES_CONFIG: join(dir, "c.json"),
        }),
      });
      assert.equal(code, 0);
      const env = readFileSync(join(dir, "env.txt"), "utf8");
      for (const name of names) assert(!env.includes(`secret-${name}`), name);
      assert.match(env, /CODEX_STEP_CONTROLLER_SOCKET=/);
    } finally {
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
