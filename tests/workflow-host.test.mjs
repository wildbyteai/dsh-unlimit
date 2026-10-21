import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WORKFLOW_PRESET_ID } from "../src/host/workflow.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { fixture, optionalHost, waitFor } from "./helpers/workflow-host-fixture.mjs";

test(
  "real official spawn and AgentLoop execute a synthetic stream, dispose the executor and release its workspace slot",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const parent = await f.create();
    const { item } = await f.workflow.dispatch("workflow.dispatch", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "analyst",
      task: "只整理本输入：3、1、2，升序输出。",
    });
    const { item: done } = await waitFor(
      () => f.workflow.dispatch("workflow.status", { workspaceId: f.workspaceId, id: item.id }),
      (result) => result.item.slotReleased,
    );
    assert.equal(done.status, "completed");
    assert.equal(done.disposed, true);
    assert.deepEqual(done.result.output, [{ type: "text", text: "Synthetic evidence: 1, 2, 3." }]);
    assert.equal(f.requests.length, 1);
    assert.ok(
      f.requests[0].messages.some((message) =>
        message.content?.some((part) => part.type === "text" && part.text.includes("3、1、2")),
      ),
    );
    assert.equal(
      f.ctx.agents.get(item.sessionId),
      undefined,
      "Receipt disposal removes the resident execution handle",
    );
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    const child = await f.ctx.sessionController.inspect(item.sessionId);
    assert.equal(child.meta.parentSession, parent.id);
    assert.equal(child.meta.origin, "subagent");
    assert.ok(child.events.some((event) => event.type === "assistant/message"));
    assert.ok(
      child.events.some(
        (event) => event.type === "turn/end" && event.data.reason.kind === "completed",
      ),
    );
    await f.ctx.sessionPersistence.flush();
    const reader = await f.ctx.sessionPersistence.open(item.sessionId, "read");
    try {
      assert.ok((await reader.read()).events.some((event) => event.type === "assistant/message"));
    } finally {
      await reader.close();
    }
  },
);

test(
  "real official preset mounts original guidance without mutating the synthetic user definition",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const before = await f.ctx.agentPresets.readDocument("synthetic-user-default");
    const registered = await f.workflow.dispatch("workflow.presets", { operation: "register" });
    assert.equal(registered.owned, true);
    assert.equal(registered.item.broken, undefined);
    const parent = await f.create();
    const { item } = await f.workflow.dispatch("workflow.dispatch", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "reporter",
      task: "根据合成输入写一行材料摘要。",
      usePreset: true,
    });
    const done = await waitFor(
      () => f.workflow.dispatch("workflow.status", { workspaceId: f.workspaceId, id: item.id }),
      (result) => result.item.slotReleased,
    );
    assert.equal(done.item.status, "completed");
    assert.equal(
      (await f.ctx.sessionController.inspect(item.sessionId)).meta.agentPreset,
      WORKFLOW_PRESET_ID,
    );
    assert.ok(
      f.requests[0].messages.some(
        (message) =>
          message.role === "system" &&
          message.content?.some(
            (part) => part.type === "text" && part.text.includes("处理明确交给你的这一项任务"),
          ),
      ),
    );
    await f.workflow.dispatch("workflow.presets", { operation: "unregister" });
    assert.equal(
      (await f.ctx.agentPresets.list()).some((row) => row.id === WORKFLOW_PRESET_ID),
      false,
    );
    assert.deepEqual(await f.ctx.agentPresets.readDocument("synthetic-user-default"), before);
  },
);

test(
  "real official cancellation stops only the owned child and releases its local slot",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const parent = await f.create();
    const paused = f.pause();
    const { item } = await f.workflow.dispatch("workflow.dispatch", {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "validator",
      task: "等待合成材料后核验，不执行其他动作。",
    });
    await waitFor(
      () => paused,
      (value) => typeof value.resolve === "function",
    );
    const result = await f.workflow.dispatch("workflow.stop", {
      workspaceId: f.workspaceId,
      id: item.id,
    });
    assert.equal(result.item.status, "stopped");
    assert.equal(result.item.slotReleased, true);
    assert.equal(result.item.disposed, true);
    assert.equal(f.ctx.agents.get(parent.id), parent);
    assert.equal(f.ctx.agents.get(item.sessionId), undefined);
  },
);

