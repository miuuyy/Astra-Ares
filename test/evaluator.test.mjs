import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Jev, decisionRequest } from "../src/jev.mjs";
import { readKey, validateConfig } from "../src/config.mjs";

const state = {
  model: "gpt-6-astra",
  supportedEfforts: ["low", "high"],
  latestUserPrompt: "Inspect the failing test",
  publicNotes: [],
  recentToolCalls: [],
};
const local = {
  provider: "local",
  baseUrl: "http://127.0.0.1:8890",
  decisionModel: "fixture-reader",
  contextTokenLimit: 7000,
};
const answer = (model) => ({
  model,
  answers: {
    effort: { type: "choice", choice: "low" },
    lease: { type: "choice", choice: "1" },
  },
});

test("local HTTP service receives all criteria and state with a singleton lease", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(body),
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answer(local.decisionModel)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    for (const apiKey of [undefined, "fixture-local-key"]) {
      const client = new Jev({
        ...local,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        maxLeaseSteps: 1,
        apiKey,
      });
      const result = await client.decide(state);
      const request = requests.at(-1);
      assert.equal(request.path, "/v1/systemone");
      assert.equal(request.auth, apiKey ? `Bearer ${apiKey}` : undefined);
      assert.deepEqual(JSON.parse(request.body.state), state);
      assert.deepEqual(
        request.body.questions,
        decisionRequest(state, 1).questions,
      );
      assert.equal(request.body.providerOptions, undefined);
      assert.equal(request.body.model, local.decisionModel);
      assert.equal(result.effort, "low");
      assert.equal(result.leaseSteps, 1);
      assert.equal(result.cost, null);
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("custom OpenRouter models keep the key and reject model substitution", async () => {
  let wrongModel = false;
  const client = new Jev({
    provider: "openrouter",
    apiKey: "fixture-openrouter-key",
    decisionModel: "cloudflare/clef-flash",
    contextTokenLimit: 60000,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
      assert.equal(
        options.headers.authorization,
        "Bearer fixture-openrouter-key",
      );
      const request = JSON.parse(options.body);
      assert.equal(request.model, "cloudflare/clef-flash");
      assert.deepEqual(request.provider, { allow_fallbacks: false });
      assert.deepEqual(request.state, state);
      return Response.json({
        ...answer(wrongModel ? "another-model" : request.model),
        provider: "Cloudflare",
      });
    },
  });
  assert.equal((await client.decide(state)).evaluatedProvider, "Cloudflare");
  wrongModel = true;
  await assert.rejects(client.decide(state), /decision rejected/);
});

test("custom evaluator failures never become a guessed decision", async () => {
  for (const result of [
    "Because the evidence is insufficient.",
    answer("different-model"),
    {
      ...answer(local.decisionModel),
      answers: {
        effort: { type: "choice", choice: "medium" },
        lease: { type: "choice", choice: "1" },
      },
    },
    {
      ...answer(local.decisionModel),
      answers: {
        effort: { type: "choice", choice: "low" },
        lease: { type: "choice", choice: "10" },
      },
    },
  ]) {
    let requests = 0;
    const client = new Jev({
      ...local,
      maxLeaseSteps: 1,
      fetchImpl: async () => {
        requests++;
        return Response.json(result);
      },
    });
    await assert.rejects(client.decide(state));
    assert.equal(requests, 1);
  }
});

test("versioned decision models require their exact ID; provider metadata is optional", async () => {
  const canonical = "jaredpalmer/kev-4b-20260924";
  const config = {
    provider: "openrouter",
    apiKey: "fixture-key",
    contextTokenLimit: 7000,
    fetchImpl: async () => Response.json(answer(canonical)),
  };
  const result = await new Jev({ ...config, decisionModel: canonical }).decide(
    state,
  );
  assert.equal(result.evaluatedModel, canonical);
  assert.equal(result.evaluatedProvider, null);
  await assert.rejects(
    new Jev({ ...config, decisionModel: "jaredpalmer/kev-4b" }).decide(state),
    /decision rejected/,
  );
});

test("each evaluator enforces its explicit input budget before sending", async () => {
  let requests = 0;
  const client = new Jev({
    ...local,
    contextTokenLimit: 10,
    fetchImpl: async () => {
      requests++;
    },
  });
  await assert.rejects(
    client.decide(state),
    (error) => error.details.category === "local_context_limit",
  );
  assert.equal(requests, 0);
});

test("local retries keep the same model and endpoint, and cancellation prevents a decision", async () => {
  const requests = [];
  const client = new Jev({
    ...local,
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      requests.push({ url, body: options.body });
      return requests.length < 3
        ? Response.json({ error: { message: "busy" } }, { status: 503 })
        : Response.json(answer(local.decisionModel));
    },
  });
  assert.equal((await client.decide(state)).attempts, 3);
  assert.equal(new Set(requests.map((request) => request.url)).size, 1);
  assert.equal(new Set(requests.map((request) => request.body)).size, 1);
  const abort = new AbortController();
  const cancelled = new Jev({
    ...local,
    fetchImpl: async () => {
      abort.abort();
      return Response.json(answer(local.decisionModel));
    },
  });
  await assert.rejects(cancelled.decide(state, { signal: abort.signal }), {
    name: "AbortError",
  });
});

test("local credentials are optional, but malformed or explicitly missing credentials fail", () => {
  assert.equal(readKey(local, {}), undefined);
  assert.equal(
    readKey(local, { ARES_LOCAL_API_KEY: "fixture-key" }),
    "fixture-key",
  );
  for (const config of [
    { ...local, apiKey: "bad key" },
    { ...local, apiKeyEnv: "MISSING" },
  ])
    assert.throws(() => readKey(config, {}));
  assert.throws(() => new Jev({ ...local, apiKey: "bad key" }));
});

test("custom endpoints and model budgets require explicit valid configuration", () => {
  for (const change of [
    { baseUrl: undefined },
    { baseUrl: "file:///tmp/endpoint" },
    { baseUrl: "http://user:secret@localhost" },
    { baseUrl: "http://localhost/?key=secret" },
    { baseUrl: "http://localhost/#fragment" },
    { decisionModel: undefined },
    { decisionModel: "" },
    { contextTokenLimit: undefined },
    { contextTokenLimit: -1 },
    { contextTokenLimit: 1.5 },
  ])
    assert.throws(() => validateConfig({ ...local, ...change }));
  assert.throws(() =>
    validateConfig({
      provider: "openrouter",
      decisionModel: "cloudflare/clef",
    }),
  );
  assert.throws(() =>
    validateConfig({ provider: "vercel", contextTokenLimit: 50000 }),
  );
  assert.equal(
    validateConfig({ ...local, baseUrl: "http://127.0.0.1:8890/" }).baseUrl,
    local.baseUrl,
  );
});
