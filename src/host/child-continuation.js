import { randomUUID } from "node:crypto";
import { fail } from "../core/validation.js";
import { resolveOfficialPackage } from "./official-package.js";

const SOURCE = "dsh-unlimit/continuation";
const DELIVERY = Symbol.for("dsh.subagent.deliverPrompt");
const service = (ctx, name) => (ctx.get ? ctx.get(name) : ctx[name]);
const identity = (value) => value?.[Symbol.for("cordis.original")] ?? value;
const inputs = (event) =>
  event.type === "agent/inbox/spliced"
    ? event.data.inserted
    : event.type === "user/message"
      ? [event.data]
      : [];
const diagnostic = (error) => ({
  code: error.code ?? "CONTINUATION_FAILED",
  message: error.message,
});

function inspectPrefix(source, id) {
  if (
    source?.meta?.id !== id ||
    !Array.isArray(source.events) ||
    !Number.isSafeInteger(source.inheritedEventCount) ||
    source.inheritedEventCount < 0 ||
    source.inheritedEventCount > source.events.length ||
    source.events.some((event, index) => event.seq !== index)
  )
    fail("INVALID_HOST_RESULT", "官方会话检查没有返回完整的自有事件前缀");
  if (source.meta.origin !== "subagent" || !source.meta.parentSession)
    fail("UNSUPPORTED", "只恢复已有明确父会话的本地子任务");
  const events = source.events.slice(source.inheritedEventCount);
  const descriptor = events.findLast((event) => event.type === "subagent/descriptor")?.data;
  if (descriptor?.mode !== "continuable" || descriptor.provider !== "spawn")
    fail("UNSUPPORTED", "该子任务没有支持的本地持续会话描述");
  const end = events.findLast((event) => event.type === "turn/end");
  if (end?.data.reason?.kind !== "max-tokens")
    fail("UNSUPPORTED", "只允许继续最新明确因长度上限结束的子任务");
  if (
    events.some(
      (event) =>
        (event.seq > end.seq &&
          (event.type === "turn/start" ||
            inputs(event).some((message) => message.source.kind !== "runtime-context"))) ||
        inputs(event).some(
          (message) => message.source.kind === SOURCE && message.source.triggerSeq === end.seq,
        ),
    )
  )
    fail("CONFLICT", "该截断已有后续输入或继续请求，未追加新一轮");
  return { parentId: source.meta.parentSession, end, events };
}

/** Explicit cold resume. Observes a new native epoch; never reuses a completed workflow receipt. */
export class ChildContinuation {
  constructor(ctx, store, host, { flow, workflow, admission, readSettings, ready }) {
    Object.assign(this, { ctx, store, host, flow, workflow, admission, readSettings, ready });
    this.runs = new Map();
  }

  services() {
    return {
      runtime: service(this.ctx, "subagents"),
      agents: service(this.ctx, "agents"),
      controller: service(this.ctx, "sessionController"),
      registry: service(this.ctx, "workspaceRegistry"),
    };
  }

  support() {
    const services = this.services();
    if (
      this.host.supported === false ||
      !this.host.runtimeRoot ||
      !resolveOfficialPackage(this.host.runtimeRoot, "@deepseek-ai/dsh-subagent").url ||
      typeof services.runtime?.[DELIVERY] !== "function" ||
      typeof services.runtime.drainChildren !== "function" ||
      typeof services.controller?.inspect !== "function" ||
      typeof services.agents?.get !== "function" ||
      !Array.isArray(services.registry?.archivedSessionIds)
    )
      fail("UNSUPPORTED", "缺少已核验的本地子任务恢复、会话检查或归档状态接口");
    return services;
  }

  active(id) {
    const run = this.runs.get(id);
    return run && !run.finished ? run : null;
  }

  controlsSession(id) {
    return Boolean(this.active(id)?.item.slotHeld);
  }

  snapshot(run) {
    return structuredClone(run.item);
  }

