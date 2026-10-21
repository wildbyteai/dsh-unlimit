import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Continuation } from "../src/host/continuation.js";
import { SUPPORTED_HOST } from "../src/host/desktop.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const code = (expected) => (error) => error.code === expected;
const user = (text) => ({
  id: randomUUID(),
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-continuation-unit-")));
  const moduleRoot = join(root, "node_modules/@deepseek-ai/dsh-llm");
  mkdirSync(moduleRoot, { recursive: true });
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(moduleRoot, "package.json"),
    JSON.stringify({ type: "module", main: "index.js" }),
  );
  // Explicit synthetic construction boundary; official execution is tested separately.
  const moduleSource =
    'import {randomUUID} from "node:crypto"; export const createUserMessage = input => Object.freeze({...input,role:"user",id:randomUUID()});';
  writeFileSync(join(moduleRoot, "index.js"), moduleSource);
  const childModuleRoot = join(root, "node_modules/@deepseek-ai/dsh-subagent");
  mkdirSync(childModuleRoot, { recursive: true });
  writeFileSync(join(childModuleRoot, "package.json"), '{"type":"module","main":"index.js"}');
  const childModuleSource = "export {};";
  writeFileSync(join(childModuleRoot, "index.js"), childModuleSource);
  const manifestPath = join(root, "desktop-runtime.json");
  const manifest = {
    release: { version: SUPPORTED_HOST },
    files: [
      {
        path: "node_modules/@deepseek-ai/dsh-llm/index.js",
        sha256: createHash("sha256").update(moduleSource).digest("hex"),
      },
      {
        path: "node_modules/@deepseek-ai/dsh-subagent/index.js",
        sha256: createHash("sha256").update(childModuleSource).digest("hex"),
      },
    ],
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const value = {
    enabled: true,
    autoContinue: false,
    continueLimit: 2,
    continueText: "Synthetic continuation A",
  };
  const listeners = new Map(),
    agents = new Map();
  const emit = (name, ...args) => {
    for (const callback of [...(listeners.get(name) ?? [])]) callback(...args);
  };
  const deliveries = [];
  let holdDeliveries = false;
  const ctx = {
    subagents: {
      [Symbol.for("dsh.subagent.deliverPrompt")](parent, id, content, source, signal, mode) {
        const child = agents.get(id);
        const delivery = { parent, id, content, source, signal, mode, status: child.status };
        deliveries.push(delivery);
        const accept = () => {
          if (signal.aborted) return { accepted: false };
          const message = { id: randomUUID(), role: "user", source, content };
          child.inbox.splice("next-turn", child.inbox.nextTurn.length, 0, [message]);
          delivery.message = message;
          return { accepted: true, messageId: message.id };
        };
        if (!holdDeliveries) return Promise.resolve(accept());
        return new Promise((resolve) => {
          delivery.release = () => resolve(accept());
        });
      },
    },
    agents: { get: (id) => agents.get(id), list: () => [...agents.values()] },
    on(name, callback) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(callback);
      listeners.set(name, entries);
      return () => entries.delete(callback);
    },
  };
  const continuation = new Continuation(
    ctx,
    { dispatch: () => ({ value }) },
    { supported: true, runtimeRoot: root },
  );
  const createAgent = (id = "root", header = {}) => {
    const events = [];
    const session = {
      id,
      header,
      inheritedEventCount: 0,
      snapshotEvents: () => [...events],
      append(type, data) {
        const event = { seq: events.length, type, data };
        events.push(event);
        emit("session/event", session, event);
        return event;
      },
    };
    const queue = { "next-turn": [], "next-step": [] };
    const agent = {
      session,
      status: "idle",
      cancelled: 0,
      followups: [],
      inbox: {
        get nextTurn() {
          return queue["next-turn"];
        },
        get nextStep() {
          return queue["next-step"];
        },
        get hasPending() {
          return Object.values(queue).some((items) => items.length);
        },
        splice(target, start, removedCount, inserted) {
          const removed = queue[target].splice(start, removedCount, ...inserted);
          session.append("agent/inbox/spliced", { target, start, removedCount, inserted });
          return removed;
        },
      },
      followup(message) {
        agent.followups.push(message);
        agent.inbox.splice("next-turn", queue["next-turn"].length, 0, [message]);
      },
      cancel(...args) {
        agent.cancelled++;
        agent.cancelArgs = args;
        return "original-cancel";
      },
      finish(reason = { kind: "max-tokens" }) {
        const event = session.append("turn/end", { turn: 1, reason });
        agent.status = "idle";
        emit("agent/status", { agent, status: "idle" });
        return event;
      },
      consume() {
        const message = agent.inbox.splice("next-turn", 0, 1, [])[0];
        agent.status = "running";
        session.append("turn/start", { turn: 2 });
        session.append("user/message", message);
        return message;
      },
    };
    agents.set(id, agent);
    emit("agent/created", { agent });
    return agent;
  };
  t.after(() => {
    continuation.revert();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    continuation,
    value,
    ctx,
    listeners,
    agents,
    emit,
    createAgent,
    manifestPath,
    manifest,
    deliveries,
    holdDeliveries() {
      holdDeliveries = true;
    },
    startChild(child, { local = true, runId = randomUUID() } = {}) {
      child.status = "running";
      emit("subagent/start", { id: child.session.id, runId, local });
    },
  };
}

test("manual continuation is explicit, truncated-only and plugin-attributed rather than a forged human input", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  await f.continuation.apply();
  for (const reason of [
    { kind: "completed" },
    { kind: "error", error: { code: "TRANSPORT" } },
    { kind: "error", error: { code: "RATE_LIMIT" } },
    { kind: "error", error: { code: "AUTH" } },
    { kind: "aborted", reason: { kind: "user" } },
  ]) {
    agent.finish(reason);
    assert.throws(() => f.continuation.continue({ sessionId: "root" }), code("UNSUPPORTED"));
  }
  const end = agent.finish();
  assert.equal(f.continuation.status({ sessionId: "root" }).manualAvailable, true);
  const result = f.continuation.continue({ sessionId: "root" });
  assert.equal(result.submitted, true);
  assert.deepEqual(result.source, {
    kind: "dsh-unlimit/continuation",
    mode: "manual",
    triggerSeq: end.seq,
  });
  assert.equal(agent.followups[0].content[0].text, f.value.continueText);
  assert.equal(f.continuation.status({ sessionId: "root" }).automaticCount, 0);
  assert.throws(() => f.continuation.continue({ sessionId: "root" }), code("CONFLICT"));
});

