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
const optionalHost = {
  skip:
    runtimeRoot && cache
      ? false
      : "Set DSH_UNLIMIT_RUNTIME and DSH_UNLIMIT_OFFICIAL_PACKAGES for official native/plan execution; no profile is loaded",
  timeout: 30000,
};

test(
  "official native file execution and explicit plan review over synthetic Sessions",
  optionalHost,
  async (t) => {
    const dnsAttempts = [];
    for (const [label, api] of [
      ["dns", dns],
      ["dns/promises", dnsPromises],
    ]) {
      for (const name of Object.keys(api).filter(
        (key) => /^(?:lookup|resolve|reverse)/.test(key) && typeof api[key] === "function",
      ))
        t.mock.method(api, name, () => {
          dnsAttempts.push(`${label}.${name}`);
          throw new Error("Modes fixture forbids DNS");
        });
    }
    syncBuiltinESMExports();
    const f = await filePermissionsFixture(t, runtimeRoot, cache);
    const [plan, questions, loop] = await Promise.all([
      f.loadOfficial("@deepseek-ai/dsh-plan-mode"),
      f.loadOfficial("@deepseek-ai/dsh-user-questions"),
      f.loadOfficial("@deepseek-ai/dsh-agent-loop"),
    ]);
    await f.mount({
      name: "synthetic-plan-turn-projection",
      inject: ["sessionProjections"],
      apply(scope) {
        scope.sessionProjections.register(loop.turnBoundaryProjectionDefinition);
      },
    });
    await f.mount(questions.UserQuestionService);
    await f.mount(plan.PlanModeController, { section: "SYNTHETIC_EXECUTABLE_PLAN_GUIDANCE" });
    const file = f.seed(join(f.workspace, "modes.txt"), "SYNTHETIC_MODES_FILE_CONTENT\n");
    const cases = [],
      reviews = [];
    const events = (agent, type) =>
      agent.session.snapshotEvents().filter((row) => row.type === type);
    const state = (agent) => f.ctx.planMode.get(agent);
    const assertActive = (agent) => assert.deepEqual(state(agent), { active: true });
    const enterPlan = async (suffix) => {
      const agent = await f.createAgent(`modes-${suffix}`);
      assert.equal(f.ctx.planMode.set(agent, true), "committed");
      assertActive(agent);
      agent.session.append("turn/start", { turn: 1 });
      return agent;
    };
    const read = async (agent) => {
      const result = await f.execute(agent, "read", { file_path: file });
      assert.equal(result.isError, false, f.text(result));
      assert.match(f.text(result), /SYNTHETIC_MODES_FILE_CONTENT/);
      return result;
    };
    const exit = (agent, signal) =>
      f.execute(
        agent,
        "exit_plan_mode",
        { plan: "# Synthetic implementation\nRead the disposable evidence file and finish." },
        signal,
      );
    const failed = (result, pattern, code) => {
      assert.equal(result.isError, true, f.text(result));
      if (pattern) assert.match(f.text(result), pattern);
      if (code) assert.equal(result.error?.info?.code, code, f.text(result));
    };
    const answerer = (agent, decide) =>
      agent.ctx.on("user-questions/request", (request) => {
        assert.equal(request.agent, agent, "review reaches the exact live calling Agent");
        assert.equal(request.agent.session, agent.session);
        assert.equal(request.questions.length, 1);
        const question = request.questions[0];
        assert.equal(question.intent.kind, "plan-review");
        assert.match(question.intent.callId, /^synthetic-file-call-\d+$/);
        assert.match(question.detail, /^# Synthetic implementation\n/);
        assert.ok(question.options.some((option) => option.label === question.intent.approve));
        reviews.push({
          sessionId: agent.id,
          questionId: question.id,
          intent: { kind: question.intent.kind, callId: question.intent.callId },
          agentIdentityMatched: true,
          fields: Object.keys(request).sort(),
        });
        return decide(request, question);
      });
    const approved = (_request, question) => ({
      answers: [{ id: question.id, selected: [question.intent.approve] }],
    });
    const preStep = (agent, decision, signal = new AbortController().signal) =>
      f.api.agents
        .agentEvents(f.ctx, agent)
        .waterfall("agent/pre-step", { messages: [], turn: 1, step: 2, signal }, () =>
          Promise.resolve(decision),
        );
    const run = async (id, action) => {
      await t.test(id, async () => {
        await action();
        cases.push({ id, result: "passed" });
      });
    };

    await run("MODES-NATIVE-AND-PLAN-READ", async () => {
      const native = await f.createAgent("modes-native");
      assert.deepEqual(state(native), { active: false });
      assert.ok(f.ctx.tools.schemas(native).some((tool) => tool.name === "read"));
      assert.ok(!f.ctx.tools.schemas(native).some((tool) => tool.name === "run_code"));
      await read(native);
      const planning = await enterPlan("read");
      await read(planning);
      assertActive(planning);
      assert.deepEqual(
        events(planning, "plan/mode").map((row) => row.data.active),
        [true],
      );
    });

    await run("MODES-PLAN-REQUIRES-ANSWERER", async () => {
      const agent = await enterPlan("no-answerer");
      assert.equal(f.ctx.approval.effectivePolicy(agent.session), "never");
      failed(await exit(agent), /no user-questions answerer/, "NO_PROVIDER");
      assertActive(agent);
      assert.deepEqual(
        events(agent, "plan/mode").map((row) => row.data.active),
        [true],
      );
      assert.deepEqual(events(agent, "approval/asked"), []);
    });

    await run("MODES-PLAN-REJECT-AND-FEEDBACK", async () => {
      const agent = await enterPlan("rejected");
      let custom = false;
      const remove = answerer(agent, (_request, question) => ({
        answers: [
          custom
            ? {
                id: question.id,
                selected: [question.intent.approve],
                custom: "SYNTHETIC_REVISE_FIRST",
              }
            : {
                id: question.id,
                selected: [
                  question.options.find((option) => option.label !== question.intent.approve).label,
                ],
              },
        ],
      }));
      try {
        failed(await exit(agent), /chose to keep planning/);
        assertActive(agent);
        custom = true;
        failed(await exit(agent), /SYNTHETIC_REVISE_FIRST/);
        assertActive(agent);
        assert.equal(events(agent, "plan/mode").length, 1);
      } finally {
        remove();
      }
    });

    await run("MODES-PLAN-DISMISS-CANCEL", async () => {
      const agent = await enterPlan("dismissed");
      const remove = answerer(agent, () => {
        throw new questions.UserQuestionError("Synthetic dismissed review", "ASK_CANCELLED");
      });
      try {
        const result = await exit(agent);
        assert.equal(result.isError, false, f.text(result));
        assert.deepEqual(result.value, { approved: false });
        assert.equal(result.concludesTurn, true);
        assertActive(agent);
        assert.equal(events(agent, "plan/mode").length, 1);
      } finally {
        remove();
      }
    });

    await run("MODES-PLAN-INFLIGHT-ABORT", async () => {
      const agent = await enterPlan("aborted"),
        control = new AbortController(),
        started = Promise.withResolvers();
      let answererAborted = false;
      const remove = answerer(
        agent,
        (request) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            request.signal.addEventListener(
              "abort",
              () => {
                answererAborted = true;
                reject(
                  new questions.UserQuestionError("Synthetic interrupted review", "ASK_ABORTED"),
                );
              },
              { once: true },
            );
          }),
      );
      try {
        const pending = exit(agent, control.signal);
        await started.promise;
        control.abort(new Error("Synthetic caller cancelled plan review"));
        failed(await pending);
        assert.equal(answererAborted, true);
        assertActive(agent);
        assert.equal(events(agent, "plan/mode").length, 1);
      } finally {
        remove();
      }
    });

    await run("MODES-PLAN-APPROVE-BOUNDARY", async () => {
      const agent = await enterPlan("approved");
      const remove = answerer(agent, approved);
      try {
        const result = await exit(agent);
        assert.equal(result.isError, false, f.text(result));
        assert.deepEqual(result.value, { approved: true });
        assert.deepEqual(state(agent), { active: true, pending: false });
        await read(agent);
        const rejected = { kind: "reject", reason: "SYNTHETIC_PRE_STEP_REJECTION" };
        assert.equal(await preStep(agent, rejected), rejected);
        assert.deepEqual(state(agent), { active: true, pending: false });
        const accepted = { kind: "enter", messages: [] },
          control = new AbortController();
        control.abort();
        assert.equal(await preStep(agent, accepted, control.signal), accepted);
        assert.deepEqual(state(agent), { active: true, pending: false });
        assert.equal(events(agent, "plan/mode").length, 1);
        assert.equal(await preStep(agent, accepted), accepted);
        assert.deepEqual(state(agent), { active: false });
        assert.deepEqual(
          events(agent, "plan/mode").map((row) => row.data.active),
          [true, false],
        );
        await preStep(agent, accepted);
        assert.equal(events(agent, "plan/mode").length, 2, "exit commits exactly once");
        await read(agent);
        assert.deepEqual(
          events(agent, "approval/asked"),
          [],
          "plan review is not ordinary operation approval",
        );
      } finally {
        remove();
      }
    });

    await run("MODES-PROMPT-REPLACE-COMPAT", async () => {
      const agent = await enterPlan("prompt");
      const assemble = () =>
        f.ctx.systemPrompt.assemble({ agent, scope: agent, signal: new AbortController().signal });
      const planSection = (assembly) => assembly.sections.find((row) => row.name === "plan:policy");
      const baseline = await assemble();
      assert.equal(planSection(baseline).text, "SYNTHETIC_EXECUTABLE_PLAN_GUIDANCE");
      Object.assign(f.settings, {
        enabled: true,
        fullAccess: false,
        autoApprove: true,
        promptMode: "replace",
        prompt: "SYNTHETIC_REPLACED_OPERATOR_PROMPT",
        workspacePolicy: "strict",
        workspaceFiles: [],
      });
      f.adapter.apply();
      const replaced = await assemble();
      assert.deepEqual(replaced.tools, baseline.tools);
      assert.deepEqual(planSection(replaced), planSection(baseline));
      assert.match(f.api.prompt.renderPrompt(replaced), /SYNTHETIC_REPLACED_OPERATOR_PROMPT/);
      assert.match(f.api.prompt.renderPrompt(replaced), /SYNTHETIC_EXECUTABLE_PLAN_GUIDANCE/);
      await read(agent);
      failed(await exit(agent), /no user-questions answerer/, "NO_PROVIDER");
      assertActive(agent);
      const remove = answerer(agent, approved);
      try {
        const result = await exit(agent);
        assert.equal(result.isError, false, f.text(result));
        assert.deepEqual(state(agent), { active: true, pending: false });
        assert.equal(
          planSection(await assemble()).text,
          "",
          "pending exit affects the proposed next assembly",
        );
        await preStep(agent, { kind: "enter", messages: [] });
        assert.deepEqual(state(agent), { active: false });
        assert.equal(planSection(await assemble()).text, "");
        await read(agent);
      } finally {
        remove();
        f.adapter.revert();
      }
      assert.deepEqual((await assemble()).tools, baseline.tools);
    });

    assert.equal(cases.length, 7, "every claimed scenario completed all assertions");
    await f.dispose();
    assert.deepEqual(dnsAttempts, []);
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      behaviorId: "CORE-MODES",
      status: "partial-official-isolation",
      target: "DSH desktop 0.2.1-rc.2",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      testResult: { tests: cases.length + 1, passed: cases.length + 1, failed: 0, skipped: 0 },
      ...f.evidence(),
      sourceDigests: [
        "tests/modes-execution-host.test.mjs",
        "tests/helpers/file-permissions-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/runtime.js",
        "src/host/permission-defaults.js",
      ].map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(join(projectRoot, path)))
          .digest("hex"),
      })),
      scenarios: cases,
      reviews,
      dnsAttempts,
      boundaries: {
        actualOfficialToolExecution: true,
        actualFilesystemRead: true,
        actualUserQuestionService: true,
        syntheticHumanAnswerer: true,
        actualPlanControllerAndSessionProjection: true,
        preStepDispatcher:
          "official agentEvents, manually driven with official enter/reject decisions",
        fullAgentLoopExecuted: false,
        ptcExecutorStarted: false,
        minimalShellStarted: false,
        completePresetsMounted: false,
      },
      limitations: [
        "Native and plan service paths were composed individually; no complete standard/minimal/PTC preset was activated.",
        "agent/pre-step was manually dispatched through official agentEvents; no AgentLoop driver, model, retry cycle or persisted Session was executed.",
        "The human review answerer was synthetic; desktop review UI, Gateway routing and user-question UI audit events were not exercised.",
        "PTC retains the prior sandbox-unavailable gap; no PTC runtime or subprocess was started in this regression.",
        "Minimal preset has no text-read tool and requires a real persistent shell; no shell/PTY was started here.",
        "No desktop installation/reload, real profile, real Session, network, DNS or subprocess was used; modified installed tool entries were hashed only.",
      ],
    };
    if (process.env.DSH_UNLIMIT_MODES_EXECUTION_EVIDENCE === "1")
      writeFileSync(
        join(projectRoot, "docs/evidence/modes-execution-acceptance.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
