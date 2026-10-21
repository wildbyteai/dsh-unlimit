import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_INPUT_RECORD, ChildOrigins } from "../src/host/child-origins.js";

const entrySource = `export function appendPluginRecord(session, type, data) {
  return session.appendRecord(type, data);
}`;

function fixture(t, source = entrySource) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-child-origins-")));
  const packageRoot = join(directory, "node_modules", "@deepseek-ai", "dsh-session");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(packageRoot, "package.json"), '{"type":"module","main":"index.js"}');
  const entry = join(packageRoot, "index.js");
  writeFileSync(entry, source);
  writeFileSync(
    join(directory, "desktop-runtime.json"),
    JSON.stringify({
      release: { version: "0.2.1-rc.2" },
      files: [
        {
          path: "node_modules/@deepseek-ai/dsh-session/index.js",
          sha256: createHash("sha256").update(source).digest("hex"),
        },
      ],
    }),
  );
  const session = (id, createdAt, meta = {}) => ({
    id,
    header: { id, createdAt, ...meta },
    inheritedEventCount: 0,
    events: [],
    snapshotEvents() {
      return [...this.events];
    },
    append(type, data) {
      const event = { seq: this.events.length, type, data };
      this.events.push(event);
      return event;
    },
    appendRecord(type, data) {
      if (this.recordFailure) throw new Error("Synthetic record storage failure");
      const event = this.append(type, structuredClone(data));
      event.ignorable = true;
      return event.seq;
    },
  });
  const parent = { id: "synthetic-parent", session: session("synthetic-parent", 100) };
  const child = {
    id: "synthetic-child",
    session: session("synthetic-child", 200, {
      origin: "subagent",
      parentSession: parent.id,
    }),
  };
  const agents = new Map([
    [parent.id, parent],
    [child.id, child],
  ]);
  const listeners = new Set();
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    on(name, callback) {
      assert.equal(name, "tools/result");
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };
  let enabled = true;
  const tracker = new ChildOrigins(ctx, { supported: true, runtimeRoot: directory }, () => enabled);
  const message = (id = "accepted-child-input", sender = parent.id) => ({
    id,
    role: "user",
    source: { kind: "agent-message", form: "relay", senderSessionId: sender },
    content: [{ type: "text", text: "Synthetic private task body" }],
  });
  const accepted = message();
  child.session.append("agent/inbox/spliced", {
    target: "next-step",
    start: 0,
    inserted: [accepted],
  });
  parent.session.append("turn/start", { turn: 2 });
  parent.session.append("step/start", { turn: 2, step: 3 });
  const call = parent.session.append("tool/call", {
    turn: 2,
    step: 3,
    callId: "synthetic-send-call",
    name: "send_message",
    arguments: JSON.stringify({ agent_id: child.id, message: "Synthetic private task body" }),
  });
  const exec = {
    agent: parent,
    callId: call.data.callId,
    name: "send_message",
    arguments: { agent_id: child.id, message: "Synthetic private task body" },
    signal: new AbortController().signal,
  };
  const result = {
    isError: false,
    value: { messageId: accepted.id },
    content: [{ type: "text", text: `message delivered to agent ${child.id}` }],
  };
  const emit = () => {
    for (const callback of listeners) callback(exec, result);
  };
  const records = () => parent.session.events.filter((event) => event.type === CHILD_INPUT_RECORD);
  t.after(() => {
    tracker.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    tracker,
    ctx,
    parent,
    child,
    agents,
    listeners,
    entry,
    exec,
    result,
    call,
    accepted,
    message,
    emit,
    records,
    setEnabled: (value) => (enabled = value),
  };
}

test("capture is gated, idempotent, reversible and stores only exact origin identities", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.tracker.status(), { state: "available" });
  f.emit();
  assert.equal(f.records().length, 0);
  await Promise.all([f.tracker.connect(), f.tracker.connect()]);
  assert.equal(f.listeners.size, 1);
  assert.deepEqual(f.tracker.status(), { state: "active" });
  f.setEnabled(false);
  assert.deepEqual(f.tracker.status(), { state: "available" });
  f.emit();
  assert.equal(f.records().length, 0);
  f.setEnabled(true);
  const beforeResult = structuredClone(f.result);
  f.emit();
  f.emit();
  assert.equal(f.records().length, 1);
  assert.deepEqual(f.records()[0].data, {
    version: 1,
    parentSessionId: f.parent.id,
    parentCreatedAt: 100,
    childSessionId: f.child.id,
    childCreatedAt: 200,
    messageId: f.accepted.id,
    callId: f.exec.callId,
    callSeq: 2,
    turnStartSeq: 0,
    stepStartSeq: 1,
  });
  assert.equal(f.records()[0].ignorable, true);
  assert.ok(!JSON.stringify(f.records()[0]).includes("Synthetic private task body"));
  assert.deepEqual(f.result, beforeResult);
  f.tracker.close();
  assert.deepEqual(f.tracker.status(), { state: "available" });
  assert.equal(f.listeners.size, 0);
  f.emit();
  await f.tracker.connect();
  f.emit();
  assert.equal(f.records().length, 1, "Reconnect must not duplicate a durable origin");
});

test("unverified or missing official record interfaces retain explicit unsupported status", async (t) => {
  await t.test("changed entry is rejected before import", async (t) => {
    const f = fixture(t);
    writeFileSync(f.entry, 'throw new Error("Unverified code must never execute");');
    assert.match((await f.tracker.connect()).reason, /摘要不一致/);
    assert.equal(f.tracker.status().state, "unsupported");
    assert.equal(f.listeners.size, 0);
  });
  for (const [label, source, reason] of [
    ["missing export", "export const unrelated = true;", /缺少 appendPluginRecord/],
    ["import failure", 'throw new Error("Synthetic import failure");', /Synthetic import failure/],
  ])
    await t.test(label, async (t) => {
      const f = fixture(t, source);
      assert.match((await f.tracker.connect()).reason, reason);
      assert.equal(f.tracker.status().state, "unsupported");
      assert.equal(f.listeners.size, 0);
    });
});