test("automatic continuation is off by default, bounded, duplicate-safe and reads current wording", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  await f.continuation.apply();
  agent.finish();
  await tick();
  assert.equal(agent.followups.length, 0);
  f.value.autoContinue = true;
  const end = agent.finish();
  f.emit("session/event", agent.session, end);
  f.value.continueText = "Synthetic continuation B";
  await tick();
  assert.equal(agent.followups.length, 1);
  assert.equal(agent.followups[0].content[0].text, "Synthetic continuation B");
  agent.consume();
  agent.finish();
  await tick();
  assert.equal(agent.followups.length, 2);
  agent.consume();
  agent.finish();
  await tick();
  assert.equal(agent.followups.length, 2);
  assert.equal(f.continuation.status({ sessionId: "root" }).automaticCount, 2);
  agent.followup(user("A new real human input"));
  agent.consume();
  agent.finish();
  await tick();
  assert.equal(agent.followups.length, 4, "one human plus one fresh automatic continuation");
  assert.equal(f.continuation.status({ sessionId: "root" }).automaticCount, 1);
});

test("native stop, disabling and a new human input cancel a pending continuation without a double send", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  f.value.autoContinue = true;
  await f.continuation.apply();
  agent.finish();
  assert.equal(agent.cancel({ kind: "user" }), "original-cancel");
  await tick();
  assert.equal(agent.followups.length, 0);
  assert.equal(agent.cancelled, 1);
  assert.throws(() => f.continuation.continue({ sessionId: "root" }), code("UNSUPPORTED"));
  agent.followup(user("Reset stop"));
  agent.consume();
  agent.finish();
  f.value.enabled = false;
  f.continuation.changed();
  await tick();
  assert.equal(agent.followups.length, 1);
  f.value.enabled = true;
  agent.followup(user("New input"));
  agent.consume();
  agent.finish();
  agent.followup(user("Replace imminent continuation"));
  await tick();
  assert.equal(agent.followups.length, 3);
  assert.equal(agent.inbox.nextTurn.length, 1);
  assert.equal(agent.inbox.nextTurn[0].source.kind, "user");
});

