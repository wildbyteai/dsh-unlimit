import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flow } from "../src/core/flow.js";
import { WorkspaceStore } from "../src/core/store.js";
import { ChildContinuation } from "../src/host/child-continuation.js";
import { SUPPORTED_HOST } from "../src/host/desktop.js";

const DELIVERY = Symbol.for("dsh.subagent.deliverPrompt");
const SOURCE = "dsh-unlimit/continuation";
const code = (expected) => (error) => error.code === expected;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const human = (text = "Synthetic replacement input") => ({
  id: randomUUID(),
  role: "user",
  source: { kind: "user" },
  content: [{ type: "text", text }],
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitGate(gate, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
    gate.promise.then(() => {
      signal?.removeEventListener("abort", abort);
      try {
        signal?.throwIfAborted();
        resolve();
      } catch (error) {
        reject(error);
      }
    }, reject);
  });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("Synthetic continuation did not reach the expected boundary");
}

// Only the host protocol is synthetic. Real Store and Flow exercise local slot
// acquisition/release in a new disposable database; no official entry is imported.
function fixture(t, { project = true, workflowOwned = project } = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-child-unit-")));
  const moduleRoot = join(directory, "node_modules/@deepseek-ai/dsh-subagent");
  mkdirSync(moduleRoot, { recursive: true });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(moduleRoot, "package.json"), '{"type":"module","main":"index.js"}');
  const moduleSource = "export {};";
  writeFileSync(join(moduleRoot, "index.js"), moduleSource);
  writeFileSync(
    join(directory, "desktop-runtime.json"),
    JSON.stringify({
      release: { version: SUPPORTED_HOST },
      files: [
        {
          path: "node_modules/@deepseek-ai/dsh-subagent/index.js",
          sha256: createHash("sha256").update(moduleSource).digest("hex"),
        },
      ],
    }),
  );
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  const flow = new Flow(store);
  const workspaceId = store.dispatch("workspaces.save", {
    name: "Synthetic child-continuation workspace",
  }).item.id;
  const listeners = new Map();
  const agents = new Map();
  const sources = new Map();
  const deliveries = [];
  const drains = [];
  const inspections = [];
  const hooks = {};
  const value = {
    enabled: true,
    autoContinue: false,
    continueLimit: 2,
    continueText: "Synthetic continuation",
  };
  let ready = true;
  let admitted = true;
  let oldDisposals = 0;
  let starts = 0;
  const priorReceipt = Object.freeze({
    id: "previous-workflow-run",
    sessionId: "child",
    status: "failed",
    stopReason: "max-tokens",
    disposed: true,
    slotReleased: true,
    messageId: "previous-workflow-message",
  });
  const workflow = {
    controlled: new Set(),
    owned: new Set(workflowOwned ? ["child"] : []),
    runs: new Map([
      [
        priorReceipt.id,
        {
          item: priorReceipt,
          receipt: {
            dispose() {
              oldDisposals++;
              throw new Error("Completed receipts cannot own a resumed epoch");
            },
          },
        },
      ],
    ]),
    ownsSession(id) {
      return this.owned.has(id);
    },
    controlsSession(id) {
      return this.controlled.has(id);
    },
  };
  const emit = (name, ...args) => {
    for (const listener of [...(listeners.get(name) ?? [])]) listener(...args);
  };
  const addSource = (id, { parentId, inherited = 0, events = [] } = {}) => {
    const source = {
      meta: {
        id,
        origin: parentId ? "subagent" : "user",
        ...(parentId ? { parentSession: parentId } : {}),
      },
      inheritedEventCount: inherited,
      events: events.map((event, seq) => ({ ...structuredClone(event), seq })),
    };
    sources.set(id, source);
    return source;
  };
  const rawAppend = (id, type, data) => {
    const source = sources.get(id);
    const event = { seq: source.events.length, type, data: structuredClone(data) };
    source.events.push(event);
    return event;
  };
  const createAgent = (id) => {
    const source = sources.get(id);
    const queues = { "next-turn": [], "next-step": [] };
    for (const event of source.events)
      if (event.type === "agent/inbox/spliced") {
        const { target, start, removedCount = 0, inserted } = event.data;
        queues[target].splice(start, removedCount, ...inserted);
      }
    let publishing = false;
    const session = {
      id,
      header: source.meta,
      inheritedEventCount: source.inheritedEventCount,
      snapshotEvents: () => [...source.events],
      append(type, data) {
        if (publishing) throw new Error("Synthetic Session publication cannot reenter");
        const event = rawAppend(id, type, data);
        publishing = true;
        try {
          emit("session/event", session, event);
        } finally {
          publishing = false;
        }
        return event;
      },
    };
    const agent = {
      id,
      session,
      status: "idle",
      cancelled: 0,
      inbox: {
        get nextTurn() {
          return queues["next-turn"];
        },
        get nextStep() {
          return queues["next-step"];
        },
        get hasPending() {
          return queues["next-turn"].length + queues["next-step"].length > 0;
        },
        splice(target, start, removedCount, inserted) {
          const removed = queues[target].splice(start, removedCount, ...inserted);
          session.append("agent/inbox/spliced", {
            target,
            start,
            removedCount,
            inserted,
            ...(removedCount ? { outcome: "canceled" } : {}),
          });
          return removed;
        },
      },
      followup(message) {
        this.inbox.splice("next-turn", queues["next-turn"].length, 0, [message]);
      },
      cancel() {
        this.cancelled++;
      },
      beginTurn() {
        this.status = "running";
        session.append("turn/start", { turn: 2 });
        const claimed = queues["next-turn"].splice(0);
        session.append("agent/inbox/spliced", {
          target: "next-turn",
          start: 0,
          removedCount: claimed.length,
          inserted: [],
        });
        for (const message of claimed) session.append("user/message", message);
      },
    };
    agents.set(id, agent);
    return agent;
  };
  const disposeAgent = (delivery) => {
    if (!delivery.agent || agents.get(delivery.id) !== delivery.agent) return;
    agents.delete(delivery.id);
    emit("agent/disposed", { agent: delivery.agent });
  };
  const end = (delivery, reason = "completed") => {
    if (delivery.ended) return;
    delivery.ended = true;
    if (delivery.agent?.status === "running") {
      delivery.agent.session.append("turn/end", {
        turn: 2,
        reason: {
          kind:
            reason === "aborted" ? "aborted" : reason === "max-tokens" ? "max-tokens" : "completed",
        },
      });
      delivery.agent.status = "idle";
    }
    disposeAgent(delivery);
    if (delivery.runId)
      emit("subagent/end", {
        id: delivery.id,
        runId: delivery.runId,
        local: true,
        provider: "spawn",
        stopReason: reason,
      });
  };
  const services = {
    agents: { get: (id) => agents.get(id) },
    workspaceRegistry: { archivedSessionIds: [] },
    sessionController: {
      async inspect(id, signal) {
        inspections.push(id);
        await hooks.inspect?.(id, signal);
        signal?.throwIfAborted();
        const source = sources.get(id);
        if (!source)
          throw Object.assign(new Error("Synthetic session unavailable"), { code: "NOT_FOUND" });
        return structuredClone(source);
      },
    },
    subagents: {
      async startActivation() {
        starts++;
        throw new Error("Manual continuation must not create a replacement child");
      },
      async [DELIVERY](parent, id, content, source, signal, mode) {
        const delivery = { parent, id, content, source, signal, mode };
        deliveries.push(delivery);
        try {
          await hooks.beforeCreate?.(delivery);
          signal.throwIfAborted();
          delivery.agent = createAgent(id);
          emit("agent/created", { agent: delivery.agent, source: "resume", signal });
          await hooks.afterCreated?.(delivery);
          signal.throwIfAborted();
          delivery.runId = randomUUID();
          if (!hooks.omitStart)
            emit("subagent/start", { id, runId: delivery.runId, provider: "spawn", local: true });
          await hooks.beforeAccept?.(delivery);
          signal.throwIfAborted();
          const message = { id: randomUUID(), role: "user", source, content };
          delivery.agent.followup(message);
          delivery.message = message;
          await hooks.afterAccept?.(delivery);
          return hooks.returnMessageId ?? message.id;
        } catch (error) {
          // Match native rollback: rejection follows disposal; a published epoch
          // has a paired end, while a failed Agent factory has only disposal.
          disposeAgent(delivery);
          if (delivery.runId) end(delivery, "aborted");
          throw error;
        }
      },
      async drainChildren(parent, ids) {
        assert.equal(agents.get(parent.id), parent, "Drain requires the exact live direct parent");
        drains.push({ parent, ids: [...ids] });
        await hooks.drain?.(parent, ids);
        for (const id of ids) {
          const delivery = deliveries.findLast((item) => item.id === id && !item.ended);
          if (delivery) {
            delivery.agent.cancel();
            end(delivery, "aborted");
          }
        }
      },
    },
  };
  const ctx = {
    get: (name) => services[name],
    on(name, callback) {
      const entries = listeners.get(name) ?? new Set();
      entries.add(callback);
      listeners.set(name, entries);
      return () => entries.delete(callback);
    },
  };
  addSource("parent");
  const parent = createAgent("parent");
  addSource("child", {
    parentId: "parent",
    events: [
      {
        type: "subagent/descriptor",
        data: { version: 3, mode: "continuable", provider: "spawn", label: "Synthetic child" },
      },
      { type: "turn/end", data: { turn: 1, reason: { kind: "max-tokens" } } },
    ],
  });
  if (project) {
    for (const sessionId of ["parent", "child"])
      store.dispatch("workspaces.bind", { id: workspaceId, sessionId });
    flow.dispatch("flow.assign", { workspaceId, sessionId: "child", role: "analyst" });
  }
  const continuation = new ChildContinuation(
    ctx,
    store,
    { supported: true, runtimeRoot: directory },
    {
      flow,
      workflow,
      readSettings: () => value,
      ready: () => ready,
      admission: {
        require() {
          if (!admitted)
            throw Object.assign(new Error("Synthetic project authorization was revoked"), {
              code: "ADMISSION_REQUIRED",
            });
        },
      },
    },
  );
  t.after(async () => {
    try {
      for (const delivery of deliveries) end(delivery, "aborted");
      await continuation.stopAll({ revoke: true });
      assert.equal(oldDisposals, 0, "A completed workflow receipt is never reused");
      assert.equal(starts, 0, "Manual continuation never calls startActivation");
    } finally {
      flow.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    continuation,
    sources,
    agents,
    services,
    store,
    flow,
    workspaceId,
    hooks,
    deliveries,
    drains,
    inspections,
    listeners,
    parent,
    value,
    workflow,
    priorReceipt,
    emit,
    rawAppend,
    addSource,
    createAgent,
    disposeAgent,
    end,
    setReady: (next) => {
      ready = next;
    },
    setAdmitted: (next) => {
      admitted = next;
    },
    slotCount: () => flow.status(workspaceId).active.length,
    listenerCount: () =>
      [...listeners.values()].reduce((count, entries) => count + entries.size, 0),
  };
}

test("cold manual continuation has a fresh native epoch and keeps its new slot until the paired end", async (t) => {
  const f = fixture(t);
  const previous = structuredClone(f.priorReceipt);
  assert.equal((await f.continuation.status("child")).manualAvailable, true);
  f.hooks.beforeCreate = () => {
    assert.equal(f.slotCount(), 1, "The project slot precedes native restoration");
    assert.equal(f.continuation.controlsSession("child"), true);
  };
  const result = await f.continuation.continue("child");
  const delivery = f.deliveries[0];
  assert.equal(result.submitted, true);
  assert.equal(result.messageId, delivery.message.id);
  assert.equal(result.manualRun.runId, delivery.runId);
  assert.notEqual(result.manualRun.id, f.priorReceipt.id);
  assert.deepEqual(result.source, {
    kind: SOURCE,
    mode: "manual",
    triggerSeq: 1,
    continuationId: result.manualRun.id,
  });
  assert.equal(delivery.parent, f.parent);
  assert.equal(delivery.id, "child");
  assert.equal(delivery.mode, "queue");
  assert.deepEqual(delivery.content, [{ type: "text", text: f.value.continueText }]);
  assert.deepEqual(f.priorReceipt, previous, "The old workflow result remains terminal");
  f.disposeAgent(delivery);
  assert.equal(f.slotCount(), 1, "Agent disposal precedes the native completion receipt");
  f.emit("subagent/end", { id: "child", runId: "unrelated-epoch", stopReason: "completed" });
  assert.equal(f.slotCount(), 1, "A same-id event from another epoch cannot release the slot");
  f.end(delivery);
  assert.equal(f.slotCount(), 0);
  assert.equal(f.continuation.controlsSession("child"), false);
  assert.equal((await f.continuation.status("child")).manualRun.status, "completed");
  assert.equal(f.listenerCount(), 0);
});

test("only an unused latest own max-tokens end permits manual restoration", async (t) => {
  const cases = [
    [
      "inherited parent end",
      "UNSUPPORTED",
      (f) => {
        const source = f.sources.get("child");
        source.inheritedEventCount = 2;
        f.rawAppend("child", "subagent/descriptor", {
          version: 3,
          mode: "continuable",
          provider: "spawn",
          label: "Own descriptor",
        });
      },
    ],
    [
      "already accepted trigger",
      "CONFLICT",
      (f) => {
        const source = f.sources.get("child");
        source.events.splice(1);
        f.rawAppend("child", "user/message", {
          ...human(),
          source: { kind: SOURCE, mode: "manual", triggerSeq: 2 },
        });
        f.rawAppend("child", "turn/end", { turn: 1, reason: { kind: "max-tokens" } });
      },
    ],
    ["later human input", "CONFLICT", (f) => f.rawAppend("child", "user/message", human())],
    [
      "later parent input",
      "CONFLICT",
      (f) =>
        f.rawAppend("child", "agent/inbox/spliced", {
          target: "next-turn",
          start: 0,
          inserted: [
            {
              ...human(),
              source: { kind: "agent-message", senderSessionId: "parent", form: "relay" },
            },
          ],
        }),
    ],
    ["new unfinished turn", "CONFLICT", (f) => f.rawAppend("child", "turn/start", { turn: 2 })],
    ...["completed", "error", "aborted", "interrupted"].map((kind) => [
      `latest end ${kind}`,
      "UNSUPPORTED",
      (f) => f.rawAppend("child", "turn/end", { turn: 2, reason: { kind } }),
    ]),
  ];
  for (const [name, expected, alter] of cases)
    await t.test(name, async (t) => {
      const f = fixture(t);
      alter(f);
      assert.equal((await f.continuation.status("child")).manualAvailable, false);
      await assert.rejects(f.continuation.continue("child"), code(expected));
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.slotCount(), 0);
      assert.equal(f.listenerCount(), 0);
    });
});

