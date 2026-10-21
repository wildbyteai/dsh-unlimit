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
import { HostCatalog } from "../src/host/catalog.js";
import { SkillLibrary } from "../src/core/skills.js";
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

const planningCatalog = () => ({
  list: async () => ({
    tools: [
      {
        name: "synthetic_read",
        description: "Read a supplied synthetic file",
        inputSchema: { secret: "NOT_FOR_PLANNER" },
      },
    ],
    skills: [
      {
        origin: "host",
        id: "inventory",
        name: "inventory",
        description: "Inventory supplied data",
      },
      { origin: "project", id: "local-skill", name: "private-project-skill" },
    ],
    toolkit: { tools: [{ id: "unavailable", available: false }] },
    sources: { tools: { state: "available", complete: true } },
  }),
  preflight: async () => ({ status: "ready" }),
});
const modelOutput = (value) => ({
  stopReason: "completed",
  output: [{ type: "text", text: JSON.stringify(value) }],
});

test("explicit goal run waits for planner disposal, executes generated dependencies and summarizes only task evidence", async (t) => {
  const f = fixture(t, planningCatalog());
  const goal = "在用户提供的两份合成清单内盘点文件，再汇总出处。";
  const { item } = await f.plans.dispatch("workflow.plan.run", {
    ...f.owner,
    goal,
    summarize: true,
  });
  assert.equal(item.proposal.execute, true);
  assert.equal(item.tasks.length, 1);
  await until(() => f.starts.length === 1);
  const gate = deferred();
  f.gates.set(f.starts[0].childId, gate);
  const generated = [
    task("alpha"),
    task("beta", {
      dependsOn: ["alpha"],
      requirements: [{ kind: "tool", name: "synthetic_read" }],
    }),
  ];
  f.pending.get(f.starts[0].childId).resolve(modelOutput({ tasks: generated }));
  await until(async () => (await f.status(item.id)).tasks[0].state === "completed");
  assert.equal(f.starts.length, 1);
  gate.resolve();
  await until(() => f.starts.length === 2);
  const state = await f.status(item.id);
  assert.deepEqual(state.proposal.taskIds, ["alpha", "beta"]);
  assert.equal(state.tasks[0].kind, "planning");
  assert.match(f.starts[1].request.prompt[0].text, /本次自动执行的原始用户目标与范围/);
  assert.ok(f.starts[1].request.prompt[0].text.includes(goal));
  f.pending.get(f.starts[1].childId).resolve(modelOutput({ evidence: "alpha original" }));
  await until(() => f.starts.length === 3);
  assert.match(f.starts[2].request.prompt[0].text, /alpha original/);
  assert.ok(f.starts[2].request.prompt[0].text.includes(goal));
  f.pending.get(f.starts[2].childId).resolve(modelOutput({ evidence: "beta original" }));
  await until(() => f.starts.length === 4);
  const summary = (await f.status(item.id)).tasks[3];
  assert.deepEqual(
    summary.sources.map((row) => row.taskId),
    ["alpha", "beta"],
  );
  assert.equal(
    summary.sources.some((row) => row.taskId === "$planner"),
    false,
  );
  f.pending.get(f.starts[3].childId).resolve(modelOutput({ report: "Unverified summary" }));
  const final = await until(async () => {
    const state = await f.status(item.id);
    return state.state === "completed" && state;
  });
  assert.equal(final.tasks.length, 4);
  assert.equal(final.id, item.id);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
});

test("automatic planning rejects unknown capabilities and internal ID collisions before dispatching generated tasks", async (t) => {
  for (const generated of [
    [task("$planner")],
    [task("$summary")],
    [task("bad", { requirements: [{ kind: "tool", name: "invented" }] })],
  ])
    await t.test(generated[0].id, async (t) => {
      const f = fixture(t, planningCatalog());
      const { item } = await f.plans.dispatch("workflow.plan.run", {
        ...f.owner,
        goal: "Synthetic goal",
        summarize: true,
      });
      await until(() => f.starts.length === 1);
      f.pending.get(f.starts[0].childId).resolve(modelOutput({ tasks: generated }));
      const final = await until(async () => {
        const state = await f.status(item.id);
        return state.state === "finished-with-errors" && state;
      });
      assert.equal(final.proposal.state, "invalid");
      assert.equal(final.proposal.tasks, undefined);
      assert.equal(final.tasks.length, 1);
      assert.equal(f.starts.length, 1);
    });
});

