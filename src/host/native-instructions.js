import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { selectedRule, usesWorkspaceInstructions } from "../core/prompts.js";
import { SUPPORTED_HOST } from "./desktop.js";

const SOURCE = "dsh-unlimit/native-instructions";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const native = (message) =>
  message?.role === "user" &&
  message.source?.kind === "agent-instructions" &&
  message.source.form === "instructions";
const replacement = (seq) => ({ op: "replace", startSeq: seq, endSeq: seq });

/**
 * Workspace policy changes the canonical Session surface, never a transport
 * copy. Built-in empty developer messages need no plugin-owned replay code.
 */
export class NativeInstructions {
  #dispose = null;
  #sessions = new Map();
  #steps = new WeakMap();

  constructor(runtime) {
    this.runtime = runtime;
  }

  supported() {
    const { ctx, host } = this.runtime;
    const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
    if (
      host.kind !== "desktop" ||
      host.version !== SUPPORTED_HOST ||
      host.supported !== true ||
      !isAbsolute(host.runtimeRoot ?? "") ||
      typeof ctx.on !== "function" ||
      typeof sessions?.list !== "function"
    )
      return "缺少已验证的桌面版本、会话目录或步骤接纳接口";
    try {
      const inventory = JSON.parse(
        readFileSync(join(host.runtimeRoot, "desktop-runtime.json"), "utf8"),
      );
      if (inventory.release?.version !== SUPPORTED_HOST)
        return "运行时发行版本与原生规则适配版本不一致";
      const require = createRequire(join(host.runtimeRoot, "package.json"));
      for (const name of [
        "@deepseek-ai/cordis",
        "@deepseek-ai/dsh-session",
        "@deepseek-ai/dsh-agent-loop",
        "@deepseek-ai/dsh-agent-instructions",
      ]) {
        const path = require.resolve(name);
        const row = inventory.files?.find((item) => item.path === relative(host.runtimeRoot, path));
        if (!row || digest(readFileSync(path)) !== row.sha256)
          return "原生规则或会话入口与发行库存摘要不一致，未接管原生规则";
      }
      return null;
    } catch {
      return "无法核验原生规则与会话入口的发行摘要";
    }
  }

  capabilities() {
    const reason =
      !this.#dispose && this.#sessions.size > 0
        ? `有${this.#sessions.size}个会话尚未确认恢复；请重新加载这些会话后再次还原`
        : this.supported();
    return [
      {
        id: "nativeInstructions",
        label: "原生工作区规则策略",
        state: reason ? "unsupported" : this.#dispose ? "active" : "available",
        detail:
          reason ??
          "按步骤处理明确来源的原生基线与刷新消息；历史以可恢复替换保留原始日志。保留策略在下一步骤生效，还原恢复仍属本插件的节点；不停止宿主发现文件。",
      },
    ];
  }

  policy(agent) {
    const config = this.runtime.settings();
    const rule = selectedRule(this.runtime.store.dispatch("rules.list", {}), agent.options?.model);
    return config.enabled && !usesWorkspaceInstructions(config, rule);
  }

