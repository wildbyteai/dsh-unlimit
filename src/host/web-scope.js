import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { fail } from "../core/validation.js";
import { SUPPORTED_HOST } from "./desktop.js";
import { fetchScopedHttp } from "./scoped-http.js";

const PACKAGE = "@deepseek-ai/dsh-web-fetch-http";
const original = (value) => value?.[Symbol.for("cordis.original")] ?? value;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameDescriptor = (a, b) =>
  Boolean(a && b) &&
  ["value", "get", "set", "enumerable", "configurable", "writable"].every(
    (key) => a[key] === b[key],
  );
const methods = ["available", "fetch", "followAndRead", "requestOnce", "readBody", "readCapped"];
const limits = ["maxResponseBytes", "maxBodyChars", "timeoutMs", "maxRedirects", "userAgent"];

/** Restricts the existing web service and HTTP provider; never grants tool authorization. */
export class WebScope {
  #owned = null;
  #calls = new AsyncLocalStorage();
  #active = new Set();
  #queue = Promise.resolve();

  constructor(ctx, store, host, { scope }) {
    Object.assign(this, { ctx, store, host, scope });
  }

  service(name) {
    return original(typeof this.ctx.get === "function" ? this.ctx.get(name) : this.ctx[name]);
  }

  enabled() {
    return this.store.dispatch("settings.get", {}).value.enabled === true;
  }

