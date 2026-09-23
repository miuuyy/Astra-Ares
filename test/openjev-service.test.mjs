import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { decisionRequest } from "../src/jev.mjs";

const MOCK_PORT = 18911;
const SVC_PORT = 18890;
const SVC_PORT_AUTH = 18891;
const BASE = `http://127.0.0.1:${SVC_PORT}`;

const backendLog = [];
let pickLetter = (letters) => 0;
// Optional override: (request, letters) => completion body sent back verbatim.
let respond = null;

function completion(chosen, letters) {
  const top = letters.slice(0, 2).map((letter) => ({
    token: letter,
    logprob: letter === chosen ? -0.1 : -2.0,
  }));
  return {
    choices: [
      {
        message: { role: "assistant", content: `"${chosen}"` },
        logprobs: {
          content: [
            {
              token: '"',
              logprob: -0.01,
              top_logprobs: [{ token: '"', logprob: -0.01 }],
            },
            { token: chosen, logprob: -0.1, top_logprobs: top },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 1 },
  };
}

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "Qwen3.5-0.8B-Q8_0" }] }));
    }
    const request = JSON.parse(body);
    backendLog.push(request);
    const letters = request.response_format?.json_schema?.schema?.enum ?? ["A"];
    const chosen = letters[Math.min(pickLetter(letters), letters.length - 1)];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        respond ? respond(request, letters) : completion(chosen, letters),
      ),
    );
  });
});

let service, serviceAuth;

async function waitHealthy(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("service did not become healthy");
}

beforeEach(() => {
  backendLog.length = 0;
  pickLetter = () => 0;
  respond = null;
});

before(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));
  service = spawn(process.execPath, ["openjev/service.mjs"], {
    env: {
      ...process.env,
      OPENJEV_PORT: String(SVC_PORT),
      OPENJEV_HOST: "127.0.0.1",
      OPENJEV_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    },
    stdio: "ignore",
  });
  serviceAuth = spawn(process.execPath, ["openjev/service.mjs"], {
    env: {
      ...process.env,
      OPENJEV_PORT: String(SVC_PORT_AUTH),
      OPENJEV_HOST: "127.0.0.1",
      OPENJEV_TOKEN: "secret-token",
      OPENJEV_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
    },
    stdio: "ignore",
  });
  await waitHealthy(BASE);
  await waitHealthy(`http://127.0.0.1:${SVC_PORT_AUTH}`);
});

after(() => {
  service?.kill();
  serviceAuth?.kill();
  mock.close();
});

test("health reports the backend model", async () => {
  const health = await waitHealthy(BASE);
  assert.equal(health.backend.reachable, true);
  assert.equal(health.backend.model, "Qwen3.5-0.8B-Q8_0");
});

test("systemone answers choice questions from criteria with calibrated probabilities", async () => {
  backendLog.length = 0;
  pickLetter = () => 1;
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "open-jev",
      state: "MODEL: gpt-6-astra\nTASK: ship it",
      questions: {
        effort: {
          type: "choice",
          instructions: "Which effort?",
          criteria: { low: "Routine", high: "Deep" },
        },
      },
    }),
  });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.model, "Qwen3.5-0.8B-Q8_0");
  assert.equal(out.answers.effort.type, "choice");
  assert.equal(out.answers.effort.choice, "high");
  const probs = out.answers.effort.probabilities;
  assert.ok(Math.abs(probs.low + probs.high - 1) < 1e-9);
  assert.ok(probs.high > probs.low);
  assert.equal(out.usage.decisions, 1);
  assert.equal(out.usage.input_tokens, 100);
});

