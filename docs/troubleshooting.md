# Troubleshooting

Start with `ares doctor`, then `ares doctor --probe`. The second command makes one small real evaluator request. It does not invoke Astra.

| Error category           | Meaning / next action                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local_context_limit`    | Nothing was sent. The whole request exceeded the local 28K guard despite bounded tool previews. Start a new focused turn/context or reduce the request; do not assume switching API keys helps. |
| `context_limit`          | Provider explicitly returned a context-limit code. Preserve the request size/code in the log. The bridge does not retry an unchanged oversized request.                                         |
| `rate_limit_or_capacity` | HTTP 429. Read `providerCode`, `providerMessage`, request ID, local tokens, and retry events. A small request can fail due to account rate limits or provider capacity.                         |
| `quota`                  | Billing/credit/account budget rejection. Supply a funded or authorized key; no automatic retries or purchases.                                                                                  |
| `authentication`         | Check the selected provider and its matching key. A Vercel key cannot authenticate directly to TypeSafe.                                                                                        |
| `provider_unavailable`   | Transient upstream HTTP error; bounded retries are logged.                                                                                                                                      |
| `timeout` / `network`    | The evaluator did not return within the deadline or transport failed. Current turn stops explicitly.                                                                                            |

Transient status codes: 408, 429, 500, 502, 503, 504, 529. Maximum three attempts and a 30-second total deadline. Backoff begins at 500 ms with jitter. A server `Retry-After` that exceeds the deadline is reported without an early retry. No provider switch is made.

Vercel documents per-model rate limits for free accounts in its [pricing tutorial](https://vercel.com/academy/ai-gateway/ai-gateway-pricing). TypeSafe documents dynamically adjusted limits and a [32K state-plus-longest-question budget](https://docs.typesafe.ai/models). These are independent limits. A 429 alone cannot establish which one was hit.

To remove the gateway from the path, explicitly configure `provider: "typesafe"` and a TypeSafe key. This is an operator choice, not an automatic recovery strategy. A better-funded key may resolve account quota, but cannot guarantee recovery from an upstream capacity incident.

For paid access through a different gateway, `ares configure --provider openrouter` selects OpenRouter's native Decisions endpoint with a funded OpenRouter key. It still serves TypeSafe's model; another billing route is not a guarantee of extra upstream capacity. A 402 means insufficient credit; 429 remains a rate/capacity error. See [paid access](paid-access.md).

After upgrading the local bridge, quit and relaunch `astra-ares resume --last`; a running Node process retains its loaded code. Your native Codex thread/history remains on disk.

## Codex desktop app

If the desktop UI shows Astra Ares but a turn fails with:

```text
Fatal error: Jev bridge: Jev requires native step_model_switching and reasoning_effort_override
```

the selected model reached a patched Ares checkpoint, but the running desktop session does not have both native feature flags enabled. This usually means the Codex app was already running before `ares desktop install`, it launched without the installed `CODEX_CLI_PATH` override, or the selected desktop Codex home does not have the required feature flags persisted in `config.toml`.

Fix:

```sh
ares desktop install
ares desktop status
```

Confirm `codexCliPath` points at `codex-desktop-launcher.mjs` and `desktopFeatureFlags` shows both required flags as `true`, then fully quit and reopen the Codex app. `ares desktop open` also installs the LaunchAgent, writes the feature flags, and opens a fresh app instance with the override. Do not launch `<data>/bin/codex app-server` directly for desktop use; the Ares desktop launcher starts the Jev bridge and prepends `features.step_model_switching=true` and `features.reasoning_effort_override=true`, while `ares desktop install` persists those flags for the desktop session config.

## Native warning items during resume

The pinned native build retains the `Astra-Jev` model name and the prototype's `Launch codex-jev` hint if started without its bridge. For Astra-Ares, start through `astra-ares`; launching the native executable directly does not start the bridge.

Codex's JSON output represents some native warnings as `item.type: error`. The experimental-feature notice is expected for `step_model_switching` and `reasoning_effort_override`. The pinned build also compares the recorded logical name `Astra-Jev` with its resolved base `gpt-6-astra` on resume, producing a cosmetic model-change warning even when this is the same intended model. These notices do not establish a failed turn; check `turn.failed`, process exit status, and the bridge's `controller_error`/`provider_error` records. The false alias comparison remains a known diagnostic limitation.

## Build trouble

`setup` fails on an archive/patch checksum mismatch, an incomplete build directory, or a stock binary without the native checkpoint. It does not continue with an unpatched CLI. For a failed source extraction, inspect/remove only the indicated build directory and rerun setup. Keep at least 10 GB free. Build artifacts can be removed after installation; keep `<data>/bin`, config, and Codex history.

### macOS: `mis-aligned LINKEDIT string pool`

This error can occur while Rust loads a proc-macro library such as `sqlx_macros`. The upstream `dev-small` profile strips symbols, which can produce a misaligned Mach-O string table rejected by the macOS 27 loader. See [issue #4](https://github.com/miuuyy/Astra-Ares/issues/4) and the [Rust report](https://github.com/rust-lang/rust/issues/157750).

The installer now sets `CARGO_PROFILE_DEV_SMALL_STRIP=none` for macOS builds. It preserves the symbol table without enabling full debug information. Linux keeps the upstream profile. This is selected by build platform, not the reported macOS version, because the build toolchain and SDK affect the generated library.

From an existing source checkout, update and retry:

```sh
git pull --ff-only
npm ci
npm run setup
```

Cargo rebuilds affected artifacts when the profile setting changes; deleting your configuration, login, sessions, or the entire build directory is unnecessary. The resulting macOS binaries and intermediate libraries may be larger.
