import { test } from "node:test";
import assert from "node:assert/strict";
import { Jev, validateDecision } from "../src/jev.mjs";
import { TurnEvaluator } from "../src/bridge.mjs";
import { budgetToolOutputs, outputTokens } from "../src/tool-output-budget.mjs";
import { validateConfig, readKey } from "../src/config.mjs";
import { retryDelay, responseError } from "../src/provider-error.mjs";
const success = {
  model: "typesafe-ai/jev",
  answers: {
    effort: { type: "choice", choice: "low" },
    lease: { type: "choice", choice: "10" },
  },
  usage: { inputTokens: 12 },
  providerMetadata: {
    gateway: {
      routing: {
        canonicalSlug: "typesafe-ai/jev",
        finalProvider: "typesafe-ai",
      },
    },
  },
};
const state = {
  model: "gpt-6-astra",
  supportedEfforts: ["low", "high"],
  latestUserPrompt: "Review task",
  publicNotes: [],
  recentToolCalls: [],
};
test("gateway diagnostics retain sanitized upstream capacity evidence", () => {
  const secret = "vck_provider_fixture";
  const error = responseError(
    "vercel",
    new Response("{}", { status: 429 }),
    {
      error: { type: "rate_limit_exceeded", message: "At capacity" },
      providerMetadata: {
        gateway: {
          generationId: "gen_fixture",
          routing: {
            modelAttempts: [
              {
                providerAttempts: [
                  {
                    provider: "typesafe-ai",
                    credentialType: "system",
                    statusCode: 429,
                    error: `Provider is at capacity ${secret}`,
                  },
                ],
              },
            ],
          },
        },
      },
    },
    secret,
  );
  assert.equal(error.details.upstreamAttempts[0].provider, "typesafe-ai");
  assert.equal(error.details.upstreamAttempts[0].credentialType, "system");
  assert.equal(error.details.upstreamAttempts[0].status, 429);
  assert(!JSON.stringify(error.details).includes(secret));
  assert.equal(error.details.generationId, "gen_fixture");
});
const checkpoint = (step, change = {}) => ({
  protocol: 3,
  type: "checkpoint",
  threadId: "t",
  turnId: "u",
  step,
  model: "gpt-6-astra",
  supportedEfforts: ["low", "high"],
  currentEffort: "low",
  failedToolCount: 0,
  inputRevision: 1,
  context: {
    schema: "CODEX_STEP_CONTROLLER_CONTEXT_V3",
    scope: "native_retained_history",
    latestUserPrompt: "Review task",
    originalTurnPrompt: "Review task",
    publicNotes: [],
    recentToolCalls: [],
    priorUserPrompts: [],
    omittedOlderToolCalls: 0,
  },
  ...change,
});
for (const leaseSteps of [1, 2, 5, 10])
  test(`lease ${leaseSteps} makes no extra evaluation requests`, async () => {
    let calls = 0;
    const records = [];
    const e = new TurnEvaluator({
      record: (r) => records.push(r),
      jev: {
        decide: async () => {
          calls++;
          return { effort: "low", leaseSteps, jevMs: 1 };
        },
      },
    });
    for (let step = 1; step <= leaseSteps + 1; step++) {
      const d = await e.handle(checkpoint(step));
      await e.handle({
        ...d,
        type: "applied",
        confirmation: "native_step_context_captured",
      });
      assert.equal(calls, step <= leaseSteps ? 1 : 2);
    }
    assert.deepEqual(
      records
        .filter((r) => r.type === "evaluation_requested")
        .map((r) => r.step),
      [1, leaseSteps + 1],
    );
  });
test("older-call preview omissions do not override effort or end a lease", async () => {
  const evaluated = [];
  const records = [];
  const evaluator = new TurnEvaluator({
    record: (event) => records.push(event),
    jev: {
      decide: async (state) => {
        evaluated.push(state);
        return { effort: "medium", leaseSteps: 2, jevMs: 1 };
      },
    },
  });
  for (let step = 1; step <= 16; step++) {
    const retained = Array.from({ length: step - 1 }, (_, index) => ({
      callId: `call-${index}`,
      name: "exec_command",
      input: "inspect next file",
      outputs: [{ text: "inspection succeeded", success: true }],
    }));
    const next = checkpoint(step, {
      supportedEfforts: ["low", "medium", "high"],
      currentEffort: "medium",
    });
    next.context.recentToolCalls = retained.slice(-6);
    next.context.omittedOlderToolCalls = Math.max(retained.length - 6, 0);
    const decision = await evaluator.handle(next);
    assert.equal(decision.effort, "medium");
    assert.equal(decision.leaseSteps, 2);
    assert.equal(evaluated.length, Math.ceil(step / 2));
    await evaluator.handle({
      ...decision,
      type: "applied",
      confirmation: "native_step_context_captured",
    });
  }
  assert.deepEqual(
    evaluated.map((state) => [state.step, state.omittedOlderToolCalls]),
    [
      [1, 0],
      [3, 0],
      [5, 0],
      [7, 0],
      [9, 2],
      [11, 4],
      [13, 6],
      [15, 8],
    ],
  );
  assert.equal(records.filter((event) => event.type === "decision").length, 16);
  assert(!records.some((event) => event.type === "effort_changed"));
});
for (const [label, change] of Object.entries({
  steer: { inputRevision: 2 },
  failure: { failedToolCount: 1 },
  model: { model: "other" },
  effort: { currentEffort: "high" },
}))
  test(`${label} ends lease`, async () => {
    let calls = 0;
    const e = new TurnEvaluator({
      record: () => {},
      jev: {
        decide: async () => {
          calls++;
          return { effort: "low", leaseSteps: 10, jevMs: 1 };
        },
      },
    });
    const d = await e.handle(checkpoint(1));
    await e.handle({
      ...d,
      type: "applied",
      confirmation: "native_step_context_captured",
    });
    await e.handle(checkpoint(2, change));
    assert.equal(calls, 2);
  });
