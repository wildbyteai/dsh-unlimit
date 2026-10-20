import { AttachmentBatches } from "./attachment-batches.js";
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
function inspected(source, sessionId) {
  if (!source?.meta || source.meta.id !== sessionId || !Array.isArray(source.events))
    fail("INVALID_HOST_RESULT", "Session inspection did not identify a complete event prefix");
  if (source.events.some((event, index) => event.seq !== index || typeof event.type !== "string"))
    fail("INVALID_HOST_RESULT", "Session event prefix must have contiguous sequence numbers");
  return source;
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
    this.attachmentBatches = new AttachmentBatches(() => this.services());
  }
  services() {
    return {
      controller: service(this.ctx, "sessionController"),
      registry: service(this.ctx, "workspaceRegistry"),
      agents: service(this.ctx, "agents"),
      attachments: service(this.ctx, "attachments"),
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
      agentLookup: typeof agents?.get === "function",
      workspaceBinding: typeof this.store?.dispatch === "function",
    };
    const required = [
      "inspect",
      "fork",
      "archive",
      "stopObservation",
      "agentLookup",
      "workspaceBinding",
    ];
    return {
      ...methods,
      rewind: required.every((name) => methods[name]),
      draftRestore: "client-bridge-required",
      missing: required.filter((name) => !methods[name]),
      subagentRewind: "creation-origin",
      unsupported: ["subagent-latest-activation-cut", "task-state-rewrite"],
      attachmentRecovery:
        typeof this.services().attachments?.readImage === "function" &&
        typeof this.services().attachments?.readFileStream === "function",
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
  async stopAgents(targets, progress) {
    progress.requested = true;
    progress.pendingIds = targets.map((agent) => agent.id);
    for (const agent of targets) {
      if (typeof agent.cancel !== "function" || typeof agent.whenIdle !== "function")
        fail("UNSUPPORTED_CAPABILITY", "An agent has no public cancel or quiescence interface");
      agent.cancel({ kind: "user" });
    }
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
    progress.settledIds = targets
      .filter((agent) => agent.status !== "running" && pending(agent) === 0)
      .map((agent) => agent.id);
    progress.pendingIds = targets
      .filter((agent) => !progress.settledIds.includes(agent.id))
      .map((agent) => agent.id);
    if (progress.pendingIds.length)
      fail("STOP_INCOMPLETE", "Some target agents still have running or queued work");
  }
  async rewindSource(sessionId, claim) {
    const { controller, registry } = this.services();
    const inspect = async (id) => {
      if (registry.archivedSessionIds.includes(id))
        fail("SESSION_ARCHIVED", "A session in the rewind lineage is already archived");
      claim?.(id);
      return inspected(await controller.inspect(id), id);
    };
    let source = await inspect(sessionId);
    const visited = new Set([sessionId]);
    const links = [];
    let anchorSeq;
    while (source.meta.origin === "subagent") {
      const child = source;
      const parentId = child.meta.parentSession;
      if (typeof parentId !== "string" || !parentId || visited.has(parentId))
        fail("INVALID_HOST_RESULT", "The subagent has no acyclic parent session identity");
      visited.add(parentId);
      source = await inspect(parentId);
      const inherited = source.inheritedEventCount;
      const childInherited = child.inheritedEventCount;
      if (
        !Number.isSafeInteger(inherited) ||
        inherited < 0 ||
        inherited > source.events.length ||
        !Number.isSafeInteger(childInherited) ||
        childInherited < 0 ||
        childInherited > child.events.length ||
        !Number.isSafeInteger(child.meta.createdAt) ||
        child.meta.createdAt < 0
      )
        fail("INVALID_HOST_RESULT", "The subagent lineage has no canonical creation metadata");
      const catalogs = source.events.filter(
        (event) =>
          event.seq >= inherited &&
          event.type === "subagent/catalog" &&
          event.data?.childId === child.meta.id,
      );
      const catalog = catalogs[0];
      const descriptors = child.events.filter(
        (event) => event.seq >= childInherited && event.type === "subagent/descriptor",
      );
      if (
        catalogs.length !== 1 ||
        catalog.data.version !== 0 ||
        catalog.data.childCreatedAt !== child.meta.createdAt ||
        !["continuable", "one-shot"].includes(catalog.data.mode) ||
        descriptors.length !== 1 ||
        descriptors[0].data?.version !== 3 ||
        descriptors[0].data.mode !== catalog.data.mode
      )
        fail(
          "AMBIGUOUS_REWIND_SOURCE",
          "The parent has no unique own catalog event matching this subagent creation",
        );
      const turn = source.events.findLast(
        (event) => event.seq < catalog.seq && event.type === "turn/start",
      );
      const step = source.events.findLast(
        (event) => event.seq < catalog.seq && event.type === "step/start",
      );
      if (
        !turn ||
        !step ||
        step.seq < turn.seq ||
        source.events.some(
          (event) =>
            event.seq < catalog.seq &&
            ((event.type === "turn/end" && event.seq > turn.seq) ||
              (event.type === "step/end" && event.seq > step.seq)),
        )
      )
        fail(
          "NO_REWIND_BOUNDARY",
          "The subagent creation is not associated with an active parent turn and step",
        );
      if (source.meta.origin === "subagent") {
        const ownedBefore = source.events.slice(inherited, catalog.seq);
        const inputs = ownedBefore.filter(
          (event) =>
            event.type === "user/message" &&
            event.surfaceOp === "append" &&
            !["runtime-context", "agent-instructions"].includes(event.data?.source?.kind),
        );
        if (
          ownedBefore.filter((event) => event.type === "turn/start").length !== 1 ||
          inputs.length !== 1 ||
          inputs[0].data?.source?.kind !== "user"
        )
          fail(
            "AMBIGUOUS_REWIND_SOURCE",
            "A nested parent has later or unattributed input; its current work cannot be mapped to its original creation",
          );
      }
      anchorSeq = catalog.seq;
      links.push({
        childSessionId: child.meta.id,
        parentSessionId: parentId,
        catalogSeq: catalog.seq,
        childCreatedAt: child.meta.createdAt,
        turnStartSeq: turn.seq,
        stepStartSeq: step.seq,
      });
    }
    return { source, anchorSeq, links };
  }
  async prepare(payload = {}, claim) {
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
    const { source, anchorSeq, links } = await this.rewindSource(sessionId, claim);
    const targetId = source.meta.id;
    if (links.length && payload.atSeq !== undefined)
      fail(
        "INVALID_REWIND_BOUNDARY",
        "A child sequence cannot be used as an explicit parent cut; select the root session instead",
      );
    const events = source.events;
    const relevant = anchorSeq === undefined ? events : events.slice(0, anchorSeq + 1);
    const lastHuman = relevant.findLast(
      (event) => human(event) && (!links.length || event.seq > links.at(-1).turnStartSeq),
    );
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
      const start = relevant.findLast((event) => event.type === "step/start");
      const stepTurn = relevant.findLast(
        (event) => event.type === "turn/start" && event.seq < (start?.seq ?? 0),
      );
      const previousEnd =
        start &&
        relevant.findLast(
          (event) =>
            event.seq < start.seq &&
            event.seq > (stepTurn?.seq ?? lastHuman.seq) &&
            event.type === "step/end",
        );
      atSeq = previousEnd?.seq ?? turnCut;
    } else atSeq = turnCut;
    const removedHuman = events.find((event) => event.seq > atSeq && human(event));
    let draft = "";
    const content = removedHuman?.data.content ?? [];
    if (
      !Array.isArray(content) ||
      content.some((part) => !part || (part.type === "text" && typeof part.text !== "string"))
    )
      fail("INVALID_HOST_RESULT", "The human message has invalid content");
    draft = content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (
      content.some((part) => part.type !== "text") &&
      payload.draftBridgeSupports?.attachments !== true
    )
      fail(
        "CLIENT_ATTACHMENTS_REQUIRED",
        "Confirm the official client attachment restoration APIs before creating a rewind session",
      );
    const strategy = atSeq < 0 ? "empty" : "fork";
    if (strategy === "empty" && !capabilities.emptySession)
      fail(
        "UNSUPPORTED_CAPABILITY",
        "Rewinding the first input requires official sessionController.create",
      );
    for (const agent of this.descendants(targetId)) {
      if (typeof agent.whenIdle !== "function" || typeof agent.cancel !== "function")
        fail(
          "UNSUPPORTED_CAPABILITY",
          "A target agent exposes no official cancellation or quiescence observation",
        );
    }
    const workspace = this.store.dispatch("workspaces.forSession", { sessionId: targetId }).item;
    const attachmentBatch = removedHuman
      ? this.attachmentBatches.create(targetId, removedHuman, content)
      : undefined;
    return {
      sessionId: targetId,
      ...(links.length
        ? {
            mapping: {
              requestedSessionId: sessionId,
              targetSessionId: targetId,
              basis: "creation",
              links,
            },
          }
        : {}),
      mode,
      ...(atSeq >= 0 ? { atSeq } : {}),
      strategy,
      draft,
      draftStatus: "pending-client",
      ...(attachmentBatch ? { attachmentBatch } : {}),
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
    const claimed = new Set([sessionId]);
    const claim = (id) => {
      if (claimed.has(id)) return;
      if (this.inFlight.has(id))
        fail("CONFLICT", "A rewind is already in progress for this session lineage");
      this.inFlight.add(id);
      claimed.add(id);
    };
    let targetId = sessionId;
    let progress;
    let plan;
    let stage = "prepare";
    try {
      plan = await this.prepare(payload, claim);
      targetId = plan.sessionId;
      const { controller, registry } = this.services();
      progress = {
        sessionId: targetId,
        ...(plan.mapping ? { mapping: plan.mapping } : {}),
        strategy: plan.strategy,
        ...(plan.atSeq === undefined ? {} : { atSeq: plan.atSeq }),
        draft: plan.draft,
        draftStatus: "pending-client",
        ...(plan.attachmentBatch ? { attachmentBatch: plan.attachmentBatch } : {}),
        archived: false,
        archive: { requested: false, verified: false },
        stop: { requested: false, settledIds: [], pendingIds: [] },
        newSessionStop: { requested: false, settledIds: [], pendingIds: [] },
        ...(plan.workspaceId ? { workspaceId: plan.workspaceId } : {}),
        binding: { inherited: false },
      };
      stage = plan.strategy === "empty" ? "create" : "fork";
      const created =
        plan.strategy === "empty"
          ? await controller.create(plan.createRequest)
          : await controller.fork({ sessionId: targetId, atSeq: plan.atSeq });
      if (
        typeof created?.sessionId !== "string" ||
        !created.sessionId ||
        claimed.has(created.sessionId)
      )
        fail("INVALID_HOST_RESULT", "Official creation did not return a distinct session identity");
      progress.newSessionId = created.sessionId;
      // A fork prefix can retain the durable enqueue for a removed human turn.
      // Clear it through the public agent path before exposing an unsent draft.
      stage = "settle-new";
      const continuation = this.services().agents.get(created.sessionId);
      if (!continuation || continuation.id !== created.sessionId)
        fail("INVALID_HOST_RESULT", "The new session has no matching observable official agent");
      await this.stopAgents([continuation], progress.newSessionStop);
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
      await registry.archiveSession(targetId, { stopActivity: true });
      progress.archived = registry.archivedSessionIds.includes(targetId);
      progress.archive.verified = progress.archived;
      if (!progress.archived)
        fail("INVALID_HOST_RESULT", "Official archive state did not confirm the original session");
      stage = "stop";
      const targets = this.descendants(targetId);
      // The official archive listener only cancels running agents. Idle agents
      // may still hold queued input, so use the public cancel path to clear it
      // (including its journal event) before observing quiescence.
      await this.stopAgents(targets, progress.stop);
      if (plan.attachmentBatch)
        this.attachmentBatches.bind(plan.attachmentBatch.token, progress.newSessionId);
      return progress;
    } catch (error) {
      if (plan?.attachmentBatch)
        this.attachmentBatches.release({ token: plan.attachmentBatch.token });
      if (progress) delete progress.attachmentBatch;
      if (!progress) throw error;
      // Official fork may report a created identity in its structured partial-failure data.
      if (
        !progress.newSessionId &&
        typeof error?.data?.sessionId === "string" &&
        !claimed.has(error.data.sessionId)
      )
        progress.newSessionId = error.data.sessionId;
      const registry = this.services().registry;
      if (Array.isArray(registry?.archivedSessionIds)) {
        progress.archived = registry.archivedSessionIds.includes(targetId);
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
      for (const id of claimed) this.inFlight.delete(id);
    }
  }
  attachment(payload) {
    return this.attachmentBatches.read(payload);
  }
  releaseAttachments(payload) {
    return this.attachmentBatches.release(payload);
  }
  close() {
    this.attachmentBatches.close();
  }
}

export default DesktopSessions;
