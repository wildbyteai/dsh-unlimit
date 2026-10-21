import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
export const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME to official 0.2.1-rc.2; no user profile is loaded",
  timeout: 20000,
};
export const raw = (value) => value?.[Symbol.for("cordis.original")] ?? value;

/** Load installed public exports only after each runtime file passes its release inventory. */
export async function loadWebRuntime(t) {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const inventory = new Map(manifest.files.map((item) => [item.path, item]));
  const verified = new Set();
  const verify = (filename) => {
    const path = relative(runtimeRoot, filename);
    assert.ok(path !== ".." && !path.startsWith(".." + sep));
    const entry = inventory.get(path);
    assert.ok(entry, `Official inventory must list ${path}`);
    assert.equal(
      createHash("sha256").update(readFileSync(filename)).digest("hex"),
      entry.sha256,
      `Refusing modified official module: ${path}`,
    );
    verified.add(path);
  };
  const hook = registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const filename = fileURLToPath(url);
        if (filename.startsWith(runtimeRoot + sep)) verify(filename);
      }
      return next(url, context);
    },
  });
  t.after(() => hook.deregister());
  const requireHost = createRequire(join(runtimeRoot, "package.json"));
  const load = async (name) => {
    const filename = requireHost.resolve(name);
    verify(filename);
    return import(pathToFileURL(filename).href);
  };
  const [cordis, cosmokit, prompt, agents, tools, web, toolWeb, httpFetch, proxy, scope, undici] =
    await Promise.all(
      [
        "@deepseek-ai/cordis",
        "@deepseek-ai/cosmokit",
        "@deepseek-ai/dsh-system-prompt",
        "@deepseek-ai/dsh-agent",
        "@deepseek-ai/dsh-tools",
        "@deepseek-ai/dsh-web",
        "@deepseek-ai/dsh-tool-web",
        "@deepseek-ai/dsh-web-fetch-http",
        "@deepseek-ai/dsh-http-proxy",
        "@deepseek-ai/dsh-scope",
        "undici",
      ].map(load),
    );
  return {
    cordis,
    cosmokit,
    prompt,
    agents,
    tools,
    web,
    toolWeb,
    httpFetch,
    proxy,
    scope,
    undici,
    verified,
    host: { kind: "desktop", version: manifest.release.version, supported: true, runtimeRoot },
  };
}