test("stopping an automatic run during planner activation or generated task preflight prevents later work", async (t) => {
  for (const phase of ["planning", "preflight"])
    await t.test(phase, async (t) => {
      const check = deferred();
      const catalog = planningCatalog();
      let checking = false;
      catalog.preflight = async () => {
        checking = true;
        return check.promise;
      };
      const f = fixture(t, catalog);
      const { item } = await f.plans.dispatch("workflow.plan.run", {
        ...f.owner,
        goal: "Synthetic goal",
        summarize: true,
      });
      await until(() => f.starts.length === 1);
      if (phase === "preflight") {
        f.pending.get(f.starts[0].childId).resolve(
          modelOutput({
            tasks: [task("worker", { requirements: [{ kind: "tool", name: "synthetic_read" }] })],
          }),
        );
        await until(() => checking);
      }
      const stopping = f.stop(item.id);
      check.resolve({ status: "ready" });
      const stopped = await stopping;
      assert.equal(stopped.stopped, true);
      assert.equal(f.starts.length, 1);
      assert.equal(f.flow.status(f.workspace.id).active.length, 0);
    });
});

test("generated work still checks admission and carries the complete original goal within the execution limit", async (t) => {
  for (const scenario of ["revoked", "context"])
    await t.test(scenario, async (t) => {
      const f = fixture(t, planningCatalog());
      let allowed = true;
      f.workflow.admission = {
        require() {
          if (!allowed) throw new StoreError("ADMISSION_REQUIRED", "Synthetic admission revoked");
        },
      };
      const { item } = await f.plans.dispatch("workflow.plan.run", {
        ...f.owner,
        goal: scenario === "context" ? "G".repeat(16 * 1024) : "Synthetic goal",
      });
      await until(() => f.starts.length === 1);
      if (scenario === "revoked") allowed = false;
      f.pending.get(f.starts[0].childId).resolve(
        modelOutput({
          tasks: [
            task("worker", {
              task: scenario === "context" ? "T".repeat(20 * 1024) : "Synthetic work",
            }),
          ],
        }),
      );
      const final = await until(async () => {
        const state = await f.status(item.id);
        return state.state === "finished-with-errors" && state;
      });
      assert.equal(
        final.tasks[1].error.code,
        scenario === "context" ? "DEPENDENCY_CONTEXT_LIMIT" : "ADMISSION_REQUIRED",
      );
      assert.equal(f.starts.length, 1);
    });
});

test("a goal produces a checked proposal using exact catalog names, without dispatching proposed tasks", async (t) => {
  const f = fixture(t, planningCatalog());
  assert.equal(f.plans.capabilities().planDrafting, true);
  const { item } = await f.plans.dispatch("workflow.plan.propose", {
    ...f.owner,
    goal: "盘点提供的合成文件并汇总",
  });
  await until(() => f.starts.length === 1);
  const prompt = f.starts[0].request.prompt[0].text;
  assert.match(prompt, /synthetic_read/);
  assert.match(prompt, /inventory/);
  assert.match(prompt, /private-project-skill/);
  assert.doesNotMatch(prompt, /NOT_FOR_PLANNER|unavailable/);
  const generated = [
    task("read", { requirements: [{ kind: "tool", name: "synthetic_read" }] }),
    task("report", { dependsOn: ["read"] }),
  ];
  const gate = deferred();
  f.gates.set(f.starts[0].childId, gate);
  f.pending.get(f.starts[0].childId).resolve(modelOutput({ tasks: generated }));
  await until(async () => (await f.status(item.id)).tasks[0].state === "completed");
  assert.equal((await f.status(item.id)).proposal.state, "pending");
  gate.resolve();
  const final = await until(async () => {
    const current = await f.status(item.id);
    return current.proposal.state === "ready" && current;
  });
  assert.equal(final.state, "completed");
  assert.equal(final.proposal.source.runId, final.tasks[0].runId);
  assert.equal(final.proposal.source.independentlyVerified, false);
  assert.equal(f.starts.length, 1);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
  assert.deepEqual(
    final.proposal.tasks.map(({ id }) => id),
    ["read", "report"],
  );
  // A separate explicit submission uses the existing scheduler and current dependency preflight.
  const run = await f.create(final.proposal.tasks);
  await until(() => f.starts.length === 2);
  assert.match(f.starts[1].request.prompt[0].text, /synthetic_read/);
  await f.stop(run.item.id);
});

