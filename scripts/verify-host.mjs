#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopRuntime } from "../src/host/runtime.js";
import { SUPPORTED_HOST } from "../src/host/desktop.js";

const argIndex = process.argv.indexOf("--runtime");
if (argIndex < 0 || !process.argv[argIndex + 1]) {
  console.error("用法: node scripts/verify-host.mjs --runtime <官方 app/dsh 运行时目录>");
  process.exitCode = 2;
} else {
  const runtimeRoot = resolve(process.argv[argIndex + 1]);
  const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  const requireFromRuntime = createRequire(join(runtimeRoot, "package.json"));
  const modules = [];
  const load = async (name) => {
    const filename = requireFromRuntime.resolve(name);
    const expected = descriptor.files.find((file) => file.path === relative(runtimeRoot, filename));
    assert.ok(expected, `宿主清单缺少 ${name} 入口，不能认定为官方原始模块`);
    const actual = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(actual, expected.sha256, `${name} 入口摘要不匹配，拒绝作为干净官方证据`);
    modules.push({ name, entrySha256: actual, matchesManifest: true });
    return import(pathToFileURL(filename).href);
  };
  const [
    { Context },
    { SystemPrompt, renderPrompt, renderContextSnapshot },
    { ApprovalService },
    { SandboxPolicyService },
    { SessionProjectionRegistry },
    { Session, SESSION_FORMAT_VERSION },
    { createScope },
    { SubagentRuntime },
    { createVolatile, updateVolatile },
  ] = await Promise.all([
    load("@deepseek-ai/cordis"),
    load("@deepseek-ai/dsh-system-prompt"),
    load("@deepseek-ai/dsh-user-approval"),
    load("@deepseek-ai/dsh-sandbox-policy"),
    load("@deepseek-ai/dsh-session-projection"),
    load("@deepseek-ai/dsh-session"),
    load("@deepseek-ai/dsh-scope"),
    load("@deepseek-ai/dsh-subagent"),
    load("@deepseek-ai/cosmokit"),
  ]);
  const result = {
    hostVersion: descriptor.release.version,
    targetVersion: SUPPORTED_HOST,
    environment: "isolated-cordis-official-services",
    integrityScope:
      "directly imported module entry files; transitive dependencies not exhaustively hashed",
    modules,
    realProfileRead: false,
    modelRequests: 0,
    installedFilesChanged: false,
    checks: [],
  };
  const check = async (name, fn) => {
    try {
      await fn();
      result.checks.push({ name, passed: true });
    } catch (error) {
      result.checks.push({ name, passed: false, error: error.message });
    }
  };
  const ctx = new Context();
  const settings = {
    enabled: false,
    prompt: "SYNTHETIC_OPERATOR_A",
    promptMode: "replace",
    workspacePolicy: "fallback",
    workspaceFiles: [],
    autoApprove: true,
    fullAccess: true,
    maxDepth: 10,
    maxSubagents: 16,
  };
  const library = { items: [], activeId: null };
  const store = {
    dispatch(action) {
      if (action === "settings.get") return { value: settings };
      if (action === "rules.list") return library;
      throw new Error(`Unexpected test action ${action}`);
    },
  };
  let runtime, owner, consumer, consumerCtx, parentScope, childScope;
  const settle = async (fiber) => {
    while (fiber?.inertia) await fiber.inertia;
  };
  const dispose = async (fiber) => {
    if (!fiber) return;
    await fiber.dispose();
    await settle(fiber);
  };
  try {
    owner = ctx.plugin({
      name: "dsh-unlimit-isolated-verification",
      apply(scope) {
        new SystemPrompt(scope, {
          includeHarnessIdentity: true,
          includeRuntimeContext: true,
          personaPrefix: "OFFICIAL_PERSONA",
          personaSuffix: "",
        });
        new SessionProjectionRegistry(scope);
        new SubagentRuntime(scope, {
          maxDepth: createVolatile(3),
          maxActiveSubagents: createVolatile(4),
        });
        new ApprovalService(scope, { policy: "ask" });
        new SandboxPolicyService(scope, {
          mode: "read-only",
          workspaceRoot: "/synthetic-workspace",
        });
      },
    });
    await settle(owner);
    assert.ok(
      ctx.systemPrompt && ctx.approval && ctx.sandboxPolicy,
      "official services must be installed",
    );
    consumer = ctx.plugin({
      name: "dsh-unlimit-synthetic-consumer",
      inject: ["systemPrompt", "approval", "sandboxPolicy", "subagents"],
      apply(scope) {
        consumerCtx = scope;
      },
    });
    await settle(consumer);
    assert.ok(consumerCtx, "injected synthetic consumer must load");
    runtime = new DesktopRuntime(consumerCtx, store, {
      supported: descriptor.release.version === SUPPORTED_HOST,
      version: descriptor.release.version,
    });
    const session = Session.create("dsh-unlimit-synthetic-session", undefined, {
      version: SESSION_FORMAT_VERSION,
      id: "dsh-unlimit-synthetic-session",
      createdAt: 0,
      isSeeded: false,
      cwd: "/synthetic-workspace",
    });
    const agent = { session, options: { model: "synthetic-model" }, ctx };
    session.append("turn/start", { turn: 0 });
    const originalRequestDescriptor = Object.getOwnPropertyDescriptor(ctx.approval, "request");
    const originalSubagentDepth = Object.getOwnPropertyDescriptor(ctx.subagents.config, "maxDepth");
    const originalSubagentCount = Object.getOwnPropertyDescriptor(
      ctx.subagents.config,
      "maxActiveSubagents",
    );
    ctx.systemPrompt.section({
      name: "synthetic-complete",
      order: 0,
      complete: true,
      text: "OFFICIAL_{{synthetic_value}}",
    });
    ctx.systemPrompt.variable("synthetic_value", () => "COMPLETE");
    ctx.systemPrompt.context({
      name: "synthetic-runtime",
      order: 999,
      text: "SYNTHETIC_RUNTIME_CONTEXT",
      required: true,
    });
    ctx.systemPrompt.tools(() => ({
      schemas: [
        {
          name: "synthetic-tool",
          description: "No execution implementation",
          parameters: {
            type: "object",
            properties: { target: { type: "string" } },
            required: ["target"],
          },
        },
      ],
    }));
    await check("version gate matches explicitly supported desktop version", () =>
      assert.equal(descriptor.release.version, SUPPORTED_HOST),
    );
    await check("official SubagentRuntime owns actual frozen volatile references", () => {
      assert.equal(ctx.subagents instanceof SubagentRuntime, true);
      assert.equal(Object.isFrozen(originalSubagentDepth.value), true);
      assert.equal(Object.isFrozen(originalSubagentCount.value), true);
    });
    await check(
      "disabled runtime preserves official complete section and tool/context assembly",
      async () => {
        runtime.apply();
        const output = await ctx.systemPrompt.assemble({ agent });
        assert.equal(renderPrompt(output), "OFFICIAL_COMPLETE");
        assert.equal(output.tools[0].name, "synthetic-tool");
        assert.match(renderContextSnapshot(output), /SYNTHETIC_RUNTIME_CONTEXT/);
      },
    );
    await check(
      "enabled replacement wins after official complete enforcement without losing schemas/context",
      async () => {
        settings.enabled = true;
        const output = await ctx.systemPrompt.assemble({ agent });
        assert.equal(renderPrompt(output), "SYNTHETIC_OPERATOR_A");
        assert.equal(output.tools[0].parameters.properties.target.type, "string");
        assert.match(renderContextSnapshot(output), /SYNTHETIC_RUNTIME_CONTEXT/);
      },
    );
    await check(
      "next assembly observes edited prompt and model-specific rule over active rule",
      async () => {
        settings.prompt = "SYNTHETIC_OPERATOR_B";
        assert.equal(
          renderPrompt(await ctx.systemPrompt.assemble({ agent })),
          "SYNTHETIC_OPERATOR_B",
        );
        library.items.push(
          { id: "global", content: "SYNTHETIC_GLOBAL" },
          { id: "model", model: "synthetic-model", content: "SYNTHETIC_MODEL" },
        );
        library.activeId = "global";
        assert.equal(renderPrompt(await ctx.systemPrompt.assemble({ agent })), "SYNTHETIC_MODEL");
        library.items[1].content = "SYNTHETIC_MODEL_CHANGED";
        assert.equal(
          renderPrompt(await ctx.systemPrompt.assemble({ agent })),
          "SYNTHETIC_MODEL_CHANGED",
        );
      },
    );
    await check("append mode preserves official prompt variable interpolation", async () => {
      settings.promptMode = "append";
      try {
        assert.equal(
          renderPrompt(await ctx.systemPrompt.assemble({ agent })),
          "OFFICIAL_COMPLETE\n\nSYNTHETIC_MODEL_CHANGED",
        );
      } finally {
        settings.promptMode = "replace";
      }
    });
    await check(
      "official approval request retains paired audit around automatic decision",
      async () => {
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(ctx.approval, "request"),
          originalRequestDescriptor,
        );
        const before = session.seq;
        assert.equal(
          await ctx.approval.request({
            agent,
            toolName: "synthetic-tool",
            reason: "Local synthetic verification",
          }),
          "allowed-once",
        );
        const pair = session.snapshotEvents(before);
        assert.deepEqual(
          pair.map((e) => e.type),
          ["approval/asked", "approval/decided"],
        );
        assert.equal(pair[0].data.id, pair[1].data.id);
        assert.equal(pair[1].data.outcome, "allowed-once");
      },
    );
    await check("cancelled official approval is audited and never converted to grant", async () => {
      const controller = new AbortController();
      controller.abort();
      const before = session.seq;
      assert.equal(
        await ctx.approval.request({
          agent,
          toolName: "synthetic-tool",
          signal: controller.signal,
        }),
        "cancelled",
      );
      assert.deepEqual(
        session.snapshotEvents(before).map((e) => e.type),
        ["approval/asked", "approval/decided"],
      );
      assert.equal(session.snapshotEvents(before)[1].data.outcome, "cancelled");
    });
    await check(
      "official sandbox only changes with enabled plus fullAccess and preserves session root",
      () => {
        settings.enabled = false;
        assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, "read-only");
        settings.enabled = true;
        settings.fullAccess = false;
        assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, "read-only");
        settings.fullAccess = true;
        assert.deepEqual(ctx.sandboxPolicy.resolve({ session }), {
          mode: "danger-full-access",
          workspaceRoot: "/synthetic-workspace",
          sessionId: session.id,
        });
      },
    );
    await check(
      "official frozen subagent refs use dynamic depth/count, preserve owner updates and disable correctly",
      () => {
        assert.equal(ctx.subagents.config.maxDepth.get(), 10);
        assert.equal(ctx.subagents.resolveMaxDepth(), 10);
        assert.equal(ctx.subagents.resolveMaxDepth("provider-managed"), undefined);
        assert.equal(ctx.subagents.config.maxActiveSubagents.get(), 16);
        settings.maxDepth = 7;
        settings.maxSubagents = 9;
        assert.equal(ctx.subagents.config.maxDepth.get(), 7);
        assert.equal(ctx.subagents.resolveMaxDepth(), 7);
        assert.equal(ctx.subagents.config.maxActiveSubagents.get(), 9);
        updateVolatile(ctx.subagents.config.maxDepth, createVolatile(5));
        updateVolatile(ctx.subagents.config.maxActiveSubagents, createVolatile(6));
        settings.enabled = false;
        assert.equal(ctx.subagents.config.maxDepth.get(), 5);
        assert.equal(ctx.subagents.config.maxActiveSubagents.get(), 6);
        assert.equal(originalSubagentDepth.value.get(), 5);
        settings.enabled = true;
      },
    );
    await check(
      "nested child agent scope receives same prompt, approval and sandbox replacements",
      async () => {
        const parentKey = {},
          childKey = {};
        parentScope = createScope(consumerCtx, parentKey);
        childScope = createScope(parentScope.ctx, childKey, { parent: parentKey });
        const child = { session, options: { model: "synthetic-model" }, ctx: childScope.ctx };
        const output = await childScope.ctx.systemPrompt.assemble({
          agent: child,
          scope: childKey,
        });
        assert.equal(renderPrompt(output), "SYNTHETIC_MODEL_CHANGED");
        assert.equal(
          await childScope.ctx.approval.request({ agent: child, toolName: "synthetic-tool" }),
          "allowed-once",
        );
        assert.equal(childScope.ctx.sandboxPolicy.resolve({ session }).mode, "danger-full-access");
      },
    );
    await check(
      "repeated apply is stable and revert restores official complete prompt and rejection",
      async () => {
        runtime.apply();
        runtime.apply();
        assert.equal(
          renderPrompt(await ctx.systemPrompt.assemble({ agent })),
          "SYNTHETIC_MODEL_CHANGED",
        );
        runtime.revert();
        runtime.revert();
        assert.equal(renderPrompt(await ctx.systemPrompt.assemble({ agent })), "OFFICIAL_COMPLETE");
        assert.equal(
          await ctx.approval.request({ agent, toolName: "synthetic-tool" }),
          "unavailable",
        );
        assert.equal(ctx.sandboxPolicy.resolve({ session }).mode, "read-only");
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(ctx.subagents.config, "maxDepth"),
          originalSubagentDepth,
        );
        assert.deepEqual(
          Object.getOwnPropertyDescriptor(ctx.subagents.config, "maxActiveSubagents"),
          originalSubagentCount,
        );
      },
    );
    await check("unverified host version refuses runtime registration", () => {
      const unsupported = new DesktopRuntime(ctx, store, {
        supported: false,
        version: "synthetic-unverified",
      });
      assert.throws(() => unsupported.apply(), /拒绝应用/);
      assert.equal(unsupported.enabled, false);
    });
  } catch (error) {
    result.checks.push({ name: "isolated harness setup", passed: false, error: error.message });
  } finally {
    await check("runtime and Cordis fibers clean up without Context.dispose", async () => {
      runtime?.revert();
      await childScope?.dispose();
      await parentScope?.dispose();
      await dispose(consumer);
      await dispose(owner);
      await dispose(ctx.fiber);
      assert.equal(owner?.uid, null);
    });
  }
  result.passed = result.checks.every((c) => c.passed);
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
