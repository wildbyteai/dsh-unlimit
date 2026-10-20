import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";
import { Flow } from "../src/core/flow.js";
import { DesktopWorkflow, WORKFLOW_PRESET_ID } from "../src/host/workflow.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-workflow-"));
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  const flow = new Flow(store);
  const workspace = store.dispatch("workspaces.save", {
    name: "Synthetic supplied text",
    scope: "Synthetic input only",
    authorization: "Synthetic fixture task authorization",
  }).item;
  const other = store.dispatch("workspaces.save", { name: "Other synthetic workspace" }).item;
  const agents = new Map([
    ["parent-a", { id: "parent-a" }],
    ["parent-b", { id: "parent-b" }],
    ["unbound", { id: "unbound" }],
  ]);
  store.dispatch("workspaces.bind", { id: workspace.id, sessionId: "parent-a" });
  store.dispatch("workspaces.bind", { id: other.id, sessionId: "parent-b" });
  const starts = [],
    disposals = [],
    pending = new Map(),
    definitions = new Map();
  let startError,
    disposalFailures = 0;
  const services = {
    agents: { get: (id) => agents.get(id) },
    subagents: {
      getProvider: (name) =>
        name === "spawn"
          ? { prepareContinuable() {}, capabilities: { agentPreset: true } }
          : undefined,
      resolveMaxDepth: () => 1,
      async startActivation(spec) {
        starts.push(spec);
        assert.equal(
          store.dispatch("workspaces.forSession", { sessionId: spec.childId }).item.id,
          spec.request.parent.id === "parent-a" ? workspace.id : other.id,
        );
        assert.ok(
          flow
            .status(store.dispatch("workspaces.forSession", { sessionId: spec.childId }).item.id)
            .active.some((item) => item.sessionId === spec.childId),
          "Slot must exist before official factory call",
        );
        if (startError) throw startError;
        const done = deferred();
        pending.set(spec.childId, done);
        return {
          childId: spec.childId,
          messageId: "accepted-message",
          result: done.promise,
          async dispose() {
            disposals.push(spec.childId);
            if (disposalFailures > 0) {
              disposalFailures--;
              throw new Error("Synthetic disposer not confirmed");
            }
            done.resolve({ output: [], stopReason: "aborted" });
          },
        };
      },
    },
    agentPresets: {
      list: async () => [...definitions.values()],
      resolve: async (id) => {
        assert.ok(definitions.has(id));
        return { id };
      },
      register: async (definition) => {
        assert.ok(!definitions.has(definition.id));
        definitions.set(definition.id, structuredClone(definition));
        return async () => definitions.delete(definition.id);
      },
    },
  };
  const workflow = new DesktopWorkflow({ get: (key) => services[key] }, store, flow);
  const input = {
    workspaceId: workspace.id,
    parentSessionId: "parent-a",
    role: "analyst",
    task: "请把给定的三个合成数值排序：3、1、2。",
  };
  t.after(async () => {
    try {
      await workflow.close();
    } finally {
      flow.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    workflow,
    services,
    workspace,
    other,
    store,
    flow,
    starts,
    disposals,
    pending,
    definitions,
    input,
    failStart: (error) => {
      startError = error;
    },
    failDisposal: (count) => {
      disposalFailures = count;
    },
  };
}

test("official dispatch contract creates a reserved executor and reads completion, role and released slot", async (t) => {
  const f = fixture(t);
  const { item } = await f.workflow.dispatch("workflow.dispatch", f.input);
  assert.equal(item.status, "running");
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].delivery, "caller");
  assert.equal(f.starts[0].request.parent, f.services.agents.get("parent-a"));
  assert.match(f.starts[0].request.prompt[0].text, /3、1、2/);
  assert.ok(f.starts[0].request.prompt[0].text.includes(f.workspace.scope));
  assert.ok(f.starts[0].request.prompt[0].text.includes(f.workspace.authorization));
  assert.ok(f.starts[0].request.prompt[0].text.includes(f.flow.rolePrompt(item.sessionId)));
  assert.equal(f.workflow.ownsSession(item.sessionId), true);
  f.pending
    .get(item.sessionId)
    .resolve({ stopReason: "completed", output: [{ type: "text", text: "1、2、3" }] });
  await flush();
  const finished = (
    await f.workflow.dispatch("workflow.status", { workspaceId: f.workspace.id, id: item.id })
  ).item;
  assert.equal(finished.status, "completed");
  assert.equal(finished.result.output[0].text, "1、2、3");
  assert.equal(finished.slotReleased, true);
  assert.equal(finished.disposed, true);
  assert.deepEqual(f.disposals, [item.sessionId]);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
  assert.equal(
    f.store.dispatch("workspaces.forSession", { sessionId: item.sessionId }).item.id,
    f.workspace.id,
    "Keep completion history bound",
  );
});

