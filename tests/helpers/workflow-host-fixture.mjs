import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import childProcess from "node:child_process";
import { DesktopWorkflow } from "../../src/host/workflow.js";
import { Flow } from "../../src/core/flow.js";
import { WorkspaceStore } from "../../src/core/store.js";
import { DesktopRuntime } from "../../src/host/runtime.js";

export const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
export const optionalHost = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated official Workflow tests; no user profile is loaded",
  timeout: 15000,
};
let official;

export function denyExternalExecution(t) {
  const calls = [];
  const deny = (name) =>
    function () {
      calls.push(name);
      throw new Error(`Isolated host test forbids ${name}`);
    };
  t.mock.method(net.Socket.prototype, "connect", deny("socket connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("datagram bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("datagram send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  for (const [label, api] of [
    ["dns", dns],
    ["dns/promises", dnsPromises],
  ])
    for (const key of Object.keys(api))
      if (/^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function")
        t.mock.method(api, key, deny(`${label}.${key}`));
  syncBuiltinESMExports();
  return () => {
    try {
      assert.deepEqual(
        calls,
        [],
        "The official-service fixture must never attempt DNS, network or child process calls, including cleanup",
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  };
}

export async function loadOfficial() {
  official ??= (async () => {
    const root = realpathSync(runtimeRoot);
    const descriptor = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
    assert.equal(descriptor.release.version, "0.2.1-rc.2");
    const require = createRequire(join(root, "package.json"));
    const load = async (name) => {
      const filename = require.resolve(name);
      const inventory = descriptor.files.find((item) => item.path === relative(root, filename));
      assert.ok(inventory, `Official inventory must include ${name}`);
      assert.equal(
        createHash("sha256").update(readFileSync(filename)).digest("hex"),
        inventory.sha256,
        `${name} must match the clean official inventory`,
      );
      return import(pathToFileURL(filename).href);
    };
    const names = {
      cordis: "@deepseek-ai/cordis",
      storage: "@deepseek-ai/dsh-storage",
      jsonStorage: "@deepseek-ai/dsh-storage-json",
      domain: "@deepseek-ai/dsh-storage-domain",
      persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
      sessions: "@deepseek-ai/dsh-session",
      projections: "@deepseek-ai/dsh-session-projection",
      query: "@deepseek-ai/dsh-session-query",
      workspaces: "@deepseek-ai/dsh-workspace",
      agents: "@deepseek-ai/dsh-agent",
      loop: "@deepseek-ai/dsh-agent-loop",
      prompt: "@deepseek-ai/dsh-system-prompt",
      tools: "@deepseek-ai/dsh-tools",
      typert: "@deepseek-ai/dsh-typert-registry",
      controller: "@deepseek-ai/dsh-api-session-controller",
      llm: "@deepseek-ai/dsh-llm",
      subagents: "@deepseek-ai/dsh-subagent",
      spawn: "@deepseek-ai/dsh-subagent-spawn-in-process",
      directories: "@deepseek-ai/dsh-working-directory",
      loader: "@deepseek-ai/cordis-plugin-loader",
      presets: "@deepseek-ai/dsh-agent-preset-registry",
      approval: "@deepseek-ai/dsh-user-approval",
      sandboxPolicy: "@deepseek-ai/dsh-sandbox-policy",
      attachments: "@deepseek-ai/dsh-attachment-local",
      skills: "@deepseek-ai/dsh-skill",
    };
    return Object.fromEntries(
      await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
    );
  })();
  return official;
}

// streamBehavior receives a 1-based count for this session and returns
// "stop" (default), "max-tokens", or "hold". A held request remains cancellable
// and is exposed in holds with resolve() for tests that explicitly release it.
export async function fixture(
  t,
  {
    captureAll = false,
    streamBehavior,
    textOutput,
    realAttachments = false,
    imageModel = true,
    attachmentConfig = {},
  } = {},
) {
  const finishGuard = denyExternalExecution(t);
  let dispose;
  t.after(async () => {
    try {
      await dispose?.();
    } finally {
      finishGuard();
    }
  });
  const api = await loadOfficial();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-real-workflow-")));
  const ctx = new api.cordis.Context();
  const fibers = [];
  const disposers = [];
  const unusedCalls = [];
  const requests = [];
  const holds = [];
  const sessionRequestCounts = new Map();
  let pause;
  let workflow;
  let runtime;
  const store = new WorkspaceStore(join(directory, "plugin-synthetic.sqlite"));
  const flow = new Flow(store);
  const project = join(directory, "project");
  mkdirSync(project);
  const workspaceId = store.dispatch("workspaces.save", {
    name: "Synthetic official-service workspace",
  }).item.id;
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "Every required official service must be active");
    return fiber;
  };
  dispose = async () => {
    try {
      await workflow?.close();
      runtime?.revert();
      for (const cleanup of disposers.reverse()) await cleanup();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      assert.deepEqual(
        unusedCalls,
        [],
        "No synthetic LLM, attachment, filesystem or upload implementation may be exercised",
      );
    } finally {
      flow.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };

  await mount({
    name: "isolated-official-session-foundation",
    apply(scope) {
      new api.storage.Storage(scope);
      new api.typert.TypertRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.projections.SessionProjectionRegistry(scope);
      new api.agents.AgentRegistry(scope);
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new api.tools.ToolRuntime(scope, { mode: "native" });
      // These are explicit inert peripheral substitutes, not SessionController,
      // AgentLoop, Session/Query, Workspace or persistence implementations.
      const unused = (name) => () => {
        unusedCalls.push(name);
        throw new Error(`Unexpected synthetic peripheral call: ${name}`);
      };
      const model = new api.cordis.Service(scope, "agentDefaultModel");
      model.currentSelection = () => ({ provider: "synthetic-offline", model: "never-called" });
      const llm = new api.cordis.Service(scope, "llm");
      if (realAttachments)
        llm.resolveModelInfo = async () => ({
          inputModalities: imageModel ? ["text", "image"] : ["text"],
        });
      // Only the transport is synthetic. Official AgentLoop consumes this valid
      // provider-neutral stream and commits real session/activation events.
      llm.prepareCall = async (config) => ({ config, stream: (request) => llm.stream(request) });
      llm.stream = async function* (request) {
        requests.push(request);
        const sessionRequestCount = (sessionRequestCounts.get(request.sessionId) ?? 0) + 1;
        sessionRequestCounts.set(request.sessionId, sessionRequestCount);
        const agent = ctx.agents.get(request.sessionId);
        assert.ok(agent, "The transport receives a real resident official Agent");
        assert.deepEqual(request.messages, agent.session.deriveMessages());
        if (!captureAll) {
          assert.equal(
            store.dispatch("workspaces.forSession", { sessionId: request.sessionId }).item.id,
            workspaceId,
          );
          assert.ok(
            flow.status(workspaceId).active.some((row) => row.sessionId === request.sessionId),
          );
        }
        const behavior =
          (await streamBehavior?.({ request, sessionRequestCount, requests })) ?? "stop";
        assert.ok(
          ["stop", "max-tokens", "hold"].includes(behavior),
          "Synthetic stream behavior must be stop, max-tokens or hold",
        );
        const gate = pause ?? (behavior === "hold" ? { request } : null);
        if (gate)
          await new Promise((resolve, reject) => {
            gate.resolve = resolve;
            if (behavior === "hold") holds.push(gate);
            request.signal.addEventListener("abort", () => reject(request.signal.reason), {
              once: true,
            });
            if (request.signal.aborted) reject(request.signal.reason);
          });
        const text = textOutput ? await textOutput(request) : "Synthetic evidence: 1, 2, 3.";
        assert.equal(typeof text, "string");
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text },
        };
        yield {
          type: "finish",
          reason: { kind: behavior === "max-tokens" ? "max-tokens" : "stop" },
        };
      };
      const fs = new api.cordis.Service(scope, "fs");
      fs.resolve = async (path, options = {}) => {
        const target = resolve(options.cwd ?? project, path);
        assert.ok(
          target === directory || target.startsWith(directory + sep),
          "No real user files are visible",
        );
        return target;
      };
      fs.stat = async (target) => ({ type: statSync(target).isDirectory() ? "directory" : "file" });
      fs.processPath = (target) => target;
      if (realAttachments) new api.skills.SkillRegistry(scope);
      else {
        const attachments = new api.cordis.Service(scope, "attachments");
        attachments.imageLimits = {
          maxImageBytes: 1024,
          maxImagesPerMessage: 1,
          maxMessageImageBytes: 1024,
          maxImagePixels: 1024,
          maxImageDimension: 32,
          mediaTypes: ["image/png"],
        };
      }
      const uploads = new api.cordis.Service(scope, "fileUploads");
      uploads.registerAgentResolver = () => () => {};
      const access = new api.cordis.Service(scope, "remoteAccess");
      access.allows = (resource) =>
        resource.kind === "session" && ctx.sessions.get(resource.id) !== undefined;
    },
  });
  if (realAttachments)
    await mount(api.attachments.LocalAttachmentStore, {
      ...attachmentConfig,
      dshHome: join(directory, "isolated-attachment-home"),
    });
  await mount(api.jsonStorage, { root: join(directory, "domains") });
  await mount(api.domain, { backend: "json", routes: {} });
  await mount(api.persistence, {
    root: join(directory, "session-logs"),
    compression: "none",
    listConcurrency: 1,
  });
  await mount(api.workspaces.WorkspaceRegistry);
  // Only the concrete observation/list methods are used. No full-text backend
  // or transport is mounted, and no search behavior is substituted.
  await mount(api.query.SessionQueryEngine);
  await mount(api.loop.AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  await mount(api.directories.WorkingDirectoryService, { defaultDirectory: project });
  await mount(api.loader.default, {
    baseUrl: pathToFileURL(join(directory, "isolated-entry.mjs")).href,
  });
  await mount(api.presets.AgentPresetRegistry ?? api.presets.default, {
    default: "synthetic-user-default",
  });
  await ctx.agentPresets.register({
    id: "synthetic-user-default",
    name: "Untouched synthetic user composition",
    plugins: [],
  });
  await mount(api.controller.SessionController, { nativeOpen: false, listWorkSliceMs: 16 });
  await mount(api.subagents.SubagentRuntime, { maxDepth: 1, maxActiveSubagents: 8 });
  await mount(api.spawn, { providerName: "spawn" });
  workflow = new DesktopWorkflow(ctx, store, flow);
  const create = async (workspace = workspaceId) => {
    const created = await ctx.sessionController.create({ cwd: join(directory, "project") });
    if (workspace)
      store.dispatch("workspaces.bind", { id: workspace, sessionId: created.sessionId });
    return ctx.agents.get(created.sessionId);
  };
  const mountDesktopRuntime = async () => {
    assert.equal(runtime, undefined, "Only one adapter owns this fixture");
    await mount(api.approval.default, { policy: "ask" });
    await mount(api.sandboxPolicy.default, { mode: "read-only", workspaceRoot: project });
    const current = store.dispatch("settings.get");
    store.dispatch("settings.save", {
      revision: current.revision,
      value: {
        ...current.value,
        enabled: true,
        prompt: "SYNTHETIC_WORKFLOW_OPERATOR",
        promptMode: "replace",
        workspacePolicy: "strict",
        workspaceFiles: [],
        autoApprove: false,
        fullAccess: false,
      },
    });
    runtime = new DesktopRuntime(ctx, store, {
      kind: "desktop",
      supported: true,
      version: "0.2.1-rc.2",
      runtimeRoot,
    });
    // Exact production plugin.js wiring, not a substitute role resolver.
    runtime.rolePrompt = (sessionId) => flow.rolePrompt(sessionId);
    runtime.apply();
    return runtime;
  };
  return {
    api,
    ctx,
    workflow,
    store,
    flow,
    workspaceId,
    directory,
    create,
    requests,
    holds,
    mountDesktopRuntime,
    onDispose: (cleanup) => disposers.push(cleanup),
    pause: () => {
      pause = {};
      return pause;
    },
  };
}

export async function waitFor(read, predicate) {
  for (let i = 0; i < 200; i++) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Official activation did not settle within one second");
}
