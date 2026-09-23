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
import { Bridge } from "../../src/bridge.mjs";
import { CodexRpc } from "./rpc.mjs";
const binary = resolve(process.argv[2]),
  evidence = resolve(process.argv[3]);
const baseModel = process.argv[4] ?? "gpt-6-astra";
const alias = {
  "gpt-6-astra": "Astra-Jev",
  "gpt-6-sol": "Sol-Jev",
  "gpt-6-luna": "Luna-Jev",
}[baseModel];
assert(alias, "Unknown fixture model");
const displayName = alias.replace("-Jev", " Ares");
mkdirSync(evidence, { recursive: true });
const socketDir = mkdtempSync(join(tmpdir(), "cj-select-"));
const home = join(evidence, "home");
mkdirSync(home, { recursive: true });
const catalog = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
);
const astra = structuredClone(
  catalog.models.find((m) => m.slug === "gpt-6-astra"),
);
astra.use_responses_lite = true;
// Local fixture metadata; capabilities come from the selected catalog entry.
astra.slug = baseModel;
astra.display_name = baseModel;
writeFileSync(
  join(evidence, "models.json"),
  JSON.stringify({ models: [astra] }),
);
const states = [],
  records = [],
  requests = [],
  failures = [];
let phase = "plain",
  turnStep = 0;
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
      assert.equal(
        body.model,
        baseModel,
        "logical alias must never reach the provider",
      );
      requests.push({ phase, body });
      turnStep++;
      const item =
        phase === "live-switch" && turnStep <= 2
          ? {
              type: "function_call",
              call_id: `switch-${turnStep}`,
              name: "switch_fixture",
              arguments: JSON.stringify({ step: turnStep }),
            }
          : {
              type: "message",
              id: `final-${requests.length}`,
              role: "assistant",
              content: [{ type: "output_text", text: "READY" }],
            };
      const sse = [
        { type: "response.created", response: { id: `r-${requests.length}` } },
        { type: "response.output_item.done", item },
        {
          type: "response.completed",
          response: {
            id: `r-${requests.length}`,
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
    } catch (error) {
      failures.push(error.message);
      return new Response("Fixture failed", { status: 500 });
    }
  },
});
const bridge = new Bridge({
  socketPath: join(socketDir, "step.sock"),
  record: (r) => records.push(r),
  jev: {
    decide: async (state) => {
      assert.equal(state.model, baseModel);
      assert.deepEqual(
        state.supportedEfforts,
        astra.supported_reasoning_levels.map((level) => level.effort),
      );
      states.push({ phase, state });
      return { effort: "low", leaseSteps: 10, jevMs: 0, cost: "0" };
    },
  },
});
const settings = {
  model: JSON.stringify(baseModel),
  model_provider: '"fixture"',
  "model_providers.fixture": `{name="OpenAI",base_url="http://127.0.0.1:${server.port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
  model_catalog_json: JSON.stringify(join(evidence, "models.json")),
  model_reasoning_effort: '"medium"',
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
let rpc, finish, rejectTurn;
async function connect(withBridge = true) {
  const env = {
    ...process.env,
    CODEX_HOME: home,
    OPENAI_API_KEY: "fixture-only",
    CODEX_API_KEY: "fixture-only",
  };
  delete env.CODEX_STEP_CONTROLLER_SOCKET;
  if (withBridge) env.CODEX_STEP_CONTROLLER_SOCKET = bridge.socketPath;
  rpc = new CodexRpc(binary, args, env, stderr);
  rpc.on("fault", (error) => rejectTurn?.(error));
  rpc.on("message", (m) => {
    if (m.method === "turn/completed") finish(m.params.turn);
    else if (m.method === "item/tool/call") {
      rpc
        .call("turn/settings/update", {
          threadId: m.params.threadId,
          turnId: m.params.turnId,
          model: m.params.arguments.step === 1 ? baseModel : alias,
          effort: "medium",
        })
        .then((result) => {
          assert.equal(result.status, "applied");
          rpc.send({
            id: m.id,
            result: {
              success: true,
              contentItems: [{ type: "inputText", text: "Settings applied." }],
            },
          });
        })
        .catch(rejectTurn);
    } else if (m.id !== undefined)
      rejectTurn?.(new Error(`Unexpected server request ${m.method}`));
  });
  await rpc.call("initialize", {
    clientInfo: { name: "jev-selection-fixture", version: "4" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized", params: {} });
}
async function run(id, newPhase) {
  phase = newPhase;
  turnStep = 0;
  let timer;
  const completion = new Promise((resolve, reject) => {
    finish = resolve;
    rejectTurn = reject;
    timer = setTimeout(
      () => reject(new Error(`Turn timed out: ${phase}`)),
      30_000,
    );
  }).finally(() => clearTimeout(timer));
  completion.catch(() => {});
  await rpc.call("turn/start", {
    threadId: id,
    input: [{ type: "text", text: `Selection fixture: ${phase}` }],
  });
  return await completion;
}
try {
  await bridge.start();
  await connect();
  const models = await rpc.call("model/list", { includeHidden: false });
  assert(models.data.some((m) => m.model === alias));
  assert.equal(
    models.data.find((m) => m.model === alias).displayName,
    displayName,
  );
  assert(models.data.some((m) => m.model === baseModel));
  const created = await rpc.call("thread/start", {
    model: baseModel,
    cwd: evidence,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "switch_fixture",
        description: "Change mode between sampling steps",
        inputSchema: {
          type: "object",
          properties: { step: { type: "integer" } },
          required: ["step"],
          additionalProperties: false,
        },
      },
    ],
  });
  const id = created.thread.id;
  assert.equal((await run(id, "plain")).status, "completed");
  assert.equal(states.length, 0);
  let updated = await rpc.call("thread/settings/update", {
    threadId: id,
    model: alias,
  });
  assert.deepEqual(updated, {});
  assert.equal((await run(id, "adaptive")).status, "completed");
  assert.equal(states.length, 1);
  await rpc.call("thread/settings/update", {
    threadId: id,
    model: baseModel,
    effort: "medium",
  });
  assert.equal((await run(id, "plain-again")).status, "completed");
  assert.equal(states.length, 1);
  assert.equal(requests.at(-1).body.reasoning.effort, "medium");
  await rpc.call("thread/settings/update", {
    threadId: id,
    model: alias,
  });
  assert.equal((await run(id, "adaptive-again")).status, "completed");
  assert.equal(states.length, 2);
  rpc.stop();
  await connect();
  const resumed = await rpc.call("thread/resume", { threadId: id });
  assert.equal(resumed.model, alias);
  assert.equal((await run(id, "resumed")).status, "completed");
  assert.equal(states.length, 3);
  assert.equal((await run(id, "live-switch")).status, "completed");
  assert.equal(states.length, 5);
  const live = requests.filter((r) => r.phase === "live-switch");
  const effectiveEffort = (body) =>
    body.input.findLast((item) => item.type === "configuration_update")
      ?.reasoning.effort ?? body.reasoning.effort;
  assert.deepEqual(
    live.map((r) => effectiveEffort(r.body)),
    ["low", "medium", "low"],
  );
  assert(
    live.every((r) => r.body.reasoning.effort === "low"),
    "native cache baseline should remain pinned",
  );
  for (let n = 1; n < live.length; n++)
    assert.deepEqual(
      live[n].body.input.slice(0, live[n - 1].body.input.length),
      live[n - 1].body.input,
    );
  rpc.stop();
  await connect(false);
  const missing = await rpc.call("thread/start", {
    model: alias,
    cwd: evidence,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  const before = requests.length;
  const failed = await run(missing.thread.id, "missing-bridge");
  assert.equal(failed.status, "failed");
  assert.match(failed.error.message, /Launch astra-ares/);
  assert.equal(requests.length, before);
  await rpc.call("thread/settings/update", {
    threadId: missing.thread.id,
    model: baseModel,
    effort: "medium",
  });
  assert.equal(
    (await run(missing.thread.id, "plain-without-bridge")).status,
    "completed",
  );
  assert.equal(states.length, 5);
  assert.deepEqual(failures, []);
  const result = {
    passed: true,
    scope:
      "Actual native CLI/app-server with explicit local provider and Jev fixtures",
    modelPicker: [baseModel, displayName],
    aliasNeverSentToProvider: true,
    plainModelZeroJevCalls: true,
    selectionPersistsAcrossRestart: true,
    nativeConfigurationUpdates: true,
    pinnedRequestEffort: "low",
    liveSwitchEfforts: ["low", "medium", "low"],
    preservedPrefix: true,
    missingBridgeFailsBeforeInference: true,
    plainWorksWithoutBridge: true,
    inferenceRequests: requests.length,
    evaluatorCalls: states.length,
    records,
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, records: undefined }, null, 2));
} finally {
  rpc?.stop();
  await bridge.stop();
  server.stop(true);
  stderr.end();
  rmSync(socketDir, { recursive: true, force: true });
}
