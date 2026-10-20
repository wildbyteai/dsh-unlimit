const PACKAGE = "@deepseek-ai/dsh-permission-presets";
const VERSION = "0.2.1-rc.2";
// Official Cordis exports symbols.original; traceable service proxies are not stable identities.
const ORIGINAL = Symbol.for("cordis.original");

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function service(ctx, name) {
  return ctx?.get ? ctx.get(name) : ctx?.[name];
}
function sameDescriptor(left, right) {
  return (
    left?.value === right.value &&
    left.writable === right.writable &&
    left.configurable === right.configurable &&
    left.enumerable === right.enumerable
  );
}
function target(ctx, host) {
  if (host?.supported !== true || host.version !== VERSION)
    return { reason: "此宿主版本尚未通过新会话权限预设适配验收" };
  const presets = service(ctx, "permissionPresets");
  if (typeof presets?.catalog !== "function") return { reason: "缺少官方权限预设目录服务" };
  const editor = service(ctx, "configEditor");
  const registry = typeof editor?.entries === "function" ? editor : service(ctx, "loader");
  if (typeof registry?.entries !== "function")
    return { reason: "缺少官方活动配置条目的只读运行时目录" };
  const entries = [...registry.entries()].filter(
    (entry) => entry.options?.name === PACKAGE && entry.fiber?.state === 2,
  );
  if (entries.length !== 1) return { reason: "官方权限预设插件未活动或不能唯一定位" };
  const entry = entries[0],
    fiber = entry.fiber,
    container = fiber.config;
  const serviceIdentity = presets[ORIGINAL] ?? presets;
  if (serviceIdentity.ctx?.fiber !== fiber)
    return { reason: "权限目录服务与活动配置不属于同一官方插件实例" };
  const descriptor = container && Object.getOwnPropertyDescriptor(container, "defaultPreset");
  if (
    !descriptor ||
    !Object.hasOwn(descriptor, "value") ||
    typeof descriptor.value?.get !== "function" ||
    (!descriptor.configurable && !descriptor.writable)
  )
    return { reason: "官方 defaultPreset 没有可替换的动态配置引用" };
  return { presets, serviceIdentity, entry, fiber, container, descriptor };
}
function catalog(presets) {
  const result = presets.catalog();
  if (
    !Array.isArray(result?.defaultOptions) ||
    typeof result.defaultPreset !== "string" ||
    result.defaultOptions.some((item) => !item || typeof item.value !== "string" || !item.value) ||
    new Set(result.defaultOptions.map((item) => item.value)).size !== result.defaultOptions.length
  )
    throw failure("INVALID_HOST_RESULT", "官方权限默认预设目录返回值无效");
  return {
    options: result.defaultOptions.map((item) => ({ ...item })),
    effective: result.defaultPreset,
  };
}
function choice(name, options) {
  if (typeof name !== "string") throw failure("INVALID_INPUT", "permissionDefault 必须是字符串");
  if (name !== "" && !options.some((item) => item.value === name))
    throw failure("INVALID_PERMISSION_DEFAULT", "只能选择官方目录中的新会话默认权限预设");
  return name;
}

