// Explicit complete-preset refusal regression; never part of automatic npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { DesktopSessions } from "../src/host/sessions.js";
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
  "scripts/probe-ptc-rewind.mjs",
  "src/host/rewind-todos.js",
  "src/host/sessions.js",
  "src/host/official-package.js",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/ptc-process-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
let completedEvidence;
// Publish only after node:test has also completed teardown and asynchronous checks.
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/ptc-rewind-acceptance.json"),
      completedEvidence,
    );
});

test(
  "complete official PTC preset rejects todo rewind before creating a branch",
  { timeout: 45000 },
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
    const workspaceQueries = [];
    const desktop = new DesktopSessions(
      f.ctx,
      {
        dispatch(action, payload) {
          assert.equal(
            action,
            "workspaces.forSession",
            "Only an explicit synthetic unbound lookup is supplied",
          );
          assert.deepEqual(Object.keys(payload), ["sessionId"]);
          assert.equal(typeof payload.sessionId, "string");
          workspaceQueries.push(payload.sessionId);
          return { item: null };
        },
      },
      { host: f.runtime.host, enabled: () => false },
    );
    t.after(() => desktop.close());

    const original = await f.create("rewind-unsupported", []);
    const content = '合成任务 "引号" \\路径\n第二行：只作为 JSON 数据；${neverEvaluate}';
    const before = [
      { content: `已完成：${content}`, status: "completed" },
      { content: `待恢复：${content}`, status: "in_progress" },
      { content: `未开始：${content}`, status: "pending" },
    ];
    const later = [
      before[0],
      { ...before[1], status: "completed" },
      before[2],
      { content: `后缀新增：${content}`, status: "completed" },
    ];
    // Original synthetic input/history only: no fabricated tool call or PTC dispatch.
    original.session.append("turn/start", { turn: 1 });
    original.session.append("step/start", { turn: 1, step: 1 });
    original.session.append(
      "user/message",
      f.api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "SYNTHETIC_PTC_TODO_TWO_STEP_HISTORY" }],
      }),
      { surfaceOp: "append" },
    );
    original.session.append("todo/write", { todos: before });
    original.session.append("step/end", { turn: 1, step: 1, reason: { kind: "completed" } });
    original.session.append("step/start", { turn: 1, step: 2 });
    original.session.append("todo/write", { todos: later });
    original.session.append("step/end", { turn: 1, step: 2, reason: { kind: "completed" } });
    original.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });

    assert.equal(f.ctx.tools.resolveExecution("todo_write", original, false), undefined);
    assert.ok(f.ctx.tools.resolveExecution("run_code", original, false));
    assert.ok(f.ctx.tools.sdkSchemas(original).some((schema) => schema.name === "todo_write"));
    const schemaNames = (await f.assemble(original)).tools.map((tool) => tool.name);
    assert.deepEqual(schemaNames, ["run_code"]);

    const readback = async () => {
      await f.ctx.sessionPersistence.flush();
      const journal = original.session.snapshotEvents();
      const reader = await f.ctx.sessionPersistence.open(original.id, "read");
      try {
        assert.deepEqual((await reader.read()).events, journal);
      } finally {
        await reader.close();
      }
      const logs = join(f.directory, "logs");
      const paths = readdirSync(logs, { recursive: true }).filter(
        (path) => path.endsWith(".jsonl") && path.split(sep).includes(original.id),
      );
      assert.equal(paths.length, 1);
      const bytes = readFileSync(join(logs, paths[0]));
      const physical = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(physical[0].id, original.id);
      assert.equal(physical.length, journal.length + 1);
      assert.deepEqual(physical.slice(1), journal);
      return { journal, bytes };
    };
    const baseline = await readback();
    const agentIds = () =>
      f.ctx.agents
        .list()
        .map((agent) => agent.id)
        .sort();
    const beforeIds = agentIds();
    const beforeArchived = [...f.ctx.workspaceRegistry.archivedSessionIds];
    const calls = { create: 0, fork: 0, archive: 0, toolsExecute: 0 };
    const observe = (target, name, key) => {
      const method = target[name];
      t.mock.method(target, name, function (...args) {
        calls[key]++;
        return Reflect.apply(method, this, args);
      });
    };
    observe(f.ctx.sessionController, "create", "create");
    observe(f.ctx.sessionController, "fork", "fork");
    observe(f.ctx.workspaceRegistry, "archiveSession", "archive");
    observe(f.ctx.tools, "execute", "toolsExecute");
    await assert.rejects(
      desktop.rewind({ sessionId: original.id, mode: "step", draftBridgeReady: true }),
      (error) => {
        assert.equal(error.code, "TODO_RESET_UNSUPPORTED");
        assert.equal(
          error.partial,
          undefined,
          "The refusal must happen before partial branch creation",
        );
        return true;
      },
    );
    assert.deepEqual(calls, { create: 0, fork: 0, archive: 0, toolsExecute: 0 });
    assert.deepEqual(agentIds(), beforeIds);
    assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, beforeArchived);
    assert.equal(f.ctx.workspaceRegistry.archivedSessionIds.includes(original.id), false);
    assert.deepEqual(workspaceQueries, [original.id]);
    assert.deepEqual(
      f.ctx.sessionProjections.snapshot(original.session, ["todos"]).values.todos,
      later,
    );
    const after = await readback();
    assert.deepEqual(after.journal, baseline.journal);
    assert.deepEqual(after.bytes, baseline.bytes);
    for (const type of ["tool/call", "tool/result", "tool/ptc-dispatch-start", "tool/ptc-dispatch"])
      assert.deepEqual(events(original, type), []);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
    assert.equal(f.evidence().isolation.ptcBackend.launches.length, 0);
    desktop.close();
    await f.dispose();
    const fixtureEvidence = f.evidence();
    assert.equal(fixtureEvidence.isolation.rootsRemoved, true);
    assert.deepEqual(fixtureEvidence.isolation.cleanupErrors, []);
    const backend = fixtureEvidence.isolation.ptcBackend;
    assert.equal(backend.launches.length, 0);
    assert.equal(backend.cleanup.verified, true);
    // The guard offers sample programs; no program or backend process ran here.
    delete backend.programSha256;
    delete backend.availableReviewProgramSha256;
    delete backend.reviewPlanSha256;
    backend.boundaries = {
      actualOfficialProcess: false,
      backendExecutionAttempted: false,
      originalGuardUnmodified: true,
    };
    const evidence = {
      schemaVersion: 1,
      behaviorId: "CORE-REWIND-PTC-TODOS",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      initialEnvironmentNames,
      ...fixtureEvidence,
      outcome: {
        todoRestore: "unsupported",
        errorCode: "TODO_RESET_UNSUPPORTED",
        rejectedBeforeFork: true,
        newSessions: 0,
        sourceArchived: false,
        sourceTodoUnchanged: true,
        completeSourceJournalUnchanged: true,
        physicalJsonlBytesUnchanged: true,
        actualOfficialReaderBeforeAndAfter: true,
        persistedEvents: after.journal.length,
        jsonlSha256: hash(after.bytes),
      },
      schemaNames,
      calls: {
        ...calls,
        modelRequests: 0,
        backendProcesses: 0,
        syntheticWorkspaceQueries: workspaceQueries.length,
      },
      sourceDigests,
      boundaries: {
        completeOriginalPtcPreset: true,
        actualDesktopSessionsRewindPreflight: true,
        actualOfficialForkExecuted: false,
        actualArchiveExecuted: false,
        actualPtcBackendProcess: false,
        actualOfficialReaderAndPhysicalJsonl: true,
        syntheticHistory: true,
        syntheticUnboundWorkspaceLookup: true,
        originalProcessGuardUnmodified: true,
        realProfileLoaded: false,
        realDesktopExecuted: false,
      },
      result: "unsupported-as-expected",
    };
    completedEvidence =
      JSON.stringify(evidence, null, 2)
        .replaceAll(f.directory, "<synthetic-root>")
        .replaceAll(f.runtime.root, "<clean-runtime>")
        .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>")
        .replaceAll(NODE, "<bundled-node>")
        .replaceAll(INSTALLED, "<installed-runtime>") + "\n";
    assert.ok(!completedEvidence.includes("/Users/"));
  },
);
