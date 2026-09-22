# The openjev provider

`openjev` points Ares at a **locally running decision service** instead of a hosted
Jev gateway. It speaks the same TypeSafe-shaped `/v1/systemone` contract that
`spark-jev-stack/decision` on dgx-01 and `openjev/service.mjs` on the Mac serve,
so the decision model runs on your own hardware — typically on the tailnet, a few
hops away, with round trips around 150 ms instead of a public-internet round trip
per decision.

## Configuration

```jsonc
// ~/.config/astra-ares/config.json
{
  "provider": "openjev",
  "baseUrl": "http://127.0.0.1:8890", // required; http(s), no query/fragment
  "model": "open-jev", // optional model name sent to the service
  "apiKeyEnv": "OPENJEV_API_KEY", // optional; the service may not need a key
  "maxLeaseSteps": 10,
}
```

- `baseUrl` is required and validated (absolute http/https URL, no query or
  fragment; trailing slashes are normalized away).
- A credential is **optional**: with no `apiKey`/`apiKeyEnv`/`apiKeyFile` and no
  `OPENJEV_API_KEY` in the environment, requests are sent unauthenticated.
- `ares configure --provider openjev --base-url http://127.0.0.1:8890` accepts an
  empty key (press enter) for unauthenticated local services.

## Protocol

The client sends exactly one `POST {baseUrl}/v1/systemone` per decision:

```jsonc
{
  "model": "open-jev",
  "state": "MODEL: gpt-6-astra\nSTEP: 3 ...\nTASK:\n...", // the structured state, rendered
  "questions": {
    "effort": {
      "type": "choice",
      "instructions": "...",
      "criteria": { "none": "...", "low": "..." },
    },
    "lease": {
      "type": "choice",
      "instructions": "...",
      "criteria": { "1": "...", "2": "..." },
    },
  },
}
```

The structured evaluator state is rendered to bounded plain text by
`src/state-text.mjs` (deterministic section order, per-item and total caps, no
truncation without an explicit marker). Hosted providers keep receiving the
structured state unchanged; only `openjev` renders it, because local decision
services take `state` as a string.

The service must echo the request id keys and answer both questions as
`{type: "choice", choice: <one of the criteria keys>}`. Responses are validated
like every other provider: effort must be one of the model's supported efforts,
lease one of `1|2|5|10` (capped by `maxLeaseSteps`), and an invalid answer never
falls back to a guessed value — the decision is rejected.

## Failure semantics

Identical to the hosted providers: transport errors, timeouts (30 s deadline),
HTTP 5xx/429 are retried up to three times against the same `baseUrl`; Ares never
silently switches providers, substitutes models, or invents efforts. A rejected
or exhausted decision stops the current turn visibly. `cost` is reported as
`null` — there is no metering on a local service.

## Compatibility notes

- Responses may carry either `usage: {input_tokens, output_tokens}` or the
  reference service's `{decisions, images, latency_ms}` shape; the latter maps to
  unknown token counts rather than being rejected.
- `noul`/`score` question types are part of the shared service contract (see
  `openjev/README.md`); Ares only ever sends `choice` questions.
