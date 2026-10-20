import { StoreError, enumValue, fail, object, string } from "../core/validation.js";

const CUT_TYPES = new Set(["step/end", "turn/end", "session/end-seed"]);
const STOP_TIMEOUT_MS = 5000;

function service(ctx, name) {
  return ctx?.get ? ctx.get(name) : ctx?.[name];
}
function human(event) {
  return (
    event.type === "user/message" &&
    event.data?.source?.kind === "user" &&
    event.surfaceOp === "append"
  );
}
function pending(agent) {
  return (agent.inbox?.nextTurn?.length ?? 0) + (agent.inbox?.nextStep?.length ?? 0);
}

export class SessionOperationError extends StoreError {
  constructor(code, message, partial) {
    super(code, message);
    this.name = "SessionOperationError";
    if (partial) this.partial = partial;
  }
}

/** Official-service adapter. Never reads Session storage files or edits log events. */
export class DesktopSessions {
  constructor(ctx, store) {
    this.ctx = ctx;
    this.store = store;
    this.inFlight = new Set();
  }
  services() {
    return {
      controller: service(this.ctx, "sessionController"),
      registry: service(this.ctx, "workspaceRegistry"),
      agents: service(this.ctx, "agents"),
    };
  }
  capabilities() {
    const { controller, registry, agents } = this.services();
    const methods = {
      list:
        typeof controller?.list === "function" &&
        Array.isArray(registry?.archivedSessionIds) &&
        typeof this.store?.dispatch === "function",
      inspect: typeof controller?.inspect === "function",
      fork: typeof controller?.fork === "function",
      emptySession: typeof controller?.create === "function",
      archive:
        typeof registry?.archiveSession === "function" &&
        Array.isArray(registry.archivedSessionIds),
      stopObservation: typeof agents?.list === "function",
      workspaceBinding: typeof this.store?.dispatch === "function",
    };
    const required = ["inspect", "fork", "archive", "stopObservation", "workspaceBinding"];
    return {
      ...methods,
      rewind: required.every((name) => methods[name]),
      draftRestore: "client-bridge-required",
      missing: required.filter((name) => !methods[name]),
      unsupported: ["subagent-to-parent-cut", "draft-attachments", "task-state-rewrite"],
    };
  }
  async list() {
    const { controller, registry } = this.services();
    if (typeof controller?.list !== "function")
      fail("UNSUPPORTED_CAPABILITY", "Official sessionController.list is unavailable");
    if (!Array.isArray(registry?.archivedSessionIds))
      fail("UNSUPPORTED_CAPABILITY", "Official archive state is unavailable");
    if (typeof this.store?.dispatch !== "function")
      fail("UNSUPPORTED_CAPABILITY", "Workspace binding store is unavailable");
    const result = await controller.list({});
    if (!Array.isArray(result?.items))
      fail("INVALID_HOST_RESULT", "Session list service returned no item array");
    const archived = new Set(registry.archivedSessionIds);
    return result.items
      .filter((item) => !archived.has(item.sessionId))
      .map((item) => {
        const sessionId = string(item.sessionId, "host sessionId");
        const title = item.projections?.values?.title;
        const workspace = this.store.dispatch("workspaces.forSession", { sessionId }).item;
        return {
          id: sessionId,
          name: typeof title === "string" && title ? title : sessionId,
          status: item.running ? "running" : "idle",
          ...(workspace ? { workspaceId: workspace.id } : {}),
        };
      });
  }
  descendants(sessionId) {
    const agents = this.services().agents.list();
    if (!Array.isArray(agents))
      fail("INVALID_HOST_RESULT", "Agent registry did not return an array");
    const selected = new Map();
    const parents = new Set([sessionId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of agents) {
        const header = agent.session?.header;
        if (
          agent.id === sessionId ||
          (header?.origin === "subagent" && parents.has(header.parentSession))
        ) {
          if (!selected.has(agent.id)) {
            selected.set(agent.id, agent);
            parents.add(agent.id);
            changed = true;
          }
        }
      }
    }
    return [...selected.values()];
  }
  async prepare(payload = {}) {
    object(payload);
    const sessionId = string(payload.sessionId ?? payload.id, "sessionId");
    const mode = enumValue(payload.mode ?? "turn", "mode", ["turn", "step"]);
    if (payload.atSeq !== undefined && (!Number.isSafeInteger(payload.atSeq) || payload.atSeq < 0))
      fail("INVALID_INPUT", "atSeq must be a non-negative safe integer");
    const capabilities = this.capabilities();
    if (!capabilities.rewind)
      fail(
        "UNSUPPORTED_CAPABILITY",
        `Required official capabilities are unavailable: ${capabilities.missing.join(", ")}`,
      );
    const { controller, registry } = this.services();
    if (registry.archivedSessionIds.includes(sessionId))
      fail("SESSION_ARCHIVED", "The source session is already archived");
    const source = await controller.inspect(sessionId);
    if (!source?.meta || source.meta.id !== sessionId || !Array.isArray(source.events))
      fail("INVALID_HOST_RESULT", "Session inspection did not identify a complete event prefix");
    if (source.meta.origin === "subagent")
      fail(
        "UNSUPPORTED_CAPABILITY",
        "Mapping a subagent rewind to its parent cut is not supported",
      );
    const events = source.events;
    if (events.some((event, index) => event.seq !== index || typeof event.type !== "string"))
      fail("INVALID_HOST_RESULT", "Session event prefix must have contiguous sequence numbers");
    const lastHuman = events.findLast(human);
    if (!lastHuman) fail("NO_REWIND_BOUNDARY", "No human input exists to rewind");
    const turnStart = events.findLast(
      (event) => event.type === "turn/start" && event.seq < lastHuman.seq,
    );
    const turnCut = (turnStart?.seq ?? lastHuman.seq) - 1;
    let atSeq;
    if (payload.atSeq !== undefined) {
      const cut = events[payload.atSeq];
      if (!cut || !CUT_TYPES.has(cut.type))
        fail(
          "INVALID_REWIND_BOUNDARY",
          "atSeq must name an existing completed step or turn boundary",
        );
      if (payload.atSeq >= events.length - 1)
        fail("INVALID_REWIND_BOUNDARY", "The cut must remove at least one event");
      atSeq = payload.atSeq;
    } else if (mode === "step") {
      const start = events.findLast((event) => event.type === "step/start");
      const previousEnd =
        start &&
        events.findLast(
          (event) =>
            event.seq < start.seq &&
            event.seq > (turnStart?.seq ?? lastHuman.seq) &&
            event.type === "step/end",
        );
      atSeq = previousEnd?.seq ?? turnCut;
    } else atSeq = turnCut;
    const removedHuman = events.find((event) => event.seq > atSeq && human(event));
    let draft = "";
    if (removedHuman) {
      const content = removedHuman.data.content;
      if (
        !Array.isArray(content) ||
        content.some((part) => part.type !== "text" || typeof part.text !== "string")
      )
        fail(
          "UNSUPPORTED_CAPABILITY",
          "This draft bridge restores text only; attachments require a separate official restoration path",
        );
      draft = content.map((part) => part.text).join("");
    }
    const strategy = atSeq < 0 ? "empty" : "fork";
    if (strategy === "empty" && !capabilities.emptySession)
      fail(
        "UNSUPPORTED_CAPABILITY",
        "Rewinding the first input requires official sessionController.create",
      );
    for (const agent of this.descendants(sessionId)) {
      if (typeof agent.whenIdle !== "function" || typeof agent.cancel !== "function")
        fail(
          "UNSUPPORTED_CAPABILITY",
          "A target agent exposes no official cancellation or quiescence observation",
        );
    }
    const workspace = this.store.dispatch("workspaces.forSession", { sessionId }).item;
    return {
      sessionId,
      mode,
      ...(atSeq >= 0 ? { atSeq } : {}),
      strategy,
      draft,
      draftStatus: "pending-client",
      ...(workspace ? { workspaceId: workspace.id } : {}),
      ...(strategy === "empty"
        ? {
            createRequest: {
              ...(source.meta.cwd === undefined ? {} : { cwd: source.meta.cwd }),
              ...(source.meta.agentPreset === undefined
                ? {}
                : { agentPreset: source.meta.agentPreset }),
            },
          }
        : {}),
    };
  }
  async rewind(payload = {}) {
    object(payload);
    const sessionId = string(payload.sessionId ?? payload.id, "sessionId");
    if (this.inFlight.has(sessionId))
      fail("CONFLICT", "A rewind is already in progress for this session");
    if (payload.draftBridgeReady !== true)
      fail(
        "CLIENT_DRAFT_REQUIRED",
        "Confirm the official client draft bridge is available before creating a rewind session",
      );
    this.inFlight.add(sessionId);
    let progress;
    let stage = "prepare";
    try {
      const plan = await this.prepare(payload);
      const { controller, registry } = this.services();
      progress = {
        sessionId,
        strategy: plan.strategy,
        ...(plan.atSeq === undefined ? {} : { atSeq: plan.atSeq }),
        draft: plan.draft,
        draftStatus: "pending-client",
        archived: false,
        archive: { requested: false, verified: false },
        stop: { requested: false, settledIds: [], pendingIds: [] },
        ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
        binding: { inherited: false },
      };
      stage = plan.strategy === "empty" ? "create" : "fork";
      const created =
        plan.strategy === "empty"
          ? await controller.create(plan.createRequest)
          : await controller.fork({ sessionId, atSeq: plan.atSeq });
      if (
        typeof created?.sessionId !== "string" ||
        !created.sessionId ||
        created.sessionId === sessionId
      )
        fail("INVALID_HOST_RESULT", "Official creation did not return a distinct session identity");
      progress.newSessionId = created.sessionId;
      if (plan.workspaceId) {
        stage = "bind";
        const result = this.store.dispatch("workspaces.bind", {
          id: plan.workspaceId,
          sessionId: created.sessionId,
        });
        if (result?.item?.id !== plan.workspaceId)
          fail("INVALID_STORE_RESULT", "Workspace binding was not confirmed");
        progress.binding = { inherited: true, workspaceId: plan.workspaceId };
      }
      stage = "archive";
      progress.archive.requested = true;
      progress.stop.requested = true;
      await registry.archiveSession(sessionId, { stopActivity: true });
      progress.archived = registry.archivedSessionIds.includes(sessionId);
      progress.archive.verified = progress.archived;
      if (!progress.archived)
        fail("INVALID_HOST_RESULT", "Official archive state did not confirm the original session");
      stage = "stop";
      const targets = this.descendants(sessionId);
      progress.stop.pendingIds = targets.map((agent) => agent.id);
      // The official archive listener only cancels running agents. Idle agents
      // may still hold queued input, so use the public cancel path to clear it
      // (including its journal event) before observing quiescence.
      for (const agent of targets) agent.cancel({ kind: "user" });
      let timer;
      try {
        await Promise.race([
          Promise.all(targets.map((agent) => agent.whenIdle())),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Agent cancellation has not settled within five seconds")),
              STOP_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      progress.stop.settledIds = targets
        .filter((agent) => agent.status !== "running" && pending(agent) === 0)
        .map((agent) => agent.id);
      progress.stop.pendingIds = targets
        .filter((agent) => !progress.stop.settledIds.includes(agent.id))
        .map((agent) => agent.id);
      if (progress.stop.pendingIds.length)
        fail("STOP_INCOMPLETE", "Some target agents still have running or queued work");
      return progress;
    } catch (error) {
      if (!progress) throw error;
      // Official fork may report a created identity in its structured partial-failure data.
      if (
        !progress.newSessionId &&
        typeof error?.data?.sessionId === "string" &&
        error.data.sessionId !== sessionId
      )
        progress.newSessionId = error.data.sessionId;
      const registry = this.services().registry;
      if (Array.isArray(registry?.archivedSessionIds)) {
        progress.archived = registry.archivedSessionIds.includes(sessionId);
        progress.archive.verified = progress.archived;
      }
      throw new SessionOperationError(
        "REWIND_PARTIAL",
        `Rewind failed at ${stage}: ${error.message ?? String(error)}`,
        {
          ...progress,
          failedAt: stage,
          causeCode: error.code ?? "HOST_ERROR",
          outcomeUnknown: !progress.newSessionId && ["fork", "create"].includes(stage),
        },
      );
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}

export default DesktopSessions;
