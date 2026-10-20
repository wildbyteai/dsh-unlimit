import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { Continuation } from "../src/host/continuation.js";
import { DesktopRuntime } from "../src/host/runtime.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const tick = () => new Promise((resolve) => setImmediate(resolve));

test(
  "official continuation uses attributed new turns, current prompt, bounded chains and real cancellation with JSONL readback",
  {
    skip: runtimeRoot
      ? false
      : "Set DSH_UNLIMIT_RUNTIME to official 0.2.1-rc.2; no user profile is loaded",
    timeout: 20000,
  },
  async (t) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-continuation-host-")));
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
    assert.equal(manifest.release.version, "0.2.1-rc.2");
    const requireHost = createRequire(join(runtimeRoot, "package.json"));
    const load = async (name) => {
      const path = requireHost.resolve(name),
        listed = manifest.files.find((file) => file.path === relative(runtimeRoot, path));
      assert.ok(listed, `Official entry not listed: ${name}`);
      assert.equal(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        listed.sha256,
        `Modified official entry: ${name}`,
      );
      return import(pathToFileURL(path).href);
    };
    let ctx, owner, persistenceFiber, continuation, runtime;
    let socketAttempts = 0;
    const savedConnect = Socket.prototype.connect;
    Socket.prototype.connect = function () {
      socketAttempts++;
      throw new Error("Continuation acceptance permits no network");
    };
    t.after(async () => {
      try {
        continuation?.revert();
        runtime?.revert();
        await owner?.dispose();
        await persistenceFiber?.dispose();
        await ctx?.fiber.dispose();
      } finally {
        Socket.prototype.connect = savedConnect;
        rmSync(directory, { recursive: true, force: true });
      }
    });
    const [
      cordis,
      prompt,
      projections,
      sessions,
      agents,
      llm,
      tools,
      loop,
      cosmokit,
      approval,
      sandbox,
      persistence,
    ] = await Promise.all([
      load("@deepseek-ai/cordis"),
      load("@deepseek-ai/dsh-system-prompt"),
      load("@deepseek-ai/dsh-session-projection"),
      load("@deepseek-ai/dsh-session"),
      load("@deepseek-ai/dsh-agent"),
      load("@deepseek-ai/dsh-llm"),
      load("@deepseek-ai/dsh-tools"),
      load("@deepseek-ai/dsh-agent-loop"),
      load("@deepseek-ai/cosmokit"),
      load("@deepseek-ai/dsh-user-approval"),
      load("@deepseek-ai/dsh-sandbox-policy"),
      load("@deepseek-ai/dsh-session-persistence-jsonl"),
    ]);
    const value = {
      enabled: true,
      prompt: "SYNTHETIC_PROMPT_A",
      promptMode: "replace",
      workspacePolicy: "strict",
      workspaceFiles: [],
      fullAccess: false,
      autoApprove: false,
      maxDepth: 3,
      maxSubagents: 3,
      autoContinue: false,
      continueLimit: 2,
      continueText: "Synthetic continuation wording",
    };
    const store = {
      dispatch(action) {
        if (action === "settings.get") return { value };
        if (action === "rules.list") return { items: [], activeId: null };
        throw new Error(`Unexpected action ${action}`);
      },
    };
    const plans = new Map(),
      requests = new Map(),
      live = new Map(),
      heldSignals = new Map();
    class SyntheticAdapter extends llm.LlmAdapter {
      async *stream(options) {
        const seen = requests.get(options.sessionId) ?? [];
        seen.push(options);
        requests.set(options.sessionId, seen);
        const plan = plans.get(options.sessionId),
          outcome = plan.outcomes[Math.min(seen.length - 1, plan.outcomes.length - 1)];
        if (outcome === "hold") {
          heldSignals.set(options.sessionId, options.signal);
          plan.started.resolve();
          await new Promise((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", resolve, { once: true });
          });
          options.signal.throwIfAborted();
        }
        if (!["stop", "max-tokens"].includes(outcome))
          throw new llm.LlmError("Synthetic model error", outcome);
        yield { type: "text-delta", index: 0, text: "Synthetic visible reply." };
        yield { type: "finish", reason: { kind: outcome } };
      }
    }
    ctx = new cordis.Context();
    owner = ctx.plugin({
      name: "synthetic-continuation-services",
      apply(scope) {
        new prompt.SystemPrompt(scope, {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: "SYNTHETIC_HOST",
          personaSuffix: "",
        });
        new projections.SessionProjectionRegistry(scope);
        new sessions.SessionStore(scope);
        new agents.AgentRegistry(scope);
        new llm.LlmRuntime(scope);
        new tools.ToolRuntime(scope);
        new approval.ApprovalService(scope, { policy: "ask" });
        new sandbox.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: directory });
        new loop.AgentLoop(scope, { agents: [], maxParallelToolCalls: cosmokit.createVolatile(1) });
        scope.llm.registerAdapter(["synthetic"], new SyntheticAdapter());
      },
    });
    await owner.await();
    persistenceFiber = ctx.plugin(persistence, {
      root: directory,
      compression: "none",
      listConcurrency: 1,
    });
    await persistenceFiber.await();
    const host = { supported: true, version: "0.2.1-rc.2", runtimeRoot };
    runtime = new DesktopRuntime(ctx, store, host);
    runtime.apply();
    continuation = new Continuation(ctx, store, host);
    await continuation.apply();
    await continuation.apply();
    const create = async (id, plan) => {
      plans.set(id, plan);
      const agent = await ctx.agentLoop.create(
        id,
        { provider: "synthetic", model: "fixture", maxTokens: 64 },
        { cwd: directory },
      );
      live.set(id, agent);
      return agent;
    };
    const sendHuman = (agent, text = "Synthetic human task") =>
      agent.followup(
        llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }),
      );
    const drain = async (agent) => {
      for (let attempt = 0; attempt < 25; attempt++) {
        await agent.whenIdle();
        await tick();
        if (
          agent.status === "idle" &&
          !continuation.status({ sessionId: agent.session.id }).pending &&
          !agent.inbox.hasPending
        )
          return;
      }
      assert.fail(
        JSON.stringify({
          id: agent.session.id,
          status: agent.status,
          queue: agent.inbox.nextTurn.map((m) => m.source),
          continuation: continuation.status({ sessionId: agent.session.id }),
          events: agent.session
            .snapshotEvents()
            .filter((e) => ["turn/start", "turn/end", "user/message"].includes(e.type))
            .map((e) => ({
              seq: e.seq,
              type: e.type,
              reason: e.data.reason,
              source: e.data.source,
            })),
        }),
      );
    };
    const custom = (agent) =>
      agent.session
        .snapshotEvents()
        .filter(
          (event) =>
            event.type === "user/message" && event.data.source.kind === "dsh-unlimit/continuation",
        );

    const manual = await create("manual", { outcomes: ["max-tokens", "stop"] });
    sendHuman(manual);
    await drain(manual);
    assert.equal(requests.get("manual").length, 1, "automatic continuation is off by default");
    value.prompt = "SYNTHETIC_PROMPT_B";
    value.continueText = "Synthetic updated continuation wording";
    const manualResult = continuation.continue({ sessionId: "manual" });
    await drain(manual);
    assert.equal(manualResult.source.mode, "manual");
    assert.equal(requests.get("manual").length, 2);
    assert.equal(custom(manual).length, 1);
    assert.equal(custom(manual)[0].data.content[0].text, value.continueText);
    assert.ok(
      requests
        .get("manual")[1]
        .messages.some(
          (message) =>
            message.role === "system" &&
            message.content.some(
              (block) => block.type === "text" && block.text === "SYNTHETIC_PROMPT_B",
            ),
        ),
    );
    assert.equal(
      manual.session
        .snapshotEvents()
        .filter((event) => event.type === "user/message" && event.data.source.kind === "user")
        .length,
      1,
      "generated continuation never becomes a second human input",
    );

    value.autoContinue = true;
    const bounded = await create("bounded", { outcomes: ["max-tokens"] });
    sendHuman(bounded);
    await drain(bounded);
    assert.equal(requests.get("bounded").length, 3);
    assert.equal(custom(bounded).length, 2);
    await tick();
    assert.equal(requests.get("bounded").length, 3, "the settled chain cannot bypass its limit");
    continuation.revert();
    await continuation.apply();
    assert.equal(
      continuation.status({ sessionId: "bounded" }).automaticCount,
      2,
      "reapply reconstructs the count from attributed inbox history",
    );
    continuation.continue({ sessionId: "bounded" });
    await drain(bounded);
    assert.equal(requests.get("bounded").length, 4);
    assert.equal(
      custom(bounded).filter((event) => event.data.source.mode === "automatic").length,
      2,
    );

    for (const reason of ["TRANSPORT", "RATE_LIMIT", "AUTH"]) {
      const agent = await create(`error-${reason}`, { outcomes: [reason] });
      sendHuman(agent);
      await drain(agent);
      assert.equal(requests.get(agent.session.id).length, 1);
      assert.equal(custom(agent).length, 0);
      assert.throws(() => continuation.continue({ sessionId: agent.session.id }), {
        code: "UNSUPPORTED",
      });
    }
    const stopped = await create("native-stop", { outcomes: ["max-tokens"] });
    sendHuman(stopped);
    await stopped.whenIdle();
    stopped.cancel({ kind: "user" });
    await drain(stopped);
    assert.equal(requests.get("native-stop").length, 1);
    const disabled = await create("disable-pending", { outcomes: ["max-tokens"] });
    sendHuman(disabled);
    await disabled.whenIdle();
    value.autoContinue = false;
    continuation.changed();
    await drain(disabled);
    assert.equal(requests.get("disable-pending").length, 1);
    value.autoContinue = true;
    const human = await create("human-replacement", { outcomes: ["max-tokens", "stop"] });
    sendHuman(human);
    await human.whenIdle();
    // Submit a genuine caller action at the idle boundary before setImmediate.
    sendHuman(human, "An actual new human instruction");
    await drain(human);
    assert.equal(requests.get("human-replacement").length, 2);
    assert.equal(custom(human).length, 0);

    const holding = Promise.withResolvers();
    const automatic = await create("owned-running", {
      outcomes: ["max-tokens", "hold"],
      started: holding,
    });
    sendHuman(automatic);
    await holding.promise;
    assert.equal(continuation.stop({ sessionId: "owned-running" }).ownedRunCancelled, true);
    await drain(automatic);
    assert.equal(heldSignals.get("owned-running").aborted, true);
    assert.equal(requests.get("owned-running").length, 2);
    const humanHolding = Promise.withResolvers();
    const unrelated = await create("unrelated-human", {
      outcomes: ["hold"],
      started: humanHolding,
    });
    sendHuman(unrelated);
    await humanHolding.promise;
    assert.equal(continuation.stop({ sessionId: "unrelated-human" }).ownedRunCancelled, false);
    assert.equal(heldSignals.get("unrelated-human").aborted, false);
    unrelated.cancel({ kind: "user" });
    await drain(unrelated);
    const childHandle = await ctx.agents.create({
      sessionId: "child",
      parentAgent: manual,
      agentOptions: { provider: "synthetic", model: "fixture", maxTokens: 64 },
      meta: {
        parentSession: manual.session.id,
        origin: "subagent",
        delegationDepth: 1,
        cwd: directory,
      },
    });
    plans.set("child", { outcomes: ["max-tokens"] });
    live.set("child", childHandle.agent);
    sendHuman(childHandle.agent);
    await drain(childHandle.agent);
    assert.equal(requests.get("child").length, 1);
    assert.throws(() => continuation.continue({ sessionId: "child" }), { code: "UNSUPPORTED" });

    const snapshots = [...live].map(([id, agent]) => ({
      id,
      events: agent.session.snapshotEvents(),
    }));
    continuation.revert();
    runtime.revert();
    await owner.dispose();
    for (const { id, events } of snapshots) {
      const handle = await ctx.sessionPersistence.open(id, "read");
      try {
        assert.deepEqual(
          (await handle.read()).events,
          events,
          "official JSONL retains the exact non-human source and continuation events",
        );
      } finally {
        await handle.close();
      }
    }
    assert.equal(socketAttempts, 0);
    t.diagnostic(
      `Official continuation ran on ${process.version}; ${snapshots.length} temporary JSONL sessions read back; no profile/network.`,
    );
  },
);