test("stop removes only owned queued input and cancels only a provably owned automatic running turn", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  f.value.autoContinue = true;
  await f.continuation.apply();
  agent.finish();
  await tick();
  agent.followup(user("Unrelated queued task"));
  const queued = f.continuation.stop({ sessionId: "root" });
  assert.equal(queued.ownedQueuedRemoved, 1);
  assert.equal(agent.cancelled, 0);
  assert.equal(agent.inbox.nextTurn[0].source.kind, "user");
  agent.consume();
  agent.finish();
  await tick();
  agent.consume();
  assert.equal(f.continuation.stop({ sessionId: "root" }).ownedRunCancelled, true);
  assert.equal(agent.cancelled, 1);
  agent.status = "idle";
  agent.followup(user("Human task"));
  agent.consume();
  assert.equal(f.continuation.stop({ sessionId: "root" }).ownedRunCancelled, false);
  assert.equal(agent.cancelled, 1);
});

test("zero limit, unsupported child sessions and missing capabilities are explicit", async (t) => {
  const f = fixture(t),
    agent = f.createAgent(),
    child = f.createAgent("child", { parentSession: "root", origin: "subagent" });
  f.value.autoContinue = true;
  f.value.continueLimit = 0;
  await f.continuation.apply();
  agent.finish();
  child.finish();
  await tick();
  assert.equal(agent.followups.length, 0);
  assert.equal(child.followups.length, 0);
  assert.throws(() => f.continuation.continue({ sessionId: "child" }), code("UNSUPPORTED"));
  assert.match(f.continuation.status({ sessionId: "child" }).unsupportedReason, /手动/);
  f.continuation.continue({ sessionId: "root" });
  assert.equal(agent.followups.length, 1, "manual action is not an automatic quota");
  const noHost = new Continuation({}, { dispatch: () => ({ value: f.value }) }, {});
  assert.ok(noHost.capabilities().every((item) => item.state === "unsupported"));
  await assert.rejects(noHost.apply(), code("UNSUPPORTED"));
});

test("revert restores exact cancel ownership, preserves later replacements and rolls back a partial apply", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  const before = Object.getOwnPropertyDescriptor(agent, "cancel");
  await f.continuation.apply();
  const wrapper = agent.cancel;
  await f.continuation.apply();
  assert.equal(agent.cancel, wrapper);
  f.continuation.revert();
  assert.deepEqual(Object.getOwnPropertyDescriptor(agent, "cancel"), before);
  const bad = f.createAgent("immutable");
  Object.defineProperty(bad, "cancel", { writable: false, configurable: false });
  await assert.rejects(f.continuation.apply(), code("UNSUPPORTED"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(agent, "cancel"), before);
  assert.ok([...f.listeners.values()].every((entries) => entries.size === 0));
  f.agents.delete("immutable");
  await f.continuation.apply();
  const external = () => "external owner";
  agent.cancel = external;
  assert.throws(
    () => f.continuation.revert(),
    (error) =>
      error instanceof AggregateError && error.errors.some((item) => item.code === "CONFLICT"),
  );
  assert.equal(agent.cancel, external);
  assert.ok([...f.listeners.values()].every((entries) => entries.size === 0));
});

test("revert during module loading cancels installation and permits a fresh apply", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  const before = Object.getOwnPropertyDescriptor(agent, "cancel");
  const loading = f.continuation.apply();
  f.continuation.revert();
  await assert.rejects(loading, code("CANCELLED"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(agent, "cancel"), before);
  assert.ok([...f.listeners.values()].every((entries) => entries.size === 0));
  await f.continuation.apply();
  assert.notEqual(agent.cancel, before.value);
  agent.finish();
  assert.equal(f.continuation.status({ sessionId: "root" }).manualAvailable, true);
});