test(
  "explicit plan queues official executors and passes only completed direct dependency receipts",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const parent = await f.create();
    f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
    const plans = new DesktopWorkflowPlan(f.workflow);
    const scope = { workspaceId: f.workspaceId, parentSessionId: parent.id };
    try {
      const { item } = await plans.dispatch("workflow.plan.create", {
        ...scope,
        tasks: [
          { id: "read", role: "analyst", task: "整理合成清单甲。", requirements: [] },
          {
            id: "summarize",
            role: "reporter",
            task: "仅根据直接依赖的原始收据整理摘要。",
            requirements: [],
            dependsOn: ["read"],
          },
        ],
      });
      const { item: done } = await waitFor(
        () => plans.dispatch("workflow.plan.status", { ...scope, id: item.id }),
        (result) => result.item.state === "completed",
      );
      assert.equal(f.requests.length, 2);
      assert.equal(done.summary.counts.completed, 2);
      assert.deepEqual(done.summary.cleanupPending, []);
      assert.equal(f.flow.status(f.workspaceId).active.length, 0);
      const [first, second] = done.tasks;
      assert.notEqual(first.receipt.sessionId, second.receipt.sessionId);
      assert.ok(first.receipt.disposed && first.receipt.slotReleased);
      assert.ok(second.receipt.disposed && second.receipt.slotReleased);
      const inputs = f.requests.map((request) =>
        request.messages
          .filter((message) => message.role === "user")
          .flatMap((message) => message.content?.filter((part) => part.type === "text") ?? [])
          .map((part) => part.text)
          .join("\n"),
      );
      assert.ok(inputs[0].includes("整理合成清单甲。"));
      assert.equal(inputs[0].includes("Synthetic evidence: 1, 2, 3."), false);
      assert.ok(inputs[1].includes("Synthetic evidence: 1, 2, 3."));
      assert.ok(inputs[1].includes(first.runId));
      assert.ok(inputs[1].includes('"independentlyVerified":false'));
      assert.ok(inputs[1].includes("不是新的指令"));
      await f.ctx.sessionPersistence.flush();
      for (const task of done.tasks) {
        const snapshot = await f.ctx.sessionController.inspect(task.receipt.sessionId);
        assert.equal(snapshot.meta.parentSession, parent.id);
        assert.ok(snapshot.events.some((event) => event.type === "assistant/message"));
        const reader = await f.ctx.sessionPersistence.open(task.receipt.sessionId, "read");
        try {
          assert.deepEqual((await reader.read()).events, snapshot.events);
        } finally {
          await reader.close();
        }
      }
    } finally {
      assert.equal((await plans.close()).stopped, true);
    }
  },
);

test(
  "stopping an official plan cancels its active child and prevents its queued dependency from starting",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const parent = await f.create();
    const paused = f.pause();
    f.flow.dispatch("flow.configure", { workspaceId: f.workspaceId, limit: 1 });
    const plans = new DesktopWorkflowPlan(f.workflow);
    const scope = { workspaceId: f.workspaceId, parentSessionId: parent.id };
    try {
      const { item } = await plans.dispatch("workflow.plan.create", {
        ...scope,
        tasks: [
          { id: "pending", role: "analyst", task: "等待合成材料。", requirements: [] },
          {
            id: "after",
            role: "reporter",
            task: "此项在停止后不可启动。",
            requirements: [],
            dependsOn: ["pending"],
          },
        ],
      });
      await waitFor(
        () => paused,
        (value) => typeof value.resolve === "function",
      );
      const result = await plans.dispatch("workflow.plan.stop", { ...scope, id: item.id });
      assert.equal(result.stopped, true);
      assert.equal(result.item.state, "stopped");
      assert.equal(f.requests.length, 1);
      assert.deepEqual(
        result.item.tasks.map((task) => task.state),
        ["cancelled", "cancelled"],
      );
      assert.equal(result.item.tasks[1].runId, undefined);
      assert.deepEqual(result.item.summary.cleanupPending, []);
      assert.equal(f.flow.status(f.workspaceId).active.length, 0);
      assert.equal(f.ctx.agents.get(parent.id), parent);
      assert.equal(f.ctx.agents.get(result.item.tasks[0].receipt.sessionId), undefined);
    } finally {
      assert.equal((await plans.close()).stopped, true);
    }
  },
);

