import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { DesktopSessions } from "../src/host/sessions.js";
import { CHILD_INPUT_RECORD, ChildOrigins } from "../src/host/child-origins.js";
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
      attachmentLocal: "@deepseek-ai/dsh-attachment-local",
      todo: "@deepseek-ai/dsh-tool-todo",
      subagents: "@deepseek-ai/dsh-subagent",
      spawn: "@deepseek-ai/dsh-subagent-spawn-in-process",
      subagentControls: "@deepseek-ai/dsh-tool-subagent-control",
      directories: "@deepseek-ai/dsh-working-directory",
    };
    return Object.fromEntries(
      await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
    );
  })();
  return official;
}

async function fixture(
  t,
  {
    attachments: useAttachments = false,
    todo: useTodo = false,
    subagents: useSubagents = false,
    subagentControls: useSubagentControls = false,
    toolMode = "native",
  } = {},
) {
  denyExternalExecution(t);
  const api = await loadOfficial();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-real-controller-")));
  const ctx = new api.cordis.Context();
  const fibers = [];
  const unusedCalls = [];
  const project = join(directory, "project");
  if (useSubagents) mkdirSync(project);
  const preStepEntered = Promise.withResolvers();
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
        "No unexpected LLM, attachment, filesystem or upload calls may occur",
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
      new api.tools.ToolRuntime(scope, { mode: toolMode });
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
      if (useSubagents) {
        fs.resolve = async (path, options = {}) => {
          const target = resolve(options.cwd ?? project, path);
          assert.ok(
            target === project || target.startsWith(project + sep),
            "Only the disposable synthetic project is visible",
          );
          return target;
        };
        fs.stat = async (target) => {
          assert.ok(target === project || target.startsWith(project + sep));
          return { type: statSync(target).isDirectory() ? "directory" : "file" };
        };
        fs.processPath = (target) => target;
        // Keep the real child inside its first pre-step until public cancel
        // aborts it. No LLM preparation or transport is allowed to run.
        scope.on("agent/pre-step", async ({ signal }) => {
          preStepEntered.resolve();
          if (!signal.aborted)
            await new Promise((resolveAbort) =>
              signal.addEventListener("abort", resolveAbort, { once: true }),
            );
          return { kind: "reject" };
        });
      }
      if (!useAttachments) {
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
  if (useAttachments) await mount(api.attachmentLocal.LocalAttachmentStore, { dshHome: directory });
  if (useTodo) await mount(api.todo, { allowParallelInProgress: false });
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
  if (useSubagents) {
    await mount(api.directories.WorkingDirectoryService, { defaultDirectory: project });
    await mount(api.subagents.SubagentRuntime, { maxDepth: 2, maxActiveSubagents: 8 });
    await mount(api.spawn, { providerName: "spawn" });
    if (useSubagentControls) await mount(api.subagentControls);
  }
  const adapter = new DesktopSessions(ctx, store, {
    host: { supported: true, version: "0.2.1-rc.2", runtimeRoot },
    enabled: () => false,
  });
  t.after(() => adapter.close());
  const create = async () => {
    const created = await ctx.sessionController.create({ cwd: project });
    store.dispatch("workspaces.bind", { id: workspaceId, sessionId: created.sessionId });
    return ctx.agents.get(created.sessionId);
  };
  const beginTurn = (agent, turn, prompt) => {
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
  };
  const endTurn = (agent, turn) => {
    agent.session.append("step/end", { turn, step: 1, reason: { kind: "completed" } });
    agent.session.append("turn/end", { turn, reason: { kind: "completed" } });
  };
  const appendTurn = (agent, turn, prompt) => {
    beginTurn(agent, turn, prompt);
    endTurn(agent, turn);
  };
  const startChild = async (parent) => {
    const receipt = await ctx.subagents.startActivation({
      provider: "spawn",
      label: "Synthetic child creation",
      request: {
        parent,
        prompt: [{ type: "text", text: "Synthetic child input is never sent to a model" }],
        maxDepth: 2,
      },
      signal: new AbortController().signal,
      delivery: "caller",
    });
    const child = ctx.agents.get(receipt.childId);
    assert.ok(child, "The official activation must own a resident child");
    await preStepEntered.promise;
    assert.equal(child.status, "running");
    return { child, receipt };
  };
  return {
    api,
    ctx,
    adapter,
    store,
    workspaceId,
    directory,
    create,
    beginTurn,
    endTurn,
    appendTurn,
    startChild,
  };
}

test(
  "official send_message preserves its exact child input in an ignorable durable origin record",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true, subagentControls: true });
    const root = await f.create();
    f.beginTurn(root, 1, "Synthetic root creation input");
    const { child, receipt } = await f.startChild(root);
    f.endTurn(root, 1);
    const origins = new ChildOrigins(f.ctx, { supported: true, runtimeRoot }, () => true);
    t.after(() => origins.close());
    const send = async (turn, callId) => {
      f.beginTurn(root, turn, `Synthetic parent turn ${turn}`);
      const args = { agent_id: child.id, message: `Synthetic child follow-up ${turn}` };
      root.session.append(
        "assistant/message",
        {
          turn,
          step: 1,
          message: f.api.llm.createAssistantMessage({
            source: { provider: "synthetic-offline", model: "never-called" },
            content: [
              {
                type: "tool-call",
                id: callId,
                name: "send_message",
                arguments: JSON.stringify(args),
              },
            ],
          }),
          stream: [],
        },
        { surfaceOp: "append" },
      );
      const call = root.session.append("tool/call", {
        turn,
        step: 1,
        callId,
        name: "send_message",
        arguments: JSON.stringify(args),
      });
      const result = await f.ctx.tools.execute({
        agent: root,
        name: "send_message",
        arguments: args,
        callId,
        signal: new AbortController().signal,
      });
      assert.equal(result.isError, false);
      assert.equal(typeof result.value.messageId, "string");
      // The existing fixture owns synthetic parent turn/call/result envelopes.
      // Execute the real tool and preserve exactly the fields AgentLoop commits.
      const logged = root.session.append(
        "tool/result",
        {
          turn,
          step: 1,
          message: f.api.llm.createToolResultMessage({
            callId,
            content: result.content,
            isError: result.isError,
          }),
          ...(result.meta === undefined ? {} : { meta: result.meta }),
        },
        { surfaceOp: "append", sourceEventSeqs: [call.seq] },
      );
      f.endTurn(root, turn);
      return { call, result, logged };
    };

    const untracked = await send(2, "synthetic-untracked-send");
    assert.equal(
      root.session.snapshotEvents().filter((event) => event.type === CHILD_INPUT_RECORD).length,
      0,
    );
    assert.ok(!JSON.stringify(untracked.logged).includes(untracked.result.value.messageId));
    assert.equal(untracked.result.meta, undefined);
    assert.deepEqual(untracked.logged.sourceEventSeqs, [untracked.call.seq]);

    assert.deepEqual(await origins.connect(), { state: "active" });
    const tracked = await send(3, "synthetic-tracked-send");
    const records = root.session
      .snapshotEvents()
      .filter((event) => event.type === CHILD_INPUT_RECORD);
    assert.equal(records.length, 1);
    const record = records[0];
    const parentEvents = root.session.snapshotEvents();
    const turnStart = parentEvents.find(
      (event) => event.type === "turn/start" && event.data.turn === 3,
    );
    const stepStart = parentEvents.find(
      (event) => event.type === "step/start" && event.data.turn === 3,
    );
    assert.deepEqual(record.data, {
      version: 1,
      parentSessionId: root.id,
      parentCreatedAt: root.session.header.createdAt,
      childSessionId: child.id,
      childCreatedAt: child.session.header.createdAt,
      messageId: tracked.result.value.messageId,
      callId: "synthetic-tracked-send",
      callSeq: tracked.call.seq,
      turnStartSeq: turnStart.seq,
      stepStartSeq: stepStart.seq,
    });
    const childInputs = child.session
      .snapshotEvents()
      .slice(child.session.inheritedEventCount)
      .flatMap((event) => (event.type === "agent/inbox/spliced" ? event.data.inserted : []))
      .filter((message) => message.id === record.data.messageId);
    assert.equal(childInputs.length, 1);
    assert.deepEqual(childInputs[0].source, {
      kind: "agent-message",
      form: "relay",
      senderSessionId: root.id,
    });
    assert.equal(record.ignorable, true);
    assert.equal(record.surfaceOp, undefined);
    assert.ok(!root.session.surface.nodes.includes(record.seq));
    assert.equal(f.api.sessions.deriveEventMessage(record), null);
    assert.ok(!JSON.stringify(record).includes("Synthetic child follow-up"));
    assert.ok(!JSON.stringify(tracked.logged).includes(record.data.messageId));

    await f.ctx.sessionPersistence.flush();
    const reader = await f.ctx.sessionPersistence.open(root.id, "read");
    try {
      const durable = await reader.read();
      assert.deepEqual(
        durable.events.filter((event) => event.type === CHILD_INPUT_RECORD),
        records,
      );
      assert.equal(reader.header.id, root.id);
    } finally {
      await reader.close();
    }
    const plan = await f.adapter.prepare({ sessionId: child.id, childOrigin: "latest" });
    assert.equal(plan.sessionId, root.id);
    assert.equal(plan.mapping.basis, "recorded-input");
    assert.equal(plan.mapping.requestedOrigin, "latest");
    assert.equal(plan.mapping.links[0].messageId, tracked.result.value.messageId);
    assert.equal(plan.mapping.links[0].callSeq, tracked.call.seq);
    assert.equal(
      plan.atSeq,
      parentEvents.findLast((event) => event.type === "turn/end" && event.data.turn === 2).seq,
    );
    assert.equal(plan.draft, "Synthetic parent turn 3");
    const rewound = await f.adapter.rewind({
      sessionId: child.id,
      childOrigin: "latest",
      draftBridgeReady: true,
    });
    assert.equal(rewound.sessionId, root.id);
    assert.equal(rewound.mapping.links[0].messageId, tracked.result.value.messageId);
    assert.equal(rewound.atSeq, plan.atSeq);
    assert.equal(rewound.draft, plan.draft);
    assert.equal(rewound.archived, true);
    assert.deepEqual(rewound.stop.pendingIds, []);
    assert.deepEqual(rewound.newSessionStop.pendingIds, []);
    const continuation = await f.ctx.sessionController.inspect(rewound.newSessionId);
    assert.deepEqual(
      continuation.events.slice(0, continuation.inheritedEventCount),
      parentEvents.slice(0, plan.atSeq + 1),
    );
    assert.ok(!continuation.events.some((event) => event.type === CHILD_INPUT_RECORD));
    await f.ctx.sessionPersistence.flush();
    const continuationReader = await f.ctx.sessionPersistence.open(rewound.newSessionId, "read");
    try {
      assert.deepEqual((await continuationReader.read()).events, continuation.events);
    } finally {
      await continuationReader.close();
    }
    origins.close();
    assert.deepEqual(origins.status(), { state: "available" });
    await receipt.dispose();
  },
);

