#!/usr/bin/env node
// Decision turnaround benchmark for the openjev port.
//
// Measures, per state size, the end-to-end decision latency an Ares turn
// actually pays: the real Jev client (state render -> HTTP -> service ->
// backend -> validate) plus the bare service path for attribution.
// Each size runs a "varied" pass (fresh state content per iteration,
// prefix-cache-realistic) and a "repeat" pass (identical body, best case).
//
// Usage: node bench/decisions-bench.mjs [--url http://127.0.0.1:8890] \
//          [--n 20] [--sizes tiny,realistic,large,max]
import { Jev } from "../src/jev.mjs";
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const BASE_URL = flag("url", "http://127.0.0.1:8890");
const N = Number(flag("n", "20"));
const GAP = Number(flag("gap-ms", "0"));
const SIZES = (flag("sizes", "tiny,realistic,large,max") || "").split(",");

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function filler(seed, targetChars) {
  const words = "the renderer caches model token prefix lease effort tool output task notes public reasoning summary recent call status success failure retry batch context window guard trim marker head tail budget estimate".split(" ");
  const lines = [];
  let size = 0;
  let i = seed;
  while (size < targetChars) {
    const line = `line ${i}: ${words[i % words.length]} ${words[(i * 7) % words.length]} ${words[(i * 13) % words.length]} ${words[(i * 29) % words.length]}`;
    lines.push(line);
    size += line.length + 1;
    i++;
  }
  return lines.join("\n");
}

let EVOLVING = false;

function makeState(size, iteration) {
  const targets = {
    tiny: { notes: 200, tools: 1, out: 300 },
    realistic: { notes: 2500, tools: 6, out: 700 },
    large: { notes: 12000, tools: 6, out: 900 },
    max: { notes: 55000, tools: 6, out: 1200 },
  }[size] ?? { notes: 2000, tools: 4, out: 500 };
  // Evolving mode simulates a real turn sequence: task and notes stay fixed,
  // the recent-tool window slides by one call per iteration.
  const window = EVOLVING ? 6 : targets.tools;
  const first = EVOLVING ? Math.max(0, iteration - window + 1) : 0;
  const recentToolCalls = [];
  for (let t = first; t < first + window; t++) {
    const k = EVOLVING ? t : t;
    recentToolCalls.push({
      callId: `c${k}-${k % 4}`,
      name: ["shell", "read", "edit", "grep"][k % 4],
      namespace: k % 2 ? "exec" : undefined,
      input: `${["npm test", "read src/auth.ts", "edit src/auth.ts:42", "grep -rn rotate"][k % 4]} (iter ${k})`,
      outputs: [{ text: filler(k * 31 + (k % 4), targets.out), success: k % 4 !== 2 }],
    });
  }
  const noteSeed = EVOLVING ? 0 : iteration;
  return {
    model: "gpt-6-astra",
    supportedEfforts: EFFORTS,
    latestUserPrompt: EVOLVING
      ? "Refactor the auth module to the new rotation API."
      : `Refactor the auth module to the new rotation API (iter ${iteration}).`,
    originalTask: "Refactor the auth module to the new rotation API, updating all call sites and tests.",
    priorUserPrompts: ["Also keep the legacy shim working."],
    historyScope: "native_retained_history",
    omittedOlderToolCalls: 4 + iteration,
    step: 3 + (iteration % 5),
    previousEffort: ["low", "medium", "high"][iteration % 3],
    newToolFailures: iteration % 4 === 0 ? 1 : 0,
    publicNotes: [
      { kind: "reasoning_summary", text: `Mapped call sites; rotation endpoint differs in error semantics. ${filler(noteSeed, targets.notes)}` },
      { kind: "progress", text: filler(noteSeed * 3 + 1, Math.floor(targets.notes / 2)) },
    ],
    recentToolCalls,
  };
}

const QUESTIONS = {
  effort: {
    type: "choice",
    instructions:
      "Which reasoning effort is sufficient for the NEXT generation of state.model? Judge the reasoning work ahead. Identify the current phase and what remains unresolved; select the lowest effort that can advance that goal reliably.",
    criteria: {
      none: "No reasoning needed: the next response is fully determined.",
      minimal: "Immediate, unambiguous next step.",
      low: "Routine continuation of an established plan.",
      medium: "Compare a few local alternatives; bounded diagnostic step.",
      high: "Material uncertainty across interacting code paths.",
      xhigh: "Difficult synthesis across subsystems.",
      max: "First-principles or proof-like correctness argument.",
      ultra: "Evidence specifically justifies reasoning beyond max.",
    },
  },
  lease: {
    type: "choice",
    instructions: "For how many upcoming model generations is the required reasoning depth likely to stay stable?",
    criteria: { 1: "Reassess after the next generation.", 2: "Predictable short continuation.", 5: "Established sequence.", 10: "Sustained predictable phase." },
  },
};

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
const stats = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length,
    min: s[0],
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    max: s.at(-1),
    mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
  };
};

async function main() {
  const client = new Jev({
    provider: "openjev",
    baseUrl: BASE_URL,
    decisionModel: "open-jev",
    deadlineMs: Number(flag("deadline", "180000")),
    maxAttempts: 1,
  });
  const results = [];
  for (const size of SIZES) {
    for (const mode of ["repeat", "evolving", "varied"]) {
      EVOLVING = mode === "evolving";
      const clientMs = [];
      const serviceMs = [];
      const efforts = {};
      let inputTokens = 0;
      for (let i = 0; i < N; i++) {
        const iteration = mode === "varied" ? i : 0;
        const state = makeState(size, iteration);
        if (i && GAP) await new Promise((r) => setTimeout(r, GAP));
        const t0 = performance.now();
        const decision = await client.decide(state);
        const total = performance.now() - t0;
        clientMs.push(Math.round(total));
        serviceMs.push(Math.round(decision.jevMs));
        inputTokens = decision.usage?.inputTokens ?? inputTokens;
        efforts[decision.effort] = (efforts[decision.effort] ?? 0) + 1;
      }
      results.push({ size, mode, client: stats(clientMs), service: stats(serviceMs), efforts, inputTokens });
      console.log(
        `${size.padEnd(10)} ${mode.padEnd(7)} client p50=${stats(clientMs).p50}ms p95=${stats(clientMs).p95}ms | service p50=${stats(serviceMs).p50}ms | efforts=${JSON.stringify(efforts)} | in_tok≈${inputTokens}`,
      );
    }
  }
  const summary = process.env.BENCH_JSON;
  if (summary) writeFileSync(summary, JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("bench failed:", e.message);
  process.exit(1);
});
