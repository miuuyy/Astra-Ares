import {
  readFileSync,
  mkdirSync,
  existsSync,
  cpSync,
  renameSync,
  chmodSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (file) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
export function nativeBuildEnv(env = process.env, platform = process.platform) {
  return {
    ...env,
    CARGO_INCREMENTAL: "0",
    // Rust's Mach-O stripping can misalign the LINKEDIT string table in
    // proc-macro dylibs. macOS 27's loader rejects those libraries (#4).
    ...(platform === "darwin" ? { CARGO_PROFILE_DEV_SMALL_STRIP: "none" } : {}),
  };
}
export async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    );
  });
}
export async function buildCodex(home) {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error(
      "This native checkpoint currently requires macOS or Linux.",
    );
  const meta = JSON.parse(
    readFileSync(join(root, "patches/upstream.json"), "utf8"),
  );
  const patch = join(root, "patches/native-checkpoint.patch");
  if (hash(patch) !== meta.patchSha256)
    throw new Error("Codex patch checksum mismatch");
  const build = join(
      home,
      "build",
      `${meta.commit}-${meta.patchSha256.slice(0, 12)}`,
    ),
    source = join(build, "source");
  mkdirSync(build, { recursive: true, mode: 0o700 });
  const archive = join(build, "source.tar.gz");
  if (!existsSync(archive))
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "2",
      "--output",
      archive,
      `https://codeload.github.com/openai/codex/tar.gz/${meta.commit}`,
    ]);
  if (hash(archive) !== meta.sourceArchiveSha256)
    throw new Error("Upstream source checksum mismatch; refusing to build");
  const stamp = join(source, ".jev-patched");
  if (!existsSync(source)) {
    mkdirSync(source);
    await run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
    await run("git", ["init", "--quiet"], { cwd: source });
    await run("git", ["apply", "--check", patch], { cwd: source });
    await run("git", ["apply", patch], { cwd: source });
    if (
      !existsSync(join(source, "codex-rs/core/src/session/step_controller.rs"))
    )
      throw new Error("Native checkpoint patch was not applied");
    writeFileSync(stamp, meta.patchSha256);
  } else if (
    !existsSync(stamp) ||
    readFileSync(stamp, "utf8") !== meta.patchSha256
  ) {
    throw new Error(
      `Incomplete or different source at ${source}; inspect and remove this build directory before retrying`,
    );
  }
  // Cargo reads the upstream-pinned rust-toolchain.toml. Never builds arbitrary stock HEAD.
  await run(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      "codex-cli",
      "--bin",
      "codex",
      "--profile",
      "dev-small",
      "-j",
      "2",
    ],
    {
      cwd: join(source, "codex-rs"),
      env: nativeBuildEnv(),
    },
  );
  const target = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : "unsupported"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const helper = meta.helpers[target];
  if (!helper)
    throw new Error(`Unsupported native companion target: ${target}`);
  const companionArchive = join(build, "code-mode-host.tar.gz");
  if (!existsSync(companionArchive))
    await run("curl", [
      "--fail",
      "--location",
      "--retry",
      "2",
      "--output",
      companionArchive,
      helper.url,
    ]);
  if (hash(companionArchive) !== helper.sha256)
    throw new Error("Code-mode host checksum mismatch");
  const companionDir = join(build, "companion");
  mkdirSync(companionDir, { recursive: true });
  await run("tar", ["-xzf", companionArchive, "-C", companionDir]);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const sources = {
    codex: join(source, "codex-rs/target/dev-small/codex"),
    "codex-code-mode-host": join(companionDir, helper.executable),
  };
  for (const [name, from] of Object.entries(sources)) {
    const temp = join(bin, `${name}.new`);
    cpSync(from, temp);
    chmodSync(temp, 0o755);
    renameSync(temp, join(bin, name));
  }
  writeFileSync(
    join(home, "build-receipt.json"),
    JSON.stringify(
      {
        commit: meta.commit,
        patchSha256: meta.patchSha256,
        binaries: Object.fromEntries(
          Object.keys(sources).map((n) => [n, hash(join(bin, n))]),
        ),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  return join(bin, "codex");
}