test("invalid inventory leaves no hooks and a repaired inventory can be applied", async (t) => {
  const f = fixture(t),
    agent = f.createAgent();
  const before = Object.getOwnPropertyDescriptor(agent, "cancel");
  writeFileSync(f.manifestPath, JSON.stringify({ release: { version: "unsupported" }, files: [] }));
  assert.ok(f.continuation.capabilities().every((item) => item.state === "unsupported"));
  await assert.rejects(f.continuation.apply(), (error) => {
    assert.equal(error.code, "UNSUPPORTED");
    assert.match(error.message, /发行版本与适配版本不一致/);
    return true;
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(agent, "cancel"), before);
  assert.equal(f.listeners.size, 0);
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.ok(f.continuation.capabilities().every((item) => item.state === "available"));
  await f.continuation.apply();
  assert.notEqual(agent.cancel, before.value);
});

async function managedChild(t) {
  const f = fixture(t);
  f.value.autoContinue = true;
  const parent = f.createAgent();
  const child = f.createAgent("child", { parentSession: "root", origin: "subagent" });
  await f.continuation.apply();
  f.startChild(child);
  return { ...f, parent, child };
}

test("managed child max-tokens synchronously queues official automatic delivery at the idle event", async (t) => {
  const f = await managedChild(t);
  f.value.continueText = "Current child continuation";
  const end = f.child.finish();
  assert.equal(
    f.deliveries.length,
    1,
    "delivery starts during agent/status idle, before an immediate callback",
  );
  const delivery = f.deliveries[0];
  assert.equal(delivery.status, "idle");
  assert.equal(delivery.parent, f.parent);
  assert.equal(delivery.id, "child");
  assert.equal(delivery.mode, "queue");
  assert.ok(delivery.signal instanceof AbortSignal);
  assert.deepEqual(delivery.content, [{ type: "text", text: "Current child continuation" }]);
  assert.deepEqual(delivery.source, {
    kind: "dsh-unlimit/continuation",
    mode: "automatic",
    triggerSeq: end.seq,
  });
  assert.equal(f.child.followups.length, 0, "child input never uses root followup");
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
  assert.equal(f.continuation.status({ sessionId: "child" }).manualAvailable, false);
  assert.throws(() => f.continuation.continue({ sessionId: "child" }), code("UNSUPPORTED"));
  f.emit("session/event", f.child.session, end);
  await tick();
  assert.equal(f.deliveries.length, 1, "same max-tokens trigger is submitted once");
});

test("managed child automatically continues only max-tokens and obeys current enable, source and limit", async (t) => {
  const f = await managedChild(t);
  for (const reason of [
    { kind: "completed" },
    { kind: "error", error: { code: "RATE_LIMIT" } },
    { kind: "aborted", reason: { kind: "user" } },
  ]) {
    f.child.finish(reason);
    assert.equal(f.deliveries.length, 0);
  }
  f.value.continueLimit = 0;
  f.child.finish();
  assert.equal(f.deliveries.length, 0);
  f.value.continueLimit = 2;
  f.value.autoContinue = false;
  f.child.finish();
  assert.equal(f.deliveries.length, 0);
  f.value.autoContinue = true;
  f.value.enabled = false;
  f.child.finish();
  assert.equal(f.deliveries.length, 0);
  f.value.enabled = true;
  f.child.finish();
  f.child.consume();
  f.child.finish();
  f.child.consume();
  f.child.finish();
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 2);
  await tick();
  assert.equal(f.deliveries.length, 2);
});

test("new parent input and a child source input reset a managed child's automatic chain", async (t) => {
  const f = await managedChild(t);
  f.value.continueLimit = 1;
  f.child.finish();
  f.child.consume();
  f.child.finish();
  assert.equal(f.deliveries.length, 1);
  f.parent.followup(user("Parent asks for status without delegating a new task"));
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
  f.child.followup({
    ...user("A fresh task delegated by the parent"),
    source: { kind: "agent-message", senderSessionId: "root", form: "relay" },
  });
  f.child.consume();
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 0);
  f.child.status = "running";
  f.child.finish();
  assert.equal(f.deliveries.length, 2);
  f.child.consume();
  f.child.session.append("user/message", {
    ...user("Context only"),
    source: { kind: "runtime-context" },
  });
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
  f.child.session.append("user/message", {
    ...user("A fresh delegated task"),
    source: { kind: "agent-message", senderSessionId: "root", form: "relay" },
  });
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 0);
  f.child.finish();
  assert.equal(f.deliveries.length, 3);
});

