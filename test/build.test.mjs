import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeBuildEnv } from "../scripts/build-codex.mjs";

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
