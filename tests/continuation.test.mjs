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
  const manifestPath = join(root, "desktop-runtime.json");
  const manifest = {
    release: { version: SUPPORTED_HOST },
    files: [
      {
        path: "node_modules/@deepseek-ai/dsh-llm/index.js",
        sha256: createHash("sha256").update(moduleSource).digest("hex"),
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
  const ctx = {
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
  return { continuation, value, ctx, listeners, agents, emit, createAgent, manifestPath, manifest };
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
  assert.match(f.continuation.status({ sessionId: "child" }).unsupportedReason, /workflow/);
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
