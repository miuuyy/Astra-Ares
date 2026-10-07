# Configuration

Run `ares configure` to save an OpenRouter key in a new installation. Run it again to replace the key for the current provider. Key entry is hidden and the config is written with mode `0600` on macOS/Linux. On Windows that mode sets no ACL; the file's privacy comes from your user-profile folder permissions, so avoid shared `ARES_CONFIG`/`ARES_HOME` locations. In an unlinked Windows checkout, run these commands as `node bin/ares.mjs …` (or `ares.cmd` after `npm.cmd link`).

```sh
ares config-path
ares configure --provider openrouter
ares doctor
ares doctor --probe
```

The last command makes one small, billable Jev request. Local `doctor` verifies the native binary and presence of a credential; it does not test account access or billing.

## Providers

| Explicit selection     | Evaluator                                  | Default key environment variable |
| ---------------------- | ------------------------------------------ | -------------------------------- |
| `openrouter` — default | `typesafe/jev-1.13`, native Decisions API  | `OPENROUTER_API_KEY`             |
| `vercel`               | `typesafe-ai/jev`, AI Gateway Evaluate API | `AI_GATEWAY_API_KEY`             |
| `typesafe`             | `jev-latest`, direct System One API        | `TYPESAFE_API_KEY`               |

Use a key issued by the selected provider. Change routes with `ares configure --provider typesafe` or `ares configure --provider vercel`. Providers are never switched automatically. OpenRouter is live-tested with a funded key; direct TypeSafe has adapter contract tests but no live acceptance here. See [paid access](paid-access.md).

For a key supplied through a password manager, `ares configure --key-stdin` reads the secret from standard input without printing it.

## Config file

Default: `~/.config/astra-ares/config.json`. `$XDG_CONFIG_HOME` is respected. An environment-based configuration looks like:

```json
{
  "provider": "openrouter",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "maxLeaseSteps": 10
}
```

| Field           | Meaning                                                     |
| --------------- | ----------------------------------------------------------- |
| `provider`      | `openrouter`, `vercel`, or `typesafe`                       |
| `apiKey`        | Inline credential stored by `configure`                     |
| `apiKeyEnv`     | Name of the environment variable containing the key         |
| `apiKeyFile`    | Absolute path to a private file containing the key          |
| `maxLeaseSteps` | `1`, `2`, `5`, or `10`; the largest duration offered to Jev |
| `codexBinary`   | Optional absolute path to a compatible patched Codex        |
| `codexHome`     | Optional absolute path to the native Codex profile/history  |

Choose only one of `apiKey`, `apiKeyEnv`, and `apiKeyFile`. With none set, the provider's default environment variable is read. A smaller `maxLeaseSteps` changes Jev's allowed lease choices; it does not prescribe the effort. Never commit a filled config file.

## Paths and logs

| Location               | Default / override                                 |
| ---------------------- | -------------------------------------------------- |
| Configuration          | `~/.config/astra-ares/config.json` / `ARES_CONFIG` |
| Data, builds, and logs | `~/.local/share/astra-ares` / `ARES_HOME`          |
| Native executable      | `<data>/bin/codex` (`codex.exe` on Windows)        |
| Native history         | `<data>/codex-home`, unless `codexHome` is set     |
| Decisions              | `<data>/runs/<run>/decisions.jsonl`                |

Decision logs contain request sizes, provider codes and request IDs, retry delays, usage, latency, and native application confirmations. They omit the API key and full task/history. Codex itself retains its normal native conversation history in its profile.

`evaluation_requested` records an evaluation attempt. `decision` with `native_step_context_captured` records successful native application. `reused: true` means the current lease was reused without another Jev request. Errors stop the turn explicitly and are described in [troubleshooting](troubleshooting.md).
