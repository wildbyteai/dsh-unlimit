import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReadLimits } from "../src/host/read-limits.js";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const rows = (message) => [...text(message).matchAll(/^\d+: (.*)$/gm)].map((match) => match[1]);

test(
  "complete standard read caps apply through the real preset fiber and preserve tool messages across turns",
  {
    skip:
      selectedRoot && cache ? false : "Set both official runtime variables; no profile is loaded",
    timeout: 45000,
  },
  async (t) => {
    const f = await presetFixture(t, selectedRoot, cache);
    const settings = { readLimit: 1024 };
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
    const scenarios = [];
    const updates = [];
    const scopedSessions = [];
    const readExecutions = [];
    const originalSchemas = new Map();
    const restoredSchemas = new Set();
    let calls;
    const files = [
      { name: "alpha", body: "ALPHA_HEAD\n" + "原创正文中🧭\n".repeat(12) + "ALPHA_TAIL" },
      { name: "beta", body: "BETA_HEAD\n" + "另一份合成材料😀\n".repeat(15) + "BETA_TAIL" },
      { name: "paged", body: "PAGED_HEAD\n" + "SYNTHETIC_PAGE_ROW\n".repeat(100) + "PAGED_TAIL" },
    ];
    for (const file of files) {
      file.path = join(f.workspace, `result-${file.name}.txt`);
      writeFileSync(file.path, file.body);
    }
    assert.ok(files.slice(0, 2).every((file) => Buffer.byteLength(file.body) < settings.readLimit));
    assert.ok(Buffer.byteLength(files[2].body) > settings.readLimit);
    const read = (file) => ({ name: "read", arguments: { file_path: file.path } });
    const resultEvents = (agent) =>
      agent.session.snapshotEvents().filter((event) => event.type === "tool/result");
    const observed = (agent) => f.requests.filter((request) => request.sessionId === agent.id);
    const currentEntries = () => limits.catalog().targets.map((target) => target.entry);
    const preset = (id, config) => {
      const definition = { ...structuredClone(f.definition), id };
      const configure = (plugins) => {
        for (const row of plugins) {
          if (row.group) configure(row.config);
          else if (row.name === "@deepseek-ai/dsh-tool-fs")
            row.config = { ...row.config, ...config };
        }
      };
      configure(definition.plugins);
      return definition;
    };
    const createScoped = async (id, suffix) => {
      const handle = await f.ctx.agents.create({
        sessionId: `synthetic-read-target-${suffix}`,
        meta: { cwd: f.workspace, agentPreset: id },
        agentOptions: {
          provider: "synthetic-standard-offline",
          model: "synthetic-model",
          maxTokens: 128,
        },
        setup: async (agentCtx) => {
          await f.ctx.agentPresets.mount(agentCtx, id);
        },
      });
      originalSchemas.set(handle.agent.id, structuredClone(f.ctx.tools.schemas(handle.agent)));
      return handle;
    };
    const sortedTools = (tools) => tools.toSorted((a, b) => a.name.localeCompare(b.name));
    const readScoped = async (scopeAgent, { restored = false } = {}) => {
      const previousResults = resultEvents(scopeAgent).length;
      const previousRequests = observed(scopeAgent).length;
      const beforeTools = originalSchemas.get(scopeAgent.id);
      assert.equal(beforeTools.length, 30);
      // Only read's advertised default line window changes with the budget.
      // Restoration must return the exact complete schema captured before apply.
      const expectedTools = sortedTools(structuredClone(beforeTools));
      if (!restored)
        expectedTools.find((tool) => tool.name === "read").parameters.properties.limit.description =
          `Maximum number of lines to return. Defaults to ${settings.readLimit + 1}.`;
      assert.deepEqual(
        sortedTools(f.ctx.tools.schemas(scopeAgent)),
        expectedTools,
        "The real scope resolves the expected schemas before its AgentLoop turn",
      );
      const otherTools = (tools) => sortedTools(tools.filter((tool) => tool.name !== "read"));
      assert.equal(otherTools(beforeTools).length, 29);
      assert.deepEqual(
        otherTools(beforeTools),
        otherTools(observed(agent)[0].tools),
        "All other 29 tool schemas remain complete and equal across scopes",
      );
      f.script(scopeAgent.id, [[read(files[2])], "finish"]);
      await f.run(scopeAgent);
      const results = resultEvents(scopeAgent).map((event) => event.data.message);
      assert.equal(results.length, previousResults + 1);
      const requests = observed(scopeAgent);
      assert.equal(requests.length, previousRequests + 2);
      for (const [index, request] of requests.slice(previousRequests).entries()) {
        assert.equal(request.tools.length, 30);
        assert.deepEqual(
          sortedTools(request.tools),
          expectedTools,
          "Each request receives the complete current scoped tool schemas",
        );
        assert.deepEqual(
          otherTools(request.tools),
          otherTools(beforeTools),
          "Budget changes and restoration preserve every other tool schema",
        );
        if (restored)
          assert.deepEqual(
            request.tools.find((tool) => tool.name === "read"),
            beforeTools.find((tool) => tool.name === "read"),
            "The restored read schema is exactly this scope's pre-apply schema",
          );
        assert.deepEqual(
          request.tools.map((tool) => tool.name).sort(),
          observed(agent)[0]
            .tools.map((tool) => tool.name)
            .sort(),
        );
        const actual = request.messages.filter((message) => message.role === "tool");
        assert.equal(actual.length, previousResults + index);
        for (const [ordinal, message] of actual.entries()) {
          assert.deepEqual(
            message,
            results[ordinal],
            "Scoped AgentLoop retains complete earlier tool messages",
          );
          const authoredCalls = request.messages
            .filter((item) => item.role === "assistant")
            .flatMap((item) => item.content.filter((part) => part.type === "tool-call"));
          assert.equal(authoredCalls.filter((call) => call.id === message.toolCallId).length, 1);
        }
      }
      if (restored) restoredSchemas.add(scopeAgent.id);
      return results.at(-1);
    };
    const captureScoped = (scopeAgent) => {
      const journal = scopeAgent.session.snapshotEvents();
      const readCalls = journal.filter(
        (event) => event.type === "tool/call" && event.data.name === "read",
      );
      assert.equal(readCalls.length, 2);
      assert.equal(resultEvents(scopeAgent).length, 2);
      assert.equal(observed(scopeAgent).length, 4);
      assert.equal(journal.filter((event) => event.type === "turn/start").length, 2);
      assert.equal(journal.filter((event) => event.type === "turn/end").length, 2);
      assert.deepEqual(
        journal.filter((event) => /compaction|prun/.test(event.type)),
        [],
      );
      assert.ok(restoredSchemas.has(scopeAgent.id));
      const result = {
        sessionId: scopeAgent.id,
        presetId: f.ctx.agentPresets.composedPreset(scopeAgent.ctx),
        syntheticModelRequests: observed(scopeAgent).length,
        turns: journal.filter((event) => event.type === "turn/start").length,
        agentLoopReadCalls: readCalls.map((event) => event.data.callId),
        actualJsonlReadback: true,
        completeToolCatalog: true,
        otherToolSchemasUnchanged: true,
        readSchemaRestored: true,
      };
      scopedSessions.push(result);
      return result;
    };
    const target = limits.target();
    assert.equal(target.reason, undefined, "The real standard preset fiber must be discoverable");
    const entry = target.entry;
    const original = structuredClone(entry.fiber.config);
    const raw = entry.options.config;
    const rawBytes = JSON.stringify(raw);
    const removeObserver = f.ctx.on(
      "internal/update",
      function (_config, noSave, next) {
        if (this === entry.fiber) updates.push({ noSave });
        return next();
      },
      { global: true, prepend: true },
    );
    const removeReadObserver = f.ctx.on(
      "tools/pre-execute",
      (execution, next) => {
        if (execution.name === "read")
          readExecutions.push({ sessionId: execution.agent?.id, callId: execution.callId });
        return next();
      },
      { global: true },
    );
    let agent;
    try {
      await t.test("STANDARD-SCOPED-READ-CAP-APPLIES-WITHOUT-CHANGING-DECLARATION", async () => {
        assert.equal(
          [...f.ctx.loader.entries()].filter(
            (item) => item.options?.name === "@deepseek-ai/dsh-tool-fs",
          ).length,
          0,
        );
        assert.equal((await limits.apply())[0].state, "active");
        assert.deepEqual(entry.fiber.config, {
          ...original,
          readMaxBytes: 1024,
          readLimit: 1025,
          readMaxLineLength: 1024,
        });
        assert.equal(entry.options.config, raw);
        assert.equal(JSON.stringify(raw), rawBytes);
        assert.deepEqual(updates, [{ noSave: true }]);
        scenarios.push({
          id: "STANDARD-SCOPED-READ-CAP-APPLIES-WITHOUT-CHANGING-DECLARATION",
          result: "passed",
        });
      });

      await t.test("STANDARD-READ-RESULTS-REMAIN-EXACT-ACROSS-STEPS-AND-TURNS", async () => {
        agent = await f.create("retained-tool-results", [
          [read(files[0])],
          [read(files[1])],
          "finish",
        ]);
        await f.run(agent);
        assert.equal(observed(agent).length, 3);
        assert.equal(resultEvents(agent).length, 2);
        for (const [index, event] of resultEvents(agent).entries()) {
          assert.equal(event.data.message.isError, false);
          assert.deepEqual(rows(event.data.message), files[index].body.split("\n"));
        }
        f.script(agent.id, [[read(files[2])], "finish"]);
        await f.run(agent);
        assert.equal(observed(agent).length, 5);
        const partial = resultEvents(agent)[2].data.message;
        assert.equal(partial.isError, false);
        assert.ok(text(partial).includes("PAGED_HEAD"));
        assert.equal(text(partial).includes("PAGED_TAIL"), false);
        const returnedRows = rows(partial);
        assert.ok(returnedRows.length > 1);
        assert.ok(Buffer.byteLength(returnedRows.join("\n")) <= settings.readLimit);
        assert.deepEqual(returnedRows, files[2].body.split("\n").slice(0, returnedRows.length));
        scenarios.push({
          id: "STANDARD-READ-RESULTS-REMAIN-EXACT-ACROSS-STEPS-AND-TURNS",
          result: "passed",
        });
      });

      await t.test("STANDARD-REVERT-RESTORES-CAPS-WITHOUT-REWRITING-HISTORY", async () => {
        const history = structuredClone(agent.session.snapshotEvents());
        await limits.revert();
        assert.deepEqual(agent.session.snapshotEvents(), history);
        assert.deepEqual(entry.fiber.config, original);
        assert.equal(entry.options.config, raw);
        assert.equal(JSON.stringify(raw), rawBytes);
        assert.deepEqual(updates, [{ noSave: true }, { noSave: true }]);
        assert.ok(original.readMaxBytes > Buffer.byteLength(files[2].body));
        f.script(agent.id, [[read(files[2])], "finish"]);
        await f.run(agent);
        const full = resultEvents(agent)[3].data.message;
        assert.equal(full.isError, false);
        assert.deepEqual(rows(full), files[2].body.split("\n"));
        assert.equal(observed(agent).length, 7);
        scenarios.push({
          id: "STANDARD-REVERT-RESTORES-CAPS-WITHOUT-REWRITING-HISTORY",
          result: "passed",
        });
      });

      await t.test("MULTIPLE-REAL-PRESET-READ-FIBERS-APPLY-AND-RESTORE-INDEPENDENTLY", async () => {
        const id = "synthetic-second-read-preset";
        const unregister = await f.ctx.agentPresets.register(
          preset(id, {
            readMaxBytes: 4096,
            readLimit: 400,
            readMaxLineLength: 400,
            readStreamMinSize: 16,
          }),
        );
        let standardHandle, handle;
        try {
          assert.equal((await f.ctx.agentPresets.resolve(id)).broken, undefined);
          standardHandle = await createScoped("standard", "first-preset");
          handle = await createScoped(id, "second-preset");
          const entries = currentEntries();
          assert.equal(entries.length, 2);
          const before = entries.map((item) => structuredClone(item.fiber.config));
          const declarations = entries.map((item) => ({
            raw: item.options.config,
            bytes: JSON.stringify(item.options.config),
          }));
          const secondary = entries.find((item) => item !== entry);
          const scopedUpdates = [];
          const observe = f.ctx.on(
            "internal/update",
            function (_config, noSave, next) {
              if (entries.some((item) => item.fiber === this)) scopedUpdates.push({ noSave });
              return next();
            },
            { global: true, prepend: true },
          );
          try {
            // Both successful earlier targets and the failing target are rolled back.
            for (const cancel of [false, true]) {
              const abort = new AbortController();
              let once = true;
              const failSecond = f.ctx.on(
                "internal/update",
                async function (config, _noSave, next) {
                  const result = await next();
                  if (this === secondary.fiber && config.readMaxBytes === 1024 && once) {
                    once = false;
                    if (cancel) abort.abort();
                    else throw new Error("Synthetic second-preset lifecycle failure");
                  }
                  return result;
                },
                { global: true },
              );
              try {
                await assert.rejects(limits.apply({ signal: abort.signal }), (error) => {
                  assert.equal(error.partial.targets.length, 2);
                  return error.partial.restored && !error.partial.owned;
                });
                assert.deepEqual(
                  entries.map((item) => item.fiber.config),
                  before,
                );
              } finally {
                failSecond();
              }
            }
            const active = (await limits.apply())[0];
            assert.equal(active.state, "active");
            assert.equal(active.targetCount, 2);
            assert.equal(active.appliedTargetCount, 2);
            assert.equal(active.coverage, "complete");
            assert.equal(active.effective, 1024);
            assert.equal(active.effectiveCaps, null, "Per-preset stream thresholds stay distinct");
            for (const target of [standardHandle.agent, handle.agent]) {
              const result = await readScoped(target);
              assert.equal(result.isError, false);
              assert.ok(text(result).includes("PAGED_HEAD"));
              assert.equal(text(result).includes("PAGED_TAIL"), false);
              assert.ok(Buffer.byteLength(rows(result).join("\n")) <= settings.readLimit);
            }
            await limits.revert();
            assert.deepEqual(
              entries.map((item) => item.fiber.config),
              before,
            );
            for (const target of [standardHandle.agent, handle.agent]) {
              const result = await readScoped(target, { restored: true });
              assert.equal(result.isError, false);
              assert.deepEqual(rows(result), files[2].body.split("\n"));
            }
            for (const [index, item] of entries.entries()) {
              assert.equal(item.options.config, declarations[index].raw);
              assert.equal(JSON.stringify(item.options.config), declarations[index].bytes);
            }
            assert.ok(scopedUpdates.length >= 8);
            assert.ok(scopedUpdates.every((update) => update.noSave === true));
            captureScoped(standardHandle.agent);
            captureScoped(handle.agent);
          } finally {
            observe();
          }
        } finally {
          await limits.revert();
          await handle?.dispose();
          await standardHandle?.dispose();
          await unregister();
        }
        assert.equal(limits.capabilities()[0].state, "available");
        scenarios.push({
          id: "MULTIPLE-REAL-PRESET-READ-FIBERS-APPLY-AND-RESTORE-INDEPENDENTLY",
          result: "passed",
          targets: 2,
          actualReadCalls: 4,
          agentLoop: true,
          actualJsonlReadback: true,
          secondTargetFailureRolledBack: true,
          duringUpdateCancellationRolledBack: true,
        });
      });

      await t.test("RETAINED-OLD-AND-CURRENT-PRESET-REVISIONS-ARE-BOTH-COVERED", async () => {
        const id = "synthetic-retained-read-preset";
        let unregister = await f.ctx.agentPresets.register(
          preset(id, {
            readMaxBytes: 4096,
            readLimit: 400,
            readMaxLineLength: 400,
            readStreamMinSize: 16,
          }),
        );
        let oldHandle, currentHandle, lease;
        try {
          oldHandle = await createScoped(id, "retained-old");
          lease = await f.ctx.agentPresets.acquireScope(id);
          assert.equal(
            f.api.scope.scopeParentOf(f.api.scope.scopeOf(oldHandle.agent.ctx)),
            lease.key,
          );
          await unregister();
          unregister = await f.ctx.agentPresets.register(
            preset(id, {
              readMaxBytes: 8192,
              readLimit: 500,
              readMaxLineLength: 500,
              readStreamMinSize: 32,
            }),
          );
          currentHandle = await createScoped(id, "retained-current");
          assert.notEqual(
            f.api.scope.scopeParentOf(f.api.scope.scopeOf(currentHandle.agent.ctx)),
            lease.key,
          );
          const entries = currentEntries();
          assert.equal(
            entries.length,
            3,
            "Root standard, retained old revision and current revision are all real active fibers",
          );
          const before = entries.map((item) => structuredClone(item.fiber.config));
          const declarations = entries.map((item) => ({
            raw: item.options.config,
            bytes: JSON.stringify(item.options.config),
          }));
          const active = (await limits.apply())[0];
          assert.equal(active.targetCount, 3);
          assert.equal(active.appliedTargetCount, 3);
          assert.equal(active.ownedTargetCount, 3);
          assert.equal(active.state, "active");
          assert.equal(active.effective, 1024);
          for (const handle of [oldHandle, currentHandle]) {
            const result = await readScoped(handle.agent);
            assert.equal(result.isError, false);
            assert.ok(text(result).includes("PAGED_HEAD"));
            assert.equal(text(result).includes("PAGED_TAIL"), false);
          }
          await limits.revert();
          assert.deepEqual(
            entries.map((item) => item.fiber.config),
            before,
          );
          for (const handle of [oldHandle, currentHandle]) {
            const result = await readScoped(handle.agent, { restored: true });
            assert.equal(result.isError, false);
            assert.deepEqual(rows(result), files[2].body.split("\n"));
          }
          for (const [index, item] of entries.entries()) {
            assert.equal(item.options.config, declarations[index].raw);
            assert.equal(JSON.stringify(item.options.config), declarations[index].bytes);
          }
          captureScoped(oldHandle.agent);
          captureScoped(currentHandle.agent);
        } finally {
          await limits.revert();
          await currentHandle?.dispose();
          await oldHandle?.dispose();
          await lease?.[Symbol.asyncDispose]();
          await unregister();
        }
        assert.equal(limits.capabilities()[0].targetCount, 1);
        scenarios.push({
          id: "RETAINED-OLD-AND-CURRENT-PRESET-REVISIONS-ARE-BOTH-COVERED",
          result: "passed",
          targets: 3,
          actualReadCalls: 4,
          agentLoop: true,
          actualJsonlReadback: true,
        });
      });

      const results = resultEvents(agent).map((event) => event.data.message);
      assert.equal(
        scenarios.length,
        5,
        "Every acceptance scenario must finish before publishing evidence",
      );
      assert.equal(results.length, 4);
      assert.equal(new Set(results.map((message) => message.toolCallId)).size, 4);
      for (const [index, request] of observed(agent).entries()) {
        const expectedCount = [0, 1, 2, 2, 3, 3, 4][index];
        const actual = request.messages.filter((message) => message.role === "tool");
        assert.equal(actual.length, expectedCount);
        for (const [ordinal, message] of actual.entries()) {
          assert.equal(message.toolCallId, results[ordinal].toolCallId);
          assert.deepEqual(
            message,
            results[ordinal],
            "Every earlier tool message retains its complete canonical content",
          );
          const authoredCalls = request.messages
            .filter((item) => item.role === "assistant")
            .flatMap((item) => item.content.filter((part) => part.type === "tool-call"));
          assert.equal(authoredCalls.filter((call) => call.id === message.toolCallId).length, 1);
        }
        assert.equal(request.tools.length, 30);
        assert.deepEqual(
          request.tools.map((tool) => tool.name).sort(),
          observed(agent)[0]
            .tools.map((tool) => tool.name)
            .sort(),
        );
      }
      const journal = agent.session.snapshotEvents();
      assert.equal(journal.filter((event) => event.type === "turn/start").length, 3);
      assert.equal(journal.filter((event) => event.type === "turn/end").length, 3);
      assert.deepEqual(
        journal.filter((event) => /compaction|prun/.test(event.type)),
        [],
      );
      assert.equal(scopedSessions.length, 4);
      const loopReadCalls = [
        ...journal
          .filter((event) => event.type === "tool/call" && event.data.name === "read")
          .map((event) => ({ sessionId: agent.id, callId: event.data.callId })),
        ...scopedSessions.flatMap((session) =>
          session.agentLoopReadCalls.map((callId) => ({ sessionId: session.sessionId, callId })),
        ),
      ];
      const directReadCalls = readExecutions.filter(
        (execution) =>
          !loopReadCalls.some(
            (call) => call.callId === execution.callId && call.sessionId === execution.sessionId,
          ),
      );
      assert.equal(readExecutions.length, 12);
      assert.equal(loopReadCalls.length, 12);
      assert.equal(
        new Set(loopReadCalls.map((call) => `${call.sessionId}:${call.callId}`)).size,
        12,
      );
      assert.deepEqual(
        directReadCalls,
        [],
        "Every actual read belongs to a recorded AgentLoop call",
      );
      for (const call of loopReadCalls)
        assert.equal(
          readExecutions.filter(
            (execution) =>
              execution.callId === call.callId && execution.sessionId === call.sessionId,
          ).length,
          1,
        );
      calls = {
        syntheticModelRequests: f.requests.length,
        turns:
          journal.filter((event) => event.type === "turn/start").length +
          scopedSessions.reduce((sum, session) => sum + session.turns, 0),
        actualReadCalls: readExecutions.length,
        agentLoopReadCalls: loopReadCalls.length,
        directToolRuntimeReadCalls: directReadCalls.length,
        retainedHistorySession: {
          syntheticModelRequests: observed(agent).length,
          turns: journal.filter((event) => event.type === "turn/start").length,
          agentLoopReadCalls: results.length,
          actualJsonlReadback: true,
        },
        additionalScopes: scopedSessions.map((session) => ({
          ...session,
          agentLoopReadCalls: session.agentLoopReadCalls.length,
        })),
      };
      assert.equal(calls.syntheticModelRequests, 23);
      assert.equal(calls.turns, 11);
      assert.deepEqual(f.errors, []);
    } finally {
      try {
        await limits.revert();
      } finally {
        removeObserver();
        removeReadObserver();
        await f.dispose();
      }
    }
    assert.equal(f.evidence().isolation.rootsRemoved, true);
    if (process.env.DSH_UNLIMIT_TOOL_RESULTS_EVIDENCE === "1") {
      const paths = [
        "tests/tool-results-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/read-limits.js",
        "src/host/runtime.js",
      ];
      writeFileSync(
        join(presetProjectRoot, "docs/evidence/tool-results-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            behaviorId: "CORE-RESULT",
            generatedAt: new Date().toISOString(),
            node: process.version,
            ...f.evidence(),
            scenarios,
            calls,
            testResult: { tests: 6, passed: 6, failed: 0, skipped: 0 },
            sourceDigests: paths.map((path) => ({
              path,
              sha256: hash(readFileSync(join(presetProjectRoot, path))),
            })),
            boundaries: {
              completeStandardPreset: true,
              actualScopedFiberUpdate: true,
              actualFileReads: true,
              canonicalToolMessagesPreserved: true,
              actualJsonlReadback: true,
              pressureCompactionExercised: false,
              multipleActiveReadFibersSupported: true,
              retainedPresetRevisionsCovered: true,
              allReadCallsThroughAgentLoop: true,
              realModelOrDesktopExecuted: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
