import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { makeFakeCodex } from "./fixtures/fake-codex.mjs";
const cli = resolve("bin/ares.mjs");
function invoke(args, env, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
}
for (const provider of ["vercel", "openrouter"])
  test(`${provider} configure accepts a piped key, keeps it private and prints no secret`, () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-config-"));
    const file = join(dir, "config.json");
    const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
    try {
      const key = "vck_private_fixture_value";
      const r = invoke(
        ["configure", "--provider", provider, "--key-stdin"],
        env,
        key + "\n",
      );
      assert.equal(r.status, 0, r.stderr);
      assert(!r.stdout.includes(key));
      assert(!r.stderr.includes(key));
      assert.equal(JSON.parse(readFileSync(file, "utf8")).apiKey, key);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).provider, provider);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const doctor = invoke(["doctor"], env);
      assert.equal(doctor.status, 1);
      assert.match(doctor.stderr, /Patched Codex is missing/);
      assert(!doctor.stderr.includes(key));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
test("unknown CLI options fail visibly", () => {
  const r = invoke(["setup", "--mystery"], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown/);
});
test("new configurations default to OpenRouter; replacing a key preserves an explicit provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-default-provider-"));
  const file = join(dir, "config.json");
  const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
  try {
    const first = invoke(["configure", "--key-stdin"], env, "fixture-first\n");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).provider, "openrouter");
    const change = invoke(
      ["configure", "--provider", "typesafe", "--key-stdin"],
      env,
      "fixture-second\n",
    );
    assert.equal(change.status, 0, change.stderr);
    const replace = invoke(
      ["configure", "--key-stdin"],
      env,
      "fixture-third\n",
    );
    assert.equal(replace.status, 0, replace.stderr);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.provider, "typesafe");
    assert.equal(saved.apiKey, "fixture-third");
    const location = invoke(["config-path"], env);
    assert.equal(location.status, 0, location.stderr);
    assert.equal(location.stdout.trim(), file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("configuration parse failures never echo credential fragments", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-invalid-config-"));
  const file = join(dir, "config.json");
  const secret = "vck_private_invalid_json_fixture";
  try {
    writeFileSync(file, '{"apiKey":"' + secret + '", invalid}');
    for (const command of ["setup", "configure", "doctor"]) {
      const result = invoke([command], { ARES_CONFIG: file });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /valid JSON configuration/);
      assert(!result.stderr.includes(secret));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("options for a different command fail instead of being ignored", () => {
  const result = invoke(["doctor", "--provider", "typesafe"], {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not supported by doctor/);
});
test("openjev configure saves the endpoint and accepts an empty or absent key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-openjev-cli-"));
  const file = join(dir, "config.json");
  const env = { ARES_CONFIG: file, ARES_HOME: join(dir, "data") };
  try {
    const first = invoke(
      [
        "configure",
        "--provider",
        "openjev",
        "--base-url",
        "http://127.0.0.1:8890/",
        "--model",
        "open-jev",
      ],
      env,
      "",
    );
    assert.equal(first.status, 0, first.stderr);
    let saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.provider, "openjev");
    assert.equal(saved.baseUrl, "http://127.0.0.1:8890");
    assert.equal(saved.model, "open-jev");
    assert.equal(saved.apiKey, undefined);
    const keyed = invoke(["configure", "--key-stdin"], env, "local-token\n");
    assert.equal(keyed.status, 0, keyed.stderr);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).apiKey, "local-token");
    const cleared = invoke(["configure", "--key-stdin"], env, "\n");
    assert.equal(cleared.status, 0, cleared.stderr);
    saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.apiKey, undefined);
    assert.equal(saved.baseUrl, "http://127.0.0.1:8890");
    const spaced = invoke(["configure", "--key-stdin"], env, "a b\n");
    assert.equal(spaced.status, 1);
    assert.match(spaced.stderr, /Invalid API key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("openjev configure requires a valid base URL; hosted providers still require a key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-openjev-cli-bad-"));
  const env = {
    ARES_CONFIG: join(dir, "config.json"),
    ARES_HOME: join(dir, "data"),
  };
  try {
    const missing = invoke(["configure", "--provider", "openjev"], env, "");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /baseUrl/);
    const query = invoke(
      ["configure", "--provider", "openjev", "--base-url", "http://h:1/?x=1"],
      env,
      "",
    );
    assert.equal(query.status, 1);
    const hosted = invoke(["configure", "--provider", "openrouter"], env, "");
    assert.equal(hosted.status, 1);
    assert.match(hosted.stderr, /--key-stdin/);
    const elsewhere = invoke(
      [
        "configure",
        "--provider",
        "typesafe",
        "--base-url",
        "http://h:1",
        "--key-stdin",
      ],
      env,
      "fixture\n",
    );
    assert.equal(elsewhere.status, 1);
    assert.match(elsewhere.stderr, /baseUrl/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("openjev doctor reports the endpoint and probes it with the configured model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-openjev-doctor-"));
  const file = join(dir, "config.json");
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        url: req.url,
        auth: req.headers.authorization,
        body: JSON.parse(body),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: "local-decider",
          id: "sysone-1",
          answers: {
            effort: { type: "choice", choice: "low" },
            lease: { type: "choice", choice: "1" },
          },
          usage: { decisions: 2, latency_ms: 3 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    writeFileSync(
      file,
      JSON.stringify({
        provider: "openjev",
        baseUrl,
        model: "open-jev",
        maxLeaseSteps: 10,
        codexBinary: makeFakeCodex(dir),
      }),
    );
    const env = {
      ...process.env,
      ARES_CONFIG: file,
      ARES_HOME: join(dir, "data"),
      OPENJEV_API_KEY: "",
    };
    const child = spawn(process.execPath, [cli, "doctor", "--probe"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.match(stdout, new RegExp(`Base URL: ${baseUrl}`));
    assert.match(stdout, /Decision model: open-jev/);
    assert.match(stdout, /Credential: none \(unauthenticated local service\)/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/systemone");
    assert.equal(requests[0].auth, undefined);
    assert.equal(requests[0].body.model, "open-jev");
    assert.equal(typeof requests[0].body.state, "string");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