test("invalid prefixes and nonlocal descriptors are rejected before native delivery", async (t) => {
  for (const [name, expected, alter] of [
    [
      "noncontiguous events",
      "INVALID_HOST_RESULT",
      (source) => {
        source.events[1].seq = 99;
      },
    ],
    [
      "invalid inherited count",
      "INVALID_HOST_RESULT",
      (source) => {
        source.inheritedEventCount = -1;
      },
    ],
    [
      "one-shot child",
      "UNSUPPORTED",
      (source) => {
        source.events[0].data.mode = "one-shot";
      },
    ],
    [
      "external provider",
      "UNSUPPORTED",
      (source) => {
        source.events[0].data.provider = "external-synthetic";
      },
    ],
  ])
    await t.test(name, async (t) => {
      const f = fixture(t);
      alter(f.sources.get("child"));
      await assert.rejects(f.continuation.continue("child"), code(expected));
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.slotCount(), 0);
    });
});

test("archived child, archived parent and absent direct parent are explicit and leave no slot", async (t) => {
  for (const target of ["child", "parent", "missing-parent"])
    await t.test(target, async (t) => {
      const f = fixture(t);
      if (target === "missing-parent") f.agents.delete("parent");
      else f.services.workspaceRegistry.archivedSessionIds.push(target);
      const status = await f.continuation.status("child");
      assert.equal(status.manualAvailable, false);
      assert.match(status.unsupportedReason, target === "missing-parent" ? /父会话/ : /归档/);
      await assert.rejects(
        f.continuation.continue("child"),
        code(target === "missing-parent" ? "PARENT_UNAVAILABLE" : "SESSION_ARCHIVED"),
      );
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.slotCount(), 0);
    });
});

