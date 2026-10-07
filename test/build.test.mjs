import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nativeBuildEnv,
  isCurrentManagedBuild,
} from "../scripts/build-codex.mjs";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("managed setup only reuses a build of the current pinned patch", () => {
  const home = mkdtempSync(join(tmpdir(), "ares-build-receipt-"));
  const file = join(home, "build-receipt.json");
  const meta = JSON.parse(
    readFileSync(new URL("../patches/upstream.json", import.meta.url), "utf8"),
  );
  try {
    assert.equal(isCurrentManagedBuild(home), false);
    writeFileSync(
      file,
      JSON.stringify({ commit: meta.commit, patchSha256: "old-patch" }),
    );
    assert.equal(isCurrentManagedBuild(home), false);
    writeFileSync(
      file,
      JSON.stringify({ commit: "old-source", patchSha256: meta.patchSha256 }),
    );
    assert.equal(isCurrentManagedBuild(home), false);
    writeFileSync(
      file,
      JSON.stringify({ commit: meta.commit, patchSha256: meta.patchSha256 }),
    );
    assert.equal(isCurrentManagedBuild(home), true);
    writeFileSync(file, "invalid receipt");
    assert.throws(() => isCurrentManagedBuild(home));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("macOS builds preserve proc-macro symbols even with inherited stripping enabled", () => {
  const inherited = {
    PATH: "/example/bin",
    RUSTUP_TOOLCHAIN: "1.95.0",
    CARGO_INCREMENTAL: "1",
    CARGO_PROFILE_DEV_SMALL_STRIP: "symbols",
  };
  const build = nativeBuildEnv(inherited, "darwin");
  assert.equal(build.CARGO_PROFILE_DEV_SMALL_STRIP, "none");
  assert.equal(build.CARGO_INCREMENTAL, "0");
  assert.equal(build.PATH, inherited.PATH);
  assert.equal(build.RUSTUP_TOOLCHAIN, inherited.RUSTUP_TOOLCHAIN);
  assert.equal(inherited.CARGO_PROFILE_DEV_SMALL_STRIP, "symbols");
  assert.equal(inherited.CARGO_INCREMENTAL, "1");
});

test("Linux retains its existing Cargo profile and explicit strip setting", () => {
  assert.deepEqual(nativeBuildEnv({ PATH: "/example/bin" }, "linux"), {
    PATH: "/example/bin",
    CARGO_INCREMENTAL: "0",
  });
  assert.equal(
    nativeBuildEnv({ CARGO_PROFILE_DEV_SMALL_STRIP: "debuginfo" }, "linux")
      .CARGO_PROFILE_DEV_SMALL_STRIP,
    "debuginfo",
  );
});
