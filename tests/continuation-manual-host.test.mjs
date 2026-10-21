import test from "node:test";
import assert from "node:assert/strict";
import { Continuation } from "../src/host/continuation.js";
import { fixture, optionalHost, runtimeRoot, waitFor } from "./helpers/workflow-host-fixture.mjs";

async function enable(f) {
  await f.mountDesktopRuntime();
  const continuation = new Continuation(
    f.ctx,
    f.store,
    { supported: true, version: "0.2.1-rc.2", runtimeRoot },
    { flow: f.flow, workflow: f.workflow },
  );
  await continuation.apply();
  f.onDispose(() => continuation.revert());
  const starts = [],
    ends = [],
    slotsAtDisposal = [];
  f.onDispose(f.ctx.on("subagent/start", (event) => starts.push(event)));
  f.onDispose(f.ctx.on("subagent/end", (event) => ends.push(event)));
  const release = (id) => {
    if (f.workflow.controlsSession(id) || continuation.controlsSession(id)) return;
    const workspace = f.store.dispatch("workspaces.forSession", { sessionId: id }).item;
    if (workspace) f.flow.dispatch("flow.release", { workspaceId: workspace.id, sessionId: id });
  };
  f.onDispose(
    f.ctx.on("agent/disposed", ({ agent }) => {
      slotsAtDisposal.push({ id: agent.id, held: continuation.controlsSession(agent.id) });
      release(agent.id);
    }),
  );
  f.onDispose(
    f.ctx.on("session/event", (session, event) => {
      if (event.type === "turn/end") release(session.id);
    }),
  );
  return { continuation, starts, ends, slotsAtDisposal };
}

async function endedWorkflow(f, parent) {
  const { item } = await f.workflow.dispatch("workflow.dispatch", {
    workspaceId: f.workspaceId,
    parentSessionId: parent.id,
    role: "analyst",
    task: "Synthetic local child with one truncated response",
  });
  return (
    await waitFor(
      () =>
        f.workflow.dispatch("workflow.status", {
          workspaceId: f.workspaceId,
          id: item.id,
        }),
      (value) => value.item.disposed && value.item.slotReleased,
    )
  ).item;
}

