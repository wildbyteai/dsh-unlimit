import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceStore } from "../src/core/store.js";
import { Flow } from "../src/core/flow.js";
import { DesktopWorkflow } from "../src/host/workflow.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { StoreError } from "../src/core/validation.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function until(check) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  assert.fail("Synthetic plan did not reach its expected state");
}
const task = (id, patch = {}) => ({
  id,
  role: "analyst",
  task: `盘点已给出的合成清单 ${id}，只返回其中的文件名。`,
  requirements: [],
  ...patch,
});

function fixture(t, catalog) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-plan-"));
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  const flow = new Flow(store);
  const workspace = store.dispatch("workspaces.save", { name: "Synthetic plan workspace" }).item;
  const other = store.dispatch("workspaces.save", { name: "Independent synthetic project" }).item;
  const agents = new Map(["parent-a", "parent-b", "parent-c"].map((id) => [id, { id }]));
  for (const id of ["parent-a", "parent-b"])
    store.dispatch("workspaces.bind", { id: workspace.id, sessionId: id });
  store.dispatch("workspaces.bind", { id: other.id, sessionId: "parent-c" });
  flow.dispatch("flow.configure", { workspaceId: workspace.id, limit: 1 });
  const starts = [],
    disposed = [],
    pending = new Map(),
    gates = new Map();
  const control = { disposalFailures: 0, startGate: null, startError: null };
  const services = {
    agents: { get: (id) => agents.get(id) },
    subagents: {
      getProvider: () => ({ prepareContinuable() {} }),
      resolveMaxDepth: () => 1,
      async startActivation(spec) {
        starts.push(spec);
        if (control.startGate) await control.startGate.promise;
        if (control.startError) throw control.startError;
        const completion = deferred();
        pending.set(spec.childId, completion);
        return {
          childId: spec.childId,
          messageId: "synthetic-message",
          result: completion.promise,
          async dispose() {
            disposed.push(spec.childId);
            if (control.disposalFailures > 0) {
              control.disposalFailures--;
              throw new Error("Synthetic cleanup not confirmed");
            }
            if (gates.has(spec.childId)) await gates.get(spec.childId).promise;
            completion.resolve({ stopReason: "aborted", output: [] });
          },
        };
      },
    },
  };
  const workflow = new DesktopWorkflow({ get: (key) => services[key] }, store, flow);
  const plans = new DesktopWorkflowPlan(workflow, { catalog });
  const coordinators = [plans];
  const owner = { workspaceId: workspace.id, parentSessionId: "parent-a" };
  const create = (tasks, parent = owner, coordinator = plans) =>
    coordinator.dispatch("workflow.plan.create", { ...parent, tasks });
  const status = async (id, parent = owner, coordinator = plans) =>
    (await coordinator.dispatch("workflow.plan.status", { ...parent, id })).item;
  const stop = (id, parent = owner, coordinator = plans) =>
    coordinator.dispatch("workflow.plan.stop", { ...parent, id });
  t.after(async () => {
    control.disposalFailures = 0;
    control.startGate?.resolve();
    gates.forEach((gate) => gate.resolve());
    try {
      for (const coordinator of coordinators) await coordinator.close();
      await workflow.close();
    } finally {
      flow.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    store,
    flow,
    workflow,
    plans,
    owner,
    other,
    workspace,
    agents,
    services,
    starts,
    disposed,
    pending,
    gates,
    control,
    coordinators,
    create,
    status,
    stop,
  };
}

test("two explicit harmless tasks queue behind one slot and disposal, with exact executor-reported results", async (t) => {
  const f = fixture(t);
  const input = [task("first"), task("second", { dependsOn: ["first"] })];
  const { item } = await f.create(input);
  assert.equal(item.state, "queued");
  assert.deepEqual(item.summary.notStarted, ["first", "second"]);
  assert.equal(f.starts.length, 0, "Registration must not be reported as executor start");
  input[0].task = "Mutated caller input must not affect queued work";
  await until(() => f.starts.length === 1);
  const child = f.starts[0].childId;
  assert.match(f.starts[0].request.prompt[0].text, /合成清单 first/);
  f.gates.set(child, deferred());
  const result = {
    stopReason: "completed",
    output: [{ type: "text", text: "Fixture lists alpha.txt; no real filesystem inspected." }],
  };
  f.pending.get(child).resolve(result);
  await until(async () => (await f.status(item.id)).tasks[0].state === "completed");
  await delay(60);
  assert.equal(f.starts.length, 1, "Terminal status alone must not release the next task");
  const waiting = await f.status(item.id);
  assert.equal(waiting.tasks[0].receipt.disposed, false);
  assert.equal(waiting.tasks[0].receipt.slotReleased, false);
  assert.equal(f.flow.status(f.workspace.id).active.length, 1);
  f.gates.get(child).resolve();
  await until(() => f.starts.length === 2);
  const successor = f.starts[1].request.prompt[0].text;
  assert.ok(
    successor.includes(JSON.stringify(result)),
    "The dependent executor must receive the actual upstream receipt result",
  );
  assert.ok(successor.includes('"independentlyVerified":false'));
  assert.ok(successor.includes('"taskId":"first"'));
  f.pending
    .get(f.starts[1].childId)
    .resolve({ stopReason: "completed", output: [{ type: "text", text: "beta.txt" }] });
  const final = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "completed" && s;
  });
  assert.equal(final.summary.counts.completed, 2);
  assert.deepEqual(final.summary.cleanupPending, []);
  assert.deepEqual(final.summary.results[0].result, result);
  assert.equal(final.summary.results[0].independentlyVerified, false);
  assert.equal(final.summary.results[0].source, "workflow-receipt");
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
  final.tasks[0].receipt.result.output[0].text = "Caller mutation";
  assert.deepEqual((await f.status(item.id)).summary.results[0].result, result);
});

