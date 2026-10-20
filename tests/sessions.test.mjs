import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSessions, SessionOperationError } from "../src/host/sessions.js";
import { WorkspaceStore } from "../src/core/store.js";

const human = (text) => ({
  role: "user",
  source: { kind: "user", rpcId: "synthetic-user-request" },
  content: [{ type: "text", text }],
});
function events(entries) {
  return entries.map(([type, data = {}], seq) => ({
    type,
    data,
    seq,
    time: seq + 1,
    ...(["user/message", "assistant/message", "system/message"].includes(type)
      ? { surfaceOp: "append" }
      : {}),
  }));
}
function twoTurns() {
  return events([
    ["session/config"],
    ["turn/start", { turn: 1 }],
    ["step/start", { turn: 1, step: 1 }],
    ["user/message", human("Original first input")],
    ["assistant/message"],
    ["step/end"],
    ["turn/end"],
    ["turn/start", { turn: 2 }],
    ["step/start", { turn: 2, step: 1 }],
    ["user/message", human("Original second input\nPreserve exact text.")],
    [
      "user/message",
      {
        role: "user",
        source: { kind: "runtime-context" },
        content: [{ type: "text", text: "Internal synthetic notice" }],
      },
    ],
    ["assistant/message"],
    ["step/end"],
    ["step/start", { turn: 2, step: 2 }],
    ["assistant/message"],
    ["step/end"],
    ["turn/end"],
  ]);
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-sessions-"));
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const workspace = store.dispatch("workspaces.save", { name: "Synthetic session workspace" }).item;
  store.dispatch("workspaces.bind", { id: workspace.id, sessionId: "original" });
  const trace = [];
  const original = { meta: { id: "original", cwd: "/synthetic/workspace" }, events: twoTurns() };
  const agent = (id, parentSession, origin) => ({
    id,
    status: "running",
    inbox: { nextTurn: ["synthetic-pending"], nextStep: [] },
    session: {
      header: { id, ...(parentSession ? { parentSession } : {}), ...(origin ? { origin } : {}) },
    },
    async whenIdle() {
      trace.push(["idle", id]);
    },
  });
  const agents = [
    agent("original"),
    agent("child", "original", "subagent"),
    agent("grandchild", "child", "subagent"),
    agent("independent-fork", "original"),
  ];
  const registry = {
    archivedSessionIds: [],
    async archiveSession(id, options) {
      trace.push(["archive", id, options]);
      this.archivedSessionIds.push(id);
      for (const target of agents.filter((item) => item.id !== "independent-fork")) {
        target.status = "idle";
        target.inbox.nextTurn = [];
      }
    },
  };
  const controller = {
    async list(request) {
      trace.push(["list", request]);
      return {
        items: [
          {
            sessionId: "original",
            running: true,
            projections: { values: { title: "Synthetic title" } },
          },
          { sessionId: "archived", running: false },
        ],
      };
    },
    async inspect(id) {
      trace.push(["inspect", id]);
      return structuredClone(original);
    },
    async fork(request) {
      trace.push(["fork", request]);
      return { sessionId: "new-fork" };
    },
    async create(request) {
      trace.push(["create", request]);
      return { sessionId: "new-empty" };
    },
  };
  const services = {
    sessionController: controller,
    workspaceRegistry: registry,
    agents: { list: () => agents },
  };
  const adapter = new DesktopSessions({ get: (name) => services[name] }, store);
  return { adapter, store, workspace, trace, original, agents, registry, controller, services };
}
const writes = (trace) => trace.filter(([name]) => ["fork", "create", "archive"].includes(name));
const code = (expected) => (error) => error.code === expected;

test("capabilities and active session summaries use official services and session-specific workspace bindings", async (t) => {
  const { adapter, registry, trace, workspace } = fixture(t);
  registry.archivedSessionIds.push("archived");
  assert.equal(adapter.capabilities().rewind, true);
  assert.equal(adapter.capabilities().draftRestore, "client-bridge-required");
  assert.deepEqual(await adapter.list(), [
    { id: "original", name: "Synthetic title", status: "running", workspaceId: workspace.id },
  ]);
  assert.equal(writes(trace).length, 0);
});