  assertCurrent(run, agent) {
    run.abort.signal.throwIfAborted();
    const services = this.services();
    if (!this.ready() || !this.readSettings().enabled) fail("DISABLED", "继续控制已关闭");
    if (
      identity(services.runtime) !== identity(run.runtime) ||
      services.agents?.get(run.item.parentSessionId) !== run.parent
    )
      fail("CONFLICT", "子任务服务或直接父会话已改变，未提交继续请求");
    if (
      services.registry.archivedSessionIds.includes(run.item.sessionId) ||
      services.registry.archivedSessionIds.includes(run.item.parentSessionId)
    )
      fail("SESSION_ARCHIVED", "子任务或父会话已归档");
    if (run.item.slotHeld) {
      this.admission?.require();
      this.flow.bound(run.item.workspaceId, run.item.sessionId);
      this.flow.bound(run.item.workspaceId, run.item.parentSessionId);
      const held = this.flow.active(run.item.workspaceId).get(run.item.sessionId);
      if (held?.acquiredAt !== run.slot.acquiredAt || held.role !== run.slot.role)
        fail("CONFLICT", "继续任务的项目槽或角色已改变");
    }
    if (agent) {
      const source = inspectPrefix(
        {
          meta: agent.session.header,
          events: agent.session.snapshotEvents(),
          inheritedEventCount: agent.session.inheritedEventCount,
        },
        run.item.sessionId,
      );
      if (
        source.end.seq !== run.item.triggerSeq ||
        source.parentId !== run.item.parentSessionId ||
        agent.inbox.hasPending ||
        agent.status !== "idle"
      )
        fail("CONFLICT", "恢复前子任务状态已有变化");
    }
  }

  reserve(run) {
    if (this.workflow?.controlsSession(run.item.sessionId))
      fail("CONFLICT", "原执行者尚未释放收据，请等待任务完整结束");
    const workspace = this.store.dispatch("workspaces.forSession", {
      sessionId: run.item.sessionId,
    }).item;
    const role =
      workspace &&
      this.flow
        ?.status(workspace.id)
        .assignments.find((item) => item.sessionId === run.item.sessionId)?.role;
    if (!role) {
      if (this.workflow?.ownsSession(run.item.sessionId))
        fail("ROLE_REQUIRED", "原演练子任务已没有明确角色，请先重新分配");
      return;
    }
    this.admission?.require();
    this.flow.bound(workspace.id, run.item.parentSessionId);
    const acquired = this.flow.dispatch("flow.acquire", {
      workspaceId: workspace.id,
      sessionId: run.item.sessionId,
      role,
    });
    if (!acquired.acquired) fail("CONFLICT", "子任务已有其他所有者持有执行槽");
    run.slot = acquired.item;
    run.item.workspaceId = workspace.id;
    run.item.slotHeld = true;
  }

  release(run) {
    if (!run.item.slotHeld) return;
    const held = this.flow.active(run.item.workspaceId).get(run.item.sessionId);
    if (held?.acquiredAt === run.slot.acquiredAt)
      this.flow.dispatch("flow.release", {
        workspaceId: run.item.workspaceId,
        sessionId: run.item.sessionId,
      });
    run.item.slotHeld = false;
  }

  finish(run, status) {
    if (run.finished) return;
    this.release(run);
    run.finished = true;
    run.item.status = status;
    for (const dispose of run.disposers.splice(0).reverse()) dispose();
    run.settled();
  }

  watch(run) {
    const abort = (error) => {
      if (!run.accepted) run.abort.abort(error);
    };
    run.disposers.push(
      this.ctx.on("session/event", (session, event) => {
        for (const message of inputs(event)) {
          if (message.source.kind === "runtime-context") continue;
          if (session.id === run.item.sessionId) {
            if (message.source.kind === SOURCE && message.source.continuationId === run.item.id) {
              run.accepted = true;
              run.ownedIds.add(message.id);
              run.item.messageId = message.id;
              run.item.status = "running";
            } else if (
              run.accepted &&
              message.source.kind === SOURCE &&
              message.source.mode === "automatic"
            ) {
              run.ownedIds.add(message.id);
            } else if (!run.accepted) {
              abort(
                Object.assign(new Error("子任务收到新输入，已撤回等待中的继续请求"), {
                  code: "CONFLICT",
                }),
              );
            } else {
              run.foreignInput = true;
            }
          } else if (message.source.kind === "user" || message.source.kind === "agent-message") {
            run.changedParents.add(session.id);
            if (session.id === run.item.parentSessionId)
              abort(
                Object.assign(new Error("父会话收到新输入，已撤回等待中的继续请求"), {
                  code: "CONFLICT",
                }),
              );
          }
        }
      }),
      this.ctx.on("agent/created", ({ agent }) => {
        if (agent.session.id !== run.item.sessionId || run.accepted) return;
        try {
          if (!run.parent) fail("CONFLICT", "检查期间子任务已被其他操作恢复");
          this.assertCurrent(run, agent);
          run.agent = agent;
        } catch (error) {
          abort(error);
        }
      }),
      this.ctx.on("subagent/start", (event) => {
        if (event.id !== run.item.sessionId) return;
        try {
          const agent = this.services().agents.get(event.id);
          if (!event.local || event.provider !== "spawn" || !agent || !run.parent)
            fail("CONFLICT", "未观察到期望的本地子任务恢复");
          this.assertCurrent(run, agent);
          run.agent = agent;
          run.item.runId = event.runId;
        } catch (error) {
          abort(error);
        }
      }),
      this.ctx.on("subagent/end", (event) => {
        if (event.id !== run.item.sessionId || event.runId !== run.item.runId) return;
        run.item.stopReason = event.stopReason;
        // Native end follows Agent disposal and release, including fast completion before delivery resolves.
        this.finish(
          run,
          event.stopReason === "aborted"
            ? "stopped"
            : event.stopReason === "max-tokens"
              ? "truncated"
              : event.stopReason === "completed"
                ? "completed"
                : "failed",
        );
      }),
    );
  }

