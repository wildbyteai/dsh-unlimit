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
import { DesktopRuntime } from "../src/host/runtime.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const officialOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME to official 0.2.1-rc.2; no profile or running desktop is used",
  timeout: 15000,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function denyExternalExecution(t) {
  const attempts = [];
  const deny = (name) => () => {
    attempts.push(name);
    throw new Error(`Isolated steering test forbids ${name}`);
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
    assert.deepEqual(attempts, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function fixture(t) {
  denyExternalExecution(t);
  const root = realpathSync(runtimeRoot);
  const manifest = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const requireHost = createRequire(join(root, "package.json"));
  const evidence = [];
  const load = async (name) => {
    const filename = requireHost.resolve(name),
      path = relative(root, filename);
    const listed = manifest.files.find((file) => file.path === path);
    assert.ok(listed, `Missing official entry ${name}`);
    const sha256 = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(sha256, listed.sha256, `Refusing modified official module ${name}`);
    evidence.push({ name, path, sha256 });
    return import(pathToFileURL(filename).href);
  };
  const names = {
    cordis: "@deepseek-ai/cordis",
    prompt: "@deepseek-ai/dsh-system-prompt",
    projections: "@deepseek-ai/dsh-session-projection",
    sessions: "@deepseek-ai/dsh-session",
    agents: "@deepseek-ai/dsh-agent",
    llm: "@deepseek-ai/dsh-llm",
    tools: "@deepseek-ai/dsh-tools",
    loop: "@deepseek-ai/dsh-agent-loop",
    cosmokit: "@deepseek-ai/cosmokit",
    approval: "@deepseek-ai/dsh-user-approval",
    sandbox: "@deepseek-ai/dsh-sandbox-policy",
    persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
  };
  const api = Object.fromEntries(
    await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
  );
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-steering-official-")));
  const ctx = new api.cordis.Context();
  const settings = {
    enabled: true,
    prompt: "SYNTHETIC_OPERATOR_A",
    promptMode: "replace",
    workspacePolicy: "strict",
    workspaceFiles: [],
    fullAccess: false,
    autoApprove: false,
    maxDepth: 3,
    maxSubagents: 3,
  };
  const reads = [],
    requests = [],
    errors = [];
  const started = Promise.withResolvers(),
    release = Promise.withResolvers();
  let toolSignal, agent, runtime, owner, persistenceFiber;
  const store = {
    dispatch(action) {
      reads.push(action);
      if (action === "settings.get") return { value: settings };
      if (action === "rules.list") return { items: [], activeId: null };
      throw new Error(`Unexpected store action ${action}`);
    },
  };
  class SyntheticAdapter extends api.llm.LlmAdapter {
    async *stream(options) {
      const position = agent.phase;
      requests.push({
        turn: position.turn,
        step: position.step,
        cursor: agent.session.seq - 1,
        messages: structuredClone(options.messages),
        tools: structuredClone(options.tools),
        header: structuredClone(agent.session.requestHeader()),
        provider: options.provider,
        model: options.model,
      });
      if (requests.length === 1) {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: "synthetic-slow-call",
          name: "synthetic_slow",
          argumentsDelta: "{}",
        };
      } else
        yield { type: "text-delta", index: 0, text: `Synthetic completion ${requests.length}.` };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  t.after(async () => {
    try {
      agent?.cancel({ kind: "user" });
      release.resolve();
      await agent?.whenIdle();
      runtime?.revert();
      await owner?.dispose();
      await persistenceFiber?.dispose();
      await ctx.fiber.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  owner = ctx.plugin({
    name: "synthetic-steering-services",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "SYNTHETIC_HOST_PERSONA",
        personaSuffix: "",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.agents.AgentRegistry(scope);
      new api.llm.LlmRuntime(scope);
      new api.tools.ToolRuntime(scope);
      new api.approval.ApprovalService(scope, { policy: "ask" });
      new api.sandbox.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: directory });
      new api.loop.AgentLoop(scope, {
        agents: [],
        maxParallelToolCalls: api.cosmokit.createVolatile(1),
      });
      scope.llm.registerAdapter(["synthetic-offline"], new SyntheticAdapter());
      scope.systemPrompt.context({
        name: "synthetic-context",
        order: 100,
        required: true,
        text: "SYNTHETIC_RUNTIME_CONTEXT",
      });
      scope.tools.register(
        api.tools.defineTool({
          name: "synthetic_slow",
          description: "Wait on an in-process test gate; no I/O or commands.",
          parameters: {},
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          async execute(_args, exec) {
            toolSignal = exec.signal;
            started.resolve();
            await Promise.race([
              release.promise,
              new Promise((resolve) => {
                if (exec.signal.aborted) resolve();
                else exec.signal.addEventListener("abort", resolve, { once: true });
              }),
            ]);
            exec.signal.throwIfAborted();
            return "SYNTHETIC_SLOW_RESULT";
          },
        }),
      );
      scope.on("agent/error", ({ error }) => errors.push(error));
    },
  });
  await owner.await();
  assert.equal(owner.state, 2);
  persistenceFiber = ctx.plugin(api.persistence, {
    root: join(directory, "logs"),
    compression: "none",
    listConcurrency: 1,
  });
  await persistenceFiber.await();
  assert.equal(persistenceFiber.state, 2);
  runtime = new DesktopRuntime(ctx, store, {
    supported: true,
    version: manifest.release.version,
    runtimeRoot: root,
  });
  runtime.apply();
  assert.equal(runtime.capabilities().find((item) => item.id === "prompt").state, "active");
  assert.equal(runtime.capabilities().find((item) => item.id === "promptRetry").state, "active");
  agent = await ctx.agentLoop.create(
    "synthetic-steering",
    { provider: "synthetic-offline", model: "synthetic-model", maxTokens: 128 },
    { cwd: directory },
  );
  const message = (text, kind = "user") =>
    api.llm.createUserMessage({ source: { kind }, content: [{ type: "text", text }] });
  const begin = async () => {
    agent.followup(message("SYNTHETIC_INITIAL_HUMAN"));
    await started.promise;
    assert.equal(agent.status, "running");
    assert.equal(requests.length, 1);
    assert.ok(
      requests[0].messages.some(
        (message) =>
          message.role === "system" &&
          message.content.some((block) => block.text === "SYNTHETIC_OPERATOR_A"),
      ),
      "The first real AgentLoop request uses the enabled plugin prompt",
    );
  };
  const drain = async () => {
    await agent.whenIdle();
    await tick();
    assert.equal(agent.status, "idle");
  };
  const verify = async () => {
    const events = agent.session.snapshotEvents();
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(agent.id, "read");
    let stored;
    try {
      stored = await reader.read();
    } finally {
      await reader.close();
    }
    assert.deepEqual(
      stored.events,
      events,
      "Physical temporary JSONL equals every committed event",
    );
    for (const request of requests) {
      const prefix = api.sessions.Session.create(
        agent.id,
        stored.events.slice(0, request.cursor + 1),
        agent.session.header,
      );
      assert.deepEqual(
        prefix.deriveMessages(),
        request.messages,
        "Complete model messages equal the official projection of that durable JSONL prefix",
      );
      assert.deepEqual(prefix.requestHeader(), request.header);
      assert.equal(request.provider, "synthetic-offline");
      assert.equal(request.model, "synthetic-model");
      assert.ok(request.tools.some((tool) => tool.name === "synthetic_slow"));
      assert.deepEqual(
        request.tools,
        requests[0].tools,
        "Prompt replacement retains full tool schemas",
      );
      assert.ok(
        request.messages.some(
          (m) =>
            m.source?.kind === "runtime-context" &&
            m.content.some((b) => b.text?.includes("SYNTHETIC_RUNTIME_CONTEXT")),
        ),
      );
      assert.ok(
        !request.messages.some((m) =>
          m.content.some((b) => b.text?.includes("SYNTHETIC_HOST_PERSONA")),
        ),
        "Enabled replacement actually affects every tested request",
      );
    }
    assert.equal(errors.length, 0, errors.map((error) => error.message).join("; "));
    assert.ok(reads.filter((action) => action === "rules.list").length >= requests.length);
    t.diagnostic(
      `Official ${manifest.release.version}; ${evidence.length} entry SHA256 checks; ${requests.length} complete requests reconstructed from temporary JSONL; no profile/network.`,
    );
    return events;
  };
  return {
    api,
    agent,
    requests,
    settings,
    message,
    begin,
    drain,
    release,
    verify,
    get toolSignal() {
      return toolSignal;
    },
  };
}

const texts = (request) =>
  request.messages.flatMap((message) =>
    message.content.filter((block) => block.type === "text").map((block) => block.text),
  );
const humanEvents = (events) =>
  events.filter((event) => event.type === "user/message" && event.data.source.kind === "user");
const userTurn = (events, text) => {
  const input = events.find(
    (event) =>
      event.type === "user/message" && event.data.content.some((block) => block.text === text),
  );
  return events.findLast((event) => event.type === "turn/start" && event.seq < input.seq).data.turn;
};

test(
  "enabled prompt injection preserves native next-step steering, ordered plugin attribution and complete request history",
  officialOnly,
  async (t) => {
    const f = await fixture(t);
    await f.begin();
    const plugin = f.message("SYNTHETIC_PLUGIN_CONTEXT", "dsh-unlimit/steering-fixture");
    const human = f.message("SYNTHETIC_STEER_HUMAN");
    f.agent.inject(plugin);
    f.agent.steer(human);
    assert.deepEqual(
      f.agent.inbox.nextStep.map((message) => message.id),
      [plugin.id, human.id],
    );
    assert.equal(f.requests.length, 1, "Steering waits for the active harmless tool boundary");
    f.settings.prompt = "SYNTHETIC_OPERATOR_B";
    f.release.resolve();
    await f.drain();
    assert.deepEqual(
      f.requests.map(({ turn, step }) => [turn, step]),
      [
        [1, 1],
        [1, 2],
      ],
    );
    assert.ok(texts(f.requests[1]).includes("SYNTHETIC_OPERATOR_B"));
    assert.ok(!texts(f.requests[1]).includes("SYNTHETIC_OPERATOR_A"));
    assert.ok(texts(f.requests[1]).includes("SYNTHETIC_SLOW_RESULT"));
    const messages = f.requests[1].messages;
    const pluginIndex = messages.findIndex((message) => message.id === plugin.id),
      humanIndex = messages.findIndex((message) => message.id === human.id);
    assert.ok(pluginIndex >= 0 && humanIndex > pluginIndex);
    assert.equal(messages[pluginIndex].source.kind, "dsh-unlimit/steering-fixture");
    assert.equal(messages[humanIndex].source.kind, "user");
    const events = await f.verify();
    assert.equal(events.filter((event) => event.type === "turn/start").length, 1);
    assert.equal(events.filter((event) => event.type === "turn/end").length, 1);
    assert.equal(
      humanEvents(events).length,
      2,
      "Runtime prompt/context and plugin input never become extra human inputs",
    );
    assert.equal(userTurn(events, "SYNTHETIC_STEER_HUMAN"), 1);
    assert.equal(f.agent.inbox.hasPending, false);
  },
);

test(
  "enabled prompt injection keeps followup queued for exactly one later turn rather than the next step",
  officialOnly,
  async (t) => {
    const f = await fixture(t);
    await f.begin();
    const followup = f.message("SYNTHETIC_NEXT_TURN_HUMAN");
    f.agent.followup(followup);
    assert.equal(f.agent.inbox.nextTurn[0].id, followup.id);
    assert.equal(f.agent.inbox.nextStep.length, 0);
    assert.equal(f.requests.length, 1);
    f.settings.prompt = "SYNTHETIC_OPERATOR_QUEUED";
    f.release.resolve();
    await f.drain();
    assert.deepEqual(
      f.requests.map(({ turn, step }) => [turn, step]),
      [
        [1, 1],
        [1, 2],
        [2, 1],
      ],
    );
    assert.equal(texts(f.requests[1]).includes("SYNTHETIC_NEXT_TURN_HUMAN"), false);
    assert.equal(
      texts(f.requests[2]).filter((text) => text === "SYNTHETIC_NEXT_TURN_HUMAN").length,
      1,
    );
    assert.ok(texts(f.requests[1]).includes("SYNTHETIC_OPERATOR_QUEUED"));
    assert.ok(texts(f.requests[2]).includes("SYNTHETIC_OPERATOR_QUEUED"));
    const events = await f.verify();
    assert.deepEqual(
      events.filter((event) => event.type === "turn/start").map((event) => event.data.turn),
      [1, 2],
    );
    assert.equal(humanEvents(events).length, 2);
    assert.equal(userTurn(events, "SYNTHETIC_NEXT_TURN_HUMAN"), 2);
    assert.equal(f.agent.inbox.hasPending, false);
  },
);

test(
  "cancel clears queued steering/followup, aborts the slow tool and inject cannot spuriously wake a stopped agent",
  officialOnly,
  async (t) => {
    const f = await fixture(t);
    await f.begin();
    f.agent.steer(f.message("SYNTHETIC_CANCELLED_STEER"));
    f.agent.followup(f.message("SYNTHETIC_CANCELLED_FOLLOWUP"));
    f.agent.inject(f.message("SYNTHETIC_CANCELLED_PLUGIN", "dsh-unlimit/steering-fixture"));
    f.agent.cancel({ kind: "user" });
    await f.drain();
    assert.equal(f.toolSignal.aborted, true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.agent.inbox.hasPending, false);
    f.release.resolve();
    await tick();
    assert.equal(f.requests.length, 1, "Late tool completion cannot wake another request");
    f.agent.inject(f.message("SYNTHETIC_IDLE_PLUGIN", "dsh-unlimit/steering-fixture"));
    await tick();
    assert.equal(f.agent.status, "idle");
    assert.equal(f.requests.length, 1, "inject is intentionally non-waking");
    assert.equal(f.agent.inbox.nextStep.length, 1);
    f.agent.cancel({ kind: "user" });
    assert.equal(f.agent.inbox.hasPending, false);
    f.settings.prompt = "SYNTHETIC_OPERATOR_AFTER_CANCEL";
    f.agent.followup(f.message("SYNTHETIC_EXPLICIT_RESUME"));
    await f.drain();
    assert.deepEqual(
      f.requests.map(({ turn, step }) => [turn, step]),
      [
        [1, 1],
        [2, 1],
      ],
    );
    assert.ok(texts(f.requests[1]).includes("SYNTHETIC_OPERATOR_AFTER_CANCEL"));
    assert.ok(
      !texts(f.requests[1]).some(
        (text) => text.startsWith("SYNTHETIC_CANCELLED_") || text === "SYNTHETIC_IDLE_PLUGIN",
      ),
    );
    const events = await f.verify();
    const ends = events.filter((event) => event.type === "turn/end");
    assert.deepEqual(
      ends.map((event) => event.data.reason.kind),
      ["aborted", "completed"],
    );
    assert.equal(humanEvents(events).length, 2);
    assert.ok(
      events.some((event) => event.type === "agent/inbox/spliced" && event.data.removedCount > 0),
    );
  },
);
