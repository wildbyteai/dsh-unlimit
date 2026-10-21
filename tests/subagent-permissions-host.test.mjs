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
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const events = (agent, type) => agent.session.snapshotEvents().filter((row) => row.type === type);
const text = (message) =>
  message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
const permissionTypes = new Set(["permission/preset", "sandbox/mode", "approval/policy"]);
const under = (base, path) => {
  const suffix = relative(base, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix))
  );
};
const read = (path, expected) => ({ name: "read", arguments: { file_path: path }, expected });
const write = (path, content, expected, extra = {}) => ({
  name: "write",
  arguments: { file_path: path, content, ...extra },
  expected,
});
const edit = (path, old_string, new_string, expected) => ({
  name: "edit",
  arguments: { file_path: path, old_string, new_string },
  expected,
});
const denied = { code: "FS_SANDBOX_DENIED", pattern: /file access denied under/ };
function heldResponse() {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  return {
    entered: entered.promise,
    release: released.resolve,
    action: {
      kind: "hold",
      async wait(request) {
        request.signal.throwIfAborted();
        entered.resolve();
        let abort;
        const cancelled = new Promise((_, reject) => {
          abort = () => reject(request.signal.reason);
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
        try {
          await Promise.race([released.promise, cancelled]);
        } finally {
          request.signal.removeEventListener("abort", abort);
        }
      },
    },
  };
}

test(
  "official spawned agents inherit captured permissions and enforce real file operations and refused escalation",
  {
    skip:
      selectedRoot && cache
        ? false
        : "Set both official runtime variables; only synthetic disposable sessions are used",
    timeout: 45000,
  },
  async (t) => {
    const platformTemporaryRoots = [realpathSync(tmpdir()), realpathSync("/tmp")];
    const f = await presetFixture(t, selectedRoot, cache, { permissionPresets: true });
    const outside = join(f.directory, "outside");
    mkdirSync(outside);
    for (const root of platformTemporaryRoots) assert.equal(under(root, outside), false);
    const outsideSeed = join(outside, "observed.txt");
    const seedText = "SYNTHETIC_OUTSIDE_HEAD\nSYNTHETIC_OUTSIDE_TAIL";
    writeFileSync(outsideSeed, seedText);
    const cases = [],
      agents = [],
      activations = [],
      toolCalls = [],
      policyObservations = [],
      diskReadbacks = [],
      jsonlReadbacks = [],
      receipts = [],
      held = new Map();
    const lifecycle = { created: [], disposed: [], started: [], ended: [] };
    f.ctx.on("agent/created", ({ agent }) => lifecycle.created.push(agent.id));
    f.ctx.on("agent/disposed", ({ agent }) => lifecycle.disposed.push(agent.id));
    f.ctx.on("subagent/start", (event) => lifecycle.started.push(event.id));
    f.ctx.on("subagent/end", (event) => lifecycle.ended.push(event.id));
    const approvalRequests = [];
    const stopAnswerer = f.ctx.on("approval/request", (request) => {
      approvalRequests.push({ sessionId: request.agent.id, toolName: request.toolName });
      return "rejected";
    });
    const verifyProgram = (agent, program, before) => {
      const calls = events(agent, "tool/call").slice(before);
      const results = events(agent, "tool/result").slice(before);
      assert.equal(calls.length, program.length);
      assert.equal(results.length, program.length);
      for (const [index, step] of program.entries()) {
        const message = results[index].data.message;
        assert.equal(typeof calls[index].data.callId, "string");
        assert.ok(calls[index].data.callId.length > 0);
        assert.equal(message.toolCallId, calls[index].data.callId);
        assert.equal(calls[index].data.name, step.name);
        assert.deepEqual(JSON.parse(calls[index].data.arguments), step.arguments);
        if (step.expected?.code || step.expected?.pattern) {
          assert.equal(message.isError, true, text(message));
          if (step.expected.code)
            assert.equal(results[index].data.error?.code, step.expected.code, text(message));
          if (step.expected.pattern) assert.match(text(message), step.expected.pattern);
        } else {
          assert.equal(message.isError, false, text(message));
          if (typeof step.expected === "string")
            for (const line of step.expected.split("\n"))
              assert.ok(text(message).includes(line), text(message));
        }
        toolCalls.push({
          sessionId: agent.id,
          callId: calls[index].data.callId,
          pairedResultCallId: message.toolCallId,
          name: step.name,
          path: relative(f.directory, step.arguments.file_path),
          ...(step.arguments.sandbox_permissions
            ? { requestedMode: step.arguments.sandbox_permissions }
            : {}),
          isError: message.isError,
          ...(results[index].data.error?.code ? { code: results[index].data.error.code } : {}),
          resultTextSha256: hash(text(message)),
          result: "passed",
        });
      }
    };
    const actions = (program, final = "finish") => [
      ...program.map(({ name, arguments: args }) => [{ name, arguments: args }]),
      final,
    ];
    const root = async (name) => {
      const agent = await f.create(`permissions-${name}`, []);
      agents.push(agent);
      return agent;
    };
    const run = async (agent, program) => {
      const before = events(agent, "tool/call").length;
      const current = held.get(agent.id);
      if (current) {
        const next = heldResponse();
        f.script(agent.id, actions(program.slice(1), next.action));
        current.action.calls = [{ name: program[0].name, arguments: program[0].arguments }];
        held.set(agent.id, next);
        current.release();
        await next.entered;
      } else {
        f.script(agent.id, actions(program));
        await f.run(agent);
      }
      verifyProgram(agent, program, before);
    };
    const spawn = async (name, parent, program) => {
      const childId = `synthetic-permissions-${name}`;
      const gate = heldResponse();
      held.set(childId, gate);
      f.script(childId, actions(program, gate.action));
      const receipt = await f.ctx.subagents.startActivation({
        provider: "spawn",
        childId,
        label: "Synthetic delegated file permission acceptance",
        request: {
          parent,
          maxDepth: f.ctx.subagents.resolveMaxDepth(),
          agentPreset: "standard",
          prompt: [{ type: "text", text: "SYNTHETIC_DISPOSABLE_PERMISSION_TASK" }],
        },
        signal: new AbortController().signal,
        delivery: "caller",
      });
      receipts.push(receipt);
      const agent = f.ctx.agents.get(childId);
      assert.ok(agent, "The admitted child must be a real official Agent");
      agents.push(agent);
      assert.equal(agent.session.header.parentSession, parent.id);
      assert.equal(
        agent.session.header.delegationDepth,
        (parent.session.header.delegationDepth ?? 0) + 1,
      );
      assert.equal(f.ctx.agents.isOwnedBy(childId, parent), true);
      assert.equal(f.ctx.agentPresets.composedPreset(agent.ctx), "standard");
      const compositions = f.ctx.agentPresets.inspectCompositions(agent.ctx);
      assert.equal(compositions.length, 1);
      assert.deepEqual(compositions[0].leakedServices, []);
      assert.deepEqual(
        compositions[0].modules.map((row) => row.moduleName).sort(),
        f.composition.rows
          .filter((row) => row.enabled)
          .map((row) => row.moduleName)
          .sort(),
      );
      const revision = await f.ctx.agentPresets.acquireScope("standard");
      try {
        assert.equal(f.api.scope.scopeParentOf(f.api.scope.scopeOf(agent.ctx)), revision.key);
      } finally {
        await revision[Symbol.asyncDispose]();
      }
      await gate.entered;
      assert.equal(agent.status, "running");
      assert.equal(
        f.requests.filter((row) => row.sessionId === childId).length,
        program.length + 1,
      );
      verifyProgram(agent, program, 0);
      activations.push({
        childId,
        parentSessionId: parent.id,
        depth: agent.session.header.delegationDepth,
        provider: "spawn",
        officialReceipt: true,
        exactRetainedScopeIdentity: true,
        actualAgentLoop: true,
        holdingOnlyAtSyntheticModelTransport: true,
        disposed: false,
      });
      return agent;
    };
    const policy = (agent, mode, approval, current, label, delegated = false) => {
      assert.equal(f.ctx.sandboxPolicy.overrideOf(agent.session), mode);
      assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, mode);
      assert.equal(f.ctx.approval.overrideOf(agent.session), approval);
      assert.equal(f.ctx.permissionPresets.current(agent.session), current);
      const facts = agent.session.snapshotEvents().filter((row) => permissionTypes.has(row.type));
      if (delegated) {
        assert.deepEqual(
          facts
            .filter((row) => row.data.source === "delegation")
            .map((row) => [row.type, row.data]),
          [
            ["sandbox/mode", { mode, source: "delegation" }],
            ["approval/policy", { policy: "never", source: "delegation" }],
          ],
        );
      }
      policyObservations.push({
        label,
        sessionId: agent.id,
        mode,
        approval,
        current,
        ...(delegated ? { delegationFactsVerified: true } : {}),
        facts: facts.map(({ type, data }) => ({ type, data })),
      });
    };
    const disk = (path, expected) => {
      if (expected === undefined) assert.equal(existsSync(path), false);
      else assert.equal(readFileSync(path, "utf8"), expected);
      diskReadbacks.push({
        path: relative(f.directory, path),
        exists: expected !== undefined,
        ...(expected === undefined
          ? {}
          : { sha256: hash(readFileSync(path)), bytes: Buffer.byteLength(expected) }),
        result: "passed",
      });
    };
    const mutation = (path, marker) => [
      write(path, `${marker}_CREATED`),
      edit(path, "CREATED", "EDITED"),
      read(path, `${marker}_EDITED`),
    ];
    const scenario = async (id, action) => {
      await t.test(id, async () => {
        await action();
        cases.push({ id, result: "passed" });
      });
    };
    let parent, fullChild, restrictedChild, readOnlyParent, readOnlyChild;
    try {
      f.settings.permissionDefault = "danger-full-access";
      f.settings.fullAccess = true;
      f.settings.autoApprove = true;
      f.settings.maxDepth = 3;
      f.settings.maxSubagents = 8;
      assert.equal(f.adapter.permissionDefaults.status().active, true);
      assert.equal(f.ctx.permissionPresets.catalog().defaultPreset, "danger-full-access");
      await scenario("PERMISSION-FULL-DEFAULT-CHILD-AND-GRANDCHILD", async () => {
        parent = await root("full-default");
        policy(parent, "danger-full-access", "never", "danger-full-access", "fresh-default");
        assert.deepEqual(
          parent.session
            .snapshotEvents()
            .filter((row) => permissionTypes.has(row.type))
            .map(({ type, data }) => [type, data]),
          [
            ["permission/preset", { preset: "danger-full-access" }],
            ["sandbox/mode", { mode: "danger-full-access" }],
            ["approval/policy", { policy: "never" }],
          ],
        );
        const parentPath = join(outside, "full-parent.txt");
        await run(parent, mutation(parentPath, "SYNTHETIC_FULL_PARENT"));
        disk(parentPath, "SYNTHETIC_FULL_PARENT_EDITED");
        const childPath = join(outside, "full-child.txt");
        fullChild = await spawn("full-child", parent, mutation(childPath, "SYNTHETIC_FULL_CHILD"));
        policy(fullChild, "danger-full-access", "never", "danger-full-access", "full-child", true);
        disk(childPath, "SYNTHETIC_FULL_CHILD_EDITED");
        const grandchildPath = join(outside, "full-grandchild.txt");
        const grandchild = await spawn(
          "full-grandchild",
          fullChild,
          mutation(grandchildPath, "SYNTHETIC_FULL_GRANDCHILD"),
        );
        policy(
          grandchild,
          "danger-full-access",
          "never",
          "danger-full-access",
          "full-grandchild",
          true,
        );
        disk(grandchildPath, "SYNTHETIC_FULL_GRANDCHILD_EDITED");
      });
      await scenario("PERMISSION-OFFICIAL-UI-SWITCH-AND-START-TIME-SNAPSHOT", async () => {
        f.ctx.permissionPresets.set(parent.session, "workspace-write");
        policy(parent, "workspace-write", "ask", "workspace-write", "parent-ui-restricted");
        assert.equal(f.ctx.permissionPresets.catalog().defaultPreset, "danger-full-access");
        const parentDenied = join(outside, "parent-after-ui-denied.txt");
        await run(parent, [
          read(outsideSeed, seedText),
          write(parentDenied, "DENIED", denied),
          edit(outsideSeed, "TAIL", "DENIED", denied),
        ]);
        disk(parentDenied);
        disk(outsideSeed, seedText);
        policy(
          fullChild,
          "danger-full-access",
          "never",
          "danger-full-access",
          "existing-child-retains-start-snapshot",
          true,
        );
        const retainedPath = join(outside, "existing-child-retained.txt");
        await run(fullChild, mutation(retainedPath, "SYNTHETIC_RETAINED_CHILD"));
        disk(retainedPath, "SYNTHETIC_RETAINED_CHILD_EDITED");
        f.ctx.permissionPresets.set(fullChild.session, "workspace-write");
        policy(fullChild, "workspace-write", "ask", "workspace-write", "child-ui-restricted");
        const childDenied = join(outside, "child-after-ui-denied.txt");
        await run(fullChild, [
          read(outsideSeed, seedText),
          write(childDenied, "DENIED", denied),
          edit(outsideSeed, "TAIL", "DENIED", denied),
        ]);
        disk(childDenied);
        disk(outsideSeed, seedText);
        const childInside = join(f.workspace, "workspace-child.txt");
        const newChildDenied = join(outside, "new-workspace-child-denied.txt");
        restrictedChild = await spawn("workspace-child", parent, [
          ...mutation(childInside, "SYNTHETIC_WORKSPACE_CHILD"),
          read(outsideSeed, seedText),
          write(newChildDenied, "DENIED", denied),
          edit(outsideSeed, "TAIL", "DENIED", denied),
        ]);
        policy(
          restrictedChild,
          "workspace-write",
          "never",
          "custom",
          "future-child-inherits-current-parent",
          true,
        );
        disk(childInside, "SYNTHETIC_WORKSPACE_CHILD_EDITED");
        disk(newChildDenied);
        disk(outsideSeed, seedText);
      });
      await scenario("PERMISSION-EXPLICIT-READONLY-OVERRIDES-PLUGIN-FULLACCESS", async () => {
        readOnlyParent = await root("explicit-readonly");
        f.api.sandboxPolicy.setSandboxMode(readOnlyParent.session, "read-only");
        policy(readOnlyParent, "read-only", "never", "custom", "explicit-readonly-parent");
        const parentInside = join(f.workspace, "readonly-parent-denied.txt");
        await run(readOnlyParent, [
          read(outsideSeed, seedText),
          write(parentInside, "DENIED", denied),
          edit(outsideSeed, "TAIL", "DENIED", denied),
        ]);
        disk(parentInside);
        disk(outsideSeed, seedText);
        const childInside = join(f.workspace, "readonly-child-denied.txt");
        const childOutside = join(outside, "readonly-child-denied.txt");
        readOnlyChild = await spawn("readonly-child", readOnlyParent, [
          read(f.sourceFile, f.content),
          read(outsideSeed, seedText),
          write(childInside, "DENIED", denied),
          write(childOutside, "DENIED", denied),
          edit(outsideSeed, "TAIL", "DENIED", denied),
        ]);
        policy(readOnlyChild, "read-only", "never", "custom", "readonly-child", true);
        disk(childInside);
        disk(childOutside);
        disk(outsideSeed, seedText);
        const grandchildDenied = join(f.workspace, "readonly-grandchild-denied.txt");
        const grandchild = await spawn("readonly-grandchild", readOnlyChild, [
          read(outsideSeed, seedText),
          write(grandchildDenied, "DENIED", denied),
        ]);
        policy(grandchild, "read-only", "never", "custom", "readonly-grandchild", true);
        disk(grandchildDenied);
      });
      await scenario("PERMISSION-PARENT-REJECTED-AND-DELEGATED-NEVER-CANNOT-ESCALATE", async () => {
        const escalation = {
          sandbox_permissions: "danger-full-access",
          justification: "SYNTHETIC_UNAUTHORIZED_WIDER_REQUEST",
        };
        const rejected = { pattern: /user rejected/ };
        const parentDenied = join(outside, "parent-escalation-denied.txt");
        const beforeParent = approvalRequests.length;
        await run(parent, [write(parentDenied, "DENIED", rejected, escalation)]);
        assert.equal(approvalRequests.length, beforeParent + 1);
        assert.deepEqual(approvalRequests.at(-1), { sessionId: parent.id, toolName: "write" });
        disk(parentDenied);
        policy(
          parent,
          "workspace-write",
          "ask",
          "workspace-write",
          "parent-after-rejected-escalation",
        );
        const beforeChildren = approvalRequests.length;
        const childDenied = join(outside, "child-escalation-denied.txt");
        await run(restrictedChild, [write(childDenied, "DENIED", rejected, escalation)]);
        disk(childDenied);
        policy(
          restrictedChild,
          "workspace-write",
          "never",
          "custom",
          "workspace-child-after-rejected-escalation",
          true,
        );
        const readOnlyDenied = join(f.workspace, "readonly-child-escalation-denied.txt");
        await run(readOnlyChild, [
          write(readOnlyDenied, "DENIED", rejected, {
            sandbox_permissions: "workspace-write",
            justification: "SYNTHETIC_UNAUTHORIZED_WORKSPACE_REQUEST",
          }),
        ]);
        disk(readOnlyDenied);
        assert.equal(
          approvalRequests.length,
          beforeChildren,
          "delegated never must reject before contacting the answerer",
        );
        policy(
          readOnlyChild,
          "read-only",
          "never",
          "custom",
          "readonly-child-after-rejected-escalation",
          true,
        );
        for (const agent of [parent, restrictedChild, readOnlyChild]) {
          const audit = agent.session
            .snapshotEvents()
            .filter((row) => ["approval/asked", "approval/decided"].includes(row.type));
          assert.equal(audit.length, 2);
          assert.equal(audit[0].type, "approval/asked");
          assert.equal(audit[1].type, "approval/decided");
          assert.equal(audit[0].data.id, audit[1].data.id);
          assert.equal(audit[1].data.outcome, "rejected");
        }
      });
      assert.equal(cases.length, 4);
      stopAnswerer();
      f.adapter.revert();
      for (const receipt of receipts.toReversed()) {
        held.get(receipt.childId).release();
        const result = await receipt.result;
        assert.equal(result.stopReason, "completed");
        await receipt.dispose();
        assert.equal(f.ctx.agents.get(receipt.childId), undefined);
        assert.equal(f.ctx.sessions.get(receipt.childId), undefined);
        Object.assign(
          activations.find((row) => row.childId === receipt.childId),
          {
            disposed: true,
            stopReason: result.stopReason,
          },
        );
      }
      receipts.length = 0;
      await f.ctx.sessionPersistence.flush();
      const logRoot = join(f.directory, "logs");
      const physicalLogs = readdirSync(logRoot, { recursive: true }).filter((path) =>
        path.endsWith(".jsonl"),
      );
      assert.equal(physicalLogs.length, agents.length);
      for (const agent of agents) {
        const snapshot = agent.session.snapshotEvents();
        const reader = await f.ctx.sessionPersistence.open(agent.id, "read");
        try {
          const stored = await reader.read();
          assert.deepEqual(stored.events, snapshot);
        } finally {
          await reader.close();
        }
        const matches = physicalLogs
          .map((path) => {
            const bytes = readFileSync(join(logRoot, path));
            const records = bytes
              .toString("utf8")
              .trimEnd()
              .split("\n")
              .map((line) => JSON.parse(line));
            return { path, bytes, records };
          })
          .filter((row) => row.records[0].id === agent.id);
        assert.equal(matches.length, 1);
        const physical = matches[0];
        assert.equal(physical.records.length, snapshot.length + 1);
        assert.deepEqual(
          physical.records
            .slice(1)
            .filter((row) => permissionTypes.has(row.type))
            .map(({ type, data }) => ({ type, data })),
          snapshot
            .filter((row) => permissionTypes.has(row.type))
            .map(({ type, data }) => ({ type, data })),
        );
        jsonlReadbacks.push({
          sessionId: agent.id,
          events: snapshot.length,
          eventsSha256: hash(JSON.stringify(snapshot)),
          file: ["<synthetic-workspace>", ...physical.path.split(sep).slice(1)].join("/"),
          fileSha256: hash(physical.bytes),
          physicalRecords: physical.records.length,
          physicalPermissionFactsEqual: true,
          officialDecodedEventsEqual: true,
          toolCalls: events(agent, "tool/call").length,
          approvalOutcomes: events(agent, "approval/decided").map((row) => row.data.outcome),
        });
      }
      assert.deepEqual(f.errors, []);
      assert.deepEqual(lifecycle.started.toSorted(), activations.map((row) => row.childId).sort());
      assert.deepEqual(lifecycle.ended.toSorted(), lifecycle.started.toSorted());
    } finally {
      for (const receipt of receipts.toReversed()) await receipt.dispose();
      await f.dispose();
    }
    assert.deepEqual(lifecycle.disposed.toSorted(), lifecycle.created.toSorted());
    const fixtureEvidence = f.evidence();
    assert.equal(fixtureEvidence.isolation.rootsRemoved, true);
    assert.equal(fixtureEvidence.isolation.guardsHeldThroughOfficialLifecycle, true);
    assert.deepEqual(fixtureEvidence.isolation.networkAttempts, []);
    assert.deepEqual(fixtureEvidence.isolation.subprocessAttempts, []);
    assert.deepEqual(fixtureEvidence.isolation.filesystemAttempts, []);
    const evidence = {
      schemaVersion: 1,
      behaviorId: "CORE-PERMISSION",
      status: "partial-official-isolation",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      workingTreeEvidence: true,
      command:
        "DSH_UNLIMIT_RUNTIME=<official-runtime> DSH_UNLIMIT_OFFICIAL_PACKAGES=<verified-archives> DSH_UNLIMIT_SUBAGENT_PERMISSIONS_EVIDENCE=1 <bundled-node> --expose-internals --test tests/subagent-permissions-host.test.mjs",
      ...fixtureEvidence,
      cases,
      activations,
      policyObservations,
      toolCalls,
      diskReadbacks,
      jsonlReadbacks,
      approval: {
        syntheticAnswererRequests: approvalRequests,
        delegatedAnswererRequests: 0,
        allOutcomes: "rejected",
      },
      lifecycle,
      calls: {
        syntheticModelRequests: f.requests.length,
        agentLoopToolCalls: toolCalls.length,
        directToolRuntimeCalls: 0,
        byTool: toolCalls.reduce(
          (counts, row) => ({ ...counts, [row.name]: (counts[row.name] ?? 0) + 1 }),
          {},
        ),
      },
      testResult: { tests: cases.length + 1, passed: cases.length + 1, failed: 0, skipped: 0 },
      sourceDigests: [
        "tests/subagent-permissions-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "tests/fixtures/official-preset-packages.json",
        "src/host/runtime.js",
        "src/host/permission-defaults.js",
        "src/host/native-instructions.js",
        "src/host/prompt-refresh.js",
      ].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) })),
      boundaries: {
        completeStandardPresetMounted: true,
        actualOfficialPermissionPresets: true,
        syntheticConfigDirectoryPointsToOfficialFiber: true,
        actualOfficialUiSetMethod: true,
        actualInProcessSpawn: true,
        actualNestedSpawn: true,
        actualAgentLoopAndToolRuntime: true,
        actualSandboxedAndLocalFilesystem: true,
        actualJsonlAndDiskReadback: true,
        exactAncestorAndPlatformTemporaryRootMetadataOnly: true,
        parentPermissionCapturedAtStartupNotRetroactivelyRevoked: true,
        readsOutsideWorkspaceAllowedByOfficialContract: true,
        fullAccessDoesNotOverrideExplicitLimits: true,
        realDesktopExecuted: false,
        realModelExecuted: false,
        realProfileLoaded: false,
        kernelSandboxExecuted: false,
        ptyOrShellExecuted: false,
        modelSubagentToolDispatchExecuted: false,
        forkOrColdRestoreExecuted: false,
      },
      limitations: [
        "The model transport and parent rejection answerer are synthetic; official spawn, AgentLoop, permission, approval, file tools and persistence execute for real.",
        "Permissions are captured when a child starts; a later parent UI change does not revoke the already-started child's snapshot. A direct child UI set and later child creation are both verified.",
        "Delegation pins approval never; a restricted workspace-write/never child derives Custom rather than the workspace-write/ask preset identity.",
        "Official read-only and workspace-write constrain mutations and permit outside-workspace reads allowed by the local backend.",
        "The fixture permits exact synthetic-root ancestor stat and exact platform temporary-root stat/realpath for official containment checks. It permits no ancestor enumeration, file contents or writes; this is not a claim of zero metadata reads outside the synthetic root.",
        "No real installation, profile, Session history, renderer selector, model network, subprocess, PTY, kernel process sandbox, fork or cold restore was exercised.",
      ],
    };
    if (process.env.DSH_UNLIMIT_SUBAGENT_PERMISSIONS_EVIDENCE === "1")
      writeFileSync(
        join(presetProjectRoot, "docs/evidence/subagent-permissions-acceptance.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
    t.diagnostic(
      `${activations.length} real spawned children/grandchildren; ${toolCalls.length} AgentLoop file calls; ${jsonlReadbacks.length} physical JSONL files verified; synthetic model transport only.`,
    );
  },
);