  async status(id) {
    const value = this.readSettings();
    const result = {
      sessionId: id,
      child: true,
      automaticCount: 0,
      limit: value.continueLimit,
      autoEnabled: Boolean(value.enabled && value.autoContinue),
      pending: false,
      stopped: false,
      manualAvailable: false,
      eligibleReason: null,
      childAutomaticAvailable: false,
      unsupportedReason: null,
      lastError: null,
    };
    const run = this.runs.get(id);
    if (run) {
      result.manualRun = this.snapshot(run);
      result.pending = !run.finished && !run.accepted;
      result.stopped = run.item.status === "stopped";
      result.lastError = run.item.error ?? null;
    }
    try {
      const services = this.support();
      const source = await services.controller.inspect(id);
      // A completed/truncated manual epoch remains visible even if the next resume is unavailable.
      const own = source.events.slice(source.inheritedEventCount);
      result.eligibleReason =
        own.findLast((event) => event.type === "turn/end")?.data.reason?.kind ?? null;
      const seen = new Set();
      for (const event of own)
        for (const message of inputs(event)) {
          if (seen.has(message.id)) continue;
          seen.add(message.id);
          if (
            message.source.kind === "user" ||
            (message.source.kind === "agent-message" &&
              message.source.senderSessionId === source.meta.parentSession)
          )
            result.automaticCount = 0;
          if (message.source.kind === SOURCE && message.source.mode === "automatic")
            result.automaticCount++;
        }
      const inspected = inspectPrefix(source, id);
      if (!this.ready() || !value.enabled) fail("DISABLED", "请先启用运行控制");
      if (this.active(id) || services.agents.get(id))
        fail("CONFLICT", "请等待当前子任务完整结束后再手动继续");
      if (
        services.registry.archivedSessionIds.includes(id) ||
        services.registry.archivedSessionIds.includes(inspected.parentId)
      )
        fail("SESSION_ARCHIVED", "子任务或父会话已归档");
      if (!services.agents.get(inspected.parentId))
        fail("PARENT_UNAVAILABLE", "直接父会话未驻留，请先打开父会话");
      result.manualAvailable = true;
    } catch (error) {
      result.unsupportedReason = error.message;
    }
    return result;
  }

