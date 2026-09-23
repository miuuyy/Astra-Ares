import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

// A stand-in for the patched Codex build: it carries the checkpoint markers
// verifyBinary() looks for, reports the pinned version, and otherwise dumps
// its environment to $FAKE_CODEX_ENV_OUT so tests can inspect what launch()
// passed to the child.
export function makeFakeCodex(dir) {
  const binary = join(dir, "codex");
  writeFileSync(
    binary,
    `#!/bin/sh
# CODEX_STEP_CONTROLLER_CONTEXT_V3
# Astra-Jev requires its bridge
if [ "$1" = "--version" ]; then echo "codex-cli 0.155.0-alpha.9.2"; exit 0; fi
env > "$FAKE_CODEX_ENV_OUT"
`,
  );
  chmodSync(binary, 0o755);
  writeFileSync(join(dir, "codex-code-mode-host"), "");
  return binary;
}
