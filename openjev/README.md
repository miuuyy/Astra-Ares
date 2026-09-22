# openjev — local decision service

The Mac-side half of the openjev port: a small, zero-dependency Node service that
exposes the TypeSafe-shaped `/v1/systemone` decision contract in front of any
OpenAI-compatible small model. It is the same shape as the `decision/` service in
`spark-jev-stack` on dgx-01, so an Ares pointed at either one behaves identically.

## Why

Ares asks Jev which reasoning effort (and lease length) to apply before every
generation. With hosted providers each decision is a public-internet round trip.
Running the decision model on the LAN removes that latency entirely:

| path | measured |
| --- | --- |
| dgx-01 → MacBook (tailscale) → Qwen3.5-0.8B → reply | **162 ms** round trip |
| decision alone (localhost, warm) | **~130–460 ms** for effort + lease |

## How decisions work (the openjev-sglang pattern)

1. Options are rendered as a lettered list (`A. low — description ...`).
2. Generation is grammar-constrained to a single letter
   (`response_format: json_schema` with an `enum` of `A`–`Z`), with thinking
   disabled (`chat_template_kwargs.enable_thinking: false` for Qwen).
3. The per-option distribution is read from that token's `top_logprobs` —
   one short generation per question, no free-form output to parse, and
   calibrated probabilities fall out of the same pass.

Both questions (effort + lease) are answered in parallel and returned in the
TypeSafe answer shape:

```json
{
  "model": "…/Qwen3.5-0.8B-Q8_0.gguf",
  "answers": {
    "effort": {"type": "choice", "choice": "low", "probabilities": {"low": 0.67, "none": 0.30}, "confidence": 0.67},
    "lease":  {"type": "choice", "choice": "2",  "probabilities": {"1": 0.11, "2": 0.36},  "confidence": 0.36}
  },
  "usage": {"input_tokens": 531, "output_tokens": 7, "decisions": 2, "latency_ms": 452.83}
}
```

## Endpoints

| endpoint | notes |
| --- | --- |
| `POST /v1/systemone` | `{state: string \| object, questions: object \| list}` — object states are rendered with the same renderer the provider uses |
| `POST /v1/decide` | list form, answers returned as an array |
| `POST /v1/chat/completions` | OpenAI shim: last user message contains `{state, questions}` JSON (use `model: "decide"`) — same as the dgx gateway's decide shim |
| `GET /v1/models` | single local model |
| `GET /health` | backend reachability + counters (no auth required) |

## Run it on the Mac

```bash
# 1. backend (llama.cpp, Metal) — small model, full GPU offload
llama-server --model ~/ai/models/Qwen3.5-0.8B-Q8_0.gguf \
  --port 8911 --host 127.0.0.1 -c 16384 -np 2 -ngl 99 --jinja &

# 2. decision service — binds 0.0.0.0 so the tailnet can reach it
node openjev/service.mjs &        # listens on :8890

curl -s localhost:8890/health | python3 -m json.tool
```

Model used: `ggml-org/Qwen3.5-0.8B-GGUF` (Q8_0, sha256-verified) — the same
Qwen3.5-0.8B the spark-jev-stack experiments validated for this role, now as the
official llama.cpp GGUF. It is a decision reader, not a chat model; quality bar
is "pick the right option label", which is what the logit-readout pattern needs.

### Environment

| var | default | meaning |
| --- | --- | --- |
| `OPENJEV_PORT` / `OPENJEV_HOST` | `8890` / `0.0.0.0` | service bind (0.0.0.0 = tailnet-reachable) |
| `OPENJEV_BACKEND_URL` | `http://127.0.0.1:8911` | OpenAI-compatible backend base (llama-server) |
| `OPENJEV_BACKEND_MODEL` | auto from `/v1/models` | backend model id |
| `OPENJEV_MODEL_ID` | backend model id | id reported in `/v1/models` and responses |
| `OPENJEV_TOKEN` | unset | require `Authorization: Bearer <token>` on all endpoints except `/health` |
| `OPENJEV_CHAT_TEMPLATE_KWARGS` | `{"enable_thinking": false}` | forwarded to the backend; Qwen needs thinking off or it answers in a think block |
| `OPENJEV_MAX_STATE_CHARS` | `60000` | head+tail cap for string states |
| `OPENJEV_QUESTION_CHARS` | `6000` | head+tail cap per question's instructions |

## Keep it running (launchd)

Copy the provided plists and load them; they restart on failure and at boot:

```bash
cp openjev/com.openjev.*.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openjev.backend.plist
launchctl load ~/Library/LaunchAgents/com.openjev.decision.plist
```

## Point Ares at it

Local (same Mac, lowest latency):

```bash
ares configure --provider openjev --base-url http://127.0.0.1:8890   # key: press enter
ares doctor --probe
```

From another machine on the tailnet (e.g. a Spark):

```jsonc
// ~/.config/astra-ares/config.json on that machine
{
  "provider": "openjev",
  "baseUrl": "http://macbook:8890",
  "maxLeaseSteps": 10
}
```

(`macbook` resolves via MagicDNS; `100.111.125.20` works too. Add
`"apiKeyEnv": "OPENJEV_API_KEY"` if the service was started with `OPENJEV_TOKEN`.)

The provider is also compatible with the dgx-01 `spark-jev-stack` decision
service (`http://dgx-01:8890` / its tailscale HTTPS serve) — same contract,
different host. Note that the GPU there is usually busy with the generation
model; the Mac service is the intended default.

## Security notes

- The service binds all interfaces so other tailnet devices can use it. That
  also means any machine that can route to the Mac can ask for decisions.
  Prefer `OPENJEV_TOKEN` when the tailnet is shared.
- `/health` is always open and never includes state or answers.
- States are rendered locally and sent only to the configured backend; nothing
  is logged beyond method/path/status/latency.
