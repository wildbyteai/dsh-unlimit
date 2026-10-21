import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { filePermissionsFixture, projectRoot } from "./helpers/file-permissions-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const options = {
  skip: runtimeRoot && cache ? false : "Set both official runtime variables; no profile is loaded",
  timeout: 30000,
};
const CUSTOM = "SYNTHETIC_MODES_LOOP_OPERATOR";
const GUIDANCE = "SYNTHETIC_MODES_LOOP_PLAN_GUIDANCE";
const CONTENT = "SYNTHETIC_MODES_LOOP_FILE_CONTENT";
const textOf = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");

test(
  "official AgentLoop executes native reads and plan review through real step boundaries",
  options,
  async (t) => {
    const dnsAttempts = [];
    for (const [label, api] of [
      ["dns", dns],
      ["dns/promises", dnsPromises],
    ]) {
      for (const key of Object.keys(api).filter(
        (key) => /^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function",
      )) {
        t.mock.method(api, key, () => {
          dnsAttempts.push(`${label}.${key}`);
          throw new Error("Modes loop fixture forbids DNS");
        });
      }
    }
    syncBuiltinESMExports();
    const f = await filePermissionsFixture(t, runtimeRoot, cache);
    const [llm, loop, plan, questions, persistence] = await Promise.all([
      f.loadOfficial("@deepseek-ai/dsh-llm"),
      f.loadOfficial("@deepseek-ai/dsh-agent-loop"),
      f.loadOfficial("@deepseek-ai/dsh-plan-mode"),
      f.loadOfficial("@deepseek-ai/dsh-user-questions"),
      f.loadOfficial("@deepseek-ai/dsh-session-persistence-jsonl"),
    ]);
    const scripts = new Map(),
      agents = [],
      observations = [],
      cases = [],
      errors = [];
    class OfflineAdapter extends llm.LlmAdapter {
      async *stream(request) {
        const agent = f.ctx.agents.get(request.sessionId);
        assert.ok(agent);
        assert.deepEqual(request.messages, agent.session.deriveMessages());
        const script = scripts.get(agent.id);
        assert.ok(
          script?.length,
          "every requested model step must have an explicit synthetic response",
        );
        const action = script.shift();
        observations.push({
          sessionId: agent.id,
          turn: agent.phase.turn,
          step: agent.phase.step,
          plan: structuredClone(f.ctx.planMode.get(agent)),
          systemText: textOf(request.messages.filter((m) => m.role === "system")),
          tools: structuredClone(request.tools),
          priorToolResults: agent.session.snapshotEvents().filter((e) => e.type === "tool/result")
            .length,
        });
        if (action === "finish")
          yield { type: "text-delta", index: 0, text: "SYNTHETIC_OFFLINE_FINISHED" };
        else {
          for (const [index, call] of action.entries()) {
            yield {
              type: "tool-call-delta",
              index,
              id: `${agent.id}-${agent.phase.step}-${index}`,
              name: call.name,
              argumentsDelta: JSON.stringify(call.arguments),
            };
          }
        }
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    await f.mount({
      name: "synthetic-modes-loop-llm",
      apply(ctx) {
        new llm.LlmRuntime(ctx);
        ctx.llm.registerAdapter(["synthetic-modes-offline"], new OfflineAdapter());
        ctx.on("agent/error", ({ error }) => errors.push(error));
      },
    });
    await f.mount(persistence, {
      root: join(f.root, "logs"),
      compression: "none",
      listConcurrency: 1,
    });
    await f.mount(loop.AgentLoop, { agents: [], maxParallelToolCalls: 1 });
    await f.mount(questions.UserQuestionService);
    await f.mount(plan.PlanModeController, { section: GUIDANCE });
    Object.assign(f.settings, {
      enabled: true,
      prompt: CUSTOM,
      promptMode: "replace",
      workspacePolicy: "strict",
      workspaceFiles: [],
      fullAccess: false,
      autoApprove: true,
    });
    f.adapter.apply();
    const file = f.seed(join(f.workspace, "mode-evidence.txt"), CONTENT + "\n");
    const read = { name: "read", arguments: { file_path: file } };
    const exit = {
      name: "exit_plan_mode",
      arguments: { plan: "# Synthetic local plan\nRead the disposable evidence file and finish." },
    };
    const create = async (id, script, planning = true) => {
      const agent = await f.ctx.agentLoop.create(
        `synthetic-modes-loop-${id}`,
        { provider: "synthetic-modes-offline", model: "synthetic-model", maxTokens: 128 },
        { cwd: f.workspace },
      );
      agents.push(agent);
      scripts.set(agent.id, script);
      if (planning) assert.equal(f.ctx.planMode.set(agent, true), "committed");
      assert.equal(f.ctx.approval.effectivePolicy(agent.session), "never");
      return agent;
    };
    const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
    const requests = (agent) => observations.filter((e) => e.sessionId === agent.id);
    const results = (agent) => events(agent, "tool/result");
    const durable = async (agent) => {
      await f.ctx.sessionPersistence.flush();
      const reader = await f.ctx.sessionPersistence.open(agent.id, "read");
      try {
        assert.deepEqual((await reader.read()).events, agent.session.snapshotEvents());
      } finally {
        await reader.close();
      }
    };
    const begin = (agent) =>
      agent.followup(
        llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "SYNTHETIC_EXPLICIT_LOCAL_TASK" }],
        }),
      );
    const settle = async (agent, reason = "completed") => {
      await agent.whenIdle();
      assert.equal(agent.status, "idle");
      assert.equal(events(agent, "turn/end").at(-1).data.reason.kind, reason);
      assert.equal(scripts.get(agent.id).length, 0, "all planned steps consumed exactly once");
      await durable(agent);
    };
    const run = async (id, fn) => {
      await t.test(id, async () => {
        await fn();
        cases.push({ id, result: "passed" });
      });
    };
    const review = (agent, decide) =>
      agent.ctx.on("user-questions/request", (request) => {
        assert.equal(request.agent, agent);
        assert.equal(request.questions.length, 1);
        const question = request.questions[0];
        assert.equal(question.intent.kind, "plan-review");
        assert.equal(f.ctx.planMode.get(agent).active, true);
        return decide(request, question);
      });
    const assertRead = (event) => {
      assert.equal(event.data.message.isError, false);
      assert.match(textOf([event.data.message]), new RegExp(CONTENT));
    };

    await run("LOOP-NATIVE-READ", async () => {
      const agent = await create("native", [[read], "finish"], false);
      begin(agent);
      await settle(agent);
      assertRead(results(agent)[0]);
      assert.equal(requests(agent).length, 2);
      assert.match(requests(agent)[0].systemText, new RegExp(CUSTOM));
      assert.doesNotMatch(requests(agent)[0].systemText, new RegExp(GUIDANCE));
      assert.deepEqual(
        requests(agent).map((r) => r.plan),
        [{ active: false }, { active: false }],
      );
    });

    await run("LOOP-APPROVE-NEXT-STEP-AND-SAME-BATCH", async () => {
      const agent = await create("approve", [[read], [exit, read], [read], "finish"]);
      const observedResults = [];
      const removeObserve = f.ctx.on("session/event", (session, event) => {
        if (session.id === agent.id && event.type === "tool/result")
          observedResults.push({
            callId: event.data.message.callId,
            state: structuredClone(f.ctx.planMode.get(agent)),
            seq: event.seq,
          });
      });
      let reviewCount = 0;
      const remove = review(agent, (_request, question) => {
        reviewCount++;
        assertRead(results(agent)[0]);
        assert.deepEqual(
          requests(agent).map((r) => r.plan.active),
          [true, true],
        );
        return { answers: [{ id: question.id, selected: [question.intent.approve] }] };
      });
      try {
        begin(agent);
        await settle(agent);
        assert.equal(reviewCount, 1);
        assert.deepEqual(
          requests(agent).map((r) => r.plan.active),
          [true, true, false, false],
        );
        assert.deepEqual(
          results(agent).map((r) => r.data.message.isError),
          [false, false, false, false],
        );
        for (const i of [0, 2, 3]) assertRead(results(agent)[i]);
        assert.deepEqual(
          observedResults.map((r) => r.state),
          [
            { active: true },
            { active: true, pending: false },
            { active: true, pending: false },
            { active: false },
          ],
        );
        assert.deepEqual(
          events(agent, "plan/mode").map((e) => e.data.active),
          [true, false],
        );
        const transition = events(agent, "plan/mode")[1];
        assert.ok(
          observedResults[2].seq < transition.seq && transition.seq < observedResults[3].seq,
        );
        assert.match(requests(agent)[0].systemText, new RegExp(GUIDANCE));
        assert.doesNotMatch(requests(agent)[2].systemText, new RegExp(GUIDANCE));
        for (const request of requests(agent)) assert.match(request.systemText, new RegExp(CUSTOM));
        assert.deepEqual(events(agent, "approval/asked"), []);
      } finally {
        remove();
        removeObserve();
      }
    });

    await run("LOOP-REJECT-KEEPS-PLAN", async () => {
      const agent = await create("reject", [[exit], "finish"]);
      const remove = review(agent, (_request, question) => ({
        answers: [
          {
            id: question.id,
            selected: [question.options.find((o) => o.label !== question.intent.approve).label],
          },
        ],
      }));
      try {
        begin(agent);
        await settle(agent);
        assert.equal(results(agent)[0].data.message.isError, true);
        assert.match(textOf([results(agent)[0].data.message]), /keep planning/);
        assert.deepEqual(
          requests(agent).map((r) => r.plan),
          [{ active: true }, { active: true }],
        );
        assert.deepEqual(
          events(agent, "plan/mode").map((e) => e.data.active),
          [true],
        );
      } finally {
        remove();
      }
    });

    await run("LOOP-DISMISS-CONCLUDES-TURN", async () => {
      const agent = await create("dismiss", [[exit]]);
      const remove = review(agent, () => {
        throw new questions.UserQuestionError("Synthetic dismissal", "ASK_CANCELLED");
      });
      try {
        begin(agent);
        await settle(agent);
        assert.equal(requests(agent).length, 1, "concludeTurn prevents another model step");
        assert.equal(results(agent)[0].data.message.isError, false);
        assert.deepEqual(f.ctx.planMode.get(agent), { active: true });
        assert.equal(events(agent, "plan/mode").length, 1);
      } finally {
        remove();
      }
    });

    await run("LOOP-CANCEL-INFLIGHT-REVIEW", async () => {
      const agent = await create("cancel", [[exit]]);
      const started = Promise.withResolvers();
      let reviewAborted = false;
      const remove = review(
        agent,
        (request) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            request.signal.addEventListener(
              "abort",
              () => {
                reviewAborted = true;
                reject(
                  new questions.UserQuestionError("Synthetic cancelled review", "ASK_ABORTED"),
                );
              },
              { once: true },
            );
          }),
      );
      try {
        begin(agent);
        await started.promise;
        assert.equal(agent.status, "running");
        agent.cancel({ kind: "user" });
        await settle(agent, "aborted");
        assert.equal(reviewAborted, true);
        assert.equal(requests(agent).length, 1);
        assert.deepEqual(f.ctx.planMode.get(agent), { active: true });
        assert.equal(events(agent, "plan/mode").length, 1);
      } finally {
        remove();
      }
    });

    await run("LOOP-NO-ANSWERER-AND-REVERT", async () => {
      const agent = await create("no-answerer", [[exit], "finish"]);
      begin(agent);
      await settle(agent);
      assert.equal(results(agent)[0].data.message.isError, true);
      assert.equal(results(agent)[0].data.error.code, "NO_PROVIDER");
      assert.deepEqual(f.ctx.planMode.get(agent), { active: true });
      f.adapter.revert();
      const restored = await create("restored", [[read], "finish"], false);
      begin(restored);
      await settle(restored);
      assertRead(results(restored)[0]);
      assert.doesNotMatch(requests(restored)[0].systemText, new RegExp(CUSTOM));
      assert.deepEqual(requests(restored)[0].tools, observations[0].tools);
    });

    assert.equal(cases.length, 6);
    assert.deepEqual(errors, []);
    assert.deepEqual(dnsAttempts, []);
    for (const request of observations) assert.deepEqual(request.tools, observations[0].tools);
    assert.ok(observations[0].tools.some((tool) => tool.name === "read"));
    assert.ok(!observations[0].tools.some((tool) => tool.name === "run_code"));
    for (const agent of agents) {
      agent.cancel({ kind: "user" });
      await agent.whenIdle();
    }
    const scenarioReadback = agents.map((agent) => ({
      id: agent.id,
      requests: requests(agent).length,
      planStatesAtRequests: requests(agent).map((r) => r.plan),
      toolResults: results(agent).length,
      toolCalls: events(agent, "tool/call").map((event) => event.data.name),
      ending: events(agent, "turn/end").at(-1).data.reason.kind,
      persistedEvents: agent.session.snapshotEvents().length,
    }));
    await f.dispose();
    assert.deepEqual(dnsAttempts, []);
    if (process.env.DSH_UNLIMIT_MODES_LOOP_EVIDENCE === "1") {
      const baseEvidence = f.evidence();
      baseEvidence.isolation.directFixtureToolCalls = baseEvidence.isolation.calls;
      delete baseEvidence.isolation.calls;
      baseEvidence.isolation.agentLoopToolCalls = scenarioReadback.reduce(
        (sum, session) => sum + session.toolCalls.length,
        0,
      );
      const paths = [
        "tests/modes-loop-host.test.mjs",
        "tests/helpers/file-permissions-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/runtime.js",
        "src/host/permission-defaults.js",
      ];
      writeFileSync(
        join(projectRoot, "docs/evidence/modes-loop-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            behaviorId: "CORE-MODES",
            node: process.version,
            ...baseEvidence,
            sourceDigests: paths.map((path) => ({
              path,
              sha256: createHash("sha256")
                .update(readFileSync(join(projectRoot, path)))
                .digest("hex"),
            })),
            testResult: { tests: 7, passed: 7, failed: 0, skipped: 0 },
            scenarios: cases,
            sessions: scenarioReadback,
            boundaries: {
              actualAgentLoop: true,
              manuallyDispatchedPreStep: false,
              actualOfficialFilesystemRead: true,
              actualJsonlReadback: true,
              syntheticModelAdapter: true,
              syntheticReviewAnswerer: true,
              completePresetsMounted: false,
              minimalOrPtcExecuted: false,
              realDesktopExecuted: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