test("two clicks during the same cold inspection admit only one native request", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  f.hooks.inspect = (_, signal) => waitGate(gate, signal);
  const first = f.continuation.continue("child");
  await until(() => f.inspections.length === 1);
  await assert.rejects(f.continuation.continue("child"), code("CONFLICT"));
  gate.resolve();
  const accepted = await first;
  assert.equal(accepted.submitted, true);
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.slotCount(), 1);
  f.end(f.deliveries[0]);
});

test("created-agent validation catches history that changed after the initial cold read", async (t) => {
  const f = fixture(t);
  f.hooks.beforeCreate = () => f.rawAppend("child", "user/message", human("Later persisted input"));
  await assert.rejects(f.continuation.continue("child"), code("CONFLICT"));
  assert.equal(f.deliveries[0].signal.aborted, true);
  assert.equal(f.deliveries[0].message, undefined);
  assert.equal(f.slotCount(), 0);
  assert.equal(f.continuation.controlsSession("child"), false);
  assert.equal(f.listenerCount(), 0);
});

test("a new child or parent input before acceptance aborts only the waiting continuation", async (t) => {
  for (const target of ["child", "parent"])
    await t.test(target, async (t) => {
      const f = fixture(t);
      const gate = deferred();
      f.hooks.afterCreated = (delivery) => waitGate(gate, delivery.signal);
      const pending = f.continuation.continue("child");
      const rejected = assert.rejects(pending, code("CONFLICT"));
      await until(() => f.deliveries[0]?.agent);
      const replacement = human();
      const recipient = f.agents.get(target);
      recipient.followup(replacement);
      await rejected;
      assert.equal(f.deliveries[0].message, undefined);
      assert.deepEqual(recipient.inbox.nextTurn, [replacement]);
      assert.equal(recipient.cancelled, 0);
      assert.equal(f.slotCount(), 0);
      gate.resolve();
    });
});

