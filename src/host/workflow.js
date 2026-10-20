import { randomUUID } from "node:crypto";
import { StoreError, fail, object, string } from "../core/validation.js";

export const WORKFLOW_PRESET_ID = "dsh-unlimit/local-evidence-worker";

const now = () => new Date().toISOString();
const diagnostic = (error) => ({
  code: error?.code ?? "HOST_ERROR",
  message: String(error?.message ?? error),
});
const terminal = (run) => ["completed", "failed", "stopped"].includes(run.item.status);

/** Calls the official subagents service; never edits host sessions or profiles directly. */
export class DesktopWorkflow {
  constructor(ctx, store, flow, { admission } = {}) {
    this.ctx = ctx;
    this.store = store;
    this.flow = flow;
    this.runs = new Map();
    this.closed = false;
    this.admission = admission;
    this.presetOwner = null;
    this.presetPending = null;
  }
  service(key) {
    return this.ctx.get(key);
  }
  ownsSession(sessionId) {
    return [...this.runs.values()].some((run) => run.item.sessionId === sessionId);
  }
  controlsSession(sessionId) {
    return [...this.runs.values()].some(
      (run) => run.item.sessionId === sessionId && !run.item.slotReleased,
    );
  }
  capabilities() {
    const runtime = this.service("subagents");
    const provider = runtime?.getProvider?.("spawn");
    const reasons = [];
    if (typeof this.service("agents")?.get !== "function")
      reasons.push("Live agent registry unavailable");
    if (
      typeof runtime?.startActivation !== "function" ||
      typeof runtime?.resolveMaxDepth !== "function"
    )
      reasons.push("Official managed subagent activation unavailable");
    if (typeof provider?.prepareContinuable !== "function")
      reasons.push("Local spawn provider with reserved child IDs unavailable");
    const presets = this.service("agentPresets");
    return {
      dispatch: reasons.length === 0,
      stop: reasons.length === 0,
      presets:
        ["register", "list", "resolve"].every((key) => typeof presets?.[key] === "function") &&
        provider?.capabilities?.agentPreset === true,
      runtimeOnly: true,
      reasons,
    };
  }
  workspace(workspaceId) {
    return this.store.get("workspaces", string(workspaceId, "workspaceId")).id;
  }
  snapshot(run) {
    return structuredClone(run.item);
  }
  owned(workspaceId, id) {
    const run = this.runs.get(string(id, "id"));
    if (!run || run.item.workspaceId !== workspaceId)
      fail("NOT_FOUND", "No owned workflow run in this workspace");
    return run;
  }
  async dispatch(action, payload = {}) {
    if (this.closed) fail("CLOSED", "Workflow has been closed");
    object(payload);
    switch (action) {
      case "workflow.capabilities":
        return this.capabilities();
      case "workflow.presets":
        return this.presets(payload);
      case "workflow.dispatch":
        return this.start(payload);
      case "workflow.status": {
        const workspaceId = this.workspace(payload.workspaceId);
        return payload.id === undefined
          ? {
              items: [...this.runs.values()]
                .filter((run) => run.item.workspaceId === workspaceId)
                .map((run) => this.snapshot(run)),
            }
          : { item: this.snapshot(this.owned(workspaceId, payload.id)) };
      }
      case "workflow.stop":
        return this.stop(this.owned(this.workspace(payload.workspaceId), payload.id));
      default:
        fail("UNKNOWN_ACTION", `Unsupported workflow action: ${action}`);
    }
  }
  async presets(payload) {
    const operation = payload.operation ?? "status";
    if (!["status", "register", "unregister"].includes(operation))
      fail("INVALID_INPUT", "Unknown workflow preset operation");
    if (operation === "register") {
      if (!this.capabilities().presets)
        fail("UNSUPPORTED_CAPABILITY", "Runtime preset registration unavailable");
      if (!this.presetPending)
        this.presetPending = this.registerPreset().finally(() => {
          this.presetPending = null;
        });
      await this.presetPending;
    } else if (operation === "unregister") {
      if (this.presetPending) await this.presetPending;
      if (this.presetOwner) {
        await this.presetOwner.dispose();
        this.presetOwner = null;
      }
    }
    const entries = (await this.service("agentPresets")?.list?.()) ?? [];
    const item = entries.find((entry) => entry.id === WORKFLOW_PRESET_ID) ?? null;
    return { item, owned: this.presetOwner !== null, runtimeOnly: true, persistent: false };
  }
  async registerPreset() {
    if (this.presetOwner) return;
    const registry = this.service("agentPresets");
    if ((await registry.list()).some((entry) => entry.id === WORKFLOW_PRESET_ID))
      fail("PRESET_CONFLICT", "Existing preset is not owned by this workflow; it was preserved");
    const dispose = await registry.register({
      id: WORKFLOW_PRESET_ID,
      name: "证据导向执行者",
      description: "执行明确分派的任务，回填事实、证据和未验证项；运行期注册。",
      plugins: [{ name: new URL("./workflow-preset.js", import.meta.url).href }],
    });
    if (typeof dispose !== "function")
      fail("HOST_PROTOCOL_ERROR", "Preset registry did not return an ownership disposer");
    this.presetOwner = { dispose };
    try {
      const resolved = await registry.resolve(WORKFLOW_PRESET_ID);
      if (resolved.broken)
        fail(
          "PRESET_BROKEN",
          `Workflow preset could not activate: ${JSON.stringify(resolved.broken)}`,
        );
    } catch (error) {
      let cleanupError;
      try {
        await dispose();
        this.presetOwner = null;
      } catch (cleanup) {
        cleanupError = diagnostic(cleanup);
      }
      const failure = new StoreError(
        "WORKFLOW_PRESET_FAILED",
        `Registered preset validation failed: ${error.message}`,
      );
      failure.partial = {
        presetId: WORKFLOW_PRESET_ID,
        owned: this.presetOwner !== null,
        ...(cleanupError ? { cleanupError } : {}),
      };
      throw failure;
    }
  }
  async start(payload) {
    this.admission?.require();
    const workspaceId = this.workspace(payload.workspaceId);
    const workspace = this.store.get("workspaces", workspaceId);
    const parentSessionId = string(payload.parentSessionId, "parentSessionId");
    const role = string(payload.role, "role");
    const task = string(payload.task, "task");
    if (Buffer.byteLength(task) > 32 * 1024) fail("INVALID_INPUT", "Workflow task exceeds 32 KiB");
    if (payload.usePreset !== undefined && typeof payload.usePreset !== "boolean")
      fail("INVALID_INPUT", "usePreset must be boolean");
    const caps = this.capabilities();
    if (!caps.dispatch) fail("UNSUPPORTED_CAPABILITY", caps.reasons.join("; "));
    const parent = this.service("agents").get(parentSessionId);
    if (!parent) fail("NOT_FOUND", "Parent session is not a live host agent");
    this.flow.bound(workspaceId, parentSessionId);
    const definition = this.store
      .dispatch("roles.list", { workspaceId })
      .items.find((item) => item.role === role);
    if (!definition) fail("INVALID_INPUT", "Unknown workspace role");
    const runtime = this.service("subagents");
    const maxDepth = runtime.resolveMaxDepth();
    if (payload.usePreset === true) {
      if (!caps.presets || !this.presetOwner)
        fail("PRESET_REQUIRED", "Register this workflow's runtime preset before selecting it");
      const preset = await this.service("agentPresets").resolve(WORKFLOW_PRESET_ID);
      if (preset.broken) fail("PRESET_BROKEN", "Workflow runtime preset is broken");
    }
    this.admission?.require();
    if (this.closed) fail("CLOSED", "Workflow has been closed");
    // Binding and slot acquisition precede the official factory's first async operation.
    const sessionId = randomUUID();
    this.store.dispatch("workspaces.bind", { id: workspaceId, sessionId });
    try {
      this.flow.dispatch("flow.assign", { workspaceId, sessionId, role });
      this.flow.dispatch("flow.acquire", { workspaceId, sessionId, role });
    } catch (error) {
      this.flow.dispatch("flow.assign", { workspaceId, sessionId, role: null });
      this.store.setMeta(`sessionWorkspace:${sessionId}`, null);
      throw error;
    }
    const run = {
      item: {
        id: randomUUID(),
        sessionId,
        parentSessionId,
        workspaceId,
        role,
        status: "starting",
        createdAt: now(),
        slotReleased: false,
        disposed: false,
      },
      abort: new AbortController(),
      receipt: null,
      stopRequested: false,
    };
    this.runs.set(run.item.id, run);
    run.ready = (async () => {
      try {
        const receipt = await runtime.startActivation({
          provider: "spawn",
          childId: sessionId,
          label: `明确分派任务 · ${role}`,
          request: {
            parent,
            maxDepth,
            prompt: [
              {
                type: "text",
                text: `工作区：${workspaceId}\n工作区范围声明：${workspace.scope ?? "未记录"}\n工作区授权声明（记录本身不构成新的执行许可）：${workspace.authorization ?? "未记录"}\n明确角色：${role}\n\n${definition.content}\n\n本次任务：\n${task}\n\n只执行明确分派且在用户授权范围内的任务；可在该范围内选择宿主已公开的技能和工具。保留宿主权限与审批边界，不扩大授权或绕过限制。回填事实、证据出处、缺失材料，不把推断写成已验证结果，不声称已自动完成完整攻击链。`,
              },
            ],
            ...(payload.usePreset === true ? { agentPreset: WORKFLOW_PRESET_ID } : {}),
          },
          signal: run.abort.signal,
          delivery: "caller",
        });
        run.receipt = receipt;
        if (
          receipt.childId !== sessionId ||
          !receipt.result?.then ||
          typeof receipt.dispose !== "function"
        )
          fail("HOST_PROTOCOL_ERROR", "Official activation returned an invalid receipt");
        run.item.status = "running";
        run.item.startedAt = now();
        run.item.messageId = receipt.messageId;
        run.completion = Promise.resolve(receipt.result).then(
          (result) => this.finish(run, result),
          (error) => this.finish(run, null, error),
        );
      } catch (error) {
        run.item.status = run.stopRequested ? "stopped" : "failed";
        run.item.error = diagnostic(error);
        run.item.finishedAt = now();
        // Official startActivation rolls back failed unpublished materializations.
        if (run.receipt) {
          try {
            await this.dispose(run);
          } catch (cleanup) {
            run.item.cleanupError = diagnostic(cleanup);
          }
        }
        if (!run.item.cleanupError) {
          this.release(run);
          this.flow.dispatch("flow.assign", { workspaceId, sessionId, role: null });
          this.store.setMeta(`sessionWorkspace:${sessionId}`, null);
        }
        const failure = new StoreError(
          "WORKFLOW_START_FAILED",
          `Official subagent creation failed: ${error.message}`,
        );
        failure.partial = { item: this.snapshot(run) };
        throw failure;
      }
    })();
    await run.ready;
    return { item: this.snapshot(run) };
  }
  async dispose(run) {
    if (!run.disposal)
      run.disposal = Promise.resolve()
        .then(() => run.receipt.dispose())
        .then(() => {
          run.item.disposed = true;
          delete run.item.cleanupError;
        })
        .catch((error) => {
          run.disposal = null;
          throw error;
        });
    return run.disposal;
  }
  release(run) {
    if (run.item.slotReleased) return;
    // A user may have rebound a finished session; never release its new workspace's slot.
    const workspace = this.store.dispatch("workspaces.forSession", {
      sessionId: run.item.sessionId,
    }).item;
    if (workspace?.id === run.item.workspaceId)
      this.flow.dispatch("flow.release", {
        workspaceId: run.item.workspaceId,
        sessionId: run.item.sessionId,
      });
    else this.flow.active(run.item.workspaceId); // Prune stale bindings using Flow's own invariant.
    run.item.slotReleased = true;
  }
  async finish(run, result, error) {
    if (result) run.item.result = structuredClone(result);
    if (error) run.item.error = diagnostic(error);
    run.item.status =
      run.stopRequested || result?.stopReason === "aborted"
        ? "stopped"
        : !error && result?.stopReason === "completed"
          ? "completed"
          : "failed";
    try {
      await this.dispose(run);
      this.release(run);
    } catch (cleanup) {
      run.item.cleanupError = diagnostic(cleanup);
      run.item.status = "failed";
    } finally {
      run.item.finishedAt = now();
    }
  }
  async stop(run) {
    if (terminal(run) && run.item.disposed) return { item: this.snapshot(run), stopped: false };
    run.stopRequested = true;
    run.abort.abort(new Error("Workflow owner requested stop"));
    try {
      await run.ready;
    } catch {
      if (!run.receipt) return { item: this.snapshot(run), stopped: true };
    }
    try {
      await this.dispose(run);
    } catch (error) {
      run.item.cleanupError = diagnostic(error);
      const failure = new StoreError(
        "WORKFLOW_STOP_FAILED",
        "Owned activation disposal failed; termination is not confirmed",
      );
      failure.partial = { item: this.snapshot(run) };
      throw failure;
    }
    await run.completion;
    this.release(run);
    run.item.status = "stopped";
    run.item.finishedAt = now();
    return { item: this.snapshot(run), stopped: true };
  }
  async stopAll() {
    const failures = [];
    for (const run of this.runs.values())
      if (!run.item.disposed && !run.item.slotReleased) {
        try {
          await this.stop(run);
        } catch (error) {
          failures.push(error);
        }
      }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some owned workflow executors have not confirmed termination",
      );
  }
  async close() {
    this.closed = true;
    const failures = [];
    try {
      await this.stopAll();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.presets({ operation: "unregister" });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Workflow teardown could not release every owned resource",
      );
  }
}

export default DesktopWorkflow;