test("cap is per call including multiple results and escaped multilingual text", () => {
  const text =
    "BEGIN\n" +
    '😀 Hello 世界 "field": "<|endoftext|>\\n"\n'.repeat(3000) +
    "END";
  const original = [
    {
      callId: "c",
      input: "read",
      outputs: [{ text }, { text: "status" }, { text: text + "tail" }],
    },
  ];
  const { recentToolCalls, stats } = budgetToolOutputs(original);
  const outputs = recentToolCalls[0].outputs;
  assert(outputs.reduce((sum, x) => sum + outputTokens(x.text), 0) <= 1000);
  assert(outputs[0].text.startsWith("BEGIN"));
  assert(outputs[2].text.endsWith("tail"));
  assert(!outputs[0].text.includes("\uFFFD"));
  assert.equal(original[0].outputs[0].text, text);
  assert.equal(stats.truncatedToolOutputs, 2);
});
test("429 retries preserve exact request, expose diagnostics, never switch provider", async () => {
  const bodies = [],
    logs = [];
  let n = 0;
  const j = new Jev({
    apiKey: "vck_fixture_secret",
    record: (r) => logs.push(r),
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/evaluate");
      bodies.push(options.body);
      n++;
      return n < 3
        ? new Response(
            JSON.stringify({
              error: {
                type: "rate_limit_exceeded",
                message: "capacity vck_fixture_secret",
              },
            }),
            {
              status: 429,
              headers: { "retry-after": "0", "x-vercel-id": "fixture" },
            },
          )
        : Response.json(success);
    },
  });
  const d = await j.decide(state);
  assert.equal(d.attempts, 3);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(logs.filter((r) => r.type === "provider_retry").length, 2);
  assert(!JSON.stringify(logs).includes("vck_fixture_secret"));
});
for (const [status, code, category] of [
  [400, "max_tokens_exceeded", "context_limit"],
  [429, "max_tokens_exceeded", "context_limit"],
  [402, "quota_for_entity_exceeded", "quota"],
  [401, "authentication_error", "authentication"],
])
  test(`${code} ${status} fails without retry`, async () => {
    let calls = 0;
    const j = new Jev({
      apiKey: "fixture",
      fetchImpl: async () => {
        calls++;
        return Response.json({ detail: { error_type: code } }, { status });
      },
    });
    await assert.rejects(
      j.decide(state),
      (e) => e.details.category === category,
    );
    assert.equal(calls, 1);
  });
