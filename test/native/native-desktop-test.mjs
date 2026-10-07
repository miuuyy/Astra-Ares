import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  createWriteStream,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { DesktopIntegration } from "../../src/desktop.mjs";
import { DESKTOP_FLAGS, withDesktopConfig } from "../../src/desktop-config.mjs";
import { CodexRpc } from "../../src/rpc.mjs";

const binary = resolve(process.argv[2]),
  evidence = resolve(process.argv[3]);
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "ares-native-desktop-"));
const profile = join(root, "profile"),
  configPath = join(root, "ares.json"),
  dataHome = join(root, "data");
mkdirSync(profile);
const catalog = JSON.parse(
  readFileSync(new URL("../fixtures/models.json", import.meta.url), "utf8"),
);
const astra = catalog.models.find((m) => m.slug === "gpt-6-astra");
astra.use_responses_lite = true;
writeFileSync(join(root, "models.json"), JSON.stringify({ models: [astra] }));
const decisions = [],
  requests = [],
  failures = [],
  notifications = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/v1/systemone") {
        const body = await request.json();
        assert.equal(body.model, "desktop-fixture");
        decisions.push(JSON.parse(body.state));
        return Response.json({
          model: body.model,
          answers: {
            effort: {
              type: "choice",
              choice: decisions.length === 1 ? "low" : "high",
            },
            lease: {
              type: "choice",
              choice: decisions.length === 1 ? "2" : "1",
            },
          },
        });
      }
      if (request.method !== "POST") return new Response(null, { status: 426 });
      let bytes = Buffer.from(await request.arrayBuffer());
      if (request.headers.get("content-encoding") === "zstd")
        bytes = Bun.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes);
      requests.push(body);
      assert.equal(body.model, "gpt-6-astra");
      const n = requests.length,
        item =
          n < 3
            ? {
                type: "function_call",
                call_id: `desktop-${n}`,
                name: "desktop_fixture",
                arguments: "{}",
              }
            : {
                type: "message",
                id: `final-${n}`,
                role: "assistant",
                content: [{ type: "output_text", text: "READY" }],
              };
      return new Response(
        [
          { type: "response.created", response: { id: `desktop-${n}` } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              id: `desktop-${n}`,
              usage: {
                input_tokens: 100,
                output_tokens: 10,
                total_tokens: 110,
              },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    } catch (error) {
      failures.push(error.message);
      return new Response("fixture failure", { status: 500 });
    }
  },
});
const configFile = join(profile, "config.toml");
const original = `# Preserve desktop settings and comments.
model_provider = "fixture"
model_catalog_json = ${JSON.stringify(join(root, "models.json"))}
[model_providers.fixture]
name = "OpenAI"
base_url = "http://127.0.0.1:${server.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
[features]
"reasoning_effort_override" = false # preserve this comment
hooks = false
apps = false
plugins = false
code_mode_host = false
remote_models = false
shell_snapshot = false
[analytics]
enabled = false
[feedback]
enabled = false
`;
writeFileSync(configFile, original);
writeFileSync(
  configPath,
  JSON.stringify({
    provider: "local",
    baseUrl: `http://127.0.0.1:${server.port}`,
    decisionModel: "desktop-fixture",
    contextTokenLimit: 28000,
    maxLeaseSteps: 2,
    codexBinary: binary,
  }),
);
const launchEnv = {},
  commands = [];