test(
  "official cold-resumed send_message records the same immutable child identity",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true, subagentControls: true });
    const root = await f.create();
    f.beginTurn(root, 1, "Synthetic root creation input");
    const { child, receipt } = await f.startChild(root);
    f.endTurn(root, 1);
    await receipt.dispose();
    assert.equal(f.ctx.agents.get(child.id), undefined);
    const origins = new ChildOrigins(f.ctx, { supported: true, runtimeRoot }, () => true);
    t.after(() => origins.close());
    await origins.connect();
    f.beginTurn(root, 2, "Synthetic root task resuming the child");
    const args = { agent_id: child.id, message: "Synthetic cold-resume input" };
    root.session.append(
      "assistant/message",
      {
        turn: 2,
        step: 1,
        message: f.api.llm.createAssistantMessage({
          source: { provider: "synthetic-offline", model: "never-called" },
          content: [
            {
              type: "tool-call",
              id: "synthetic-cold-resume-send",
              name: "send_message",
              arguments: JSON.stringify(args),
            },
          ],
        }),
        stream: [],
      },
      { surfaceOp: "append" },
    );
    const call = root.session.append("tool/call", {
      turn: 2,
      step: 1,
      name: "send_message",
      callId: "synthetic-cold-resume-send",
      arguments: JSON.stringify(args),
    });
    const result = await f.ctx.tools.execute({
      agent: root,
      name: "send_message",
      callId: call.data.callId,
      arguments: args,
      signal: new AbortController().signal,
    });
    assert.equal(result.isError, false);
    root.session.append(
      "tool/result",
      {
        turn: 2,
        step: 1,
        message: f.api.llm.createToolResultMessage({
          callId: call.data.callId,
          content: result.content,
          isError: result.isError,
        }),
      },
      { surfaceOp: "append", sourceEventSeqs: [call.seq] },
    );
    f.endTurn(root, 2);
    const resumed = f.ctx.agents.get(child.id);
    assert.ok(resumed);
    assert.notEqual(resumed, child);
    assert.equal(resumed.session.header.createdAt, child.session.header.createdAt);
    const records = root.session
      .snapshotEvents()
      .filter((event) => event.type === CHILD_INPUT_RECORD);
    assert.equal(records.length, 1);
    assert.equal(records[0].data.childCreatedAt, child.session.header.createdAt);
    assert.equal(records[0].data.messageId, result.value.messageId);
    assert.equal(records[0].data.callSeq, call.seq);
    const plan = await f.adapter.prepare({ sessionId: child.id, childOrigin: "latest" });
    assert.equal(plan.sessionId, root.id);
    assert.equal(plan.mapping.basis, "recorded-input");
    assert.equal(plan.mapping.links[0].messageId, result.value.messageId);
    assert.equal(plan.mapping.links[0].callSeq, call.seq);
    assert.equal(plan.draft, "Synthetic root task resuming the child");
    assert.equal(
      root.session.snapshotEvents().filter((event) => event.type === "subagent/catalog").length,
      1,
      "Cold resume must not invent a second creation fact",
    );
    resumed.cancel({ kind: "user" });
    await resumed.whenIdle();
  },
);

