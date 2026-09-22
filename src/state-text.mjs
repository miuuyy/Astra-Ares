// Renders an evaluator state object as bounded, deterministic plain text for
// openjev-style decision services that take `state` as a string. Hosted
// providers keep receiving the structured state object unchanged.

const NOTE_CHARS = 6_000;
const TOTAL_CHARS = 120_000;
const marker = (removed) => `\n[... ${removed} characters omitted ...]\n`;

function cap(text, budget) {
  if (typeof text !== "string") return "";
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  const removed = text.length - budget;
  return text.slice(0, half) + marker(removed) + text.slice(-half);
}

const list = (items, empty) => (items.length ? items.join("\n") : empty);

export function renderState(state) {
  const sections = [];
  const meta = [`MODEL: ${state.model}`];
  if (state.step !== undefined)
    meta.push(
      `STEP: ${state.step}` +
        (state.previousEffort !== undefined
          ? ` (effort so far: ${state.previousEffort})`
          : "") +
        (state.newToolFailures
          ? ` (new tool failures: ${state.newToolFailures})`
          : ""),
    );
  if (state.supportedEfforts?.length)
    meta.push(`SUPPORTED EFFORTS: ${state.supportedEfforts.join(", ")}`);
  if (state.historyScope) meta.push(`HISTORY SCOPE: ${state.historyScope}`);
  sections.push(meta.join("\n"));

  const task = state.originalTask ?? state.latestUserPrompt ?? "";
  if (task) sections.push(`TASK:\n${cap(task, NOTE_CHARS)}`);
  if (
    state.latestUserPrompt &&
    state.originalTask &&
    state.latestUserPrompt !== state.originalTask
  )
    sections.push(
      `LATEST USER REQUEST:\n${cap(state.latestUserPrompt, NOTE_CHARS)}`,
    );

  const prior = (state.priorUserPrompts ?? []).map(
    (p, i) => `${i + 1}. ${cap(p, 2_000)}`,
  );
  if (prior.length) sections.push(`PRIOR USER REQUESTS:\n${list(prior, "")}`);

  const notes = (state.publicNotes ?? []).map((note) => {
    const tag = [note.kind, note.phase].filter(Boolean).join("/");
    return `- [${tag}] ${cap(note.text, NOTE_CHARS)}`;
  });
  if (notes.length) sections.push(`PROGRESS NOTES:\n${list(notes, "")}`);

  const omitted = state.omittedOlderToolCalls;
  const calls = (state.recentToolCalls ?? []).map((call) => {
    const name = call.namespace ? `${call.namespace}:${call.name}` : call.name;
    const lines = [
      `#${call.callId} ${name}`,
      `   in: ${cap(call.input ?? "", 2_000)}`,
    ];
    for (const output of call.outputs ?? []) {
      const status =
        output.success === undefined ? "" : output.success ? " ok:" : " ERR:";
      lines.push(`  =>${status} ${cap(output.text ?? "", NOTE_CHARS)}`);
    }
    return lines.join("\n");
  });
  if (calls.length)
    sections.push(
      `RECENT TOOL CALLS (oldest first${omitted ? `; ${omitted} older omitted` : ""}):\n${list(calls, "")}`,
    );

  const text = sections.join("\n\n");
  if (text.length <= TOTAL_CHARS) return text;
  const half = Math.floor(TOTAL_CHARS / 2);
  return (
    text.slice(0, half) + marker(text.length - TOTAL_CHARS) + text.slice(-half)
  );
}