test("invalid model proposals retain raw output and cannot be treated as executable plans", async (t) => {
  for (const [name, generated] of [
    ["invented capability", [task("a", { requirements: [{ kind: "tool", name: "invented" }] })]],
    ["unobserved directory", [task("a", { requirements: [{ kind: "directory", path: "/tmp" }] })]],
    ["missing dependency", [task("a", { dependsOn: ["missing"] })]],
    ["cycle", [task("a", { dependsOn: ["b"] }), task("b", { dependsOn: ["a"] })]],
    ["unknown role", [task("a", { role: "invented" })]],
    ["preset injection", [task("a", { usePreset: true })]],
    [
      "unobserved resource",
      [
        task("a", {
          skills: [{ origin: "project", id: "local-skill", resources: ["references/guessed.md"] }],
        }),
      ],
    ],
    ["invented skill", [task("a", { skills: [{ origin: "project", id: "missing" }] })]],
    [
      "skill dependency override",
      [task("a", { skills: [{ origin: "project", id: "local-skill", requirements: [] }] })],
    ],
    ["extra action", [task("a", { command: "never-execute" })]],
  ])
    await t.test(name, async (t) => {
      const f = fixture(t, planningCatalog());
      const { item } = await f.plans.dispatch("workflow.plan.propose", {
        ...f.owner,
        goal: "整理合成材料",
      });
      await until(() => f.starts.length === 1);
      const output = modelOutput({ tasks: generated });
      f.pending.get(f.starts[0].childId).resolve(output);
      const final = await until(async () => {
        const current = await f.status(item.id);
        return current.proposal.state === "invalid" && current;
      });
      assert.equal(final.state, "finished-with-errors");
      assert.equal(final.proposal.tasks, undefined);
      assert.deepEqual(final.tasks[0].receipt.result, output);
      assert.equal(f.starts.length, 1);
    });
});

test("planning respects close, context limits, failure and stop", async (t) => {
  const catalog = planningCatalog();
  const f = fixture(t, catalog);
  await assert.rejects(
    f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "a".repeat(17 * 1024) }),
    { code: "INVALID_INPUT" },
  );
  const read = catalog.list;
  catalog.list = async () => {
    const value = await read();
    value.tools[0].description = "a".repeat(31 * 1024);
    return value;
  };
  await assert.rejects(f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "goal" }), {
    code: "PLANNING_CONTEXT_LIMIT",
  });
  assert.equal(f.starts.length, 0);
  catalog.list = read;
  const first = await f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "goal" });
  await until(() => f.starts.length === 1);
  const stopped = await f.stop(first.item.id);
  assert.equal(stopped.item.proposal.state, "cancelled");
  assert.equal(stopped.stopped, true);
  const second = await f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "goal" });
  await until(() => f.starts.length === 2);
  f.pending.get(f.starts[1].childId).resolve({ stopReason: "max-tokens", output: [] });
  await until(async () => (await f.status(second.item.id)).proposal.state === "failed");
  const wait = deferred();
  catalog.list = () => wait.promise;
  const pending = f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "goal" });
  await f.plans.close();
  wait.resolve(await read());
  await assert.rejects(pending, { code: "CLOSED" });
  assert.equal(f.starts.length, 2);
});

