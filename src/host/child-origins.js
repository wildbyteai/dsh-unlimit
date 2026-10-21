import { resolveOfficialPackage } from "./official-package.js";

export const CHILD_INPUT_RECORD = "plugin:dsh-unlimit/child-input";

const service = (ctx, name) => (ctx.get ? ctx.get(name) : ctx[name]);
const identity = (value) => typeof value === "string" && value.length > 0;
const timestamp = (value) => Number.isSafeInteger(value) && value >= 0;

function ownHistory(session) {
  if (typeof session?.snapshotEvents !== "function") return;
  const events = session.snapshotEvents();
  const inherited = session.inheritedEventCount;
  if (
    !Array.isArray(events) ||
    !Number.isSafeInteger(inherited) ||
    inherited < 0 ||
    inherited > events.length ||
    events.some((event, index) => event.seq !== index || typeof event.type !== "string")
  )
    return;
  return events.slice(inherited);
}

function targetOf(call) {
  try {
    return JSON.parse(call.data.arguments)?.agent_id;
  } catch {
    return undefined;
  }
}

function matchingInput(events, messageId, parentId) {
  let inserted = 0;
  let consumed = 0;
  for (const event of events) {
    const messages =
      event.type === "agent/inbox/spliced"
        ? event.data.inserted
        : event.type === "user/message"
          ? [event.data]
          : [];
    if (!Array.isArray(messages)) return false;
    for (const message of messages) {
      if (message.id !== messageId) continue;
      const source = message.source;
      if (
        source?.kind !== "agent-message" ||
        source.form !== "relay" ||
        source.senderSessionId !== parentId
      )
        return false;
      if (event.type === "user/message") consumed++;
      else inserted++;
    }
  }
  // Admission and model consumption retain one identity in two event forms.
  return inserted <= 1 && consumed <= 1 && inserted + consumed > 0;
}

function callBoundary(events, call, atSeq = call.seq) {
  const before = events.filter((event) => event.seq < atSeq);
  const turn = before.findLast((event) => event.type === "turn/start");
  const step = before.findLast((event) => event.type === "step/start");
  if (
    !turn ||
    !step ||
    !Number.isSafeInteger(call.data.turn) ||
    call.data.turn < 1 ||
    !Number.isSafeInteger(call.data.step) ||
    call.data.step < 1 ||
    step.seq < turn.seq ||
    call.data.turn !== turn.data.turn ||
    call.data.turn !== step.data.turn ||
    call.data.step !== step.data.step ||
    before.some(
      (event) =>
        (event.type === "turn/end" && event.seq > turn.seq) ||
        (event.type === "step/end" && event.seq > step.seq),
    )
  )
    return;
  return { turnStartSeq: turn.seq, stepStartSeq: step.seq };
}

/** Record exact future tool deliveries without changing tool results or model context. */
export class ChildOrigins {
  #appendRecord;
  #dispose;
  #connecting;
  #generation = 0;
  #reason;

  constructor(ctx, host, enabled) {
    this.ctx = ctx;
    this.host = host;
    this.enabled = enabled;
  }

  status() {
    return {
      state: this.#reason
        ? "unsupported"
        : this.#dispose && this.enabled()
          ? "active"
          : "available",
      ...(this.#reason ? { reason: this.#reason } : {}),
    };
  }

  async connect() {
    if (this.#dispose) return this.status();
    if (this.#connecting) return this.#connecting;
    const generation = ++this.#generation;
    this.#connecting = this.#connect(generation).finally(() => {
      if (generation === this.#generation) this.#connecting = undefined;
    });
    return this.#connecting;
  }

  async #connect(generation) {
    const resolved = resolveOfficialPackage(this.host.runtimeRoot, "@deepseek-ai/dsh-session");
    const agents = service(this.ctx, "agents");
    let reason = resolved.reason;
    if (!reason && this.host.supported === false) reason = "此宿主版本未通过子代理来源适配";
    if (!reason && (typeof agents?.get !== "function" || typeof this.ctx.on !== "function"))
      reason = "缺少官方活动代理目录或工具结果事件接口";
    let appendRecord;
    if (!reason) {
      try {
        appendRecord = (await import(resolved.url)).appendPluginRecord;
        if (typeof appendRecord !== "function") reason = "官方会话模块缺少 appendPluginRecord";
      } catch (error) {
        reason = `官方子代理来源记录接口不可用：${error.message}`;
      }
    }
    if (generation !== this.#generation) return this.status();
    this.#reason = reason;
    if (reason) return this.status();
    this.#appendRecord = appendRecord;
    try {
      this.#dispose = this.ctx.on("tools/result", (exec, result) => this.#record(exec, result));
    } catch (error) {
      this.#reason = `官方工具结果观察器不可用：${error.message}`;
    }
    return this.status();
  }

  #record(exec, result) {
    if (
      !this.enabled() ||
      exec.name !== "send_message" ||
      exec.parent !== undefined ||
      result.isError !== false ||
      !identity(exec.callId) ||
      !identity(exec.arguments?.agent_id) ||
      !identity(result.value?.messageId)
    )
      return;
    const agents = service(this.ctx, "agents");
    const parent = exec.agent;
    if (!parent || !identity(parent.id) || agents.get(parent.id) !== parent) return;
    const child = agents.get(exec.arguments.agent_id);
    if (!child || child === parent || child.id !== exec.arguments.agent_id) return;
    const parentHeader = parent.session?.header;
    const childHeader = child.session?.header;
    if (
      parent.session?.id !== parent.id ||
      parentHeader?.id !== parent.id ||
      !timestamp(parentHeader.createdAt) ||
      child.session?.id !== child.id ||
      childHeader?.id !== child.id ||
      childHeader.origin !== "subagent" ||
      childHeader.parentSession !== parent.id ||
      !timestamp(childHeader.createdAt)
    )
      return;
    const parentEvents = ownHistory(parent.session);
    const childEvents = ownHistory(child.session);
    if (!parentEvents || !childEvents) return;
    const messageId = result.value.messageId;
    if (!matchingInput(childEvents, messageId, parent.id)) return;
    const calls = parentEvents.filter(
      (event) => event.type === "tool/call" && event.data.callId === exec.callId,
    );
    if (calls.length !== 1 || calls[0].data.name !== exec.name || targetOf(calls[0]) !== child.id)
      return;
    const boundary = callBoundary(parentEvents, calls[0]);
    const observedBoundary = callBoundary(parentEvents, calls[0], parentEvents.at(-1).seq + 1);
    if (
      !boundary ||
      !observedBoundary ||
      boundary.turnStartSeq !== observedBoundary.turnStartSeq ||
      boundary.stepStartSeq !== observedBoundary.stepStartSeq
    )
      return;
    if (
      parentEvents.some(
        (event) =>
          event.type === CHILD_INPUT_RECORD &&
          (event.data?.messageId === messageId || event.data?.callId === exec.callId),
      )
    )
      return;
    // The official observer contains and reports append failures. Do not turn
    // a failed commit into a successful-looking capture or alter the tool result.
    this.#appendRecord(parent.session, CHILD_INPUT_RECORD, {
      version: 1,
      parentSessionId: parent.id,
      parentCreatedAt: parentHeader.createdAt,
      childSessionId: child.id,
      childCreatedAt: childHeader.createdAt,
      messageId,
      callId: exec.callId,
      callSeq: calls[0].seq,
      ...boundary,
    });
  }

  close() {
    this.#generation++;
    this.#connecting = undefined;
    const dispose = this.#dispose;
    this.#dispose = undefined;
    dispose?.();
  }
}