test("429 exhausts bounded retries and carries actual provider cause", async () => {
  let calls = 0;
  const j = new Jev({
    apiKey: "fixture",
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return Response.json(
        {
          error: {
            type: "rate_limit_exceeded",
            message: "Provider is at capacity",
          },
        },
        { status: 429 },
      );
    },
  });
  await assert.rejects(
    j.decide(state),
    (e) =>
      e.details.category === "rate_limit_or_capacity" &&
      e.message.includes("Provider is at capacity"),
  );
  assert.equal(calls, 3);
});
test("long Retry-After fails rather than retrying before allowed", async () => {
  let calls = 0;
  const j = new Jev({
    apiKey: "fixture",
    sleep: async () => assert.fail("must not wait"),
    fetchImpl: async () => {
      calls++;
      return new Response("{}", {
        status: 429,
        headers: { "retry-after": "90" },
      });
    },
  });
  await assert.rejects(j.decide(state));
  assert.equal(calls, 1);
  assert.equal(retryDelay(new Headers({ "retry-after": "2" }), 1), 2000);
});
test("cancellation aborts backoff before another attempt", async () => {
  const controller = new AbortController();
  let calls = 0;
  const j = new Jev({
    apiKey: "fixture",
    fetchImpl: async () => {
      calls++;
      controller.abort();
      return new Response("{}", { status: 429 });
    },
  });
  await assert.rejects(j.decide(state, { signal: controller.signal }));
  assert.equal(calls, 1);
});
test("direct TypeSafe adapter uses canonical documented request and usage shape", async () => {
  const j = new Jev({
    apiKey: "fixture",
    provider: "typesafe",
    fetchImpl: async (url, o) => {
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      const request = JSON.parse(o.body);
      assert.equal(request.model, "jev-latest");
      assert(!request.providerOptions);
      return Response.json({
        ...success,
        model: "jev-1.13.0",
        usage: { input_tokens: 21, output_tokens: 3 },
        providerMetadata: undefined,
      });
    },
  });
  assert.deepEqual((await j.decide(state)).usage, {
    inputTokens: 21,
    outputTokens: 3,
  });
});
test("OpenRouter uses native Decisions, pinned Jev, and the same body on retry", async () => {
  const bodies = [],
    logs = [];
  const j = new Jev({
    apiKey: "fixture-openrouter-key",
    provider: "openrouter",
    record: (event) => logs.push(event),
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
      assert.equal(
        options.headers.authorization,
        "Bearer fixture-openrouter-key",
      );
      assert.equal(options.redirect, "error");
      bodies.push(options.body);
      const request = JSON.parse(options.body);
      assert.equal(request.model, "typesafe/jev-1.13");
      assert.deepEqual(request.provider, {
        only: ["typesafe"],
        allow_fallbacks: false,
      });
      assert(!request.providerOptions);
      assert(!request.messages);
      assert.deepEqual(request.state, state);
      if (bodies.length === 1)
        return Response.json(
          { error: { code: 429, message: "Rate limit exceeded" } },
          { status: 429 },
        );
      return Response.json({
        model: "typesafe/jev-1.13-20260917",
        provider: "TypeSafe",
        id: "gen-dec-fixture",
        answers: success.answers,
        usage: { input_tokens: 476, output_tokens: 70, cost: 0.000019992 },
      });
    },
  });
  const d = await j.decide(state);
  assert.equal(d.attempts, 2);
  assert.equal(new Set(bodies).size, 1);
  assert.deepEqual(d.usage, { inputTokens: 476, outputTokens: 70 });
  assert.equal(d.cost, 0.000019992);
  assert.equal(d.generationId, "gen-dec-fixture");
  assert.equal(
    logs.find((e) => e.type === "provider_error").providerCode,
    "429",
  );
  assert.match(d.requestStats.policyHash, /^[0-9a-f]{12}$/);
});
test("OpenRouter rejects another provider or an unrequested model version", () => {
  const response = {
    ...success,
    model: "typesafe/jev-1.13",
    provider: "TypeSafe",
  };
  assert.equal(validateDecision(response, 10, "openrouter").effort, "low");
  for (const change of [
    { provider: "Other" },
    { provider: undefined },
    { model: "typesafe/jev-1.14" },
    { model: "another-model" },
  ])
    assert.throws(() =>
      validateDecision({ ...response, ...change }, 10, "openrouter"),
    );
});
test("OpenRouter configuration selects only its explicit credential source", () => {
  const config = validateConfig({ provider: "openrouter" });
  assert.equal(
    readKey(config, {
      OPENROUTER_API_KEY: "openrouter-fixture",
      AI_GATEWAY_API_KEY: "wrong-fixture",
    }),
    "openrouter-fixture",
  );
  assert.throws(() => readKey(config, { AI_GATEWAY_API_KEY: "wrong-fixture" }));
});
test("local context overflow sends no network request", async () => {
  const j = new Jev({
    apiKey: "fixture",
    fetchImpl: async () => assert.fail("must not send"),
  });
  await assert.rejects(
    j.decide({ ...state, latestUserPrompt: "long ".repeat(35000) }),
    (e) => e.details.category === "local_context_limit",
  );
});
test("invalid decision cannot be substituted with a guessed effort", () => {
  assert.throws(() =>
    validateDecision({
      ...success,
      answers: {
        ...success.answers,
        effort: { type: "choice", choice: "bad" },
      },
    }),
  );
  assert.throws(() =>
    validateDecision({
      ...success,
      providerMetadata: {
        gateway: {
          routing: { canonicalSlug: "wrong", finalProvider: "typesafe-ai" },
        },
      },
    }),
  );
});
test("config rejects ambiguity, typos and unsupported lease", () => {
  assert.throws(() =>
    validateConfig({ provider: "vercel", apiKey: "x", apiKeyFile: "/key" }),
  );
  assert.throws(() => validateConfig({ provider: "vercel", maxLeaseSteps: 7 }));
  assert.throws(() => validateConfig({ provider: "vercel", fallback: "high" }));
  assert.equal(validateConfig({ provider: "vercel" }).maxLeaseSteps, 10);
});
test("cancellation after response arrival cannot return an evaluator decision", async () => {
  const abort = new AbortController();
  const j = new Jev({
    apiKey: "fixture",
    fetchImpl: async () => {
      abort.abort();
      return Response.json(success);
    },
  });
  await assert.rejects(j.decide(state, { signal: abort.signal }));
});
