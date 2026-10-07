#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import {
  locations,
  loadConfig,
  saveConfig,
  readKey,
  validateConfig,
  readConfig,
} from "../src/config.mjs";
import { verifyBinary } from "../src/launch.mjs";
import { Jev } from "../src/jev.mjs";
import { buildCodex, isCurrentManagedBuild } from "../scripts/build-codex.mjs";
const help = `Astra-Ares — Adaptive Reasoning Effort Selection

ares setup [--binary /path/to/patched/codex] [--provider vercel|typesafe|openrouter|local]
ares configure [--provider vercel|typesafe|openrouter|local] [--key-stdin]
  [--base-url http://127.0.0.1:8890] [--decision-model model-id] [--context-token-limit 7000]
ares doctor [--probe]
ares config-path
astra-ares [ordinary Codex CLI arguments]

Config: $ARES_CONFIG or ~/.config/astra-ares/config.json
Data:   $ARES_HOME or ~/.local/share/astra-ares
setup builds an isolated pinned Codex. --binary adopts an already patched build.
configure reads a key without echo; --key-stdin accepts a piped secret.
New installations use OpenRouter. Existing configurations keep their provider.
Vercel: AI_GATEWAY_API_KEY. Direct TypeSafe: TYPESAFE_API_KEY.
OpenRouter Decisions: OPENROUTER_API_KEY.
Local System One service: ARES_LOCAL_API_KEY (optional); model and token limit required.
`;
function parse(args) {
  const options = {};
  while (args.length) {
    const arg = args.shift();
    if (["--probe", "--key-stdin"].includes(arg)) options[arg.slice(2)] = true;
    else if (
      [
        "--binary",
        "--provider",
        "--base-url",
        "--decision-model",
        "--context-token-limit",
      ].includes(arg) &&
      args[0] &&
      !args[0].startsWith("--")
    )
      options[arg.slice(2)] = args.shift();
    else throw new Error(`Unknown or incomplete option: ${arg}`);
  }
  return options;
}
function applyEvaluatorOptions(config, options) {
  const clearKey = () => {
    for (const field of ["apiKey", "apiKeyEnv", "apiKeyFile"])
      delete config[field];
  };
  if (options.provider && options.provider !== config.provider) {
    clearKey();
    for (const field of ["baseUrl", "decisionModel", "contextTokenLimit"])
      delete config[field];
    config.provider = options.provider;
  }
  if (
    options["base-url"] !== undefined &&
    options["base-url"] !== config.baseUrl
  )
    clearKey();
  if (
    options["decision-model"] !== undefined &&
    options["decision-model"] !== config.decisionModel
  )
    delete config.contextTokenLimit;
  for (const [option, field] of [
    ["base-url", "baseUrl"],
    ["decision-model", "decisionModel"],
  ]) {
    if (options[option] !== undefined) config[field] = options[option];
  }
  if (options["context-token-limit"] !== undefined)
    config.contextTokenLimit = Number(options["context-token-limit"]);
}
try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22+ is required");
  const command = process.argv[2] ?? "help";
  const options = parse(process.argv.slice(3));
  const allowedOptions = {
    setup: [
      "binary",
      "provider",
      "base-url",
      "decision-model",
      "context-token-limit",
    ],
    configure: [
      "provider",
      "key-stdin",
      "base-url",
      "decision-model",
      "context-token-limit",
    ],
    doctor: ["probe"],
  };
  for (const option of Object.keys(options))
    if (!(allowedOptions[command] ?? []).includes(option))
      throw new Error(`Option --${option} is not supported by ${command}`);
  const paths = locations();
  if (["help", "--help", "-h"].includes(command)) console.log(help);
  else if (command === "config-path") console.log(paths.config);
  else if (command === "setup") {
    const config = existsSync(paths.config)
      ? readConfig(paths.config)
      : { provider: options.provider ?? "openrouter", maxLeaseSteps: 10 };
    applyEvaluatorOptions(config, options);
    validateConfig(config);
    let needsBuild = false;
    if (options.binary) {
      config.codexBinary = resolve(options.binary);
      verifyBinary(config.codexBinary);
    } else {
      try {
        verifyBinary(config.codexBinary ?? paths.binary);
      } catch (error) {
        if (config.codexBinary)
          throw new Error(
            `Configured codexBinary is incompatible: ${error.message} Rebuild it and use setup --binary, or remove codexBinary from ${paths.config} to build the managed binary.`,
          );
        needsBuild = true;
      }
    }
    if (!config.codexBinary && !isCurrentManagedBuild(paths.home))
      needsBuild = true;
    // Persist setup's choices before the long build. A concurrent configure
    // command owns any later changes; never write this snapshot back afterward.
    saveConfig(paths.config, config);
    if (needsBuild) {
      console.log("Building the current native checkpoint...");
      await buildCodex(paths.home);
    }
    verifyBinary(config.codexBinary ?? paths.binary);
    console.log(
      `Ready. Config: ${paths.config}\nSet your provider key with ares configure, or its environment variable.\nStart: astra-ares`,
    );
  } else if (command === "configure") {
    const config = existsSync(paths.config)
      ? readConfig(paths.config)
      : { provider: "openrouter", maxLeaseSteps: 10 };
    applyEvaluatorOptions(config, options);
    validateConfig(config);
    let key;
    if (options["key-stdin"]) key = readFileSync(0, "utf8").trim();
    else {
      if (!process.stdin.isTTY)
        throw new Error("Use --key-stdin for a piped key");
      process.stderr.write(
        config.provider === "local"
          ? "Local evaluator API key (hidden; Enter for no key): "
          : "Jev API key (hidden): ",
      );
      const output = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      const rl = createInterface({
        input: process.stdin,
        output,
        terminal: true,
      });
      try {
        key = (await rl.question("")).trim();
      } finally {
        rl.close();
        process.stderr.write("\n");
      }
    }
    if ((!key && config.provider !== "local") || /\s/.test(key))
      throw new Error("Invalid API key");
    delete config.apiKeyFile;
    delete config.apiKeyEnv;
    if (key) config.apiKey = key;
    else delete config.apiKey;
    saveConfig(paths.config, config);
    console.log(`Configuration saved privately in ${paths.config}`);
  } else if (command === "doctor") {
    const config = loadConfig();
    verifyBinary(config.codexBinary ?? paths.binary);
    const key = readKey(config);
    console.log(
      `Codex checkpoint: compatible\nProvider: ${config.provider}\nCredential: ${key ? "present" : "not configured (local service)"}\nConfig: ${paths.config}`,
    );
    if (options.probe) {
      const decision = await new Jev({
        apiKey: key,
        provider: config.provider,
        baseUrl: config.baseUrl,
        decisionModel: config.decisionModel,
        contextTokenLimit: config.contextTokenLimit,
        maxLeaseSteps: config.maxLeaseSteps,
      }).decide({
        model: "gpt-6-astra",
        supportedEfforts: ["low", "medium", "high"],
        latestUserPrompt: "Reply READY.",
        publicNotes: [],
        recentToolCalls: [],
      });
      console.log(
        JSON.stringify(
          {
            probe: "passed",
            provider: decision.provider,
            model: decision.evaluatedModel,
            effort: decision.effort,
            usage: decision.usage,
            attempts: decision.attempts,
            ms: decision.jevMs,
          },
          null,
          2,
        ),
      );
    }
  } else throw new Error(`Unknown command: ${command}\n${help}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
