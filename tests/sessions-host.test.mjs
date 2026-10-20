import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { DesktopSessions } from "../src/host/sessions.js";
import { WorkspaceStore } from "../src/core/store.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const optionalHost = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated official SessionController tests; no user profile is loaded",
  timeout: 15000,
};
let official;

function denyExternalExecution(t) {
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
  syncBuiltinESMExports();
  t.after(() => {
    assert.deepEqual(
      calls,
      [],
      "The official-service fixture must never attempt a socket or child process",
    );
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function loadOfficial() {
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
    };
    return Object.fromEntries(
      await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
    );
  })();
  return official;
}

async function fixture(t) {
  denyExternalExecution(t);
  const api = await loadOfficial();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-real-controller-")));
  const ctx = new api.cordis.Context();
  const fibers = [];
  const unusedCalls = [];
  const store = new WorkspaceStore(join(directory, "plugin-synthetic.sqlite"));
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
  t.after(async () => {
    try {
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      assert.deepEqual(
        unusedCalls,
        [],
        "No synthetic LLM, attachment, filesystem or upload implementation may be exercised",
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
      new api.tools.ToolRuntime(scope);
      // These are explicit inert peripheral substitutes, not SessionController,
      // AgentLoop, Session/Query, Workspace or persistence implementations.
      const unused = (name) => () => {
        unusedCalls.push(name);
        throw new Error(`Unexpected synthetic peripheral call: ${name}`);
      };
      const model = new api.cordis.Service(scope, "agentDefaultModel");
      model.currentSelection = () => ({ provider: "synthetic-offline", model: "never-called" });
      const llm = new api.cordis.Service(scope, "llm");
      llm.stream = unused("llm.stream");
      llm.resolveCallConfig = unused("llm.resolveCallConfig");
      const fs = new api.cordis.Service(scope, "fs");
      fs.resolve = unused("fs.resolve");
      const attachments = new api.cordis.Service(scope, "attachments");
      attachments.imageLimits = {
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 1024,
        maxImageDimension: 32,
        mediaTypes: ["image/png"],
      };
      const uploads = new api.cordis.Service(scope, "fileUploads");
      uploads.registerAgentResolver = () => () => {};
      const access = new api.cordis.Service(scope, "remoteAccess");
      access.allows = (resource) =>
        resource.kind === "session" && ctx.sessions.get(resource.id) !== undefined;
    },
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
  await mount(api.controller.SessionController, { nativeOpen: false, listWorkSliceMs: 16 });
  const adapter = new DesktopSessions(ctx, store);
  const create = async () => {
    const created = await ctx.sessionController.create({ cwd: join(directory, "project") });
    store.dispatch("workspaces.bind", { id: workspaceId, sessionId: created.sessionId });
    return ctx.agents.get(created.sessionId);
  };
  const appendTurn = (agent, turn, prompt) => {
    agent.session.append("turn/start", { turn });
    agent.session.append("step/start", { turn, step: 1 });
    agent.session.append(
      "user/message",
      api.llm.createUserMessage({
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      }),
      { surfaceOp: "append" },
    );
    agent.session.append("step/end", { turn, step: 1, reason: { kind: "completed" } });
    agent.session.append("turn/end", { turn, reason: { kind: "completed" } });
  };
  return { api, ctx, adapter, store, workspaceId, directory, create, appendTurn };
}

test(
  "real official controller forks an exact synthetic prefix and durably archives the original",
  optionalHost,
  async (t) => {
    const { ctx, adapter, store, workspaceId, directory, create, appendTurn } = await fixture(t);
    const original = await create();
    appendTurn(original, 1, "First synthetic input");
    appendTurn(original, 2, "Second synthetic input\nKeep exact text.");
    await ctx.sessionPersistence.flush();
    const before = await ctx.sessionController.inspect(original.id);
    const plan = await adapter.prepare({ sessionId: original.id });
    const result = await adapter.rewind({ sessionId: original.id, draftBridgeReady: true });
    assert.equal(result.strategy, "fork");
    assert.notEqual(result.newSessionId, original.id);
    assert.equal(result.archived, true);
    assert.equal(result.draftStatus, "pending-client");
    assert.equal(result.draft, "Second synthetic input\nKeep exact text.");
    assert.deepEqual(result.stop.pendingIds, []);
    const child = await ctx.sessionController.inspect(result.newSessionId);
    assert.equal(child.meta.parentSession, original.id);
    assert.equal(child.inheritedEventCount, plan.atSeq + 1);
    assert.deepEqual(child.events.slice(0, plan.atSeq + 1), before.events.slice(0, plan.atSeq + 1));
    assert.ok(child.events.some((event) => event.type === "session/end-seed"));
    assert.deepEqual((await ctx.sessionController.inspect(original.id)).events, before.events);
    assert.equal(
      store.dispatch("workspaces.forSession", { sessionId: result.newSessionId }).item.id,
      workspaceId,
    );
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(result.newSessionId, "read");
    try {
      assert.deepEqual((await reader.read()).events, child.events);
    } finally {
      await reader.close();
    }
    assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(original.id));
    const durableWorkspace = JSON.parse(
      readFileSync(join(directory, "domains", "workspace.json"), "utf8"),
    );
    assert.ok(durableWorkspace.global.archivedSessionIds.includes(original.id));
    assert.ok(!(await adapter.list()).some((item) => item.id === original.id));
    assert.ok((await adapter.list()).some((item) => item.id === result.newSessionId));
  },
);

test(
  "real official controller creates an empty continuation for the first synthetic turn",
  optionalHost,
  async (t) => {
    const { ctx, adapter, directory, create, appendTurn } = await fixture(t);
    const original = await create();
    appendTurn(original, 1, "First-turn synthetic draft");
    const result = await adapter.rewind({ sessionId: original.id, draftBridgeReady: true });
    assert.equal(result.strategy, "empty");
    assert.equal(result.draft, "First-turn synthetic draft");
    const continuation = await ctx.sessionController.inspect(result.newSessionId);
    assert.equal(continuation.meta.cwd, join(directory, "project"));
    assert.equal(continuation.meta.parentSession, undefined);
    assert.equal(
      continuation.events.some((event) => event.type === "user/message"),
      false,
    );
    assert.equal(
      continuation.events.some((event) => event.type === "turn/start"),
      false,
    );
    assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(original.id));
  },
);

test(
  "real official archive stop clears queued synthetic input and invalid cuts create no session",
  optionalHost,
  async (t) => {
    const { api, ctx, adapter, create, appendTurn } = await fixture(t);
    const original = await create();
    appendTurn(original, 1, "First synthetic turn");
    appendTurn(original, 2, "Second synthetic turn");
    const beforeIds = ctx.sessions.list().map((session) => session.id);
    await assert.rejects(
      adapter.rewind({ sessionId: original.id, atSeq: 1, draftBridgeReady: true }),
      (error) => error.code === "INVALID_REWIND_BOUNDARY",
    );
    assert.deepEqual(
      ctx.sessions.list().map((session) => session.id),
      beforeIds,
    );
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.length, 0);
    // Official inject() records pending next-step input without waking the loop.
    original.inject(
      api.llm.createUserMessage({
        content: [{ type: "text", text: "Synthetic pending notice" }],
        source: { kind: "runtime-context" },
      }),
    );
    assert.equal(original.inbox.nextStep.length, 1);
    const result = await adapter.rewind({ sessionId: original.id, draftBridgeReady: true });
    assert.equal(result.archived, true);
    assert.equal(original.inbox.nextStep.length, 0);
    assert.equal(original.status, "idle");
    assert.ok(result.stop.settledIds.includes(original.id));
  },
);