test("malformed, non-text and oversized planner output is rejected without repair or execution", async (t) => {
  for (const output of [
    [{ type: "text", text: "not JSON" }],
    [{ type: "text", text: "x".repeat(33 * 1024) }],
    [{ type: "image", data: "synthetic" }],
    [{ type: "text", text: JSON.stringify({ tasks: [task("a")], execute: true }) }],
  ])
    await t.test(output[0].type + String(output[0].text?.length), async (t) => {
      const f = fixture(t, planningCatalog());
      const { item } = await f.plans.dispatch("workflow.plan.propose", {
        ...f.owner,
        goal: "合成目标",
      });
      await until(() => f.starts.length === 1);
      f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output });
      const result = await until(async () => {
        const current = await f.status(item.id);
        return current.proposal.state === "invalid" && current;
      });
      assert.equal(result.proposal.error.code, "INVALID_PROPOSAL");
      assert.deepEqual(result.tasks[0].receipt.result.output, output);
      assert.equal(f.starts.length, 1);
    });
});

test("catalog observation cannot carry a planning request across a changed parent binding", async (t) => {
  const catalog = planningCatalog();
  const original = catalog.list;
  const wait = deferred();
  catalog.list = () => wait.promise;
  const f = fixture(t, catalog);
  const pending = f.plans.dispatch("workflow.plan.propose", { ...f.owner, goal: "合成目标" });
  f.store.dispatch("workspaces.bind", { id: f.other.id, sessionId: f.owner.parentSessionId });
  wait.resolve(await original());
  await assert.rejects(pending, { code: "WORKSPACE_MISMATCH" });
  assert.equal(f.starts.length, 0);
});

test("optional summary waits for every source and disposal, cites exact unverified results and uses normal lifecycle", async (t) => {
  const f = fixture(t);
  const { item } = await f.plans.dispatch("workflow.plan.create", {
    ...f.owner,
    tasks: [task("alpha"), task("beta")],
    summarize: true,
  });
  assert.equal(item.summaryTaskId, "$summary");
  assert.equal(item.tasks.length, 3);
  const results = ["alpha.txt (synthetic list A)", "beta.txt (synthetic list B)"].map((text) => ({
    stopReason: "completed",
    output: [{ type: "text", text }],
  }));
  await until(() => f.starts.length === 1);
  f.pending.get(f.starts[0].childId).resolve(results[0]);
  await until(() => f.starts.length === 2);
  const second = f.starts[1].childId;
  const gate = deferred();
  f.gates.set(second, gate);
  f.pending.get(second).resolve(results[1]);
  await until(async () => (await f.status(item.id)).tasks[1].state === "completed");
  await delay(60);
  assert.equal(f.starts.length, 2, "Summary must wait for confirmed disposal, not just output");
  gate.resolve();
  await until(() => f.starts.length === 3);
  const live = await f.status(item.id);
  const summary = live.tasks[2];
  assert.equal(summary.role, "planner");
  assert.deepEqual(
    summary.sources,
    live.tasks.slice(0, 2).map((source) => ({
      taskId: source.id,
      runId: source.runId,
      state: "completed",
      source: "workflow-receipt",
      independentlyVerified: false,
    })),
  );
  const prompt = f.starts[2].request.prompt[0].text;
  for (let i = 0; i < 2; i++) {
    assert.ok(
      prompt.includes(
        JSON.stringify({
          ...summary.sources[i],
          role: "analyst",
          task: live.tasks[i].task,
          result: results[i],
        }),
      ),
      "Summary must receive each exact result paired with its source metadata",
    );
  }
  const output = {
    stopReason: "completed",
    output: [{ type: "text", text: "待核实汇总：alpha / beta，见各来源。" }],
  };
  f.pending.get(f.starts[2].childId).resolve(output);
  const final = await until(async () => {
    const state = await f.status(item.id);
    return state.state === "completed" && state;
  });
  assert.deepEqual(final.tasks[2].receipt.result, output);
  assert.equal(final.tasks[2].receipt.disposed, true);
  assert.equal(final.tasks[2].receipt.slotReleased, true);
  assert.deepEqual(
    final.summary.results.map((result) => result.independentlyVerified),
    [false, false, false],
  );
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
});

