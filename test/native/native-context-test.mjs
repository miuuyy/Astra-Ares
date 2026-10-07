import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { Bridge, controllerPath } from "../../src/bridge.mjs";
import { CodexRpc } from "./rpc.mjs";
import { outputTokens } from "../../src/tool-output-budget.mjs";

// Real patched Codex; explicit local Responses/Jev fixtures, no model inference.
const binary = resolve(process.argv[2]);
const evidenceDir = resolve(process.argv[3]);
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
const socketDir = mkdtempSync(join(tmpdir(), "cj-context-"));
const socketPath = controllerPath(socketDir);
const home = join(evidenceDir, "home");
mkdirSync(home, { recursive: true });
const models = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
);
const astra = structuredClone(
  models.models.find((m) => m.slug === "gpt-6-astra"),
);
assert(astra);
astra.use_responses_lite = true;
writeFileSync(
  join(evidenceDir, "models.json"),
  JSON.stringify({ models: [astra] }),
);
const prompt =
  "Preserve all requirements and the overall objective.\n" +
  "A detailed requirement that must reach the evaluator in full.\n".repeat(
    180,
  ) +
  "FINAL_OBJECTIVE_MARKER";
const longOutput = "Context evidence ".repeat(700) + "TOOL_RESULT_TAIL_MARKER";
const states = [],
  records = [],
  failures = [],
  requests = [];
