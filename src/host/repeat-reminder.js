import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { StoreError, fail } from "../core/validation.js";
import { SUPPORTED_HOST } from "./desktop.js";

const PACKAGE = "@deepseek-ai/dsh-repeat-tool-reminder";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (value) => structuredClone(value);
const diagnostic = (error) => ({
  code: error?.code ?? "HOST_ERROR",
  message: String(error?.message ?? error),
});
function cancelled(signal) {
  if (signal?.aborted) fail("ABORTED", "重复提醒配置操作已取消");
}

/** Reconfigures only the official advisory plugin through its ordinary noSave lifecycle. */
export class RepeatReminder {
  #owned = null;
  #queue = Promise.resolve();
  #pending = false;
  constructor(ctx, store, host) {
    this.ctx = ctx;
    this.store = store;
    this.host = host;
  }
  service(name) {
    return typeof this.ctx.get === "function" ? this.ctx.get(name) : this.ctx[name];
  }
  mode() {
    const mode = this.store.dispatch("settings.get", {}).value.repeatReminder ?? "host";
    if (!["host", "off"].includes(mode)) fail("INVALID_INPUT", "repeatReminder必须为host或off");
    return mode;
  }
  target(active = true) {
    if (
      this.host?.kind !== "desktop" ||
      this.host.version !== SUPPORTED_HOST ||
      this.host.supported !== true ||
      !isAbsolute(this.host.runtimeRoot ?? "")
    )
      return { reason: "当前桌面版本或可信运行时根未通过适配门" };
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.host.runtimeRoot, "desktop-runtime.json"), "utf8"),
      );
      if (manifest.release?.version !== SUPPORTED_HOST)
        return { reason: "运行时发行版本与适配版本不一致" };
      const require = createRequire(join(this.host.runtimeRoot, "package.json"));
      let filename;
      for (const name of [
        PACKAGE,
        "@deepseek-ai/cordis",
        "@deepseek-ai/cordis-plugin-loader",
        ...(this.service("hmr") ? ["@deepseek-ai/dsh-hmr"] : []),
      ]) {
        const path = require.resolve(name);
        const row = manifest.files?.find(
          (item) => item.path === relative(this.host.runtimeRoot, path),
        );
        if (!row || digest(readFileSync(path)) !== row.sha256)
          return { reason: "重复提醒或配置生命周期入口与发行库存摘要不一致，未修改配置" };
        if (name === PACKAGE) filename = path;
      }
      const loader = this.service("loader");
      if (typeof loader?.entries !== "function" || typeof this.ctx.on !== "function")
        return { reason: "缺少官方运行时条目目录或配置生命周期观察接口" };
      const entries = [...loader.entries()].filter(
        (entry) =>
          entry.options?.name === PACKAGE &&
          (entry.fiber?.state === 2 || (!active && entry === this.#owned?.entry)),
      );
      if (entries.length !== 1 || (active && entries[0].fiber?.state !== 2))
        return { reason: "官方重复提醒条目未唯一活动，未修改配置" };
      const entry = entries[0],
        fiber = entry.fiber;
      if (
        typeof fiber?.update !== "function" ||
        typeof fiber.await !== "function" ||
        typeof entry.moduleNamespace?.apply !== "function" ||
        fiber.runtime?.callback !== entry.moduleNamespace.apply
      )
        return { reason: "官方重复提醒条目缺少可识别的noSave生命周期或模块身份" };
      const config = fiber.config;
      if (
        !config ||
        !Array.isArray(config.thresholds) ||
        !Array.isArray(config.include) ||
        !Array.isArray(config.exclude) ||
        !Number.isInteger(config.argumentsPreviewChars)
      )
        return { reason: "重复提醒活动配置格式无法识别" };
      return { entry, fiber, filename };
    } catch {
      return { reason: "无法安全核验官方重复提醒配置目录与发行摘要" };
    }
  }
  owns(target) {
    const owned = this.#owned;
    return (
      owned &&
      target.entry === owned.entry &&
      target.fiber === owned.fiber &&
      target.fiber.config === owned.config &&
      equal(target.fiber.config, owned.expected) &&
      target.entry.options.config === owned.raw &&
      equal(target.entry.options.config, owned.rawSnapshot)
    );
  }
  capabilities() {
    const target = this.target();
    let requested;
    try {
      requested = this.mode();
    } catch {
      requested = "invalid";
    }
    const conflict = this.#owned && !this.owns(target);
    return [
      {
        id: "repeatReminder",
        label: "重复调用提醒",
        advisoryOnly: true,
        requested,
        effective: this.#owned && !conflict ? "off" : "host",
        state:
          target.reason || conflict || requested === "invalid"
            ? "unsupported"
            : this.#pending
              ? "applying"
              : this.#owned
                ? "active"
                : "available",
        owned: Boolean(this.#owned),
        detail: conflict
          ? "活动配置已由其他所有者改变；未覆盖其配置，请处理冲突"
          : (target.reason ??
            "仅控制官方重复调用建议提醒；不解除工具拒绝或审批。应用/恢复会重挂载并重置提醒计数，不删除历史消息。"),
        ...(conflict ? { code: "CONFLICT" } : {}),
      },
    ];
  }
  serial(work) {
    const task = this.#queue.then(async () => {
      const hmr = this.service("hmr");
      if (hmr && typeof hmr.runExclusive !== "function")
        fail("UNSUPPORTED_CAPABILITY", "HMR缺少官方配置串行接口");
      // Do not invoke an unverified host service before the read-only version/digest gate.
      return hmr && !this.target(false).reason ? hmr.runExclusive(work) : work();
    });
    this.#queue = task.catch(() => {});
    return task;
  }
  async moduleIdentity(target) {
    const namespace = await import(pathToFileURL(target.filename).href);
    if (
      namespace.apply !== target.entry.moduleNamespace.apply ||
      namespace.apply !== target.fiber.runtime.callback
    )
      fail("UNSUPPORTED_CAPABILITY", "活动重复提醒回调不属于已校验的官方入口");
  }
  async update(target, next) {
    let observed = false,
      completion;
    const observesUpdate = target.fiber.state === 2;
    // A transparent observer captures the real update waterfall Promise, since
    // Fiber.update itself returns void. It never changes config/noSave/decisions.
    const dispose = this.ctx.on(
      "internal/update",
      function (config, noSave, nextStep) {
        if (this !== target.fiber) return nextStep();
        observed = true;
        try {
          const result = nextStep();
          completion = Promise.resolve(result);
          completion.catch(() => {});
          return result;
        } catch (error) {
          completion = Promise.reject(error);
          completion.catch(() => {});
          throw error;
        }
      },
      { global: true, prepend: true },
    );
    try {
      target.fiber.update(next, true);
      if (observesUpdate && !observed)
        fail("UNSUPPORTED_CAPABILITY", "配置生命周期未经过透明观察器，未确认应用");
      if (observed) await completion;
      await target.fiber.await();
      if (
        target.entry.fiber !== target.fiber ||
        target.fiber.state !== 2 ||
        !equal(target.fiber.config, next)
      )
        fail("CONFIG_NOT_APPLIED", "宿主配置更新被拒绝、替换或未稳定生效");
    } finally {
      dispose();
    }
  }
  apply({ signal } = {}) {
    return this.serial(async () => {
      cancelled(signal);
      if (this.mode() === "host") {
        await this.restore();
        return this.capabilities();
      }
      const target = this.target();
      if (this.#owned) {
        if (!this.owns(target)) fail("CONFLICT", "重复提醒配置已由其他所有者改变，未覆盖");
        return this.capabilities();
      }
      if (target.reason) fail("UNSUPPORTED_CAPABILITY", target.reason);
      await this.moduleIdentity(target);
      cancelled(signal);
      if (
        this.target().entry !== target.entry ||
        target.entry.fiber !== target.fiber ||
        target.fiber.state !== 2
      )
        fail("CONFLICT", "核验期间官方配置条目已变化");
      const original = plain(target.fiber.config);
      const before = target.fiber.config;
      const raw = target.entry.options.config;
      const rawSnapshot = plain(raw);
      const next = { ...plain(original), exclude: [...new Set([...original.exclude, "*"])] };
      this.#pending = true;
      try {
        await this.update(target, next);
        this.#owned = {
          ...target,
          original,
          config: target.fiber.config,
          expected: plain(next),
          raw,
          rawSnapshot,
        };
        cancelled(signal);
        this.#pending = false;
        return this.capabilities();
      } catch (error) {
        let restored = target.fiber.config === before;
        let rollbackError;
        if (
          !restored &&
          target.entry.fiber === target.fiber &&
          equal(target.fiber.config, next) &&
          target.entry.options.config === raw &&
          equal(raw, rawSnapshot)
        ) {
          this.#owned ??= {
            ...target,
            original,
            config: target.fiber.config,
            expected: plain(next),
            raw,
            rawSnapshot,
          };
          try {
            await this.restore();
            restored = true;
          } catch (failure) {
            rollbackError = diagnostic(failure);
          }
        }
        const failure = new StoreError(error.code ?? "REPEAT_APPLY_FAILED", error.message);
        failure.partial = {
          restored,
          owned: Boolean(this.#owned),
          ...(rollbackError ? { rollbackError } : {}),
        };
        throw failure;
      } finally {
        this.#pending = false;
      }
    });
  }
  async restore() {
    if (!this.#owned) return;
    const owned = this.#owned;
    const target = this.target(false);
    if (target.reason || !this.owns(target))
      fail("CONFLICT", "重复提醒配置或条目已由其他所有者改变，保留其修改");
    await this.moduleIdentity(target);
    try {
      await this.update(target, plain(owned.original));
      if (
        target.entry.options.config !== owned.raw ||
        !equal(target.entry.options.config, owned.rawSnapshot)
      )
        fail("CONFLICT", "恢复期间条目持久配置已改变");
      this.#owned = null;
    } catch (error) {
      if (target.entry.fiber === owned.fiber && equal(target.fiber.config, owned.original)) {
        owned.config = target.fiber.config;
        owned.expected = plain(owned.original);
      }
      throw error;
    }
  }
  revert() {
    return this.serial(async () => {
      await this.restore();
      return this.capabilities();
    });
  }
  changed(options) {
    return this.apply(options);
  }
}

export default RepeatReminder;
