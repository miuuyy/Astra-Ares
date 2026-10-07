// Isolate native compilation while exercising the real setup/configure CLI
// processes against the same config file. This loader is only used by tests.
export async function load(url, context, nextLoad) {
  let source;
  if (url === new URL("../../src/launch.mjs", import.meta.url).href) {
    source = `
      import { existsSync } from "node:fs";
      export function verifyBinary(binary) {
        if (!existsSync(binary)) throw new Error("Patched Codex is missing");
      }
    `;
  } else if (
    url === new URL("../../scripts/build-codex.mjs", import.meta.url).href
  ) {
    source = `
      import { existsSync, mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { setTimeout } from "node:timers/promises";
      export async function buildCodex(home) {
        console.log("FIXTURE_BUILD_WAITING");
        const deadline = Date.now() + 10000;
        while (!existsSync(join(home, "continue-build"))) {
          if (Date.now() > deadline) throw new Error("Fixture build timed out");
          await setTimeout(10);
        }
        if (process.env.ARES_TEST_BUILD_FAIL === "1")
          throw new Error("Fixture compilation failed");
        mkdirSync(join(home, "bin"), { recursive: true });
        writeFileSync(join(home, process.platform === "win32" ? "bin/codex.exe" : "bin/codex"), "fixture");
      }
    `;
  }
  return source === undefined
    ? nextLoad(url, context)
    : { format: "module", shortCircuit: true, source };
}