let controller;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 426 });
    try {
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "zstd")
        bytes = Bun.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes);
      assert.equal(controller.completedCheckpoints, requests.length + 1);
      requests.push(body);
      const n = requests.length;
      const items =
        n <= 7
          ? [
              {
                type: "reasoning",
                id: `summary-${n}`,
                summary: [
                  {
                    type: "summary_text",
                    text: `Published reasoning summary ${n}: preserve the task priorities.`,
                  },
                ],
                content: [
                  {
                    type: "reasoning_text",
                    text: "RAW_REASONING_MUST_NOT_LEAVE_CODEX",
                  },
                ],
                encrypted_content: "OPAQUE_REASONING_MUST_NOT_LEAVE_CODEX",
              },
              {
                type: "message",
                id: `progress-${n}`,
                role: "assistant",
                phase: "commentary",
                content: [
                  {
                    type: "output_text",
                    text: `Public progress ${n}: plan and unresolved work.`,
                  },
                ],
              },
              {
                type: "function_call",
                call_id: `context-tool-${n}`,
                name: "fixture_context",
                arguments: JSON.stringify({
                  step: n,
                  goal: "Preserve overall priorities",
                }),
              },
            ]
          : [
              {
                type: "message",
                id: "final",
                role: "assistant",
                phase: "final_answer",
                content: [
                  { type: "output_text", text: "Context fixture complete." },
                ],
              },
            ];
      const events = [
        { type: "response.created", response: { id: `context-response-${n}` } },
        ...items.map((item) => ({ type: "response.output_item.done", item })),
        {
          type: "response.completed",
          response: {
            id: `context-response-${n}`,
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ];
      return new Response(
        events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    } catch (error) {
      failures.push(error.message);
      return new Response("Fixture assertion failed", { status: 500 });
    }
  },
});
const settings = {
  model: '"Astra-Jev"',
  model_provider: '"fixture"',
  "model_providers.fixture": `{name="OpenAI",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  model_catalog_json: JSON.stringify(join(evidenceDir, "models.json")),
  model_reasoning_effort: '"low"',
  model_reasoning_summary: '"detailed"',
  "features.step_model_switching": "true",
  "features.reasoning_effort_override": "true",
  "features.hooks": "false",
  "features.apps": "false",
  "features.plugins": "false",
  "features.code_mode_host": "false",
  "features.remote_models": "false",
  "features.shell_snapshot": "false",
  "analytics.enabled": "false",
  "feedback.enabled": "false",
};
const args = Object.entries(settings).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
args.push("app-server", "--stdio");
const log = createWriteStream(join(evidenceDir, "stderr.log"));
const rpc = new CodexRpc(
  binary,
  args,
  {
    ...process.env,
    CODEX_HOME: home,
    CODEX_STEP_CONTROLLER_SOCKET: socketPath,
    OPENAI_API_KEY: "local-fixture-only",
    CODEX_API_KEY: "local-fixture-only",
  },
  log,
);
let resolveCompletion, rejectCompletion;
const completion = new Promise((resolve, reject) => {
  resolveCompletion = resolve;
  rejectCompletion = reject;
});
completion.catch(() => {});
const deadline = setTimeout(
  () => rejectCompletion(new Error("Native context test timed out")),
  60_000,
);
controller = new Bridge({
  socketPath,
  record: (r) => records.push(r),
  jev: {
    decide: async (state) => {
      states.push(state);
      return { effort: "low", leaseSteps: 1, jevMs: 0, cost: "0" };
    },
  },
});
try {
  await controller.start();
  rpc.on("fault", rejectCompletion);
  rpc.on("message", (message) => {
    try {
      if (message.method === "item/tool/call") {
        const n = message.params.arguments.step;
        rpc.send({
          id: message.id,
          result: {
            success: true,
            contentItems: [
              {
                type: "inputText",
                text: n === 2 ? longOutput : `Tool result ${n}.`,
              },
            ],
          },
        });
      } else if (message.method === "turn/completed")
        resolveCompletion(message.params.turn);
      else if (message.id !== undefined)
        rejectCompletion(
          new Error(`Unexpected server request ${message.method}`),
        );
    } catch (error) {
      rejectCompletion(error);
    }
  });
  await rpc.call("initialize", {
    clientInfo: { name: "astra-ares-context-fixture", version: "2" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized", params: {} });
  const thread = await rpc.call("thread/start", {
    model: "Astra-Jev",
    cwd: evidenceDir,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "fixture_context",
        description: "Synthetic context fixture",
        inputSchema: {
          type: "object",
          properties: {
            step: { type: "integer" },
            goal: { type: "string" },
          },
          required: ["step", "goal"],
          additionalProperties: false,
        },
      },
    ],
  });
  const turn = await rpc.call("turn/start", {
    threadId: thread.thread.id,
    effort: "low",
    input: [{ type: "text", text: prompt }],
  });
  const done = await completion;
  assert.equal(done.status, "completed", JSON.stringify(done.error));
  assert.deepEqual(failures, []);
  assert.equal(states.length, 8);
  const final = states.at(-1);
  for (const state of states) assert.equal(state.latestUserPrompt, prompt);
  assert(
    requests[0].input.some(
      (item) =>
        item.role === "user" &&
        item.content?.some((part) => part.text === prompt),
    ),
  );
  assert.equal(final.publicNotes.length, 14);
  assert.equal(
    final.publicNotes.filter((n) => n.kind === "reasoning_summary").length,
    7,
  );
  assert(
    final.publicNotes.some((n) => n.text.startsWith("Public progress 1:")),
  );
  assert(
    final.publicNotes.some((n) =>
      n.text.startsWith("Published reasoning summary 1:"),
    ),
  );
  assert.deepEqual(
    final.recentToolCalls.map((t) => t.callId),
    [2, 3, 4, 5, 6, 7].map((n) => `context-tool-${n}`),
  );
  for (const call of final.recentToolCalls) {
    assert.equal(call.outputs.length, 1);
    assert(call.outputs[0].historyIndex > call.historyIndex);
    assert.equal(JSON.parse(call.input).goal, "Preserve overall priorities");
  }
  const preview = final.recentToolCalls[0].outputs[0];
  assert(outputTokens(preview.text) <= 1000);
  assert(preview.text.includes("middle omitted"));
  assert(preview.text.includes("TOOL_RESULT_TAIL_MARKER"));
  assert(preview.truncation.truncated);
  assert(
    requests.some((r) =>
      r.input.some(
        (item) =>
          item.type.endsWith("_output") &&
          JSON.stringify(item).includes(longOutput),
      ),
    ),
    "Astra must continue to receive the original native tool result",
  );
  assert.equal(final.omittedOlderToolCalls, 1);
  assert(
    !JSON.stringify(states).includes("RAW_REASONING_MUST_NOT_LEAVE_CODEX"),
  );
  assert(
    !JSON.stringify(states).includes("OPAQUE_REASONING_MUST_NOT_LEAVE_CODEX"),
  );
  const result = {
    passed: true,
    scope:
      "Actual patched Codex with local Responses/Jev fixtures; public context projection only",
    generations: requests.length,
    promptBytes: Buffer.byteLength(prompt),
    promptSource: "native_accepted_input",
    publicNotes: final.publicNotes.length,
    reasoningSummaries: final.publicNotes.filter(
      (n) => n.kind === "reasoning_summary",
    ).length,
    toolCalls: final.recentToolCalls.length,
    omittedOlderToolCalls: final.omittedOlderToolCalls,
    nativeToolResultBytes: Buffer.byteLength(longOutput),
    jevPreviewTokens: outputTokens(preview.text),
    nativeHistoryUnchanged: true,
    toolResultPreviewBounded: true,
    fullPromptPreserved: true,
    oldestPublicNotesPreserved: true,
    opaqueReasoningExcluded: true,
    contextStats: records
      .filter((r) => r.type === "decision")
      .map((r) => r.contextStats),
  };
  writeFileSync(
    join(evidenceDir, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearTimeout(deadline);
  rpc.stop();
  await controller.stop();
  server.stop(true);
  log.end();
  rmSync(socketDir, { recursive: true, force: true });
}