  target() {
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
        return { reason: "HTTP 运行时发行版本与适配版本不一致" };
      const require = createRequire(join(this.host.runtimeRoot, "package.json"));
      const paths = {};
      for (const name of [
        PACKAGE,
        "@deepseek-ai/dsh-web",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-http-proxy",
        "@deepseek-ai/cordis",
        "@deepseek-ai/cordis-plugin-loader",
      ]) {
        const path = require.resolve(name);
        const row = manifest.files?.find(
          (item) => item.path === relative(this.host.runtimeRoot, path),
        );
        if (!row || createHash("sha256").update(readFileSync(path)).digest("hex") !== row.sha256)
          return { reason: "HTTP 或调用归属入口与发行库存摘要不一致，未改动宿主" };
        paths[name] = path;
      }
      const entries = [...this.service("loader").entries()].filter(
        (entry) => entry.options?.name === PACKAGE && entry.fiber?.state === 2,
      );
      if (entries.length !== 1) return { reason: "官方 HTTP provider 插件没有唯一活动条目" };
      const entry = entries[0];
      if (
        typeof entry.moduleNamespace?.apply !== "function" ||
        entry.fiber.runtime?.callback !== entry.moduleNamespace.apply
      )
        return { reason: "官方 HTTP provider 条目模块身份无法核实" };
      const web = this.service("web");
      const agents = this.service("agents");
      const tools = this.service("tools");
      const provider = web?.fetchProviders?.get("http");
      if (
        !provider ||
        typeof web.fetch !== "function" ||
        typeof web.config?.fetchProvider?.get !== "function" ||
        typeof agents?.currentInitiator !== "function" ||
        typeof agents.get !== "function" ||
        typeof tools?.execute !== "function" ||
        typeof this.ctx.on !== "function" ||
        limits.some((key) => provider.limits?.[key] !== entry.fiber.config?.[key])
      )
        return { reason: "HTTP provider、调用归属或活动配置合同不完整" };
      return { entry, web, agents, tools, provider, paths };
    } catch {
      return { reason: "无法安全核验 HTTP 执行边界" };
    }
  }

  owns(owned = this.#owned) {
    if (!owned || owned.closing || this.#owned !== owned) return false;
    const { entry, web, agents, tools, provider } = owned;
    return (
      this.service("web") === web &&
      this.service("agents") === agents &&
      this.service("tools") === tools &&
      [...this.service("loader").entries()].filter(
        (item) => item.options?.name === PACKAGE && item.fiber?.state === 2,
      ).length === 1 &&
      [...this.service("loader").entries()].includes(entry) &&
      entry.fiber === owned.fiber &&
      entry.fiber.state === 2 &&
      entry.moduleNamespace.apply === owned.module.apply &&
      entry.fiber.runtime.callback === owned.module.apply &&
      entry.fiber.config === owned.config &&
      equal(owned.config, owned.configSnapshot) &&
      provider.limits === owned.limits &&
      equal(provider.limits, owned.limitsSnapshot) &&
      web.fetchProviders === owned.providers &&
      owned.providers.get("http") === provider &&
      provider.id === "http" &&
      provider.resolveAddresses === owned.resolve &&
      Object.getPrototypeOf(provider) === owned.module.HttpFetchProvider.prototype &&
      methods.every((key) => {
        const inherited = owned.module.HttpFetchProvider.prototype[key];
        return (
          inherited === owned.methods[key] &&
          (key === "fetch" ||
            (!Object.hasOwn(provider, key) && provider[key] === owned.methods[key]))
        );
      }) &&
      owned.patches.every(({ target, key, installed }) =>
        sameDescriptor(Object.getOwnPropertyDescriptor(target, key), installed),
      ) &&
      agents.currentInitiator === owned.initiator &&
      agents.get === owned.agentGet &&
      tools.execute === owned.toolExecute
    );
  }

  capabilities() {
    const target = this.target();
    let conflict = false;
    try {
      conflict = Boolean(this.#owned && !this.owns());
    } catch {
      conflict = true;
    }
    return [
      {
        id: "webScope",
        label: "主／子代理 HTTP 范围执行",
        state: target.reason || conflict ? "unsupported" : this.#owned ? "active" : "available",
        owned: Boolean(this.#owned),
        detail:
          target.reason ??
          (conflict
            ? "HTTP 运行时所有权已变化；拒绝沿用适配，保留外部改动"
            : "约束现有 web.fetch/http，每跳核验地区并固定地址。无例外的 IPv6 需明确译址发现；代理和远端 Fetch 拒绝。不覆盖搜索、MCP、终端或浏览器。"),
      },
    ];
  }

  selected(owned) {
    const { web, WebError } = owned;
    const id = web.config.fetchProvider.get() ?? web.fetchProviderEnv;
    if (id !== undefined) {
      const provider = web.fetchProviders.get(id);
      if (!provider)
        throw new WebError("配置的 Fetch provider 未注册", "WEB_PROVIDER_CONFIGURED_MISSING");
      if (!provider.available())
        throw new WebError("配置的 Fetch provider 不可用", "WEB_PROVIDER_CONFIGURED_UNAVAILABLE");
      return provider;
    }
    const usable = [...web.fetchProviders.values()].filter((provider) => provider.available());
    if (!usable.length) throw new WebError("没有可用的 Fetch provider", "WEB_PROVIDER_UNAVAILABLE");
    if (usable.length !== 1)
      throw new WebError("Fetch provider 不唯一，请在宿主中选择", "WEB_PROVIDER_AMBIGUOUS");
    return usable[0];
  }

  assert(owned, call, revision, signal) {
    const reject = (code, message) => {
      throw new owned.WebError(message, code);
    };
    if (signal?.aborted) reject("WEB_ABORTED", "HTTP 请求已取消");
    if (!this.owns(owned)) reject("WEB_SCOPE_OWNERSHIP", "HTTP 范围控制的宿主接口所有权已变化");
    if (!this.enabled() || (revision !== undefined && this.scope.status().revision !== revision))
      reject("WEB_SCOPE_CHANGED", "运行控制或目标范围已变化，请重新发起请求");
    if (
      !call?.active ||
      original(call.exec.agent) !== call.agent ||
      !call.agent?.session?.id ||
      original(owned.agents.get(call.agent.session.id)) !== call.agent ||
      original(owned.agents.currentInitiator()) !== call.agent
    )
      reject("WEB_SCOPE_CONTEXT", "HTTP 请求缺少一致的活动工具与 Agent 归属");
    if (this.selected(owned) !== owned.provider)
      reject("WEB_SCOPE_PROVIDER_UNSUPPORTED", "所选 Fetch provider 未提供可核实的本地目标地址");
  }

  async fetch(owned, request, signal) {
    const call = this.#calls.getStore();
    this.assert(owned, call, undefined, signal);
    const revision = this.scope.status().revision;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, call.exec.signal, controller.signal].filter(Boolean));
    const active = { call, controller };
    this.#active.add(active);
    active.done = Promise.resolve().then(() =>
      fetchScopedHttp(
        {
          HttpFetchProvider: owned.module.HttpFetchProvider,
          native: owned.provider,
          scope: this.scope,
          proxyRouteFor: owned.proxyRouteFor,
          guard: () => this.assert(owned, call, revision, combined),
          WebError: owned.WebError,
        },
        request,
        combined,
      ),
    );
    try {
      return await active.done;
    } finally {
      this.#active.delete(active);
    }
  }

  serial(work) {
    const task = this.#queue.then(work);
    this.#queue = task.catch(() => {});
    return task;
  }

  apply() {
    return this.serial(async () => {
      if (this.#owned) {
        if (!this.owns()) fail("CONFLICT", "HTTP 接口所有权已变化，未覆盖");
        return this.capabilities();
      }
      const target = this.target();
      if (target.reason) fail("UNSUPPORTED_CAPABILITY", target.reason);
      const load = (name) => import(pathToFileURL(target.paths[`@deepseek-ai/${name}`]).href);
      const [module, webModule, agentModule, toolsModule, proxy] = await Promise.all([
        load("dsh-web-fetch-http"),
        load("dsh-web"),
        load("dsh-agent"),
        load("dsh-tools"),
        load("dsh-http-proxy"),
      ]);
      const current = this.target();
      if (
        current.reason ||
        ["entry", "web", "agents", "tools", "provider"].some((key) => current[key] !== target[key])
      )
        fail("CONFLICT", "HTTP 执行边界在加载适配时发生变化");
      const { entry, web, agents, tools, provider } = target;
      if (
        entry.moduleNamespace.apply !== module.apply ||
        !(web instanceof webModule.WebRuntime) ||
        !(agents instanceof agentModule.AgentRegistry) ||
        !(tools instanceof toolsModule.ToolRuntime) ||
        Object.getPrototypeOf(provider) !== module.HttpFetchProvider.prototype ||
        methods.some(
          (key) => Object.hasOwn(provider, key) || typeof provider[key] !== "function",
        ) ||
        Object.hasOwn(web, "fetch") ||
        web.fetch !== webModule.WebRuntime.prototype.fetch ||
        provider.resolveAddresses !==
          new module.HttpFetchProvider(provider.limits).resolveAddresses ||
        agents.currentInitiator !== agentModule.AgentRegistry.prototype.currentInitiator ||
        agents.get !== agentModule.AgentRegistry.prototype.get ||
        tools.execute !== toolsModule.ToolRuntime.prototype.execute
      )
        fail("UNSUPPORTED_CAPABILITY", "活动 HTTP、工具或 Agent 实例并非可识别的官方原始接口");
      const owned = {
        ...target,
        module,
        WebError: webModule.WebError,
        proxyRouteFor: proxy.proxyRouteFor,
        fiber: entry.fiber,
        config: entry.fiber.config,
        configSnapshot: structuredClone(entry.fiber.config),
        limits: provider.limits,
        limitsSnapshot: { ...provider.limits },
        providers: web.fetchProviders,
        methods: Object.fromEntries(methods.map((key) => [key, provider[key]])),
        resolve: provider.resolveAddresses,
        initiator: agents.currentInitiator,
        agentGet: agents.get,
        toolExecute: tools.execute,
        patches: [],
      };
      const patch = (target, key, replacement) => {
        const descriptor = Object.getOwnPropertyDescriptor(target, key);
        Object.defineProperty(target, key, {
          configurable: true,
          writable: true,
          value: replacement,
        });
        owned.patches.push({
          target,
          key,
          descriptor,
          installed: Object.getOwnPropertyDescriptor(target, key),
        });
      };
      const adapter = this;
      const nativeWebFetch = web.fetch;
      try {
        owned.dispose = this.ctx.on(
          "tools/execute",
          async (exec, next) => {
            if (!adapter.enabled()) return next();
            const call = { exec, agent: original(exec.agent), active: true };
            return adapter.#calls.run(call, async () => {
              try {
                return await next();
              } finally {
                call.active = false;
                const remaining = [...adapter.#active].filter((item) => item.call === call);
                for (const item of remaining) item.controller.abort();
                await Promise.allSettled(remaining.map((item) => item.done));
              }
            });
          },
          { global: true, prepend: true },
        );
        patch(web, "fetch", async function (request, signal) {
          if (!adapter.enabled()) return nativeWebFetch.call(this, request, signal);
          adapter.assert(owned, adapter.#calls.getStore(), undefined, signal);
          // Dispatch the exact validated object. Re-running native selection here
          // could let a stateful third-party available() switch the destination.
          return owned.provider.fetch(request, signal);
        });
        patch(provider, "fetch", async function (request, signal) {
          if (!adapter.enabled()) return owned.methods.fetch.call(this, request, signal);
          return adapter.fetch(owned, request, signal);
        });
        this.#owned = owned;
      } catch (error) {
        for (const { target, key, descriptor } of owned.patches.reverse()) {
          if (descriptor) Object.defineProperty(target, key, descriptor);
          else delete target[key];
        }
        owned.dispose?.();
        throw error;
      }
      return this.capabilities();
    });
  }

  async stopAll() {
    const active = [...this.#active];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.done));
    return { stopped: true };
  }

  revert() {
    return this.serial(async () => {
      const owned = this.#owned;
      if (!owned) return;
      owned.closing = true;
      await this.stopAll();
      const conflicts = [];
      for (const { target, key, descriptor, installed } of [...owned.patches].reverse()) {
        if (!sameDescriptor(Object.getOwnPropertyDescriptor(target, key), installed)) {
          conflicts.push(key);
          continue;
        }
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else delete target[key];
      }
      owned.dispose();
      this.#owned = null;
      if (conflicts.length) fail("CONFLICT", "部分 HTTP 接口已由其他所有者改动，未覆盖其改动");
    });
  }
}