/** Runtime-only default selection. Existing session facts remain exclusively official-owned. */
export class PermissionDefaults {
  #owned = null;
  constructor(ctx, store, host) {
    this.ctx = ctx;
    this.store = store;
    this.host = host;
  }
  settings() {
    return this.store.dispatch("settings.get", {}).value;
  }
  currentTarget() {
    return target(this.ctx, this.host);
  }
  owns(current) {
    const owned = this.#owned;
    return Boolean(
      owned &&
        !current.reason &&
        current.entry === owned.entry &&
        current.fiber === owned.fiber &&
        current.container === owned.container &&
        current.serviceIdentity === owned.serviceIdentity &&
        sameDescriptor(current.descriptor, owned.installedDescriptor),
    );
  }
  status() {
    const settings = this.settings(),
      requested = settings.permissionDefault ?? "";
    const current = this.currentTarget();
    const conflict = this.#owned && !this.owns(current);
    let options = [],
      effective = null,
      detail = current.reason;
    if (!current.reason) {
      try {
        ({ options, effective } = catalog(current.presets));
        choice(requested, options);
      } catch (error) {
        return {
          available: false,
          active: false,
          requested,
          effective,
          options: options.length
            ? options
            : this.owns(current)
              ? this.#owned.options.map((item) => ({ ...item }))
              : [],
          detail: error.message,
        };
      }
    }
    if (conflict) detail = "权限默认配置已由宿主或其他插件替换；未覆盖外部修改，请还原后重新检查";
    return {
      available: !detail,
      active: !detail && this.owns(current) && settings.enabled === true && requested !== "",
      requested,
      effective,
      options,
      detail:
        detail ??
        "仅影响未来全新会话；已有、seeded或显式受限会话由官方保留。空选项、禁用或还原后跟随宿主当前动态默认值，不写profile。",
    };
  }
  capabilities() {
    const state = this.status();
    return [
      {
        id: "permissionDefault",
        label: "新会话权限默认预设",
        state: !state.available ? "unsupported" : state.active ? "active" : "available",
        detail: state.detail,
      },
    ];
  }
  changed() {
    const current = this.currentTarget();
    if (current.reason) {
      if ((this.settings().permissionDefault ?? "") !== "")
        throw failure("UNSUPPORTED_CAPABILITY", current.reason);
      return { notified: false, detail: current.reason };
    }
    if (this.#owned && !this.owns(current))
      throw failure("CONFLICT", "权限默认配置已由其他所有者改变，未发送旧目录通知");
    if (typeof current.presets.emitCatalogChanged !== "function")
      throw failure("UNSUPPORTED_CAPABILITY", "官方权限目录未提供变更通知接口");
    current.presets.emitCatalogChanged();
    // The official emitter isolates listener failures and returns no delivery acknowledgement.
    return { notified: true, deliveryConfirmed: false };
  }
  validate(name) {
    if (typeof name !== "string") throw failure("INVALID_INPUT", "permissionDefault 必须是字符串");
    if (name === "") return name;
    const current = this.currentTarget();
    if (current.reason) throw failure("UNSUPPORTED_CAPABILITY", current.reason);
    if (this.#owned && !this.owns(current))
      throw failure("CONFLICT", "权限默认配置已由其他所有者改变，未覆盖");
    return choice(name, this.#owned?.options ?? catalog(current.presets).options);
  }
  apply() {
    const requested = this.settings().permissionDefault ?? "";
    const current = this.currentTarget();
    if (this.#owned) {
      if (!this.owns(current)) throw failure("CONFLICT", "权限默认配置已由其他所有者改变，未覆盖");
      choice(requested, this.#owned.options);
      return this.status();
    }
    if (current.reason) {
      if (requested !== "") throw failure("UNSUPPORTED_CAPABILITY", current.reason);
      return this.status();
    }
    const { options } = catalog(current.presets);
    choice(requested, options);
    const original = current.descriptor.value;
    const adapter = this;
    // The configured preset table is fixed during this official plugin lifetime.
    // Capture defaultOptions before replacement: catalog() itself reads this get().
    // Preserve the volatile symbol writer so owner commits still update original.
    const replacement = Object.freeze({
      ...original,
      get() {
        if (!adapter.owns(adapter.currentTarget())) return original.get();
        const settings = adapter.settings();
        const requested = settings.permissionDefault ?? "";
        return settings.enabled === true && requested !== ""
          ? choice(requested, options)
          : original.get();
      },
    });
    const installedDescriptor = { ...current.descriptor, value: replacement };
    Object.defineProperty(current.container, "defaultPreset", installedDescriptor);
    this.#owned = { ...current, options, installedDescriptor };
    try {
      if (!this.owns(this.currentTarget()))
        throw failure("CONFLICT", "应用过程中权限配置发生变化，未覆盖新配置");
      this.changed();
      return this.status();
    } catch (error) {
      if (
        sameDescriptor(
          Object.getOwnPropertyDescriptor(current.container, "defaultPreset"),
          installedDescriptor,
        )
      )
        Object.defineProperty(current.container, "defaultPreset", current.descriptor);
      this.#owned = null;
      throw error;
    }
  }
  revert() {
    const owned = this.#owned;
    if (!owned) return;
    this.#owned = null;
    if (
      !sameDescriptor(
        Object.getOwnPropertyDescriptor(owned.container, "defaultPreset"),
        owned.installedDescriptor,
      )
    )
      throw failure("CONFLICT", "权限默认引用已被其他所有者替换，保留其修改");
    Object.defineProperty(owned.container, "defaultPreset", owned.descriptor);
    const current = this.currentTarget();
    if (
      !current.reason &&
      current.entry === owned.entry &&
      current.fiber === owned.fiber &&
      current.container === owned.container &&
      current.serviceIdentity === owned.serviceIdentity
    )
      this.changed();
  }
}
