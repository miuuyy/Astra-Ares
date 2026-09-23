import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalCliArgs } from "../src/cli-args.mjs";
import { codexArgsWithAresFeatures } from "../src/launch.mjs";
import { CodexRpc } from "./native/rpc.mjs";

test("Ares feature flags are always prepended before app-server startup", () => {
  assert.deepEqual(
    codexArgsWithAresFeatures([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
    ]).slice(0, 4),
    [
      "-c",
      "features.step_model_switching=true",
      "-c",
      "features.reasoning_effort_override=true",
    ],
  );
});

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
