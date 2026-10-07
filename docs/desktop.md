# Codex desktop on macOS

Ares can run its existing native checkpoint behind the Codex desktop app. This is an experimental integration using the app's `CODEX_CLI_PATH` override, not an official plugin. It uses the same pinned Codex build as the CLI. Desktop updates may introduce protocol requirements that build does not support.

## Install

Complete the normal [installation](installation.md), including `ares setup` and `ares configure`, first. Then run:

```sh
ares desktop install
ares desktop status
```

Fully quit the desktop app, then reopen it from the Dock or with:

```sh
ares desktop open --app /Applications/ChatGPT.app
```

Use your actual app path, for example `/Applications/Codex.app` if that is the installed application. `open` does not terminate an already running app; an existing process keeps its old environment until you quit it.

Updating an older Ares checkout requires rerunning `ares setup`: this version includes a native TOML-writing fix and validates generated TOML before replacing the file. Desktop setup rejects older binaries that lack that protection. An explicitly adopted `codexBinary` must be rebuilt separately.

Select **Astra Ares**, **Sol Ares**, or **Luna Ares** in the model picker. An ordinary model bypasses adaptive evaluation. Model availability still depends on the native catalog and your account. Remote hosts and hosts with an explicit `codex_cli_command` are outside this local integration.

## Which configuration is used

The installer records absolute paths to the Node executable, Ares entry point, Ares config, Ares data directory, and selected Codex home. GUI launches and login activation use those saved paths; they do not depend on the terminal's `PATH`, `ARES_CONFIG`, or `ARES_HOME`.

For an existing custom Ares installation:

```sh
ARES_CONFIG=/path/to/ares.json ARES_HOME=/path/to/ares-data \
  ares desktop install --codex-home /path/to/codex-profile
```

The desktop profile is chosen from `--codex-home`, the Ares config's `codexHome`, the current `CODEX_HOME`, the existing launchctl `CODEX_HOME`, then `~/.codex`. Repeating installation retains the saved selection. A different installation path requires uninstalling first. If Node or the repository moves, reinstall with the new paths.

Unlike the default CLI profile, desktop integration uses the selected desktop profile's existing login and history. It does not replace the selected model, copy login tokens, or create a default model configuration at launch.

The evaluator credential must be stored as `apiKey` or `apiKeyFile` in the saved Ares configuration. `ares configure` stores it privately. Shell-only credentials and `apiKeyEnv` are rejected for desktop installation because GUI processes may not inherit them. A keyless local evaluator remains supported. Credentials are not copied into the launcher, receipt, or LaunchAgent, and evaluator environment variables are removed before spawning native Codex.

## Installation changes and removal

The installation receipt and launcher live under `~/Library/Application Support/Astra-Ares/desktop/`. This fixed location lets `status` and `uninstall` find a custom installation from a fresh terminal.

Installation makes these changes:

- A per-user LaunchAgent reapplies `CODEX_CLI_PATH` and `CODEX_HOME` after login. These environment overrides affect newly launched local desktop processes for this user. A conflicting override from another tool is reported rather than overwritten during activation.
- Codex's own `config/batchWrite` API enables `features.step_model_switching` and `features.reasoning_effort_override` in the selected profile's `config.toml`. It preserves comments and quoted/dotted TOML keys. Version checks reject concurrent edits. Conflicting higher-priority configuration fails explicitly.
- A private receipt saves previous environment values and the two original feature settings. It contains paths and installation metadata, not keys or task content.

The app bundle is not modified. The bridge inherits the app-server's stdio directly; it does not proxy or rewrite its messages. Setup RPCs run only during installation/removal, not between model generations. The runtime uses the same evaluator and lease handling as the CLI. [App-server protocol documentation](https://learn.chatgpt.com/docs/app-server).

To remove it:

```sh
ares desktop uninstall
```

Fully quit and reopen the desktop app afterward. Removal restores an environment variable only while it still equals the Ares-installed value. It restores each feature flag only while its current value is still `true`; changes made by another tool or by you remain. Other settings, credentials, conversations, and Ares decision logs are retained. Modified generated launcher/LaunchAgent files cause an explicit error instead of being deleted. Activation diagnostics remain in `activation.log` alongside the former receipt location.

An interrupted operation leaves its receipt for recovery. If a process died while holding the installation lock, the CLI reports the lock path; verify that no install/remove operation is running before removing that lock. Do not delete the receipt before recovering the installation.

## Validation boundary

Tests cover saved custom paths with a minimal GUI environment, installation rollback, ownership-aware removal, and the actual generated launcher. A headless native fixture drives the pinned app-server through the launcher, receives native effort acknowledgements, checks lease reuse, verifies the effective `configuration_update` values and unchanged request prefix, and exercises native TOML editing. No paid inference is involved.

Launchctl and application opening are isolated test doubles. A live desktop restart, model picker rendering, and physical login/reboot have not been acceptance-tested for this implementation. The installer is macOS-only; ordinary Ares CLI support on Linux and Windows is unchanged.
