import test from "node:test";
import assert from "node:assert/strict";
import { Continuation } from "../src/host/continuation.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { fixture, optionalHost, runtimeRoot, waitFor } from "./helpers/workflow-host-fixture.mjs";

async function enable(f, limit = 2) {
  await f.mountDesktopRuntime();
  const saved = f.store.dispatch("settings.get");
  f.store.dispatch("settings.save", {
    revision: saved.revision,
    value: { ...saved.value, autoContinue: true, continueLimit: limit },
  });
  const continuation = new Continuation(f.ctx, f.store, {
    supported: true,
    version: "0.2.1-rc.2",
    runtimeRoot,
  });
  await continuation.apply();
  f.onDispose(() => continuation.revert());
  const starts = [],
    ends = [],
    observations = [];
  f.onDispose(f.ctx.on("subagent/start", (event) => starts.push(event)));
  f.onDispose(f.ctx.on("subagent/end", (event) => ends.push(event)));
  // Production releases unowned Flow slots on turn/end/disposal. Owned workflow
  // receipts must remain responsible throughout the complete continuation chain.
  const release = (id) => {
    if (f.workflow.controlsSession(id)) return;
    const workspace = f.store.dispatch("workspaces.forSession", { sessionId: id }).item;
    if (workspace) f.flow.dispatch("flow.release", { workspaceId: workspace.id, sessionId: id });
  };
  f.onDispose(
    f.ctx.on("session/event", (session, event) => {
      if (event.type === "turn/end" && session.header.parentSession)
        observations.push(continuation.status({ sessionId: session.id }));
      if (event.type === "turn/end") release(session.id);
    }),
  );
  f.onDispose(f.ctx.on("agent/disposed", ({ agent }) => release(agent.id)));
  return { continuation, starts, ends, observations };
}

async function readEvents(f, id) {
  const handle = await f.ctx.sessionPersistence.open(id, "read");
  try {
    return (await handle.read()).events;
  } finally {
    await handle.close();
  }
}
const continuationInputs = (events) =>
  events.filter(
    (event) =>
      event.type === "user/message" && event.data.source.kind === "dsh-unlimit/continuation",
  );

test(
  "official workflow keeps one activation and its slot until the truncated child finishes, then starts dependents",
  optionalHost,
  async (t) => {
    let firstChild;
    const f = await fixture(t, {
      streamBehavior({ request, sessionRequestCount }) {
        firstChild ??= request.sessionId;
        if (request.sessionId !== firstChild) return "stop";
        return sessionRequestCount === 1 ? "max-tokens" : "hold";
      },
    });
    const { continuation, starts, ends } = await enable(f);
    f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
    const parent = await f.create();
    const plans = new DesktopWorkflowPlan(f.workflow);
    f.onDispose(() => plans.close());
    const { item } = await plans.dispatch("workflow.plan.create", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      tasks: [
        { id: "first", role: "analyst", task: "Synthetic first task", requirements: [] },
        {
          id: "second",
          role: "analyst",
          task: "Synthetic dependent task",
          requirements: [],
          dependsOn: ["first"],
        },
      ],
    });
    const address = { workspaceId: f.workspaceId, parentSessionId: parent.id, id: item.id };
    await waitFor(
      () => f.holds,
      (holds) => holds.length === 1,
    );
    const held = (await plans.dispatch("workflow.plan.status", address)).item;
    assert.equal(held.tasks[0].state, "running");
    assert.equal(held.tasks[0].receipt.slotReleased, false);
    assert.equal(held.tasks[1].state, "queued");
    assert.equal(f.flow.status(f.workspaceId).active.length, 1);
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 0);
    assert.equal(f.requests.length, 2);
    assert.equal(continuation.status({ sessionId: firstChild }).automaticCount, 1);
    const live = f.ctx.agents.get(firstChild);
    const input = continuationInputs(live.session.snapshotEvents());
    assert.equal(input.length, 1);
    assert.equal(input[0].data.source.mode, "automatic");
    const truncated = live.session
      .snapshotEvents()
      .find((event) => event.type === "turn/end" && event.data.reason.kind === "max-tokens");
    assert.equal(input[0].data.source.triggerSeq, truncated.seq);
    assert.equal(
      parent.session.snapshotEvents().filter((event) => event.type === "user/message").length,
      0,
    );

    f.holds[0].resolve();
    const done = await waitFor(
      () => plans.dispatch("workflow.plan.status", address),
      (result) => result.item.state === "completed",
    );
    assert.ok(done.item.tasks.every((task) => task.receipt.slotReleased && task.receipt.disposed));
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    for (const start of starts) {
      const terminal = ends.filter((event) => event.runId === start.runId);
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].id, start.id);
      assert.equal(terminal[0].stopReason, "completed");
    }
    assert.equal(
      starts.filter((event) => event.id === firstChild).length,
      1,
      "No cold-resume epoch",
    );
    assert.equal(f.requests.length, 3, "Two first-task turns and one dependent turn");
    assert.equal(
      parent.session.snapshotEvents().filter((event) => event.type === "user/message").length,
      0,
      "Caller delivery never becomes a parent wake/settlement message",
    );
    const persisted = await readEvents(f, firstChild);
    assert.deepEqual(continuationInputs(persisted), input);
    assert.equal(persisted.filter((event) => event.type === "turn/end").length, 2);
  },
);