test("missing interfaces, unknown actions, bad parent, mismatched workspace and role fail before host writes", async (t) => {
  const f = fixture(t);
  for (const patch of [
    { parentSessionId: "absent" },
    { parentSessionId: "unbound" },
    { workspaceId: f.other.id },
    { role: "invented" },
    { task: " " },
    { task: "字".repeat(11000) },
  ]) {
    await assert.rejects(f.workflow.dispatch("workflow.dispatch", { ...f.input, ...patch }));
  }
  delete f.services.subagents.resolveMaxDepth;
  assert.equal(f.workflow.capabilities().dispatch, false);
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", f.input), {
    code: "UNSUPPORTED_CAPABILITY",
  });
  await assert.rejects(f.workflow.dispatch("workflow.unsupported", f.input), {
    code: "UNKNOWN_ACTION",
  });
  assert.equal(f.starts.length, 0);
  assert.equal(f.flow.status(f.workspace.id).assignments.length, 0);
});

test("full workspace rejects before executor creation and leaves no prospective binding or role", async (t) => {
  const f = fixture(t);
  f.flow.dispatch("flow.configure", { workspaceId: f.workspace.id, limit: 1 });
  const first = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", f.input), { code: "SLOTS_FULL" });
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.flow.status(f.workspace.id).assignments, [
    { sessionId: first.sessionId, role: "analyst" },
  ]);
});

test("official creation rejection rolls back the local slot, assignment and reserved binding", async (t) => {
  const f = fixture(t);
  f.failStart(new Error("Synthetic factory rejected before publication"));
  let failure;
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", f.input), (error) => {
    failure = error;
    return error.code === "WORKFLOW_START_FAILED";
  });
  const item = failure.partial.item;
  assert.equal(item.status, "failed");
  assert.equal(item.slotReleased, true);
  assert.equal(f.store.dispatch("workspaces.forSession", { sessionId: item.sessionId }).item, null);
  assert.deepEqual(f.flow.status(f.workspace.id).active, []);
  assert.deepEqual(f.flow.status(f.workspace.id).assignments, []);
});

test("execution rejection and abnormal stop reason are failures and release owned slots", async (t) => {
  const f = fixture(t);
  const a = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  const b = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  f.pending.get(a.sessionId).reject(new Error("Synthetic execution failed"));
  f.pending.get(b.sessionId).resolve({ stopReason: "max-tokens", output: [] });
  await flush();
  const { items } = await f.workflow.dispatch("workflow.status", { workspaceId: f.workspace.id });
  assert.deepEqual(
    items.map((item) => item.status),
    ["failed", "failed"],
  );
  assert.ok(items.every((item) => item.slotReleased && item.disposed));
});

test("workspaces have independent limits and cannot observe or stop another workspace's run", async (t) => {
  const f = fixture(t);
  for (const id of [f.workspace.id, f.other.id])
    f.flow.dispatch("flow.configure", { workspaceId: id, limit: 1 });
  const a = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  const b = (
    await f.workflow.dispatch("workflow.dispatch", {
      ...f.input,
      workspaceId: f.other.id,
      parentSessionId: "parent-b",
    })
  ).item;
  await assert.rejects(
    f.workflow.dispatch("workflow.stop", { workspaceId: f.other.id, id: a.id }),
    { code: "NOT_FOUND" },
  );
  assert.deepEqual(
    (await f.workflow.dispatch("workflow.status", { workspaceId: f.other.id })).items.map(
      (item) => item.id,
    ),
    [b.id],
  );
  const stopped = await f.workflow.dispatch("workflow.stop", {
    workspaceId: f.workspace.id,
    id: a.id,
  });
  assert.equal(stopped.item.status, "stopped");
  assert.equal(stopped.item.slotReleased, true);
  assert.deepEqual(f.disposals, [a.sessionId]);
  assert.equal(f.flow.status(f.other.id).active.length, 1);
});

test("another adapter cannot revoke a foreign run; close only disposes its own handles", async (t) => {
  const f = fixture(t);
  const foreign = new DesktopWorkflow({ get: (key) => f.services[key] }, f.store, f.flow);
  const item = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  await assert.rejects(
    foreign.dispatch("workflow.stop", { workspaceId: f.workspace.id, id: item.id }),
    { code: "NOT_FOUND" },
  );
  await foreign.close();
  assert.deepEqual(f.disposals, []);
  await f.workflow.close();
  assert.deepEqual(f.disposals, [item.sessionId]);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
});

test("runtime preset registration uses relocatable module URL and exact owned revocation", async (t) => {
  const f = fixture(t);
  f.definitions.set("user/custom", {
    id: "user/custom",
    name: "Unchanged user preset",
    plugins: [],
  });
  const registered = await f.workflow.dispatch("workflow.presets", { operation: "register" });
  assert.equal(registered.owned, true);
  assert.equal(registered.persistent, false);
  assert.equal(
    f.definitions.get(WORKFLOW_PRESET_ID).plugins[0].name,
    new URL("../src/host/workflow-preset.js", import.meta.url).href,
  );
  await f.workflow.dispatch("workflow.presets", { operation: "register" });
  const item = (await f.workflow.dispatch("workflow.dispatch", { ...f.input, usePreset: true }))
    .item;
  assert.equal(f.starts[0].request.agentPreset, WORKFLOW_PRESET_ID);
  await f.workflow.dispatch("workflow.presets", { operation: "unregister" });
  assert.deepEqual([...f.definitions.keys()], ["user/custom"]);
  await f.workflow.dispatch("workflow.stop", { workspaceId: f.workspace.id, id: item.id });
});