test("prepare is read-only and chooses the exact previous turn boundary and human draft", async (t) => {
  const { adapter, trace, original } = fixture(t);
  const before = structuredClone(original);
  const plan = await adapter.prepare({ sessionId: "original" });
  assert.equal(plan.atSeq, 6);
  assert.equal(plan.strategy, "fork");
  assert.equal(plan.draft, "Original second input\nPreserve exact text.");
  assert.equal(plan.draft.includes("Internal"), false);
  assert.deepEqual(original, before);
  assert.deepEqual(writes(trace), []);
});

test("rewind forks, inherits workspace binding and archives while waiting for source and subagent stops", async (t) => {
  const { adapter, trace, store, workspace, original, agents } = fixture(t);
  const before = structuredClone(original);
  const result = await adapter.rewind({ id: "original", mode: "turn", draftBridgeReady: true });
  assert.equal(result.newSessionId, "new-fork");
  assert.equal(result.draftStatus, "pending-client");
  assert.equal(result.archived, true);
  assert.equal(result.archive.verified, true);
  assert.equal(result.binding.inherited, true);
  assert.equal(
    store.dispatch("workspaces.forSession", { sessionId: result.newSessionId }).item.id,
    workspace.id,
  );
  assert.deepEqual(trace.find(([name]) => name === "fork")[1], { sessionId: "original", atSeq: 6 });
  assert.deepEqual(
    trace.find(([name]) => name === "archive"),
    ["archive", "original", { stopActivity: true }],
  );
  assert.deepEqual(result.stop.settledIds, ["original", "child", "grandchild"]);
  assert.deepEqual(result.stop.pendingIds, []);
  assert.equal(agents.find((agent) => agent.id === "independent-fork").status, "running");
  assert.deepEqual(original, before);
  assert.equal(
    trace.some(([name]) => name === "prompt"),
    false,
  );
});

test("step mode rewinds only the final step; explicit cuts must name completed boundaries", async (t) => {
  const { adapter, trace } = fixture(t);
  const plan = await adapter.prepare({ sessionId: "original", mode: "step" });
  assert.equal(plan.atSeq, 12);
  assert.equal(plan.draft, "");
  assert.equal(
    (await adapter.prepare({ sessionId: "original", atSeq: 5 })).draft,
    "Original second input\nPreserve exact text.",
  );
  for (const atSeq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      adapter.rewind({ sessionId: "original", atSeq, draftBridgeReady: true }),
      code("INVALID_INPUT"),
    );
  for (const atSeq of [2, 16, 999])
    await assert.rejects(
      adapter.rewind({ sessionId: "original", atSeq, draftBridgeReady: true }),
      code("INVALID_REWIND_BOUNDARY"),
    );
  assert.deepEqual(writes(trace), []);
});

test("first-turn rewind creates an official blank session and returns its original text as an unsent draft", async (t) => {
  const { adapter, original, trace } = fixture(t);
  original.events = events([
    ["turn/start"],
    ["step/start"],
    ["user/message", human("First human sentence")],
    ["assistant/message"],
    ["step/end"],
    ["turn/end"],
  ]);
  const plan = await adapter.prepare({ sessionId: "original", mode: "step" });
  assert.equal(plan.strategy, "empty");
  const result = await adapter.rewind({ sessionId: "original", draftBridgeReady: true });
  assert.equal(result.newSessionId, "new-empty");
  assert.equal(result.draft, "First human sentence");
  assert.deepEqual(trace.find(([name]) => name === "create")[1], { cwd: "/synthetic/workspace" });
  assert.equal(
    trace.some(([name]) => name === "fork"),
    false,
  );
});

test("missing official interfaces or client handshake refuse before any write", async (t) => {
  const { adapter, controller, registry, services, trace } = fixture(t);
  await assert.rejects(adapter.rewind({ sessionId: "original" }), code("CLIENT_DRAFT_REQUIRED"));
  for (const [target, property] of [
    [controller, "inspect"],
    [controller, "fork"],
    [registry, "archiveSession"],
    [services.agents, "list"],
  ]) {
    const previous = target[property];
    delete target[property];
    try {
      await assert.rejects(
        adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
        code("UNSUPPORTED_CAPABILITY"),
      );
    } finally {
      target[property] = previous;
    }
  }
  assert.deepEqual(writes(trace), []);
});

