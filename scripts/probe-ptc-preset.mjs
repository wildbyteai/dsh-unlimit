// Explicit, synthetic full-preset acceptance; not part of automatic npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
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
const sources = [
  "scripts/probe-ptc-preset.mjs",
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

test(
  "complete official PTC preset executes replace and revert through AgentLoop",
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
    const sessions = [];
    const promptVerification = [];
    t.after(() => {
      const isolation = f.evidence().isolation;
      console.log(
        "PTC cleanup",
        JSON.stringify({
          rootsRemoved: isolation.rootsRemoved,
          errors: isolation.cleanupErrors,
          backend: isolation.ptcBackend.cleanup,
        }),
      );
    });
    const scenario = (name, action) =>
      t.test(name, async () => {
        try {
          await action();
        } catch (error) {
          console.error(error);
          throw error;
        }
      });
    const call = {
      name: "run_code",
      arguments: {
        code: f.ptc.program,
        description: "Read one disposable synthetic file through the original PTC tool binding.",
        timeoutMs: 3000,
      },
    };
    const run = (agent) =>
      f.ptc.run(async () => {
        await f.run(agent);
        const results = events(agent, "tool/result");
        assert.equal(results.length, 1);
        assert.equal(results[0].data.message.isError, false, text([results[0].data.message]));
      });
    let baselineTools, persona;
    const functionalSections = new Map();
    const verifySession = (agent, mode) => {
      const observed = f.requests.filter((r) => r.sessionId === agent.id);
      assert.equal(observed.length, 2);
      for (const request of observed) assert.deepEqual(request.tools, baselineTools);
      const calls = events(agent, "tool/call");
      const starts = events(agent, "tool/ptc-dispatch-start");
      const dispatches = events(agent, "tool/ptc-dispatch");
      const results = events(agent, "tool/result");
      assert.equal(calls.length, 1);
      assert.equal(starts.length, 1);
      assert.equal(dispatches.length, 1);
      assert.equal(results.length, 1);
      assert.equal(calls[0].data.name, "run_code");
      assert.equal(typeof calls[0].data.arguments, "string");
      assert.deepEqual(JSON.parse(calls[0].data.arguments), call.arguments);
      assert.equal(starts[0].data.name, "read");
      assert.equal(dispatches[0].data.name, "read");
      assert.equal(starts[0].data.subCallId, dispatches[0].data.subCallId);
      assert.equal(typeof starts[0].data.subCallId, "string");
      for (const event of [starts[0], dispatches[0]]) {
        assert.equal(event.data.parentCallId, calls[0].data.callId);
        assert.equal(event.data.rootCallId, calls[0].data.callId);
      }
      assert.deepEqual(starts[0].data.arguments, { file_path: f.sourceFile });
      assert.equal(results[0].data.message.isError, false, text([results[0].data.message]));
      assert.ok(text([results[0].data.message]).includes(f.content));
      const returned = JSON.parse(text([results[0].data.message]));
      assert.deepEqual(returned.networkAndSpawnAttempts, []);
      assert.deepEqual(returned.environmentNames, []);
      assert.equal(returned.value.path, f.sourceFile);
      assert.deepEqual(returned.value.lines, [{ number: 1, text: f.content }]);
      assert.equal(dispatches[0].data.isError, false);
      const nextTools = observed[1].messages.filter((m) => m.role === "tool");
      assert.equal(nextTools.length, 1);
      assert.deepEqual(nextTools[0], results[0].data.message);
      const system = text(observed[0].messages.filter((m) => m.role === "system"));
      assert.equal(system.includes(f.settings.prompt), mode === "replace");
      assert.equal(system.includes(persona), mode === "revert");
      for (const rendered of functionalSections.values()) assert.ok(system.includes(rendered));
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
      for (const type of [
        "tool/call",
        "tool/ptc-dispatch-start",
        "tool/ptc-dispatch",
        "tool/result",
      ])
        assert.deepEqual(
          physical.filter((row) => row.type === type),
          events(agent, type),
        );
      sessions.push({
        id: agent.id,
        mode,
        requests: observed.length,
        toolCalls: calls.map((e) => e.data.name),
        ptcDispatches: dispatches.map((e) => ({ type: e.type, data: structuredClone(e.data) })),
        persistedEvents: agent.session.snapshotEvents().length,
        physicalJsonlRows: physical.length,
        jsonlSha256: hash(bytes),
        actualJsonlEventsEqual: true,
        nextModelToolResultEqual: true,
      });
    };
    await scenario("PTC-REPLACE-COMPLETE-PRESET", async () => {
      const agent = await f.create("replace", [[call], "finish"]);
      const original = await f.unadaptedAssembly(agent);
      const personaSection = original.sections.find(
        (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
      );
      assert.ok(personaSection);
      persona = f.api.prompt.renderPrompt({ ...original, sections: [personaSection] });
      assert.ok(persona.length > 0);
      baselineTools = structuredClone(original.tools);
      assert.deepEqual(
        baselineTools.map((tool) => tool.name),
        ["run_code"],
      );
      const replaced = await f.assemble(agent);
      assert.deepEqual(replaced.tools, baselineTools);
      for (const name of ["tools:ptc-only", "tools:sdk"]) {
        const section = original.sections.find((s) => s.name === name);
        assert.ok(section?.text.length > 0, name);
        assert.deepEqual(
          replaced.sections.find((s) => s.name === name),
          section,
        );
        functionalSections.set(
          name,
          f.api.prompt.renderPrompt({ ...original, sections: [section] }),
        );
      }
      await run(agent);
      verifySession(agent, "replace");
      promptVerification.push({
        mode: "replace",
        originalPersonaSha256: hash(persona),
        result: "passed",
      });
    });
    assert.equal(sessions.length, 1, "Replace must pass before the revert scenario starts");
    await scenario("PTC-REVERT-COMPLETE-PRESET", async () => {
      f.adapter.revert();
      const agent = await f.create("revert", [[call], "finish"]);
      const restored = await f.assemble(agent);
      assert.deepEqual(restored.tools, baselineTools);
      for (const [name, rendered] of functionalSections) {
        const section = restored.sections.find((s) => s.name === name);
        assert.ok(section);
        assert.equal(f.api.prompt.renderPrompt({ ...restored, sections: [section] }), rendered);
      }
      await run(agent);
      verifySession(agent, "revert");
      promptVerification.push({
        mode: "revert",
        originalPersonaSha256: hash(persona),
        result: "passed",
      });
    });
    assert.equal(sessions.length, 2);
    assert.equal(f.requests.length, 4);
    assert.deepEqual(f.errors, []);
    assert.equal(f.evidence().isolation.syntheticSourceReads.length, 2);
    await f.dispose();
    const evidence = {
      schemaVersion: 1,
      behaviorId: "CORE-MODES",
      developmentBasis: "d455551d169c977e7cd405cea468275a91c4d6d6",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      initialEnvironmentNames,
      ...f.evidence(),
      sessions,
      promptVerification,
      schemas: {
        names: baselineTools.map((t) => t.name),
        sha256: hash(JSON.stringify(baselineTools)),
        allRequestsIdentical: true,
      },
      functionalSections: [...functionalSections].map(([name, rendered]) => ({
        name,
        sha256: hash(rendered),
      })),
      calls: {
        syntheticModelRequests: 4,
        agentLoopRunCode: 2,
        officialPtcRead: 2,
        directToolRuntimeCalls: 0,
      },
      sourceDigests: sources,
      boundaries: {
        completePtcPresetMounted: true,
        actualOfficialLoaderAndRegistry: true,
        actualAgentLoop: true,
        actualOfficialPtcBackend: true,
        actualJsonlReadback: true,
        syntheticModelResponses: true,
        realDesktopExecuted: false,
        planTransitionOrOtherDeclaredToolsExecuted: false,
        originalSeatbeltProfileUnmodified: true,
        kernelReadAndNetworkWhitelist: false,
      },
      result: "passed",
    };
    const serialized = JSON.stringify(evidence, null, 2)
      .replaceAll(f.directory, "<synthetic-root>")
      .replaceAll(f.runtime.root, "<clean-runtime>")
      .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>");
    assert.ok(!serialized.includes("/Users/"));
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/ptc-preset-acceptance.json"),
      serialized + "\n",
    );
  },
);
