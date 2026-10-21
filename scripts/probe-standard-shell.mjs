// Explicit disposable filesystem and official Seatbelt probe, outside npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { presetFixture, presetProjectRoot } from "../tests/helpers/preset-fixture.mjs";

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
  "scripts/probe-standard-shell.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/standard-shell-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/permission-defaults.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
let completedEvidence;
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/standard-shell-acceptance.json"),
      completedEvidence,
    );
});

test(
  "standard file and bash tools share effective permissions through the real kernel sandbox",
  { timeout: 45000 },
  async (t) => {
    const f = await presetFixture(
      t,
      INSTALLED,
      join(presetProjectRoot, "artifacts/official-packages"),
      { shellExecution: true },
    );
    const outside = join(f.directory, "outside");
    mkdirSync(outside);
    // This peer directory is not under a platform temporary root: workspace-write
    // must not succeed through an unrelated /tmp allowance.
    assert.ok(outside.startsWith(presetProjectRoot));
    assert.ok(!outside.startsWith("/private/tmp/") && !outside.startsWith("/tmp/"));
    const scenarios = [];
    const definitions = [
      {
        id: "readonly",
        explicit: "read-only",
        effective: "read-only",
        allowed: [false, false],
        fullAccess: false,
      },
      {
        id: "workspace",
        explicit: "workspace-write",
        effective: "workspace-write",
        allowed: [true, false],
        fullAccess: false,
      },
      {
        id: "full-default",
        effective: "danger-full-access",
        allowed: [true, true],
        fullAccess: true,
      },
      {
        id: "explicit-restricted",
        explicit: "read-only",
        effective: "read-only",
        allowed: [false, false],
        fullAccess: true,
      },
      {
        id: "revert",
        effective: "read-only",
        allowed: [false, false],
        fullAccess: true,
        revert: true,
      },
    ];
    let baselineTools, fullAccessAgent;
    try {
      for (const definition of definitions) {
        await t.test(definition.id, async () => {
          f.settings.fullAccess = definition.fullAccess;
          if (definition.revert) f.adapter.revert();
          const value = `SYNTHETIC_${definition.id}_WRITE`;
          const targets = [f.workspace, outside].flatMap((base) =>
            ["file", "bash"].map((family) => ({
              family,
              path: join(base, `${definition.id}-${family}.txt`),
            })),
          );
          const commands = targets
            .filter((row) => row.family === "bash")
            .map((row) => `printf '%s' ${quote(value)} > ${quote(row.path)}`);
          let commandIndex = 0;
          const actions = targets.map((row) => [
            row.family === "file"
              ? { name: "write", arguments: { file_path: row.path, content: value } }
              : {
                  name: "bash",
                  arguments: {
                    command: commands[commandIndex++],
                    description:
                      "Write only the specified disposable synthetic permission fixture.",
                  },
                },
          ]);
          const agent =
            definition.id === "explicit-restricted"
              ? fullAccessAgent
              : await f.create(`shell-${definition.id}`, [...actions, "finish"]);
          assert.ok(agent);
          if (definition.id === "full-default") fullAccessAgent = agent;
          if (definition.id === "explicit-restricted") f.script(agent.id, [...actions, "finish"]);
          const priorResults = events(agent, "tool/result");
          const priorCalls = events(agent, "tool/call").length;
          const priorRequests = f.requests.filter((r) => r.sessionId === agent.id).length;
          if (definition.explicit)
            f.api.sandboxPolicy.setSandboxMode(agent.session, definition.explicit);
          assert.equal(
            f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
            definition.effective,
          );
          const shellResults = await f.standardShell.run(
            agent,
            definition.effective,
            commands,
            () => f.run(agent),
          );
          const results = events(agent, "tool/result").slice(priorResults.length);
          assert.equal(results.length, 4);
          assert.deepEqual(
            events(agent, "tool/call")
              .slice(priorCalls)
              .map((e) => e.data.name),
            ["write", "bash", "write", "bash"],
          );
          const requests = f.requests.filter((r) => r.sessionId === agent.id).slice(priorRequests);
          assert.equal(requests.length, 5);
          const outcomes = [];
          for (let i = 0; i < targets.length; i++) {
            const row = targets[i],
              allowed = definition.allowed[Math.floor(i / 2)];
            assert.equal(
              existsSync(row.path),
              allowed,
              `${definition.id}: ${row.family} actual file effect`,
            );
            if (allowed) assert.equal(readFileSync(row.path, "utf8"), value);
            const message = results[i].data.message;
            // Official bash reports a completed process with nonzero exit as a
            // normal tool result. Verify the real exit and disk effect instead.
            assert.equal(message.isError, row.family === "file" && !allowed, text([message]));
            if (!allowed && row.family === "file")
              assert.equal(results[i].data.error.code, "FS_SANDBOX_DENIED");
            if (row.family === "bash") {
              const processResult = shellResults[Math.floor(i / 2)];
              assert.equal(processResult.code, allowed ? 0 : 1);
              assert.equal(processResult.signal, null);
              assert.equal(processResult.closed, true);
              if (!allowed) {
                assert.match(text([message]), /Operation not permitted|Permission denied/);
                assert.ok(
                  text([message]).includes(
                    `[sandbox: file access denied under ${definition.effective} mode]`,
                  ),
                );
                assert.ok(text([message]).includes("[exit code: 1]"));
              }
            }
            assert.deepEqual(
              requests[i + 1].messages.filter((m) => m.role === "tool"),
              [...priorResults, ...results.slice(0, i + 1)].map((e) => e.data.message),
            );
            outcomes.push({
              family: row.family,
              target: i < 2 ? "workspace" : "outside",
              allowed,
              output: text([message]),
            });
          }
          for (const request of requests) {
            baselineTools ??= structuredClone(request.tools);
            assert.deepEqual(request.tools, baselineTools);
            assert.equal(
              text(request.messages.filter((m) => m.role === "system")).includes(f.settings.prompt),
              !definition.revert,
            );
          }
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
          for (const type of ["tool/call", "tool/result", "sandbox/mode"])
            assert.deepEqual(
              physical.filter((row) => row.type === type),
              events(agent, type),
            );
          scenarios.push({
            ...definition,
            sessionId: agent.id,
            requests: requests.length,
            outcomes,
            jsonlSha256: hash(bytes),
            physicalRows: physical.length,
            officialAndPhysicalReadbackEqual: true,
          });
        });
      }
      assert.equal(scenarios.length, definitions.length);
      assert.equal(f.requests.length, 25);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.dispose();
    }
    const evidence = {
      schemaVersion: 1,
      behaviorIds: ["CORE-FILES", "CORE-PERMISSION", "CORE-MODES"],
      developmentBasis: "50607362d76d284eaced4bdcd482d4b9caf896f9",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      ...f.evidence(),
      scenarios,
      sourceDigests,
      boundaries: {
        actualOfficialAgentLoopAndPreset: true,
        actualFilesystemAndShell: true,
        syntheticModelResponses: true,
        realDesktopExecuted: false,
        ptyExecuted: false,
        realProfileModified: false,
        networkTested: false,
        arbitraryAdditionalDirectoryGrantsTested: false,
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