test("project capacity occupied by an unrelated workflow is queued, never taken over", async (t) => {
  const f = fixture(t);
  const direct = (
    await f.workflow.dispatch("workflow.dispatch", {
      ...f.owner,
      role: "analyst",
      task: "Synthetic independent task",
    })
  ).item;
  const { item } = await f.create([task("queued")]);
  await delay(60);
  assert.equal(f.starts.length, 1);
  assert.equal((await f.status(item.id)).tasks[0].state, "queued");
  await f.stop(item.id);
  assert.equal(
    f.disposed.length,
    0,
    "Stopping the queued plan must preserve the unrelated receipt",
  );
  assert.equal(f.flow.status(f.workspace.id).active[0].sessionId, direct.sessionId);
  f.pending.get(direct.sessionId).resolve({ stopReason: "completed", output: [] });
});

test("failed and missing prerequisites block downstream tasks without inventing results", async (t) => {
  const f = fixture(t);
  const { item } = await f.create([
    task("leaf", { dependsOn: ["middle"] }),
    task("middle", { dependsOn: ["first"] }),
    task("first"),
    task("missing", { dependsOn: ["absent"] }),
    task("independent"),
  ]);
  await until(() => f.starts.length === 1);
  f.pending.get(f.starts[0].childId).resolve({
    stopReason: "error",
    output: [{ type: "text", text: "Incomplete synthetic output" }],
  });
  await until(() => f.starts.length === 2);
  assert.match(f.starts[1].request.prompt[0].text, /合成清单 independent/);
  f.pending.get(f.starts[1].childId).resolve({ stopReason: "completed", output: [] });
  const final = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "finished-with-errors" && s;
  });
  assert.deepEqual(
    final.tasks.map((item) => item.state),
    ["blocked", "blocked", "failed", "blocked", "completed"],
  );
  assert.deepEqual(final.tasks[3].blockedBy, [{ id: "absent", reason: "missing-dependency" }]);
  assert.deepEqual(final.summary.notStarted, ["leaf", "middle", "missing"]);
  assert.equal(final.summary.results.length, 2);
});