test("pending child delivery is aborted by stop, native cancel, disable, new input and revert", async (t) => {
  for (const action of [
    "stop",
    "cancel",
    "parent-cancel",
    "disable",
    "auto-off",
    "child-input",
    "parent-input",
    "completed",
    "revert",
  ]) {
    await t.test(action, async (t) => {
      const f = await managedChild(t);
      f.holdDeliveries();
      const end = f.child.finish();
      f.emit("session/event", f.child.session, end);
      assert.equal(f.deliveries.length, 1, "a pending trigger cannot submit twice");
      const delivery = f.deliveries[0];
      assert.equal(delivery.signal.aborted, false);
      if (action === "stop") {
        assert.equal(f.continuation.stop({ sessionId: "child" }).pendingCancelled, true);
      } else if (action === "cancel") f.child.cancel({ kind: "user" });
      else if (action === "parent-cancel") f.parent.cancel({ kind: "user" });
      else if (action === "disable") {
        f.value.enabled = false;
        f.continuation.changed();
      } else if (action === "auto-off") {
        f.value.autoContinue = false;
        f.continuation.changed();
      } else if (action === "child-input") f.child.followup(user("Replace pending task"));
      else if (action === "parent-input")
        f.child.followup({
          ...user("Replace pending child task from parent"),
          source: { kind: "agent-message", senderSessionId: "root", form: "relay" },
        });
      else if (action === "completed") f.child.finish({ kind: "completed" });
      else f.continuation.revert();
      assert.equal(delivery.signal.aborted, true);
      delivery.release();
      await tick();
      assert.equal(
        f.child.inbox.nextTurn.length,
        ["child-input", "parent-input"].includes(action) ? 1 : 0,
        "cancelled delivery cannot arrive later or replace an unrelated new input",
      );
      assert.equal(delivery.message, undefined);
      assert.equal(f.deliveries.length, 1);
    });
  }
});

test("accepted child automatic input uses ordinary ownership removal and running-turn cancellation", async (t) => {
  const f = await managedChild(t);
  f.child.finish();
  await tick();
  const acceptedSignal = f.deliveries[0].signal;
  const stop = f.continuation.stop({ sessionId: "child" });
  assert.equal(stop.ownedQueuedRemoved, 1);
  assert.equal(f.child.inbox.nextTurn.length, 0);
  assert.equal(acceptedSignal.aborted, false, "accepted delivery is no longer pending");
  f.child.followup(user("Restart child"));
  f.child.consume();
  f.child.finish();
  f.child.consume();
  assert.equal(f.continuation.stop({ sessionId: "child" }).ownedRunCancelled, true);
  assert.equal(f.child.cancelled, 1);
});

test("child automatic delivery requires an observed local start and exact live managed parent and child", async (t) => {
  for (const scenario of [
    "unobserved",
    "pre-apply-start",
    "remote",
    "missing-parent",
    "replaced-parent",
    "replaced-child",
  ]) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      f.value.autoContinue = true;
      const parent = f.createAgent();
      const child = f.createAgent("child", { parentSession: "root", origin: "subagent" });
      if (scenario === "pre-apply-start") f.startChild(child);
      await f.continuation.apply();
      if (scenario !== "unobserved" && scenario !== "pre-apply-start")
        f.startChild(child, { local: scenario !== "remote" });
      if (scenario === "missing-parent") f.agents.delete("root");
      if (scenario === "replaced-parent") f.agents.set("root", { ...parent });
      if (scenario === "replaced-child") f.agents.set("child", { ...child });
      child.status = "running";
      child.finish();
      await tick();
      assert.equal(f.deliveries.length, 0);
      assert.throws(() => f.continuation.continue({ sessionId: "child" }), code("UNSUPPORTED"));
      // Restore the directory for ordinary fixture teardown after the residency probe.
      f.agents.set("root", parent);
      f.agents.set("child", child);
    });
  }
});

test("child history excludes inherited root inputs and automatic quota, retaining its own accepted history", async (t) => {
  const f = fixture(t);
  f.value.autoContinue = true;
  f.value.continueLimit = 1;
  f.createAgent();
  const child = f.createAgent("child", { parentSession: "root", origin: "subagent" });
  child.session.append("user/message", {
    ...user("Inherited root continuation"),
    source: { kind: "dsh-unlimit/continuation", mode: "automatic", triggerSeq: 100 },
  });
  child.session.inheritedEventCount = 1;
  await f.continuation.apply();
  f.startChild(child);
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 0);
  child.finish();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
  f.continuation.revert();
  await f.continuation.apply();
  f.startChild(child);
  assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
  child.status = "running";
  child.finish();
  assert.equal(f.deliveries.length, 1, "own accepted automatic history still enforces quota");
});

