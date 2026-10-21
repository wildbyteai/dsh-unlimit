import { resolveOfficialPackage } from "./official-package.js";
import { DEFAULT_SETTINGS, fail, object, string } from "../core/validation.js";

const SOURCE = "dsh-unlimit/continuation";
const CHILD_DELIVERY = Symbol.for("dsh.subagent.deliverPrompt");
const isChild = (agent) =>
  Boolean(agent.session.header.parentSession || agent.session.header.origin === "subagent");
export const DEFAULT_CONTINUE_TEXT = DEFAULT_SETTINGS.continueText;
const service = (ctx, name) => (ctx.get ? ctx.get(name) : ctx[name]);
const serviceIdentity = (value) => value?.[Symbol.for("cordis.original")] ?? value;

function methodOf(target, key) {
  for (let current = target; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : null;
  }
  return null;
}

function settings(store) {
  const value = store.dispatch("settings.get", {}).value;
  const result = {
    ...value,
    autoContinue: value.autoContinue ?? DEFAULT_SETTINGS.autoContinue,
    continueLimit: value.continueLimit ?? DEFAULT_SETTINGS.continueLimit,
    continueText: value.continueText ?? DEFAULT_CONTINUE_TEXT,
  };
  if (
    typeof result.autoContinue !== "boolean" ||
    !Number.isSafeInteger(result.continueLimit) ||
    result.continueLimit < 0 ||
    result.continueLimit > 20
  )
    fail("INVALID_INPUT", "自动继续开关及0到20次限额无效");
  string(result.continueText, "continueText");
  if (Buffer.byteLength(result.continueText) > 4096) fail("INVALID_INPUT", "继续用语超过4KiB");
  return result;
}

function messages(event) {
  if (event.type === "agent/inbox/spliced") return event.data.inserted;
  if (event.type === "user/message") return [event.data];
  return [];
}

const startsInputChain = (message, parentId) =>
  message.source.kind === "user" ||
  (parentId &&
    message.source.kind === "agent-message" &&
    message.source.senderSessionId === parentId);

function historyState(session) {
  let automaticCount = 0;
  const messageIds = new Set(),
    usedTriggers = new Set(),
    automaticIds = new Set();
  const child = Boolean(session.header.parentSession || session.header.origin === "subagent");
  for (const event of session
    .snapshotEvents()
    .slice(child ? (session.inheritedEventCount ?? 0) : 0))
    for (const message of messages(event)) {
      if (messageIds.has(message.id)) continue;
      messageIds.add(message.id);
      if (startsInputChain(message, child ? session.header.parentSession : undefined))
        automaticCount = 0;
      if (message.source.kind !== SOURCE) continue;
      usedTriggers.add(message.source.triggerSeq);
      if (message.source.mode === "automatic") {
        automaticCount++;
        automaticIds.add(message.id);
      }
    }
  return { automaticCount, messageIds, usedTriggers, automaticIds };
}

/** Bounded new-turn continuation. Request retry and human inbox ownership stay with the host. */
export class Continuation {
  #disposers = [];
  #states = new Map();
  #loading;
  #generation = 0;
  #createMessage;
  #childRuntime;
  #childActivations = new Map();

  constructor(ctx, store, host) {
    this.ctx = ctx;
    this.store = store;
    this.host = host;
  }