test("parent inputs and cancellation observed during cold inspection cannot arrive late as a new turn", async (t) => {
  for (const action of ["new-input", "parent-cancel"])
    await t.test(action, async (t) => {
      const f = fixture(t);
      const gate = deferred();
      f.hooks.inspect = (_, signal) => waitGate(gate, signal);
      const pending = f.continuation.continue("child");
      const rejected = assert.rejects(
        pending,
        code(action === "new-input" ? "CONFLICT" : "CANCELLED"),
      );
      await until(() => f.inspections.length === 1);
      if (action === "new-input") f.parent.followup(human("Parent changed the task"));
      else f.continuation.abortParent("parent");
      gate.resolve();
      await rejected;
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.slotCount(), 0);
    });
});

test("pending manual admission honors stop, parent cancellation, disabled controls and parent replacement", async (t) => {
  for (const action of [
    "stop",
    "parent-cancel",
    "disabled",
    "not-ready",
    "parent-replaced",
    "archived",
    "revoked",
  ])
    await t.test(action, async (t) => {
      const f = fixture(t);
      const gate = deferred();
      f.hooks.afterCreated = (delivery) => waitGate(gate, delivery.signal);
      const pending = f.continuation.continue("child");
      const expected = ["stop", "parent-cancel"].includes(action)
        ? "CANCELLED"
        : ["disabled", "not-ready"].includes(action)
          ? "DISABLED"
          : action === "archived"
            ? "SESSION_ARCHIVED"
            : action === "revoked"
              ? "ADMISSION_REQUIRED"
              : "CONFLICT";
      const rejected = assert.rejects(pending, code(expected));
      await until(() => f.deliveries[0]?.agent);
      let stop;
      if (action === "stop") stop = f.continuation.stop("child");
      else if (action === "parent-cancel") f.continuation.abortParent("parent");
      else if (action === "disabled") f.value.enabled = false;
      else if (action === "not-ready") f.setReady(false);
      else if (action === "parent-replaced") f.createAgent("parent");
      else if (action === "archived") f.services.workspaceRegistry.archivedSessionIds.push("child");
      else f.setAdmitted(false);
      gate.resolve();
      await rejected;
      if (stop) assert.equal((await stop).ownedRunCancelled, false);
      assert.equal(f.deliveries[0].message, undefined);
      assert.equal(f.slotCount(), 0);
      assert.equal(f.listenerCount(), 0);
    });
});

