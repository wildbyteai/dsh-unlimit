import test from "node:test";
import assert from "node:assert/strict";
import { NativeInstructions } from "../src/host/native-instructions.js";
import { selectedRule, usesWorkspaceInstructions } from "../src/core/prompts.js";

const user = (text, kind = "user") => ({
  id: text,
  role: "user",
  source: { kind, ...(kind === "agent-instructions" ? { form: "instructions" } : {}) },
  content: [{ type: "text", text }],
});

function fixture(t) {
  const listeners = new Map();
  const sessions = [];
  const config = { enabled: true, workspacePolicy: "strict", prompt: "" };
  const library = { items: [], activeId: null };
  const runtime = {
    ctx: {
      sessions: { list: () => sessions },
      on(name, callback, options) {
        assert.equal(options.prepend, true);
        assert.ok(!listeners.has(name));
        listeners.set(name, callback);
        return () => listeners.delete(name);
      },
    },
    host: { supported: true },
    settings: () => config,
    store: {
      dispatch(action) {
        assert.equal(action, "rules.list");
        return library;
      },
    },
  };
  const control = new NativeInstructions(runtime);
  // Unit fixture bypasses only the file/version gate. Official host tests
  // exercise the real gate, producer, event store, loop and persistence.
  control.supported = () => null;
  const agents = [];
  const agent = (model = "synthetic-model") => {
    const events = [];
    const nodes = [];
    let failWrite = false;
    const effects = new Set();
    const session = {
      id: `synthetic-${sessions.length}`,
      surface: { nodes },
      eventAt: (seq) => events[seq],
      append(type, data, options) {
        if (failWrite) throw new Error("synthetic write rejected");
        const event = structuredClone({ type, data, ...options, seq: events.length });
        if (options.surfaceOp === "append") nodes.push(event.seq);
        else {
          const index = nodes.indexOf(options.surfaceOp.startSeq);
          assert.notEqual(index, -1, "Replacement may target only a visible node");
          assert.equal(options.surfaceOp.endSeq, options.surfaceOp.startSeq);
          nodes.splice(index, 1, event.seq);
        }
        events.push(event);
        return event;
      },
    };
    const owner = {
      session,
      options: { model },
      ctx: {
        effect(create) {
          const cleanup = create();
          const dispose = () => {
            if (!effects.delete(dispose)) return;
            cleanup();
          };
          effects.add(dispose);
          return dispose;
        },
      },
      dispose() {
        for (const dispose of [...effects]) dispose();
      },
      set failWrite(value) {
        failWrite = value;
      },
      events,
      visible: () => nodes.map((seq) => events[seq]),
    };
    sessions.push(session);
    agents.push(owner);
    return owner;
  };
  const enter = async (owner, decision, next = async () => decision, signal) => {
    const context = {
      agent: owner,
      turn: 2,
      step: 1,
      signal: signal ?? new AbortController().signal,
    };
    const entered = await listeners.get("agent/pre-step")(context, next);
    if (entered.kind === "enter" && listeners.has("agent/request"))
      await listeners.get("agent/request")(context, async () => ({}));
    return entered;
  };
  t.after(() => {
    for (const owner of agents) owner.failWrite = false;
    control.revert();
  });
  control.apply();
  return { control, runtime, config, library, listeners, agent, enter };
}

test("workspace eligibility shares the actual model/activity/prompt precedence", () => {
  const library = {
    items: [
      { id: "active", content: "global" },
      { id: "model", model: "a", content: "  " },
    ],
    activeId: "active",
  };
  assert.equal(selectedRule(library, "a").id, "model");
  assert.equal(selectedRule(library, "b").id, "active");
  const settings = { workspacePolicy: "fallback", prompt: "" };
  assert.equal(usesWorkspaceInstructions(settings, selectedRule(library, "a")), true);
  assert.equal(usesWorkspaceInstructions(settings, selectedRule(library, "b")), false);
  assert.equal(usesWorkspaceInstructions({ ...settings, prompt: "saved" }), false);
  assert.equal(usesWorkspaceInstructions({ ...settings, workspacePolicy: "always" }), true);
  assert.equal(usesWorkspaceInstructions({ ...settings, workspacePolicy: "strict" }), false);
});

test("strict targets only exact native attribution; repeated steps do not duplicate masks", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  const history = [
    user("Native baseline", "agent-instructions"),
    user("Human text containing agent-instructions"),
    user("Runtime data", "runtime-context"),
    {
      ...user("Unknown native form", "agent-instructions"),
      source: { kind: "agent-instructions" },
    },
  ];
  for (const message of history) a.session.append("user/message", message, { surfaceOp: "append" });
  const initial = structuredClone(a.events);
  const messages = [user("Current human"), user("New native", "agent-instructions")];
  const decision = { kind: "enter", messages, startsRequestSeries: true };
  const result = await f.enter(a, decision);
  assert.deepEqual(result, { ...decision, messages: [messages[0]] });
  assert.equal(decision.messages, messages);
  assert.deepEqual(a.events.slice(0, initial.length), initial, "Raw log is immutable");
  assert.equal(a.events.length, initial.length + 1);
  assert.equal(a.visible()[0].type, "developer/message");
  assert.equal(a.visible()[0].data.message.content.length, 0);
  assert.deepEqual(
    a
      .visible()
      .slice(1)
      .map((event) => event.data),
    history.slice(1),
  );
  await f.enter(a, decision);
  assert.equal(a.events.length, initial.length + 1, "Already hidden history is not rewritten");
  f.config.workspacePolicy = "always";
  let observed;
  const keep = await f.enter(a, decision, async () => {
    observed = a.visible().map((event) => event.data);
    return decision;
  });
  assert.equal(keep, decision);
  assert.deepEqual(observed, history, "Producer sees restored baseline before composing");
  assert.deepEqual(
    a.visible().map((event) => event.data),
    history,
  );
});