test("systemone renders object states for the backend prompt", async () => {
  backendLog.length = 0;
  pickLetter = () => 0;
  await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: {
        model: "gpt-6-astra",
        supportedEfforts: ["low", "high"],
        latestUserPrompt: "Review task",
        publicNotes: [],
        recentToolCalls: [],
      },
      questions: {
        effort: {
          type: "choice",
          instructions: "effort?",
          criteria: { low: "x", high: "y" },
        },
        lease: {
          type: "choice",
          instructions: "lease?",
          criteria: { 1: "a", 10: "b" },
        },
      },
    }),
  });
  assert.equal(backendLog.length, 2);
  const prompt = backendLog[0].messages.at(-1).content;
  assert.match(prompt, /MODEL: gpt-6-astra/);
  assert.match(prompt, /OPTIONS:\nA\. low — x\nB\. high — y/);
  assert.match(backendLog[1].messages.at(-1).content, /A\. 1 — a\nB\. 10 — b/);
  assert.equal(
    backendLog[0].response_format.json_schema.schema.enum.join(","),
    "A,B",
  );
});

test("noul maps the Yes/No letter distribution to a probability", async () => {
  pickLetter = () => 1;
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: "s",
      questions: { urgent: { type: "noul", instructions: "Urgent?" } },
    }),
  });
  const out = await res.json();
  assert.equal(out.answers.urgent.type, "noul");
  assert.equal(
    out.answers.urgent.noul,
    1 - Math.exp(-0.1) / (Math.exp(-0.1) + Math.exp(-2)),
  );
});

test("bad question types and missing options are rejected without backend calls", async () => {
  backendLog.length = 0;
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: "s",
      questions: { x: { type: "mood", instructions: "?" } },
    }),
  });
  assert.equal(res.status, 400);
  assert.equal(backendLog.length, 0);
});

test("OpenAI shim extracts {state, questions} from the user message", async () => {
  pickLetter = () => 0;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "decide",
      messages: [
        {
          role: "user",
          content:
            'Here is the payload: {"state":"hello","questions":{"q":{"type":"choice","instructions":"pick","options":["a","b"]}}}',
        },
      ],
    }),
  });
  const out = await res.json();
  assert.equal(out.object, "chat.completion");
  const answers = JSON.parse(out.choices[0].message.content);
  assert.equal(answers.q.choice, "a");
  assert.equal(out.usage.decisions, 1);
});

