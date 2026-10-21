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
    const scenarios = [],
      escalations = [];
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
      // All retries pass through the full preset and official approval service.
      // Only the model output and the final user-answer channel are synthetic.
      f.adapter.apply();
      f.settings.fullAccess = false;
      const third = join(f.directory, "third");
      mkdirSync(third);
      for (const definition of [
        { id: "approved", root: f.workspace, outcome: "allowed-once", writable: true },
        { id: "rejected", root: f.workspace, outcome: "rejected", writable: false },
        { id: "outside", root: outside, outcome: "allowed-once", writable: false },
        { id: "third", root: third, outcome: "allowed-once", writable: false },
        {
          id: "auto-approved",
          root: f.workspace,
          outcome: "allowed-once",
          writable: true,
          autoApprove: true,
        },
        {
          id: "explicit-never",
          root: f.workspace,
          outcome: "rejected",
          writable: false,
          autoApprove: true,
          policy: "never",
        },
      ]) {
        await t.test(`escalation-${definition.id}`, async () => {
          f.settings.autoApprove = definition.autoApprove ?? false;
          const target = join(definition.root, `escalation-${definition.id}.txt`);
          const nextTarget = join(f.workspace, `escalation-${definition.id}-next.txt`);
          const value = `SYNTHETIC_ESCALATION_${definition.id}`;
          const command = `printf '%s' ${quote(value)} > ${quote(target)}`;
          const nextCommand = `printf '%s' ${quote(value)} > ${quote(nextTarget)}`;
          const call = (source, escalate = false) => ({
            name: "bash",
            arguments: {
              command: source,
              description: "Write only the specified disposable synthetic escalation fixture.",
              ...(escalate
                ? {
                    sandbox_permissions: "workspace-write",
                    justification: "Retry the denied synthetic command in its original workspace.",
                  }
                : {}),
            },
          });
          let agent;
          const actions = [
            [call(command)],
            {
              kind: "hold",
              wait() {
                assert.equal(existsSync(target), false, "first attempt made no file");
                const first = events(agent, "tool/result");
                assert.equal(first.length, 1);
                assert.match(text([first[0].data.message]), /\[exit code: 1\]/);
                assert.ok(
                  text([first[0].data.message]).includes(
                    "[sandbox: file access denied under read-only mode]",
                  ),
                );
                assert.equal(events(agent, "approval/asked").length, 0);
              },
              calls: [call(command, true)],
            },
          ];
          if (definition.writable)
            actions.push({
              kind: "hold",
              wait() {
                assert.equal(readFileSync(target, "utf8"), value);
                assert.equal(events(agent, "tool/result").length, 2);
                assert.equal(events(agent, "approval/decided").at(-1).data.outcome, "allowed-once");
                assert.equal(
                  f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
                  "read-only",
                );
              },
              calls: [call(nextCommand)],
            });
          actions.push("finish");
          agent = await f.create(`escalation-${definition.id}`, actions);
          // Leaving approval policy unset is necessary to test the plugin's
          // opt-in default; an explicit never must override that default.
          if (definition.policy) f.api.approval.setApprovalPolicy(agent.session, definition.policy);
          f.api.sandboxPolicy.setSandboxMode(agent.session, "read-only");
          const standingEvents = events(agent, "sandbox/mode");
          let answers = 0;
          agent.ctx.on("approval/request", (request) => {
            answers++;
            assert.equal(request.agent, agent);
            assert.equal(request.toolName, "bash");
            assert.equal(request.callId, events(agent, "tool/call").at(-1).data.callId);
            assert.equal(existsSync(target), false, "approval precedes any successful retry");
            return definition.outcome;
          });
          const approved = definition.outcome === "allowed-once";
          const commands = [
            command,
            ...(approved ? [command] : []),
            ...(definition.writable ? [nextCommand] : []),
          ];
          const modes = [
            "read-only",
            ...(approved ? ["workspace-write"] : []),
            ...(definition.writable ? ["read-only"] : []),
          ];
          const processes = await f.standardShell.run(agent, modes, commands, () => f.run(agent));
          assert.deepEqual(
            processes.map((row) => row.code),
            [
              1,
              ...(approved ? [definition.writable ? 0 : 1] : []),
              ...(definition.writable ? [1] : []),
            ],
          );
          assert.ok(processes.every((row) => row.closed && row.signal === null));
          const results = events(agent, "tool/result");
          const calls = events(agent, "tool/call");
          assert.equal(results.length, definition.writable ? 3 : 2);
          assert.equal(calls.length, results.length);
          assert.ok(calls.every((row) => row.data.name === "bash"));
          assert.equal(results[1].data.message.isError, !approved);
          if (!approved) assert.match(text([results[1].data.message]), /user rejected/);
          if (approved && !definition.writable)
            assert.ok(
              text([results[1].data.message]).includes(
                "[sandbox: file access denied under workspace-write mode]",
              ),
            );
          assert.equal(existsSync(target), definition.writable);
          if (definition.writable) assert.equal(readFileSync(target, "utf8"), value);
          assert.equal(existsSync(nextTarget), false, "later ordinary call stays read-only");
          assert.deepEqual(events(agent, "sandbox/mode"), standingEvents);
          const policy = f.ctx.sandboxPolicy.resolve({ session: agent.session });
          assert.equal(policy.mode, "read-only");
          assert.equal(policy.workspaceRoot, f.workspace);
          const asked = events(agent, "approval/asked"),
            decided = events(agent, "approval/decided");
          assert.equal(asked.length, 1);
          assert.equal(decided.length, 1);
          assert.equal(asked[0].data.id, decided[0].data.id);
          assert.equal(decided[0].data.outcome, definition.outcome);
          assert.equal(answers, definition.autoApprove ? 0 : 1);
          const requests = f.requests.filter((row) => row.sessionId === agent.id);
          assert.equal(requests.length, results.length + 1);
          for (let i = 0; i < results.length; i++)
            assert.deepEqual(
              requests[i + 1].messages.filter((message) => message.role === "tool"),
              results.slice(0, i + 1).map((row) => row.data.message),
            );
          escalations.push({
            id: definition.id,
            sessionId: agent.id,
            target: definition.root === f.workspace ? "workspace" : definition.id,
            autoApprove: definition.autoApprove ?? false,
            explicitApprovalPolicy: definition.policy ?? null,
            outcome: definition.outcome,
            answererCalls: answers,
            fileCreatedAndReadBack: definition.writable,
            standingMode: policy.mode,
            workspaceRootUnchanged: true,
            requests: requests.length,
            toolCalls: calls.length,
            processes,
            approvalAudit: [...asked, ...decided],
            officialPersistenceReadbackEqual: true,
          });
        });
      }
      assert.equal(escalations.length, 6);
      assert.equal(f.requests.length, 45);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.dispose();
    }
    const evidence = {
      schemaVersion: 1,
      behaviorIds: ["CORE-FILES", "CORE-PERMISSION", "CORE-MODES", "CORE-ESCALATION"],
      developmentBasis: "cff1d197541e9b139ec42e5ae09598321231408b",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      ...f.evidence(),
      scenarios,
      escalations,
      sourceDigests,
      boundaries: {
        actualOfficialAgentLoopAndPreset: true,
        actualFilesystemAndShell: true,
        syntheticModelResponses: true,
        syntheticApprovalResponses: true,
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
