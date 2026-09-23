#!/usr/bin/env node
import {
  launchDesktopCodex,
  recordDesktopLauncherError,
} from "../src/desktop.mjs";

try {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Node.js 22+ is required");
  process.exitCode = await launchDesktopCodex(process.argv.slice(2));
} catch (error) {
  recordDesktopLauncherError(error, process.argv.slice(2));
  process.exitCode = 1;
}
