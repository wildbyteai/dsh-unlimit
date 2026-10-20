import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopSessions, SessionOperationError } from "../src/host/sessions.js";
import { WorkspaceStore } from "../src/core/store.js";
import { rewindSummary } from "../web/rewind.js";

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
    cancel(cause) {
      trace.push(["cancel", id, cause]);
      this.status = "idle";
      this.inbox.nextTurn = [];
      this.inbox.nextStep = [];
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
      agents.push(agent("new-fork"));
      return { sessionId: "new-fork" };
    },
    async create(request) {
      trace.push(["create", request]);
      agents.push(agent("new-empty"));
      return { sessionId: "new-empty" };
    },
  };
  const services = {
    sessionController: controller,
    workspaceRegistry: registry,
    agents: { list: () => agents, get: (id) => agents.find((item) => item.id === id) },
  };
  const adapter = new DesktopSessions({ get: (name) => services[name] }, store);
  t.after(() => adapter.close());
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
  assert.deepEqual(result.newSessionStop, {
    requested: true,
    settledIds: ["new-fork"],
    pendingIds: [],
  });
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
    [services.agents, "get"],
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

test("bad event streams, missing subagent lineage, non-human input and unacknowledged attachments refuse before writes", async (t) => {
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
    code("INVALID_HOST_RESULT"),
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
    code("CLIENT_ATTACHMENTS_REQUIRED"),
  );
  assert.deepEqual(writes(trace), []);
});

