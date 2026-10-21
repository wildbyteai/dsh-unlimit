import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);

test(
  "complete official standard preset loads through Registry and drives synthetic AgentLoop",
  {
    skip:
      selectedRoot && cache
        ? false
        : "Set both official runtime variables; no real profile is loaded",
    timeout: 45000,
  },
  async (t) => {
    const f = await presetFixture(t, selectedRoot, cache);
    const read = { name: "read", arguments: { file_path: f.sourceFile } };
    const sessions = [];
    const scenarios = [];
    const promptVerification = [];
    let originalPersona;
    const verifyRead = (agent, index = 0) => {
      const result = events(agent, "tool/result")[index];
      assert.equal(result.data.message.isError, false);
      assert.ok(text([result.data.message]).includes(f.content));
    };
    const capture = (agent) =>
      sessions.push({
        id: agent.id,
        requests: f.requests.filter((r) => r.sessionId === agent.id).length,
        toolCalls: events(agent, "tool/call").map((e) => e.data.name),
        persistedEvents: agent.session.snapshotEvents().length,
        preset: f.ctx.agentPresets.composedPreset(agent.ctx),
      });
    await t.test("STANDARD-NATIVE-READ-AND-ACTIVE-COMPOSITION", async () => {
      const agent = await f.create("native", [[read], "finish"]);
      const baseline = await f.unadaptedAssembly(agent);
      const personaSection = baseline.sections.find(
        (section) => section.name === f.api.prompt.PERSONA_PREFIX_SECTION,
      );
      assert.ok(personaSection);
      originalPersona = f.api.prompt.renderPrompt({ ...baseline, sections: [personaSection] });
      assert.ok(originalPersona.length > 0);
      await f.run(agent);
      verifyRead(agent);
      const observed = f.requests.filter((r) => r.sessionId === agent.id);
      assert.equal(observed.length, 2);
      assert.match(
        text(observed[0].messages.filter((m) => m.role === "system")),
        /SYNTHETIC_STANDARD_REPLACE_MARKER/,
      );
      assert.ok(
        !text(observed[0].messages.filter((m) => m.role === "system")).includes(originalPersona),
      );
      promptVerification.push({
        id: "STANDARD-PERSONA-REPLACED",
        section: personaSection.name,
        officialRenderedSha256: createHash("sha256").update(originalPersona).digest("hex"),
        result: "passed",
      });
      const names = observed[0].tools.map((tool) => tool.name);
      const expectedNames = [
        "read",
        "read_image",
        "write",
        "edit",
        "glob",
        "grep",
        "bash",
        "job_list",
        "job_output",
        "job_kill",
        "schedule_create",
        "schedule_list",
        "schedule_delete",
        "schedule_update",
        "skill",
        "get_goal",
        "create_goal",
        "update_goal",
        "exit_plan_mode",
        "subagent",
        "subagent_fork",
        "list_agents",
        "send_message",
        "interrupt_agent",
        "workflow",
        "ask_user_question",
        "todo_write",
        "web_search",
        "web_fetch",
        "present",
      ];
      assert.deepEqual(
        names.toSorted(),
        expectedNames.toSorted(),
        "The complete original standard preset must expose exactly the official native catalog",
      );
      assert.equal(f.composition.rows.find((r) => r.entryId.endsWith("tool-pwsh")).enabled, false);
      assert.equal(
        f.composition.rows.find((r) => r.entryId.endsWith("tool-plugin-manager")).enabled,
        false,
      );
      assert.equal(
        f.composition.rows.find((r) => r.entryId.endsWith("tool-plugin-market")).enabled,
        false,
      );
      capture(agent);
      scenarios.push({ id: "STANDARD-NATIVE-READ-AND-ACTIVE-COMPOSITION", result: "passed" });
    });
    await t.test("STANDARD-ISOLATED-PLAN-REVIEW", async () => {
      const exit = {
        name: "exit_plan_mode",
        arguments: { plan: "# Synthetic standard plan\nRead the disposable evidence and finish." },
      };
      const agent = await f.create("plan", [[read], [exit, read], [read], "finish"]);
      const controller = f.ctx.agentPresets.serviceFor(agent, "planMode");
      assert.ok(controller);
      assert.equal(f.ctx.get("planMode"), undefined, "Plan service is isolated inside the preset");
      assert.equal(controller.set(agent, true), "committed");
      const original = await f.unadaptedAssembly(agent);
      const shippedGuidance = f.definition.plugins
        .find((row) => row.id === "planning")
        .config.find((row) => row.id === "plan-mode").config.section;
      const planSection = original.sections.find((section) => section.text === shippedGuidance);
      assert.ok(
        planSection,
        "The plan instructions must come from the unchanged official declaration",
      );
      const replacement = await f.assemble(agent);
      assert.deepEqual(
        replacement.sections.find((section) => section.name === planSection.name),
        planSection,
        "Replace must preserve the real preset's complete plan section",
      );
      const renderedPlan = f.api.prompt.renderPrompt({ ...original, sections: [planSection] });
      let reviews = 0;
      const remove = agent.ctx.on("user-questions/request", (request) => {
        assert.equal(request.agent, agent);
        const question = request.questions[0];
        assert.equal(question.intent.kind, "plan-review");
        reviews++;
        return { answers: [{ id: question.id, selected: [question.intent.approve] }] };
      });
      try {
        await f.run(agent);
        assert.equal(reviews, 1);
        for (const i of [0, 2, 3]) verifyRead(agent, i);
        assert.deepEqual(
          f.requests.filter((r) => r.sessionId === agent.id).map((r) => r.plan.active),
          [true, true, false, false],
        );
        assert.deepEqual(
          f.requests
            .filter((r) => r.sessionId === agent.id)
            .map((r) => text(r.messages.filter((m) => m.role === "system")).includes(renderedPlan)),
          [true, true, false, false],
        );
        promptVerification.push({
          id: "STANDARD-PLAN-SECTION-PRESERVED",
          section: planSection.name,
          officialRenderedSha256: createHash("sha256").update(renderedPlan).digest("hex"),
          result: "passed",
        });
        assert.deepEqual(
          events(agent, "plan/mode").map((e) => e.data.active),
          [true, false],
        );
        assert.equal(events(agent, "tool/result")[1].data.message.isError, false);
        capture(agent);
        scenarios.push({ id: "STANDARD-ISOLATED-PLAN-REVIEW", result: "passed" });
      } finally {
        remove();
      }
    });
    await t.test("STANDARD-REVERT-RETAINS-PRESET", async () => {
      f.adapter.revert();
      const agent = await f.create("restored", [[read], "finish"]);
      await f.run(agent);
      verifyRead(agent);
      const observed = f.requests.filter((r) => r.sessionId === agent.id);
      assert.doesNotMatch(
        text(observed[0].messages.filter((m) => m.role === "system")),
        /SYNTHETIC_STANDARD_REPLACE_MARKER/,
      );
      assert.ok(
        text(observed[0].messages.filter((m) => m.role === "system")).includes(originalPersona),
        "Revert restores the original official scoped persona rendered by the official prompt service",
      );
      promptVerification.push({
        id: "STANDARD-PERSONA-RESTORED",
        section: f.api.prompt.PERSONA_PREFIX_SECTION,
        officialRenderedSha256: createHash("sha256").update(originalPersona).digest("hex"),
        result: "passed",
      });
      assert.deepEqual(observed[0].tools, f.requests[0].tools);
      capture(agent);
      scenarios.push({ id: "STANDARD-REVERT-RETAINS-PRESET", result: "passed" });
    });
    assert.equal(scenarios.length, 3);
    assert.deepEqual(f.errors, []);
    for (const request of f.requests) assert.deepEqual(request.tools, f.requests[0].tools);
    await f.dispose();
    if (process.env.DSH_UNLIMIT_PRESETS_EVIDENCE === "1") {
      const paths = [
        "tests/presets-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "tests/fixtures/official-preset-packages.json",
        "src/host/runtime.js",
        "src/host/native-instructions.js",
        "src/host/permission-defaults.js",
        "src/host/prompt-refresh.js",
      ];
      const schemas = {
        sha256: createHash("sha256").update(JSON.stringify(f.requests[0].tools)).digest("hex"),
        names: f.requests[0].tools.map((tool) => tool.name),
        count: f.requests[0].tools.length,
        allRequestsIdentical: true,
      };
      writeFileSync(
        join(presetProjectRoot, "docs/evidence/presets-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            behaviorId: "CORE-MODES",
            generatedAt: new Date().toISOString(),
            node: process.version,
            platform: { os: process.platform, arch: process.arch },
            ...f.evidence(),
            scenarios,
            sessions,
            schemas,
            promptVerification,
            testResult: { tests: 4, passed: 4, failed: 0, skipped: 0 },
            calls: {
              syntheticModelRequests: f.requests.length,
              agentLoopToolCalls: sessions.reduce((sum, row) => sum + row.toolCalls.length, 0),
              directToolRuntimeCalls: 0,
              byTool: sessions
                .flatMap((row) => row.toolCalls)
                .reduce((counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }), {}),
            },
            sourceDigests: paths.map((path) => ({
              path,
              sha256: createHash("sha256")
                .update(readFileSync(join(presetProjectRoot, path)))
                .digest("hex"),
            })),
            boundaries: {
              completeStandardPresetMounted: true,
              actualOfficialLoader: true,
              actualOfficialRegistry: true,
              actualAgentLoop: true,
              actualOfficialFilesystemRead: true,
              actualJsonlReadback: true,
              syntheticReviewAnswerer: true,
              minimalOrPtcExecuted: false,
              realDesktopExecuted: false,
              otherDeclaredToolsExecuted: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