test("summary includes failed and unstarted sources without turning the plan into success", async (t) => {
  const f = fixture(t);
  const { item } = await f.plans.dispatch("workflow.plan.create", {
    ...f.owner,
    summarize: true,
    tasks: [task("failed"), task("blocked", { dependsOn: ["failed"] })],
  });
  await until(() => f.starts.length === 1);
  const failed = { stopReason: "max-tokens", output: [{ type: "text", text: "partial evidence" }] };
  f.pending.get(f.starts[0].childId).resolve(failed);
  await until(() => f.starts.length === 2);
  const live = await f.status(item.id);
  assert.equal(live.tasks[1].state, "blocked");
  assert.equal(live.tasks[1].runId, undefined);
  assert.deepEqual(live.tasks[2].sources[1], {
    taskId: "blocked",
    state: "blocked",
    source: "plan-task-state",
    independentlyVerified: false,
  });
  const prompt = f.starts[1].request.prompt[0].text;
  assert.ok(prompt.includes(JSON.stringify(failed)));
  assert.ok(prompt.includes('"blockedBy":[{"id":"failed","reason":"failed"}]'));
  f.pending.get(f.starts[1].childId).resolve({ stopReason: "completed", output: [] });
  const final = await until(async () => {
    const state = await f.status(item.id);
    return state.state === "finished-with-errors" && state;
  });
  assert.deepEqual(
    final.tasks.map((task) => task.state),
    ["failed", "blocked", "completed"],
  );
  assert.equal(f.starts.length, 2);
});

test("summary refuses oversized or non-JSON sources without truncating or dispatching them", async (t) => {
  for (const [code, output] of [
    ["SUMMARY_CONTEXT_LIMIT", [{ type: "text", text: "A".repeat(33 * 1024) }]],
    ["SUMMARY_RESULT_INVALID", [{ type: "text", text: 1n }]],
  ])
    await t.test(code, async (t) => {
      const f = fixture(t);
      const { item } = await f.plans.dispatch("workflow.plan.create", {
        ...f.owner,
        tasks: [task("source")],
        summarize: true,
      });
      await until(() => f.starts.length === 1);
      f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output });
      const final = await until(async () => {
        const state = await f.status(item.id);
        return state.state === "finished-with-errors" && state;
      });
      assert.equal(final.tasks[1].error.code, code);
      assert.equal(final.tasks[1].state, "blocked");
      assert.deepEqual(final.tasks[0].receipt.result.output, output);
      assert.equal(f.starts.length, 1);
    });
});

test("summary opt-in validates reserved IDs and stop cancels the extra executor", async (t) => {
  const f = fixture(t);
  for (const patch of [
    { summarize: "true", tasks: [task("source")] },
    { summarize: true, tasks: [task("$summary")] },
    { summarize: true, tasks: [task("source", { dependsOn: ["$summary"] })] },
  ])
    await assert.rejects(f.plans.dispatch("workflow.plan.create", { ...f.owner, ...patch }), {
      code: "INVALID_INPUT",
    });
  assert.equal(f.starts.length, 0);
  const { item } = await f.plans.dispatch("workflow.plan.create", {
    ...f.owner,
    tasks: [task("source")],
    summarize: true,
  });
  await until(() => f.starts.length === 1);
  f.pending.get(f.starts[0].childId).resolve({ stopReason: "completed", output: [] });
  await until(() => f.starts.length === 2);
  const stopped = await f.stop(item.id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.item.tasks[1].state, "cancelled");
  assert.equal(stopped.item.tasks[1].receipt.slotReleased, true);
  assert.equal(f.flow.status(f.workspace.id).active.length, 0);
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
    directory,
    create,
    status,
    stop,
  };
}

