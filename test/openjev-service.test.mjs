import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const MOCK_PORT = 18911;
const SVC_PORT = 18890;
const SVC_PORT_AUTH = 18891;
const BASE = `http://127.0.0.1:${SVC_PORT}`;

const backendLog = [];
let pickLetter = (letters) => 0;

const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "Qwen3.5-0.8B-Q8_0" }] }));
    }
    backendLog.push(JSON.parse(body));
    const letters = body.match(/"enum":\["([^"]*)"(?:,"([^"]*)")?/);
    const options = letters ? letters.slice(1).filter(Boolean) : ["A"];
    const chosen = options[Math.min(pickLetter(), options.length - 1)];
    const top = options.slice(0, 2).map((letter, i) => ({
      token: `"${letter}"`.includes('"') ? letter : letter,
      logprob: letter === chosen ? -0.1 : -2.0,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
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
      }),
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
  assert.match(prompt, /OPTIONS:\nA\. low\nB\. high/);
  assert.match(backendLog[1].messages.at(-1).content, /A\. 1\nB\. 10/);
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
