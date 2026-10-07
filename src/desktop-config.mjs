import { mkdirSync, realpathSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CodexRpc } from "./rpc.mjs";

export const DESKTOP_FLAGS = [
  "step_model_switching",
  "reasoning_effort_override",
];

// Use Codex's own TOML editor: preserve comments, quoted keys and other settings.
// No model requests or bridge are involved in these setup-only RPCs.
export async function withDesktopConfig(binary, home, action) {
  if (
    !readFileSync(binary).includes(
      Buffer.from("Ares config editor rejected invalid TOML before writing"),
    )
  )
    throw new Error(
      "Desktop setup requires the current native config editor. Rebuild with ares setup; rebuild an adopted codexBinary separately.",
    );
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(realpathSync(home), "config.toml");
  const rpc = new CodexRpc(
    binary,
    ["app-server", "--stdio"],
    {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: home,
      RUST_LOG: "off",
    },
    undefined,
    { cwd: home },
  );
  const call = async (method, params) => {
    try {
      return await rpc.call(method, params);
    } catch (error) {
      // Native config diagnostics can contain private values from the file.
      throw new Error(
        `Codex ${method} failed. Check the desktop config syntax and concurrent edits.`,
        { cause: error },
      );
    }
  };
  const read = async () => {
    const result = await call("config/read", { includeLayers: true });
    const layer = result.layers?.find(
      (item) =>
        item.name.type === "user" &&
        item.name.file === file &&
        !item.name.profile,
    );
    if (!layer)
      throw new Error(
        "Codex did not return the selected user configuration layer",
      );
    const flags = Object.fromEntries(
      DESKTOP_FLAGS.map((key) => {
        const value = layer.config.features?.[key] ?? null;
        if (value !== null && typeof value !== "boolean")
          throw new Error(`Invalid desktop feature setting: ${key}`);
        return [key, value];
      }),
    );
    return { flags, effective: result.config.features, version: layer.version };
  };
  const write = async (values, snapshot) => {
    const edits = Object.entries(values)
      .filter(([key, value]) => value !== snapshot.flags[key])
      .map(([key, value]) => ({
        keyPath: `features.${key}`,
        value,
        mergeStrategy: "replace",
      }));
    if (edits.length)
      await call("config/batchWrite", {
        edits,
        filePath: file,
        expectedVersion: snapshot.version,
      });
    return read();
  };
  try {
    await call("initialize", {
      clientInfo: { name: "astra_ares_setup", version: "0.2.1" },
      capabilities: { experimentalApi: true },
    });
    rpc.send({ method: "initialized" });
    return await action({ read, write });
  } finally {
    await rpc.stop();
  }
}