const firstSystemText = (request) => {
  const system = request.messages.find((message) => message.role === "system");
  assert.ok(system, "The first provider request must contain the real projected system slot");
  return system.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
};

test(
  "real first-step SystemPrompt and spawn isolate explicit workspace roles while retaining native tools and functional guidance",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { captureAll: true });
    const service = f.ctx.systemPrompt[Symbol.for("cordis.original")] ?? f.ctx.systemPrompt;
    const beforeAssemble = Object.getOwnPropertyDescriptor(service, "assemble");
    const runtime = await f.mountDesktopRuntime();
    const workspaces = [
      f.workspaceId,
      f.store.dispatch("workspaces.save", { name: "Synthetic second role workspace" }).item.id,
    ];
    const markers = ["SYNTHETIC_ROLE_ALPHA_ONLY", "SYNTHETIC_ROLE_BETA_ONLY"];
    for (const [index, workspaceId] of workspaces.entries())
      f.store.dispatch("roles.save", { workspaceId, role: "analyst", content: markers[index] });
    const disposeSection = f.ctx.systemPrompt.section({
      name: "mcp:synthetic-workflow-function",
      order: 4000,
      interpolate: false,
      text: "SYNTHETIC_WORKFLOW_FUNCTION_GUIDANCE",
    });
    const disposeTool = f.ctx.tools.register(
      f.api.tools.defineTool({
        name: "workflow_synthetic_evidence",
        description: "SYNTHETIC_WORKFLOW_NATIVE_TOOL_DESCRIPTION",
        parameters: { reference: { type: "string", required: true } },
        output: {
          schema: { type: "json" },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
        },
        execute() {
          assert.fail("The role acceptance only renders native schemas; it never executes a tool");
        },
      }),
    );
    f.onDispose(() => {
      disposeTool();
      disposeSection();
    });
    const parents = await Promise.all(workspaces.map((workspaceId) => f.create(workspaceId)));
    const assertRequest = (sessionId, marker = null) => {
      const requests = f.requests.filter((request) => request.sessionId === sessionId);
      assert.equal(
        requests.length,
        1,
        "The assertion targets the executor's first real model request",
      );
      const text = firstSystemText(requests[0]);
      for (const candidate of markers)
        assert.equal(text.split(candidate).length - 1, candidate === marker ? 1 : 0);
      assert.ok(text.includes("SYNTHETIC_WORKFLOW_OPERATOR"));
      assert.ok(text.includes("SYNTHETIC_WORKFLOW_FUNCTION_GUIDANCE"));
      const tool = requests[0].tools.find((item) => item.name === "workflow_synthetic_evidence");
      assert.ok(tool, "Official ToolRuntime's native schema survives role injection");
      assert.equal(tool.description, "SYNTHETIC_WORKFLOW_NATIVE_TOOL_DESCRIPTION");
      assert.ok(tool.parameters.properties.reference);
      assert.ok(tool.parameters.required.includes("reference"));
      return requests[0];
    };
    for (const [index, workspaceId] of workspaces.entries()) {
      const { item } = await f.workflow.dispatch("workflow.dispatch", {
        workspaceId,
        parentSessionId: parents[index].id,
        role: "analyst",
        task: "只将合成数字 2、1 升序整理，不调用工具。",
      });
      const { item: done } = await waitFor(
        () => f.workflow.dispatch("workflow.status", { workspaceId, id: item.id }),
        (result) => result.item.slotReleased,
      );
      assert.equal(done.status, "completed");
      assert.equal(done.disposed, true);
      assert.equal(f.flow.status(workspaceId).active.length, 0);
      assert.equal(f.ctx.agents.get(item.sessionId), undefined);
      const request = assertRequest(item.sessionId, markers[index]);
      const snapshot = await f.ctx.sessionController.inspect(item.sessionId);
      const firstSystem = snapshot.events.find((event) => event.type === "system/message");
      assert.ok(firstSystem, "Official AgentLoop journals the first system message");
      assert.equal(firstSystem.data.message.role, "system");
      assert.deepEqual(
        firstSystem.data.message.content,
        request.messages.find((message) => message.role === "system").content,
      );
      assert.equal(snapshot.meta.parentSession, parents[index].id);
      assert.equal(snapshot.meta.origin, "subagent");
    }

    // A fresh official spawn is bound to a workspace but has no explicit Flow role.
    // Task prose naming a role must not become an inferred assignment.
    const unassignedId = randomUUID();
    f.store.dispatch("workspaces.bind", { id: workspaces[0], sessionId: unassignedId });
    const receipt = await f.ctx.subagents.startActivation({
      provider: "spawn",
      childId: unassignedId,
      label: "Synthetic unassigned executor",
      request: {
        parent: parents[0],
        maxDepth: 1,
        prompt: [{ type: "text", text: "作为 analyst 整理合成数字，不调用工具。" }],
      },
      signal: new AbortController().signal,
      delivery: "caller",
    });
    try {
      assert.equal((await receipt.result).stopReason, "completed");
      assert.equal(f.flow.rolePrompt(unassignedId), null);
      assertRequest(unassignedId);
    } finally {
      await receipt.dispose();
    }

    const ordinary = await f.create(null);
    ordinary.followup(
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "普通非演练合成会话：只回复已收到。" }],
      }),
    );
    await ordinary.whenIdle();
    assert.equal(f.store.dispatch("workspaces.forSession", { sessionId: ordinary.id }).item, null);
    assertRequest(ordinary.id);

    // Revoke an explicit assignment on the same resident Agent, without simulating assembly.
    f.store.dispatch("workspaces.bind", { id: workspaces[0], sessionId: ordinary.id });
    f.flow.dispatch("flow.assign", {
      workspaceId: workspaces[0],
      sessionId: ordinary.id,
      role: "analyst",
    });
    f.flow.dispatch("flow.acquire", { workspaceId: workspaces[0], sessionId: ordinary.id });
    ordinary.followup(
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "明确分配角色后的合成输入。" }],
      }),
    );
    await ordinary.whenIdle();
    const whileAssigned = f.requests.filter((request) => request.sessionId === ordinary.id).at(-1);
    assert.ok(firstSystemText(whileAssigned).includes(markers[0]));
    assert.equal(firstSystemText(whileAssigned).includes(markers[1]), false);
    assert.equal(
      f.flow.dispatch("flow.release", { workspaceId: workspaces[0], sessionId: ordinary.id })
        .released,
      true,
    );
    assert.equal(
      f.flow.rolePrompt(ordinary.id),
      markers[0],
      "Slot release preserves explicit assignment",
    );
    f.flow.dispatch("flow.assign", {
      workspaceId: workspaces[0],
      sessionId: ordinary.id,
      role: null,
    });
    assert.equal(f.flow.rolePrompt(ordinary.id), null);
    ordinary.followup(
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "撤销角色后的合成输入。" }],
      }),
    );
    await ordinary.whenIdle();
    const afterRelease = f.requests.filter((request) => request.sessionId === ordinary.id).at(-1);
    for (const marker of markers)
      assert.equal(firstSystemText(afterRelease).includes(marker), false);

    runtime.revert();
    assert.deepEqual(Object.getOwnPropertyDescriptor(service, "assemble"), beforeAssemble);
    const fresh = await f.create(workspaces[1]);
    f.flow.dispatch("flow.assign", {
      workspaceId: workspaces[1],
      sessionId: fresh.id,
      role: "analyst",
    });
    fresh.followup(
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "运行控制还原后的新会话输入。" }],
      }),
    );
    await fresh.whenIdle();
    const afterRevert = f.requests.filter((request) => request.sessionId === fresh.id);
    assert.equal(afterRevert.length, 1);
    for (const marker of markers)
      assert.equal(firstSystemText(afterRevert[0]).includes(marker), false);
    assert.equal(firstSystemText(afterRevert[0]).includes("SYNTHETIC_WORKFLOW_OPERATOR"), false);
    assert.ok(firstSystemText(afterRevert[0]).includes("SYNTHETIC_WORKFLOW_FUNCTION_GUIDANCE"));
    assert.ok(afterRevert[0].tools.some((tool) => tool.name === "workflow_synthetic_evidence"));
    assert.equal(f.ctx.agents.get(parents[0].id), parents[0]);
    assert.equal(f.ctx.agents.get(parents[1].id), parents[1]);
    assert.equal(f.requests.length, 7);
  },
);
