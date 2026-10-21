import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { StoreError, fail } from "../core/validation.js";
import { SUPPORTED_HOST } from "./desktop.js";

const PACKAGE = "@deepseek-ai/dsh-tool-fs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (value) => structuredClone(value);
const diagnostic = (error) => ({
  code: error?.code ?? "HOST_ERROR",
  message: String(error?.message ?? error),
});
function cancelled(signal) {
  if (signal?.aborted) fail("ABORTED", "读取上限配置操作已取消");
}

/** Reconfigures only official read window caps through the ordinary noSave lifecycle. */
export class ReadLimits {
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
  limit() {
    const value = this.store.dispatch("settings.get", {}).value.readLimit ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 1))
      fail("INVALID_INPUT", "readLimit必须为非负安全整数字节数，且加一仍为安全整数");
    return value;
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
          return { reason: "读取上限或配置生命周期入口与发行库存摘要不一致，未修改配置" };
        if (name === PACKAGE) filename = path;
      }
      const loader = this.service("loader");
      if (typeof loader?.entries !== "function" || typeof this.ctx.on !== "function")
        return { reason: "缺少官方运行时条目目录或配置生命周期观察接口" };
      const candidates = new Set(loader.entries());
      // Retained preset trees are deliberately detached from the Host Loader.
      // Cordis still catalogs their real fibers and Loader-owned Entry links.
      if (typeof this.ctx.registry?.values === "function")
        for (const runtime of this.ctx.registry.values())
          for (const fiber of runtime.fibers) {
            const entry = fiber.entry;
            if (
              entry?.options?.name === PACKAGE &&
              entry.fiber === fiber &&
              fiber.runtime === runtime &&
              runtime.callback === entry.moduleNamespace?.apply
            )
              candidates.add(entry);
          }
      const entries = [...candidates].filter(
        (entry) =>
          entry.options?.name === PACKAGE &&
          (entry.fiber?.state === 2 || (!active && entry === this.#owned?.entry)),
      );
      if (entries.length !== 1 || (active && entries[0].fiber?.state !== 2))
        return { reason: "官方读取上限条目未唯一活动，未修改配置" };
      const entry = entries[0],
        fiber = entry.fiber;
      if (
        typeof fiber?.update !== "function" ||
        typeof fiber.await !== "function" ||
        typeof entry.moduleNamespace?.apply !== "function" ||
        fiber.runtime?.callback !== entry.moduleNamespace.apply
      )
        return { reason: "官方读取上限条目缺少可识别的noSave生命周期或模块身份" };
      const config = fiber.config;
      if (
        !config ||
        config.read !== true ||
        !["readLimit", "readMaxBytes", "readMaxLineLength", "readStreamMinSize"].every(
          (key) => Number.isSafeInteger(config[key]) && config[key] > 0,
        )
      )
        return { reason: "官方read工具未启用或活动cap格式无法识别" };
      return { entry, fiber, filename };
    } catch {
      return { reason: "无法安全核验官方读取上限配置目录与发行摘要" };
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
  ownershipConflict(message) {
    const error = new StoreError("CONFLICT", message);
    error.partial = { restored: false, owned: Boolean(this.#owned) };
    throw error;
  }
  capabilities() {
    const target = this.target();
    let requested;
    try {
      requested = this.limit();
    } catch {
      requested = "invalid";
    }
    const conflict = Boolean(this.#owned && !this.owns(target));
    const trusted = !target.reason && !conflict && requested !== "invalid";
    return [
      {
        id: "readLimit",
        label: "文件读取字节预算",
        requested,
        effective: trusted ? (this.#owned ? this.#owned.expected.readMaxBytes : "host") : null,
        effectiveCaps: trusted
          ? Object.fromEntries(
              ["readMaxBytes", "readLimit", "readMaxLineLength", "readStreamMinSize"].map((key) => [
                key,
                target.fiber.config[key],
              ]),
            )
          : null,
        state: this.#pending
          ? "applying"
          : !trusted
            ? "unsupported"
            : this.#owned
              ? "active"
              : "available",
        owned: Boolean(this.#owned),
        detail: conflict
          ? "活动配置所有权冲突；保留外部修改，未覆盖"
          : (target.reason ??
            "仅调整官方read的静态正文窗口；0沿用宿主。行号、封装、页尾不计预算，不限制实际I/O或其他工具。重挂载期间工具短暂不可用，在途调用沿用原cap。"),
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
      fail("UNSUPPORTED_CAPABILITY", "活动读取上限回调不属于已校验的官方入口");
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
      const limit = this.limit();
      if (limit === 0) {
        await this.restore();
        return this.capabilities();
      }
      const target = this.target();
      if (this.#owned && !this.owns(target))
        this.ownershipConflict("读取配置已由其他所有者改变，未覆盖");
      if (target.reason) fail("UNSUPPORTED_CAPABILITY", target.reason);
      if (this.#owned?.expected.readMaxBytes === limit) return this.capabilities();
      const before = target.fiber.config;
      const beforeSnapshot = plain(before);
      const previous = this.#owned;
      const original = previous?.original ?? plain(before);
      const raw = target.entry.options.config;
      const rawSnapshot = plain(raw);
      await this.moduleIdentity(target);
      cancelled(signal);
      if (
        this.target().entry !== target.entry ||
        target.entry.fiber !== target.fiber ||
        target.fiber.state !== 2 ||
        target.fiber.config !== before ||
        !equal(before, beforeSnapshot) ||
        target.entry.options.config !== raw ||
        !equal(raw, rawSnapshot)
      )
        fail("CONFLICT", "核验期间官方读取配置已变化");
      // A B-byte body has at most B+1 empty lines, and UTF-16 length never exceeds
      // UTF-8 byte length. These are finite upper bounds, not zero/unlimited caps.
      const next = {
        ...plain(before),
        readMaxBytes: limit,
        readLimit: limit + 1,
        readMaxLineLength: limit,
      };
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
        if (target.entry.options.config !== raw || !equal(raw, rawSnapshot))
          fail("CONFLICT", "noSave更新期间持久配置改变，未覆盖外部修改");
        cancelled(signal);
        this.#pending = false;
        return this.capabilities();
      } catch (error) {
        let restored = target.fiber.config === before && equal(before, beforeSnapshot);
        let rollbackError;
        if (
          !restored &&
          target.entry.fiber === target.fiber &&
          equal(target.fiber.config, next) &&
          target.entry.options.config === raw &&
          equal(raw, rawSnapshot)
        ) {
          this.#owned = {
            ...target,
            original,
            config: target.fiber.config,
            expected: plain(next),
            raw,
            rawSnapshot,
          };
          try {
            await this.update(target, beforeSnapshot);
            if (target.entry.options.config !== raw || !equal(raw, rawSnapshot))
              fail("CONFLICT", "回滚期间持久配置改变");
            this.#owned = previous
              ? { ...previous, config: target.fiber.config, expected: plain(beforeSnapshot) }
              : null;
            restored = true;
          } catch (failure) {
            rollbackError = diagnostic(failure);
          }
        }
        const failure = new StoreError(error.code ?? "READ_LIMIT_APPLY_FAILED", error.message);
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
      this.ownershipConflict("读取上限配置或条目已由其他所有者改变，保留其修改");
    await this.moduleIdentity(target);
    const current = this.target(false);
    if (current.reason || !this.owns(current))
      this.ownershipConflict("恢复核验期间读取配置所有权已改变，保留外部修改");
    this.#pending = true;
    try {
      await this.update(current, plain(owned.original));
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
      const failure = new StoreError(error.code ?? "READ_LIMIT_RESTORE_FAILED", error.message);
      failure.partial = {
        restored:
          target.entry.fiber === owned.fiber &&
          target.fiber.state === 2 &&
          equal(target.fiber.config, owned.original) &&
          target.entry.options.config === owned.raw &&
          equal(target.entry.options.config, owned.rawSnapshot),
        owned: true,
      };
      throw failure;
    } finally {
      this.#pending = false;
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

export default ReadLimits;