  async continue(id) {
    if (this.active(id)) fail("CONFLICT", "该子任务已有等待或执行中的继续请求");
    const services = this.support();
    const run = {
      item: { id: randomUUID(), sessionId: id, runId: null, status: "starting", slotHeld: false },
      runtime: services.runtime,
      abort: new AbortController(),
      disposers: [],
      changedParents: new Set(),
      cancelledParents: new Set(),
      ownedIds: new Set(),
      accepted: false,
      finished: false,
    };
    run.done = new Promise((resolve) => {
      run.settled = resolve;
    });
    this.runs.set(id, run);
    this.watch(run);
    try {
      const source = inspectPrefix(await services.controller.inspect(id, run.abort.signal), id);
      run.item.parentSessionId = source.parentId;
      run.item.triggerSeq = source.end.seq;
      run.parent = services.agents.get(source.parentId);
      if (!run.parent) fail("PARENT_UNAVAILABLE", "直接父会话未驻留，请先打开父会话");
      if (services.agents.get(id)) fail("CONFLICT", "子任务仍在驻留，请等待当前运行结束");
      if (run.changedParents.has(source.parentId)) fail("CONFLICT", "检查期间父会话收到新输入");
      if (run.cancelledParents.has(source.parentId)) fail("CANCELLED", "检查期间父会话已停止");
      this.reserve(run);
      this.assertCurrent(run);
      const messageId = await run.runtime[DELIVERY](
        run.parent,
        id,
        [{ type: "text", text: this.readSettings().continueText }],
        { kind: SOURCE, mode: "manual", triggerSeq: source.end.seq, continuationId: run.item.id },
        run.abort.signal,
        "queue",
      );
      if (!run.accepted || run.item.messageId !== messageId || !run.item.runId)
        fail("CONTINUATION_PARTIAL", "官方返回后未确认同一次恢复与消息接纳，未宣称继续成功");
      return {
        sessionId: id,
        submitted: true,
        messageId,
        source: {
          kind: SOURCE,
          mode: "manual",
          triggerSeq: source.end.seq,
          continuationId: run.item.id,
        },
        manualRun: this.snapshot(run),
      };
    } catch (error) {
      run.item.error = diagnostic(error);
      if (!run.accepted) this.finish(run, run.abort.signal.aborted ? "stopped" : "failed");
      error.partial = { ...error.partial, manualRun: this.snapshot(run) };
      throw error;
    }
  }

  async stop(id, { revoke = false } = {}) {
    const run = this.runs.get(id);
    if (!run || run.finished)
      return { sessionId: id, stopped: true, ownedRunCancelled: false, ownedQueuedRemoved: 0 };
    let removed = 0,
      cancelled = false;
    if (!run.accepted)
      run.abort.abort(Object.assign(new Error("继续请求已停止"), { code: "CANCELLED" }));
    else if (this.services().agents.get(id) === run.agent) {
      const agent = run.agent;
      for (const [target, key] of [
        ["next-turn", "nextTurn"],
        ["next-step", "nextStep"],
      ])
        for (let index = agent.inbox[key].length - 1; index >= 0; index--)
          if (run.ownedIds.has(agent.inbox[key][index].id)) {
            agent.inbox.splice(target, index, 1, []);
            removed++;
          }
      const events = agent.session.snapshotEvents();
      const start = events.findLast((event) => event.type === "turn/start");
      const current = events.filter(
        (event) =>
          event.seq > (start?.seq ?? -1) &&
          event.type === "user/message" &&
          event.data.source.kind !== "runtime-context",
      );
      const ownsTurn =
        current.length > 0 && current.every((event) => run.ownedIds.has(event.data.id));
      if (
        !agent.inbox.hasPending &&
        !run.foreignInput &&
        (agent.status === "idle" || ownsTurn) &&
        this.services().agents.get(run.parent.session.id) === run.parent
      ) {
        // No await between exact-instance ownership check and the host's ID-addressed drain.
        await run.runtime.drainChildren(run.parent, [id]);
        cancelled = true;
      } else if (revoke) {
        // Foreign input belongs to the host. End this module's control without cancelling that work.
        run.item.error = {
          code: "OWNERSHIP_RELEASED",
          message: "子任务已有其他输入，保留宿主执行并撤销本模块控制",
        };
        this.finish(run, "released");
      }
    }
    if (!run.accepted || cancelled) await run.done;
    return {
      sessionId: id,
      stopped: true,
      ownedRunCancelled: cancelled,
      ownedQueuedRemoved: removed,
      manualRun: this.snapshot(run),
    };
  }

  abortParent(id) {
    for (const run of this.runs.values())
      if (!run.finished && !run.accepted) {
        run.cancelledParents.add(id);
        if (run.item.parentSessionId === id)
          run.abort.abort(Object.assign(new Error("父会话已停止"), { code: "CANCELLED" }));
      }
  }

  async stopAll({ projectsOnly = false, revoke = false } = {}) {
    const results = await Promise.allSettled(
      [...this.runs.values()]
        .filter((run) => !run.finished && (!projectsOnly || run.item.slotHeld))
        .map((run) => this.stop(run.item.sessionId, { revoke })),
    );
    const failures = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "部分手动继续尚未确认停止");
  }
}
