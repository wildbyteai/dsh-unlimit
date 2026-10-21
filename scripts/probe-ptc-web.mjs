// Explicit official-process probe; never run implicitly by npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { presetFixture, presetProjectRoot } from "../tests/helpers/preset-fixture.mjs";
import {
  presetWebFixture,
  presetWebUrl,
  presetWebBody,
} from "../tests/helpers/preset-web-fixture.mjs";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
  "scripts/probe-ptc-web.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/preset-web-fixture.mjs",
  "tests/helpers/ptc-process-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/native-instructions.js",
  "src/host/prompt-refresh.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
let completedEvidence;
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/ptc-web-acceptance.json"),
      completedEvidence,
    );
});

test(
  "complete PTC preset fetches through official run_code with replace and revert",
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
    const web = await presetWebFixture(t, f);
    const sessions = [];
    const call = {
      name: "run_code",
      arguments: {
        code: f.ptc.webProgram,
        description: "Fetch one explicitly supplied synthetic page through the official SDK.",
        timeoutMs: 3000,
      },
    };
    let baselineTools;
    try {
      for (const mode of ["replace", "revert"]) {
        await t.test(mode, async () => {
          if (mode === "revert") f.adapter.revert();
          const agent = await f.create(`web-${mode}`, [[call], "finish"]);
          const original = await f.unadaptedAssembly(agent);
          const persona = f.api.prompt.renderPrompt({
            ...original,
            sections: original.sections.filter(
              (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
            ),
          });
          assert.ok(persona.length > 0);
          baselineTools ??= structuredClone(original.tools);
          assert.deepEqual(original.tools, baselineTools);
          assert.deepEqual(
            baselineTools.map((tool) => tool.name),
            ["run_code"],
          );
          assert.ok(f.ctx.tools.sdkSchemas(agent).some((tool) => tool.name === "web_fetch"));
          const functional = original.sections.filter((s) =>
            ["tools:ptc-only", "tools:sdk"].includes(s.name),
          );
          assert.equal(functional.length, 2);
          const composed = await f.assemble(agent);
          for (const section of functional)
            assert.deepEqual(
              composed.sections.find((s) => s.name === section.name),
              section,
            );
          web.reply();
          await f.ptc.run(() => f.run(agent));
          const calls = events(agent, "tool/call");
          const starts = events(agent, "tool/ptc-dispatch-start");
          const nested = events(agent, "tool/ptc-dispatch");
          const results = events(agent, "tool/result");
          for (const rows of [calls, starts, nested, results]) assert.equal(rows.length, 1);
          assert.equal(calls[0].data.name, "run_code");
          assert.deepEqual(JSON.parse(calls[0].data.arguments), call.arguments);
          for (const event of [starts[0], nested[0]]) {
            assert.equal(event.data.name, "web_fetch");
            assert.equal(event.data.parentCallId, calls[0].data.callId);
            assert.equal(event.data.rootCallId, calls[0].data.callId);
          }
          assert.equal(starts[0].data.subCallId, nested[0].data.subCallId);
          assert.deepEqual(starts[0].data.arguments, { url: presetWebUrl });
          assert.equal(nested[0].data.isError, false);
          assert.equal(results[0].data.message.isError, false, text([results[0].data.message]));
          const returned = JSON.parse(text([results[0].data.message]));
          assert.equal(returned.value.url, presetWebUrl);
          assert.equal(returned.value.statusCode, 200);
          assert.equal(returned.value.body.content, presetWebBody);
          assert.deepEqual(returned.networkAndSpawnAttempts, []);
          assert.deepEqual(returned.environmentNames, []);
          const requests = f.requests.filter((r) => r.sessionId === agent.id);
          assert.equal(requests.length, 2);
          for (const request of requests) {
            const system = text(request.messages.filter((m) => m.role === "system"));
            assert.equal(system.includes(f.settings.prompt), mode === "replace");
            assert.equal(system.includes(persona), mode === "revert");
            assert.ok(!system.includes("SYNTHETIC_PAGE_INSTRUCTION"));
            assert.deepEqual(request.tools, baselineTools);
          }
          assert.deepEqual(
            requests[1].messages.filter((m) => m.role === "tool"),
            [results[0].data.message],
          );
          assert.equal(web.requests.at(-1).agentId, agent.id);
          assert.equal(web.dnsCalls.at(-1).agentId, agent.id);
          const logs = join(f.directory, "logs");
          const files = readdirSync(logs, { recursive: true }).filter(
            (path) => path.endsWith(".jsonl") && path.split(sep).includes(agent.id),
          );
          assert.equal(files.length, 1);
          const bytes = readFileSync(join(logs, files[0]));
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
            mode,
            id: agent.id,
            modelRequests: requests.length,
            outerCall: calls[0].data.name,
            innerCall: nested[0].data.name,
            pageBodySha256: hash(presetWebBody),
            jsonlSha256: hash(bytes),
            physicalRows: physical.length,
            exactCallCausality: true,
            nextModelResultEqual: true,
            jsonlReadbackEqual: true,
            personaSha256: hash(persona),
            functionalSections: functional.map((s) => ({
              name: s.name,
              sha256: hash(JSON.stringify(s)),
            })),
          });
        });
      }
      assert.equal(sessions.length, 2);
      assert.equal(web.requests.length, 2);
      assert.equal(web.dnsCalls.length, 2);
      assert.deepEqual(f.errors, []);
      web.assertConsumed();
    } finally {
      await web.dispose();
      await f.dispose();
    }
    const evidence = {
      schemaVersion: 1,
      behaviorId: "CORE-WEBTOOLS",
      developmentBasis: "c14f088b6ee9eaaa46deecf39b39f81de05a0672",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      ...f.evidence(),
      sessions,
      sourceDigests,
      syntheticTransport: { dnsCalls: web.dnsCalls, requests: web.requests },
      boundaries: {
        actualOfficialPresetAndAgentLoop: true,
        actualPtcNodeBackend: true,
        nativePublicResolverPreserved: true,
        syntheticModelDnsAndHttp: true,
        modelPromptInjectionResistanceProven: false,
        realDesktopExecuted: false,
        realNetworkAccessed: false,
        kernelNetworkWhitelist: false,
      },
      result: "passed",
    };
    completedEvidence =
      JSON.stringify(evidence, null, 2)
        .replaceAll(f.directory, "<synthetic-root>")
        .replaceAll(f.runtime.root, "<clean-runtime>")
        .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>") + "\n";
    assert.ok(!completedEvidence.includes("/Users/"));
  },
);
