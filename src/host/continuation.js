import { resolveOfficialPackage } from "./official-package.js";
import { DEFAULT_SETTINGS, fail, object, string } from "../core/validation.js";

const SOURCE = "dsh-unlimit/continuation";
const isChild = (agent) =>
  Boolean(agent.session.header.parentSession || agent.session.header.origin === "subagent");
export const DEFAULT_CONTINUE_TEXT = DEFAULT_SETTINGS.continueText;
const service = (ctx, name) => (ctx.get ? ctx.get(name) : ctx[name]);

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

function historyState(session) {
  let automaticCount = 0;
  const messageIds = new Set(),
    usedTriggers = new Set(),
    automaticIds = new Set();
  for (const event of session.snapshotEvents())
    for (const message of messages(event)) {
      if (messageIds.has(message.id)) continue;
      messageIds.add(message.id);
      if (message.source.kind === "user") automaticCount = 0;
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
          "默认关闭，单个人工输入链最多0–20次，仅处理max-tokens；原生停止与新输入会撤回待续。",
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
      continuation.#clear(state);
      state.stopped = true;
      state.interrupted = true;
      return original.apply(this, args);
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
      this.#states.clear();
      const disposers = [];
      try {
        disposers.push(
          this.ctx.on("session/event", (session, event) => this.#event(session, event)),
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
    for (const message of messages(event)) {
      if (event.type === "user/message" && message.source.kind === "user") {
        this.#clear(state);
        state.automaticCount = 0;
        state.stopped = false;
        state.interrupted = false;
      }
      if (state.messageIds.has(message.id)) continue;
      state.messageIds.add(message.id);
      if (message.source.kind === SOURCE) {
        state.usedTriggers.add(message.source.triggerSeq);
        if (message.source.mode === "automatic") {
          state.automaticCount++;
          state.automaticIds.add(message.id);
        }
      } else if (message.source.kind !== "runtime-context") {
        this.#clear(state);
        if (message.source.kind === "user") {
          state.automaticCount = 0;
          state.stopped = false;
          state.interrupted = false;
        }
      }
    }
    if (event.type !== "turn/end" || isChild(agent)) return;
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
      state.pending !== null
    )
      return;
    state.pending = setImmediate(() => {
      state.pending = null;
      try {
        this.#submit(state, event.seq, "automatic");
      } catch (error) {
        state.lastError = { code: error.code ?? "CONTINUATION_FAILED", message: error.message };
      }
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
      fail("UNSUPPORTED", "子代理的继续需要重新获取workflow执行槽，本版仅支持根会话");
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
    const pending = state.pending !== null;
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
      pending: state.pending !== null,
      stopped: state.stopped,
      eligibleReason: end?.data.reason?.kind ?? null,
      unsupportedReason: state.interrupted
        ? "已观察到原生停止或取消，不能当作模型截断继续"
        : isChild(state.agent)
          ? "子代理须通过workflow重新获取执行槽，本版仅支持根会话"
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
    if (errors.length)
      throw new AggregateError(errors, "继续模块已尝试撤销全部监听与取消观察，部分所有权已改变");
  }
}