function skillFixture(t) {
  const f = fixture(t);
  const library = new SkillLibrary(join(f.directory, "selected-skills"));
  f.agents.set(f.owner.parentSessionId, {
    id: f.owner.parentSessionId,
    session: { id: f.owner.parentSessionId, header: { cwd: f.directory } },
  });
  f.services.skills = {
    snapshot: async () => ({
      complete: true,
      skills: [{ name: "same-name", invocation: { modelInvocable: true } }],
    }),
    get: async () => ({
      name: "same-name",
      content: "HOST_BODY_MUST_NOT_LEAK",
      metadata: { "dsh-unlimit": { requirements: [] } },
    }),
  };
  f.services.tools = { schemas: () => [{ name: "synthetic_read" }] };
  f.plans.catalog = new HostCatalog(
    { get: (key) => f.services[key] },
    { library, toolkit: { status: () => ({ tools: [] }) } },
  );
  const save = (body, declaration = "[]") =>
    library.dispatch("skills.save", {
      id: "local-skill",
      content: `---\nname: same-name\ndescription: Original synthetic project skill\n${declaration === null ? "" : `dsh-unlimit-requirements: ${declaration}\n`}---\n${body}`,
    });
  return { ...f, library, save, ref: { origin: "project", id: "local-skill" } };
}

test("project skill selection is available to planning and exact complete body reaches only its selected executor", async (t) => {
  const f = skillFixture(t);
  f.save("PROJECT_BODY_COMPLETE\nUse only the supplied synthetic records.");
  const selected = task("selected", { skills: [f.ref] });
  const { item: draft } = await f.plans.dispatch("workflow.plan.propose", {
    ...f.owner,
    goal: "Use the project inventory skill",
  });
  await until(() => f.starts.length === 1);
  const plannerPrompt = f.starts[0].request.prompt[0].text;
  assert.match(plannerPrompt, /local-skill/);
  assert.doesNotMatch(plannerPrompt, /PROJECT_BODY_COMPLETE|HOST_BODY_MUST_NOT_LEAK/);
  f.pending.get(f.starts[0].childId).resolve(modelOutput({ tasks: [selected] }));
  const ready = await until(async () => {
    const current = await f.status(draft.id);
    return current.proposal.state === "ready" && current;
  });
  assert.deepEqual(ready.proposal.tasks[0].skills, [f.ref]);
  const { item } = await f.create([...ready.proposal.tasks, task("unrelated")]);
  await until(() => f.starts.length === 2);
  const prompt = f.starts[1].request.prompt[0].text;
  const content = f.library.dispatch("skills.read", { id: f.ref.id }).item.content;
  assert.ok(prompt.includes(JSON.stringify([{ ...f.ref, name: "same-name", content }])));
  assert.doesNotMatch(prompt, /HOST_BODY_MUST_NOT_LEAK/);
  f.pending.get(f.starts[1].childId).resolve(modelOutput({ result: "done" }));
  await until(() => f.starts.length === 3);
  assert.doesNotMatch(f.starts[2].request.prompt[0].text, /PROJECT_BODY_COMPLETE/);
  const state = await f.status(item.id);
  assert.equal(state.tasks[0].preflight.skillBodies, undefined);
  assert.equal(state.tasks[0].skillContext[0].content, content);
  await f.stop(item.id);
});

test("undeclared, missing and oversized skills block without dispatch or truncation", async (t) => {
  for (const [name, body, declaration, code] of [
    ["undeclared", "Original body", null, "DEPENDENCIES_UNAVAILABLE"],
    [
      "missing tool",
      "Original body",
      '[{"kind":"tool","name":"missing"}]',
      "DEPENDENCIES_UNAVAILABLE",
    ],
    ["oversized", "x".repeat(33 * 1024), "[]", "DEPENDENCY_CONTEXT_LIMIT"],
  ])
    await t.test(name, async (t) => {
      const f = skillFixture(t);
      f.save(body, declaration);
      const { item } = await f.create([task("selected", { skills: [f.ref] })]);
      const done = await until(async () => {
        const state = await f.status(item.id);
        return state.state === "finished-with-errors" && state;
      });
      assert.equal(done.tasks[0].error.code, code);
      assert.equal(f.starts.length, 0);
      assert.ok(done.tasks[0].skillContext[0].content.endsWith(body));
    });
});