test(
  "real managed child creation rewinds its root creation turn despite later root input",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true });
    const root = await f.create();
    f.appendTurn(root, 1, "Retained first root input");
    const retained = await f.ctx.sessionController.inspect(root.id);
    f.beginTurn(root, 2, "Root input that created the child\nRestore this exact draft.");
    const { child, receipt } = await f.startChild(root);
    f.endTurn(root, 2);
    f.appendTurn(root, 3, "Later root input must not select the rewind boundary");
    const notice = (text) =>
      f.api.llm.createUserMessage({
        source: { kind: "runtime-context" },
        content: [{ type: "text", text }],
      });
    root.inject(notice("Synthetic pending root input"));
    child.inject(notice("Synthetic pending child input"));
    assert.equal(root.inbox.nextStep.length, 1);
    assert.equal(child.inbox.nextStep.length, 1);
    const before = await f.ctx.sessionController.inspect(root.id);
    const childBefore = await f.ctx.sessionController.inspect(child.id);
    const catalog = before.events.filter(
      (event) => event.type === "subagent/catalog" && event.data.childId === child.id,
    );
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].data.childCreatedAt, childBefore.meta.createdAt);
    assert.equal(childBefore.meta.origin, "subagent");
    assert.equal(childBefore.meta.parentSession, root.id);
    const descriptor = f.api.subagents.foldSubagentDescriptor(
      childBefore.events.slice(childBefore.inheritedEventCount),
    );
    assert.equal(descriptor.mode, "continuable");
    assert.equal(descriptor.provider, "spawn");
    const plan = await f.adapter.prepare({ sessionId: child.id });
    assert.equal(plan.sessionId, root.id);
    assert.equal(plan.atSeq, retained.events.length - 1);
    assert.equal(plan.mapping.basis, "creation");
    assert.equal(plan.mapping.links[0].catalogSeq, catalog[0].seq);
    const result = await f.adapter.rewind({ sessionId: child.id, draftBridgeReady: true });
    assert.equal(result.sessionId, root.id);
    assert.equal(result.mapping.requestedSessionId, child.id);
    assert.equal(result.mapping.targetSessionId, root.id);
    assert.equal(result.strategy, "fork");
    assert.equal(result.draft, "Root input that created the child\nRestore this exact draft.");
    assert.equal(result.archived, true);
    assert.equal(result.binding.workspaceId, f.workspaceId);
    assert.deepEqual(result.stop.pendingIds, []);
    assert.ok(result.stop.settledIds.includes(root.id));
    assert.deepEqual(result.newSessionStop.pendingIds, []);
    assert.equal(root.status, "idle");
    assert.equal(child.status, "idle");
    for (const agent of [root, child, f.ctx.agents.get(result.newSessionId)]) {
      assert.equal(agent.inbox.nextStep.length, 0);
      assert.equal(agent.inbox.nextTurn.length, 0);
    }
    await receipt.result;
    const continuation = await f.ctx.sessionController.inspect(result.newSessionId);
    assert.equal(continuation.meta.parentSession, root.id);
    assert.equal(continuation.meta.origin, undefined);
    assert.equal(continuation.inheritedEventCount, retained.events.length);
    assert.deepEqual(continuation.events.slice(0, retained.events.length), retained.events);
    assert.equal(
      continuation.events.some(
        (event) => event.type === "subagent/catalog" && event.data.childId === child.id,
      ),
      false,
    );
    assert.deepEqual(
      (await f.ctx.sessionController.inspect(root.id)).events.slice(0, before.events.length),
      before.events,
      "The original root log remains an unchanged prefix",
    );
    assert.deepEqual(
      (await f.ctx.sessionController.inspect(child.id)).events.slice(0, childBefore.events.length),
      childBefore.events,
      "The original child log remains an unchanged prefix",
    );
    assert.equal(
      f.store.dispatch("workspaces.forSession", { sessionId: result.newSessionId }).item.id,
      f.workspaceId,
    );
    assert.ok(f.ctx.workspaceRegistry.archivedSessionIds.includes(root.id));
    await f.ctx.sessionPersistence.flush();
    const reader = await f.ctx.sessionPersistence.open(result.newSessionId, "read");
    try {
      assert.deepEqual((await reader.read()).events, continuation.events);
    } finally {
      await reader.close();
    }
  },
);

