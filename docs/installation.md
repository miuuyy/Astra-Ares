# Installation

Astra-Ares consists of a pinned, patched Codex CLI and a local Jev bridge. The patch adds a checkpoint before model generation and a confirmed-effort notification. It uses Codex's existing live settings mechanism. This is a native CLI extension, not an installable Codex plugin or an Astra API proxy.

## Windows (PowerShell)

Install Node.js 22+, Git for Windows, [rustup](https://rustup.rs/) with its default MSVC toolchain, and Visual Studio Build Tools with the **Desktop development with C++** workload and a Windows SDK. Setup also runs `curl` and `tar`; recent Windows releases include both, otherwise put them on `PATH`. Allow about 10 GB free.

```powershell
git clone https://github.com/miuuyy/Astra-Ares.git
cd Astra-Ares
npm.cmd ci
npm.cmd run setup
node bin/ares.mjs configure
node bin/astra-ares.mjs
```

`npm.cmd` sidesteps PowerShell execution policies that can block `npm.ps1`. Running from the checkout needs no global link. For linked commands, run `npm.cmd link` and use `ares.cmd` and `astra-ares.cmd`; if they are not found, add npm's global prefix (`npm.cmd prefix -g`) itself to `PATH`. Elsewhere in these guides, read bare `ares`/`astra-ares` as `node bin/ares.mjs`/`node bin/astra-ares.mjs` in an unlinked Windows checkout, and `npm` as `npm.cmd`.

Defaults live under your user profile: configuration in `%USERPROFILE%\.config\astra-ares\config.json` and data in `%USERPROFILE%\.local\share\astra-ares`. Setup installs `bin\codex.exe` and `bin\codex-code-mode-host.exe`, plus `codex-command-runner.exe` and `codex-windows-sandbox-setup.exe` for Codex's optional Windows sandbox. The config file's `0600` mode is not a Windows ACL: its privacy comes from the folder permissions, so keep any `ARES_CONFIG` or `ARES_HOME` override in a folder only you can read. The bridge uses a randomly named pipe instead of a Unix socket; see [architecture](architecture.md#bridge-transport).

The first start after setup can take a minute while Microsoft Defender scans the new `codex.exe`. With Codex's optional Windows sandbox off, read-only mode with approval `never` (the `exec` defaults) refuses shell commands; this is upstream Codex behavior. Use interactive approvals, enable the Windows sandbox, or explicitly choose a less restrictive sandbox for that run.

To update, quit Ares and update the checkout, then run `npm.cmd ci`, `npm.cmd run setup`, and `node bin/astra-ares.mjs resume --last`. To remove linked commands, run `npm.cmd unlink -g astra-ares`; delete the two folders above only if you also want to remove your key, builds, logs and sessions.

## From a source checkout (macOS and Linux)

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

Setup verifies the source archive and patch checksums, builds a separate Codex, and installs its matching checksum-pinned code-mode companion. A subsequent setup reuses a compatible managed binary only when its build receipt matches the current source and patch checksums; older builds are rebuilt. Build directories include the patch checksum, so a new patch never reuses incompatible source. The normal Codex CLI and desktop application are not patched in place.

On macOS, setup preserves Rust symbol tables so proc-macro libraries can load on macOS 27. This increases build artifact size; it does not enable full debug information. See [build troubleshooting](troubleshooting.md#macos-mis-aligned-linkedit-string-pool) if an older checkout failed while loading `sqlx_macros`.

This preview has no public npm release or prebuilt Ares binary. Use the repository source. Apple Silicon macOS has local build and runtime acceptance; Intel macOS and Linux need platform acceptance. Windows 11 x64 has local build and runtime acceptance, and CI runs its native fixtures; Windows ARM64 is untested.

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

On Windows: `node bin/ares.mjs setup --binary C:\absolute\path\to\patched\codex.exe`.

The binary must contain the compatible native checkpoint, report the pinned Codex version, and have `codex-code-mode-host` (`codex-code-mode-host.exe` on Windows) beside it. A stock Codex executable is rejected explicitly. The selected path is saved as `codexBinary` in the private configuration.

## Login and sessions

Ares creates its own Codex home under `~/.local/share/astra-ares/codex-home`. It reuses an existing Codex `auth.json` via a symlink when available. Otherwise run `astra-ares login`. On Windows, creating that symlink requires Developer Mode; without it Ares keeps an independent login and never copies your token.

Existing custom profiles can be selected with an absolute `codexHome` in the configuration. This is useful when continuing sessions from the earlier Jev prototype. The model picker provides **Astra Ares**, **Sol Ares**, and **Luna Ares** for available base models. The selected entry is preserved when a session resumes.

## Update

Quit Ares first. Update the checkout, then run:

```sh
npm ci
npm run setup
npm link
astra-ares resume --last
```

Config, credentials, and native sessions live outside the checkout. Setup rebuilds an outdated managed binary. An explicitly configured `codexBinary` is never overwritten: rebuild it and adopt the new binary with `ares setup --binary`, or remove that field to use the managed build. Replacing the binary with stock Codex or using its self-update is unsupported. Remote and daemon transports are outside this integration. The separate [macOS desktop setup](desktop.md) uses the same native checkpoint and bridge.

## Remove

For an installation linked with npm:

If desktop integration is installed, run `ares desktop uninstall` first, then fully quit and reopen the desktop app. This restores its launch settings before you remove the command or checkout.

```sh
npm unlink -g astra-ares
```

This removes the two command links, retaining your configuration and history. Delete `~/.config/astra-ares` and `~/.local/share/astra-ares` manually only if you also want to remove the saved key, builds, logs, and Ares sessions. If you selected custom paths, inspect them separately before deleting anything.
