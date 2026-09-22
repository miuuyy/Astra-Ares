import { test } from "node:test";
import assert from "node:assert/strict";
import { Jev, validateDecision, decisionRequest } from "../src/jev.mjs";
import { renderState } from "../src/state-text.mjs";
import { validateConfig, readKey } from "../src/config.mjs";

const openjevSuccess = {
  model: "Qwen3.5-0.8B",
  answers: {
    effort: {
      type: "choice",
      choice: "low",
      probabilities: { low: 0.82, high: 0.18 },
      confidence: 0.82,
    },
    lease: { type: "choice", choice: "5", confidence: 0.6 },
  },
  usage: { input_tokens: 512, output_tokens: 4 },
  id: "openjev-fixture",
};

const state = {
  model: "gpt-6-astra",
  supportedEfforts: ["low", "high"],
  latestUserPrompt: "Review task",
  publicNotes: [],
  recentToolCalls: [],
};

test("openjev sends a rendered state to the configured /v1/systemone endpoint", async () => {
  let auth, url, body;
  const j = new Jev({
    provider: "openjev",
    baseUrl: "http://127.0.0.1:8890/",
    fetchImpl: async (u, o) => {
      url = u;
      auth = o.headers.authorization;
      body = JSON.parse(o.body);
      return Response.json(openjevSuccess);
    },
  });
  const d = await j.decide(state);
  assert.equal(url, "http://127.0.0.1:8890/v1/systemone");
  assert.equal(auth, undefined);
  assert.equal(body.model, "open-jev");
  assert.equal(typeof body.state, "string");
  assert.match(body.state, /MODEL: gpt-6-astra/);
  assert.match(body.state, /Review task/);
  assert(!body.providerOptions);
  assert.equal(d.effort, "low");
  assert.equal(d.leaseSteps, 5);
  assert.equal(d.evaluatedModel, "Qwen3.5-0.8B");
  assert.equal(d.cost, null);
  assert.equal(d.generationId, "openjev-fixture");
  assert.deepEqual(d.usage, { inputTokens: 512, outputTokens: 4 });
});

test("openjev honors a configured decision model and optional key", async () => {
  let auth, body;
  const j = new Jev({
    provider: "openjev",
    apiKey: " local-secret ",
    baseUrl: "https://macbook.tailnet:9443",
    decisionModel: " qwen-decision ",
    fetchImpl: async (_u, o) => {
      auth = o.headers.authorization;
      body = JSON.parse(o.body);
      return Response.json(openjevSuccess);
    },
  });
  await j.decide(state);
  assert.equal(auth, "Bearer local-secret");
  assert.equal(body.model, "qwen-decision");
});

test("openjev accepts the reference service's usage shape", () => {
  const d = validateDecision(
    {
      ...openjevSuccess,
      usage: { decisions: 2, images: 0, latency_ms: 41.3 },
    },
    10,
    "openjev",
  );
  assert.equal(d.usage.inputTokens, undefined);
  assert.equal(d.usage.outputTokens, undefined);
});

test("openjev rejects empty model, bad effort, and out-of-range leases", () => {
  assert.throws(() =>
    validateDecision({ ...openjevSuccess, model: "" }, 10, "openjev"),
  );
  assert.throws(() =>
    validateDecision(
      {
        ...openjevSuccess,
        answers: {
          ...openjevSuccess.answers,
          effort: { type: "choice", choice: "extreme" },
        },
      },
      10,
      "openjev",
    ),
  );
  assert.throws(() =>
    validateDecision(
      {
        ...openjevSuccess,
        answers: {
          ...openjevSuccess.answers,
          lease: { type: "choice", choice: "7" },
        },
      },
      10,
      "openjev",
    ),
  );
  assert.equal(validateDecision(openjevSuccess, 10, "openjev").effort, "low");
});

test("openjev provider errors map to bounded categories and retry on 5xx", async () => {
  let calls = 0;
  const j = new Jev({
    provider: "openjev",
    baseUrl: "http://127.0.0.1:8890",
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return Response.json(
        { detail: "decision model overloaded" },
        { status: 503 },
      );
    },
  });
  await assert.rejects(
    j.decide(state),
    (e) =>
      e.details.category === "provider_unavailable" &&
      e.details.retryable === true &&
      e.message.includes("decision model overloaded"),
  );
  assert.equal(calls, 3);
});

