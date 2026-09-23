import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const binary = process.env.JEV_TEST_BINARY;
if (!binary) throw new Error("Set JEV_TEST_BINARY to the patched Codex binary");
for (const [name, model] of [
  ["context"],
  ["session"],
  ["selection", "gpt-6-astra"],
  ["selection", "gpt-6-sol"],
  ["selection", "gpt-6-luna"],
]) {
  const out = resolve(`work/test-${name}-${model ?? "astra"}-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const child = spawn(
    "bun",
    [
      `test/native/native-${name}-test.mjs`,
      binary,
      out,
      ...(model ? [model] : []),
    ],
    { stdio: "inherit" },
  );
  const code = await new Promise((r, j) => {
    child.once("error", j);
    child.once("exit", r);
  });
  if (code !== 0) process.exit(code ?? 1);
}