test("native rejection rolls back only the new slot and pending listeners", async (t) => {
  const f = fixture(t);
  f.hooks.beforeCreate = () => {
    throw Object.assign(new Error("Synthetic cold writer unavailable"), { code: "WRITER_HELD" });
  };
  await assert.rejects(f.continuation.continue("child"), code("WRITER_HELD"));
  assert.equal(f.slotCount(), 0);
  assert.equal(f.listenerCount(), 0);
  const status = await f.continuation.status("child");
  assert.equal(status.manualRun.status, "failed");
  assert.equal(status.lastError.code, "WRITER_HELD");
  assert.equal(f.sources.get("child").events.length, 2);
});

test("native acceptance without matching message evidence is partial and retains its live slot until end", async (t) => {
  const f = fixture(t);
  f.hooks.returnMessageId = "different-message";
  await assert.rejects(f.continuation.continue("child"), code("CONTINUATION_PARTIAL"));
  assert.equal(f.deliveries[0].message.source.kind, SOURCE);
  assert.equal(
    f.slotCount(),
    1,
    "Accepted execution cannot be treated as a failed unstarted request",
  );
  f.end(f.deliveries[0]);
  assert.equal(f.slotCount(), 0);
});

test("fast completion before delivery resolves is recorded as this new epoch's completion", async (t) => {
  const f = fixture(t);
  f.hooks.afterAccept = (delivery) => {
    delivery.agent.beginTurn();
    f.end(delivery);
  };
  const result = await f.continuation.continue("child");
  assert.equal(result.submitted, true);
  assert.equal(result.manualRun.status, "completed");
  assert.equal(result.manualRun.stopReason, "completed");
  assert.equal(f.slotCount(), 0);
  assert.equal(f.listenerCount(), 0);
});

