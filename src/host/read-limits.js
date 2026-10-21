import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { StoreError, fail } from "../core/validation.js";
import { SUPPORTED_HOST } from "./desktop.js";

const PACKAGE = "@deepseek-ai/dsh-tool-fs";
const CAPS = ["readMaxBytes", "readLimit", "readMaxLineLength", "readStreamMinSize"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (value) => structuredClone(value);
const caps = (config) => Object.fromEntries(CAPS.map((key) => [key, config[key]]));
const diagnostic = (error) => ({
  code: error?.code ?? "HOST_ERROR",
  message: String(error?.message ?? error),
});
function cancelled(signal) {
  if (signal?.aborted) fail("ABORTED", "读取上限配置操作已取消");
}

/** Reconfigures official read windows, with independent ownership for every real Entry. */
export class ReadLimits {
  #owned = new Map();
  #ids = new WeakMap();
  #nextId = 0;
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
  id(entry) {
    if (!this.#ids.has(entry)) this.#ids.set(entry, `read-target-${++this.#nextId}`);
    return this.#ids.get(entry);
  }
  limit() {
    const value = this.store.dispatch("settings.get", {}).value.readLimit ?? 0;
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + 1))
      fail("INVALID_INPUT", "readLimit必须为非负安全整数字节数，且加一仍为安全整数");
    return value;
  }
  catalog(active = true) {
    if (
      this.host?.kind !== "desktop" ||
      this.host.version !== SUPPORTED_HOST ||
      this.host.supported !== true ||
      !isAbsolute(this.host.runtimeRoot ?? "")
    )
      return { targets: [], reason: "当前桌面版本或可信运行时根未通过适配门" };
    try {
      const manifest = JSON.parse(
        readFileSync(join(this.host.runtimeRoot, "desktop-runtime.json"), "utf8"),
      );
      if (manifest.release?.version !== SUPPORTED_HOST)
        return { targets: [], reason: "运行时发行版本与适配版本不一致" };
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
          return {
            targets: [],
            reason: "读取上限或配置生命周期入口与发行库存摘要不一致，未修改配置",
          };
        if (name === PACKAGE) filename = path;
      }
      const loader = this.service("loader");
      if (typeof loader?.entries !== "function" || typeof this.ctx.on !== "function")
        return { targets: [], reason: "缺少官方运行时条目目录或配置生命周期观察接口" };
      const candidates = new Set(loader.entries());
      // Retained preset revisions are detached from the root Loader. Use only
      // real Entry/Fiber/Runtime links from the public Cordis registry.
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
      const targets = [];
      for (const entry of candidates) {
        if (entry.options?.name !== PACKAGE) continue;
        const fiber = entry.fiber;
        if (fiber?.state !== 2 && (active || !this.#owned.has(entry))) continue;
        if (fiber?.config?.read === false && !this.#owned.has(entry)) continue;
        const target = { entry, fiber, filename, apply: entry.moduleNamespace?.apply };
        if (
          fiber?.entry !== entry ||
          typeof fiber?.update !== "function" ||
          typeof fiber.await !== "function" ||
          typeof target.apply !== "function" ||
          fiber.runtime?.callback !== target.apply
        )
          target.reason = "官方读取上限条目缺少可识别的noSave生命周期或模块身份";
        else if (
          fiber.config?.read !== true ||
          !CAPS.every((key) => Number.isSafeInteger(fiber.config[key]) && fiber.config[key] > 0)
        )
          target.reason = "官方read工具未启用或活动cap格式无法识别";
        targets.push(target);
      }
      return { targets, filename };
    } catch {
      return { targets: [], reason: "无法安全核验官方读取上限配置目录与发行摘要" };
    }
  }
  // Preserve the existing inspection shape when exactly one target exists.
  target(active = true) {
    const result = this.catalog(active);
    return {
      ...result,
      ...(result.targets.length === 1 ? result.targets[0] : {}),
      ...(result.reason
        ? {}
        : result.targets.length === 0
          ? { reason: "未发现已启用且活动的官方read条目" }
          : result.targets.find((item) => item.reason)),
    };
  }
  owns(target) {
    const owned = target && this.#owned.get(target.entry);
    return Boolean(
      owned &&
        target.fiber === owned.fiber &&
        target.apply === owned.apply &&
        target.fiber.config === owned.config &&
        equal(target.fiber.config, owned.expected) &&
        target.entry.options.config === owned.raw &&
        equal(target.entry.options.config, owned.rawSnapshot),
    );
  }
  capabilities() {
    const catalog = this.catalog(false);
    let requested;
    try {
      requested = this.limit();
    } catch {
      requested = "invalid";
    }
    const active = catalog.targets.filter(
      (target) => target.fiber?.state === 2 && target.fiber.config?.read === true,
    );
    const current = new Map(catalog.targets.map((target) => [target.entry, target]));
    const conflicts = [...this.#owned].filter(([entry]) => {
      const target = current.get(entry);
      return !target || target.reason || target.fiber.state !== 2 || !this.owns(target);
    });
    const invalid = active.find((target) => target.reason);
    const trusted =
      !catalog.reason &&
      !invalid &&
      active.length > 0 &&
      !conflicts.length &&
      requested !== "invalid";
    const appliedTargetCount = active.filter(
      (target) =>
        !target.reason && this.owns(target) && target.fiber.config.readMaxBytes === requested,
    ).length;
    const complete =
      trusted &&
      requested > 0 &&
      appliedTargetCount === active.length &&
      this.#owned.size === active.length;
    const coverage = conflicts.length
      ? "conflict"
      : !trusted
        ? "unavailable"
        : complete
          ? "complete"
          : requested === 0 && !this.#owned.size
            ? "host"
            : this.#owned.size
              ? "partial"
              : "pending";
    const targets = catalog.targets.map((target) => ({
      id: this.id(target.entry),
      state:
        target.reason || (this.#owned.has(target.entry) && !this.owns(target))
          ? "conflict"
          : target.fiber.state !== 2
            ? "inactive"
            : this.owns(target) && target.fiber.config.readMaxBytes === requested
              ? "active"
              : requested === 0 && !this.#owned.has(target.entry)
                ? "host"
                : "pending",
      owned: this.#owned.has(target.entry),
      effectiveCaps:
        !catalog.reason &&
        !target.reason &&
        target.fiber.state === 2 &&
        (!this.#owned.has(target.entry) || this.owns(target))
          ? caps(target.fiber.config)
          : null,
    }));
    for (const [entry] of this.#owned)
      if (!current.has(entry))
        targets.push({ id: this.id(entry), state: "missing", owned: true, effectiveCaps: null });
    const allCaps =
      trusted && !this.#pending && (complete || !this.#owned.size)
        ? active.map((target) => caps(target.fiber.config))
        : [];
    const effectiveCaps =
      allCaps.length && allCaps.every((value) => equal(value, allCaps[0])) ? allCaps[0] : null;
    const scopeDetail =
      "仅调整官方read的静态正文窗口；0沿用宿主。行号、封装、页尾不计预算，不限制实际I/O或其他工具。重挂载期间工具短暂不可用，在途调用沿用原cap。";
    return [
      {
        id: "readLimit",
        label: "文件读取字节预算",
        requested,
        effective:
          this.#pending || !trusted
            ? null
            : complete
              ? requested
              : !this.#owned.size
                ? "host"
                : null,
        effectiveCaps,
        state: this.#pending
          ? "applying"
          : !trusted
            ? "unsupported"
            : complete
              ? "active"
              : "available",
        owned: Boolean(this.#owned.size),
        targetCount: active.length,
        appliedTargetCount,
        ownedTargetCount: this.#owned.size,
        coverage,
        targets,
        detail: conflicts.length
          ? "读取目标已退出活动目录或配置所有权冲突；保留外部修改和独立恢复责任，未全局生效"
          : (catalog.reason ??
            invalid?.reason ??
            (active.length ? null : "未发现已启用且活动的官方read条目") ??
            `${coverage === "pending" || coverage === "partial" ? `当前预算已应用于${appliedTargetCount}/${active.length}个目标；需重新应用以覆盖全部当前目标。` : ""}${scopeDetail}`),
        ...(conflicts.length ? { code: "CONFLICT" } : {}),
      },
    ];
  }
  serial(work) {
    const task = this.#queue.then(async () => {
      const hmr = this.service("hmr");
      if (hmr && typeof hmr.runExclusive !== "function")
        fail("UNSUPPORTED_CAPABILITY", "HMR缺少官方配置串行接口");
      // Never invoke an unverified host service before the version/digest gate.
      return hmr && !this.catalog(false).reason ? hmr.runExclusive(work) : work();
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
    // Capture the real waterfall Promise without altering config/noSave/decisions.
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
  sameTargets(catalog, plans) {
    return (
      !catalog.reason &&
      catalog.targets.length === plans.length &&
      plans.every((plan) =>
        catalog.targets.some(
          (target) =>
            !target.reason &&
            target.entry === plan.target.entry &&
            target.fiber === plan.target.fiber &&
            target.apply === plan.target.apply,
        ),
      )
    );
  }
  beforeUnchanged(plan) {
    const { target, before, beforeSnapshot, raw, rawSnapshot } = plan;
    return (
      target.entry.fiber === target.fiber &&
      target.fiber.state === 2 &&
      target.fiber.config === before &&
      equal(before, beforeSnapshot) &&
      target.entry.options.config === raw &&
      equal(raw, rawSnapshot)
    );
  }
  retain(plan, expected) {
    const { target, original, raw, rawSnapshot } = plan;
    const record = {
      ...target,
      original,
      config: target.fiber.config,
      expected: plain(expected),
      raw,
      rawSnapshot,
    };
    this.#owned.set(target.entry, record);
    return record;
  }
  failure(error, targets) {
    const failure = new StoreError(error.code ?? "READ_LIMIT_APPLY_FAILED", error.message);
    const rollbackError = targets.find((target) => target.rollbackError)?.rollbackError;
    failure.partial = {
      restored: targets.every((target) => target.restored),
      owned: Boolean(this.#owned.size),
      targets,
      ...(rollbackError ? { rollbackError } : {}),
    };
    return failure;
  }
  async rollback(plan) {
    const { target, before, beforeSnapshot, previous, next, raw, rawSnapshot } = plan;
    const result = {
      id: this.id(target.entry),
      restored: false,
      owned: this.#owned.has(target.entry),
    };
    if (target.fiber.config === before && equal(before, beforeSnapshot)) {
      result.restored = true;
      return result;
    }
    if (
      target.entry.fiber !== target.fiber ||
      !equal(target.fiber.config, next) ||
      (plan.appliedConfig && target.fiber.config !== plan.appliedConfig)
    ) {
      result.error = diagnostic(
        new StoreError("CONFLICT", "回滚前目标或活动配置身份已改变，保留外部修改"),
      );
      return result;
    }
    // Retain the attempted state even if external changes prohibit rollback.
    this.retain(plan, next);
    let updating = false;
    try {
      const catalog = this.catalog(false);
      const current = catalog.targets.find((item) => item.entry === target.entry);
      if (catalog.reason || current?.reason || !this.owns(current))
        fail("CONFLICT", "回滚目标或配置所有权已改变，保留外部修改");
      await this.moduleIdentity(current);
      const verified = this.catalog(false);
      if (
        verified.reason ||
        !verified.targets.some(
          (item) => item.entry === target.entry && !item.reason && this.owns(item),
        )
      )
        fail("CONFLICT", "回滚核验期间读取配置所有权已改变");
      updating = true;
      await this.update(current, beforeSnapshot);
      if (target.entry.options.config !== raw || !equal(raw, rawSnapshot))
        fail("CONFLICT", "回滚期间持久配置改变");
      if (previous)
        this.#owned.set(target.entry, {
          ...previous,
          config: target.fiber.config,
          expected: plain(beforeSnapshot),
        });
      else this.#owned.delete(target.entry);
      result.restored = true;
    } catch (error) {
      if (
        updating &&
        target.entry.fiber === target.fiber &&
        equal(target.fiber.config, beforeSnapshot)
      )
        this.retain(plan, beforeSnapshot);
      result.rollbackError = diagnostic(error);
    }
    result.owned = this.#owned.has(target.entry);
    return result;
  }
  apply({ signal } = {}) {
    return this.serial(async () => {
      cancelled(signal);
      const limit = this.limit();
      if (limit === 0) {
        await this.restore();
        return this.capabilities();
      }
      const catalog = this.catalog();
      const conflict = [...this.#owned].find(([entry]) => {
        const target = catalog.targets.find((item) => item.entry === entry);
        return catalog.reason || target?.reason || !this.owns(target);
      });
      if (conflict)
        throw this.failure(
          new StoreError("CONFLICT", "读取配置或目标已由其他所有者改变，未覆盖"),
          [...this.#owned].map(([entry]) => ({ id: this.id(entry), restored: false, owned: true })),
        );
      if (
        catalog.reason ||
        !catalog.targets.length ||
        catalog.targets.some((target) => target.reason)
      )
        fail(
          "UNSUPPORTED_CAPABILITY",
          catalog.reason ??
            catalog.targets.find((target) => target.reason)?.reason ??
            "未发现已启用且活动的官方read条目",
        );
      const plans = catalog.targets.map((target) => {
        const before = target.fiber.config,
          previous = this.#owned.get(target.entry);
        return {
          target,
          before,
          beforeSnapshot: plain(before),
          previous,
          original: previous?.original ?? plain(before),
          raw: target.entry.options.config,
          rawSnapshot: plain(target.entry.options.config),
          // Finite bounds: a B-byte body has at most B+1 empty lines; its UTF-16
          // length never exceeds its UTF-8 byte length.
          next: {
            ...plain(before),
            readMaxBytes: limit,
            readLimit: limit + 1,
            readMaxLineLength: limit,
          },
        };
      });
      for (const plan of plans) {
        await this.moduleIdentity(plan.target);
        cancelled(signal);
      }
      if (
        !this.sameTargets(this.catalog(), plans) ||
        !plans.every((plan) => this.beforeUnchanged(plan))
      )
        fail("CONFLICT", "核验期间官方读取目标或配置已变化");
      const attempts = [];
      this.#pending = true;
      try {
        for (const plan of plans) {
          if (
            !this.sameTargets(this.catalog(), plans) ||
            !plans.every((item) =>
              attempts.includes(item) ? this.owns(item.target) : this.beforeUnchanged(item),
            )
          )
            fail("CONFLICT", "应用期间官方读取目标或配置已变化");
          cancelled(signal);
          if (plan.previous?.expected.readMaxBytes === limit) continue;
          attempts.push(plan);
          await this.update(plan.target, plan.next);
          plan.appliedConfig = plan.target.fiber.config;
          this.retain(plan, plan.next);
          if (!this.owns(plan.target))
            fail("CONFLICT", "noSave更新期间持久配置改变，未覆盖外部修改");
          cancelled(signal);
        }
        if (
          !this.sameTargets(this.catalog(), plans) ||
          !plans.every((plan) => this.owns(plan.target))
        )
          fail("CONFLICT", "应用完成前官方读取目标或配置已变化，未确认全部生效");
        this.#pending = false;
        return this.capabilities();
      } catch (error) {
        const results = [];
        for (const plan of [...attempts].reverse()) results.push(await this.rollback(plan));
        throw this.failure(error, results);
      } finally {
        this.#pending = false;
      }
    });
  }
  async restore() {
    if (!this.#owned.size) return;
    const results = [];
    let firstError;
    this.#pending = true;
    try {
      for (const [entry, owned] of [...this.#owned]) {
        const result = { id: this.id(entry), restored: false, owned: true };
        let updating = false;
        try {
          const catalog = this.catalog(false);
          const target = catalog.targets.find((item) => item.entry === entry);
          if (catalog.reason || target?.reason || !this.owns(target))
            fail("CONFLICT", "读取上限配置或条目已由其他所有者改变，保留其修改");
          await this.moduleIdentity(target);
          const verified = this.catalog(false);
          const current = verified.targets.find((item) => item.entry === entry);
          if (verified.reason || current?.reason || !this.owns(current))
            fail("CONFLICT", "恢复核验期间读取配置所有权已改变，保留外部修改");
          updating = true;
          await this.update(current, plain(owned.original));
          if (entry.options.config !== owned.raw || !equal(entry.options.config, owned.rawSnapshot))
            fail("CONFLICT", "恢复期间条目持久配置已改变");
          this.#owned.delete(entry);
          result.restored = true;
          result.owned = false;
        } catch (error) {
          if (
            updating &&
            entry.fiber === owned.fiber &&
            equal(owned.fiber.config, owned.original)
          ) {
            owned.config = owned.fiber.config;
            owned.expected = plain(owned.original);
          }
          result.restored =
            entry.fiber === owned.fiber &&
            owned.fiber.state === 2 &&
            equal(owned.fiber.config, owned.original) &&
            entry.options.config === owned.raw &&
            equal(entry.options.config, owned.rawSnapshot);
          result.error = diagnostic(error);
          firstError ??= error;
        }
        results.push(result);
      }
      if (firstError) throw this.failure(firstError, results);
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