test("openjev constructor validates baseUrl and key shape", () => {
  assert.throws(() => new Jev({ provider: "openjev" }), /baseUrl/);
  assert.throws(
    () => new Jev({ provider: "openjev", baseUrl: "ftp://x" }),
    /http or https/,
  );
  assert.throws(
    () => new Jev({ provider: "openjev", baseUrl: "http://x/?a=1" }),
    /query or fragment/,
  );
  assert.throws(
    () => new Jev({ provider: "openjev", baseUrl: "http://x", apiKey: "a b" }),
    /whitespace/,
  );
});

test("openjev decisionRequest keeps lease criteria aligned with maxLeaseSteps", () => {
  const request = decisionRequest(
    { ...state, supportedEfforts: ["none", "low"] },
    2,
  );
  assert.deepEqual(Object.keys(request.questions.lease.criteria), ["1", "2"]);
  assert.deepEqual(Object.keys(request.questions.effort.criteria), [
    "none",
    "low",
  ]);
});

test("renderState is deterministic, complete, and bounded", () => {
  const full = {
    model: "gpt-6-astra",
    supportedEfforts: ["low", "medium", "high"],
    latestUserPrompt: "Fix the failing tests",
    originalTask: "Make CI green",
    priorUserPrompts: ["Make CI green"],
    historyScope: "native_retained_history",
    omittedOlderToolCalls: 3,
    step: 4,
    previousEffort: "low",
    newToolFailures: 1,
    publicNotes: [
      { kind: "reasoning_summary", text: "Ran the suite; 2 failures remain." },
    ],
    recentToolCalls: [
      {
        callId: "c1",
        name: "shell",
        namespace: "exec",
        input: "npm test",
        outputs: [{ text: "2 failing", success: false }],
      },
    ],
  };
  const first = renderState(full);
  assert.equal(renderState(full), first);
  assert.match(first, /MODEL: gpt-6-astra/);
  assert.match(
    first,
    /STEP: 4 \(effort so far: low\) \(new tool failures: 1\)/,
  );
  assert.match(first, /TASK:\nMake CI green/);
  assert.match(first, /LATEST USER REQUEST:\nFix the failing tests/);
  assert.match(first, /\[reasoning_summary\] Ran the suite/);
  assert.match(first, /#c1 exec:shell/);
  assert.match(first, /=> ERR: 2 failing/);
  assert.match(first, /3 older omitted/);
  const huge = renderState({
    ...full,
    publicNotes: [{ kind: "note", text: "x".repeat(300_000) }],
  });
  assert(huge.length < 130_000);
  assert.match(huge, /characters omitted/);
  const minimal = renderState({
    model: "m",
    supportedEfforts: ["low"],
    latestUserPrompt: "hi",
    publicNotes: [],
    recentToolCalls: [],
  });
  assert.match(minimal, /TASK:\nhi/);
});

test("openjev config requires baseUrl, normalizes it, and rejects it elsewhere", () => {
  assert.throws(
    () => validateConfig({ provider: "openjev" }),
    /requires baseUrl/,
  );
  const config = validateConfig({
    provider: "openjev",
    baseUrl: "http://MacBook.tailnet:8890///",
  });
  assert.equal(config.baseUrl, "http://macbook.tailnet:8890");
  assert.throws(
    () => validateConfig({ provider: "vercel", baseUrl: "http://x:1" }),
    /only used with/,
  );
  assert.throws(
    () => validateConfig({ provider: "openjev", baseUrl: "notaurl" }),
    /valid absolute URL/,
  );
  assert.throws(
    () => validateConfig({ provider: "openjev", baseUrl: "http://x/a?q=1" }),
    /query or fragment/,
  );
  assert.equal(
    validateConfig({
      provider: "openjev",
      baseUrl: "http://x:8890",
      model: "jev",
    }).model,
    "jev",
  );
});

test("openjev key is optional but OPENJEV_API_KEY is honored when present", () => {
  const config = validateConfig({
    provider: "openjev",
    baseUrl: "http://127.0.0.1:8890",
  });
  assert.equal(readKey(config, {}), undefined);
  assert.equal(readKey(config, { OPENJEV_API_KEY: "tok" }), "tok");
  const named = validateConfig({
    provider: "openjev",
    baseUrl: "http://127.0.0.1:8890",
    apiKeyEnv: "MY_KEY",
  });
  assert.equal(readKey(named, { MY_KEY: "tok2" }), "tok2");
});