test(
  "ordinary official children keep the same activation, respect the quota and notify their parent only once",
  optionalHost,
  async (t) => {
    let parentId;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior: ({ request }) => (request.sessionId === parentId ? "stop" : "max-tokens"),
    });
    const { starts, ends, observations } = await enable(f, 2);
    const parent = await f.create(null);
    parentId = parent.id;
    const receipt = await f.ctx.subagents.startActivation({
      provider: "spawn",
      label: "Synthetic bounded child",
      request: { parent, maxDepth: 1, prompt: [{ type: "text", text: "Synthetic child task" }] },
      signal: new AbortController().signal,
      delivery: "parent",
    });
    f.onDispose(() => receipt.dispose());
    const result = await receipt.result;
    await parent.whenIdle();
    assert.equal(result.stopReason, "max-tokens");
    assert.equal(
      f.requests.filter((request) => request.sessionId === receipt.childId).length,
      3,
      JSON.stringify({ starts, ends, observations }),
    );
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].runId, ends[0].runId);
    assert.equal(ends[0].stopReason, "max-tokens");
    assert.equal(
      f.flow.status(f.workspaceId).active.length,
      0,
      "Ordinary official children do not acquire project workflow slots",
    );
    const events = await readEvents(f, receipt.childId);
    const inputs = continuationInputs(events);
    assert.equal(inputs.length, 2);
    assert.equal(new Set(inputs.map((event) => event.data.source.triggerSeq)).size, 2);
    assert.equal(
      parent.session
        .snapshotEvents()
        .filter(
          (event) =>
            event.type === "user/message" &&
            event.data.source.kind === "subagent-settled" &&
            event.data.source.senderSessionId === receipt.childId,
        ).length,
      1,
      "The parent receives one final notification after the entire bounded chain",
    );
  },
);

test(
  "stopping an owned automatic child turn aborts it without a new activation or early slot release",
  optionalHost,
  async (t) => {
    const f = await fixture(t, {
      streamBehavior: ({ sessionRequestCount }) =>
        sessionRequestCount === 1 ? "max-tokens" : "hold",
    });
    const { continuation, starts, ends } = await enable(f);
    const parent = await f.create();
    const { item } = await f.workflow.dispatch("workflow.dispatch", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "analyst",
      task: "Synthetic cancel task",
    });
    await waitFor(
      () => f.holds,
      (holds) => holds.length === 1,
    );
    assert.equal(f.flow.status(f.workspaceId).active.length, 1);
    assert.equal(continuation.stop({ sessionId: item.sessionId }).ownedRunCancelled, true);
    const result = await waitFor(
      () =>
        f.workflow.dispatch("workflow.status", {
          workspaceId: f.workspaceId,
          id: item.id,
        }),
      (value) => value.item.slotReleased,
    );
    assert.equal(result.item.status, "stopped");
    assert.equal(result.item.disposed, true);
    assert.equal(f.holds[0].request.signal.aborted, true);
    assert.equal(f.requests.length, 2);
    assert.equal(starts.length, 1);
    assert.equal(ends.length, 1);
    assert.equal(starts[0].runId, ends[0].runId);
    assert.equal(ends[0].stopReason, "aborted");
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
  },
);
