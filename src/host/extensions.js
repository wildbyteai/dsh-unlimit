const LOG_PACKAGE = "@deepseek-ai/dsh-session-log-deepseek";

function conflict(message) {
  return Object.assign(new Error(message), { code: "CONFLICT" });
}

// ConfigEditor.entries() is an in-memory view. configuration()/edit()/Settings
// mutations are deliberately not used: those can read or write profile files.
function logTarget(ctx) {
  const editor = ctx.get ? ctx.get("configEditor") : ctx.configEditor;
  const registry =
    typeof editor?.entries === "function" ? editor : ctx.get ? ctx.get("loader") : ctx.loader;
  if (typeof registry?.entries !== "function")
    return { reason: "缺少官方活动配置条目的只读运行时目录" };
  const entries = [...registry.entries()].filter(
    (entry) => entry.options?.name === LOG_PACKAGE && entry.fiber?.state === 2,
  );
  if (entries.length !== 1)
    return { reason: "官方会话日志插件未活动或不能唯一定位，未修改任何配置" };
  const container = entries[0].fiber.config;
  const descriptor = container && Object.getOwnPropertyDescriptor(container, "enabled");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value?.get !== "function"
  ) {
    return { reason: "活动日志配置没有可识别的enabled动态引用" };
  }
  if (!descriptor.configurable && !descriptor.writable) {
    return { reason: "日志enabled配置容器不可替换，不能在不持久化profile的条件下关闭上传" };
  }
  return { container, descriptor };
}

/** Optional 0.2.1 runtime adaptations; never edits the host or persisted profile. */
export class HostExtensions {
  #registration = null;

  constructor(ctx, store) {
    this.ctx = ctx;
    this.store = store;
  }

  capabilities() {
    const target = logTarget(this.ctx);
    const owned = this.#registration;
    const current =
      owned &&
      owned.activation.active &&
      target.container === owned.container &&
      owned.container.enabled === owned.replacement;
    if (owned && !current) owned.activation.active = false;
    const logReason =
      owned && !current
        ? "日志引用已被宿主或其他插件替换；请还原并重新检查，未覆盖新引用"
        : target.reason;
    return [
      {
        id: "hooks",
        label: "Hook处理策略",
        state: "unsupported",
        detail:
          "尚未验证Claude/Codex Hook策略配置器；宿主通用事件与拒绝结果保留，保存此开关不改变它们。",
      },
      {
        id: "memory",
        label: "第三方记忆段策略",
        state: "unsupported",
        detail:
          "尚未验证第三方记忆策略配置器；具名MCP段不等于来源证明，不按名称猜删段落或人工消息。",
      },
      {
        id: "sessionLogUpload",
        label: "关闭官方会话日志上传",
        state: logReason ? "unsupported" : current ? "active" : "available",
        detail:
          logReason ??
          "仅临时替换活动日志配置容器中的动态引用；插件启用时返回关闭，禁用及还原后使用宿主当前值，不写profile。",
      },
    ];
  }

  apply() {
    if (this.#registration) {
      const target = logTarget(this.ctx);
      if (
        !this.#registration.activation.active ||
        target.container !== this.#registration.container ||
        this.#registration.container.enabled !== this.#registration.replacement
      ) {
        this.#registration.activation.active = false;
        throw conflict("日志配置已由其他所有者改变，未覆盖");
      }
      return this.capabilities();
    }
    const target = logTarget(this.ctx);
    if (target.reason) return this.capabilities();
    const { container, descriptor } = target;
    const original = descriptor.value;
    const store = this.store;
    const activation = { active: true };
    // The reference itself is frozen in the official runtime. Preserve its
    // symbol protocol and owning runtime's update closure; replace the field,
    // not original.get(), so host volatile updates continue to reach it.
    const replacement = Object.freeze({
      ...original,
      get() {
        if (!activation.active) return original.get();
        return store.dispatch("settings.get", {}).value.enabled ? false : original.get();
      },
    });
    try {
      Object.defineProperty(container, "enabled", { ...descriptor, value: replacement });
      this.#registration = { container, descriptor, replacement, activation };
      return this.capabilities();
    } catch (error) {
      activation.active = false;
      if (container.enabled === replacement)
        Object.defineProperty(container, "enabled", descriptor);
      this.#registration = null;
      throw error;
    }
  }

  revert() {
    const owned = this.#registration;
    if (!owned) return;
    owned.activation.active = false;
    if (owned.container.enabled !== owned.replacement) {
      this.#registration = null;
      throw conflict("日志配置已被其他所有者替换，保留其修改；本插件未覆盖");
    }
    Object.defineProperty(owned.container, "enabled", owned.descriptor);
    this.#registration = null;
  }
}
