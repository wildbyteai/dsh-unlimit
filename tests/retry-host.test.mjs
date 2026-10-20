import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Socket } from "node:net";
import { pathToFileURL } from "node:url";
import { RetryPolicy } from "../src/host/retry-policy.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;

test(
  "official AgentLoop executes bounded retry policy and persists original executor audit, cancellation and revert",
  {
    skip: runtimeRoot
      ? false
      : "Set DSH_UNLIMIT_RUNTIME to an official 0.2.1-rc.2 installation; no profile is loaded",
    timeout: 20000,
  },
  async (t) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-retry-")));
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
    assert.equal(manifest.release.version, "0.2.1-rc.2");
    const requireHost = createRequire(join(runtimeRoot, "package.json"));
    const load = async (name) => {
      const path = requireHost.resolve(name);
      const listed = manifest.files.find((file) => file.path === relative(runtimeRoot, path));
      assert.ok(listed, `Official manifest entry missing: ${name}`);
      assert.equal(
        createHash("sha256").update(readFileSync(path)).digest("hex"),
        listed.sha256,
        `Refusing modified official module: ${name}`,
      );
      return import(pathToFileURL(path).href);
    };
    let socketAttempts = 0;
    const savedConnect = Socket.prototype.connect;
    Socket.prototype.connect = function () {
      socketAttempts++;
      throw new Error("Retry acceptance permits no network");
    };
    let ctx, owner, retryFiber, persistenceFiber, adapter;
    t.after(async () => {
      try {
        adapter?.revert();
        await retryFiber?.dispose();
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
      retry,
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
      load("@deepseek-ai/dsh-llm-retry"),
      load("@deepseek-ai/dsh-session-persistence-jsonl"),
    ]);
    const settings = { enabled: true, retryOverride: true, retryLimit: 2 };
    const plans = new Map(),
      counts = new Map(),
      live = new Map(),
      captures = [];
    const normal = llm.resolveRetryPolicy(
      {
        mode: "normal",
        maxRetries: 1,
        retryableCodes: ["SERVER", "AUTH", "RATE_LIMIT"],
        backoff: { initialDelayMs: 1, maxDelayMs: 100, jitterRatio: 0 },
      },
      "synthetic",
    );
    const always = llm.resolveRetryPolicy(
      { mode: "always", backoff: { initialDelayMs: 1, maxDelayMs: 100, jitterRatio: 0 } },
      "synthetic",
    );
    class SyntheticAdapter extends llm.LlmAdapter {
      providerRetryPolicy(provider) {
        return provider === "always" ? always : normal;
      }
      async *stream(options) {
        const count = (counts.get(options.sessionId) ?? 0) + 1;
        counts.set(options.sessionId, count);
        const plan = plans.get(options.sessionId);
        if (count <= plan.failures)
          throw new llm.LlmError(
            "Synthetic local failure",
            plan.code,
            plan.retryAfter ? { providerRetryAfterMs: plan.retryAfter } : undefined,
          );
        yield { type: "text-delta", index: 0, text: "Synthetic completion." };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
    ctx = new cordis.Context();
    owner = ctx.plugin({
      name: "synthetic-retry-host-services",
      apply(scope) {
        new prompt.SystemPrompt(scope, {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: "SYNTHETIC",
          personaSuffix: "",
        });
        new projections.SessionProjectionRegistry(scope);
        new sessions.SessionStore(scope);
        new agents.AgentRegistry(scope);
        new llm.LlmRuntime(scope);
        new tools.ToolRuntime(scope);
        new loop.AgentLoop(scope, { agents: [], maxParallelToolCalls: cosmokit.createVolatile(1) });
        scope.llm.registerAdapter(["normal", "always"], new SyntheticAdapter());
        scope.on("session/event", (session, event) => {
          if (event.type === "llm/retry" && plans.get(session.id)?.cancel)
            live.get(session.id).cancel({ kind: "user" });
        });
      },
    });
    await owner.await();
    adapter = new RetryPolicy(ctx, {
      dispatch(action) {
        assert.equal(action, "settings.get");
        return { value: settings };
      },
    });
    assert.equal(
      adapter.capabilities()[0].state,
      "unsupported",
      "llm alone must not imply a retry executor",
    );
    persistenceFiber = ctx.plugin(persistence, {
      root: directory,
      compression: "none",
      listConcurrency: 1,
    });
    await persistenceFiber.await();
    retryFiber = ctx.plugin(retry, {});
    await retryFiber.await();
    assert.equal(adapter.capabilities()[0].state, "available");
    const originalMethod = Object.getPrototypeOf(ctx.llm).prepareCall;
    const originalDescriptor = Object.getOwnPropertyDescriptor(ctx.llm, "prepareCall");
    adapter.apply();
    adapter.apply();
    const prepared = await ctx.llm.prepareCall({ provider: "normal", model: "synthetic" });
    assert.equal(Object.isFrozen(prepared), true);
    assert.deepEqual(prepared.retryPolicy.retryableCodes, ["RATE_LIMIT", "SERVER"]);
    assert.equal(
      ctx.llm.providerRetryPolicy("normal"),
      normal,
      "provider registration is unchanged",
    );

    const run = async (id, plan, provider = "normal") => {
      plans.set(id, plan);
      const agent = await ctx.agentLoop.create(
        id,
        { provider, model: "synthetic", maxTokens: 64 },
        { cwd: directory },
      );
      live.set(id, agent);
      agent.followup(
        llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: "Synthetic retry acceptance." }],
        }),
      );
      await agent.whenIdle();
      const events = agent.session.snapshotEvents();
      captures.push({ id, events });
      return {
        agent,
        events,
        retries: events.filter((event) => event.type === "llm/retry"),
        starts: events.filter((event) => event.type === "llm/retry-started"),
        end: events.findLast((event) => event.type === "turn/end"),
      };
    };

    settings.retryLimit = 0;
    const zero = await run("retry-zero", { code: "SERVER", failures: 5 });
    assert.equal(counts.get("retry-zero"), 1);
    assert.equal(zero.retries.length, 0);
    assert.equal(zero.end.data.reason.kind, "error");
    settings.retryLimit = 2;
    const two = await run("retry-two", { code: "SERVER", failures: 5 });
    assert.equal(counts.get("retry-two"), 3);
    assert.equal(two.retries.length, 2);
    assert.equal(two.starts.length, 2);
    assert.deepEqual(
      two.retries.map((event) => event.data.maxRetries),
      [2, 2],
    );
    for (let index = 0; index < 2; index++)
      assert.ok(two.retries[index].seq < two.starts[index].seq);
    const success = await run("retry-success", { code: "SERVER", failures: 2 });
    assert.equal(counts.get("retry-success"), 3);
    assert.equal(success.end.data.reason.kind, "completed");
    for (const code of [
      "AUTH",
      "INVALID_CREDENTIAL",
      "QUOTA_EXCEEDED",
      "ACCOUNT_QUOTA_EXCEEDED",
      "INVALID_REQUEST",
      "CONTEXT_WINDOW_EXCEEDED",
    ]) {
      const id = `permanent-${code}`;
      const failed = await run(id, { code, failures: 5 }, "always");
      assert.equal(
        counts.get(id),
        1,
        `${code} must not be retried even under original always policy`,
      );
      assert.equal(failed.retries.length, 0);
      assert.equal(failed.end.data.reason.kind, "error");
    }
    const after = await run("retry-after", { code: "SERVER", failures: 1, retryAfter: 15 });
    assert.equal(after.retries[0].data.delayMs, 15, "official Retry-After stays authoritative");
    const excessiveAfter = await run("retry-after-over-cap", {
      code: "SERVER",
      failures: 1,
      retryAfter: 101,
    });
    assert.equal(counts.get("retry-after-over-cap"), 1);
    assert.equal(excessiveAfter.retries.length, 0);
    const cancel = await run("retry-cancel", {
      code: "SERVER",
      failures: 5,
      retryAfter: 100,
      cancel: true,
    });
    assert.equal(counts.get("retry-cancel"), 1);
    assert.equal(cancel.retries.length, 1);
    assert.equal(cancel.starts.length, 0);
    assert.equal(cancel.end.data.reason.kind, "aborted");
    settings.retryOverride = false;
    const native = await run("retry-native", { code: "SERVER", failures: 5 });
    assert.equal(counts.get("retry-native"), 2);
    assert.equal(native.retries[0].data.maxRetries, 1);
    adapter.revert();
    assert.equal(Object.getPrototypeOf(ctx.llm).prepareCall, originalMethod);
    assert.deepEqual(Object.getOwnPropertyDescriptor(ctx.llm, "prepareCall"), originalDescriptor);
    assert.equal(
      (await ctx.llm.prepareCall({ provider: "normal", model: "synthetic" })).retryPolicy,
      normal,
    );
    settings.retryOverride = true;
    adapter.apply();
    await retryFiber.dispose();
    assert.equal(adapter.capabilities()[0].state, "unsupported");
    await assert.rejects(ctx.llm.prepareCall({ provider: "normal", model: "synthetic" }), {
      code: "UNSUPPORTED",
    });
    adapter.revert();

    // Dispose live agents first: their official JSONL handles drain and release.
    await owner.dispose();
    for (const capture of captures) {
      const handle = await ctx.sessionPersistence.open(capture.id, "read");
      try {
        const stored = await handle.read();
        assert.deepEqual(
          stored.events,
          capture.events,
          "physical official JSONL log equals the committed session events",
        );
      } finally {
        await handle.close();
      }
    }
    assert.equal(socketAttempts, 0);
    t.diagnostic(
      `Official isolated retry acceptance ran on ${process.version}; ${captures.length} sessions read back from temporary JSONL storage; no network/profile.`,
    );
  },
);