test("parent cancellation retracts only accepted child automatic input before it starts", async (t) => {
  const f = await managedChild(t);
  f.child.finish();
  assert.equal(f.deliveries.length, 1);
  const owned = f.child.inbox.nextTurn[0];
  const unrelated = {
    ...user("Unrelated task from the parent"),
    source: { kind: "agent-message", senderSessionId: "root", form: "relay" },
  };
  const human = user("Unrelated manual child input");
  f.child.followup(unrelated);
  f.child.followup(human);
  assert.equal(f.child.inbox.nextTurn.length, 3);
  assert.equal(f.parent.cancel({ kind: "user" }), "original-cancel");
  assert.deepEqual(f.child.inbox.nextTurn, [unrelated, human]);
  assert.equal(f.child.cancelled, 0, "no child turn is running yet");
  assert.equal(f.parent.cancelled, 1);
  assert.equal(
    f.deliveries[0].signal.aborted,
    false,
    "the accepted delivery is removed through inbox ownership",
  );
  assert.equal(owned.source.mode, "automatic");
  await tick();
  assert.equal(f.deliveries.length, 1);
});

test("parent cancellation cancels an owned child automatic running turn but preserves ordinary child work", async (t) => {
  await t.test("owned automatic turn", async (t) => {
    const f = await managedChild(t);
    f.child.finish();
    f.child.consume();
    assert.equal(f.child.status, "running");
    f.parent.cancel({ kind: "user" });
    assert.equal(f.parent.cancelled, 1);
    assert.equal(f.child.cancelled, 1);
    assert.deepEqual(f.child.cancelArgs, [{ kind: "user" }]);
    await tick();
    assert.equal(f.deliveries.length, 1);
  });
  await t.test("ordinary delegated turn", async (t) => {
    const f = await managedChild(t);
    f.child.followup({
      ...user("Ordinary parent task"),
      source: { kind: "agent-message", senderSessionId: "root", form: "relay" },
    });
    f.child.consume();
    f.parent.cancel({ kind: "user" });
    assert.equal(f.parent.cancelled, 1);
    assert.equal(f.child.cancelled, 0);
    assert.equal(f.child.status, "running");
    assert.equal(f.deliveries.length, 0);
  });
});

test("child automatic quota is preserved for context, instructions, settled notices and descendant messages", async (t) => {
  for (const source of [
    { kind: "runtime-context" },
    { kind: "agent-instructions" },
    { kind: "subagent-settled" },
    { kind: "agent-message", senderSessionId: "grandchild", form: "relay" },
  ]) {
    await t.test(
      source.kind + (source.senderSessionId ? ` from ${source.senderSessionId}` : ""),
      async (t) => {
        const f = await managedChild(t);
        f.value.continueLimit = 1;
        f.child.finish();
        f.child.consume();
        f.child.session.append("user/message", { ...user("Non-task source input"), source });
        assert.equal(f.continuation.status({ sessionId: "child" }).automaticCount, 1);
        f.child.finish();
        assert.equal(f.deliveries.length, 1, "non-parent source cannot reopen the automatic quota");
      },
    );
  }
});

test("child cancel ownership conflict cannot suppress native parent cancellation or stopping another child", async (t) => {
  const f = await managedChild(t);
  f.child.finish();
  f.child.consume();
  const sibling = f.createAgent("sibling", { parentSession: "root", origin: "subagent" });
  f.startChild(sibling);
  sibling.finish();
  assert.equal(sibling.inbox.nextTurn.length, 1);
  const installedCancel = f.child.cancel;
  let laterOwnerCalls = 0;
  const laterOwnerCancel = () => {
    laterOwnerCalls++;
  };
  f.child.cancel = laterOwnerCancel;
  try {
    let conflict;
    try {
      f.parent.cancel({ kind: "user" });
    } catch (error) {
      conflict = error;
    }
    const hasConflict = (error) =>
      error?.code === "CONFLICT" ||
      (error instanceof AggregateError && error.errors.some(hasConflict));
    assert.ok(
      hasConflict(conflict),
      "child cancellation ownership conflict is reported explicitly",
    );
    assert.equal(f.parent.cancelled, 1, "the native parent cancellation must always execute");
    assert.equal(f.child.cancel, laterOwnerCancel, "a later cancel owner is preserved");
    assert.equal(laterOwnerCalls, 0, "the plugin must not invoke the later owner's cancel");
    assert.equal(
      sibling.inbox.nextTurn.length,
      0,
      "one child conflict cannot block another child's owned continuation removal",
    );
    await tick();
    assert.equal(sibling.inbox.nextTurn.length, 0);
  } finally {
    // Restore our deliberately replaced method so fixture teardown can release its own hook.
    f.child.cancel = installedCancel;
  }
});
