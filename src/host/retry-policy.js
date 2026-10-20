import { fail } from "../core/validation.js";

const TRANSIENT_CODES = Object.freeze([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "TIMEOUT",
  "TRANSPORT",
]);

function service(ctx, name) {
  return ctx.get ? ctx.get(name) : ctx[name];
}

function methodOf(object) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "prepareCall");
    if (descriptor) return typeof descriptor.value === "function" ? descriptor.value : null;
  }
  return null;
}

function target(ctx) {
  const llm = service(ctx, "llm");
  if (!llm || !methodOf(llm)) return { reason: "缺少模型请求prepareCall接口" };
  // 0.2.1 internal adaptation point: the official retry plugin owns this
  // registration and its fiber removes the key on unload. No profile is read.
  const registry = service(ctx, "sessionProjections");
  const registration =
    typeof registry?.registrations?.get === "function"
      ? registry.registrations.get("llmRetry")
      : undefined;
  if (
    typeof registry?.stateOf !== "function" ||
    registration?.def?.key !== "llmRetry" ||
    registration.def.stateVersion !== 1 ||
    !(registration.refs > 0)
  ) {
    return { reason: "未检测到官方llm-retry执行器的活动llmRetry v1投影；仅有llm不能控制重试" };
  }
  const descriptor = Object.getOwnPropertyDescriptor(llm, "prepareCall");
  if (
    descriptor
      ? !Object.hasOwn(descriptor, "value") || (!descriptor.configurable && !descriptor.writable)
      : !Object.isExtensible(llm)
  ) {
    return { reason: "模型prepareCall接口不可逆替换" };
  }
  return { llm, descriptor };
}

function overridePolicy(policy, maxRetries) {
  if (!policy || !["normal", "always"].includes(policy.mode))
    fail("UNSUPPORTED", "未识别宿主提供方重试策略，拒绝伪装生效");
  const allowed = [
    "mode",
    "initialDelayMs",
    "maxDelayMs",
    "jitterRatio",
    ...(policy.mode === "normal" ? ["maxRetries", "retryableCodes"] : []),
  ];
  if (
    Object.keys(policy).some((key) => !allowed.includes(key)) ||
    !Number.isFinite(policy.initialDelayMs) ||
    policy.initialDelayMs <= 0 ||
    !Number.isFinite(policy.maxDelayMs) ||
    policy.maxDelayMs < policy.initialDelayMs ||
    policy.maxDelayMs > 2147483647 ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    fail("UNSUPPORTED", "宿主重试退避策略不兼容，未改变该请求策略");
  }
  if (
    policy.mode === "normal" &&
    (!Number.isSafeInteger(policy.maxRetries) ||
      policy.maxRetries < 0 ||
      !Array.isArray(policy.retryableCodes) ||
      policy.retryableCodes.some((code) => typeof code !== "string" || !code) ||
      new Set(policy.retryableCodes).size !== policy.retryableCodes.length)
  ) {
    fail("UNSUPPORTED", "宿主normal重试策略不兼容，未改变该请求策略");
  }
  return Object.freeze({
    mode: "normal",
    maxRetries,
    retryableCodes: Object.freeze(
      TRANSIENT_CODES.filter(
        (code) => policy.mode === "always" || policy.retryableCodes.includes(code),
      ),
    ),
    initialDelayMs: policy.initialDelayMs,
    maxDelayMs: policy.maxDelayMs,
    jitterRatio: policy.jitterRatio,
  });
}

/** Changes prepared-call policy only. The official executor owns retries and audit events. */
export class RetryPolicy {
  #registration = null;

  constructor(ctx, store) {
    this.ctx = ctx;
    this.store = store;
  }

  capabilities() {
    const candidate = target(this.ctx);
    const owned = this.#registration;
    const conflict = owned && candidate.descriptor?.value !== owned.replacement;
    const reason =
      candidate.reason ?? (conflict ? "prepareCall已由其他所有者替换，未覆盖" : undefined);
    return [
      {
        id: "retryLimit",
        label: "模型请求重试次数",
        state: reason ? "unsupported" : owned ? "active" : "available",
        detail:
          reason ??
          "可逆覆盖每请求策略；仅enabled与retryOverride同时开启时生效，保留官方退避/Retry-After和持久日志；依赖0.2.1内部llmRetry v1投影。",
      },
    ];
  }

  apply() {
    const candidate = target(this.ctx);
    const owned = this.#registration;
    if (candidate.reason) fail("UNSUPPORTED", candidate.reason);
    if (owned) {
      if (candidate.descriptor?.value !== owned.replacement)
        fail("CONFLICT", "模型请求接口已改变，未重复覆盖");
      return;
    }
    const { llm, descriptor } = candidate;
    const original = methodOf(llm);
    const adapter = this;
    const replacement = async function (...args) {
      const prepared = await original.apply(this, args);
      const settings = adapter.store.dispatch("settings.get", {}).value;
      if (!settings.enabled || !settings.retryOverride) return prepared;
      if (
        !Number.isSafeInteger(settings.retryLimit) ||
        settings.retryLimit < 0 ||
        settings.retryLimit > 20
      )
        fail("INVALID_INPUT", "retryLimit必须是0到20之间的整数");
      const current = target(adapter.ctx);
      if (current.reason || current.descriptor?.value !== replacement)
        fail("UNSUPPORTED", current.reason ?? "模型请求接口所有权已改变");
      const descriptors = prepared && Object.getOwnPropertyDescriptors(prepared);
      if (
        !descriptors?.retryPolicy ||
        !Object.hasOwn(descriptors.retryPolicy, "value") ||
        typeof prepared.stream !== "function"
      )
        fail("UNSUPPORTED", "宿主PreparedLlmCall合同不兼容");
      descriptors.retryPolicy = {
        ...descriptors.retryPolicy,
        value: overridePolicy(prepared.retryPolicy, settings.retryLimit),
      };
      return Object.freeze(Object.create(Object.getPrototypeOf(prepared), descriptors));
    };
    Object.defineProperty(
      llm,
      "prepareCall",
      descriptor
        ? { ...descriptor, value: replacement }
        : { configurable: true, writable: true, value: replacement },
    );
    this.#registration = { llm, descriptor, replacement };
  }

  revert() {
    const owned = this.#registration;
    if (!owned) return;
    this.#registration = null;
    if (Object.getOwnPropertyDescriptor(owned.llm, "prepareCall")?.value !== owned.replacement)
      fail("CONFLICT", "模型请求接口已被其他所有者替换，保留该修改");
    if (owned.descriptor) Object.defineProperty(owned.llm, "prepareCall", owned.descriptor);
    else delete owned.llm.prepareCall;
  }
}