/** Real official service and tool execution; only DNS answers and HTTP dispatch are synthetic. */
export async function webFixture(t) {
  const api = await loadWebRuntime(t);
  const ctx = new api.cordis.Context();
  const entries = [];
  const settings = { enabled: true, ownServers: [] };
  const actions = [];
  const store = {
    dispatch(action) {
      actions.push(action);
      assert.equal(action, "settings.get", "Ordinary fetch must not require admission/workspace");
      return { value: settings };
    },
  };
  const decisions = [];
  const scope = {
    revision: "synthetic-scope-1",
    status() {
      return { revision: this.revision };
    },
    preview() {
      return { state: "ready", reason: "region-pending" };
    },
    decide(hostname, address) {
      decisions.push({ hostname, address, agent: raw(ctx.agents).currentInitiator() });
      return { allowed: true, reason: "country-allowed", country: "US", address };
    },
  };
  class SyntheticLoader extends api.cordis.Service {
    constructor(owner) {
      super(owner, "loader");
    }
    entries() {
      return entries;
    }
  }
  const baseFiber = ctx.plugin({
    name: "synthetic-web-services",
    apply(owner) {
      new api.prompt.SystemPrompt(owner, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "SYNTHETIC_WEB_FIXTURE",
        personaSuffix: "",
      });
      new api.agents.AgentRegistry(owner);
      new api.tools.ToolRuntime(owner, { mode: "native" });
      new SyntheticLoader(owner);
    },
  });
  await baseFiber.await();
  const webFiber = ctx.plugin(api.web.WebRuntime, {
    fetchProvider: "http",
  });
  await webFiber.await();
  const httpFiber = ctx.plugin(api.httpFetch, {
    maxResponseBytes: 4096,
    maxBodyChars: 4096,
    timeoutMs: 1000,
    maxRedirects: 3,
    userAgent: "synthetic-web-fixture",
  });
  await httpFiber.await();
  const toolFiber = ctx.plugin(api.toolWeb, { search: false, fetch: true });
  await toolFiber.await();
  for (const [name, fiber, moduleNamespace] of [
    ["@deepseek-ai/dsh-web", webFiber, api.web],
    ["@deepseek-ai/dsh-web-fetch-http", httpFiber, api.httpFetch],
    ["@deepseek-ai/dsh-tool-web", toolFiber, api.toolWeb],
  ])
    entries.push({ options: { name, config: fiber.config }, fiber, moduleNamespace });
  const httpEntry = entries.find(
    (entry) => entry.options.name === "@deepseek-ai/dsh-web-fetch-http",
  );
  assert.equal(httpFiber.runtime.callback, api.httpFetch.apply);
  const native = raw(ctx.web).fetchProviders.get("http");
  assert.ok(native instanceof api.httpFetch.HttpFetchProvider);
  assert.equal(
    native.resolveAddresses,
    new api.httpFetch.HttpFetchProvider(native.limits).resolveAddresses,
    "Fixture must retain the production provider's native public-address resolver",
  );
  const mockAgent = new api.undici.MockAgent();
  mockAgent.disableNetConnect();
  const dnsCalls = [];
  const requests = [];
  const forbidden = [];
  const answers = new Map();
  const restorers = [];
  const replace = (target, key, replacement) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: true,
      writable: true,
      ...descriptor,
      value: replacement,
    });
    restorers.push(() => {
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else delete target[key];
    });
  };
  const rejectIO = (kind) => () => {
    forbidden.push(kind);
    throw new Error(`Unexpected real I/O in synthetic web fixture: ${kind}`);
  };
  replace(Socket.prototype, "connect", rejectIO("socket"));
  replace(globalThis, "fetch", rejectIO("global-fetch"));
  replace(dgram, "createSocket", rejectIO("udp"));
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    replace(childProcess, key, rejectIO(`child-process:${key}`));
  for (const key of ["lookup", "resolve", "resolve4", "resolve6"])
    replace(dns, key, rejectIO(`dns:${key}`));
  replace(dnsPromises, "lookup", async (hostname, options) => {
    dnsCalls.push({ hostname, agent: raw(ctx.agents).currentInitiator() });
    const value = answers.get(hostname);
    if (value === undefined)
      throw Object.assign(new Error("No synthetic DNS answer"), { code: "ENOTFOUND" });
    return typeof value === "function" ? value(options) : value.map((answer) => ({ ...answer }));
  });
  replace(api.undici.Agent.prototype, "dispatch", function (options, handler) {
    requests.push({
      origin: String(options.origin),
      path: options.path,
      agent: raw(ctx.agents).currentInitiator(),
    });
    return mockAgent.get(options.origin).dispatch(options, handler);
  });
  syncBuiltinESMExports();
  const agentScopes = [];
  let sequence = 0;
  t.after(async () => {
    try {
      for (const owned of agentScopes.reverse()) {
        owned.detach();
        await owned.scope.dispose();
      }
      await toolFiber.dispose();
      await httpFiber.dispose();
      await webFiber.dispose();
      await baseFiber.dispose();
      await ctx.fiber.dispose();
      await mockAgent.close();
    } finally {
      for (const restore of restorers.reverse()) restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(forbidden, [], "No real DNS/network or child process is permitted");
  });
  const createAgent = (id, parent) => {
    const agent = {
      id,
      session: { id, header: { id, ...(parent ? { parentSession: parent.session.id } : {}) } },
      status: "running",
      options: {},
    };
    const scope = api.scope.createScope(ctx, agent, parent ? { parent } : undefined);
    agent.ctx = scope.ctx;
    const detach = raw(ctx.agents).enter(agent, parent);
    agentScopes.push({ scope, detach });
    assert.equal(raw(ctx.agents).get(id), agent);
    return agent;
  };
  return {
    api,
    ctx,
    entries,
    httpEntry,
    httpFiber,
    native,
    settings,
    store,
    actions,
    scope,
    decisions,
    dnsCalls,
    requests,
    forbidden,
    answers,
    createAgent,
    setProvider(id) {
      api.cosmokit.updateVolatile(
        raw(ctx.web).config.fetchProvider,
        api.cosmokit.createVolatile(id),
      );
    },
    reply(url, { statusCode = 200, body = "synthetic page", headers = {}, delay = 0 } = {}) {
      const parsed = new URL(url);
      answers.set(parsed.hostname, [{ address: "93.184.216.34", family: 4 }]);
      const mock = mockAgent
        .get(parsed.origin)
        .intercept({ path: parsed.pathname + parsed.search, method: "GET" })
        .reply(statusCode, body, { headers: { "content-type": "text/plain", ...headers } });
      if (delay) mock.delay(delay);
      return mock;
    },
    invoke(agent, url, { initiator = agent, signal = new AbortController().signal } = {}) {
      const execute = () =>
        ctx.tools.execute({
          name: "web_fetch",
          arguments: { url },
          callId: `web-${++sequence}`,
          agent,
          signal,
        });
      return initiator === null ? execute() : ctx.agents.withInitiator(initiator, execute);
    },
  };
}
