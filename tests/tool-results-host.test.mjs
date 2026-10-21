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

      await t.test("MULTIPLE-REAL-PRESET-READ-FIBERS-ARE-REJECTED-WITHOUT-MUTATION", async () => {
        const unregister = await f.ctx.agentPresets.register({
          ...structuredClone(f.definition),
          id: "synthetic-second-read-preset",
        });
        try {
          assert.equal(
            (await f.ctx.agentPresets.resolve("synthetic-second-read-preset")).broken,
            undefined,
          );
          const entries = [...f.ctx.registry.values()]
            .flatMap((runtime) => [...runtime.fibers])
            .filter((fiber) => fiber.entry?.fiber === fiber)
            .map((fiber) => fiber.entry)
            .filter(
              (item) =>
                item?.options?.name === "@deepseek-ai/dsh-tool-fs" && item.fiber.state === 2,
            );
          assert.equal(entries.length, 2);
          const before = entries.map((item) => structuredClone(item.fiber.config));
          assert.equal(limits.capabilities()[0].state, "unsupported");
          await assert.rejects(limits.apply(), { code: "UNSUPPORTED_CAPABILITY" });
          assert.deepEqual(
            entries.map((item) => item.fiber.config),
            before,
          );
          assert.deepEqual(updates, [{ noSave: true }, { noSave: true }]);
        } finally {
          await unregister();
        }
        assert.equal(limits.capabilities()[0].state, "available");
        scenarios.push({
          id: "MULTIPLE-REAL-PRESET-READ-FIBERS-ARE-REJECTED-WITHOUT-MUTATION",
          result: "passed",
        });
      });

      const results = resultEvents(agent).map((event) => event.data.message);
      assert.equal(
        scenarios.length,
        4,
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
      assert.deepEqual(f.errors, []);
    } finally {
      try {
        await limits.revert();
      } finally {
        removeObserver();
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
            calls: { syntheticModelRequests: 7, actualReadCalls: 4, turns: 3 },
            testResult: { tests: 5, passed: 5, failed: 0, skipped: 0 },
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
              multipleActiveReadFibersSupported: false,
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