test("input contracts reject cycles, undeclared requirements, role errors and extra execution options before activation", async (t) => {
  const f = fixture(t);
  for (const tasks of [
    [],
    [task("x"), task("x")],
    [task("x", { dependsOn: ["x"] })],
    [task("x", { dependsOn: ["y"] }), task("y", { dependsOn: ["x"] })],
    [task("x", { requirements: undefined })],
    [task("x", { role: "invented" })],
    [task("x", { shell: "invented" })],
    [task("x", { requirements: [{ kind: "tool", name: "read", path: "/unexpected" }] })],
    Array.from({ length: 33 }, (_, i) => task(String(i))),
  ]) {
    await assert.rejects(f.create(tasks), { code: "INVALID_INPUT" });
  }
  await assert.rejects(
    f.create([task("x")], { workspaceId: f.other.id, parentSessionId: "parent-a" }),
    { code: "WORKSPACE_MISMATCH" },
  );
  await assert.rejects(f.plans.dispatch("workflow.plan.shell", {}), { code: "UNKNOWN_ACTION" });
  assert.equal(f.starts.length, 0);
  assert.equal(f.plans.plans.size, 0);
});

test("explicit capability preflight gates dispatch; unknown and missing catalogs remain unexecuted", async (t) => {
  const calls = [];
  const catalog = {
    async preflight(input, options) {
      calls.push({ input, signal: options.signal });
      return {
        status: input.requirements[0].name === "visible" ? "ready" : "unknown",
        executionAuthorized: false,
        checks: [{ state: "unknown", detail: "Synthetic declaration observation" }],
      };
    },
  };
  const f = fixture(t, catalog);
  const { item } = await f.create([
    task("unknown", { requirements: [{ kind: "tool", name: "unknown" }] }),
    task("ready", { requirements: [{ kind: "tool", name: "visible" }] }),
  ]);
  await until(() => f.starts.length === 1);
  assert.match(f.starts[0].request.prompt[0].text, /合成清单 ready/);
  assert.ok(
    f.starts[0].request.prompt[0].text.includes('"name":"visible"'),
    "Explicit selection requirements must reach the executor task",
  );
  assert.equal(calls[0].input.sessionId, "parent-a");
  assert.deepEqual(calls[0].input.requirements, [{ kind: "tool", name: "unknown" }]);
  assert.equal(calls[0].signal.aborted, false);
  const s = await f.status(item.id);
  assert.equal(s.tasks[0].state, "blocked");
  assert.equal(s.tasks[0].runId, undefined);
  f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output: [] });
  const noCatalog = new DesktopWorkflowPlan(f.workflow);
  f.coordinators.push(noCatalog);
  const unsupported = (
    await f.create(
      [task("missing", { requirements: [{ kind: "toolkit", name: "nmap" }] })],
      f.owner,
      noCatalog,
    )
  ).item;
  const blocked = await until(async () => {
    const s = await f.status(unsupported.id, f.owner, noCatalog);
    return s.state === "finished-with-errors" && s;
  });
  assert.equal(blocked.tasks[0].error.code, "UNSUPPORTED_PREFLIGHT");
  assert.equal(f.starts.length, 1);
});

test("parent and project ownership prevents takeover, stopAll preserves other coordinators and permits new plans", async (t) => {
  const f = fixture(t);
  const peer = new DesktopWorkflowPlan(f.workflow);
  f.coordinators.push(peer);
  const otherOwner = { workspaceId: f.other.id, parentSessionId: "parent-c" };
  const a = (await f.create([task("owned-a")])).item;
  const b = (await f.create([task("owned-b")], otherOwner, peer)).item;
  await until(() => f.starts.length === 2);
  for (const parent of [{ ...f.owner, parentSessionId: "parent-b" }, otherOwner]) {
    await assert.rejects(f.status(a.id, parent), { code: "NOT_FOUND" });
    await assert.rejects(f.stop(a.id, parent), { code: "NOT_FOUND" });
  }
  const stopped = await f.plans.stopAll();
  assert.equal(stopped.stopped, true);
  assert.equal(f.disposed.length, 1);
  assert.equal((await f.status(b.id, otherOwner, peer)).tasks[0].state, "running");
  const again = (await f.create([task("new-after-stopAll")])).item;
  await until(() => f.starts.length === 3);
  assert.equal((await f.status(again.id)).tasks[0].state, "running");
  assert.equal(f.flow.status(f.other.id).active.length, 1);
});