  #support() {
    if (this.host.supported === false) return { reason: "宿主版本未通过继续能力适配" };
    const agents = service(this.ctx, "agents");
    if (
      typeof agents?.get !== "function" ||
      typeof agents?.list !== "function" ||
      typeof this.ctx.on !== "function"
    )
      return { reason: "缺少官方活动代理目录或事件接口" };
    if (!this.host.runtimeRoot) return { reason: "未提供官方运行时，不能加载消息构造接口" };
    const resolved = resolveOfficialPackage(this.host.runtimeRoot, "@deepseek-ai/dsh-llm");
    if (!resolved.url) return { reason: `官方消息构造模块不可用：${resolved.reason}` };
    return { agents, url: resolved.url };
  }

  capabilities() {
    const reason = this.#support().reason;
    return [
      {
        id: "continuation.manual",
        label: "手动继续截断输出",
        state: reason ? "unsupported" : this.#disposers.length ? "active" : "available",
        detail:
          reason ?? "仅支持已确认max-tokens结束且空闲的会话；保留插件来源，不覆盖错误或用户停止。",
      },
      {
        id: "continuation.auto",
        label: "有限自动继续",
        state: reason ? "unsupported" : this.#disposers.length ? "active" : "available",
        detail:
          reason ??
          "默认关闭，每条输入链最多0–20次；支持根会话及启用后创建的受管本地子代理，仅处理max-tokens。",
      },
    ];
  }

  #state(agent) {
    const id = agent.session.id;
    let state = this.#states.get(id);
    if (!state) {
      state = {
        agent,
        ...historyState(agent.session),
        pending: null,
        childPending: null,
        childTrigger: null,
        stopped: false,
        interrupted: false,
        lastError: null,
        cancel: null,
      };
      this.#states.set(id, state);
    }
    return state;
  }

  #clear(state) {
    if (state.pending !== null) clearImmediate(state.pending);
    state.pending = null;
    state.childPending?.controller.abort();
    state.childPending = null;
    state.childTrigger = null;
  }

  #interruptState(state) {
    const interrupted = state.interrupted;
    this.#clear(state);
    state.stopped = true;
    state.interrupted = true;
    if (interrupted) return;
    const errors = [];
    for (const activation of this.#childActivations.values())
      if (activation.parent === state.agent) {
        const child = this.#states.get(activation.agent.session.id);
        if (child) {
          try {
            if (service(this.ctx, "agents")?.get(child.agent.session.id) === child.agent)
              this.stop({ sessionId: child.agent.session.id });
          } catch (error) {
            errors.push(error);
          }
          try {
            this.#interruptState(child);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    if (errors.length)
      throw new AggregateError(errors, "已尝试停止子代理自动继续，部分取消接口所有权发生冲突");
  }

  #attach(agent) {
    const state = this.#state(agent);
    if (state.cancel) return;
    const descriptor = Object.getOwnPropertyDescriptor(agent, "cancel");
    const original = methodOf(agent, "cancel");
    if (
      !original ||
      typeof agent.followup !== "function" ||
      typeof agent.session.snapshotEvents !== "function" ||
      !agent.inbox ||
      typeof agent.inbox.splice !== "function" ||
      !Array.isArray(agent.inbox.nextTurn) ||
      !Array.isArray(agent.inbox.nextStep) ||
      (descriptor
        ? !Object.hasOwn(descriptor, "value") || (!descriptor.configurable && !descriptor.writable)
        : !Object.isExtensible(agent))
    )
      fail("UNSUPPORTED", "该代理不支持可撤销取消观察及正式followup提交");
    const continuation = this;
    const wrapper = function (...args) {
      const errors = [];
      let result;
      try {
        continuation.#interruptState(state);
      } catch (error) {
        errors.push(error);
      }
      // Descendant cleanup must never suppress the host's native cancellation.
      try {
        result = original.apply(this, args);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "自动继续清理与原生取消均发生错误");
      return result;
    };
    Object.defineProperty(
      agent,
      "cancel",
      descriptor
        ? { ...descriptor, value: wrapper }
        : { configurable: true, writable: true, value: wrapper },
    );
    state.cancel = { descriptor, wrapper };
  }

  #detach(state) {
    this.#clear(state);
    if (!state.cancel) return;
    const { descriptor, wrapper } = state.cancel;
    state.cancel = null;
    if (Object.getOwnPropertyDescriptor(state.agent, "cancel")?.value !== wrapper)
      fail("CONFLICT", "代理cancel已被其他所有者替换，保留其修改");
    if (descriptor) Object.defineProperty(state.agent, "cancel", descriptor);
    else delete state.agent.cancel;
  }

  async apply() {
    if (this.#disposers.length) return;
    if (this.#loading) return this.#loading;
    const support = this.#support();
    if (support.reason) fail("UNSUPPORTED", support.reason);
    const generation = this.#generation;
    const loading = (async () => {
      const { createUserMessage } = await import(support.url);
      if (typeof createUserMessage !== "function") fail("UNSUPPORTED", "官方消息构造接口不兼容");
      if (generation !== this.#generation) fail("CANCELLED", "继续模块加载已撤销");
      this.#createMessage = createUserMessage;
      const childRuntime = service(this.ctx, "subagents");
      this.#childRuntime =
        typeof childRuntime?.[CHILD_DELIVERY] === "function" &&
        resolveOfficialPackage(this.host.runtimeRoot, "@deepseek-ai/dsh-subagent").url
          ? childRuntime
          : undefined;
      this.#states.clear();
      const disposers = [];
      try {
        disposers.push(
          this.ctx.on("session/event", (session, event) => this.#event(session, event)),
        );
        disposers.push(
          this.ctx.on("agent/status", ({ agent, status }) => {
            if (status !== "idle") return;
            const state = this.#states.get(agent.session.id);
            if (state?.agent !== agent || state.childTrigger === null) return;
            const end = this.#end(agent);
            if (end?.seq !== state.childTrigger || end.data.reason.kind !== "max-tokens") {
              this.#clear(state);
              return;
            }
            this.#continueChild(state, end, settings(this.store));
          }),
        );
        disposers.push(
          this.ctx.on("subagent/start", (event) => {
            if (!this.#childRuntime || !event.local) return;
            const agent = support.agents.get(event.id);
            const parent = agent && support.agents.get(agent.session.header.parentSession);
            if (agent && parent)
              this.#childActivations.set(event.id, { runId: event.runId, agent, parent });
          }),
          this.ctx.on("subagent/end", (event) => {
            if (this.#childActivations.get(event.id)?.runId !== event.runId) return;
            const state = this.#states.get(event.id);
            if (state) this.#clear(state);
            this.#childActivations.delete(event.id);
          }),
        );
        disposers.push(
          this.ctx.on("agent/created", ({ agent }) => {
            try {
              this.#attach(agent);
            } catch (error) {
              this.#state(agent).lastError = {
                code: error.code ?? "UNSUPPORTED",
                message: error.message,
              };
            }
          }),
        );
        disposers.push(
          this.ctx.on("agent/disposed", ({ agent }) => {
            const state = this.#states.get(agent.session.id);
            if (state) {
              this.#interruptState(state);
              this.#detach(state);
              this.#states.delete(agent.session.id);
            }
          }),
        );
        for (const agent of support.agents.list()) this.#attach(agent);
        this.#disposers = disposers;
      } catch (error) {
        const errors = [error];
        for (const dispose of disposers.reverse())
          try {
            dispose();
          } catch (failure) {
            errors.push(failure);
          }
        for (const state of this.#states.values())
          try {
            this.#detach(state);
          } catch (failure) {
            errors.push(failure);
          }
        this.#states.clear();
        this.#createMessage = undefined;
        this.#childRuntime = undefined;
        this.#childActivations.clear();
        if (errors.length > 1)
          throw new AggregateError(errors, "继续模块半安装失败，已尝试完整撤销");
        throw error;
      }
    })();
    this.#loading = loading;
    try {
      await loading;
    } finally {
      if (this.#loading === loading) this.#loading = undefined;
    }
  }

  #event(session, event) {
    const agent = service(this.ctx, "agents")?.get(session.id);
    if (!agent) return;
    const state = this.#state(agent);
    const child = isChild(agent);
    for (const message of messages(event)) {
      if (
        event.type === "user/message" &&
        startsInputChain(message, agent.session.header.parentSession)
      ) {
        this.#clear(state);
        state.automaticCount = 0;
        state.stopped = false;
        state.interrupted = false;
      }
      if (state.messageIds.has(message.id)) continue;
      state.messageIds.add(message.id);
      if (message.source.kind === SOURCE) {
        if (state.childPending?.triggerSeq === message.source.triggerSeq) state.childPending = null;
        state.usedTriggers.add(message.source.triggerSeq);
        if (message.source.mode === "automatic") {
          state.automaticCount++;
          state.automaticIds.add(message.id);
        }
      } else if (message.source.kind !== "runtime-context") {
        this.#clear(state);
        if (startsInputChain(message, agent.session.header.parentSession)) {
          state.automaticCount = 0;
          state.stopped = false;
          state.interrupted = false;
        }
      }
    }
    if (event.type !== "turn/end") return;
    if (event.data.reason?.kind !== "max-tokens") {
      this.#clear(state);
      return;
    }
    const value = settings(this.store);
    if (
      !value.enabled ||
      !value.autoContinue ||
      state.stopped ||
      state.automaticCount >= value.continueLimit ||
      state.usedTriggers.has(event.seq) ||
      state.pending !== null ||
      state.childPending !== null
    )
      return;
    if (child) {
      state.childTrigger = event.seq;
      if (agent.status === "idle") this.#continueChild(state, event, value);
      return;
    }
    state.pending = setImmediate(() => {
      state.pending = null;
      try {
        this.#submit(state, event.seq, "automatic");
      } catch (error) {
        state.lastError = { code: error.code ?? "CONTINUATION_FAILED", message: error.message };
      }
    });
  }

  #childActivation(state) {
    const activation = this.#childActivations.get(state.agent.session.id);
    const agents = service(this.ctx, "agents");
    return this.#childRuntime &&
      serviceIdentity(service(this.ctx, "subagents")) === serviceIdentity(this.#childRuntime) &&
      activation?.agent === state.agent &&
      agents?.get(state.agent.session.id) === state.agent &&
      agents.get(activation.parent.session.id) === activation.parent
      ? activation
      : null;
  }

  #continueChild(state, event, value) {
    state.childTrigger = null;
    const activation = this.#childActivation(state);
    if (
      !activation ||
      !value.enabled ||
      !value.autoContinue ||
      state.stopped ||
      state.automaticCount >= value.continueLimit ||
      state.usedTriggers.has(event.seq) ||
      state.childPending !== null ||
      !state.cancel ||
      state.interrupted ||
      Object.getOwnPropertyDescriptor(state.agent, "cancel")?.value !== state.cancel.wrapper ||
      state.agent.inbox.hasPending
    )
      return;
    const pending = { triggerSeq: event.seq, controller: new AbortController() };
    state.childPending = pending;
    // Idle status is emitted before whenIdle resolves. Queue here so delivery
    // wakes the idle driver before settlement, retaining its receipt and slot.
    // turn/end itself is too early: asynchronous admission can miss its queue check.
    let delivery;
    try {
      delivery = this.#childRuntime[CHILD_DELIVERY](
        activation.parent,
        state.agent.session.id,
        [{ type: "text", text: value.continueText }],
        { kind: SOURCE, mode: "automatic", triggerSeq: event.seq },
        pending.controller.signal,
        "queue",
      );
    } catch (error) {
      delivery = Promise.reject(error);
    }
    Promise.resolve(delivery)
      .then((messageId) => {
        if (!state.messageIds.has(messageId))
          fail(
            "CONTINUATION_PARTIAL",
            "官方子代理返回接纳结果，但未观察到对应消息；未宣称继续成功",
          );
        state.lastError = null;
      })
      .catch((error) => {
        if (!pending.controller.signal.aborted)
          state.lastError = { code: error.code ?? "CONTINUATION_FAILED", message: error.message };
      })
      .finally(() => {
        if (state.childPending === pending) state.childPending = null;
      });
  }

  #agent(payload) {
    object(payload);
    string(payload.sessionId, "sessionId");
    if (Object.keys(payload).some((key) => key !== "sessionId"))
      fail("INVALID_INPUT", "继续操作不接受任意消息或执行参数");
    const agent = service(this.ctx, "agents")?.get(payload.sessionId);
    if (!agent) fail("NOT_FOUND", "活动会话不存在");
    return agent;
  }

  #end(agent) {
    return agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
  }

  #submit(state, triggerSeq, mode) {
    if (isChild(state.agent))
      fail("UNSUPPORTED", "子代理目前仅支持当前受管运行中的自动继续；手动恢复尚未接入");
    if (!this.#disposers.length || !state.cancel || !this.#createMessage)
      fail("UNSUPPORTED", "继续模块未就绪或该代理不支持安全提交");
    const value = settings(this.store),
      agent = state.agent;
    if (state.interrupted) fail("UNSUPPORTED", "已观察到原生停止或取消，不能当作模型截断继续");
    if (!value.enabled) fail("DISABLED", "插件已禁用，未提交继续请求");
    if (Object.getOwnPropertyDescriptor(agent, "cancel")?.value !== state.cancel.wrapper)
      fail("CONFLICT", "代理取消接口所有权改变，未自动继续");
    if (
      mode === "automatic" &&
      (!value.autoContinue || state.stopped || state.automaticCount >= value.continueLimit)
    )
      fail("DISABLED", "自动继续已关闭、停止或达到次数上限");
    const end = this.#end(agent);
    if (end?.seq !== triggerSeq || end.data.reason?.kind !== "max-tokens")
      fail("UNSUPPORTED", "只支持最新明确max-tokens截断，其他错误或停止不能用新轮次覆盖");
    if (state.usedTriggers.has(triggerSeq)) fail("CONFLICT", "该截断已经提交过继续请求");
    if (agent.status !== "idle" || agent.inbox.hasPending)
      fail("CONFLICT", "会话正在运行或已有输入，未追加继续请求");
    const message = this.#createMessage({
      source: { kind: SOURCE, mode, triggerSeq },
      content: [{ type: "text", text: value.continueText }],
    });
    this.#clear(state);
    agent.followup(message);
    const accepted = agent.session
      .snapshotEvents()
      .some((event) => messages(event).some((item) => item.id === message.id));
    if (!accepted)
      fail("CONTINUATION_PARTIAL", "已调用followup但未确认官方队列提交；未宣称继续已提交");
    if (!state.messageIds.has(message.id)) {
      state.messageIds.add(message.id);
      state.usedTriggers.add(triggerSeq);
      if (mode === "automatic") {
        state.automaticCount++;
        state.automaticIds.add(message.id);
      }
    }
    state.lastError = null;
    return {
      sessionId: agent.session.id,
      submitted: true,
      messageId: message.id,
      source: message.source,
      automaticCount: state.automaticCount,
    };
  }

  continue(payload) {
    const agent = this.#agent(payload),
      state = this.#state(agent);
    const end = this.#end(agent);
    if (!end) fail("UNSUPPORTED", "会话没有可确认的截断结束记录");
    return this.#submit(state, end.seq, "manual");
  }

  #ownsRunning(state) {
    const agent = state.agent;
    if (agent.status !== "running" || agent.inbox.hasPending) return false;
    const events = agent.session.snapshotEvents();
    const start = events.findLast((event) => event.type === "turn/start");
    if (!start || events.some((event) => event.seq > start.seq && event.type === "turn/end"))
      return false;
    const inputs = events
      .filter(
        (event) =>
          event.seq > start.seq &&
          event.type === "user/message" &&
          event.data.source.kind !== "runtime-context",
      )
      .map((event) => event.data);
    return (
      inputs.length > 0 &&
      inputs.every(
        (message) =>
          state.automaticIds.has(message.id) &&
          message.source.kind === SOURCE &&
          message.source.mode === "automatic",
      )
    );
  }

  stop(payload) {
    const state = this.#state(this.#agent(payload));
    const pending =
      state.pending !== null || state.childPending !== null || state.childTrigger !== null;
    this.#clear(state);
    state.stopped = true;
    if (!this.#disposers.length || !state.cancel)
      return {
        sessionId: state.agent.session.id,
        stopped: true,
        pendingCancelled: pending,
        ownedQueuedRemoved: 0,
        ownedRunCancelled: false,
      };
    let ownedQueuedRemoved = 0;
    for (const [target, key] of [
      ["next-turn", "nextTurn"],
      ["next-step", "nextStep"],
    ]) {
      const queued = state.agent.inbox[key];
      for (let index = queued.length - 1; index >= 0; index--) {
        const message = queued[index];
        if (
          state.automaticIds.has(message.id) &&
          message.source.kind === SOURCE &&
          message.source.mode === "automatic"
        ) {
          state.agent.inbox.splice(target, index, 1, []);
          ownedQueuedRemoved++;
        }
      }
    }
    const ownedRunning = this.#ownsRunning(state);
    if (ownedRunning) {
      if (Object.getOwnPropertyDescriptor(state.agent, "cancel")?.value !== state.cancel?.wrapper)
        fail("CONFLICT", "所属自动运行的取消接口已改变，未覆盖该修改");
      state.agent.cancel({ kind: "user" });
    }
    return {
      sessionId: state.agent.session.id,
      stopped: true,
      pendingCancelled: pending,
      ownedQueuedRemoved,
      ownedRunCancelled: ownedRunning,
    };
  }

  // Synchronous: root may await it after settings.save. It starts no model call.
  changed() {
    const value = settings(this.store);
    if (!value.enabled || !value.autoContinue)
      for (const state of this.#states.values()) this.stop({ sessionId: state.agent.session.id });
    else
      for (const state of this.#states.values())
        if (state.automaticCount >= value.continueLimit) this.#clear(state);
  }

  status(payload) {
    const state = this.#state(this.#agent(payload)),
      end = this.#end(state.agent),
      value = settings(this.store);
    return {
      sessionId: state.agent.session.id,
      automaticCount: state.automaticCount,
      limit: value.continueLimit,
      autoEnabled: Boolean(value.enabled && value.autoContinue),
      pending: state.pending !== null || state.childPending !== null || state.childTrigger !== null,
      childAutomaticAvailable: Boolean(this.#childActivation(state)),
      stopped: state.stopped,
      eligibleReason: end?.data.reason?.kind ?? null,
      unsupportedReason: state.interrupted
        ? "已观察到原生停止或取消，不能当作模型截断继续"
        : isChild(state.agent)
          ? "子代理目前仅支持当前受管运行中的自动继续；手动恢复尚未接入"
          : !state.cancel
            ? "该代理没有可撤销取消观察接口"
            : null,
      manualAvailable: Boolean(
        !state.interrupted &&
          !isChild(state.agent) &&
          this.#disposers.length &&
          state.cancel &&
          Object.getOwnPropertyDescriptor(state.agent, "cancel")?.value === state.cancel.wrapper &&
          value.enabled &&
          end?.data.reason?.kind === "max-tokens" &&
          !state.usedTriggers.has(end.seq) &&
          state.agent.status === "idle" &&
          !state.agent.inbox.hasPending,
      ),
      lastError: state.lastError,
    };
  }

  revert() {
    this.#generation++;
    const errors = [];
    for (const state of this.#states.values()) {
      try {
        this.stop({ sessionId: state.agent.session.id });
      } catch (error) {
        errors.push(error);
      }
    }
    for (const dispose of this.#disposers.splice(0).reverse())
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    for (const state of this.#states.values())
      try {
        this.#detach(state);
      } catch (error) {
        errors.push(error);
      }
    this.#states.clear();
    this.#createMessage = undefined;
    this.#childRuntime = undefined;
    this.#childActivations.clear();
    if (errors.length)
      throw new AggregateError(errors, "继续模块已尝试撤销全部监听与取消观察，部分所有权已改变");
  }
}
