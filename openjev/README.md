# openjev — local decision service

A small, zero-dependency Node service that exposes the TypeSafe-shaped
`/v1/systemone` decision contract in front of any OpenAI-compatible small model.
Point the `openjev` provider at it and Ares makes its decisions on your own
hardware instead of a hosted gateway. It speaks the same shape as other local
System One implementations, so any conforming decision service works.

## Why

Ares asks Jev which reasoning effort (and lease length) to apply before every
generation. With hosted providers each decision is a public-internet round trip
(measured ~310 ms p50 in prior work). Running the decision model on the LAN
removes that round trip; steady-state decisions on an M4 Pro measured
**~140–180 ms** with the 0.8B model, and ~5–30 ms of that was the wire.

Model choice matters more than speed here — it is the decision quality:

| model (GGUF) | trivial task | hard task | decision latency |
| --- | --- | --- | --- |
| `ggml-org/Qwen3.5-0.8B-Q8_0` | low ✓ | low ✗ (no discrimination) | ~180–460 ms |
| `unsloth/Qwen3.5-4B-Q5_K_M` **(default)** | low ✓ | medium ✓ | ~600–1100 ms |

Both live in `~/ai/models/`. Swap via the backend plist's `--model` argument
(or any OpenAI-compatible endpoint at all — vLLM on the Sparks, LM Studio, etc.);
the decision service only needs `/chat/completions` with `response_format` and
`logprobs` support.

## How decisions work (the openjev-sglang pattern)

1. Options are rendered as a lettered list (`A. low — description ...`).
2. Generation is grammar-constrained to a single letter
   (`response_format: json_schema` with an `enum` of `A`–`Z`), with thinking
   disabled (`chat_template_kwargs.enable_thinking: false` for Qwen).
3. The per-option distribution is read from that token's `top_logprobs` —
   one short generation per question, no free-form output to parse, and
   calibrated probabilities fall out of the same pass.

The applied `choice` is the grammar-constrained answer, so it is always one of
the offered options. The reported `probabilities` are the backend's raw
next-token distribution over the option letters (pre-grammar-mask, renormalized
over the letters it returned) — the same raw-logits character as the
spark-jev-stack option-logit readout — so its argmax can occasionally differ
from the constrained choice; treat it as a confidence signal, not a second
decision.

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
# 1. backend (llama.cpp, Metal) — 4B default (better decisions), 0.8B for lowest latency
llama-server --model ~/ai/models/Qwen3.5-4B-Q5_K_M.gguf \
  --port 8911 --host 127.0.0.1 -c 16384 -np 2 -ngl 99 --jinja &

# 2. decision service — loopback only by default
node openjev/service.mjs &        # listens on 127.0.0.1:8890

curl -s localhost:8890/health | python3 -m json.tool
```

Models: `unsloth/Qwen3.5-4B-GGUF` (Q5_K_M) and `ggml-org/Qwen3.5-0.8B-GGUF`
(Q8_0), both sha256-verified — the same Qwen3.5 family the spark-jev-stack
experiments validated for this role. They are decision readers, not chat
models; the quality bar is "pick the right option label", which is what the
logit-readout pattern needs.

### Environment

| var | default | meaning |
| --- | --- | --- |
| `OPENJEV_PORT` / `OPENJEV_HOST` | `8890` / `127.0.0.1` | service bind; a non-loopback host requires `OPENJEV_TOKEN` (or the opt-out below) |
| `OPENJEV_BACKEND_URL` | `http://127.0.0.1:8911` | OpenAI-compatible backend base (llama-server) |
| `OPENJEV_BACKEND_MODEL` | auto from `/v1/models` | backend model id |
| `OPENJEV_MODEL_ID` | backend model id | id reported in `/v1/models` and responses |
| `OPENJEV_TOKEN` | unset | require `Authorization: Bearer <token>` on all endpoints except `/health` |
| `OPENJEV_ALLOW_UNAUTHENTICATED` | unset | `1` allows a non-loopback bind without a token (trusted networks only) |
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

Substitute the placeholders first (`NODE_PATH`, `HOME_PATH`, `DEPLOY_DIR`,
`PATH_TO_HOME`).

**macOS TCC warning:** launchd agents are *not* granted Documents-folder access,
and Node blocks indefinitely on a first read of a `~/Documents` file under TCC.
Do not point the service at a path under `~/Documents` (or `~/Desktop`/`~/Downloads`).
Deploy a runtime copy somewhere unprotected — the service imports
`../src/state-text.mjs`, so mirror the two-file layout:

```bash
mkdir -p ~/ai/openjev/src ~/ai/src
cp openjev/service.mjs ~/ai/openjev/service.mjs
cp src/state-text.mjs ~/ai/src/state-text.mjs
# then point the decision plist's ProgramArguments at /Users/<you>/ai/openjev/service.mjs
```

Restart after editing: `launchctl unload <plist> && launchctl load <plist>`.

## Point Ares at it

Local (same Mac, lowest latency):

```bash
ares configure --provider openjev --base-url http://127.0.0.1:8890   # key: press enter
ares doctor --probe
```

From another machine on your tailnet/LAN, first expose the service explicitly
on the decision host:

```bash
OPENJEV_HOST=0.0.0.0 OPENJEV_TOKEN=<long-random-token> node openjev/service.mjs
```

Then on the client:

```jsonc
// ~/.config/astra-ares/config.json on that machine
{
  "provider": "openjev",
  "baseUrl": "http://<decision-host>:8890",
  "maxLeaseSteps": 10
}
```

(Use a MagicDNS/LAN hostname or IP, and provide the token with
`ares configure --key-stdin` or `OPENJEV_API_KEY`.)

## Security notes

- The service binds loopback by default. Serving other machines is opt-in:
  set `OPENJEV_HOST` to a non-loopback address, and the service refuses to
  start unless `OPENJEV_TOKEN` is set (or `OPENJEV_ALLOW_UNAUTHENTICATED=1`
  acknowledges that anything that can route to the host may request decisions).
- `/health` is always open and never includes state or answers.
- States are rendered locally and sent only to the configured backend; nothing
  is logged beyond method/path/status/latency.