test("preset collision preserves custom composition and never claims ownership", async (t) => {
  const f = fixture(t);
  const custom = {
    id: WORKFLOW_PRESET_ID,
    name: "User custom conflict",
    plugins: [{ name: "synthetic-custom" }],
  };
  f.definitions.set(WORKFLOW_PRESET_ID, structuredClone(custom));
  await assert.rejects(f.workflow.dispatch("workflow.presets", { operation: "register" }), {
    code: "PRESET_CONFLICT",
  });
  await f.workflow.dispatch("workflow.presets", { operation: "unregister" });
  assert.deepEqual(f.definitions.get(WORKFLOW_PRESET_ID), custom);
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", { ...f.input, usePreset: true }), {
    code: "PRESET_REQUIRED",
  });
  assert.equal(f.starts.length, 0);
});

test("unconfirmed disposal retains slot and binding until explicit owner stop retries successfully", async (t) => {
  const f = fixture(t);
  f.failDisposal(1);
  f.flow.dispatch("flow.configure", { workspaceId: f.workspace.id, limit: 1 });
  const item = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  f.pending.get(item.sessionId).resolve({ stopReason: "completed", output: [] });
  await flush();
  const failed = (
    await f.workflow.dispatch("workflow.status", { workspaceId: f.workspace.id, id: item.id })
  ).item;
  assert.equal(failed.status, "failed");
  assert.match(failed.cleanupError.message, /not confirmed/);
  assert.equal(failed.slotReleased, false);
  assert.equal(
    f.store.dispatch("workspaces.forSession", { sessionId: item.sessionId }).item.id,
    f.workspace.id,
  );
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", f.input), { code: "SLOTS_FULL" });
  const stopped = await f.workflow.dispatch("workflow.stop", {
    workspaceId: f.workspace.id,
    id: item.id,
  });
  assert.equal(stopped.item.disposed, true);
  assert.equal(stopped.item.slotReleased, true);
  assert.equal(stopped.item.cleanupError, undefined);
  assert.deepEqual(f.disposals, [item.sessionId, item.sessionId]);
});

test("invalid receipt plus cleanup failure keeps concurrency counted and can be explicitly revoked", async (t) => {
  const f = fixture(t);
  const original = f.services.subagents.startActivation;
  f.services.subagents.startActivation = async (spec) => ({
    ...(await original(spec)),
    childId: "invalid-host-receipt",
  });
  f.failDisposal(1);
  let partial;
  await assert.rejects(f.workflow.dispatch("workflow.dispatch", f.input), (error) => {
    partial = error.partial.item;
    return error.code === "WORKFLOW_START_FAILED";
  });
  assert.equal(partial.slotReleased, false);
  assert.equal(f.flow.status(f.workspace.id).active.length, 1);
  assert.equal(
    f.store.dispatch("workspaces.forSession", { sessionId: partial.sessionId }).item.id,
    f.workspace.id,
  );
  const { item } = await f.workflow.dispatch("workflow.stop", {
    workspaceId: f.workspace.id,
    id: partial.id,
  });
  assert.equal(item.slotReleased, true);
  assert.equal(item.disposed, true);
});

test("post-registration resolve failure withdraws the exact owned preset and preserves user records", async (t) => {
  const f = fixture(t);
  f.definitions.set("custom", { id: "custom", plugins: [] });
  f.services.agentPresets.resolve = async () => {
    throw new Error("Synthetic registry resolution failure");
  };
  await assert.rejects(
    f.workflow.dispatch("workflow.presets", { operation: "register" }),
    (error) => {
      assert.deepEqual(error.partial, { presetId: WORKFLOW_PRESET_ID, owned: false });
      return error.code === "WORKFLOW_PRESET_FAILED";
    },
  );
  assert.deepEqual([...f.definitions.keys()], ["custom"]);
  assert.equal((await f.workflow.dispatch("workflow.presets")).owned, false);
});

test("failed explicit stop reports its owned partial state and retries without releasing concurrency early", async (t) => {
  const f = fixture(t);
  const item = (await f.workflow.dispatch("workflow.dispatch", f.input)).item;
  f.failDisposal(1);
  await assert.rejects(
    f.workflow.dispatch("workflow.stop", { workspaceId: f.workspace.id, id: item.id }),
    (error) => {
      assert.equal(error.partial.item.id, item.id);
      assert.equal(error.partial.item.slotReleased, false);
      assert.equal(error.partial.item.disposed, false);
      return error.code === "WORKFLOW_STOP_FAILED";
    },
  );
  assert.equal(f.flow.status(f.workspace.id).active.length, 1);
  const stopped = await f.workflow.dispatch("workflow.stop", {
    workspaceId: f.workspace.id,
    id: item.id,
  });
  assert.equal(stopped.item.status, "stopped");
  assert.equal(stopped.item.slotReleased, true);
  assert.equal(stopped.item.disposed, true);
});