test("unconfirmed cleanup pauses queue and explicit stop retry retains the real slot until confirmation", async (t) => {
  const f = fixture(t);
  const { item } = await f.create([task("first"), task("later")]);
  await until(() => f.starts.length === 1);
  f.control.disposalFailures = 2;
  f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output: [] });
  await until(async () => (await f.status(item.id)).state === "cleanup-pending");
  assert.equal(f.flow.status(f.workspace.id).active.length, 1);
  const failedStop = await f.stop(item.id);
  assert.equal(failedStop.stopped, false);
  assert.equal(failedStop.item.state, "cleanup-pending");
  assert.equal(f.starts.length, 1);
  assert.equal(f.flow.status(f.workspace.id).active.length, 1);
  const retried = await f.stop(item.id);
  assert.equal(retried.stopped, true);
  assert.equal(retried.item.tasks[1].state, "cancelled");
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
});

test("stop during asynchronous activation waits for its owned receipt and never starts the queued successor", async (t) => {
  const f = fixture(t);
  f.control.startGate = deferred();
  const { item } = await f.create([task("starting"), task("queued")]);
  await until(() => f.starts.length === 1);
  const stopping = f.stop(item.id);
  await delay(10);
  assert.equal((await f.status(item.id)).state, "stopping");
  assert.equal(f.disposed.length, 0);
  f.control.startGate.resolve();
  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.equal(f.disposed.length, 1);
  assert.equal(f.starts.length, 1);
  assert.equal(result.item.tasks[1].state, "cancelled");
  assert.deepEqual(result.item.summary.cleanupPending, []);
});

test("binding revoked after creation cancels only owned work; status and cleanup remain readable", async (t) => {
  const f = fixture(t);
  const { item } = await f.create([task("owned"), task("queued")]);
  await until(() => f.starts.length === 1);
  f.store.dispatch("workspaces.bind", { id: f.other.id, sessionId: "parent-a" });
  const result = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "stopped" && s;
  });
  assert.equal(result.error.code, "WORKSPACE_MISMATCH");
  assert.equal(result.tasks[1].state, "cancelled");
  assert.equal(f.starts.length, 1);
  assert.equal((await f.stop(item.id)).stopped, true);
});

test("stopAll marks every queue before awaiting an in-flight activation, without closing the coordinator", async (t) => {
  const f = fixture(t);
  f.control.startGate = deferred();
  await f.create([task("starting")]);
  await until(() => f.starts.length === 1);
  const otherOwner = { workspaceId: f.other.id, parentSessionId: "parent-c" };
  const queued = (await f.create([task("other-project-queue")], otherOwner)).item;
  const stopping = f.plans.stopAll();
  await delay(15);
  assert.equal(f.starts.length, 1);
  assert.equal((await f.status(queued.id, otherOwner)).state, "stopping");
  f.control.startGate.resolve();
  const result = await stopping;
  assert.equal(result.stopped, true);
  assert.equal(result.items.length, 2);
  assert.equal(f.starts.length, 1);
  assert.equal(f.plans.closed, false);
});

test("binding changed during preflight is rechecked before dispatch; no caller-supplied task bypasses it", async (t) => {
  const checking = deferred();
  const catalog = { preflight: () => checking.promise };
  const f = fixture(t, catalog);
  const { item } = await f.create([
    task("checking", { requirements: [{ kind: "tool", name: "visible" }] }),
  ]);
  await until(async () => (await f.status(item.id)).tasks[0].state === "checking");
  f.store.dispatch("workspaces.bind", { id: f.other.id, sessionId: "parent-a" });
  checking.resolve({ status: "ready", checks: [] });
  const result = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "stopped" && s;
  });
  assert.equal(result.error.code, "WORKSPACE_MISMATCH");
  assert.equal(result.tasks[0].state, "cancelled");
  assert.equal(f.starts.length, 0);
});