test(
  "real managed child from its root first turn rewinds to an empty ordinary continuation",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true });
    const root = await f.create();
    f.beginTurn(root, 1, "First root input that created a real managed child");
    const { child, receipt } = await f.startChild(root);
    f.endTurn(root, 1);
    const result = await f.adapter.rewind({ sessionId: child.id, draftBridgeReady: true });
    assert.equal(result.sessionId, root.id);
    assert.equal(result.mapping.basis, "creation");
    assert.equal(result.strategy, "empty");
    assert.equal(result.draft, "First root input that created a real managed child");
    assert.equal(result.archived, true);
    assert.deepEqual(result.stop.pendingIds, []);
    assert.deepEqual(result.newSessionStop.pendingIds, []);
    await receipt.result;
    const continuation = await f.ctx.sessionController.inspect(result.newSessionId);
    assert.equal(continuation.meta.cwd, join(f.directory, "project"));
    assert.equal(continuation.meta.parentSession, undefined);
    assert.equal(continuation.meta.origin, undefined);
    assert.equal(
      continuation.events.some((event) =>
        ["turn/start", "user/message", "subagent/catalog"].includes(event.type),
      ),
      false,
    );
    for (const agent of [root, child, f.ctx.agents.get(result.newSessionId)]) {
      assert.equal(agent.status, "idle");
      assert.equal(agent.inbox.nextStep.length, 0);
      assert.equal(agent.inbox.nextTurn.length, 0);
    }
    assert.equal(
      f.store.dispatch("workspaces.forSession", { sessionId: result.newSessionId }).item.id,
      f.workspaceId,
    );
  },
);

