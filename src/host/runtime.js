import {
  composePrompt,
  selectedInstructions,
  selectedRule,
  usesWorkspaceInstructions,
} from "../core/prompts.js";
import { connectPromptRecovery, connectPromptRefresh } from "./prompt-refresh.js";
import { PermissionDefaults } from "./permission-defaults.js";
import { NativeInstructions } from "./native-instructions.js";
import { TerminalOwnership } from "./terminal-ownership.js";

function replace(target, key, create) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const original = target[key];
  if (typeof original !== "function") throw new Error(`宿主缺少接口 ${key}`);
  const replacement = create(original);
  Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement });
  return () => {
    if (Object.getOwnPropertyDescriptor(target, key)?.value !== replacement)
      throw new Error(`接口 ${key} 已被其他插件改动，未覆盖该改动`);
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else delete target[key];
  };
}

function replaceReference(config, key, read) {
  const descriptor = Object.getOwnPropertyDescriptor(config, key);
  const original = config[key];
  const replacement = Object.freeze({ ...original, get: () => read(original) });
  Object.defineProperty(config, key, { ...descriptor, value: replacement });
  return () => {
    if (Object.getOwnPropertyDescriptor(config, key)?.value !== replacement)
      throw new Error(`配置 ${key} 已被其他插件改动`);
    Object.defineProperty(config, key, descriptor);
  };
}

// 0.2.1-rc.2 omits `complete` from rendered sections. Read the same scoped
// registration snapshot as assemble; never mutate definitions or registry maps.
function completeSectionNames(systemPrompt, scope) {
  if (typeof systemPrompt.layers?.merge !== "function") return new Set();
  const definitions = systemPrompt.layers.merge(scope, (layer) => layer.sections);
  return new Set(
    [...definitions].filter(([, definition]) => definition.complete === true).map(([name]) => name),
  );
}