test("close while the verified module is loading does not leave an observer", async (t) => {
  const f = fixture(t);
  const connecting = f.tracker.connect();
  f.tracker.close();
  await connecting;
  assert.deepEqual(f.tracker.status(), { state: "available" });
  assert.equal(f.listeners.size, 0);
});

test("observer registration failure remains visible as unsupported", async (t) => {
  const f = fixture(t);
  f.ctx.on = () => {
    throw new Error("Synthetic observer registration failure");
  };
  const status = await f.tracker.connect();
  assert.equal(status.state, "unsupported");
  assert.match(status.reason, /Synthetic observer registration failure/);
  assert.deepEqual(f.tracker.status(), status);
  assert.equal(f.listeners.size, 0);
});

test("a consumed message and its one admission are the same input identity", async (t) => {
  const f = fixture(t);
  f.child.session.append("user/message", f.accepted);
  await f.tracker.connect();
  f.emit();
  assert.equal(f.records().length, 1);
});

test("a consumed-only exact relay can be observed without reading another source", async (t) => {
  const f = fixture(t);
  f.child.session.events[0] = { seq: 0, type: "user/message", data: f.accepted };
  await f.tracker.connect();
  f.emit();
  assert.equal(f.records().length, 1);
});

test("duplicate, inherited, missing or conflicting child inputs never become origins", async (t) => {
  const cases = [
    ["missing id", (f) => (f.result.value.messageId = "absent-input")],
    ["inherited input", (f) => (f.child.session.inheritedEventCount = 1)],
    ["wrong sender", (f) => (f.accepted.source.senderSessionId = "other-parent")],
    ["not a relay", (f) => (f.accepted.source.form = "notice")],
    ["human source", (f) => (f.accepted.source = { kind: "user" })],
    [
      "duplicate admission",
      (f) => f.child.session.append("agent/inbox/spliced", { inserted: [f.accepted] }),
    ],
    [
      "duplicate consumption",
      (f) => {
        f.child.session.append("user/message", f.accepted);
        f.child.session.append("user/message", f.accepted);
      },
    ],
    [
      "conflicting consumption",
      (f) => f.child.session.append("user/message", f.message(f.accepted.id, "other-parent")),
    ],
  ];
  for (const [label, change] of cases)
    await t.test(label, async (t) => {
      const f = fixture(t);
      change(f);
      await f.tracker.connect();
      f.emit();
      assert.equal(f.records().length, 0);
    });
});

test("only exact live parent and direct subagent child identities may be recorded", async (t) => {
  const cases = [
    ["missing parent", (f) => delete f.exec.agent],
    ["stale parent", (f) => f.agents.set(f.parent.id, { ...f.parent })],
    ["missing child", (f) => f.agents.delete(f.child.id)],
    ["wrong child session", (f) => (f.child.session.header.id = "other-child")],
    ["ordinary fork", (f) => delete f.child.session.header.origin],
    ["different parent", (f) => (f.child.session.header.parentSession = "other-parent")],
    ["invalid creation identity", (f) => (f.child.session.header.createdAt = -1)],
  ];
  for (const [label, change] of cases)
    await t.test(label, async (t) => {
      const f = fixture(t);
      change(f);
      await f.tracker.connect();
      f.emit();
      assert.equal(f.records().length, 0);
    });
});

test("an own unique ordinary call inside its matching active turn and step is required", async (t) => {
  const cases = [
    ["inherited call", (f) => (f.parent.session.inheritedEventCount = 3)],
    ["duplicate call", (f) => f.parent.session.append("tool/call", f.call.data)],
    ["wrong tool", (f) => (f.call.data.name = "other-tool")],
    ["wrong target", (f) => (f.call.data.arguments = '{"agent_id":"other-child"}')],
    ["invalid arguments", (f) => (f.call.data.arguments = "{")],
    ["no active step", (f) => (f.parent.session.events[1].type = "step/end")],
    ["closed turn", (f) => (f.parent.session.events[0].type = "turn/end")],
    ["result after step close", (f) => f.parent.session.append("step/end", { turn: 2, step: 3 })],
    ["different turn", (f) => (f.call.data.turn = 3)],
    ["different step", (f) => (f.call.data.step = 4)],
    ["PTC execution", (f) => (f.exec.parent = Symbol("synthetic-ptc-parent"))],
  ];
  for (const [label, change] of cases)
    await t.test(label, async (t) => {
      const f = fixture(t);
      change(f);
      await f.tracker.connect();
      f.emit();
      assert.equal(f.records().length, 0);
    });
});

test("accepted success is recorded after caller cancellation but failed results are not", async (t) => {
  const f = fixture(t);
  const abort = new AbortController();
  abort.abort();
  f.exec.signal = abort.signal;
  await f.tracker.connect();
  f.result.isError = true;
  f.emit();
  assert.equal(f.records().length, 0);
  f.result.isError = false;
  f.emit();
  assert.equal(f.records().length, 1);
  assert.equal(f.records()[0].data.messageId, f.accepted.id);
});

test("record append failures reach the official observer without changing delivery results", async (t) => {
  const f = fixture(t);
  f.parent.session.recordFailure = true;
  await f.tracker.connect();
  const before = structuredClone(f.result);
  assert.throws(f.emit, /Synthetic record storage failure/);
  assert.equal(f.records().length, 0);
  assert.deepEqual(f.result, before);
  f.parent.session.recordFailure = false;
  f.emit();
  assert.equal(f.records().length, 1);
});
