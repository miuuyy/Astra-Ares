# Testing

The test suite verifies the router's contracts at two levels. It does not establish model quality, cost savings, or production availability.

## Unit and regression tests

```sh
npm ci
npm test
```

On Windows PowerShell, use `npm.cmd ci` and `npm.cmd test`. These tests require no API keys. They cover effort/lease validation, lease reuse and invalidation, bounded tool previews, Unicode and JSON escaping, exact-body HTTP retries, cancellation, explicit provider errors, credential handling, and CLI configuration.

Launcher regressions cover prompt text after `--`, option values that resemble flags or commands, and rejection of actual unsupported transports. RPC regressions verify that a missing executable rejects pending and future calls immediately instead of waiting for the request timeout.

## Native integration fixtures

Build or adopt the compatible native Codex, install Bun, then run:

```sh
# macOS/Linux
JEV_TEST_BINARY="$HOME/.local/share/astra-ares/bin/codex" npm run test:native
```

```powershell
# Windows PowerShell (default ARES_HOME)
$env:JEV_TEST_BINARY = Join-Path $HOME '.local\share\astra-ares\bin\codex.exe'
npm.cmd run test:native
```

For a custom binary path, set `JEV_TEST_BINARY` accordingly. The suites run the actual native executable against explicit local Responses and Jev fixtures; they do not spend API credits.

| Suite           | Boundary checked                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Context         | Task text and public notes preserved; recent tool previews bounded; main-model history unchanged; opaque reasoning excluded        |
| Session         | Settings acknowledged before inference; leases; accepted user input; cancellation; visible provider failure; ordinary-model bypass |
| Selection       | Native model selection, restart/resume, effort updates, original prefix retained, missing bridge rejected before inference         |
| Desktop (macOS) | Generated desktop launcher, saved config paths, native TOML editing, lease reuse, effective effort updates, and uninstall          |

Artifacts are written under ignored `work/` directories. Request-prefix preservation is not a measurement of production prompt-cache hit rate. Local build and runtime acceptance covers Apple Silicon macOS and Windows 11 x64; other platform and long-session compaction coverage remains limited. CI runs unit tests and package checks on Linux, macOS and Windows. The manually dispatched native build runs setup and these fixtures on macOS and Windows x64. On Windows, that covers the named-pipe bridge and native checkpoints. Fixture tool calls do not exercise real Windows command execution or the optional elevated Windows sandbox, and do not establish provider quality or long-session reliability.

## Live checks

```sh
ares doctor          # local installation and configuration checks
ares doctor --probe  # one small, billable Jev request
```

A successful probe verifies that the configured provider accepted one request. It does not guarantee sustained capacity or validate Astra's task quality. Check local decision logs for provider errors, request sizes, lease reuse and native acknowledgements during your own workloads. Keep task transcripts and credentials out of public reports.

The desktop fixture uses the real patched binary and local HTTP model/evaluator fixtures, with isolated launchctl/open calls. It does not launch the desktop app or establish UI/login/reboot acceptance. See [desktop validation limits](desktop.md#validation-boundary).
