// jev-hook.mjs — Universal pre-turn JEV effort scorer + provider knob mapper.
// Local, deterministic fast path; no network. Emits a knob patch for the next
// model call. EFFORTS ladder and semantics reuse src/jev.mjs (Astra-Ares).
//
// Usage: echo '<turn_context json>' | node src/jev-hook.mjs
// Turn context (all optional): { input_tokens, new_user_input, tool_results:
//   [{ tokens, ok }], consecutive_failures, lease: { effort, steps_remaining } }
//
// Env kill switch: JEV_HOOK=off → { disabled: true } (harness applies nothing).

import { EFFORTS } from "./jev.mjs";

export const RANK = Object.fromEntries(EFFORTS.map((e, i) => [e, i]));

// --- Complexity scoring (deterministic, §2.1 of the design doc) ------------

export function scoreTurn(ctx = {}) {
  const signals = [];
  let score = 0; // 0..7 index into EFFORTS

  // New user input always breaks the lease and re-evaluates.
  if (ctx.new_user_input) signals.push("new_user_input:reevaluate");

  // Trivial continuation: valid lease with no error/new-input signal.
  const lease = ctx.lease;
  const leaseValid =
    lease && Number.isInteger(lease.steps_remaining) && lease.steps_remaining > 0;

  // Tool-result mass since last turn (head/tail previews already capped
  // upstream at 1000 o200k tokens each per tool-output-budget.mjs).
  const results = Array.isArray(ctx.tool_results) ? ctx.tool_results : [];
  const resultTokens = results.reduce((s, r) => s + (r.tokens || 0), 0);
  const failures = results.filter((r) => r.ok === false).length;
  const consecutiveFailures = ctx.consecutive_failures || 0;

  if (leaseValid && !ctx.new_user_input && failures === 0 && consecutiveFailures === 0) {
    // Fast path: cached effort, zero evaluator cost.
    return {
      effort: lease.effort in RANK ? lease.effort : "low",
      lease_steps: lease.steps_remaining,
      cached: true,
      signals: ["lease_valid:cached"],
    };
  }

  // Baseline: routine continuation.
  score = RANK.low;
  signals.push("baseline:low");

  if (resultTokens > 8000) { score = Math.max(score, RANK.medium); signals.push(`tool_mass:${resultTokens}`); }
  if (resultTokens > 40000) { score = Math.max(score, RANK.high); signals.push("tool_mass:heavy"); }
  if (consecutiveFailures >= 2 || failures >= 2) { score = Math.max(score, RANK.high); signals.push(`retry_storm:${Math.max(consecutiveFailures, failures)}`); }
  if (ctx.input_tokens > 60000) { score = Math.max(score, RANK.medium); signals.push(`context:${ctx.input_tokens}`); }
  if (ctx.new_user_input) { score = Math.max(score, RANK.medium); signals.push("fresh_task:medium"); }
  if (ctx.deep_synthesis_hint) { score = Math.max(score, RANK.xhigh); signals.push("synthesis_hint"); }

  const effort = EFFORTS[score];
  return { effort, lease_steps: leaseScore(effort), cached: false, signals };
}

// Lease: predictable phases get longer leases; deep efforts reassess sooner.
function leaseScore(effort) {
  return (RANK[effort] <= RANK.low) ? 5 : (RANK[effort] <= RANK.medium) ? 2 : 1;
}

// --- Effort → provider-native knob mapping (§2.2; clamp down, never invent) -

export function knobPatch(effort, provider) {
  const r = RANK[effort] ?? RANK.low;
  switch (provider) {
    case "openai":
      // reasoning_effort: minimal..high supported.
      return { reasoning_effort: EFFORTS[Math.min(r, RANK.high)] === "none" ? "minimal" : EFFORTS[Math.min(r, RANK.high)] };
    case "anthropic": {
      if (r === RANK.none) return { thinking: { type: "disabled" } };
      const budgets = { minimal: 2048, low: 2048, medium: 6144, high: 10240, xhigh: 24576, max: 24576, ultra: 32768 };
      return { thinking: { type: "enabled", budget_tokens: budgets[effort] } };
    }
    case "gemini": {
      const budgets = { none: 0, minimal: 128, low: 512, medium: 2048, high: 8192, xhigh: 16384, max: 16384, ultra: 24576 };
      return { generationConfig: { thinkingConfig: { thinkingBudget: budgets[effort] } } };
    }
    case "grok":
      return { reasoning_effort: EFFORTS[Math.min(r, RANK.high)] === "none" ? "minimal" : EFFORTS[Math.min(r, RANK.high)] };
    default:
      // No native knob: prompt-level directive; degrade gracefully, never block.
      return {
        instruction_text:
          r <= RANK.minimal
            ? "Answer directly; no extended reasoning needed."
            : r >= RANK.xhigh
              ? "Think carefully step by step; verify invariants before concluding."
              : "Reason concisely before answering.",
      };
  }
}

export function decide(ctx, provider) {
  if (process.env.JEV_HOOK === "off") return { disabled: true };
  const d = scoreTurn(ctx);
  return { ...d, knob_patch: knobPatch(d.effort, provider ?? "prompt") };
}

// --- CLI --------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("jev-hook.mjs")) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let ctx = {};
  try { ctx = raw.trim() ? JSON.parse(raw) : {}; } catch { /* empty context on bad input */ }
  process.stdout.write(JSON.stringify(decide(ctx, process.env.JEV_PROVIDER)) + "\n");
}
