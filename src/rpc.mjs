import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

export class CodexRpc extends EventEmitter {
  constructor(binary, args, env, stderr, options = {}) {
    super();
    this.sequence = 0;
    this.pending = new Map();
    this.child = spawn(binary, args, {
      ...options,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => stderr?.write(chunk));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch (error) {
        this.failPending(error);
        this.emit("fault", error);
      }
    });
    this.child.on("error", (error) => {
      this.failPending(error);
      this.emit("fault", error);
    });
    this.child.stdin.on("error", (error) => {
      this.failPending(error);
      this.emit("fault", error);
    });
    this.child.on("exit", (code, signal) => {
      this.failPending(new Error(`Codex exited (${code ?? signal})`));
      this.emit("exit", { code, signal });
    });
  }
  failPending(error) {
    this.closedError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.closedError);
    }
    this.pending.clear();
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error("Unexpected Codex response id");
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error)
        pending.reject(
          new Error(`${pending.method}: ${message.error.message}`),
        );
      else pending.resolve(message.result);
    } else this.emit("message", message);
  }
  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  call(method, params, timeoutMs = 30_000) {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  // Windows terminates asynchronously; a restart on the same CODEX_HOME must
  // wait until the old process releases its SQLite state.
  stop() {
    if (
      this.child.pid === undefined ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return Promise.resolve();
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    this.child.kill("SIGTERM");
    const timeout = setTimeout(() => this.child.kill("SIGKILL"), 5000);
    return exited.finally(() => clearTimeout(timeout));
  }
}