test("start failure remains failed without fake completion, missing runtime disables capability, close rejects new plans", async (t) => {
  const f = fixture(t);
  f.control.startError = new Error("Synthetic factory rejected before receipt");
  const { item } = await f.create([task("failed")]);
  const result = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "finished-with-errors" && s;
  });
  assert.equal(result.tasks[0].state, "failed");
  assert.equal(result.tasks[0].receipt.slotReleased, true);
  assert.equal(result.summary.results.length, 0);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
  delete f.services.subagents;
  assert.equal(f.plans.capabilities().available, false);
  await assert.rejects(f.create([task("unsupported")]), { code: "UNSUPPORTED_CAPABILITY" });
  await f.plans.close();
  await assert.rejects(f.create([task("closed")]), { code: "CLOSED" });
  assert.equal(f.plans.capabilities().available, false);
});

test("a queued task still passes the workflow admission gate after an earlier task completes", async (t) => {
  const f = fixture(t);
  let accepted = true;
  let checks = 0;
  f.workflow.admission = {
    require() {
      checks++;
      if (!accepted)
        throw new StoreError("ADMISSION_REQUIRED", "Synthetic entry confirmation revoked");
    },
  };
  const { item } = await f.create([task("accepted"), task("revoked")]);
  await until(() => f.starts.length === 1);
  accepted = false;
  f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output: [] });
  const result = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "finished-with-errors" && s;
  });
  assert.equal(result.tasks[1].state, "failed");
  assert.equal(result.tasks[1].error.code, "ADMISSION_REQUIRED");
  assert.equal(result.tasks[1].runId, undefined);
  assert.ok(checks >= 3, "The plan must not bypass checks performed by each actual workflow start");
  assert.equal(f.starts.length, 1);
  assert.equal((await f.stop(item.id)).stopped, true);
});

test("dependency context includes only declared upstream receipts, never unrelated results", async (t) => {
  const f = fixture(t);
  const { item } = await f.create([
    task("unrelated"),
    task("source"),
    task("summary", { dependsOn: ["source"] }),
  ]);
  await until(() => f.starts.length === 1);
  f.pending.get(f.starts[0].childId).resolve({
    stopReason: "completed",
    output: [{ type: "text", text: "UNRELATED_SYNTHETIC_RESULT" }],
  });
  await until(() => f.starts.length === 2);
  const direct = {
    stopReason: "completed",
    output: [{ type: "text", text: "DIRECT_SYNTHETIC_EVIDENCE" }],
  };
  f.pending.get(f.starts[1].childId).resolve(direct);
  await until(() => f.starts.length === 3);
  const prompt = f.starts[2].request.prompt[0].text;
  assert.ok(prompt.includes(JSON.stringify(direct)));
  assert.ok(!prompt.includes("UNRELATED_SYNTHETIC_RESULT"));
  assert.ok(!prompt.includes('"taskId":"unrelated"'));
  f.pending.get(f.starts[2].childId).resolve({ stopReason: "completed", output: [] });
  await until(async () => (await f.status(item.id)).state === "completed");
});

test("oversized upstream evidence explicitly blocks the dependent task without truncated dispatch", async (t) => {
  const f = fixture(t);
  const { item } = await f.create([task("source"), task("summary", { dependsOn: ["source"] })]);
  await until(() => f.starts.length === 1);
  const result = {
    stopReason: "completed",
    output: [{ type: "text", text: "x".repeat(33 * 1024) }],
  };
  f.pending.get(f.starts[0].childId).resolve(result);
  const final = await until(async () => {
    const s = await f.status(item.id);
    return s.state === "finished-with-errors" && s;
  });
  assert.equal(final.tasks[1].state, "blocked");
  assert.equal(final.tasks[1].error.code, "DEPENDENCY_CONTEXT_LIMIT");
  assert.equal(final.tasks[1].runId, undefined);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(
    final.summary.results[0].result,
    result,
    "Readback must still retain the complete upstream result",
  );
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
});
