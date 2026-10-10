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
| `local`                | Explicit model on your System One service  | `ARES_LOCAL_API_KEY` (optional)  |

Use a key issued by the selected provider. Change routes with `ares configure --provider typesafe` or `ares configure --provider vercel`. Providers are never switched automatically. OpenRouter is live-tested with a funded key; direct TypeSafe has adapter contract tests but no live acceptance here. See [paid access](paid-access.md).

For a key supplied through a password manager, `ares configure --key-stdin` reads the secret from standard input without printing it.

### Other OpenRouter decision models

Jev remains the default. To select another model from the [OpenRouter Decisions catalog](https://openrouter.ai/api/v1/models?output_modalities=decisions), specify its exact ID and a conservative input-token guard appropriate to its context window:

```sh
ares configure --provider openrouter --decision-model cloudflare/clef-flash --context-token-limit 60000
```

Enter your existing OpenRouter key. For an 8k model, use a smaller limit such as `7000`. The limit counts the complete request with the local `o200k_base` tokenizer, not the evaluator's own tokenizer, so leave room for differences, service overhead, and its response. No catalog lookup or automatic model selection is added to the decision path. Changing the model requires an explicit new limit. Non-default models must return the exact requested ID; use the catalog's `canonical_slug` when a public alias resolves to a dated model. Model substitution is rejected. Provider fallbacks are disabled, and the serving provider is recorded. Decision quality is model- and workload-dependent.

For Kev, the verified canonical ID is `jaredpalmer/kev-4b-20260924`; use `--context-token-limit 7000`. Both that ID and `cloudflare/clef-flash` completed a small live decision probe. This verifies API compatibility, not decision quality on coding tasks.

Provider restrictions still apply. For example, Clef-flash rejected a one-option lease question (`maxLeaseSteps: 1`) in a direct API check, but accepted the two-option question with `maxLeaseSteps: 2`. Ares surfaces that rejection instead of changing your configured lease limit or inventing an answer.

### A local or self-hosted evaluator

Run a decision service separately, then configure its base URL, exact model ID, and input budget:

```sh
ares configure --provider local --base-url http://127.0.0.1:8890 --decision-model your-decision-model --context-token-limit 7000
```

Press Enter at the key prompt only if that service needs no authentication. Non-interactive configuration still requires `--key-stdin`, including an empty input for no key. Ares never carries a previous provider's credentials into the new route. Switching providers clears their endpoint/model settings; changing a local endpoint clears its stored credential. An explicitly configured but missing or malformed credential is an error.

The service must implement `POST /v1/systemone`. This is a decision API, not `/chat/completions`: an ordinary Ollama, LM Studio, or vLLM endpoint alone is insufficient. Ares sends the model ID, a JSON-encoded string containing the bounded task state, and the unchanged typed `effort` and `lease` questions with their full criteria. The service must support a one-option lease question when `maxLeaseSteps` is `1` and return:

```json
{
  "model": "your-decision-model",
  "answers": {
    "effort": { "type": "choice", "choice": "low" },
    "lease": { "type": "choice", "choice": "1" }
  }
}
```

Only offered choices are valid. Responses must name the configured model exactly. Invalid responses stop the turn; no free-form answer is converted into a decision. No model server, weight download, background service, or extra renderer is installed. Local inference quality and hardware latency are not established by the HTTP fixture tests. Unknown local cost is logged as `null`, not as measured zero cost.

### OpenCode Zen

[OpenCode Zen](https://opencode.ai/docs/zen/) serves Jev through the same decision API at `https://opencode.ai/zen/v1/systemone`, so the `local` route can use it. The input budget matches the built-in Jev routes:

```sh
ares configure --provider local --base-url https://opencode.ai/zen --decision-model jev-1.13-free --context-token-limit 28000
```

OpenCode documents key-based access: enter your Zen API key at the prompt, and Ares sends it as a bearer token. The default key environment variable for this route is `ARES_LOCAL_API_KEY`, not `OPENCODE_API_KEY`. OpenCode lists `jev-1.13-free` as available for a limited time and does not say how its request data is used. As with any `local` evaluator, fresh evaluation cost is logged as `null`.

On October 10, 2026, `jev-1.13-free` also answered without a key. That configuration passed `ares doctor --probe` on Linux x64 with `maxLeaseSteps` set to `1`, `2` and `10`, and completed Astra Ares `exec` and TUI sessions. Keyed access and the paid `jev-1.13` were not tested.

## Config file

Default: `~/.config/astra-ares/config.json`. `$XDG_CONFIG_HOME` is respected. An environment-based configuration looks like:

```json
{
  "provider": "openrouter",
  "apiKeyEnv": "OPENROUTER_API_KEY",
  "maxLeaseSteps": 10
}
```

| Field               | Meaning                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `provider`          | `openrouter`, `vercel`, `typesafe`, or `local`                                                                                  |
| `baseUrl`           | Required for `local`; HTTP(S) base URL without credentials, query, or fragment                                                  |
| `decisionModel`     | Required for `local`, optional for `openrouter`; exact evaluator ID                                                             |
| `contextTokenLimit` | Required for custom evaluators; positive input-token guard. Built-in Jev routes default to 28,000 and allow only smaller limits |
| `apiKey`            | Inline credential stored by `configure`                                                                                         |
| `apiKeyEnv`         | Name of the environment variable containing the key                                                                             |
| `apiKeyFile`        | Absolute path to a private file containing the key                                                                              |
| `maxLeaseSteps`     | `1`, `2`, `5`, or `10`; the largest duration offered to Jev                                                                     |
| `codexBinary`       | Optional absolute path to a compatible patched Codex                                                                            |
| `codexHome`         | Optional absolute path to the native Codex profile/history                                                                      |

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