test("token auth gates every endpoint except health", async () => {
  const base = `http://127.0.0.1:${SVC_PORT_AUTH}`;
  const denied = await fetch(`${base}/v1/models`);
  assert.equal(denied.status, 401);
  const ok = await fetch(`${base}/v1/models`, {
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(ok.status, 200);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
});

test("the Astra-Ares openjev provider completes a decision against this service", async () => {
  pickLetter = () => 0;
  const { Jev } = await import("../src/jev.mjs");
  const j = new Jev({
    provider: "openjev",
    baseUrl: BASE,
    decisionModel: "open-jev",
  });
  const d = await j.decide({
    model: "gpt-6-astra",
    supportedEfforts: ["low", "high"],
    latestUserPrompt: "Reply READY.",
    publicNotes: [],
    recentToolCalls: [],
  });
  assert.equal(d.effort, "low");
  assert.equal(d.leaseSteps, 1);
  assert.equal(d.provider, "openjev");
});

const ASTRA_STATE = {
  model: "gpt-6-astra",
  supportedEfforts: ["low", "high"],
  latestUserPrompt: "Reply READY.",
  publicNotes: [],
  recentToolCalls: [],
};

async function systemone(body, base = BASE) {
  const res = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const TWO_CHOICE = {
  state: "s",
  questions: {
    effort: {
      type: "choice",
      instructions: "Which effort?",
      criteria: { low: "Routine", high: "Deep" },
    },
  },
};

test("prose answers are rejected instead of salvaging a letter from them", async () => {
  // Regression: "Because ..." used to be read as option B.
  for (const content of [
    "Because the evidence is insufficient.",
    '"Because"',
    "B because it is harder",
    '"b"',
    '"C"',
    "",
  ]) {
    respond = () => ({
      choices: [{ message: { role: "assistant", content } }],
      usage: {},
    });
    const out = await systemone(TWO_CHOICE);
    assert.equal(out.status, 502, content);
    assert.match(out.body.error.message, /exactly one option letter/);
  }
});

test("logprobs cannot override a malformed structured answer", async () => {
  respond = (_request, letters) => ({
    ...completion("B", letters),
    choices: [
      {
        ...completion("B", letters).choices[0],
        message: { content: "Because" },
      },
    ],
  });
  const out = await systemone(TWO_CHOICE);
  assert.equal(out.status, 502);
});

test("the Astra-Ares provider rejects a decision built from prose output", async () => {
  respond = () => ({
    choices: [
      { message: { content: "Because the evidence is insufficient." } },
    ],
  });
  const { Jev } = await import("../src/jev.mjs");
  const j = new Jev({ provider: "openjev", baseUrl: BASE, maxAttempts: 1 });
  await assert.rejects(j.decide(ASTRA_STATE));
});

test("a valid answer without logprobs keeps confidence unknown", async () => {
  for (const content of ['"B"', "B", ' "B"\n']) {
    respond = () => ({ choices: [{ message: { content } }] });
    const out = await systemone({
      state: "s",
      questions: {
        effort: TWO_CHOICE.questions.effort,
        level: {
          type: "score",
          instructions: "Level?",
          options: ["zero", "one"],
        },
      },
    });
    assert.equal(out.status, 200, content);
    assert.equal(out.body.answers.effort.choice, "high");
    assert.equal(out.body.answers.effort.confidence, null);
    assert.equal(out.body.answers.effort.probabilities, undefined);
    assert.equal(out.body.answers.level.score, 1);
    assert.equal(out.body.answers.level.confidence, null);
  }
});

test("logprobs at a different letter than the answer leave confidence unknown", async () => {
  respond = (_request, letters) => ({
    ...completion("A", letters),
    choices: [
      { ...completion("A", letters).choices[0], message: { content: '"B"' } },
    ],
  });
  const out = await systemone(TWO_CHOICE);
  assert.equal(out.status, 200);
  assert.equal(out.body.answers.effort.choice, "high");
  assert.equal(out.body.answers.effort.confidence, null);
});

test("noul without logprobs fails instead of inventing a probability", async () => {
  respond = () => ({ choices: [{ message: { content: '"A"' } }] });
  const out = await systemone({
    state: "s",
    questions: { urgent: { type: "noul", instructions: "Urgent?" } },
  });
  assert.equal(out.status, 502);
  assert.match(out.body.error.message, /noul probability is unknown/);
});

test("single-option questions are answered without a backend call", async () => {
  const out = await systemone({
    state: "s",
    questions: {
      lease: {
        type: "choice",
        instructions: "lease?",
        criteria: { 1: "only" },
      },
    },
  });
  assert.equal(out.status, 200);
  assert.equal(backendLog.length, 0);
  assert.deepEqual(out.body.answers.lease, {
    type: "choice",
    choice: "1",
    probabilities: { 1: 1 },
    confidence: 1,
  });
});

test("the Astra-Ares provider works with maxLeaseSteps: 1", async () => {
  // Regression: this used to fail with HTTP 400 "needs 2-26 options".
  pickLetter = () => 1;
  const { Jev } = await import("../src/jev.mjs");
  const j = new Jev({ provider: "openjev", baseUrl: BASE, maxLeaseSteps: 1 });
  const d = await j.decide(ASTRA_STATE);
  assert.equal(d.effort, "high");
  assert.equal(d.leaseSteps, 1);
  assert.equal(
    backendLog.length,
    1,
    "only the effort question reaches the model",
  );
});

test("empty or unlabelled option lists are still rejected", async () => {
  for (const question of [
    { type: "choice", instructions: "?", criteria: {} },
    { type: "choice", instructions: "?", options: [] },
    {
      type: "choice",
      instructions: "?",
      options: [{ description: "no label" }],
    },
    {
      type: "choice",
      instructions: "?",
      options: [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0"],
    },
  ]) {
    const out = await systemone({ state: "s", questions: { q: question } });
    assert.equal(out.status, 400);
  }
  assert.equal(backendLog.length, 0);
});

test("the model receives the provider's criteria descriptions for every option", async () => {
  // Regression: only Object.keys(criteria) reached the prompt.
  const { Jev } = await import("../src/jev.mjs");
  await new Jev({ provider: "openjev", baseUrl: BASE }).decide(ASTRA_STATE);
  const { questions } = decisionRequest(ASTRA_STATE);
  const prompts = backendLog.map((r) => r.messages.at(-1).content);
  assert.equal(prompts.length, 2);
  for (const [i, question] of [questions.effort, questions.lease].entries()) {
    const prompt = prompts.find((p) =>
      p.includes(question.instructions.slice(0, 60)),
    );
    assert.ok(prompt, `prompt for question ${i}`);
    Object.entries(question.criteria).forEach(([label, description], j) => {
      assert.ok(
        prompt.includes(`${"ABCD"[j]}. ${label} — ${description}`),
        `${label} description missing`,
      );
    });
  }
});

test("array criteria and object options keep their descriptions", async () => {
  await systemone({
    state: "s",
    questions: {
      a: {
        type: "choice",
        instructions: "a?",
        criteria: [
          { label: "fast", description: "Cheap and quick" },
          { label: "slow", description: "Careful" },
        ],
      },
      b: {
        type: "choice",
        instructions: "b?",
        options: ["plain", { label: "rich", description: "With detail" }],
      },
    },
  });
  const prompts = backendLog.map((r) => r.messages.at(-1).content).join("\n");
  assert.match(prompts, /A\. fast — Cheap and quick\nB\. slow — Careful/);
  assert.match(prompts, /A\. plain\nB\. rich — With detail/);
});

function startService(env) {
  const child = spawn(process.execPath, ["openjev/service.mjs"], {
    env: {
      ...process.env,
      OPENJEV_HOST: "",
      OPENJEV_TOKEN: "",
      OPENJEV_ALLOW_UNAUTHENTICATED: "",
      OPENJEV_MODEL_ID: "test",
      OPENJEV_BACKEND_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  const listening = async () => {
    for (let i = 0; i < 100 && !output.includes("listening on"); i++)
      await new Promise((r) => setTimeout(r, 50));
    return output;
  };
  return { child, exited, listening, output: () => output };
}

test("the service binds loopback by default", { timeout: 10_000 }, async () => {
  const svc = startService({ OPENJEV_PORT: "18892" });
  try {
    assert.match(
      await svc.listening(),
      /listening on http:\/\/127\.0\.0\.1:18892/,
    );
  } finally {
    svc.child.kill();
  }
});

test(
  "a non-loopback bind without a token is refused",
  { timeout: 10_000 },
  async () => {
    const svc = startService({
      OPENJEV_PORT: "18893",
      OPENJEV_HOST: "0.0.0.0",
    });
    assert.equal(await svc.exited, 1);
    assert.match(
      svc.output(),
      /refusing to listen on non-loopback host 0\.0\.0\.0/,
    );
  },
);

test(
  "LAN exposure is allowed with a token or an explicit opt-out",
  { timeout: 10_000 },
  async () => {
    for (const [port, env] of [
      ["18894", { OPENJEV_TOKEN: "t" }],
      ["18895", { OPENJEV_ALLOW_UNAUTHENTICATED: "1" }],
    ]) {
      const svc = startService({
        OPENJEV_PORT: port,
        OPENJEV_HOST: "0.0.0.0",
        ...env,
      });
      try {
        assert.match(
          await svc.listening(),
          new RegExp(`listening on http://0\\.0\\.0\\.0:${port}`),
        );
      } finally {
        svc.child.kill();
      }
    }
  },
);
