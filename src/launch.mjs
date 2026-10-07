import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { Bridge, controllerPath } from "./bridge.mjs";
import { Jev } from "./jev.mjs";
import { exe, loadConfig, readKey } from "./config.mjs";
import { assertLocalCliArgs } from "./cli-args.mjs";
export function verifyBinary(binary) {
  if (!existsSync(binary))
    throw new Error("Patched Codex is missing. Run ares setup.");
  const bytes = readFileSync(binary);
  for (const marker of [
    "CODEX_STEP_CONTROLLER_CONTEXT_V3",
    "Jev requires its bridge",
    "Astra Ares",
    "Luna Ares",
    "Sol Ares",
  ]) {
    if (!bytes.includes(Buffer.from(marker)))
      throw new Error(
        "This Codex binary has no compatible Jev checkpoint. Run ares setup.",
      );
  }
  if (
    execFileSync(binary, ["--version"], {
      encoding: "utf8",
      // Defender can scan a fresh 300+ MB codex.exe for over a minute on first run.
      timeout: 120_000,
    }).trim() !== "codex-cli 0.155.0-alpha.9.2"
  )
    throw new Error(
      "Unsupported Codex version; rebuild the pinned source with ares setup.",
    );
  if (!existsSync(join(dirname(binary), `codex-code-mode-host${exe}`)))
    throw new Error(
      `codex-code-mode-host${exe} must be beside the patched Codex`,
    );
}
export async function launch(args, config = loadConfig()) {
  if (!["darwin", "linux", "win32"].includes(process.platform))
    throw new Error("Jev native checkpoint requires macOS, Linux or Windows");
  assertLocalCliArgs(args);
  const binary = config.codexBinary ?? config.paths.binary;
  verifyBinary(binary);
  const home = config.codexHome ?? config.paths.codexHome;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!existsSync(join(home, "config.toml")))
    writeFileSync(
      join(home, "config.toml"),
      'model = "Astra-Jev"\nmodel_provider = "openai"\n',
      { mode: 0o600 },
    );
  const auth = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "auth.json",
  );
  if (!existsSync(join(home, "auth.json")) && existsSync(auth))
    try {
      symlinkSync(auth, join(home, "auth.json"));
    } catch (error) {
      // Windows needs Developer Mode for symlinks. Never copy a rotating token.
      if (error.code !== "EPERM") throw error;
      console.error(
        "Could not link your Codex login; sign in separately with: node bin/astra-ares.mjs login",
      );
    }
  const socketDir = mkdtempSync(join(tmpdir(), "ares-"));
  const runDir = join(
    config.paths.runs,
    new Date().toISOString().replaceAll(":", "-") + "-" + process.pid,
  );
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const record = (event) =>
    appendFileSync(
      join(runDir, "decisions.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n",
      { mode: 0o600 },
    );
  let evaluator;
  const jev = {
    decide(state, options) {
      evaluator ??= new Jev({
        apiKey: readKey(config),
        provider: config.provider,
        baseUrl: config.baseUrl,
        decisionModel: config.decisionModel,
        contextTokenLimit: config.contextTokenLimit,
        maxLeaseSteps: config.maxLeaseSteps,
        record,
      });
      return evaluator.decide(state, options);
    },
  };
  const bridge = new Bridge({
    socketPath: controllerPath(socketDir),
    jev,
    record,
  });
  const env = {
    ...process.env,
    CODEX_HOME: home,
    CODEX_STEP_CONTROLLER_SOCKET: bridge.socketPath,
  };
  for (const name of [
    "AI_GATEWAY_API_KEY",
    "TYPESAFE_API_KEY",
    "OPENROUTER_API_KEY",
    "ARES_LOCAL_API_KEY",
    config.apiKeyEnv,
  ].filter(Boolean))
    delete env[name];
  let child;
  // Windows already delivers console Ctrl+C to the child; kill() would terminate it.
  const onInt = () => process.platform !== "win32" && child?.kill("SIGINT"),
    onTerm = () => child?.kill("SIGTERM");
  try {
    await bridge.start();
    record({
      type: "cli_started",
      version: "0.2.1",
      provider: config.provider,
      maxLeaseSteps: config.maxLeaseSteps,
    });
    child = spawn(
      binary,
      [
        "-c",
        "features.step_model_switching=true",
        "-c",
        "features.reasoning_effort_override=true",
        ...args,
      ],
      { stdio: "inherit", env },
    );
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 130 : 1)));
    });
    record({
      type: "cli_exited",
      exitCode: code,
      confirmedCheckpoints: bridge.completedCheckpoints,
    });
    return code;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    await bridge.stop();
    rmSync(socketDir, { recursive: true, force: true });
  }
}