test("archived originals and missing cancellation or quiescence capability are refused before fork", async (t) => {
  const { adapter, registry, agents, trace } = fixture(t);
  registry.archivedSessionIds.push("original");
  await assert.rejects(
    adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    code("SESSION_ARCHIVED"),
  );
  registry.archivedSessionIds.length = 0;
  for (const method of ["whenIdle", "cancel"]) {
    const original = agents[1][method];
    delete agents[1][method];
    await assert.rejects(
      adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
      code("UNSUPPORTED_CAPABILITY"),
    );
    agents[1][method] = original;
  }
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
  const { adapter, registry, agents } = fixture(t);
  registry.archiveSession = async function (id) {
    this.archivedSessionIds.push(id);
  };
  for (const agent of agents) agent.cancel = () => {};
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

function lineageFixture(t) {
  const f = fixture(t);
  f.original.inheritedEventCount = 0;
  f.original.meta.createdAt = 10;
  const rootEntries = f.original.events.map((event) => [event.type, event.data]);
  rootEntries.splice(15, 0, [
    "subagent/catalog",
    { version: 0, childId: "child", childCreatedAt: 20, mode: "continuable" },
  ]);
  rootEntries.push(
    ["turn/start", { turn: 3 }],
    ["step/start", { turn: 3, step: 1 }],
    ["user/message", human("Later unrelated human turn")],
    ["step/end"],
    ["turn/end"],
  );
  f.original.events = events(rootEntries);
  const child = {
    meta: { id: "child", origin: "subagent", parentSession: "original", createdAt: 20 },
    inheritedEventCount: 0,
    events: events([
      [
        "subagent/descriptor",
        { version: 3, mode: "continuable", provider: "spawn", label: "child" },
      ],
      ["turn/start", { turn: 1 }],
      ["step/start", { turn: 1, step: 1 }],
      ["user/message", human("Synthetic delegated task")],
      [
        "subagent/catalog",
        { version: 0, childId: "grandchild", childCreatedAt: 30, mode: "one-shot" },
      ],
      ["step/end"],
      ["turn/end"],
    ]),
  };
  const grandchild = {
    meta: { id: "grandchild", origin: "subagent", parentSession: "child", createdAt: 30 },
    inheritedEventCount: 0,
    events: events([["subagent/descriptor", { version: 3, mode: "one-shot", provider: "spawn" }]]),
  };
  const records = new Map([
    ["original", f.original],
    ["child", child],
    ["grandchild", grandchild],
  ]);
  f.controller.inspect = async (id) => {
    f.trace.push(["inspect", id]);
    return structuredClone(records.get(id));
  };
  return { ...f, child, grandchild, records };
}

test("a child's creation maps to its parent turn or step rather than the parent's latest input", async (t) => {
  const { adapter, trace, original } = lineageFixture(t);
  const before = structuredClone(original);
  const turn = await adapter.prepare({ sessionId: "child" });
  assert.equal(turn.sessionId, "original");
  assert.equal(turn.atSeq, 6);
  assert.equal(turn.draft, "Original second input\nPreserve exact text.");
  assert.equal(turn.mapping.basis, "creation");
  assert.equal(turn.mapping.requestedSessionId, "child");
  assert.equal(turn.mapping.links[0].catalogSeq, 15);
  const step = await adapter.prepare({ sessionId: "child", mode: "step" });
  assert.equal(step.atSeq, 12);
  assert.equal(step.draft, "Later unrelated human turn");
  // A step cut retains the original human input; only the later removed input
  // becomes a draft, never the synthetic delegated child task.
  assert.deepEqual(original, before);
  assert.deepEqual(writes(trace), []);
  await assert.rejects(
    adapter.prepare({ sessionId: "child", atSeq: 5 }),
    code("INVALID_REWIND_BOUNDARY"),
  );
});

test("nested creation follows only exact owned catalog links and inherits the root workspace", async (t) => {
  const { adapter, trace, workspace } = lineageFixture(t);
  const result = await adapter.rewind({ sessionId: "grandchild", draftBridgeReady: true });
  assert.equal(result.sessionId, "original");
  assert.equal(result.workspaceId, workspace.id);
  assert.equal(result.mapping.links.length, 2);
  assert.equal(result.mapping.targetSessionId, "original");
  assert.deepEqual(result.stop.settledIds, ["original", "child", "grandchild"]);
  assert.deepEqual(trace.find(([name]) => name === "fork")[1], { sessionId: "original", atSeq: 6 });
  assert.deepEqual(trace.find(([name]) => name === "archive").slice(1), [
    "original",
    { stopActivity: true },
  ]);
});

test("ambiguous, inherited, mismatched, cyclic or unassociated lineage never creates a branch", async (t) => {
  const cases = [
    (f) => {
      f.original.inheritedEventCount = 16;
    },
    (f) => {
      f.original.events[15].data.childCreatedAt++;
    },
    (f) => {
      f.original.events[15].data.version = 9;
    },
    (f) => {
      f.child.events[0].data.mode = "one-shot";
    },
    (f) => {
      f.child.meta.parentSession = "child";
    },
    (f) => {
      f.child.meta.parentSession = "missing";
    },
    (f) => {
      f.original.events.splice(15, 0, {
        type: "subagent/catalog",
        data: { ...f.original.events[15].data },
      });
    },
    (f) => {
      f.original.events.splice(15, 0, { type: "step/end", data: {} });
    },
  ];
  for (const change of cases) {
    const f = lineageFixture(t);
    change(f);
    f.original.events.forEach((event, seq) => {
      event.seq = seq;
    });
    await assert.rejects(
      f.adapter.rewind({ sessionId: "child", draftBridgeReady: true }),
      (error) =>
        ["INVALID_HOST_RESULT", "AMBIGUOUS_REWIND_SOURCE", "NO_REWIND_BOUNDARY"].includes(
          error.code,
        ),
    );
    assert.deepEqual(writes(f.trace), []);
  }
});

test("later or steered nested parents cannot falsely attribute a descendant to the root creation turn", async (t) => {
  for (const extra of [
    ["turn/start", { turn: 2 }],
    [
      "user/message",
      { ...human("Later parent direction"), source: { kind: "agent-message", form: "relay" } },
    ],
    ["user/message", human("Later child human input")],
  ]) {
    const f = lineageFixture(t);
    const entries = f.child.events.map((event) => [event.type, event.data]);
    entries.splice(4, 0, extra);
    f.child.events = events(entries);
    await assert.rejects(
      f.adapter.rewind({ sessionId: "grandchild", draftBridgeReady: true }),
      (error) => ["AMBIGUOUS_REWIND_SOURCE", "NO_REWIND_BOUNDARY"].includes(error.code),
    );
    assert.deepEqual(writes(f.trace), []);
  }
});

test("shared ancestor locks prevent concurrent child and parent rewinds and are released after completion", async (t) => {
  const f = lineageFixture(t);
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const fork = f.controller.fork;
  f.controller.fork = async (request) => {
    started.resolve();
    await resume.promise;
    return fork(request);
  };
  const first = f.adapter.rewind({ sessionId: "child", draftBridgeReady: true });
  await started.promise;
  for (const sessionId of ["original", "grandchild"])
    await assert.rejects(f.adapter.rewind({ sessionId, draftBridgeReady: true }), code("CONFLICT"));
  resume.resolve();
  await first;
  assert.equal(f.adapter.inFlight.size, 0);
  assert.equal(f.trace.filter(([name]) => name === "fork").length, 1);
});

test("new branch inbox must be cleared and observed before the original is archived", async (t) => {
  const f = fixture(t);
  const result = await f.adapter.rewind({ sessionId: "original", draftBridgeReady: true });
  assert.equal(f.services.agents.get(result.newSessionId).inbox.nextTurn.length, 0);
  assert.ok(
    f.trace.findIndex(([name, id]) => name === "cancel" && id === "new-fork") <
      f.trace.findIndex(([name]) => name === "archive"),
  );
  const broken = fixture(t);
  broken.services.agents.get = () => undefined;
  await assert.rejects(
    broken.adapter.rewind({ sessionId: "original", draftBridgeReady: true }),
    (error) =>
      error.partial?.failedAt === "settle-new" &&
      error.partial.newSessionId === "new-fork" &&
      error.partial.archived === false,
  );
  assert.deepEqual(broken.registry.archivedSessionIds, []);
});

test("rewind result displays the mapped source and queue evidence without claiming navigation or hiding partial failure", () => {
  const outcome = {
    archived: true,
    newSessionId: "synthetic-new",
    atSeq: 6,
    mapping: { basis: "creation", requestedSessionId: "<child>", targetSessionId: "root" },
    draftStatus: "restored",
    openStatus: "requested",
    newSessionStop: { requested: true, settledIds: ["synthetic-new"], pendingIds: [] },
  };
  const html = rewindSummary(outcome);
  assert.ok(html.includes("&lt;child&gt;"));
  assert.ok(html.includes("保留到事件 6"));
  assert.ok(html.includes("新分支待处理输入已清空"));
  assert.ok(html.includes("页面切换尚无完成回执"));
  assert.ok(html.includes("没有自动发送"));
  const partial = rewindSummary({
    ...outcome,
    archived: false,
    draftStatus: "host-partial",
    newSessionStop: { requested: true, settledIds: [], pendingIds: ["synthetic-new"] },
    error: "<synthetic error>",
  });
  assert.ok(partial.includes("宿主回退尚未完成"));
  assert.ok(partial.includes("清理未确认"));
  assert.ok(partial.includes("&lt;synthetic error&gt;"));
  assert.ok(!partial.includes("文字草稿已恢复"));
});

function withAttachments(f) {
  const image = {
    attachmentId: `sha256:${"a".repeat(64)}`,
    name: "synthetic.png",
    bytes: 3,
    mediaType: "image/png",
    width: 1,
    height: 1,
  };
  const file = { attachmentId: `sha256:${"b".repeat(64)}`, name: "synthetic.txt", bytes: 4 };
  f.original.events[9].data.content = [
    { type: "text", text: "before" },
    { type: "image", attachment: image },
    { type: "file", attachment: file },
    { type: "text", text: "after" },
  ];
  f.services.attachments = {
    imageLimits: {
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100,
      maxImageBytes: 100,
      mediaTypes: ["image/png"],
    },
    async readImage(ref, signal) {
      signal.throwIfAborted();
      return { ref, data: Uint8Array.from([1, 2, 3]) };
    },
    async *readFileStream(ref, signal) {
      signal.throwIfAborted();
      yield Uint8Array.from([4, 5]);
      yield Uint8Array.from([6, 7]);
    },
  };
  return { image, file };
}
const attachmentsHandshake = {
  sessionId: "original",
  draftBridgeReady: true,
  draftBridgeSupports: { attachments: true },
};

test("attachment batch is immutable, ordered, unreadable before completion and restricted to the bound target", async (t) => {
  const f = fixture(t);
  withAttachments(f);
  const plan = await f.adapter.prepare(attachmentsHandshake);
  assert.equal(plan.draft, "beforeafter");
  assert.deepEqual(
    plan.attachmentBatch.items.map(({ type, partIndex }) => [type, partIndex]),
    [
      ["image", 1],
      ["file", 2],
    ],
  );
  assert.equal(
    JSON.stringify(plan).includes("sha256:"),
    false,
    "No ref can be supplied back to the byte reader",
  );
  await assert.rejects(
    f.adapter.attachment({ token: plan.attachmentBatch.token, index: 0, newSessionId: "new-fork" }),
    code("ATTACHMENT_BATCH_UNBOUND"),
  );
  const result = await f.adapter.rewind(attachmentsHandshake);
  const request = {
    token: result.attachmentBatch.token,
    index: 0,
    newSessionId: result.newSessionId,
  };
  await assert.rejects(
    f.adapter.attachment({ ...request, newSessionId: "unrelated" }),
    code("ATTACHMENT_BATCH_UNBOUND"),
  );
  await assert.rejects(
    f.adapter.attachment({ ...request, sourceSession: "unrelated", ref: {} }),
    code("INVALID_INPUT"),
  );
  assert.equal((await f.adapter.attachment(request)).item.contentBase64, "AQID");
  assert.equal(
    (await f.adapter.attachment({ ...request, index: 1 })).item.contentBase64,
    "BAUGBw==",
  );
  f.original.events[9].data.content[1].attachment.bytes = 2;
  await assert.rejects(f.adapter.attachment(request), code("ATTACHMENT_AUTHORIZATION_CHANGED"));
});

test("missing attachment APIs and current official image limits refuse before any fork/archive", async (t) => {
  const f = fixture(t);
  withAttachments(f);
  delete f.services.attachments.readFileStream;
  await assert.rejects(f.adapter.rewind(attachmentsHandshake), code("UNSUPPORTED_CAPABILITY"));
  assert.deepEqual(writes(f.trace), []);
  withAttachments(f);
  f.services.attachments.imageLimits.maxImageBytes = 2;
  await assert.rejects(f.adapter.rewind(attachmentsHandshake), code("UNSUPPORTED_CAPABILITY"));
  assert.deepEqual(writes(f.trace), []);
});

test("attachment release, deadline and close cancel reads; reader rejects byte/ref mismatch", async (t) => {
  for (const mode of ["release", "deadline", "close", "short", "overrun", "different-ref"]) {
    const f = fixture(t);
    withAttachments(f);
    const result = await f.adapter.rewind(attachmentsHandshake);
    const token = result.attachmentBatch.token;
    const request = {
      token,
      index: mode === "different-ref" ? 0 : 1,
      newSessionId: result.newSessionId,
    };
    if (["release", "deadline", "close"].includes(mode)) {
      const gate = Promise.withResolvers();
      let signal;
      f.services.attachments.readFileStream = async function* (ref, observed) {
        signal = observed;
        await gate.promise;
        yield Uint8Array.from([4, 5, 6, 7]);
      };
      const reading = f.adapter.attachment(request);
      await new Promise((resolve) => setImmediate(resolve));
      if (mode === "release") {
        assert.deepEqual(f.adapter.releaseAttachments({ token }), { released: true });
        assert.deepEqual(f.adapter.releaseAttachments({ token }), { released: false });
      }
      if (mode === "deadline")
        f.adapter.attachmentBatches.now = () => result.attachmentBatch.expiresAt;
      if (mode === "close") f.adapter.close();
      gate.resolve();
      await assert.rejects(reading, code("ATTACHMENT_BATCH_EXPIRED"));
      assert.equal(signal.aborted, true);
    } else {
      if (mode === "different-ref")
        f.services.attachments.readImage = async (ref) => ({
          ref: { ...ref, name: "other.png" },
          data: new Uint8Array(3),
        });
      else
        f.services.attachments.readFileStream = async function* () {
          yield new Uint8Array(mode === "short" ? 3 : 5);
        };
      await assert.rejects(f.adapter.attachment(request), code("INVALID_HOST_RESULT"));
    }
  }
});

test("failed rewind releases its attachment authorization and never exposes a token in partial results", async (t) => {
  const f = fixture(t);
  withAttachments(f);
  f.registry.archiveSession = async () => {
    throw new Error("synthetic archive failure");
  };
  await assert.rejects(f.adapter.rewind(attachmentsHandshake), (error) => {
    assert.equal(error.code, "REWIND_PARTIAL");
    assert.equal(error.partial.attachmentBatch, undefined);
    assert.equal(f.adapter.attachmentBatches.batches.size, 0);
    return true;
  });
});
