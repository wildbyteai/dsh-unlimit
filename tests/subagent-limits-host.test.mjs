import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Flow } from "../src/core/flow.js";
import { WorkspaceStore } from "../src/core/store.js";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const snapshotHash = (agent) => hash(JSON.stringify(agent.session.snapshotEvents()));
const idOf = (name) => `synthetic-limits-${name}`;

function heldResponse() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: released.resolve,
    action: {
      kind: "hold",
      async wait(request) {
        request.signal.throwIfAborted();
        entered.resolve();
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(request.signal.reason);
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
        try {
          await Promise.race([released.promise, cancelled]);
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
      },
    },
  };
}

test(
  "official standard agents enforce live activation capacity and caller-resolved depth independently of local slots",
  {
    skip:
      selectedRoot && cache
        ? false
        : "Set both official runtime variables; only synthetic disposable sessions are used",
    timeout: 45000,
  },
  async (t) => {
    const f = await presetFixture(t, selectedRoot, cache);
    const scenarios = [];
    const activations = [];
    const denials = [];
    const receipts = new Set();
    const roots = [];
    const lifecycle = { created: [], disposed: [], started: [], ended: [] };
    f.ctx.on("agent/created", ({ agent }) => lifecycle.created.push(agent.id));
    f.ctx.on("agent/disposed", ({ agent }) => lifecycle.disposed.push(agent.id));
    f.ctx.on("subagent/start", (event) => lifecycle.started.push(event.id));
    f.ctx.on("subagent/end", (event) => lifecycle.ended.push(event.id));

    f.adapter.revert();
    const official = {
      depth: f.ctx.subagents.config.maxDepth,
      quantity: f.ctx.subagents.config.maxActiveSubagents,
    };
    assert.ok(Object.isFrozen(official.depth));
    assert.ok(Object.isFrozen(official.quantity));
    assert.equal(official.depth.get(), 1);
    assert.equal(official.quantity.get(), 8);
    f.adapter.apply();

    const root = async (name) => {
      const agent = await f.create(`limits-${name}`, []);
      roots.push(agent);
      return agent;
    };
    const start = async (name, parent) => {
      const childId = idOf(name);
      const response = heldResponse();
      f.script(childId, [response.action]);
      // This is the same explicit depth resolution used by DesktopWorkflow.
      // startActivation itself does not implicitly resolve omitted depth caps.
      const resolvedDepth = f.ctx.subagents.resolveMaxDepth();
      const receipt = await f.ctx.subagents.startActivation({
        provider: "spawn",
        childId,
        label: "Synthetic activation-limit acceptance",
        request: {
          parent,
          maxDepth: resolvedDepth,
          agentPreset: "standard",
          prompt: [{ type: "text", text: "SYNTHETIC_DISPOSABLE_LIMIT_TASK" }],
        },
        signal: new AbortController().signal,
        delivery: "caller",
      });
      receipts.add(receipt);
      assert.equal(receipt.childId, childId);
      assert.equal(typeof receipt.messageId, "string");
      const agent = f.ctx.agents.get(childId);
      assert.ok(agent, "An admitted child must be a real live official Agent");
      await response.entered;
      assert.equal(agent.status, "running");
      assert.equal(agent.session.header.parentSession, parent.id);
      assert.equal(
        agent.session.header.delegationDepth,
        (parent.session.header.delegationDepth ?? 0) + 1,
      );
      assert.equal(f.ctx.agents.isOwnedBy(childId, parent), true);
      assert.equal(f.ctx.agentPresets.composedPreset(agent.ctx), "standard");
      const composition = f.ctx.agentPresets.inspectCompositions(agent.ctx);
      assert.equal(composition.length, 1);
      assert.deepEqual(composition[0].leakedServices, []);
      assert.deepEqual(
        composition[0].modules.map((row) => row.moduleName).sort(),
        f.composition.rows
          .filter((row) => row.enabled)
          .map((row) => row.moduleName)
          .sort(),
      );
      const revision = await f.ctx.agentPresets.acquireScope("standard");
      try {
        assert.equal(
          f.api.scope.scopeParentOf(f.api.scope.scopeOf(agent.ctx)),
          revision.key,
          "Spawned agents must join the exact retained standard revision",
        );
      } finally {
        await revision[Symbol.asyncDispose]();
      }
      const row = {
        childId,
        parentSessionId: parent.id,
        depth: agent.session.header.delegationDepth,
        resolvedMaxDepth: resolvedDepth,
        maxActiveSubagents: f.ctx.subagents.config.maxActiveSubagents.get(),
        preset: "standard",
        exactRetainedScopeIdentity: true,
        officialReceipt: true,
        liveAgentObserved: true,
        realAgentLoopRequest: true,
        disposed: false,
      };
      activations.push(row);
      return { receipt, response, agent, row };
    };
    const complete = async (run) => {
      run.response.release();
      const result = await run.receipt.result;
      assert.equal(result.stopReason, "completed");
      assert.equal(f.requests.filter((request) => request.sessionId === run.agent.id).length, 1);
      assert.ok(
        result.output.some(
          (part) => part.type === "text" && part.text === "SYNTHETIC_STANDARD_COMPLETE",
        ),
      );
      await run.receipt.dispose();
      receipts.delete(run.receipt);
      assert.equal(f.ctx.agents.get(run.agent.id), undefined);
      assert.equal(f.ctx.sessions.get(run.agent.id), undefined);
      await f.ctx.sessionPersistence.flush();
      const reader = await f.ctx.sessionPersistence.open(run.agent.id, "read");
      try {
        const snapshot = await reader.read();
        assert.equal(hash(JSON.stringify(snapshot.events)), snapshotHash(run.agent));
        assert.equal(
          snapshot.events.findLast((event) => event.type === "turn/end")?.data.reason.kind,
          "completed",
        );
      } finally {
        await reader.close();
      }
      Object.assign(run.row, {
        disposed: true,
        stopReason: result.stopReason,
        persistedJsonlReadback: true,
      });
    };
    const refuse = async (name, parent, expected) => {
      const childId = idOf(name);
      const before = {
        agents: f.ctx.agents
          .list()
          .map((agent) => agent.id)
          .sort(),
        requests: f.requests.length,
        created: lifecycle.created.length,
        started: lifecycle.started.length,
        parentSnapshot: snapshotHash(parent),
      };
      let observed;
      await assert.rejects(
        () => start(name, parent),
        (error) => {
          observed = error;
          if (expected.kind === "depth") {
            assert.ok(error instanceof f.api.subagents.SubagentDepthError);
            assert.equal(error.attemptedDepth, expected.attemptedDepth);
            assert.equal(error.maxDepth, expected.maxDepth);
          } else {
            assert.ok(error instanceof f.api.subagents.SubagentError);
            assert.equal(error.code, "ACTIVATION_LIMIT_REACHED");
            assert.match(error.message, new RegExp(`active child limit: ${expected.limit}\\)`));
          }
          return true;
        },
      );
      await f.ctx.sessionPersistence.flush();
      assert.deepEqual(
        f.ctx.agents
          .list()
          .map((agent) => agent.id)
          .sort(),
        before.agents,
      );
      assert.equal(f.requests.length, before.requests);
      assert.equal(lifecycle.created.length, before.created);
      assert.equal(lifecycle.started.length, before.started);
      assert.equal(snapshotHash(parent), before.parentSnapshot);
      assert.equal(f.ctx.agents.get(childId), undefined);
      assert.equal(f.ctx.sessions.get(childId), undefined);
      assert.equal(await f.ctx.sessionPersistence.stat(childId), undefined);
      denials.push({
        childId,
        parentSessionId: parent.id,
        kind: expected.kind,
        name: observed.name,
        ...(observed.code === undefined ? {} : { code: observed.code }),
        ...(expected.kind === "depth"
          ? { attemptedDepth: observed.attemptedDepth, maxDepth: observed.maxDepth }
          : { maxActiveSubagents: expected.limit }),
        noAgentCreated: true,
        noLifecycleStart: true,
        noModelRequest: true,
        noSessionOrJsonl: true,
        parentEventsUnchanged: true,
      });
    };

    try {
      await t.test("CAPACITY-LOW-LIMIT-NEXT-REQUEST-UPDATE-AND-RELEASE", async () => {
        f.settings.maxDepth = 3;
        f.settings.maxSubagents = 1;
        const parent = await root("quantity");
        const first = await start("quantity-first", parent);
        await refuse("quantity-second", parent, { kind: "quantity", limit: 1 });
        f.settings.maxSubagents = 2;
        const second = await start("quantity-second", parent);
        assert.equal(f.ctx.agents.get(first.agent.id), first.agent);
        f.settings.maxSubagents = 1;
        await refuse("quantity-next", parent, { kind: "quantity", limit: 1 });
        await complete(second);
        await refuse("quantity-next", parent, { kind: "quantity", limit: 1 });
        await complete(first);
        await complete(await start("quantity-next", parent));
        scenarios.push({
          id: "CAPACITY-LOW-LIMIT-NEXT-REQUEST-UPDATE-AND-RELEASE",
          limits: [1, 2, 1],
          acceptedAfterReusingDeniedIds: true,
          loweringPreservesAlreadyRunningAgents: true,
          releasedCapacityReused: true,
          result: "passed",
        });
      });

      await t.test("DEPTH-ZERO-NESTED-GRANDCHILD-NEXT-REQUEST-UPDATE", async () => {
        f.settings.maxSubagents = 3;
        f.settings.maxDepth = 0;
        const parent = await root("depth");
        await refuse("depth-child", parent, { kind: "depth", attemptedDepth: 1, maxDepth: 0 });
        f.settings.maxDepth = 1;
        const child = await start("depth-child", parent);
        await refuse("depth-grandchild", child.agent, {
          kind: "depth",
          attemptedDepth: 2,
          maxDepth: 1,
        });
        f.settings.maxDepth = 2;
        const grandchild = await start("depth-grandchild", child.agent);
        await refuse("depth-great-grandchild", grandchild.agent, {
          kind: "depth",
          attemptedDepth: 3,
          maxDepth: 2,
        });
        f.settings.maxDepth = 1;
        assert.equal(f.ctx.agents.get(grandchild.agent.id), grandchild.agent);
        await refuse("depth-next-grandchild", child.agent, {
          kind: "depth",
          attemptedDepth: 2,
          maxDepth: 1,
        });
        await complete(grandchild);
        await complete(child);
        scenarios.push({
          id: "DEPTH-ZERO-NESTED-GRANDCHILD-NEXT-REQUEST-UPDATE",
          limits: [0, 1, 2, 1],
          actualNestedDepths: [1, 2],
          acceptedAfterReusingDeniedIds: true,
          loweringPreservesAlreadyRunningAgents: true,
          result: "passed",
        });
      });

      await t.test("RESIDENT-TREE-POOL-AND-LOCAL-WORKFLOW-SLOTS-ARE-DISTINCT", async () => {
        const store = new WorkspaceStore(join(f.directory, "synthetic-limits.sqlite"));
        const flow = new Flow(store);
        try {
          const workspaceId = store.dispatch("workspaces.save", {
            name: "Synthetic limit domains",
          }).item.id;
          assert.equal(store.dispatch("settings.get", {}).value.maxSubagents, 16);
          assert.equal(flow.status(workspaceId).limit, 3);
          f.settings.maxDepth = 2;
          f.settings.maxSubagents = 1;
          const firstRoot = await root("pool-one");
          const secondRoot = await root("pool-two");
          const local = (action, payload = {}) =>
            flow.dispatch(action, { workspaceId, ...payload });
          for (const agent of [firstRoot, secondRoot]) {
            store.dispatch("workspaces.bind", { id: workspaceId, sessionId: agent.id });
            local("flow.assign", { sessionId: agent.id, role: "analyst" });
          }
          local("flow.configure", { limit: 1 });
          assert.equal(local("flow.acquire", { sessionId: firstRoot.id }).acquired, true);
          assert.throws(
            () => local("flow.acquire", { sessionId: secondRoot.id }),
            (error) => error.code === "SLOTS_FULL",
          );
          const first = await start("pool-one-child", firstRoot);
          const second = await start("pool-two-child", secondRoot);
          assert.equal(flow.status(workspaceId).active.length, 1);
          await refuse("pool-grandchild", first.agent, { kind: "quantity", limit: 1 });
          local("flow.configure", { limit: 2 });
          assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 1);
          await refuse("pool-extra-child", firstRoot, { kind: "quantity", limit: 1 });
          local("flow.configure", { limit: 1 });
          f.settings.maxSubagents = 2;
          const grandchild = await start("pool-grandchild", first.agent);
          assert.equal(flow.status(workspaceId).limit, 1);
          assert.throws(
            () => local("flow.acquire", { sessionId: secondRoot.id }),
            (error) => error.code === "SLOTS_FULL",
          );
          await refuse("pool-extra-child", firstRoot, { kind: "quantity", limit: 2 });
          await complete(grandchild);
          await complete(await start("pool-extra-child", firstRoot));
          await complete(first);
          await complete(second);
          assert.equal(local("flow.release", { sessionId: firstRoot.id }).released, true);
          assert.deepEqual(flow.status(workspaceId).active, []);
          scenarios.push({
            id: "RESIDENT-TREE-POOL-AND-LOCAL-WORKFLOW-SLOTS-ARE-DISTINCT",
            defaults: { pluginMaxSubagents: 16, officialMaxActiveSubagents: 8, localSlots: 3 },
            quantityScope: "pool shared by uninterrupted resident parent-child links",
            separateRootPoolsObserved: true,
            descendantConsumesSamePool: true,
            directOfficialApiDoesNotAcquireLocalFlowSlots: true,
            localSlotChangesPreserveOfficialCapacity: true,
            officialCapacityChangesPreserveLocalSlots: true,
            result: "passed",
          });
        } finally {
          flow.close();
          store.close();
        }
      });

      await t.test("REVERT-RESTORES-ORIGINAL-VOLATILES-AND-OFFICIAL-BOUNDARIES", async () => {
        f.settings.maxDepth = 4;
        f.settings.maxSubagents = 1;
        assert.equal(f.ctx.subagents.resolveMaxDepth(), 4);
        assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 1);
        f.adapter.revert();
        assert.equal(f.ctx.subagents.config.maxDepth, official.depth);
        assert.equal(f.ctx.subagents.config.maxActiveSubagents, official.quantity);
        assert.equal(f.ctx.subagents.resolveMaxDepth(), 1);
        assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 8);
        const parent = await root("revert");
        const children = [];
        for (let i = 0; i < 8; i++) children.push(await start(`revert-child-${i + 1}`, parent));
        await refuse("revert-ninth", parent, { kind: "quantity", limit: 8 });
        await refuse("revert-grandchild", children[0].agent, {
          kind: "depth",
          attemptedDepth: 2,
          maxDepth: 1,
        });
        await complete(children.pop());
        await complete(await start("revert-ninth", parent));
        for (const child of children.reverse()) await complete(child);
        scenarios.push({
          id: "REVERT-RESTORES-ORIGINAL-VOLATILES-AND-OFFICIAL-BOUNDARIES",
          originalReferenceIdentityRestored: true,
          restoredMaxDepth: 1,
          restoredMaxActiveSubagents: 8,
          eightActualChildrenAccepted: true,
          ninthActualChildRejected: true,
          nestedDepthTwoRejected: true,
          releasedCapacityReused: true,
          result: "passed",
        });
      });
      assert.equal(scenarios.length, 4);
      assert.deepEqual(f.errors, []);
      assert.equal(receipts.size, 0);
      assert.deepEqual(
        f.ctx.agents
          .list()
          .map((agent) => agent.id)
          .sort(),
        roots.map((agent) => agent.id).sort(),
      );
      assert.deepEqual(lifecycle.started.toSorted(), activations.map((row) => row.childId).sort());
      assert.deepEqual(lifecycle.ended.toSorted(), lifecycle.started.toSorted());
      assert.ok(activations.every((row) => row.disposed));
    } finally {
      for (const receipt of receipts) await receipt.dispose();
      await f.dispose();
    }
    assert.deepEqual(lifecycle.disposed.toSorted(), lifecycle.created.toSorted());
    assert.deepEqual(f.evidence().isolation.networkAttempts, []);
    assert.equal(f.evidence().isolation.rootsRemoved, true);

    if (process.env.DSH_UNLIMIT_SUBAGENT_LIMITS_EVIDENCE === "1") {
      const paths = [
        "tests/subagent-limits-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "tests/fixtures/official-preset-packages.json",
        "src/host/runtime.js",
        "src/core/flow.js",
        "src/core/store.js",
        "src/core/validation.js",
      ];
      writeFileSync(
        join(presetProjectRoot, "docs/evidence/subagent-limits-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            behaviorId: "CORE-SUBAGENTS",
            generatedAt: new Date().toISOString(),
            node: process.version,
            platform: { os: process.platform, arch: process.arch },
            workingTreeEvidence: true,
            command:
              "DSH_UNLIMIT_RUNTIME=<official-runtime> DSH_UNLIMIT_OFFICIAL_PACKAGES=<verified-archives> DSH_UNLIMIT_SUBAGENT_LIMITS_EVIDENCE=1 <bundled-node> --expose-internals --test tests/subagent-limits-host.test.mjs",
            ...f.evidence(),
            scenarios,
            activations,
            denials,
            lifecycle,
            calls: { syntheticModelRequests: f.requests.length, modelAuthoredToolCalls: 0 },
            testResult: { tests: 5, passed: 5, failed: 0, skipped: 0 },
            sourceDigests: paths.map((path) => ({
              path,
              sha256: hash(readFileSync(join(presetProjectRoot, path))),
            })),
            boundaries: {
              completeStandardPresetMounted: true,
              actualOfficialLoader: true,
              actualOfficialRegistry: true,
              actualSubagentRuntime: true,
              actualInProcessSpawn: true,
              actualAgentLoop: true,
              actualJsonlReadback: true,
              holdingOnlyAtSyntheticModelTransport: true,
              callerResolvesMaxDepthForEachStartActivation: true,
              modelSubagentToolSchemaDispatchExecuted: false,
              explicitApiDepthOverrideBehaviorAssessed: false,
              localFlowBookkeepingOnly: true,
              realDesktopExecuted: false,
              realModelExecuted: false,
              realProfileLoaded: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
