// test-jev-hook.mjs — scorer & knob mapper coverage (node src/test-jev-hook.mjs)
import { strict as assert } from "node:assert";
import { scoreTurn, knobPatch, decide } from "./jev-hook.mjs";

// Trivial continuation: valid lease → cached, zero evaluator cost.
let d = scoreTurn({ lease: { effort: "low", steps_remaining: 5 } });
assert.equal(d.effort, "low");
assert.equal(d.cached, true);

// Huge tool result → at least medium.
d = scoreTurn({ tool_results: [{ tokens: 12000, ok: true }] });
assert.ok(["medium", "high", "xhigh", "max", "ultra"].includes(d.effort));

// Retry storm → high.
d = scoreTurn({ consecutive_failures: 3 });
assert.equal(d.effort, "high");

// New user input breaks lease, floor medium.
d = scoreTurn({ new_user_input: true, lease: { effort: "low", steps_remaining: 5 } });
assert.equal(d.effort, "medium");
assert.ok(!d.cached);

// Knob mapper clamps: openai ultra → high (never invent unsupported values).
assert.equal(knobPatch("ultra", "openai").reasoning_effort, "high");
// Anthropic: none → disabled; ultra → 32768.
assert.equal(knobPatch("none", "anthropic").thinking.type, "disabled");
assert.equal(knobPatch("ultra", "anthropic").thinking.budget_tokens, 32768);
// Gemini: none → 0.
assert.equal(knobPatch("none", "gemini").generationConfig.thinkingConfig.thinkingBudget, 0);
// Unknown provider → graceful instruction_text.
assert.ok(knobPatch("high", "unknown").instruction_text.length > 0);
// All 8 efforts produce valid patches on every provider.
for (const p of ["openai", "anthropic", "gemini", "grok", "other"]) {
  for (const e of ["none","minimal","low","medium","high","xhigh","max","ultra"]) {
    assert.ok(knobPatch(e, p) && Object.keys(knobPatch(e, p)).length > 0);
  }
}
// Kill switch.
process.env.JEV_HOOK = "off";
assert.equal(decide({}, "openai").disabled, true);
delete process.env.JEV_HOOK;

console.log("all jev-hook tests passed");
