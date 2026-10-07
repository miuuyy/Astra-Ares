import { createServer } from "node:net";
import { chmodSync } from "node:fs";
import { basename, join } from "node:path";
import { EFFORTS } from "./jev.mjs";
import { budgetToolOutputs } from "./tool-output-budget.mjs";

// Node serves Windows named pipes through the same net API as Unix sockets.
export function controllerPath(dir) {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${basename(dir)}`
    : join(dir, "step.sock");
}

export function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([size, body]);
}

// One state machine per native turn; the stock CLI owns chat, tools, approvals,
// model selection, history and settings. No app-server proxy or UI replacement.
export class TurnEvaluator {
  constructor({ jev, record }) {
    Object.assign(this, { jev, record });
    this.lastStep = 0;
    this.failures = 0;
    this.remaining = 0;
    this.pending = null;
  }
  async handle(p, signal) {
    if (p.protocol !== 3 || !Number.isSafeInteger(p.step))
      throw new Error("Invalid checkpoint protocol");
    if (p.type === "applied") {
      const pending = this.pending;
      if (
        !pending ||
        p.threadId !== this.threadId ||
        p.turnId !== this.turnId ||
        p.step !== pending.step ||
        p.effort !== pending.effort ||
        p.confirmation !== "native_step_context_captured"
      ) {
        throw new Error(
          "Native confirmation does not match the evaluator decision",
        );
      }
      this.record({
        ...pending,
        type: "decision",
        confirmation: p.confirmation,
      });
      if (
        this.previousEffort === undefined ||
        pending.previousEffort !== p.effort
      ) {
        this.record({
          type:
            this.previousEffort === undefined
              ? "effort_selected"
              : "effort_changed",
          threadId: p.threadId,
          turnId: p.turnId,
          step: p.step,
          from:
            pending.previousEffort === p.effort ? null : pending.previousEffort,
          to: p.effort,
          confirmation: p.confirmation,
        });
      }
      this.previousEffort = p.effort;
      this.lastStep = p.step;
      this.remaining--;
      this.pending = null;
      return { protocol: 3, type: "recorded", step: p.step };
    }
    if (
      p.type !== "checkpoint" ||
      this.pending ||
      p.step !== this.lastStep + 1 ||
      typeof p.threadId !== "string" ||
      typeof p.turnId !== "string" ||
      (this.threadId &&
        (p.threadId !== this.threadId || p.turnId !== this.turnId)) ||
      typeof p.model !== "string" ||
      !Array.isArray(p.supportedEfforts) ||
      !p.supportedEfforts.length ||
      !p.supportedEfforts.every((effort) => EFFORTS.includes(effort)) ||
      !Number.isSafeInteger(p.failedToolCount) ||
      p.failedToolCount < this.failures ||
      !Number.isSafeInteger(p.inputRevision) ||
      p.inputRevision < (this.inputRevision ?? 0) ||
      p.context?.schema !== "CODEX_STEP_CONTROLLER_CONTEXT_V3" ||
      typeof p.context.latestUserPrompt !== "string" ||
      typeof p.context.originalTurnPrompt !== "string" ||
      !Array.isArray(p.context.publicNotes) ||
      !Array.isArray(p.context.recentToolCalls) ||
      p.context.recentToolCalls.length > 6
    )
      throw new Error("Invalid native checkpoint");
    this.threadId = p.threadId;
    this.turnId = p.turnId;
    const newToolFailures = p.failedToolCount - this.failures;
    if (
      newToolFailures ||
      p.model !== this.model ||
      p.inputRevision !== this.inputRevision ||
      p.context.latestUserPrompt !== this.latestPrompt ||
      (this.previousEffort && p.currentEffort !== this.previousEffort)
    )
      this.remaining = 0;
    this.model = p.model;
    this.latestPrompt = p.context.latestUserPrompt;
    this.inputRevision = p.inputRevision;
    this.failures = p.failedToolCount;
    const reused = this.remaining > 0;
    let contextStats = null;
    if (!reused) {
      signal?.throwIfAborted();
      const { recentToolCalls, stats } = budgetToolOutputs(
        p.context.recentToolCalls,
      );
      const state = {
        model: p.model,
        supportedEfforts: p.supportedEfforts,
        latestUserPrompt: p.context.latestUserPrompt,
        originalTask:
          p.context.originalTurnPrompt === p.context.latestUserPrompt
            ? undefined
            : p.context.originalTurnPrompt,
        priorUserPrompts: p.context.priorUserPrompts,
        publicNotes: p.context.publicNotes,
        recentToolCalls,
        historyScope: p.context.scope,
        omittedOlderToolCalls: p.context.omittedOlderToolCalls,
        step: p.step,
        previousEffort: p.currentEffort,
        newToolFailures,
      };
      contextStats = {
        promptBytes: Buffer.byteLength(state.latestUserPrompt),
        publicNotes: state.publicNotes.length,
        reasoningSummaries: state.publicNotes.filter(
          (note) => note.kind === "reasoning_summary",
        ).length,
        toolCalls: state.recentToolCalls.length,
        toolOutputs: state.recentToolCalls.reduce(
          (n, call) => n + call.outputs.length,
          0,
        ),
        stateBytes: Buffer.byteLength(JSON.stringify(state)),
        truncatedByController: stats.truncatedToolOutputs > 0,
        ...stats,
      };
      this.record({
        type: "evaluation_requested",
        threadId: p.threadId,
        turnId: p.turnId,
        step: p.step,
        model: p.model,
        contextStats,
      });
      this.decision = await this.jev.decide(state, {
        signal,
        trace: { threadId: p.threadId, turnId: p.turnId, step: p.step },
      });
      this.remaining = this.decision.leaseSteps;
    }
    signal?.throwIfAborted();
    const d = this.decision;
    if (
      !p.supportedEfforts.includes(d.effort) ||
      ![1, 2, 5, 10].includes(d.leaseSteps)
    ) {
      throw new Error(
        "Evaluator selected settings unsupported by the chosen model",
      );
    }
    this.pending = {
      threadId: p.threadId,
      turnId: p.turnId,
      step: p.step,
      model: p.model,
      ...d,
      previousEffort: p.currentEffort,
      reused,
      newToolFailures,
      contextStats,
      remainingSteps: this.remaining - 1,
      jevMs: reused ? 0 : d.jevMs,
      attempts: reused ? 0 : d.attempts,
      requestStats: reused ? null : d.requestStats,
      cost: reused ? "0" : d.cost,
      usage: reused ? null : d.usage,
    };
    return {
      protocol: 3,
      type: "decision",
      threadId: p.threadId,
      turnId: p.turnId,
      step: p.step,
      effort: d.effort,
      leaseSteps: d.leaseSteps,
      evaluatorMs: Math.round(reused ? 0 : d.jevMs),
    };
  }
}

export class Bridge {
  constructor({ socketPath, jev, record }) {
    Object.assign(this, { socketPath, jev, record });
    this.sockets = new Set();
    this.owners = new Set();
    this.completedCheckpoints = 0;
  }
  async start() {
    this.server = createServer((socket) => {
      const abort = new AbortController();
      const evaluator = new TurnEvaluator({
        jev: this.jev,
        record: this.record,
      });
      this.sockets.add(socket);
      let bytes = Buffer.alloc(0),
        processing = false,
        owner;
      const fail = (error) => {
        if (abort.signal.aborted) return;
        const message = error.message.slice(0, 500);
        this.record({
          type: "controller_error",
          threadId: evaluator.threadId,
          turnId: evaluator.turnId,
          message,
          ...(error.details ?? {}),
        });
        socket.end(frame({ type: "error", message }));
        abort.abort();
      };
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length < 4) return;
        const length = bytes.readUInt32BE(0);
        if (
          !length ||
          length > 2_000_000 ||
          processing ||
          bytes.length > length + 4
        ) {
          fail(new Error("Invalid or overlapping native frame"));
          return;
        }
        if (bytes.length !== length + 4) return;
        let message;
        try {
          message = JSON.parse(bytes.subarray(4));
        } catch {
          fail(new Error("Invalid native JSON"));
          return;
        }
        if (!owner) {
          owner = JSON.stringify([message.threadId, message.turnId]);
          if (this.owners.has(owner)) {
            owner = undefined;
            fail(new Error("Duplicate active turn connection"));
            return;
          }
          this.owners.add(owner);
        }
        bytes = Buffer.alloc(0);
        processing = true;
        evaluator
          .handle(message, abort.signal)
          .then((reply) => {
            if (abort.signal.aborted) return;
            if (reply.type === "recorded") this.completedCheckpoints++;
            processing = false;
            socket.write(frame(reply));
          })
          .catch(fail);
      });
      socket.on("error", () => {});
      socket.on("close", () => {
        abort.abort();
        this.sockets.delete(socket);
        if (owner) this.owners.delete(owner);
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
    // ponytail: a Windows pipe has no file mode; its default ACL also lets
    // Everyone open it read-only, so it is not a private 0600 equivalent.
    // Add an owner-only security descriptor if strict isolation is required.
    if (process.platform !== "win32") chmodSync(this.socketPath, 0o600);
  }
  async stop() {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}
