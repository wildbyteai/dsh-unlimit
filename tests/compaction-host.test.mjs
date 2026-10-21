import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { ReadLimits } from "../src/host/read-limits.js";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const text = (message) =>
  message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
const originals = (agent) => events(agent, "tool/result").filter((e) => e.surfaceOp === "append");
const rows = (message) => [...text(message).matchAll(/^\d+: (.*)$/gm)].map((m) => m[1]);
const PROVIDER = "synthetic-pressure-offline";
const CONTEXT = 100000;
const SUMMARY =
  "SYNTHETIC_PRESSURE_CHECKPOINT: earlier disposable file reads completed; continue the explicitly scripted task.";
let completedEvidence;
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/compaction-acceptance.json"),
      completedEvidence,
    );
});

test(
  "official pressure pruning and summary preserve durable results and plugin restoration",
  {
    skip:
      selectedRoot && cache ? false : "Set both official runtime variables; no profile is loaded",
    timeout: 45000,
  },
  async (t) => {
    const f = await presetFixture(t, selectedRoot, cache);
    const requests = [],
      summaries = [],
      handles = [],
      bindings = [],
      executions = [],
      scenarios = [];
    const scripts = new Map();
    const settings = { readLimit: 131072 };
    const limits = new ReadLimits(
      f.ctx,
      {
        dispatch: (action) => {
          assert.equal(action, "settings.get");
          return { value: settings };
        },
      },
      f.runtime.host,
    );
    class SyntheticPressureAdapter extends f.api.llm.LlmAdapter {
      async resolveModel(provider, model, signal) {
        return {
          ...(await super.resolveModel(provider, model, signal)),
          context: { contextWindow: CONTEXT },
        };
      }
      async *stream(request) {
        const agent = f.ctx.agents.get(request.sessionId);
        assert.ok(agent);
        if (request.purpose === "compaction") {
          const prefix = request.messages.slice(0, -1);
          assert.deepEqual(prefix, agent.session.deriveMessages().slice(0, prefix.length));
          assert.equal(request.messages.at(-1).role, "user");
          assert.equal(request.tools.length, 30);
          assert.ok(text(prefix[0]).includes(f.settings.prompt));
          summaries.push({
            sessionId: agent.id,
            request: structuredClone({
              messages: request.messages,
              tools: request.tools,
              maxTokens: request.maxTokens,
            }),
            measurement: structuredClone(f.ctx.tokenMeter.measure(agent.session)),
            start: structuredClone(events(agent, "compaction/start").at(-1)),
          });
          yield { type: "text-delta", index: 0, text: SUMMARY };
          yield { type: "finish", reason: { kind: "stop" } };
          return;
        }
        assert.deepEqual(request.messages, agent.session.deriveMessages());
        const actions = scripts.get(agent.id);
        assert.ok(actions?.length, "Every conversation response is explicitly scripted");
        requests.push({
          sessionId: agent.id,
          messages: structuredClone(request.messages),
          tools: structuredClone(request.tools),
          surface: [...agent.session.surface.nodes],
          measurement: structuredClone(f.ctx.tokenMeter.measure(agent.session)),
        });
        const action = actions.shift();
        if (action === "finish")
          yield { type: "text-delta", index: 0, text: "SYNTHETIC_PRESSURE_DONE" };
        else
          yield {
            type: "tool-call-delta",
            index: 0,
            id: `${agent.id}-read-${requests.length}`,
            name: "read",
            argumentsDelta: JSON.stringify({ file_path: action }),
          };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    const unregister = f.ctx.llm.registerAdapter([PROVIDER], new SyntheticPressureAdapter());
    const observe = f.ctx.on(
      "tools/pre-execute",
      (execution, next) => {
        if (execution.name === "read")
          executions.push({ sessionId: execution.agent.id, callId: execution.callId });
        return next();
      },
      { global: true },
    );
    const create = async (suffix) => {
      const handle = await f.ctx.agents.create({
        sessionId: `synthetic-pressure-${suffix}`,
        meta: { cwd: f.workspace, agentPreset: "standard" },
        agentOptions: { provider: PROVIDER, model: "synthetic-context-100000", maxTokens: 128 },
        setup: async (ctx) => {
          await f.ctx.agentPresets.mount(ctx, "standard");
        },
      });
      handles.push(handle);
      const agent = handle.agent;
      const lease = await f.ctx.agentPresets.acquireScope("standard");
      try {
        assert.equal(f.api.scope.scopeParentOf(f.api.scope.scopeOf(agent.ctx)), lease.key);
      } finally {
        await lease[Symbol.asyncDispose]();
      }
      const composition = f.ctx.agentPresets.inspectCompositions(agent.ctx);
      assert.equal(composition.length, 1);
      assert.deepEqual(composition[0].leakedServices, []);
      const compaction = f.ctx.agentPresets.serviceFor(agent, "compaction");
      const pruner = f.ctx.agentPresets.serviceFor(agent, "toolResultPruner");
      assert.ok(compaction && pruner);
      assert.equal(f.ctx.get("compaction"), undefined);
      assert.equal(f.ctx.get("toolResultPruner"), undefined);
      assert.deepEqual(pruner.config, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
      assert.equal(compaction.config.auto, true);
      assert.equal(compaction.config.headroomTokens, 65536);
      assert.equal(compaction.config.thresholdRatio, 0.8);
      assert.equal(compaction.config.retainRatio, 0.16);
      bindings.push({
        sessionId: agent.id,
        exactRetainedScopeIdentity: true,
        compaction: structuredClone(compaction.config),
        pruner: structuredClone(pruner.config),
      });
      return agent;
    };
    const run = async (agent, actions) => {
      scripts.set(agent.id, [...actions]);
      agent.followup(
        f.api.llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "SYNTHETIC_AUTHORIZED_READ_ONLY_PRESSURE_TASK" }],
        }),
      );
      await agent.whenIdle();
      assert.equal(agent.status, "idle");
      assert.deepEqual(scripts.get(agent.id), []);
      assert.equal(events(agent, "turn/end").at(-1).data.reason.kind, "completed");
      await f.ctx.sessionPersistence.flush();
      const reader = await f.ctx.sessionPersistence.open(agent.id, "read");
      try {
        assert.deepEqual((await reader.read()).events, agent.session.snapshotEvents());
      } finally {
        await reader.close();
      }
    };
    const scenario = (name, action) =>
      t.test(name, async () => {
        try {
          await action();
        } catch (error) {
          console.error(error);
          throw error;
        }
      });
    const large = {
      path: join(f.workspace, "large.txt"),
      body:
        "PRUNE_HEAD\n" +
        ("SYNTHETIC_ORIGINAL_" + "x".repeat(76) + "\n").repeat(1300) +
        "PRUNE_TAIL",
    };
    const small = {
      path: join(f.workspace, "small.txt"),
      body:
        "COMPACT_HEAD\n" + ("SYNTHETIC中🧭_" + "a".repeat(100) + "\n").repeat(50) + "COMPACT_TAIL",
    };
    for (const file of [large, small]) writeFileSync(file.path, file.body);
    assert.ok(Buffer.byteLength(large.body) < settings.readLimit);
    assert.ok(Buffer.byteLength(small.body) < 8192);
    const entry = limits.target().entry;
    const originalConfig = structuredClone(entry.fiber.config);
    const raw = entry.options.config,
      rawText = JSON.stringify(raw);
    let pruneAgent, compactAgent, persona, originalSchemas;
    try {
      pruneAgent = await create("prune");
      compactAgent = await create("summary");
      const originalAssembly = await f.unadaptedAssembly(compactAgent);
      const section = originalAssembly.sections.find(
        (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
      );
      assert.ok(section);
      persona = f.api.prompt.renderPrompt({ ...originalAssembly, sections: [section] });
      originalSchemas = structuredClone(originalAssembly.tools);
      await scenario("PRESSURE-PRUNES-MODEL-SURFACE-BUT-PRESERVES-ORIGINAL-LOG", async () => {
        await limits.apply();
        await run(pruneAgent, [large.path, "finish"]);
        const original = originals(pruneAgent);
        assert.equal(original.length, 1);
        assert.equal(original[0].data.message.isError, false);
        assert.deepEqual(rows(original[0].data.message), large.body.split("\n"));
        const prunes = events(pruneAgent, "compaction/prune");
        assert.equal(prunes.length, 1);
        assert.deepEqual(prunes[0].data.shadowedSeqs, [original[0].seq]);
        assert.equal(events(pruneAgent, "compaction/summary").length, 0);
        const replacements = events(pruneAgent, "tool/result").filter(
          (e) => e.surfaceOp?.op === "replace",
        );
        assert.equal(replacements.length, 1);
        const replacement = replacements[0];
        assert.deepEqual(replacement.sourceEventSeqs, [original[0].seq]);
        assert.deepEqual(replacement.surfaceOp, {
          op: "replace",
          startSeq: original[0].seq,
          endSeq: original[0].seq,
        });
        assert.deepEqual(
          { ...replacement.data.message, content: original[0].data.message.content },
          original[0].data.message,
        );
        const content = text(replacement.data.message);
        assert.ok(content.includes("PRUNE_HEAD") && content.includes("PRUNE_TAIL"));
        assert.ok(Array.from(content).length <= 8192);
        assert.ok(content.length < text(original[0].data.message).length);
        assert.deepEqual(
          requests
            .filter((r) => r.sessionId === pruneAgent.id)[1]
            .messages.filter((m) => m.role === "tool"),
          [replacement.data.message],
        );
        scenarios.push({
          id: "PRESSURE-PRUNES-MODEL-SURFACE-BUT-PRESERVES-ORIGINAL-LOG",
          originalBytes: Buffer.byteLength(text(original[0].data.message)),
          visibleCodePoints: Array.from(content).length,
          originalSeq: original[0].seq,
          replacementSeq: replacement.seq,
          result: "passed",
        });
      });
      assert.equal(scenarios.length, 1);
      await scenario("PRESSURE-SUMMARY-USES-REAL-METER-AND-BALANCED-TOOL-HISTORY", async () => {
        settings.readLimit = 8192;
        await limits.apply();
        await run(compactAgent, [...Array(30).fill(small.path), "finish"]);
        const original = originals(compactAgent);
        assert.equal(original.length, 30);
        for (const event of original) {
          assert.equal(event.data.message.isError, false);
          assert.deepEqual(rows(event.data.message), small.body.split("\n"));
          assert.ok(Array.from(text(event.data.message)).length < 8192);
        }
        assert.deepEqual(events(compactAgent, "compaction/prune"), []);
        const summariesHere = events(compactAgent, "compaction/summary");
        assert.ok(summariesHere.length > 0, "Real pressure must trigger official summarization");
        assert.equal(summariesHere.length, summaries.length);
        assert.equal(events(compactAgent, "compaction/start").length, summariesHere.length);
        assert.equal(events(compactAgent, "compaction/end").length, summariesHere.length);
        for (const [index, event] of summariesHere.entries()) {
          assert.equal(event.data.llmStreamCall, true);
          assert.deepEqual(event.data.summary, [{ type: "text", text: SUMMARY }]);
          assert.deepEqual(event.data.rawOutput, event.data.summary);
          assert.equal(event.data.compactionId, summaries[index].start.data.compactionId);
          assert.ok(summaries[index].measurement.totalTokens >= 34336);
          assert.equal(summaries[index].measurement.baseline.kind, "estimated");
          assert.ok(event.data.shadowedTokenCount > 0);
          assert.ok(event.data.shadowedSeqs.some((seq) => original.some((row) => row.seq === seq)));
          assert.equal(events(compactAgent, "compaction/end")[index].data.error, undefined);
          assert.equal(
            events(compactAgent, "compaction/end")[index].data.compactionId,
            event.data.compactionId,
          );
          const checkpoint = compactAgent.session.eventAt(event.seq + 1);
          assert.equal(checkpoint.type, "user/message");
          assert.deepEqual(checkpoint.surfaceOp, {
            op: "replace",
            startSeq: event.data.shadowedRange.start,
            endSeq: event.data.shadowedRange.end,
          });
          assert.deepEqual(checkpoint.sourceEventSeqs, [
            summaries[index].start.seq,
            event.seq,
            ...event.data.shadowedSeqs,
          ]);
          assert.ok(text(checkpoint.data).includes(SUMMARY));
        }
        for (const request of requests.filter((r) => r.sessionId === compactAgent.id)) {
          assert.ok(text(request.messages[0]).includes(f.settings.prompt));
          assert.equal(request.tools.length, 30);
          const calls = request.messages
            .filter((m) => m.role === "assistant")
            .flatMap((m) => m.content.filter((b) => b.type === "tool-call"));
          const results = request.messages.filter((m) => m.role === "tool");
          assert.equal(calls.length, results.length);
          for (const message of results) {
            assert.equal(calls.filter((call) => call.id === message.toolCallId).length, 1);
            assert.deepEqual(
              message,
              original.find((row) => row.data.message.toolCallId === message.toolCallId).data
                .message,
            );
          }
        }
        assert.ok(requests.at(-1).messages.some((m) => text(m).includes(SUMMARY)));
        assert.ok(requests.at(-1).messages.filter((m) => m.role === "tool").length < 30);
        scenarios.push({
          id: "PRESSURE-SUMMARY-USES-REAL-METER-AND-BALANCED-TOOL-HISTORY",
          originalReadResults: 30,
          summaries: summariesHere.length,
          visibleToolResults: requests.at(-1).messages.filter((m) => m.role === "tool").length,
          result: "passed",
        });
      });
      assert.equal(scenarios.length, 2);
      await scenario("REVERT-DOES-NOT-REVIVE-OFFICIAL-COMPACTED-HISTORY", async () => {
        const history = structuredClone(compactAgent.session.snapshotEvents());
        const surface = [...compactAgent.session.surface.nodes];
        const projected = structuredClone(compactAgent.session.deriveMessages());
        await limits.revert();
        f.adapter.revert();
        assert.deepEqual(compactAgent.session.snapshotEvents(), history);
        assert.deepEqual(compactAgent.session.surface.nodes, surface);
        assert.deepEqual(compactAgent.session.deriveMessages(), projected);
        assert.deepEqual(entry.fiber.config, originalConfig);
        assert.equal(entry.options.config, raw);
        assert.equal(JSON.stringify(raw), rawText);
        const before = requests.length;
        await run(compactAgent, [small.path, "finish"]);
        assert.deepEqual(requests[before].tools, originalSchemas);
        assert.ok(text(requests[before].messages[0]).includes(persona));
        assert.equal(text(requests[before].messages[0]).includes(f.settings.prompt), false);
        assert.ok(requests[before].messages.some((m) => text(m).includes(SUMMARY)));
        assert.deepEqual(rows(originals(compactAgent).at(-1).data.message), small.body.split("\n"));
        assert.equal(events(compactAgent, "compaction/summary").length, summaries.length);
        scenarios.push({
          id: "REVERT-DOES-NOT-REVIVE-OFFICIAL-COMPACTED-HISTORY",
          originalReadResults: originals(compactAgent).length,
          historyUnchangedByRevert: true,
          schemaRestored: true,
          result: "passed",
        });
      });
      assert.equal(scenarios.length, 3);
      assert.deepEqual(f.errors, []);
      assert.equal(f.requests.length, 0, "Only the dedicated synthetic provider was used");
      assert.equal(executions.length, 32);
      const otherSchemas = (tools) => tools.filter((tool) => tool.name !== "read");
      for (const request of [...requests, ...summaries.map((row) => row.request)])
        assert.deepEqual(otherSchemas(request.tools), otherSchemas(originalSchemas));
      for (const file of [large, small]) assert.equal(readFileSync(file.path, "utf8"), file.body);
      for (const agent of [pruneAgent, compactAgent]) {
        const calls = events(agent, "tool/call");
        assert.equal(calls.length, originals(agent).length);
        for (const call of calls)
          assert.equal(
            executions.filter((e) => e.sessionId === agent.id && e.callId === call.data.callId)
              .length,
            1,
          );
      }
    } finally {
      try {
        await limits.revert();
      } finally {
        observe();
        for (const handle of handles.reverse()) {
          await handle.agent.cancel({ kind: "user" });
          await handle.agent.whenIdle();
          await handle.dispose();
        }
        unregister();
      }
    }
    const sessionRecords = [];
    for (const agent of [pruneAgent, compactAgent]) {
      const filenames = readdirSync(join(f.directory, "logs"), { recursive: true }).filter(
        (p) => p.endsWith(".jsonl") && p.split(sep).includes(agent.id),
      );
      assert.equal(filenames.length, 1);
      const bytes = readFileSync(join(f.directory, "logs", filenames[0]));
      const physical = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      const journal = agent.session.snapshotEvents();
      for (const type of [
        "tool/call",
        "tool/result",
        "compaction/prune",
        "compaction/start",
        "compaction/summary",
        "compaction/end",
      ])
        assert.deepEqual(
          physical.filter((event) => event.type === type),
          journal.filter((event) => event.type === type),
        );
      sessionRecords.push({
        sessionId: agent.id,
        events: journal.length,
        physicalJsonlRows: physical.length,
        jsonlSha256: digest(bytes),
        originalResults: originals(agent).map((event) => ({
          seq: event.seq,
          callId: event.data.message.toolCallId,
          contentSha256: digest(JSON.stringify(event.data.message)),
          bytes: Buffer.byteLength(text(event.data.message)),
        })),
        pressureEvents: journal
          .filter((event) => event.type.startsWith("compaction/"))
          .map((event) => ({
            type: event.type,
            seq: event.seq,
            compactionId: event.data.compactionId,
            shadowedSeqs: event.data.shadowedSeqs,
            shadowedTokenCount: event.data.shadowedTokenCount,
          })),
        actualJsonlReadback: true,
      });
    }
    await f.dispose();
    if (process.env.DSH_UNLIMIT_COMPACTION_EVIDENCE === "1") {
      const sources = [
        "tests/compaction-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/read-limits.js",
        "src/host/runtime.js",
        "src/host/native-instructions.js",
      ];
      const evidence = {
        schemaVersion: 1,
        behaviorId: "CORE-RESULT",
        developmentBasis: "292ad7afad07f6da545c0a11e9cdf46d3817715e",
        generatedAt: new Date().toISOString(),
        node: process.version,
        ...f.evidence(),
        bindings,
        scenarios,
        sessions: sessionRecords,
        calls: {
          conversationRequests: requests.length,
          summaryRequests: summaries.length,
          agentLoopReadCalls: executions.length,
          directToolRuntimeCalls: 0,
        },
        model: {
          provider: PROVIDER,
          contextWindow: CONTEXT,
          conversationMaxTokens: 128,
          syntheticResponses: true,
          usageCountersProvided: false,
          pressureThresholdTokens: 34336,
          retainedTailTokens: 15979,
        },
        summaryRequests: summaries.map(({ sessionId, request, measurement }) => ({
          sessionId,
          purpose: "compaction",
          messagesSha256: digest(JSON.stringify(request.messages)),
          toolsSha256: digest(JSON.stringify(request.tools)),
          messageCount: request.messages.length,
          maxTokens: request.maxTokens,
          totalEstimatedTokens: measurement.totalTokens,
          baseline: measurement.baseline.kind,
        })),
        sourceDigests: sources.map((path) => ({
          path,
          sha256: digest(readFileSync(join(presetProjectRoot, path))),
        })),
        boundaries: {
          originalPresetAndCompactionPolicy: true,
          actualOfficialTokenMeter: true,
          automaticPressurePath: true,
          officialPrunerExecuted: true,
          officialSummaryTransactionExecuted: true,
          originalToolResultsRetainedInPhysicalJsonl: true,
          allOriginalToolResultsSentAfterCompaction: false,
          pluginRevertPreservesCompaction: true,
          summarySemanticQualityVerified: false,
          providerOverflowRecoveryVerified: false,
          realModelOrDesktopExecuted: false,
        },
        testResult: { tests: 4, passed: 4, failed: 0, skipped: 0 },
        result: "passed",
      };
      completedEvidence =
        JSON.stringify(evidence, null, 2)
          .replaceAll(f.runtime.root, "<clean-runtime>")
          .replaceAll(f.directory, "<synthetic-root>")
          .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>") + "\n";
      assert.ok(!completedEvidence.includes("/Users/"));
    }
  },
);
