#!/usr/bin/env node
import { resolve } from "node:path";
import { DesktopIntegration, launchDesktop } from "../src/desktop.mjs";

try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22+ is required");
  const [receipt, command, ...args] = process.argv.slice(2);
  if (!receipt) throw new Error("Missing desktop installation receipt");
  if (command === "run") process.exitCode = await launchDesktop(args, receipt);
  else if (command === "activate" && args.length === 0) {
    const desktop = new DesktopIntegration();
    if (resolve(receipt) !== desktop.paths.state)
      throw new Error(
        "Desktop receipt does not belong to this user installation",
      );
    await desktop.activate();
  } else throw new Error("Invalid desktop launcher invocation");
} catch (error) {
  // stdout belongs exclusively to the native app-server protocol.
  console.error(`Ares desktop: ${error.message}`);
  process.exitCode = 1;
}