export class DesktopRuntime {
  #undo = [];
  #activation = null;
  constructor(ctx, store, host) {
    this.ctx = ctx;
    this.store = store;
    this.host = host;
    this.permissionDefaults = new PermissionDefaults(ctx, store, host);
    this.nativeInstructions = new NativeInstructions(this);
    this.terminalOwnership = new TerminalOwnership(this);
    if (
      host.supported &&
      host.runtimeRoot &&
      typeof ctx.on === "function" &&
      typeof ctx.effect === "function"
    ) {
      ctx.effect(() => connectPromptRecovery(ctx, this));
    }
  }
  settings() {
    return this.store.dispatch("settings.get", {}).value;
  }
  service(name) {
    return this.ctx.get ? this.ctx.get(name) : this.ctx[name];
  }
  get enabled() {
    return this.#undo.length > 0;
  }
  terminalStatus() {
    const agents = this.service("agents");
    const presets = this.service("agentPresets");
    if (
      !this.host.supported ||
      typeof agents?.list !== "function" ||
      typeof presets?.serviceFor !== "function"
    )
      return { available: false, detail: "当前没有经过适配的活动会话与终端目录，未执行检查。" };
    try {
      const owners = agents.list();
      if (!Array.isArray(owners)) throw new Error("活动会话目录返回值无效");
      const terminals = [],
        pendingOwners = [];
      for (const owner of owners) {
        if (typeof owner?.id !== "string") throw new Error("活动会话缺少身份");
        const registry = presets.serviceFor(owner, "terminals");
        if (registry === undefined) continue;
        if (typeof registry.list !== "function" || typeof registry.hasOwnerActivity !== "function")
          throw new Error("终端目录缺少只读清单或活动状态接口");
        const snapshots = registry.list(owner);
        if (!Array.isArray(snapshots)) throw new Error("终端目录返回值无效");
        for (const snapshot of snapshots) {
          if (
            typeof snapshot.sessionId !== "string" ||
            !["running", "exited"].includes(snapshot.status?.kind)
          )
            throw new Error("终端快照缺少会话身份或运行状态");
          terminals.push({
            agentId: owner.id,
            terminalId: snapshot.sessionId,
            state: snapshot.status.kind,
            startupMode: this.terminalOwnership.owns(registry, owner, snapshot.sessionId)
              ? "danger-full-access"
              : "unknown",
            elevatedByPlugin: this.terminalOwnership.owns(registry, owner, snapshot.sessionId)
              ? true
              : "unknown",
          });
        }
        if (snapshots.length === 0 && registry.hasOwnerActivity(owner))
          pendingOwners.push(owner.id);
      }
      return {
        available: true,
        scannedAgents: owners.length,
        terminals,
        pendingOwners,
        detail:
          "仅检查当前活动会话，不读取输出或历史。仅标记本次加载后由本插件实际升权创建的终端；未记录的来源保持未知。本检查不会关闭终端。",
      };
    } catch (error) {
      return { available: false, detail: `终端检查失败：${error.message}` };
    }
  }
  capabilities() {
    this.permissionDefaults.ctx = this.ctx;
    const candidates = [
      ["prompt", "系统提示词替换", typeof this.service("systemPrompt")?.assemble === "function"],
      [
        "promptRetry",
        "重试时刷新系统提示词",
        Boolean(this.host.runtimeRoot && typeof this.ctx.on === "function"),
      ],
      ["approval", "审批自动放行", typeof this.service("approval")?.decide === "function"],
      [
        "sandbox",
        "文件与命令完整访问",
        typeof this.service("sandboxPolicy")?.resolve === "function",
      ],
      [
        "subagents",
        "子代理数量与深度",
        typeof this.service("subagents")?.config?.maxDepth?.get === "function",
      ],
    ];
    return [
      ...candidates.map(([id, label, present]) => ({
        id,
        label,
        state:
          !this.host.supported || !present ? "unsupported" : this.enabled ? "active" : "available",
        detail: !this.host.supported
          ? "此宿主版本尚未通过适配验收"
          : present
            ? id === "sandbox"
              ? "还原会关闭本次加载后由本插件升权创建的持久终端并等待退出；未记录来源或用户显式授权的终端不关闭。"
              : "运行时适配；还原后恢复宿主接口"
            : "当前组合未提供所需接口",
      })),
      ...this.permissionDefaults.capabilities(),
      ...this.nativeInstructions.capabilities(),
    ];
  }
  apply() {
    if (this.terminalOwnership.closing) throw new Error("正在关闭升权终端，请等待还原完成");
    if (this.enabled) return;
    if (!this.host.supported) throw new Error("此宿主版本未通过适配检查，拒绝应用");
    const required = this.capabilities().filter(
      (cap) => ["prompt", "approval", "sandbox"].includes(cap.id) && cap.state === "unsupported",
    );
    if (required.length)
      throw new Error(`缺少核心能力：${required.map((cap) => cap.label).join("、")}`);
    const runtime = this;
    const pending = [];
    let terminalTrackingStarted = false;
    const activation = {};
    this.#activation = activation;
    try {
      this.terminalOwnership.apply();
      terminalTrackingStarted = true;
      this.permissionDefaults.apply();
      pending.push(() => this.permissionDefaults.revert());
      pending.push(
        replace(
          this.service("systemPrompt"),
          "assemble",
          (original) =>
            async function (...args) {
              if (runtime.#activation !== activation) return original.apply(this, args);
              const config = runtime.settings();
              const context = args[0] ?? {};
              const completeNames =
                config.enabled && config.promptMode === "replace"
                  ? completeSectionNames(this, context.scope)
                  : new Set();
              const output = await original.apply(this, args);
              if (runtime.#activation !== activation || !config.enabled) return output;
              const library = runtime.store.dispatch("rules.list", {});
              const model = context.model ?? context.agent?.options?.model;
              const rule = selectedRule(library, model);
              const directory = context.agent?.session?.header?.cwd;
              const usesWorkspace = usesWorkspaceInstructions(config, rule);
              const workspaceText = usesWorkspace
                ? selectedInstructions(directory, config.workspaceFiles)
                : "";
              const composed = composePrompt(output, config, {
                rule,
                workspaceText,
                completeSectionNames: completeNames,
              });
              const sessionId = context.agent?.session?.id;
              const role = sessionId ? runtime.rolePrompt?.(sessionId) : null;
              return role
                ? {
                    ...composed,
                    sections: [
                      ...composed.sections,
                      { name: "dsh-unlimit/role", text: role, interpolate: false },
                    ],
                  }
                : composed;
            },
        ),
      );
      pending.push(
        replace(
          this.service("approval"),
          "decide",
          (original) =>
            async function (request, ...args) {
              if (runtime.#activation !== activation) return original.call(this, request, ...args);
              const config = runtime.settings();
              const session = args[0] ?? request.agent?.session;
              const explicit = session && this.overrideOf?.(session);
              if (config.enabled && config.autoApprove && explicit === undefined)
                return request.signal?.aborted ? "cancelled" : "allowed-once";
              return original.call(this, request, ...args);
            },
        ),
      );
      pending.push(
        replace(
          this.service("sandboxPolicy"),
          "resolve",
          (original) =>
            function (...args) {
              const resolved = original.apply(this, args);
              if (runtime.#activation !== activation) return resolved;
              const config = runtime.settings();
              const request = args[0] ?? {};
              const explicit =
                request.mode ?? (request.session && this.overrideOf?.(request.session));
              if (
                config.enabled &&
                config.fullAccess &&
                explicit === undefined &&
                runtime.terminalOwnership.allowsElevation()
              ) {
                if (resolved.mode !== "danger-full-access")
                  runtime.terminalOwnership.elevated(request.session);
                return { ...resolved, mode: "danger-full-access" };
              }
              return resolved;
            },
        ),
      );
      if (this.host.runtimeRoot && typeof this.ctx.on === "function") {
        pending.push(connectPromptRefresh(this.ctx, this));
      }
      this.nativeInstructions.apply();
      pending.push(() => this.nativeInstructions.revert());
      const subagents = this.service("subagents")?.config;
      for (const [field, setting] of [
        ["maxDepth", "maxDepth"],
        ["maxActiveSubagents", "maxSubagents"],
      ]) {
        if (typeof subagents?.[field]?.get !== "function") continue;
        pending.push(
          replaceReference(subagents, field, (original) => {
            if (runtime.#activation !== activation) return original.get();
            const config = runtime.settings();
            return config.enabled ? config[setting] : original.get();
          }),
        );
      }
      this.#undo = pending;
    } catch (error) {
      this.#activation = null;
      const cleanup = [];
      if (terminalTrackingStarted) {
        try {
          this.terminalOwnership.revert();
        } catch (failure) {
          cleanup.push(failure);
        }
      }
      for (const undo of pending.reverse()) {
        try {
          undo();
        } catch (failure) {
          cleanup.push(failure);
        }
      }
      if (cleanup.length)
        throw new AggregateError([error, ...cleanup], "运行控制应用失败，部分接口撤销未完成");
      throw error;
    }
  }
  revert() {
    this.#activation = null;
    // A failed durable restoration remains retryable after other wrappers have
    // already been released by a previous revert attempt.
    const errors = [];
    if (this.#undo.length === 0) {
      try {
        this.nativeInstructions.revert();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const undo of this.#undo.reverse()) {
      try {
        undo();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#undo = [];
    let closing;
    try {
      closing = this.terminalOwnership.revert();
    } catch (error) {
      errors.push(error);
    }
    if (closing)
      return closing.then(
        () => {
          if (errors.length)
            throw new AggregateError(errors, "部分接口已被其他插件变更，请检查状态");
        },
        (error) => {
          throw new AggregateError([...errors, error], "运行控制撤销未完成");
        },
      );
    if (errors.length) throw new AggregateError(errors, "部分接口已被其他插件变更，请检查状态");
  }
}