test("bad event streams, subagent origin, non-human input and attachments refuse before writes", async (t) => {
  const { adapter, original, trace } = fixture(t);
  const valid = structuredClone(original);
  original.events[1].seq = 999;
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("INVALID_HOST_RESULT"),
  );
  original.events = valid.events;
  original.meta.origin = "subagent";
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("UNSUPPORTED_CAPABILITY"),
  );
  delete original.meta.origin;
  original.events = events([
    ["turn/start"],
    ["user/message", { ...human("Notice"), source: { kind: "runtime-context" } }],
    ["turn/end"],
  ]);
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("NO_REWIND_BOUNDARY"),
  );
  original.events = events([
    ["turn/start"],
    [
      "user/message",
      { ...human("An image"), content: [{ type: "image", attachment: { id: "synthetic-image" } }] },
    ],
    ["turn/end"],
  ]);
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("UNSUPPORTED_CAPABILITY"),
  );
  assert.deepEqual(writes(trace), []);
});

test("archived originals and missing target quiescence capability are refused before fork", async (t) => {
  const { adapter, registry, agents, trace } = fixture(t);
  registry.archivedSessionIds.push("original");
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("SESSION_ARCHIVED"),
  );
  registry.archivedSessionIds.length = 0;
  delete agents[1].whenIdle;
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("UNSUPPORTED_CAPABILITY"),
  );
  assert.deepEqual(writes(trace), []);
});

test("an archive failure reports the already-created session and binding without claiming success", async (t) => {
  const { adapter, registry, trace } = fixture(t);
  registry.archiveSession = async () => {
    throw new Error("Synthetic archive failure");
  };
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    (error) => {
      assert.ok(error instanceof SessionOperationError);
      assert.equal(error.code, "REWIND_PARTIAL");
      assert.equal(error.partial.failedAt, "archive");
      assert.equal(error.partial.newSessionId, "new-fork");
      assert.equal(error.partial.binding.inherited, true);
      assert.equal(error.partial.archived, false);
      assert.equal(error.partial.draftStatus, "pending-client");
      return true;
    },
  );
  assert.equal(trace.filter(([name]) => name === "fork").length, 1);
});

test("official partial fork errors retain the disclosed new identity and never archive the original", async (t) => {
  const { adapter, controller, registry } = fixture(t);
  controller.fork = async () => {
    const error = new Error("Synthetic workspace attachment failed");
    error.code = "session/workspace-attach-failed";
    error.data = { sessionId: "partially-created" };
    throw error;
  };
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    (error) =>
      error.partial?.newSessionId === "partially-created" &&
      error.partial.failedAt === "fork" &&
      error.partial.outcomeUnknown === false,
  );
  assert.deepEqual(registry.archivedSessionIds, []);
});

test("stop verification failure reports the archived source and pending agents", async (t) => {
  const { adapter, registry } = fixture(t);
  registry.archiveSession = async function (id) {
    this.archivedSessionIds.push(id);
  };
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    (error) => {
      assert.equal(error.partial.failedAt, "stop");
      assert.equal(error.partial.archived, true);
      assert.equal(error.partial.causeCode, "STOP_INCOMPLETE");
      assert.deepEqual(error.partial.stop.pendingIds, ["original", "child", "grandchild"]);
      return true;
    },
  );
});

test("concurrent rewinds of one source are serialized by rejection and cannot double-fork", async (t) => {
  const { adapter, controller, trace } = fixture(t);
  const inspect = controller.inspect;
  let resume;
  const gate = new Promise((resolve) => {
    resume = resolve;
  });
  controller.inspect = async (id) => {
    await gate;
    return inspect(id);
  };
  const first = adapter.rewind({ sessionId: "original", draftBridgeReady: true });
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("CONFLICT"),
  );
  resume();
  await first;
  assert.equal(trace.filter(([name]) => name === "fork").length, 1);
});
