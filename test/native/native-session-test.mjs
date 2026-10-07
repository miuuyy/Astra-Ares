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
import { CodexRpc } from "../../src/rpc.mjs";

const binary = resolve(process.argv[2]),
  evidence = resolve(process.argv[3]);
mkdirSync(evidence, { recursive: true });
const socketDir = mkdtempSync(join(tmpdir(), "cj-session-"));
const home = join(evidence, "home");
mkdirSync(home, { recursive: true });
const catalog = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
);
const astra = structuredClone(
  catalog.models.find((m) => m.slug === "gpt-6-astra"),
);
astra.use_responses_lite = true;
const other = {
  ...structuredClone(astra),
  slug: "fixture-native-second",
  display_name: "Fixture native second",
};
writeFileSync(
  join(evidence, "models.json"),
  JSON.stringify({ models: [astra, other] }),
);
const records = [],
  states = [],
  requests = [],
  events = [],
  failures = [];
let adaptiveRequests = 0;
let bridge,
  phase = "repair",
  cancelEntered,
  cancelObserved = false;
const choices = [
  { effort: "low", leaseSteps: 10 },
  { effort: "high", leaseSteps: 2 },
  { effort: "low", leaseSteps: 1 },
];
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
      if (phase !== "second-model") adaptiveRequests++;
      assert.equal(
        bridge.completedCheckpoints,
        adaptiveRequests,
        "incorrect adaptive activation",
      );
      assert.equal(
        body.model,
        phase === "second-model" ? "fixture-native-second" : "gpt-6-astra",
      );
      requests.push(body);
      const n = requests.length;
      const item =
        n <= 3 || (phase === "steer" && n === 7)
          ? {
              type: "function_call",
              call_id: `fixture-${n}`,
              name: "fixture_checkpoint",
              arguments: JSON.stringify({ step: n === 7 ? 99 : n }),
            }
          : {
              type: "message",
              id: `final-${n}`,
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: `Fixture response ${n}: task context retained.`,
                },
              ],
            };
      const sse = [
        { type: "response.created", response: { id: `response-${n}` } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: `response-${n}`,
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
        sse.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    } catch (e) {
      failures.push(e.message);
      return new Response("Fixture failure", { status: 500 });
    }
  },
});
bridge = new Bridge({
  socketPath: controllerPath(socketDir),
  record: (r) => records.push(r),
  jev: {
    decide: async (state, { signal }) => {
      states.push(state);
      if (phase === "cancel") {
        cancelEntered();
        await new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              cancelObserved = true;
              reject(new Error("Fixture aborted"));
            },
            { once: true },
          ),
        );
      }
      if (phase === "error") throw new Error("Fixture Jev HTTP 429");
      return {
        ...(phase === "repair"
          ? choices.shift()
          : {
              effort: phase === "second-model" ? "medium" : "low",
              leaseSteps: phase === "steer" ? 10 : 1,
            }),
        jevMs: 0,
        cost: "0",
      };
    },
  },
});
const settings = {
  model: '"Astra-Jev"',
  model_provider: '"fixture"',
  "model_providers.fixture": `{name="OpenAI",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  model_catalog_json: JSON.stringify(join(evidence, "models.json")),
  model_reasoning_effort: '"low"',
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
const stderr = createWriteStream(join(evidence, "stderr.log"));
const rpc = new CodexRpc(
  binary,
  args,
  {
    ...process.env,
    CODEX_HOME: home,
    CODEX_STEP_CONTROLLER_SOCKET: bridge.socketPath,
    OPENAI_API_KEY: "fixture-only",
    CODEX_API_KEY: "fixture-only",
  },
  stderr,
);
let finish, rejectTurn;
rpc.on("fault", (e) => rejectTurn?.(e));
rpc.on("message", (m) => {
  events.push(m);
  if (m.method === "item/tool/call") {
    const answer = () =>
      rpc.send({
        id: m.id,
        result: {
          success: m.params.arguments.step !== 1,
          contentItems: [
            {
              type: "inputText",
              text:
                m.params.arguments.step === 1
                  ? "Fixture tool failed."
                  : "Fixture tool completed.",
            },
          ],
        },
      });
    if (m.params.arguments.step === 99) {
      rpc
        .call("turn/steer", {
          threadId: m.params.threadId,
          expectedTurnId: m.params.turnId,
          input: [
            { type: "text", text: "Identical steer still ends a lease." },
          ],
        })
        .then(answer)
        .catch(rejectTurn);
    } else answer();
  } else if (m.method === "turn/completed") finish(m.params.turn);
  else if (m.id !== undefined)
    rejectTurn(new Error(`Unexpected server request ${m.method}`));
});
async function startTurn(threadId, prompt, options = {}) {
  let timer;
  const completed = new Promise((resolve, reject) => {
    finish = resolve;
    rejectTurn = reject;
    timer = setTimeout(() => reject(new Error("Turn timeout")), 30_000);
  }).finally(() => clearTimeout(timer));
  completed.catch(() => {});
  const started = await rpc.call("turn/start", {
    threadId,
    effort: "low",
    input: [{ type: "text", text: prompt }],
    ...options,
  });
  return { started: started.turn, completed };
}
try {
  await bridge.start();
  await rpc.call("initialize", {
    clientInfo: { name: "jev-native-session-fixture", version: "3" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized", params: {} });
  const thread = await rpc.call("thread/start", {
    model: "Astra-Jev",
    cwd: evidence,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "fixture_checkpoint",
        description: "Fixture",
        inputSchema: {
          type: "object",
          properties: { step: { type: "integer" } },
          required: ["step"],
          additionalProperties: false,
        },
      },
    ],
  });
  const id = thread.thread.id;
  let run = await startTurn(
    id,
    "Original task: preserve atomicity and task priorities.",
  );
  assert.equal((await run.completed).status, "completed");
  assert.equal(requests.length, 4);
  assert.deepEqual(
    records
      .filter((r) => r.type === "decision")
      .map((r) => [r.effort, r.reused]),
    [
      ["low", false],
      ["high", false],
      ["high", true],
      ["low", false],
    ],
  );
  assert.deepEqual(
    events
      .filter((m) => m.method === "turn/reasoningEffort/updated")
      .map((m) => [m.params.fromEffort, m.params.toEffort]),
    [
      [null, "low"],
      ["low", "high"],
      ["high", "low"],
    ],
  );
  for (let n = 1; n < 4; n++)
    assert.deepEqual(
      requests[n].input.slice(0, requests[n - 1].input.length),
      requests[n - 1].input,
    );
  phase = "followup";
  run = await startTurn(
    id,
    "Continue the same task, with an additional constraint.",
  );
  assert.equal((await run.completed).status, "completed");
  assert.equal(
    states.at(-1).latestUserPrompt,
    "Continue the same task, with an additional constraint.",
  );
  assert(
    states.at(-1).priorUserPrompts.some((p) => p.includes("Original task:")),
  );
  const beforeCancel = requests.length;
  phase = "cancel";
  const entered = new Promise((resolve) => {
    cancelEntered = resolve;
  });
  run = await startTurn(
    id,
    "This turn will be interrupted during the evaluator request.",
  );
  await entered;
  await rpc.call("turn/interrupt", { threadId: id, turnId: run.started.id });
  assert.equal((await run.completed).status, "interrupted");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(cancelObserved);
  assert.equal(requests.length, beforeCancel);
  phase = "error";
  run = await startTurn(
    id,
    "A provider error must remain visible and stop this turn.",
  );
  const failed = await run.completed;
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /Fixture Jev HTTP 429/);
  assert.equal(requests.length, beforeCancel);
  const evaluationsBeforePlain = states.length;
  phase = "second-model";
  run = await startTurn(id, "Continue using the user-selected native model.", {
    model: "fixture-native-second",
  });
  assert.equal((await run.completed).status, "completed");
  assert.equal(
    states.length,
    evaluationsBeforePlain,
    "ordinary models must not call Jev",
  );
  assert.equal(requests.at(-1).model, "fixture-native-second");
  phase = "steer";
  const evaluationsBeforeSteer = states.length;
  run = await startTurn(id, "Identical steer still ends a lease.", {
    model: "Astra-Jev",
  });
  assert.equal((await run.completed).status, "completed");
  assert.equal(
    states.length - evaluationsBeforeSteer,
    2,
    "identical accepted user input must terminate the 10-step lease",
  );
  assert.deepEqual(failures, []);
  const result = {
    passed: true,
    scope: "Actual patched Codex; explicit Responses/Jev fixtures",
    completedTurns: 4,
    interruptedTurns: 1,
    failedTurns: 1,
    inferenceRequests: requests.length,
    nativeConfirmationBeforeInference: true,
    continuedConversation: true,
    nativeModelSelection: true,
    plainModelBypassesJev: true,
    aliasNeverSentToProvider: true,
    preservedPrefix: true,
    cancelledEvaluator: cancelObserved,
    providerFailureVisible: true,
    identicalSteerInvalidatesLease: true,
    settingsEvents: events
      .filter((m) => m.method === "turn/reasoningEffort/updated")
      .map((m) => m.params),
    records,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify(
      { ...result, records: undefined, settingsEvents: undefined },
      null,
      2,
    ),
  );
} finally {
  rpc.stop();
  await bridge.stop();
  server.stop(true);
  stderr.end();
  rmSync(socketDir, { recursive: true, force: true });
}