test("stop retracts only owned queued messages and preserves later foreign input and slot observation", async (t) => {
  const f = fixture(t);
  await f.continuation.continue("child");
  const delivery = f.deliveries[0];
  const foreign = human("A separate child instruction");
  delivery.agent.followup(foreign);
  const stopped = await f.continuation.stop("child");
  assert.equal(stopped.ownedQueuedRemoved, 1);
  assert.equal(stopped.ownedRunCancelled, false);
  assert.deepEqual(delivery.agent.inbox.nextTurn, [foreign]);
  assert.equal(f.drains.length, 0);
  assert.equal(f.slotCount(), 1, "The current native epoch remains observed until it ends");
  delivery.agent.beginTurn();
  f.end(delivery);
  assert.equal(f.slotCount(), 0);
});

test("an exclusively owned active turn drains its new child epoch and reports native stop completion", async (t) => {
  const f = fixture(t);
  await f.continuation.continue("child");
  const delivery = f.deliveries[0];
  delivery.agent.beginTurn();
  const stopped = await f.continuation.stop("child");
  assert.equal(stopped.ownedRunCancelled, true);
  assert.equal(stopped.manualRun.status, "stopped");
  assert.equal(f.drains.length, 1);
  assert.equal(f.drains[0].parent, f.parent);
  assert.deepEqual(f.drains[0].ids, ["child"]);
  assert.equal(f.slotCount(), 0);
  assert.equal(delivery.agent.cancelled, 1);
});