let loaded = false;
const desktop = new DesktopIntegration({
  userHome: root,
  env: { ARES_CONFIG: configPath, ARES_HOME: dataHome },
  nodePath: execFileSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
  }).trim(),
  exec(command, args) {
    commands.push([command, ...args]);
    assert.equal(command, "/bin/launchctl");
    const [action, key, value] = args;
    if (action === "getenv") return launchEnv[key] ?? "";
    if (action === "setenv") {
      launchEnv[key] = value;
      return "";
    }
    if (action === "unsetenv") {
      delete launchEnv[key];
      return "";
    }
    if (action === "bootstrap") {
      loaded = true;
      return "";
    }
    if (action === "bootout") {
      loaded = false;
      return "";
    }
    if (action === "print" && loaded) return "loaded";
    if (action === "print")
      throw Object.assign(new Error("not loaded"), { status: 113 });
    throw new Error(`unexpected action: ${action}`);
  },
});
let rpc;
const stderr = createWriteStream(join(evidence, "stderr.log"));
try {
  const status = await desktop
    .install({ codexHome: profile })
    .catch((error) => {
      try {
        execFileSync(binary, ["app-server", "--stdio"], {
          env: {
            PATH: process.env.PATH,
            HOME: root,
            CODEX_HOME: profile,
            RUST_LOG: "error",
          },
          input: "",
          encoding: "utf8",
          timeout: 5000,
        });
      } catch (diagnostic) {
        writeFileSync(
          join(evidence, "config-stderr.log"),
          diagnostic.stderr ?? "",
        );
      }
      throw error;
    });
  assert(status.environmentMatches && status.filesMatch);
  execFileSync("/usr/bin/plutil", ["-lint", desktop.paths.plist], {
    stdio: "pipe",
  });
  const installedText = readFileSync(configFile, "utf8");
  assert(installedText.includes("# Preserve desktop settings and comments."));
  assert(
    installedText.includes(
      '"reasoning_effort_override" = true # preserve this comment',
    ),
  );
  // Launch exactly the generated executable with no installing shell's ARES_* variables.
  rpc = new CodexRpc(
    desktop.paths.launcher,
    ["app-server", "--stdio"],
    {
      PATH: "/usr/bin:/bin",
      HOME: root,
      ...launchEnv,
      RUST_LOG: "off",
    },
    stderr,
  );
  rpc.on("fault", (error) => failures.push(error.message));
  let complete, fail;
  rpc.on("message", (message) => {
    notifications.push(message);
    if (message.method === "item/tool/call")
      rpc.send({
        id: message.id,
        result: {
          success: true,
          contentItems: [
            { type: "inputText", text: "Verified fixture result" },
          ],
        },
      });
    else if (message.method === "turn/completed")
      complete?.(message.params.turn);
    else if (message.id !== undefined)
      fail?.(new Error(`Unexpected request: ${message.method}`));
  });
  await rpc.call("initialize", {
    clientInfo: { name: "ares_desktop_fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });
  const models = await rpc.call("model/list", {});
  assert(models.data.some((model) => model.model === "Astra-Jev"));
  const thread = await rpc.call("thread/start", {
    model: "Astra-Jev",
    cwd: root,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "desktop_fixture",
        description: "Fixture",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  });
  let timer;
  const finished = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
    timer = setTimeout(
      () => reject(new Error("Desktop fixture turn timed out")),
      30000,
    );
  }).finally(() => clearTimeout(timer));
  finished.catch(() => {});
  await rpc.call("turn/start", {
    threadId: thread.thread.id,
    effort: "low",
    input: [{ type: "text", text: "Verify desktop effort changes." }],
  });
  assert.equal((await finished).status, "completed");
  await rpc.stop();
  rpc = null;
  writeFileSync(
    join(evidence, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
  assert.equal(decisions.length, 2);
  const effectiveEffort = (request) =>
    request.input.findLast((item) => item.type === "configuration_update")
      ?.reasoning.effort ?? request.reasoning.effort;
  assert.deepEqual(requests.map(effectiveEffort), ["low", "low", "high"]);
  assert(requests.every((request) => request.reasoning.effort === "low"));
  for (let n = 1; n < requests.length; n++)
    assert.deepEqual(
      requests[n].input.slice(0, requests[n - 1].input.length),
      requests[n - 1].input,
    );
  assert.equal(decisions[0].latestUserPrompt, "Verify desktop effort changes.");
  const records = readdirSync(join(dataHome, "runs")).flatMap((dir) =>
    readFileSync(join(dataHome, "runs", dir, "decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse),
  );
  assert.deepEqual(
    records
      .filter((r) => r.type === "decision")
      .map((r) => [r.effort, r.reused]),
    [
      ["low", false],
      ["low", true],
      ["high", false],
    ],
  );
  assert(
    notifications.some(
      (message) =>
        message.method === "turn/reasoningEffort/updated" &&
        message.params.toEffort === "high",
    ),
  );
  assert(!failures.length, failures.join("\n"));
  await desktop.uninstall();
  assert.deepEqual(launchEnv, {});
  const restored = readFileSync(configFile, "utf8");
  assert(
    restored.includes(
      '"reasoning_effort_override" = false # preserve this comment',
    ),
  );
  assert(!restored.includes("step_model_switching"));

  // Native TOML editing handles valid representations without a second parser.
  for (const text of [
    "",
    '# keep\nfeatures."step_model_switching" = false\n',
    "# keep\nfeatures = { reasoning_effort_override = false }\n",
  ]) {
    writeFileSync(configFile, text);
    await withDesktopConfig(binary, profile, async ({ read, write }) => {
      const before = await read();
      const after = await write(
        Object.fromEntries(DESKTOP_FLAGS.map((key) => [key, true])),
        before,
      );
      assert(DESKTOP_FLAGS.every((key) => after.flags[key]));
      await write(before.flags, after);
    });
    if (text.includes("# keep"))
      assert(readFileSync(configFile, "utf8").includes("# keep"));
  }
  writeFileSync(configFile, "features = [ invalid\n");
  await assert.rejects(
    withDesktopConfig(binary, profile, async ({ read }) => read()),
  );
  assert.equal(readFileSync(configFile, "utf8"), "features = [ invalid\n");
  writeFileSync(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: true,
        modelGenerations: requests.length,
        evaluatorRequests: decisions.length,
        efforts: requests.map(effectiveEffort),
        nativeAcknowledgements: records.filter((r) => r.type === "decision")
          .length,
        tomlVariants: 4,
        launchctl: "isolated fixture",
        desktopUI: "not exercised",
      },
      null,
      2,
    ),
  );
  console.log(
    "Desktop native fixture passed: saved paths, TOML edits, stdio, lease reuse, native effort changes, uninstall.",
  );
} finally {
  await rpc?.stop();
  server.stop(true);
  stderr.end();
  rmSync(root, { recursive: true, force: true });
}
