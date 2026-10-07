import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join, dirname, isAbsolute } from "node:path";

export const exe = process.platform === "win32" ? ".exe" : "";

export function locations(env = process.env) {
  const home = env.ARES_HOME
    ? resolve(env.ARES_HOME)
    : join(homedir(), ".local/share/astra-ares");
  const config = env.ARES_CONFIG
    ? resolve(env.ARES_CONFIG)
    : join(
        env.XDG_CONFIG_HOME || join(homedir(), ".config"),
        "astra-ares/config.json",
      );
  return {
    home,
    config,
    binary: join(home, `bin/codex${exe}`),
    codexHome: join(home, "codex-home"),
    runs: join(home, "runs"),
  };
}
export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Config must be a JSON object");
  const allowed = [
    "provider",
    "apiKey",
    "apiKeyEnv",
    "apiKeyFile",
    "maxLeaseSteps",
    "codexHome",
    "codexBinary",
  ];
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown config field: ${key}`);
  if (!["vercel", "typesafe", "openrouter"].includes(value.provider))
    throw new Error("provider must be vercel, typesafe or openrouter");
  if (![1, 2, 5, 10].includes(value.maxLeaseSteps ?? 10))
    throw new Error("maxLeaseSteps must be 1, 2, 5 or 10");
  for (const key of allowed.filter((k) => k !== "maxLeaseSteps")) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "string" || !value[key].trim())
    )
      throw new Error(`${key} must be a nonempty string`);
  }
  if (
    ["apiKey", "apiKeyEnv", "apiKeyFile"].filter(
      (key) => value[key] !== undefined,
    ).length > 1
  )
    throw new Error("Choose one of apiKey, apiKeyEnv or apiKeyFile");
  for (const key of ["codexHome", "codexBinary", "apiKeyFile"])
    if (value[key] && !isAbsolute(value[key]))
      throw new Error(`${key} must be an absolute path`);
  return { ...value, maxLeaseSteps: value.maxLeaseSteps ?? 10 };
}
export function loadConfig(env = process.env) {
  const paths = locations(env);
  if (!existsSync(paths.config))
    throw new Error(`Run ares setup first. Missing config: ${paths.config}`);
  return { ...readConfig(paths.config), paths };
}
export function readConfig(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Cannot read valid JSON configuration: ${file}`);
  }
  return validateConfig(data);
}
export function readKey(config, env = process.env) {
  const variable =
    config.apiKeyEnv ||
    {
      vercel: "AI_GATEWAY_API_KEY",
      typesafe: "TYPESAFE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    }[config.provider];
  const key = config.apiKeyFile
    ? readFileSync(config.apiKeyFile, "utf8").trim()
    : config.apiKey?.trim() || env[variable]?.trim();
  if (!key || /\s/.test(key))
    throw new Error(
      `Missing or invalid Jev credential. Set ${variable} or apiKey in ${config.paths?.config ?? "config.json"}`,
    );
  return key;
}
export function saveConfig(file, config) {
  validateConfig(config);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.new`;
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
