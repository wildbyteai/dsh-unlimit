import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { SUPPORTED_HOST } from "./desktop.js";

const original = (value) => value?.[Symbol.for("cordis.original")] ?? value;

/** Creation-time attribution only; never infer ownership from a PID or current settings. */
export class TerminalOwnership {
  #scope = new AsyncLocalStorage();
  #undo = [];
  #pending = new Set();
  #owned = new Set();
  #closing = null;
  #active = false;
  #failures = [];

  constructor(runtime) {
    this.runtime = runtime;
  }

  get closing() {
    return this.#closing !== null;
  }

  apply() {
    if (this.#closing || this.#owned.size || this.#failures.length)
      throw new Error("升权终端尚未完成回收，请先重试还原");
    if (this.#active) return;
    const { host } = this.runtime;
    // Synthetic/partial service compositions without a desktop runtime have no PTY adapter.
    if (!host.runtimeRoot || !this.runtime.service("agentPresets")) return;
    const inventory = JSON.parse(
      readFileSync(join(host.runtimeRoot, "desktop-runtime.json"), "utf8"),
    );
    if (host.version !== SUPPORTED_HOST || inventory.release?.version !== SUPPORTED_HOST)
      throw new Error("持久终端运行时版本未通过适配门");
    const require = createRequire(join(host.runtimeRoot, "package.json"));
    const names = ["@deepseek-ai/dsh-terminal", "@deepseek-ai/dsh-terminal-bash"];
    for (const name of names) {
      const path = require.resolve(name);
      const entry = inventory.files?.find((row) => row.path === relative(host.runtimeRoot, path));
      if (!entry || createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256)
        throw new Error("持久终端入口与发行库存不符，未接管终端权限");
    }
    this.attach(
      require(names[0]).TerminalSessionService.prototype,
      require(names[1]).BashTerminalBackend.prototype,
    );
  }

  attach(registryPrototype, backendPrototype) {
    if (this.#active || this.#closing || this.#owned.size) throw new Error("终端跟踪仍在使用中");
    const tracker = this;
    const activation = {};
    this.#active = activation;
    const wrap = (target, create) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, "spawn");
      if (typeof descriptor?.value !== "function") throw new Error("缺少已验证的终端 spawn 接口");
      const replacement = create(descriptor.value);
      Object.defineProperty(target, "spawn", { ...descriptor, value: replacement });
      this.#undo.push(() => {
        if (Object.getOwnPropertyDescriptor(target, "spawn")?.value !== replacement)
          throw new Error("终端创建接口已被其他所有者改变，未覆盖其修改");
        Object.defineProperty(target, "spawn", descriptor);
      });
    };
    try {
      wrap(
        registryPrototype,
        (spawn) =>
          function (owner, ...args) {
            if (tracker.#active !== activation) return spawn.call(this, owner, ...args);
            const agents = this.ctx?.get ? this.ctx.get("agents") : this.ctx?.agents;
            if (original(agents) !== original(tracker.runtime.service("agents")))
              return spawn.call(this, owner, ...args);
            const lease = { registry: this, owner, elevated: false, backend: false };
            const task = tracker.#scope.run(lease, async () => {
              try {
                const snapshot = await spawn.call(this, owner, ...args);
                if (lease.elevated)
                  tracker.#owned.add({ registry: this, owner, id: snapshot.sessionId });
                return snapshot;
              } catch (error) {
                // Native rollback failures may leave unpublished resources. Do not lose
                // that fact just because the failed spawn settled before revert started.
                if (lease.elevated && (error.cleanupError || error instanceof AggregateError))
                  tracker.#failures.push(error);
                throw error;
              }
            });
            tracker.#pending.add(task);
            // Register both settlement handlers without creating an unhandled rejection.
            task.then(
              () => tracker.#pending.delete(task),
              () => tracker.#pending.delete(task),
            );
            return task;
          },
      );
      wrap(
        backendPrototype,
        (spawn) =>
          function (spec) {
            const lease = tracker.#scope.getStore();
            if (
              tracker.#active !== activation ||
              original(this.ctx.sandboxPolicy) !==
                original(tracker.runtime.service("sandboxPolicy"))
            )
              return spawn.call(this, spec);
            const parent = lease?.owner === spec.owner && !lease.backend ? lease : null;
            return tracker.#scope.run({ owner: spec.owner, parent, backend: true }, () =>
              spawn.call(this, spec),
            );
          },
      );
    } catch (error) {
      this.#active = false;
      for (const undo of this.#undo.splice(0).reverse()) undo();
      throw error;
    }
  }

  elevated(session) {
    const lease = this.#scope.getStore();
    if (lease?.backend && lease.parent && lease.owner.session === session)
      lease.parent.elevated = true;
  }

  allowsElevation() {
    const lease = this.#scope.getStore();
    return !lease?.backend || lease.parent !== null;
  }

  owns(registry, owner, id) {
    return [...this.#owned].some(
      (entry) =>
        original(entry.registry) === original(registry) && entry.owner === owner && entry.id === id,
    );
  }

  revert() {
    if (this.#closing) return this.#closing;
    this.#active = false;
    const errors = [...this.#failures];
    for (const undo of this.#undo.splice(0).reverse()) {
      try {
        undo();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!this.#pending.size && !this.#owned.size) {
      if (errors.length) throw new AggregateError(errors, "终端创建接口未完整恢复");
      return;
    }
    this.#closing = (async () => {
      // Publication may still be in flight when revert invalidates permission callbacks.
      const pending = await Promise.allSettled([...this.#pending]);
      for (const result of pending) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      for (const entry of this.#owned) {
        try {
          if (entry.registry.list(entry.owner).some((row) => row.sessionId === entry.id))
            await entry.registry.kill(entry.owner, entry.id, "dsh-unlimit permission revert");
          this.#owned.delete(entry);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "升权终端回收未完成，请重试还原；未报告权限已收回");
    })().finally(() => {
      this.#closing = null;
    });
    return this.#closing;
  }
}
