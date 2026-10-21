// Explicit fixed-backend acceptance; never part of automatic npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { presetFixture, presetProjectRoot } from "../tests/helpers/preset-fixture.mjs";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const initialEnvironmentNames = Object.keys(process.env).sort();
delete process.env.__CF_USER_TEXT_ENCODING;
assert.equal(process.execPath, NODE);
assert.equal(process.version, "v24.21.0");
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.deepEqual(process.execArgv, ["--expose-internals"]);
assert.deepEqual(process.argv.slice(2), []);
assert.deepEqual(Object.keys(process.env).sort(), ["DSH_UNLIMIT_RUNTIME", "PATH"]);
assert.equal(process.env.PATH, "/usr/bin:/bin");
assert.equal(process.env.DSH_UNLIMIT_RUNTIME, INSTALLED);
assert.equal(realpathSync(INSTALLED), INSTALLED);
assert.equal(
  hash(readFileSync(join(INSTALLED, "desktop-runtime.json"))),
  "3b264f1d9d4d3dc01e37aa382b2575a9dda6e34480af04982921b7d7720f0ef0",
);
const sourceDigests = [
  "scripts/probe-ptc-plan.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/ptc-process-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/native-instructions.js",
  "src/host/permission-defaults.js",
  "src/host/prompt-refresh.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
const PLAN_INSTRUCTION =
  "SYNTHETIC_PLAN_ONLY: present the complete disposable-file reading plan for explicit review; do not implement it in this turn.";
const IMPLEMENT_INSTRUCTION =
  "SYNTHETIC_IMPLEMENT_APPROVED_PLAN: now implement the approved plan by reading the disposable evidence file and reporting its content.";
let completedEvidence;
// node:test can discover asynchronous failures after a test body has returned.
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/ptc-plan-acceptance.json"),
      completedEvidence,
    );
});