test(
  "manual cold continuation creates a new epoch with current prompt/role, one slot and an independently stoppable receipt",
  optionalHost,
  async (t) => {
    let parentId;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior({ request, sessionRequestCount }) {
        return request.sessionId === parentId
          ? "stop"
          : sessionRequestCount === 1
            ? "max-tokens"
            : "hold";
      },
    });
    const { continuation, starts, ends, slotsAtDisposal } = await enable(f);
    f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
    const parent = await f.create();
    parentId = parent.id;
    const old = await endedWorkflow(f, parent);
    assert.equal(f.ctx.agents.get(old.sessionId), undefined);
    assert.equal(old.result.stopReason, "max-tokens");
    assert.equal((await continuation.status({ sessionId: old.sessionId })).manualAvailable, true);
    const saved = f.store.dispatch("settings.get");
    f.store.dispatch("settings.save", {
      revision: saved.revision,
      value: {
        ...saved.value,
        autoContinue: false,
        prompt: "CURRENT_MANUAL_SYSTEM_MARKER",
        continueText: "CURRENT_CONTINUE_MARKER",
      },
    });
    f.store.dispatch("roles.save", {
      workspaceId: f.workspaceId,
      role: "analyst",
      content: "CURRENT_MANUAL_ROLE_MARKER",
    });
    const pending = continuation.continue({ sessionId: old.sessionId });
    await assert.rejects(
      continuation.continue({ sessionId: old.sessionId }),
      (error) => error.code === "CONFLICT",
    );
    const accepted = await pending;
    assert.equal(accepted.submitted, true);
    assert.equal(accepted.source.mode, "manual");
    assert.equal(accepted.manualRun.slotHeld, true);
    await waitFor(
      () => f.holds,
      (holds) => holds.length === 1,
    );
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].runId, starts[1].runId);
    assert.equal(accepted.manualRun.runId, starts[1].runId);
    assert.equal(f.flow.status(f.workspaceId).active.length, 1);
    const request = f.requests.filter((item) => item.sessionId === old.sessionId).at(-1);
    const system = request.messages
      .filter((message) => message.role === "system")
      .flatMap((message) => message.content)
      .map((part) => part.text ?? "")
      .join("\n");
    assert.match(system, /CURRENT_MANUAL_SYSTEM_MARKER/);
    assert.match(system, /CURRENT_MANUAL_ROLE_MARKER/);
    const child = f.ctx.agents.get(old.sessionId);
    const input = child.session
      .snapshotEvents()
      .find((event) => event.type === "user/message" && event.data.id === accepted.messageId);
    assert.equal(input.data.source.continuationId, accepted.manualRun.id);
    assert.equal(input.data.content[0].text, "CURRENT_CONTINUE_MARKER");
    assert.equal(continuation.status({ sessionId: old.sessionId }).automaticCount, 0);
    const stopped = await continuation.stop({ sessionId: old.sessionId });
    assert.equal(stopped.ownedRunCancelled, true);
    assert.equal(stopped.manualRun.status, "stopped");
    assert.equal(stopped.manualRun.slotHeld, false);
    assert.equal(f.holds[0].request.signal.aborted, true);
    assert.equal(ends.length, 2);
    assert.equal(ends[1].stopReason, "aborted");
    assert.ok(
      slotsAtDisposal.some((item) => item.id === old.sessionId && item.held),
      "Slot is held through native agent disposal, until paired end",
    );
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    assert.deepEqual(
      (await f.workflow.dispatch("workflow.status", { workspaceId: f.workspaceId, id: old.id }))
        .item,
      old,
    );
    await parent.whenIdle();
    const persisted = await f.ctx.sessionController.inspect(old.sessionId);
    assert.equal(
      persisted.events.filter(
        (event) => event.type === "user/message" && event.data.id === accepted.messageId,
      ).length,
      1,
    );
  },
);

test(
  "ordinary ended child can resume without project slots and produces the native parent settlement notification",
  optionalHost,
  async (t) => {
    let parentId;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior: ({ request, sessionRequestCount }) =>
        request.sessionId !== parentId && sessionRequestCount === 1 ? "max-tokens" : "stop",
    });
    const { continuation, starts, ends } = await enable(f);
    const parent = await f.create(null);
    parentId = parent.id;
    const receipt = await f.ctx.subagents.startActivation({
      provider: "spawn",
      label: "Synthetic ordinary child",
      request: { parent, maxDepth: 1, prompt: [{ type: "text", text: "Synthetic task" }] },
      signal: new AbortController().signal,
      delivery: "caller",
    });
    f.onDispose(() => receipt.dispose());
    await receipt.result;
    const accepted = await continuation.continue({ sessionId: receipt.childId });
    const final = await waitFor(
      () => continuation.status({ sessionId: receipt.childId }),
      (value) => value.manualRun?.status === "completed",
    );
    await parent.whenIdle();
    assert.equal(final.manualAvailable, false);
    assert.equal(final.eligibleReason, "completed");
    assert.equal(final.manualRun.slotHeld, false);
    assert.equal(starts.length, 2);
    assert.equal(ends.length, 2);
    assert.notEqual(starts[0].runId, starts[1].runId);
    const observed = await f.ctx.sessionController.inspect(receipt.childId);
    const manual = observed.events.filter(
      (event) => event.type === "user/message" && event.data.id === accepted.messageId,
    );
    assert.equal(manual.length, 1);
    assert.equal(manual[0].data.source.kind, "dsh-unlimit/continuation");
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
    );
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
  },
);