test(
  "duplicate own creation facts in a real managed parent reject before fork or archive",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true });
    const root = await f.create();
    f.beginTurn(root, 1, "Synthetic root input");
    const { child, receipt } = await f.startChild(root);
    const catalog = root.session
      .snapshotEvents()
      .find((event) => event.type === "subagent/catalog" && event.data.childId === child.id);
    root.session.append("subagent/catalog", catalog.data);
    f.endTurn(root, 1);
    const beforeIds = f.ctx.sessions.list().map((session) => session.id);
    const before = await f.ctx.sessionController.inspect(root.id);
    await assert.rejects(
      f.adapter.rewind({ sessionId: child.id, draftBridgeReady: true }),
      (error) => error.code === "AMBIGUOUS_REWIND_SOURCE",
    );
    assert.deepEqual(
      f.ctx.sessions.list().map((session) => session.id),
      beforeIds,
    );
    assert.deepEqual((await f.ctx.sessionController.inspect(root.id)).events, before.events);
    assert.equal(f.ctx.workspaceRegistry.archivedSessionIds.length, 0);
    assert.equal(child.status, "running", "Rejected preparation must not cancel original work");
    await receipt.dispose();
  },
);

test(
  "a real managed child from a schedule-only root turn cannot rewind an earlier human turn",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { subagents: true });
    const root = await f.create();
    f.appendTurn(root, 1, "Earlier human input does not own a later reminder turn");
    root.session.append("turn/start", { turn: 2 });
    root.session.append("step/start", { turn: 2, step: 1 });
    root.session.append(
      "user/message",
      f.api.llm.createUserMessage({
        source: { kind: "schedule" },
        content: [{ type: "text", text: "Synthetic automatic reminder" }],
      }),
      { surfaceOp: "append" },
    );
    const { child, receipt } = await f.startChild(root);
    f.endTurn(root, 2);
    const beforeIds = f.ctx.sessions.list().map((session) => session.id);
    await assert.rejects(
      f.adapter.prepare({ sessionId: child.id }),
      (error) => error.code === "NO_REWIND_BOUNDARY",
    );
    assert.deepEqual(
      f.ctx.sessions.list().map((session) => session.id),
      beforeIds,
    );
    assert.equal(f.ctx.workspaceRegistry.archivedSessionIds.length, 0);
    await receipt.dispose();
  },
);

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

