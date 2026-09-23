# Decision turnaround — openjev local vs hosted Jev

Date: 2026-09-23. Machine: Apple M4 Pro, 24 GB unified memory, macOS.
Backend: llama.cpp 0.4.1 (Metal, `-ngl 99`, 2 slots), decision service `openjev/service.mjs`.
Client: the real `src/jev.mjs` openjev provider (render → HTTP → validate), as an Ares turn pays it.

**Co-tenancy caveat:** during these runs another workload on the same Mac was
executing a 7-core index rebuild under heavy memory pressure (~41 GB swap in
use). Numbers are therefore *pessimistic* for absolute latency, and *fair* for
the 0.8B-vs-4B comparison (identical conditions). The 4B degrades
disproportionately under memory pressure because its per-token compute
amplifies weight-eviction stalls.

## Modes

- **repeat** — identical request body; upper bound of prefix-cache benefit.
- **evolving** — fixed task/notes, tool-result window slides by one per call:
  the real steady-state pattern of an Ares turn sequence.
- **varied** — fresh content everywhere per call: worst case (cold session or
  unrelated task), full prompt reprocessing.

## Results (client-level p50, 3 s pacing between decisions)

| state size (~tokens) | mode | 0.8B Q8_0 | 4B Q5_K_M |
| --- | --- | --- | --- |
| tiny (~1.3k) | repeat | **137 ms** | 301 ms |
| tiny (~2.5k) | evolving | **141 ms** | 309 ms |
| tiny (~1.3k) | varied | 435 ms | 2,348 ms |
| realistic (~5.8k) | repeat | **161 ms** | 355 ms |
| realistic (~5.8k) | evolving | **141 ms** | — (timed out >30 s) |
| realistic (~5.8k) | varied | 1,514 ms | 9,329 ms |
| large (~11.3k) | evolving | **181 ms** | — |
| large (~11.3k) | varied | 3,041 ms | — |
| max (~12.5k) | evolving | **182 ms** | — |
| max (~12.5k) | varied | 3,383 ms | — |

Supporting measurements:

- **Prompt-processing rate** (from llama-server timing logs, same conditions):
  0.8B ≈ 0.38 ms/token (**2,640 tok/s**) at 6k-token prompts, even under memory
  pressure; 4B ≈ 2.9–3.6 ms/token (~300 tok/s) with collapses to 24–29 ms/token
  (34–40 tok/s) under eviction stalls. When the machine was quieter the 4B did
  767 tok/s — the gap is co-tenancy, not the model's ceiling.
- **Cold start** (fresh stack, first decision, prompt cache empty): 0.58 s;
  model load at backend start: ~1.1 s (once, at login/boot via launchd).
- **Tailscale hop**: decision served to another tailnet host measured earlier
  at **162 ms RTT total** (132 ms model-internal → ~30 ms wire+stack). From the
  Mac via its own 100.x IP: p50 243 ms vs 240 ms model-internal (loopback
  netstack; no wire). Treat the tailscale cost as ~5–30 ms on the LAN.

## Comparison with hosted Jev

Reference point for hosted Jev: **~310 ms p50** measured against the same
decision workload in earlier community benchmarking (`jev-router` quorum bench);
vendor documentation claims 70–500 ms. No hosted key was available during this
session for a live A/B, so the comparison uses those priors:

| decision path | steady-state (evolving) | cold/varied |
| --- | --- | --- |
| **openjev local, 0.8B** (this Mac) | **~140–180 ms** | 0.4–3.4 s (scales with size) |
| **openjev local, 4B** (this Mac) | ~300 ms (quiet) | 2.3–9+ s; stall-risk under co-tenancy |
| hosted Jev (prior measurement) | ~310 ms p50 | same (billed per input token) |

**Headline: the 0.8B local path is ~2× faster than hosted Jev in steady state
and is free, with the worst case (full cold reprocessing of a 12.5k-token
state) at ~3.4 s — paid only on the first decision of an unrelated session.**
Real turn sequences keep the task prefix cached, so the common case is the
~140–180 ms row regardless of state size up to at least ~12.5k tokens.

## Per-generation amortization

Ares asks once per lease, not once per generation. In these runs the models
picked leases of 2–5 on ambiguous synthetic states; on clear routine steps the
observed lease was 2–10. Amortized overhead per Astra generation at lease 2:

- local 0.8B: ~70 ms per generation — 0.1–0.7% of a 10–60 s generation.
- hosted Jev at 310 ms p50: ~155 ms per generation.

## Model choice

- **0.8B Q8_0 (recommended default):** robust under memory pressure,
  2,600 tok/s prompt processing, ~140 ms decisions. Known weakness: flat
  discrimination on hard tasks (stays `low`).
- **4B Q5_K_M:** better discrimination (typo→`low`, hard design→`medium`) but
  2–6× slower here and stall-prone under co-tenancy. Choose it only when the
  machine is quiet and decision quality matters more than turnaround.

Swap by editing `--model` in `~/Library/LaunchAgents/com.openjev.backend.plist`
and reloading both launchd jobs; any OpenAI-compatible backend works.

## Reproducing

```bash
node bench/decisions-bench.mjs --url http://127.0.0.1:8890 --n 10 --gap-ms 3000 --sizes tiny,realistic
node bench/decisions-bench.mjs --url http://127.0.0.1:8890 --n 5 --gap-ms 2000 --sizes large,max
```