  observe(agent) {
    const session = agent.session;
    if (this.#sessions.has(session)) return;
    if (typeof agent.ctx?.effect !== "function")
      throw new Error("缺少会话持久句柄关闭前的官方代理清理接口");
    // AgentLoop disposes its scope before closing its persistence handle.
    // agent/disposed is later and cannot safely commit a durable restoration.
    const entry = { restore: true };
    entry.dispose = agent.ctx.effect(() => () => {
      if (entry.restore) this.restore(session);
      this.#sessions.delete(session);
    });
    this.#sessions.set(session, entry);
  }

  surface(session) {
    if (
      typeof session?.eventAt !== "function" ||
      typeof session.append !== "function" ||
      !Array.isArray(session.surface?.nodes)
    )
      throw new Error("原生规则策略所需的会话surface接口不可用");
    return session.surface.nodes.map((seq) => session.eventAt(seq));
  }

  original(session, event) {
    const message = event?.data?.message;
    if (event?.type !== "developer/message" || message?.source?.kind !== SOURCE) return null;
    const source = message.source;
    const original = session.eventAt(source.originalSeq);
    // A later rewrite or compaction owns its new node. Never revive its hidden
    // history merely because a source reference leads back to our marker.
    if (
      source.format !== 1 ||
      !Number.isSafeInteger(source.originalSeq) ||
      source.originalSeq < 0 ||
      source.originalSeq >= event.seq ||
      message.role !== "developer" ||
      !Array.isArray(message.content) ||
      message.content.length !== 0 ||
      original?.type !== "user/message" ||
      !native(original.data) ||
      source.originalDigest !== digest(JSON.stringify(original.data)) ||
      event.surfaceOp?.op !== "replace" ||
      event.surfaceOp.startSeq !== source.originalSeq ||
      event.surfaceOp.endSeq !== source.originalSeq ||
      event.sourceEventSeqs?.length !== 1 ||
      event.sourceEventSeqs[0] !== source.originalSeq
    )
      throw Object.assign(new Error("原生规则替换记录不完整，未猜测恢复内容"), {
        code: "NATIVE_INSTRUCTIONS_CONFLICT",
      });
    return original;
  }

  restore(session) {
    const markers = this.surface(session)
      .map((event) => ({ event, original: this.original(session, event) }))
      .filter((entry) => entry.original);
    for (const { event, original } of markers) {
      session.append("user/message", original.data, {
        surfaceOp: replacement(event.seq),
        sourceEventSeqs: [event.seq, original.seq],
      });
    }
  }

  hide(session, { turn, step }) {
    const surface = this.surface(session);
    // Validate existing own markers before making any new replacements.
    for (const event of surface) this.original(session, event);
    for (const event of surface) {
      if (event.type !== "user/message" || !native(event.data)) continue;
      session.append(
        "developer/message",
        {
          turn,
          step,
          message: {
            id: randomUUID(),
            role: "developer",
            source: {
              kind: SOURCE,
              format: 1,
              originalSeq: event.seq,
              originalDigest: digest(JSON.stringify(event.data)),
            },
            content: [],
          },
        },
        { surfaceOp: replacement(event.seq), sourceEventSeqs: [event.seq] },
      );
    }
  }

  apply() {
    if (this.#dispose || this.supported()) return;
    if (this.#sessions.size > 0)
      throw new Error("原生规则仍有未确认恢复的会话，请先重新加载并还原");
    let active = true;
    const unregisterStep = this.runtime.ctx.on(
      "agent/pre-step",
      async ({ agent, turn, step, signal }, next) => {
        signal?.throwIfAborted();
        const suppress = this.policy(agent);
        const session = agent.session;
        this.observe(agent);
        // Restore before the producer observes history, so it can recognize its
        // existing baseline when the operator switches back to preservation.
        if (!suppress) this.restore(session);
        const decision = await next();
        signal?.throwIfAborted();
        if (!active || decision.kind === "reject") return decision;
        this.#steps.set(agent, { turn, step, suppress });
        if (!suppress) return decision;
        const messages = decision.messages.filter((message) => !native(message));
        return messages.length === decision.messages.length ? decision : { ...decision, messages };
      },
      { prepend: true },
    );
    try {
      const unregisterRequest = this.runtime.ctx.on(
        "agent/request",
        async ({ agent, turn, step, signal }, next) => {
          const config = await next();
          signal?.throwIfAborted();
          const prepared = this.#steps.get(agent);
          if (active && prepared?.suppress && prepared.turn === turn && prepared.step === step) {
            // A developer event must belong to an already-open step, including
            // under the physical JSONL reader. pre-step is too early. This
            // awaited callback runs before the loop journals/builds its request.
            this.hide(agent.session, { turn, step });
          }
          return config;
        },
        { prepend: true },
      );
      this.#dispose = () => {
        active = false;
        unregisterRequest();
        unregisterStep();
        this.#steps = new WeakMap();
      };
    } catch (error) {
      active = false;
      unregisterStep();
      throw error;
    }
  }

  revert() {
    if (!this.#dispose && this.#sessions.size === 0 && this.supported()) return;
    this.#dispose?.();
    this.#dispose = null;
    const ctx = this.runtime.ctx;
    const registry = typeof ctx.get === "function" ? ctx.get("sessions") : ctx.sessions;
    // Include loaded forks carrying inherited markers, even if they have not
    // entered a step through this connector yet. Persisted, unloaded sessions
    // are intentionally never opened by a controls operation.
    const loaded = typeof registry?.list === "function" ? registry.list() : [];
    const sessions = new Set(loaded);
    const errors = [];
    if (typeof registry?.list !== "function")
      errors.push(new Error("会话目录不可用，不能确认所有已加载分支的恢复状态"));
    for (const session of sessions) {
      try {
        this.restore(session);
        for (const [previous, entry] of this.#sessions) {
          if (previous.id !== session.id) continue;
          if (entry) {
            entry.restore = false;
            entry.dispose();
          }
          this.#sessions.delete(previous);
        }
      } catch (error) {
        if (!this.#sessions.has(session)) this.#sessions.set(session, null);
        errors.push(error);
      }
    }
    // Never append to a detached Session after its durable writer has closed.
    // A later loaded instance with the same id can retry from its actual log.
    for (const session of this.#sessions.keys()) {
      if (!loaded.some((current) => current.id === session.id))
        errors.push(new Error(`会话 ${session.id} 已卸载，需重新加载后确认规则恢复`));
    }
    if (errors.length)
      throw new AggregateError(errors, "部分原生规则未能恢复；保留替换记录，可再次还原");
  }
}