test(
  "official LocalAttachmentStore restores only original human refs after a completed synthetic fork",
  optionalHost,
  async (t) => {
    const { api, ctx, adapter, create, appendTurn } = await fixture(t, { attachments: true });
    const original = await create();
    appendTurn(original, 1, "First input");
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const image = await ctx.attachments.saveImage({
      data: png,
      mediaType: "image/png",
      name: "synthetic.png",
    });
    const file = await ctx.attachments.saveFile({
      data: Uint8Array.from(Buffer.from("Synthetic local attachment bytes")),
      name: "synthetic.txt",
    });
    original.session.append("turn/start", { turn: 2 });
    original.session.append("step/start", { turn: 2, step: 1 });
    original.session.append(
      "user/message",
      api.llm.createUserMessage({
        source: { kind: "user" },
        content: [
          { type: "text", text: "Human input" },
          { type: "image", attachment: image },
          { type: "file", attachment: file },
        ],
      }),
      { surfaceOp: "append" },
    );
    original.session.append("step/end", { turn: 2, step: 1, reason: { kind: "completed" } });
    original.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
    const result = await adapter.rewind({
      sessionId: original.id,
      draftBridgeReady: true,
      draftBridgeSupports: { attachments: true },
    });
    assert.equal(result.archived, true);
    assert.deepEqual(
      result.attachmentBatch.items.map((item) => item.type),
      ["image", "file"],
    );
    const restoredImage = await adapter.attachment({
      token: result.attachmentBatch.token,
      index: 0,
      newSessionId: result.newSessionId,
    });
    const expectedImage = await ctx.attachments.readImage(image);
    assert.deepEqual(
      Buffer.from(restoredImage.item.contentBase64, "base64"),
      Buffer.from(expectedImage.data),
    );
    const restoredFile = await adapter.attachment({
      token: result.attachmentBatch.token,
      index: 1,
      newSessionId: result.newSessionId,
    });
    assert.equal(
      Buffer.from(restoredFile.item.contentBase64, "base64").toString(),
      "Synthetic local attachment bytes",
    );
    const child = await ctx.sessionController.inspect(result.newSessionId);
    assert.equal(
      child.events.some((event) =>
        event.data?.content?.some((part) => part.attachment?.attachmentId === file.attachmentId),
      ),
      false,
      "The removed human input is not smuggled into the child's log",
    );
    assert.deepEqual(adapter.releaseAttachments({ token: result.attachmentBatch.token }), {
      released: true,
    });
  },
);