test("failed native stop retains control until the paired native end confirms release", async (t) => {
  const f = fixture(t);
  await f.continuation.continue("child");
  const delivery = f.deliveries[0];
  delivery.agent.beginTurn();
  f.hooks.drain = () => {
    throw Object.assign(new Error("Synthetic teardown still active"), { code: "TEARDOWN_FAILED" });
  };
  await assert.rejects(f.continuation.stop("child"), code("TEARDOWN_FAILED"));
  assert.equal(f.continuation.controlsSession("child"), true);
  assert.equal(f.slotCount(), 1);
  f.end(delivery, "aborted");
  assert.equal(f.slotCount(), 0);
});

test("revoking project control preserves a turn containing foreign input and releases only local ownership", async (t) => {
  const f = fixture(t);
  await f.continuation.continue("child");
  const delivery = f.deliveries[0];
  const foreign = human("Host-owned replacement work");
  delivery.agent.followup(foreign);
  delivery.agent.beginTurn();
  const stop = await f.continuation.stop("child");
  assert.equal(stop.ownedRunCancelled, false);
  assert.equal(f.slotCount(), 1);
  await f.continuation.stopAll({ projectsOnly: true, revoke: true });
  assert.equal(f.drains.length, 0);
  assert.equal(delivery.agent.cancelled, 0);
  assert.equal(f.agents.get("child"), delivery.agent);
  assert.equal(f.continuation.controlsSession("child"), false);
  assert.equal(f.slotCount(), 0);
  const status = await f.continuation.status("child");
  assert.equal(status.manualRun.status, "released");
  assert.equal(status.lastError.code, "OWNERSHIP_RELEASED");
});

test("project continuation cannot take a full, foreign-owned or unfinished workflow slot", async (t) => {
  for (const scenario of ["full", "existing-slot", "workflow-active", "missing-role", "revoked"])
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      let expected = "CONFLICT";
      if (scenario === "full") {
        f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
        f.store.dispatch("workspaces.bind", { id: f.workspaceId, sessionId: "other-child" });
        f.flow.dispatch("flow.assign", {
          workspaceId: f.workspaceId,
          sessionId: "other-child",
          role: "analyst",
        });
        f.flow.dispatch("flow.acquire", { workspaceId: f.workspaceId, sessionId: "other-child" });
        expected = "SLOTS_FULL";
      } else if (scenario === "existing-slot")
        f.flow.dispatch("flow.acquire", { workspaceId: f.workspaceId, sessionId: "child" });
      else if (scenario === "workflow-active") f.workflow.controlled.add("child");
      else if (scenario === "missing-role") {
        f.flow.dispatch("flow.assign", {
          workspaceId: f.workspaceId,
          sessionId: "child",
          role: null,
        });
        expected = "ROLE_REQUIRED";
      } else {
        f.setAdmitted(false);
        expected = "ADMISSION_REQUIRED";
      }
      const before = f.flow.status(f.workspaceId).active;
      await assert.rejects(f.continuation.continue("child"), code(expected));
      assert.deepEqual(f.flow.status(f.workspaceId).active, before);
      assert.equal(f.deliveries.length, 0);
      assert.equal(f.continuation.controlsSession("child"), false);
    });
});

test("an ordinary local child resumes without acquiring a project role or slot", async (t) => {
  const f = fixture(t, { project: false });
  f.setAdmitted(false);
  const result = await f.continuation.continue("child");
  assert.equal(result.submitted, true);
  assert.equal(result.manualRun.slotHeld, false);
  assert.equal(f.slotCount(), 0);
  assert.equal(f.continuation.controlsSession("child"), false);
  f.end(f.deliveries[0]);
});