test(
  "a completed workflow must acquire a new slot before cold continuation; a full workspace makes no native resume",
  optionalHost,
  async (t) => {
    let firstChild;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior({ request }) {
        firstChild ??= request.sessionId;
        return request.sessionId === firstChild ? "max-tokens" : "hold";
      },
    });
    const { continuation, starts } = await enable(f);
    f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
    const parent = await f.create();
    const old = await endedWorkflow(f, parent);
    const active = await f.workflow.dispatch("workflow.dispatch", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "analyst",
      task: "Synthetic holding task",
    });
    await waitFor(
      () => f.holds,
      (holds) => holds.length === 1,
    );
    await assert.rejects(
      continuation.continue({ sessionId: old.sessionId }),
      (error) => error.code === "SLOTS_FULL",
    );
    assert.equal(starts.length, 2);
    assert.equal(f.ctx.agents.get(old.sessionId), undefined);
    assert.equal(f.flow.status(f.workspaceId).active[0].sessionId, active.item.sessionId);
    await f.workflow.dispatch("workflow.stop", { workspaceId: f.workspaceId, id: active.item.id });
  },
);

test(
  "new parent input during native cold creation aborts manual admission before any child request",
  optionalHost,
  async (t) => {
    let parentId;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior: ({ request }) => (request.sessionId === parentId ? "stop" : "max-tokens"),
    });
    const { continuation } = await enable(f);
    const parent = await f.create();
    parentId = parent.id;
    const old = await endedWorkflow(f, parent);
    let reached = false,
      release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.onDispose(() => release());
    f.onDispose(
      f.ctx.on("agent/created", async ({ agent }) => {
        if (agent.id === old.sessionId) {
          reached = true;
          await gate;
        }
      }),
    );
    const outcome = continuation.continue({ sessionId: old.sessionId }).then(
      () => assert.fail("Stale manual input must not be accepted"),
      (error) => error,
    );
    await waitFor(() => reached, Boolean);
    parent.followup(
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "Synthetic newer parent input" }],
      }),
    );
    release();
    const error = await outcome;
    assert.equal(error.code, "CONFLICT");
    await parent.whenIdle();
    assert.equal(f.requests.filter((item) => item.sessionId === old.sessionId).length, 1);
    assert.equal(f.ctx.agents.get(old.sessionId), undefined);
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    const observed = await f.ctx.sessionController.inspect(old.sessionId);
    assert.equal(
      observed.events.filter(
        (event) =>
          event.type === "user/message" && event.data.source.kind === "dsh-unlimit/continuation",
      ).length,
      0,
    );
  },
);

test(
  "stopping manual continuation preserves a later foreign child input and holds the epoch slot until native settlement",
  optionalHost,
  async (t) => {
    let parentId;
    const f = await fixture(t, {
      captureAll: true,
      streamBehavior({ request, sessionRequestCount }) {
        if (request.sessionId === parentId) return "stop";
        return sessionRequestCount === 1
          ? "max-tokens"
          : sessionRequestCount === 2
            ? "hold"
            : "stop";
      },
    });
    const { continuation } = await enable(f);
    const parent = await f.create();
    parentId = parent.id;
    const old = await endedWorkflow(f, parent);
    await continuation.continue({ sessionId: old.sessionId });
    await waitFor(
      () => f.holds,
      (holds) => holds.length === 1,
    );
    const foreignId = await f.ctx.subagents[Symbol.for("dsh.subagent.deliverPrompt")](
      parent,
      old.sessionId,
      [{ type: "text", text: "Synthetic foreign input to preserve" }],
      { kind: "user" },
      new AbortController().signal,
      "queue",
    );
    const stopped = await continuation.stop({ sessionId: old.sessionId });
    assert.equal(stopped.ownedRunCancelled, false);
    assert.equal(f.holds[0].request.signal.aborted, false);
    assert.equal(
      f.ctx.agents.get(old.sessionId).inbox.nextTurn.some((message) => message.id === foreignId),
      true,
    );
    assert.equal(stopped.manualRun.slotHeld, true);
    f.holds[0].resolve();
    const done = await waitFor(
      () => continuation.status({ sessionId: old.sessionId }),
      (value) => value.manualRun?.status === "completed",
    );
    assert.equal(done.manualRun.slotHeld, false);
    await parent.whenIdle();
    const observed = await f.ctx.sessionController.inspect(old.sessionId);
    assert.equal(
      observed.events.filter(
        (event) => event.type === "user/message" && event.data.id === foreignId,
      ).length,
      1,
    );
  },
);