test(
  "official todo projection follows the native fork prefix and turn reset without plugin state rewriting",
  optionalHost,
  async (t) => {
    const { api, ctx, adapter, create } = await fixture(t, { todo: true });
    for (const mode of ["turn", "step"]) {
      const original = await create();
      const first = [{ content: "First synthetic task", status: "completed" }];
      const second = [{ content: "Second synthetic task", status: "in_progress" }];
      const final = [{ content: "Later synthetic task", status: "pending" }];
      const start = (turn) => {
        original.session.append("turn/start", { turn });
        original.session.append("step/start", { turn, step: 1 });
        original.session.append(
          "user/message",
          api.llm.createUserMessage({
            source: { kind: "user" },
            content: [{ type: "text", text: `Synthetic turn ${turn}` }],
          }),
          { surfaceOp: "append" },
        );
      };
      const end = (turn) => {
        original.session.append("step/end", { turn, step: 1, reason: { kind: "completed" } });
        original.session.append("turn/end", { turn, reason: { kind: "completed" } });
      };
      const todos = (agent) =>
        ctx.sessionProjections.snapshot(agent.session, ["todos"]).values.todos;
      start(1);
      original.session.append("todo/write", { todos: first });
      end(1);
      assert.deepEqual(todos(original), first);
      start(2);
      assert.equal(todos(original), null, "Native turn/start resets the task projection");
      original.session.append("todo/write", { todos: second });
      original.session.append("step/end", { turn: 2, step: 1, reason: { kind: "completed" } });
      original.session.append("step/start", { turn: 2, step: 2 });
      original.session.append("todo/write", { todos: final });
      original.session.append("step/end", { turn: 2, step: 2, reason: { kind: "completed" } });
      original.session.append("turn/end", { turn: 2, reason: { kind: "completed" } });
      assert.deepEqual(todos(original), final);
      const result = await adapter.rewind({ sessionId: original.id, mode, draftBridgeReady: true });
      const child = ctx.agents.get(result.newSessionId);
      assert.deepEqual(todos(child), mode === "turn" ? first : second);
      assert.deepEqual(
        todos(original),
        final,
        "Archiving leaves the original history and projection intact",
      );
      assert.equal(
        (await ctx.sessionController.inspect(child.id)).events.filter(
          (event) => event.type === "todo/write",
        ).length,
        mode === "turn" ? 1 : 2,
      );
    }
  },
);

async function completedTodoStep(t, options = {}) {
  const f = await fixture(t, { todo: true, ...options });
  const original = await f.create();
  original.session.append("turn/start", { turn: 1 });
  original.session.append("step/start", { turn: 1, step: 1 });
  original.session.append(
    "user/message",
    f.api.llm.createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "Synthetic task with two steps" }],
    }),
    { surfaceOp: "append" },
  );
  const before = [
    { content: "Earlier complete task", status: "completed" },
    { content: "Affected task", status: "in_progress" },
    { content: "Unstarted task", status: "pending" },
  ];
  original.session.append("todo/write", { todos: before });
  original.session.append("step/end", { turn: 1, step: 1, reason: { kind: "completed" } });
  original.session.append("step/start", { turn: 1, step: 2 });
  const later = [
    before[0],
    { ...before[1], status: "completed" },
    before[2],
    { content: "Removed step only task", status: "completed" },
  ];
  original.session.append("todo/write", { todos: later });
  original.session.append("step/end", { turn: 1, step: 2, reason: { kind: "completed" } });
  original.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return {
    ...f,
    original,
    before,
    later,
    expected: [before[0], { ...before[1], status: "pending" }, before[2]],
    rewind: () =>
      f.adapter.rewind({ sessionId: original.id, mode: "step", draftBridgeReady: true }),
    todos: (id) =>
      f.ctx.sessionProjections.snapshot(f.ctx.agents.get(id).session, ["todos"]).values.todos,
  };
}

test(
  "step rewind uses native todo_write to reset only a retained task whose completion was cut",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    const result = await f.rewind();
    assert.deepEqual(result.todoReset, {
      requested: true,
      plannedCount: 1,
      verified: true,
      resetCount: 1,
    });
    assert.deepEqual(f.todos(result.newSessionId), f.expected);
    assert.deepEqual(f.todos(f.original.id), f.later);
    const child = f.ctx.agents.get(result.newSessionId);
    const reader = await f.ctx.sessionPersistence.open(result.newSessionId, "read");
    try {
      const log = await reader.read();
      assert.deepEqual(
        log.events.filter((event) => event.type === "todo/write").at(-1).data.todos,
        f.expected,
      );
    } finally {
      await reader.close();
    }
    assert.doesNotMatch(
      JSON.stringify(child.session.deriveMessages()),
      /dsh-unlimit-rewind-|Removed step only task/,
    );
    assert.equal(
      child.session
        .snapshotEvents()
        .some((event) => event.type === "tool/call" || event.type === "tool/result"),
      false,
    );
    child.session.append("turn/start", { turn: 2 });
    assert.equal(f.todos(child.id), null, "The next native turn still owns its own task list");
  },
);

test(
  "todo tool denial prevents source archiving and reports the created branch",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    f.ctx.on("tools/pre-execute", (exec) =>
      exec.name === "todo_write" ? { kind: "deny", reason: "Synthetic refusal" } : undefined,
    );
    await assert.rejects(f.rewind(), (error) => {
      assert.equal(error.code, "REWIND_PARTIAL");
      assert.equal(error.partial.failedAt, "reset-todos");
      assert.equal(error.partial.todoReset.verified, false);
      assert.deepEqual(f.todos(error.partial.newSessionId), f.before);
      assert.equal(error.partial.archived, false);
      return true;
    });
  },
);