test("fallback differs by model while concurrent steps preserve their own selections", async (t) => {
  const f = fixture(t);
  f.config.workspacePolicy = "fallback";
  f.library.items.push({ id: "a-rule", model: "a", content: "operator rule" });
  const a = f.agent("a");
  const b = f.agent("b");
  const native = user("Native", "agent-instructions");
  for (const owner of [a, b]) owner.session.append("user/message", native, { surfaceOp: "append" });
  let resumeA;
  const aPending = f.enter(a, null, () => new Promise((resolve) => (resumeA = resolve)));
  const decision = { kind: "enter", messages: [native, user("human")] };
  assert.equal(await f.enter(b, decision), decision);
  resumeA(decision);
  assert.deepEqual((await aPending).messages, [decision.messages[1]]);
  assert.equal(a.visible()[0].type, "developer/message");
  assert.equal(b.visible()[0].type, "user/message");
});

test("native rejection and cancellation do not become success or hide history", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  a.session.append("user/message", user("Native", "agent-instructions"), { surfaceOp: "append" });
  const reject = { kind: "reject", reason: "Synthetic native denial" };
  assert.equal(await f.enter(a, reject), reject);
  assert.equal(a.events.length, 1);
  const abort = new AbortController();
  await assert.rejects(
    f.enter(
      a,
      null,
      async () => {
        abort.abort();
        return { kind: "enter", messages: [user("human")] };
      },
      abort.signal,
    ),
    { name: "AbortError" },
  );
  assert.equal(a.events.length, 1);
});

test("revert during an awaited hook leaves no later mutation or detached lifecycle effect", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  a.session.append("user/message", user("Native", "agent-instructions"), { surfaceOp: "append" });
  let resume;
  const pending = f.enter(a, null, () => new Promise((resolve) => (resume = resolve)));
  f.control.revert();
  const decision = { kind: "enter", messages: [user("human")] };
  resume(decision);
  assert.equal(await pending, decision);
  a.dispose();
  assert.equal(a.events.length, 1);
  assert.equal(f.listeners.size, 0);
});

test("restoration respects a later compaction and is retryable after a write failure", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  const b = f.agent();
  for (const owner of [a, b]) {
    owner.session.append("user/message", user("Native", "agent-instructions"), {
      surfaceOp: "append",
    });
    await f.enter(owner, { kind: "enter", messages: [user("human")] });
  }
  const marker = a.visible()[0];
  a.session.append("user/message", user("External summary", "compaction"), {
    surfaceOp: { op: "replace", startSeq: marker.seq, endSeq: marker.seq },
    sourceEventSeqs: [marker.seq],
  });
  b.failWrite = true;
  assert.throws(() => f.control.revert(), /未能恢复/);
  assert.deepEqual(a.visible()[0].data, user("External summary", "compaction"));
  assert.equal(b.visible()[0].type, "developer/message");
  b.failWrite = false;
  f.control.revert();
  assert.deepEqual(b.visible()[0].data, user("Native", "agent-instructions"));
});

test("agent scope cleanup restores before release and unknown desktop contexts stay unsupported", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  a.session.append("user/message", user("Native", "agent-instructions"), { surfaceOp: "append" });
  await f.enter(a, { kind: "enter", messages: [user("human")] });
  a.dispose();
  assert.deepEqual(a.visible()[0].data, user("Native", "agent-instructions"));
  const unavailable = new NativeInstructions({
    ...f.runtime,
    host: { kind: "preview", supported: false },
  });
  unavailable.apply();
  assert.equal(unavailable.capabilities()[0].state, "unsupported");
});

test("failed cleanup never writes to an unloaded session and retries through its loaded replacement", async (t) => {
  const f = fixture(t);
  const a = f.agent();
  const message = user("Native", "agent-instructions");
  a.session.append("user/message", message, { surfaceOp: "append" });
  await f.enter(a, { kind: "enter", messages: [user("human")] });
  a.failWrite = true;
  assert.throws(() => a.dispose(), /write rejected/);
  a.failWrite = false;

  const loaded = f.runtime.ctx.sessions.list();
  loaded.splice(loaded.indexOf(a.session), 1);
  const append = a.session.append.bind(a.session);
  let closedWriterCalls = 0;
  a.session.append = () => {
    closedWriterCalls++;
    throw new Error("closed writer");
  };
  assert.throws(() => f.control.revert(), /未能恢复/);
  assert.equal(closedWriterCalls, 0);
  assert.equal(f.control.capabilities()[0].state, "unsupported");
  assert.throws(() => f.control.apply(), /未确认恢复/);
  assert.equal(f.listeners.size, 0);

  loaded.push({ ...a.session, append });
  f.control.revert();
  assert.equal(closedWriterCalls, 0);
  assert.deepEqual(a.visible()[0].data, message);
  assert.equal(f.control.capabilities()[0].state, "available");
});
