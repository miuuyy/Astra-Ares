# Installation

Astra-Ares consists of a pinned, patched Codex CLI and a local Jev bridge. The patch adds a checkpoint before model generation and a confirmed-effort notification. It uses Codex's existing live settings mechanism. This is a native CLI extension, not an installable Codex plugin or an Astra API proxy.

## From a source checkout

Use Node.js 22+ with npm, Git, curl, tar, a native C/C++ toolchain, and rustup. On macOS the native toolchain comes from Xcode Command Line Tools (`xcode-select --install`). Allow about 10 GB free during compilation. The source pins Rust 1.95 through its upstream toolchain file.

From the downloaded or cloned `Astra-Ares` directory:

```sh
git clone https://github.com/miuuyy/Astra-Ares.git
cd Astra-Ares
npm ci
npm run setup
npm link
ares configure
astra-ares
```

Setup verifies the source archive and patch checksums, builds a separate Codex, and installs its matching checksum-pinned code-mode companion. A subsequent setup reuses a compatible managed binary or rebuilds an older one. Build directories include the patch checksum, so a new patch never reuses incompatible source. The normal Codex CLI and desktop application are not patched in place.

On macOS, setup preserves Rust symbol tables so proc-macro libraries can load on macOS 27. This increases build artifact size; it does not enable full debug information. See [build troubleshooting](troubleshooting.md#macos-mis-aligned-linkedit-string-pool) if an older checkout failed while loading `sqlx_macros`.

This preview has no public npm release or prebuilt Ares binary. Use the repository source. Apple Silicon macOS has local build and runtime acceptance; Intel macOS and Linux need platform acceptance. Windows is unsupported.

## Without global commands

If you do not want `npm link`, run the same tool directly from the source folder:

```sh
node bin/ares.mjs configure
npm start -- -C /path/to/project
node bin/ares.mjs doctor
```

If a linked command is not found, put your npm global prefix's `bin` directory on `PATH`, or use these direct commands. Node.js 22+ must be the `node` selected by that PATH.

## Reuse an existing native build

```sh
ares setup --binary /absolute/path/to/patched/codex
```

The binary must contain the compatible native checkpoint, report the pinned Codex version, and have `codex-code-mode-host` beside it. A stock Codex executable is rejected explicitly. The selected path is saved as `codexBinary` in the private configuration.

## Login and sessions

Ares creates its own Codex home under `~/.local/share/astra-ares/codex-home`. It reuses an existing Codex `auth.json` via a symlink when available. Otherwise run `astra-ares login`.

Existing custom profiles can be selected with an absolute `codexHome` in the configuration. This is useful when continuing sessions from the earlier Jev prototype. The model picker provides **Astra Ares**, **Sol Ares**, and **Luna Ares** for available base models. The selected entry is preserved when a session resumes.

## Update

Quit Ares first. Update the checkout, then run:

```sh
npm ci
npm run setup
npm link
astra-ares resume --last
```

Config, credentials, and native sessions live outside the checkout. Setup rebuilds an outdated managed binary. An explicitly configured `codexBinary` is never overwritten: rebuild it and adopt the new binary with `ares setup --binary`, or remove that field to use the managed build. Replacing the binary with stock Codex or using its self-update is unsupported. Remote, daemon, and desktop-app transports are outside this CLI integration.

## Remove

For an installation linked with npm:

```sh
npm unlink -g astra-ares
```

This removes the two command links, retaining your configuration and history. Delete `~/.config/astra-ares` and `~/.local/share/astra-ares` manually only if you also want to remove the saved key, builds, logs, and Ares sessions. If you selected custom paths, inspect them separately before deleting anything.