test("queued tasks reread selected skill declarations and cannot silently ignore absent body delivery", async (t) => {
  const f = skillFixture(t);
  f.save("Original body");
  const { item } = await f.create([
    task("first"),
    task("second", { skills: [f.ref], dependsOn: ["first"] }),
  ]);
  await until(() => f.starts.length === 1);
  f.save("Changed body", '[{"kind":"tool","name":"missing"}]');
  f.pending.get(f.starts[0].childId).resolve(modelOutput({ result: "done" }));
  const done = await until(async () => {
    const current = await f.status(item.id);
    return current.state === "finished-with-errors" && current;
  });
  assert.equal(done.tasks[1].state, "blocked");
  assert.match(done.tasks[1].skillContext[0].content, /Changed body/);
  assert.equal(f.starts.length, 1);
  f.plans.catalog = { preflight: async () => ({ status: "ready" }) };
  const next = await f.create([task("incomplete", { skills: [f.ref] })]);
  await until(
    async () => (await f.status(next.item.id)).tasks[0].error?.code === "SKILL_CONTEXT_UNAVAILABLE",
  );
  assert.equal(f.starts.length, 1);
});

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

test("plan environment declarations use the catalog contract and block missing configuration before activation", async (t) => {
  const observed = [];
  const f = fixture(t, {
    async preflight(payload) {
      observed.push(payload);
      return {
        status: "blocked",
        checks: [{ ...payload.requirements[0], state: "missing" }],
        executionAuthorized: false,
      };
    },
  });
  const { item } = await f.create([
    task("requires-local-config", {
      requirements: [{ kind: "environment-variable", name: "SYNTHETIC_PLAN_TOKEN" }],
    }),
  ]);
  const result = await until(async () => {
    const value = await f.status(item.id);
    return value.state === "finished-with-errors" && value;
  });
  assert.deepEqual(observed[0], {
    sessionId: "parent-a",
    requirements: [{ kind: "environment-variable", name: "SYNTHETIC_PLAN_TOKEN", nonEmpty: true }],
  });
  assert.equal(result.tasks[0].state, "blocked");
  assert.equal(result.tasks[0].error.code, "DEPENDENCIES_UNAVAILABLE");
  assert.equal(f.starts.length, 0);
  await assert.rejects(
    f.create([
      task("invalid", {
        requirements: [
          { kind: "environment-variable", name: "SYNTHETIC_PLAN_TOKEN", nonEmpty: "false" },
        ],
      }),
    ]),
    /boolean/,
  );
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
    [task("x", { skills: [{ origin: "foreign", id: "a" }] })],
    [
      task("x", {
        skills: [
          { origin: "project", id: "a" },
          { origin: "project", id: "a" },
        ],
      }),
    ],
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

test("explicit resource errors and combined context limit prevent executor startup", async (t) => {
  for (const [path, value, code] of [
    ["missing.md", null, "DEPENDENCIES_UNAVAILABLE"],
    ["large.txt", "x".repeat(32 * 1024), "DEPENDENCY_CONTEXT_LIMIT"],
  ])
    await t.test(path, async (t) => {
      const f = skillFixture(t);
      const content =
        "---\nname: same-name\ndescription: Synthetic resource skill\ndsh-unlimit-requirements: []\n---\nUse selected reference.";
      f.library.dispatch("skills.import", {
        id: f.ref.id,
        files: [
          { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64") },
          ...(value === null
            ? []
            : [{ path, contentBase64: Buffer.from(value).toString("base64") }]),
        ],
      });
      const { item } = await f.create([
        task("selected", { skills: [{ ...f.ref, resources: [path] }] }),
      ]);
      const done = await until(async () => {
        const result = await f.status(item.id);
        return result.state === "finished-with-errors" && result;
      });
      assert.equal(done.tasks[0].error.code, code);
      assert.equal(f.starts.length, 0);
    });
});

test("automatic resource selection is bound to its own observed skill and excludes extra metadata", async (t) => {
  const catalog = planningCatalog();
  const list = catalog.list;
  catalog.list = async () => {
    const value = await list();
    value.skills.find((item) => item.origin === "project").resources = [
      {
        path: "references/own.md",
        bytes: 3,
        content: "NOT_FOR_RESOURCE_PLANNER",
        contentBase64: "PRIVATE_BASE64",
      },
    ];
    value.skills.push({
      origin: "project",
      id: "other-skill",
      name: "other",
      resources: [{ path: "references/foreign.md", bytes: 4 }],
    });
    return value;
  };
  const f = fixture(t, catalog);
  const { item } = await f.plans.dispatch("workflow.plan.run", {
    ...f.owner,
    goal: "Use local-skill to inspect supplied material",
  });
  await until(() => f.starts.length === 1);
  const prompt = f.starts[0].request.prompt[0].text;
  assert.match(prompt, /references\/own.md/);
  assert.match(prompt, /references\/foreign.md/);
  assert.doesNotMatch(prompt, /NOT_FOR_RESOURCE_PLANNER|PRIVATE_BASE64/);
  f.pending.get(f.starts[0].childId).resolve(
    modelOutput({
      tasks: [
        task("read", {
          skills: [{ origin: "project", id: "local-skill", resources: ["references/foreign.md"] }],
        }),
      ],
    }),
  );
  const final = await until(async () => {
    const state = await f.status(item.id);
    return state.proposal.state === "invalid" && state;
  });
  assert.equal(final.proposal.error.code, "UNKNOWN_RESOURCE");
  assert.equal(f.starts.length, 1);
});

test("a selected resource removed after planning observation blocks automatic execution", async (t) => {
  const f = skillFixture(t);
  const content =
    "---\nname: same-name\ndescription: Synthetic resource skill\ndsh-unlimit-requirements: []\n---\nUse the selected reference.";
  const document = { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64") };
  f.library.dispatch("skills.import", {
    id: f.ref.id,
    files: [
      document,
      {
        path: "references/count.md",
        contentBase64: Buffer.from("SYNTHETIC_COUNT_BODY").toString("base64"),
      },
    ],
  });
  const { item } = await f.plans.dispatch("workflow.plan.run", {
    ...f.owner,
    goal: "Use the supplied skill reference",
  });
  await until(() => f.starts.length === 1);
  assert.match(f.starts[0].request.prompt[0].text, /references\/count.md/);
  assert.doesNotMatch(f.starts[0].request.prompt[0].text, /SYNTHETIC_COUNT_BODY/);
  f.library.dispatch("skills.import", { id: f.ref.id, files: [document] });
  f.pending.get(f.starts[0].childId).resolve(
    modelOutput({
      tasks: [task("read", { skills: [{ ...f.ref, resources: ["references/count.md"] }] })],
    }),
  );
  const final = await until(async () => {
    const state = await f.status(item.id);
    return state.state === "finished-with-errors" && state;
  });
  assert.equal(final.proposal.state, "ready");
  assert.equal(final.tasks[1].state, "blocked");
  assert.equal(final.tasks[1].error.code, "DEPENDENCIES_UNAVAILABLE");
  assert.ok(
    final.tasks[1].preflight.checks.some((check) => check.code === "SKILL_RESOURCE_MISSING"),
  );
  assert.equal(f.starts.length, 1);
});

test("oversized resource inventory is rejected without truncation or starting a planner", async (t) => {
  const catalog = planningCatalog();
  const list = catalog.list;
  catalog.list = async () => {
    const value = await list();
    value.skills[1].resources = Array.from({ length: 200 }, (_, i) => ({
      path: `references/${i}-${"x".repeat(180)}.md`,
      bytes: 1,
    }));
    return value;
  };
  const f = fixture(t, catalog);
  await assert.rejects(
    f.plans.dispatch("workflow.plan.run", { ...f.owner, goal: "Use listed skills" }),
    { code: "PLANNING_CONTEXT_LIMIT" },
  );
  assert.equal(f.starts.length, 0);
});