test(
  "complete official PTC preset reviews a plan before later explicit implementation",
  {
    timeout: 45000,
  },
  async (t) => {
    const f = await presetFixture(
      t,
      INSTALLED,
      join(presetProjectRoot, "artifacts/official-packages"),
      {
        presetId: "ptc",
        ptcExecution: true,
      },
    );
    assert.equal(typeof f.ptc.reviewProgram, "string");
    assert.match(f.ptc.reviewPlan, /^#\s+\S/);
    const reviewCall = {
      name: "run_code",
      arguments: {
        code: f.ptc.reviewProgram,
        description: "Present the complete synthetic plan for explicit human review only.",
        timeoutMs: 3000,
      },
    };
    const readCall = {
      name: "run_code",
      arguments: {
        code: f.ptc.program,
        description:
          "Implement the approved synthetic plan by reading its disposable evidence file.",
        timeoutMs: 3000,
      },
    };
    const agent = await f.create("plan", [[reviewCall], "finish"]);
    const controller = f.ctx.agentPresets.serviceFor(agent, "planMode");
    assert.ok(controller, "The original retained PTC revision must provide planMode");
    assert.equal(f.ctx.get("planMode"), undefined);
    assert.equal(controller.set(agent, true), "committed");
    const original = await f.unadaptedAssembly(agent);
    const personaSection = original.sections.find(
      (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
    );
    assert.ok(personaSection);
    const persona = f.api.prompt.renderPrompt({ ...original, sections: [personaSection] });
    assert.ok(persona.length > 0);
    const baselineTools = structuredClone(original.tools);
    assert.deepEqual(
      baselineTools.map((tool) => tool.name),
      ["run_code"],
    );
    const sdkSchemas = structuredClone(f.ctx.tools.sdkSchemas(agent));
    for (const name of ["read", "exit_plan_mode"])
      assert.ok(sdkSchemas.some((schema) => schema.name === name));
    const shippedGuidance = f.definition.plugins
      .find((row) => row.id === "planning")
      .config.find((row) => row.id === "plan-mode").config.section;
    const planSection = original.sections.find((section) => section.text === shippedGuidance);
    assert.ok(planSection, "Plan guidance comes from the unchanged complete official declaration");
    const renderedPlan = f.api.prompt.renderPrompt({ ...original, sections: [planSection] });
    const replaced = await f.assemble(agent);
    const functionalSections = new Map();
    for (const name of ["tools:ptc-only", "tools:sdk", planSection.name]) {
      const section = original.sections.find((s) => s.name === name);
      assert.ok(section?.text.length > 0);
      assert.deepEqual(
        replaced.sections.find((s) => s.name === name),
        section,
      );
      functionalSections.set(name, f.api.prompt.renderPrompt({ ...original, sections: [section] }));
    }
    assert.deepEqual(replaced.tools, baselineTools);
    const resultStates = [],
      reviews = [],
      scenarios = [],
      turns = [];
    const removeObserve = f.ctx.on("session/event", (session, event) => {
      if (session === agent.session && event.type === "tool/result")
        resultStates.push({
          seq: event.seq,
          callId: event.data.message.toolCallId,
          plan: structuredClone(controller.get(agent)),
        });
    });
    const run = async (instruction) => {
      const before = f.requests.length;
      agent.followup(
        f.api.llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: instruction }],
        }),
      );
      await agent.whenIdle();
      assert.equal(agent.status, "idle");
      assert.equal(events(agent, "turn/end").at(-1).data.reason.kind, "completed");
      assert.equal(f.requests.length, before + 2);
      assert.ok(
        f.requests[before].messages.some((m) => m.role === "user" && text([m]) === instruction),
      );
      await f.ctx.sessionPersistence.flush();
      const reader = await f.ctx.sessionPersistence.open(agent.id, "read");
      try {
        assert.deepEqual((await reader.read()).events, agent.session.snapshotEvents());
      } finally {
        await reader.close();
      }
      turns.push({
        instruction,
        turn: events(agent, "turn/end").at(-1).data.turn,
        requestSteps: f.requests.slice(before).map((r) => r.step),
        actualOfficialReaderEventsEqual: true,
      });
    };
    const verifyCall = (index, expected, name, args) => {
      const call = events(agent, "tool/call")[index];
      const start = events(agent, "tool/ptc-dispatch-start")[index];
      const dispatch = events(agent, "tool/ptc-dispatch")[index];
      const result = events(agent, "tool/result")[index];
      assert.equal(call.data.name, "run_code");
      assert.deepEqual(JSON.parse(call.data.arguments), expected.arguments);
      for (const event of [start, dispatch]) {
        assert.equal(event.data.name, name);
        assert.equal(event.data.parentCallId, call.data.callId);
        assert.equal(event.data.rootCallId, call.data.callId);
        assert.deepEqual(event.data.arguments, args);
      }
      assert.equal(start.data.subCallId, dispatch.data.subCallId);
      assert.ok(start.data.subCallId.startsWith(call.data.callId + ":ptc:"));
      assert.equal(result.data.message.toolCallId, call.data.callId);
      assert.equal(dispatch.data.isError, false);
      assert.equal(result.data.message.isError, false, text([result.data.message]));
      assert.ok(call.seq < start.seq && start.seq < dispatch.seq && dispatch.seq < result.seq);
      const returned = JSON.parse(text([result.data.message]));
      assert.deepEqual(returned.networkAndSpawnAttempts, []);
      assert.deepEqual(returned.environmentNames, []);
      return { call, start, dispatch, result, returned };
    };
    try {
      await t.test("PTC-PLAN-EXPLICIT-REVIEW-AND-NEXT-STEP", async () => {
        const removeReview = agent.ctx.on("user-questions/request", (request) => {
          assert.equal(request.agent, agent);
          assert.equal(request.agent.session, agent.session);
          assert.equal(request.questions.length, 1);
          assert.ok(request.signal && !request.signal.aborted);
          const question = request.questions[0];
          assert.equal(question.intent.kind, "plan-review");
          assert.equal(question.detail, f.ptc.reviewPlan);
          assert.ok(question.options.some((option) => option.label === question.intent.approve));
          const start = events(agent, "tool/ptc-dispatch-start").at(-1);
          assert.equal(start.data.name, "exit_plan_mode");
          assert.equal(question.intent.callId, start.data.subCallId);
          assert.deepEqual(controller.get(agent), { active: true });
          assert.equal(f.requests.length, 1);
          assert.deepEqual(
            events(agent, "plan/mode").map((e) => e.data.active),
            [true],
          );
          const answer = { answers: [{ id: question.id, selected: [question.intent.approve] }] };
          reviews.push({
            sessionId: agent.id,
            exactLiveAgentAndSession: true,
            questionId: question.id,
            detail: question.detail,
            intent: structuredClone(question.intent),
            answer: structuredClone(answer),
            plan: structuredClone(controller.get(agent)),
          });
          return answer;
        });
        try {
          await f.ptc.run(() => run(PLAN_INSTRUCTION));
        } finally {
          removeReview();
        }
        assert.equal(reviews.length, 1);
        const review = verifyCall(0, reviewCall, "exit_plan_mode", { plan: f.ptc.reviewPlan });
        assert.deepEqual(review.returned.value, { approved: true });
        assert.deepEqual(resultStates[0].plan, { active: true, pending: false });
        assert.equal(resultStates[0].callId, review.call.data.callId);
        assert.equal(resultStates[0].seq, review.result.seq);
        assert.deepEqual(
          f.requests.map((r) => r.plan),
          [{ active: true }, { active: false }],
        );
        assert.deepEqual(
          events(agent, "plan/mode").map((e) => e.data.active),
          [true, false],
        );
        const transition = events(agent, "plan/mode")[1];
        const nextStep = events(agent, "step/start")[1];
        assert.ok(review.result.seq < transition.seq && transition.seq < nextStep.seq);
        assert.equal(nextStep.data.step, f.requests[1].step);
        assert.deepEqual(
          f.requests[1].messages.filter((m) => m.role === "tool"),
          [review.result.data.message],
        );
        assert.deepEqual(controller.get(agent), { active: false });
        assert.deepEqual(events(agent, "approval/asked"), []);
        for (const [index, request] of f.requests.entries()) {
          const system = text(request.messages.filter((m) => m.role === "system"));
          assert.ok(system.includes(f.settings.prompt));
          assert.equal(system.includes(persona), false);
          assert.equal(system.includes(renderedPlan), index === 0);
        }
        assert.equal(f.evidence().isolation.syntheticSourceReads.length, 0);
        scenarios.push({ id: "PTC-PLAN-EXPLICIT-REVIEW-AND-NEXT-STEP", result: "passed" });
      });
      assert.equal(scenarios.length, 1);
      await t.test("PTC-APPROVED-IMPLEMENTATION-AFTER-REVERT", async () => {
        f.adapter.revert();
        assert.deepEqual(controller.get(agent), { active: false });
        const restored = await f.assemble(agent);
        assert.deepEqual(restored.tools, baselineTools);
        assert.deepEqual(f.ctx.tools.sdkSchemas(agent), sdkSchemas);
        for (const name of ["tools:ptc-only", "tools:sdk"]) {
          const section = restored.sections.find((s) => s.name === name);
          assert.ok(section);
          assert.equal(
            f.api.prompt.renderPrompt({ ...restored, sections: [section] }),
            functionalSections.get(name),
          );
        }
        f.script(agent.id, [[readCall], "finish"]);
        await f.ptc.run(() => run(IMPLEMENT_INSTRUCTION));
        const read = verifyCall(1, readCall, "read", { file_path: f.sourceFile });
        assert.equal(read.returned.value.path, f.sourceFile);
        assert.deepEqual(read.returned.value.lines, [{ number: 1, text: f.content }]);
        assert.deepEqual(resultStates[1].plan, { active: false });
        assert.equal(resultStates[1].callId, read.call.data.callId);
        assert.deepEqual(
          f.requests[3].messages.filter((m) => m.role === "tool"),
          events(agent, "tool/result").map((e) => e.data.message),
        );
        for (const request of f.requests.slice(2)) {
          const system = text(request.messages.filter((m) => m.role === "system"));
          assert.ok(system.includes(persona));
          assert.equal(system.includes(f.settings.prompt), false);
          assert.equal(system.includes(renderedPlan), false);
          assert.deepEqual(request.plan, { active: false });
        }
        assert.deepEqual(
          events(agent, "plan/mode").map((e) => e.data.active),
          [true, false],
        );
        assert.equal(f.evidence().isolation.syntheticSourceReads.length, 1);
        scenarios.push({ id: "PTC-APPROVED-IMPLEMENTATION-AFTER-REVERT", result: "passed" });
      });
      assert.equal(scenarios.length, 2);
      assert.equal(f.requests.length, 4);
      assert.equal(events(agent, "turn/start").length, 2);
      assert.equal(events(agent, "turn/end").length, 2);
      for (const type of [
        "tool/call",
        "tool/ptc-dispatch-start",
        "tool/ptc-dispatch",
        "tool/result",
      ])
        assert.equal(events(agent, type).length, 2);
      assert.deepEqual(f.errors, []);
      for (const request of f.requests) {
        assert.deepEqual(request.tools, baselineTools);
        const system = text(request.messages.filter((m) => m.role === "system"));
        for (const name of ["tools:ptc-only", "tools:sdk"])
          assert.ok(system.includes(functionalSections.get(name)));
      }
      assert.deepEqual(f.ctx.tools.sdkSchemas(agent), sdkSchemas);
    } finally {
      removeObserve();
    }
    const logs = join(f.directory, "logs");
    const paths = readdirSync(logs, { recursive: true }).filter(
      (path) => path.endsWith(".jsonl") && path.split(sep).includes(agent.id),
    );
    assert.equal(paths.length, 1);
    const bytes = readFileSync(join(logs, paths[0]));
    const physical = bytes
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const journal = agent.session.snapshotEvents();
    assert.equal(physical.length, journal.length + 1);
    assert.deepEqual(physical.slice(1), journal);
    const associations = [reviewCall, readCall].map((call, index) => {
      const result = events(agent, "tool/result")[index];
      const start = events(agent, "tool/ptc-dispatch-start")[index];
      const dispatch = events(agent, "tool/ptc-dispatch")[index];
      return {
        call: events(agent, "tool/call")[index],
        programSha256: hash(call.arguments.code),
        start,
        dispatch: {
          seq: dispatch.seq,
          data: { ...dispatch.data, content: undefined },
          contentSha256: hash(JSON.stringify(dispatch.data.content)),
        },
        result: {
          seq: result.seq,
          callId: result.data.message.toolCallId,
          messageSha256: hash(JSON.stringify(result.data.message)),
          returned: JSON.parse(text([result.data.message])),
        },
      };
    });
    // Keep exact arguments in local assertions; publish hashes instead of program source.
    for (const row of associations)
      row.call = { seq: row.call.seq, callId: row.call.data.callId, name: row.call.data.name };
    await f.dispose();
    const fixtureEvidence = f.evidence();
    assert.equal(fixtureEvidence.isolation.ptcBackend.launches.length, 2);
    assert.equal(fixtureEvidence.isolation.rootsRemoved, true);
    assert.deepEqual(fixtureEvidence.isolation.cleanupErrors, []);
    for (const row of sourceDigests)
      assert.equal(hash(readFileSync(join(presetProjectRoot, row.path))), row.sha256);
    completedEvidence =
      JSON.stringify(
        {
          schemaVersion: 1,
          behaviorId: "CORE-MODES",
          developmentBasis: "c49d982ed6b5607ad1ac6d223e58019011a16259",
          generatedAt: new Date().toISOString(),
          node: process.version,
          platform: { os: process.platform, arch: process.arch },
          initialEnvironmentNames,
          ...fixtureEvidence,
          scenarios,
          session: {
            id: agent.id,
            turns,
            reviews,
            resultStates,
            associations,
            persistedEvents: journal.length,
            physicalJsonlRows: physical.length,
            jsonlSha256: hash(bytes),
            allPhysicalEventsEqual: true,
            modeAndStepEvents: journal.filter((e) =>
              ["plan/mode", "turn/start", "step/start", "step/end", "turn/end"].includes(e.type),
            ),
          },
          requests: f.requests.map((r) => ({
            sessionId: r.sessionId,
            step: r.step,
            plan: r.plan,
            messagesSha256: hash(JSON.stringify(r.messages)),
            toolsSha256: hash(JSON.stringify(r.tools)),
          })),
          prompts: {
            personaSha256: hash(persona),
            planSectionSha256: hash(renderedPlan),
            functionalSections: [...functionalSections].map(([name, rendered]) => ({
              name,
              sha256: hash(rendered),
            })),
            replaceDuringReviewAndNextStep: true,
            revertedBeforeExplicitImplementation: true,
          },
          schemas: {
            names: baselineTools.map((tool) => tool.name),
            sha256: hash(JSON.stringify(baselineTools)),
            sdkSha256: hash(JSON.stringify(sdkSchemas)),
            sdkNames: sdkSchemas.map((s) => s.name),
            allRequestsIdentical: true,
          },
          programs: {
            reviewSha256: hash(reviewCall.arguments.code),
            readSha256: hash(readCall.arguments.code),
          },
          calls: {
            syntheticModelRequests: 4,
            agentLoopRunCode: 2,
            officialPtcPlanReview: 1,
            officialPtcRead: 1,
            syntheticHumanReviews: 1,
            directToolRuntimeCalls: 0,
          },
          sourceDigests,
          boundaries: {
            completeOriginalPtcPreset: true,
            actualOfficialAgentLoop: true,
            actualOfficialUserQuestions: true,
            actualOfficialPtcBackend: true,
            actualNextPreStepCommit: true,
            actualJsonlReadback: true,
            syntheticModelResponsesAndHumanAnswer: true,
            realUserApprovalVerified: false,
            realModelOrDesktopExecuted: false,
            originalSeatbeltProfileUnmodified: true,
            kernelReadAndNetworkWhitelist: false,
            rejectionCancellationOrOtherToolsVerified: false,
          },
          testResult: { tests: 3, passed: 3, failed: 0, skipped: 0 },
          result: "passed",
        },
        null,
        2,
      )
        .replaceAll(f.directory, "<synthetic-root>")
        .replaceAll(f.runtime.root, "<clean-runtime>")
        .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>") + "\n";
    assert.ok(!completedEvidence.includes("/Users/"));
  },
);
