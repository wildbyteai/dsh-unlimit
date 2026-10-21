import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { filePermissionsFixture, projectRoot } from "./helpers/file-permissions-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const optionalHost = {
  skip:
    runtimeRoot && cache
      ? false
      : "Set DSH_UNLIMIT_RUNTIME and DSH_UNLIMIT_OFFICIAL_PACKAGES for official escalation; no profile is loaded",
  timeout: 30000,
};

test(
  "official one-shot escalation over synthetic Sessions and real filesystem mutations",
  optionalHost,
  async (t) => {
    const f = await filePermissionsFixture(t, runtimeRoot, cache);
    const agent = await f.createAgent("escalation-main");
    f.api.approval.setApprovalPolicy(agent.session, "ask");
    agent.session.append("turn/start", { turn: 1 });
    const third = join(f.root, "third");
    mkdirSync(third);
    const captures = [],
      cases = [];
    let decision = "allowed-once";
    const answerer = agent.ctx.on("approval/request", (request) => {
      assert.equal(request.agent, agent, "approval is routed to the exact synthetic Agent");
      assert.equal(request.agent.session, agent.session);
      assert.equal(request.toolName, "write");
      assert.equal(typeof request.callId, "string");
      captures.push({
        fields: Object.keys(request).sort(),
        toolName: request.toolName,
        callId: request.callId,
        requestedMode: /to (\S+):/.exec(request.reason)?.[1],
        agentIdentityMatched: true,
      });
      return typeof decision === "function" ? decision(request) : decision;
    });
    const execute = (path, extra = {}, actor = agent, signal) =>
      f.execute(
        actor,
        "write",
        { file_path: path, content: "SYNTHETIC_ESCALATION_CONTENT", ...extra },
        signal,
      );
    const allow = {
      sandbox_permissions: "workspace-write",
      justification: "仅本次写入临时合成工作区",
    };
    const failed = (result, pattern, code) => {
      assert.equal(result.isError, true, f.text(result));
      if (pattern) assert.match(f.text(result), pattern);
      if (code) assert.equal(result.error?.info?.code, code);
    };
    const ok = (result) => assert.equal(result.isError, false, f.text(result));
    const audit = (actor = agent) =>
      actor.session
        .snapshotEvents()
        .filter((row) => ["approval/asked", "approval/decided"].includes(row.type));
    const verifyPairs = (actor = agent) => {
      const rows = audit(actor);
      assert.equal(rows.length % 2, 0);
      for (let i = 0; i < rows.length; i += 2) {
        assert.equal(rows[i].type, "approval/asked");
        assert.equal(rows[i + 1].type, "approval/decided");
        assert.equal(rows[i].data.id, rows[i + 1].data.id);
      }
      return rows;
    };
    const lastOutcome = () => audit().at(-1).data.outcome;
    const run = async (id, action) => {
      await t.test(id, async () => {
        await action();
        cases.push({ id, result: "passed" });
      });
    };
    let schema;
    await run("ESC-SCHEMA", async () => {
      const write = f.ctx.tools.schemas(agent).find((row) => row.name === "write");
      assert.deepEqual(write.parameters.properties.sandbox_permissions.enum, [
        "workspace-write",
        "danger-full-access",
      ]);
      assert.deepEqual(Object.keys(write.parameters.properties).sort(), [
        "content",
        "file_path",
        "justification",
        "sandbox_permissions",
      ]);
      assert.equal(write.parameters.additionalProperties, undefined);
      assert.equal(f.ctx.tools.get("request_permissions", agent), undefined);
      schema = {
        writeParameters: Object.keys(write.parameters.properties),
        escalationTargets: write.parameters.properties.sandbox_permissions.enum,
        additionalPropertiesKeyword: "omitted",
        undeclaredPropertiesRejectedBySchema: false,
        requestPermissionsRegisteredInThisComposition: false,
      };
    });
    await run("ESC-READONLY-TO-WORKSPACE", async () => {
      const target = join(f.workspace, "approved.txt");
      failed(await execute(target), /read-only mode/, "FS_SANDBOX_DENIED");
      assert.equal(existsSync(target), false);
      assert.equal(audit().length, 0);
      ok(await execute(target, allow));
      assert.equal(readFileSync(target, "utf8"), "SYNTHETIC_ESCALATION_CONTENT");
      assert.equal(lastOutcome(), "allowed-once");
      assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "read-only");
      assert.equal(
        f.ctx.sandboxPolicy.resolve({ session: agent.session }).workspaceRoot,
        f.workspace,
      );
    });
    await run("ESC-ROOT-NOT-EXTENDED-AND-TEMP-ALLOWED", async () => {
      for (const root of [f.outside, third]) {
        const target = join(root, "not-granted.txt");
        failed(await execute(target, allow), /workspace-write mode/, "FS_SANDBOX_DENIED");
        assert.equal(
          lastOutcome(),
          "allowed-once",
          "approval succeeded but the original workspace fence still denied",
        );
        assert.equal(existsSync(target), false);
      }
      const temporary = join(f.temporary, "native-temp-allowed.txt");
      ok(await execute(temporary, allow));
      assert.equal(readFileSync(temporary, "utf8"), "SYNTHETIC_ESCALATION_CONTENT");
      const undeclaredOutside = join(f.outside, "undeclared-root-still-denied.txt");
      failed(
        await execute(undeclaredOutside, { ...allow, additional_write_roots: [f.outside] }),
        /workspace-write mode/,
        "FS_SANDBOX_DENIED",
      );
      assert.equal(existsSync(undeclaredOutside), false);
      const undeclaredInside = join(f.workspace, "undeclared-field-ignored.txt");
      ok(await execute(undeclaredInside, { ...allow, additional_write_roots: [f.outside] }));
      assert.equal(readFileSync(undeclaredInside, "utf8"), "SYNTHETIC_ESCALATION_CONTENT");
      schema.undeclaredDirectoryFieldIgnoredByExecutor = true;
    });
    await run("ESC-ONE-SHOT-AND-AGENT-ISOLATION", async () => {
      const target = join(f.workspace, "next-call.txt");
      const before = captures.length;
      failed(await execute(target), /read-only mode/, "FS_SANDBOX_DENIED");
      assert.equal(captures.length, before);
      assert.equal(existsSync(target), false);
      ok(await execute(target, allow));
      assert.equal(captures.length, before + 1, "a new request must obtain a fresh approval");
      const other = await f.createAgent("escalation-other");
      f.api.approval.setApprovalPolicy(other.session, "ask");
      other.session.append("turn/start", { turn: 1 });
      const otherPath = join(f.workspace, "other-agent.txt");
      failed(await execute(otherPath, allow, other), /no approval channel is available/);
      assert.equal(captures.length, before + 1, "another Agent cannot consume the scoped answerer");
      assert.equal(verifyPairs(other).at(-1).data.outcome, "unavailable");
      assert.equal(existsSync(otherPath), false);
    });
    await run("ESC-REJECT-CANCEL-UNAVAILABLE", async () => {
      for (const [outcome, pattern] of [
        ["rejected", /user rejected/],
        ["cancelled", /was cancelled/],
        ["unavailable", /no approval channel is available/],
      ]) {
        decision = outcome;
        const target = join(f.workspace, `${outcome}.txt`);
        failed(await execute(target, allow), pattern);
        assert.equal(lastOutcome(), outcome);
        assert.equal(existsSync(target), false);
      }
      for (const [name, answer] of [
        [
          "throwing",
          () => {
            throw new Error("Synthetic answerer failure");
          },
        ],
        ["invalid", "allow-always"],
      ]) {
        decision = answer;
        const target = join(f.workspace, `${name}.txt`);
        failed(await execute(target, allow), /no approval channel is available/);
        assert.equal(lastOutcome(), "unavailable");
        assert.equal(existsSync(target), false);
      }
      decision = "allowed-once";
    });
    await run("ESC-PENDING-CANCEL-IGNORES-LATE-ALLOW", async () => {
      let release;
      decision = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const target = join(f.workspace, "late-allow.txt"),
        control = new AbortController();
      const pending = execute(target, allow, agent, control.signal);
      while (!release) await new Promise((resolve) => setImmediate(resolve));
      control.abort(new Error("Synthetic caller cancellation"));
      failed(await pending);
      release("allowed-once");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lastOutcome(), "cancelled");
      assert.equal(existsSync(target), false);
      decision = "allowed-once";
    });
    await run("ESC-PLUGIN-AUTOAPPROVE-OFF-AND-EXPLICIT-NEVER", async () => {
      f.settings.enabled = true;
      f.settings.fullAccess = false;
      f.settings.autoApprove = false;
      f.adapter.apply();
      decision = "rejected";
      const rejected = join(f.workspace, "plugin-rejected.txt");
      failed(await execute(rejected, allow), /user rejected/);
      assert.equal(lastOutcome(), "rejected");
      assert.equal(existsSync(rejected), false);
      f.settings.autoApprove = true;
      f.api.approval.setApprovalPolicy(agent.session, "never");
      const before = captures.length,
        never = join(f.workspace, "explicit-never.txt");
      decision = "allowed-once";
      failed(await execute(never, allow), /user rejected/);
      assert.equal(lastOutcome(), "rejected");
      assert.equal(
        captures.length,
        before,
        "never is enforced before the answerer and plugin autoApprove",
      );
      assert.equal(existsSync(never), false);
      f.adapter.revert();
      f.settings.enabled = false;
      f.settings.autoApprove = false;
      f.api.approval.setApprovalPolicy(agent.session, "ask");
    });
    await run("ESC-VALIDATION-AND-EQUAL-MODE", async () => {
      const before = captures.length;
      for (const [name, args] of [
        ["missing-reason", { sandbox_permissions: "workspace-write" }],
        ["reason-only", { justification: "Synthetic reason" }],
        ["empty-reason", { sandbox_permissions: "workspace-write", justification: " " }],
      ]) {
        const target = join(f.workspace, `${name}.txt`);
        failed(await execute(target, args));
        assert.equal(existsSync(target), false);
      }
      assert.equal(captures.length, before);
      const alreadyWritable = await f.createAgent("escalation-same-mode", "workspace-write");
      const target = join(f.workspace, "same-mode.txt");
      ok(await execute(target, allow, alreadyWritable));
      assert.equal(
        audit(alreadyWritable).length,
        0,
        "equal mode needs no approval, even without an open turn",
      );
      await assert.rejects(
        f.api.sandboxSeam.approveEscalation(
          {
            requestedMode: "read-only",
            effectiveMode: "workspace-write",
            justification: "Synthetic invalid narrower target",
            subject: "operation",
          },
          {},
        ),
        /not strictly wider/,
      );
    });
    await run("ESC-NO-APPROVER-AND-CLOSED-TURN", async () => {
      await assert.rejects(
        f.api.sandboxSeam.approveEscalation(
          {
            requestedMode: "workspace-write",
            effectiveMode: "read-only",
            justification: "Synthetic unavailable service",
            subject: "operation",
          },
          { agent },
        ),
        /no approval service is composed/,
      );
      const before = audit().length;
      agent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      await assert.rejects(
        f.ctx.approval.request({
          agent,
          toolName: "write",
          callId: "synthetic-outside-turn",
          reason: "Synthetic outside-turn request",
        }),
        /outside an open turn/,
      );
      assert.equal(audit().length, before);
    });
    assert.equal(cases.length, 9);
    const pairs = verifyPairs();
    assert.equal(
      new Set(pairs.filter((row) => row.type === "approval/asked").map((row) => row.data.id)).size,
      pairs.length / 2,
    );
    assert.equal(
      agent.session.snapshotEvents().filter((row) => row.type === "sandbox/mode").length,
      0,
      "one-shot escalation does not persist a sandbox mode grant",
    );
    answerer();
    await f.dispose();
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      behaviorId: "CORE-ESCALATION",
      status: "partial-official-isolation",
      target: "DSH desktop 0.2.1-rc.2",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      testResult: { tests: cases.length + 1, passed: cases.length + 1, failed: 0, skipped: 0 },
      ...f.evidence(),
      sourceDigests: [
        "tests/escalation-host.test.mjs",
        "tests/helpers/file-permissions-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/runtime.js",
        "src/host/permission-defaults.js",
      ].map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(join(projectRoot, path)))
          .digest("hex"),
      })),
      cases,
      schema,
      approval: {
        requestShapes: [
          ...new Map(captures.map((row) => [row.fields.join(","), row.fields])).values(),
        ],
        scopedAnswererRequests: captures.length,
        mainSessionAuditPairs: pairs.length / 2,
        mainSessionOutcomes: pairs
          .filter((row) => row.type === "approval/decided")
          .map((row) => row.data.outcome),
        exactAgentIdentityVerified: true,
        changedSandboxModeEvents: 0,
        lateApprovalIgnoredAfterCancellation: true,
      },
      supported:
        "One approved workspace-write retry in the original Session workspace plus platform temporary roots.",
      unsupported:
        "Authorizing a new arbitrary directory while confining third directories: no directory grant field or store is exposed by these official APIs.",
      limitations: [
        "No desktop UI, installation, reload, profile or real Session history was exercised.",
        "The answerer is synthetic; the official ApprovalService, audit events, file tools and filesystem provider execute for real.",
        "No subprocess, PTY, Bash or PowerShell command was executed; process-side escalation remains unverified.",
        "workspace-write retains the original Session workspaceRoot and includes native platform temporary roots; it is not a newly authorized directory grant.",
        "danger-full-access is an unconfined per-call mode, not a narrow directory grant; this regression does not exercise it.",
        "The one-shot approval does not persist sandbox mode state or provide a remembered grant store or rollback of completed file changes.",
      ],
    };
    if (process.env.DSH_UNLIMIT_ESCALATION_EVIDENCE === "1")
      writeFileSync(
        join(projectRoot, "docs/evidence/escalation-acceptance.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