test(
  "a post-write tool refusal preserves truthful partial todo readback without archiving",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    f.ctx.on("tools/post-execute", (exec) =>
      exec.name === "todo_write"
        ? { kind: "block", feedback: [{ type: "text", text: "Synthetic post refusal" }] }
        : undefined,
    );
    await assert.rejects(f.rewind(), (error) => {
      assert.equal(error.partial.failedAt, "reset-todos");
      assert.equal(error.partial.todoReset.verified, true);
      assert.equal(error.partial.todoReset.resetCount, 1);
      assert.deepEqual(f.todos(error.partial.newSessionId), f.expected);
      assert.equal(error.partial.archived, false);
      return true;
    });
  },
);

test(
  "PTC todo rewind rejects before creating a branch or changing the source",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t, { toolMode: "ptc" });
    const before = f.original.session.snapshotEvents();
    const fork = t.mock.method(f.ctx.sessionController, "fork");
    const create = t.mock.method(f.ctx.sessionController, "create");
    let executions = 0;
    f.ctx.on("tools/pre-execute", () => {
      executions++;
    });
    await assert.rejects(f.rewind(), { code: "TODO_RESET_UNSUPPORTED" });
    assert.equal(fork.mock.callCount(), 0);
    assert.equal(create.mock.callCount(), 0);
    assert.equal(executions, 0);
    assert.deepEqual(f.original.session.snapshotEvents(), before);
    assert.deepEqual(f.todos(f.original.id), f.later);
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
  },
);

test(
  "a durable but malformed branch journal cannot confirm todo restoration or archive the source",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    const before = f.original.session.snapshotEvents();
    f.ctx.on("tools/post-execute", (exec) => {
      if (exec.name !== "todo_write") return;
      // Fault injection: an idle fork has no open turn. The writer accepts
      // this event, but the official persistence reader must reject it.
      exec.agent.session.append("step/start", { turn: 2, step: 1 });
    });
    let childId;
    await assert.rejects(f.rewind(), (error) => {
      assert.equal(error.code, "REWIND_PARTIAL");
      assert.equal(error.partial.failedAt, "reset-todos");
      assert.equal(error.partial.todoReset.verified, false);
      assert.equal(error.partial.todoReset.resetCount, 0);
      assert.equal(error.partial.archived, false);
      childId = error.partial.newSessionId;
      assert.deepEqual(f.todos(childId), f.expected, "An in-memory write is not durable validity");
      assert.match(error.message, /stored log is corrupt/);
      return true;
    });
    await assert.rejects(
      f.ctx.sessionPersistence.open(childId, "read"),
      /step\/start does not match the open turn and next step/,
    );
    assert.deepEqual(f.original.session.snapshotEvents(), before);
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, []);
  },
);

test(
  "new branch input accepted during todo policy evaluation cancels restoration before write",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    f.ctx.on("tools/pre-execute", (exec) => {
      if (exec.name !== "todo_write") return;
      exec.agent.session.append(
        "user/message",
        f.api.llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "Synthetic later user input" }],
        }),
        { surfaceOp: "append" },
      );
      return { kind: "allow" };
    });
    await assert.rejects(f.rewind(), (error) => {
      assert.equal(error.partial.todoReset.verified, false);
      assert.equal(error.partial.archived, false);
      assert.deepEqual(f.todos(error.partial.newSessionId), f.before);
      assert.match(
        JSON.stringify(f.ctx.agents.get(error.partial.newSessionId).session.deriveMessages()),
        /Synthetic later user input/,
      );
      return true;
    });
  },
);

test(
  "closing the session adapter cancels a pending todo policy before its write",
  optionalHost,
  async (t) => {
    const f = await completedTodoStep(t);
    f.ctx.on("tools/pre-execute", (exec) => {
      if (exec.name !== "todo_write") return;
      f.adapter.close();
      return { kind: "allow" };
    });
    await assert.rejects(f.rewind(), (error) => {
      assert.equal(error.partial.todoReset.verified, false);
      assert.equal(error.partial.archived, false);
      assert.deepEqual(f.todos(error.partial.newSessionId), f.before);
      return true;
    });
  },
);
