import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { RepeatReminder } from "../src/host/repeat-reminder.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const optionalHost = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated official repeat/Loader tests; no profile is loaded",
  timeout: 15000,
};
async function fixture(t) {
  const calls = [];
  const deny = (name) => () => {
    calls.push(name);
    throw new Error(`No external execution: ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("dgram.bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("dgram.send"));
  for (const method of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ])
    t.mock.method(childProcess, method, deny(method));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  syncBuiltinESMExports();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-repeat-host-")));
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const require = createRequire(join(runtimeRoot, "package.json"));
  const load = async (name) => {
    const path = require.resolve(name);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      manifest.files.find((item) => item.path === relative(runtimeRoot, path))?.sha256,
      `${name} entry must match official inventory`,
    );
    return import(pathToFileURL(path).href);
  };
  const [cordis, loader, repeat, tools, scope, prompt, timer, hmr] = await Promise.all([
    load("@deepseek-ai/cordis"),
    load("@deepseek-ai/cordis-plugin-loader"),
    load("@deepseek-ai/dsh-repeat-tool-reminder"),
    load("@deepseek-ai/dsh-tools"),
    load("@deepseek-ai/dsh-scope"),
    load("@deepseek-ai/dsh-system-prompt"),
    load("@deepseek-ai/cordis-plugin-timer"),
    load("@deepseek-ai/dsh-hmr"),
  ]);
  const ctx = new cordis.Context();
  const fibers = [];
  const owned = [];
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2);
    return fiber;
  };
  let adapter;
  let allowOwnershipConflict = false;
  t.after(async () => {
    try {
      try {
        await adapter?.revert();
      } catch (error) {
        if (!allowOwnershipConflict || error.code !== "CONFLICT") throw error;
      }
      for (const item of owned.reverse()) await item.dispose();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx.fiber.dispose();
      assert.deepEqual(calls, []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });
  await mount({
    name: "synthetic-repeat-test-services",
    apply(inner) {
      new prompt.SystemPrompt(inner, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new tools.ToolRuntime(inner);
      const editor = new cordis.Service(inner, "configEditor");
      editor.configuration = deny("profile.configuration");
      editor.edit = deny("profile.edit");
      const settings = new cordis.Service(inner, "settings");
      settings.write = deny("profile.settings.write");
    },
  });
  await mount(loader.default, { baseUrl: pathToFileURL(join(runtimeRoot, "package.json")).href });
  await mount(timer.default);
  // Real HMR serial queue, no profileContext and no watched roots.
  await mount(hmr.default, { base: pathToFileURL(root + "/").href, root: [] });
  const id = await ctx.loader.create({
    id: "synthetic-repeat",
    name: "@deepseek-ai/dsh-repeat-tool-reminder",
    config: {
      thresholds: [3, 5],
      include: [],
      exclude: ["synthetic_skip"],
      argumentsPreviewChars: 87,
    },
  });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(id);
  await entry.fiber.await();
  assert.equal(entry.moduleNamespace.apply, repeat.apply);
  let writes = 0;
  ctx.loader.write = () => {
    writes++;
  };
  const raw = entry.options.config;
  const rawBytes = JSON.stringify(raw);
  const original = structuredClone(entry.fiber.config);
  const localSettings = { enabled: false, repeatReminder: "off" };
  adapter = new RepeatReminder(
    ctx,
    {
      dispatch(action) {
        assert.equal(action, "settings.get");
        return { value: localSettings };
      },
    },
    { kind: "desktop", version: "0.2.1-rc.2", supported: true, runtimeRoot },
  );
  const agent = { id: "synthetic-repeat-agent", session: { id: "synthetic-repeat-agent" } };
  const agentScope = scope.createScope(ctx, agent);
  owned.push(agentScope);
  agent.ctx = agentScope.ctx;
  const file = join(root, "synthetic.txt");
  writeFileSync(file, "Original synthetic evidence\n");
  let executions = 0;
  ctx.tools.register(
    tools.defineTool({
      name: "synthetic_read",
      description: "Reads only a fixed temporary synthetic file",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      execute() {
        executions++;
        return { text: readFileSync(file, "utf8") };
      },
    }),
  );
  const results = [];
  ctx.on("tools/result", (exec, result) => {
    results.push({ callId: exec.callId, result });
  });
  let counter = 0;
  const read = (signal = new AbortController().signal) =>
    ctx.tools.execute({
      name: "synthetic_read",
      arguments: {},
      agent,
      callId: `synthetic-${++counter}`,
      signal,
    });
  return {
    ctx,
    root,
    adapter,
    entry,
    raw,
    rawBytes,
    original,
    localSettings,
    read,
    results,
    writes: () => writes,
    executions: () => executions,
    expectOwnershipConflict: () => {
      allowOwnershipConflict = true;
    },
  };
}

test(
  "official repeat plugin remains advisory; noSave off/restoration preserve raw Loader config and all tool executions",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const baseline = [];
    for (let i = 0; i < 3; i++) baseline.push(await f.read());
    assert.equal(f.executions(), 3);
    assert.equal(
      baseline[2].additionalContexts.filter((item) => item.source.kind === "repeat-tool-reminder")
        .length,
      1,
    );
    assert.ok(baseline.every((item) => !item.isError));
    const changed = await f.adapter.apply();
    assert.equal(changed[0].state, "active");
    assert.equal(f.entry.options.config, f.raw);
    assert.equal(JSON.stringify(f.raw), f.rawBytes);
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await f.read()).additionalContexts?.some(
          (item) => item.source.kind === "repeat-tool-reminder",
        ) ?? false,
        false,
      );
    assert.equal(f.executions(), 6);
    assert.equal(f.results.length, 6);
    assert.equal(f.writes(), 0);
    await f.adapter.apply();
    await f.adapter.revert();
    const restored = [];
    for (let i = 0; i < 3; i++) restored.push(await f.read());
    assert.ok(
      restored[2].additionalContexts.some((item) => item.source.kind === "repeat-tool-reminder"),
    );
    assert.equal(f.executions(), 9);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.entry.fiber.config, f.original);
    assert.equal(JSON.stringify(f.entry.options.config), f.rawBytes);
    // Positive control: the same real Loader hook does persist an ordinary update.
    f.entry.fiber.update({ ...f.original, argumentsPreviewChars: 88 }, false);
    await f.entry.fiber.await();
    assert.equal(f.writes(), 1);
    assert.equal(f.entry.options.config.argumentsPreviewChars, 88);
  },
);

test(
  "official downstream post block/feedback and pre-execute denial survive off; cancelled reads never become successes",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    const feedback = [{ type: "text", text: "Synthetic policy refused the result" }];
    let block = true;
    const dispose = f.ctx.on("tools/post-execute", async (_exec, _result, next) =>
      block
        ? {
            kind: "block",
            feedback,
            additionalContexts: [
              {
                role: "user",
                content: [{ type: "text", text: "Other policy context" }],
                source: { kind: "synthetic-policy" },
              },
            ],
          }
        : next(),
    );
    for (let i = 0; i < 3; i++) {
      const result = await f.read();
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, feedback);
    }
    await f.adapter.apply();
    for (let i = 0; i < 3; i++) {
      const result = await f.read();
      assert.equal(result.isError, true);
      assert.deepEqual(result.content, feedback);
      assert.equal(
        result.additionalContexts.some((item) => item.source.kind === "synthetic-policy"),
        true,
      );
      assert.equal(
        result.additionalContexts.some((item) => item.source.kind === "repeat-tool-reminder"),
        false,
      );
    }
    assert.equal(f.executions(), 6);
    dispose();
    block = false;
    const denied = f.ctx.on("tools/pre-execute", () => ({
      kind: "deny",
      reason: "Synthetic access denied",
    }));
    const result = await f.read();
    assert.equal(result.isError, true);
    assert.equal(f.executions(), 6);
    denied();
    const abort = new AbortController();
    abort.abort();
    const cancelled = await f.read(abort.signal);
    assert.equal(cancelled.isError, true);
    assert.equal(f.executions(), 6);
    assert.equal(f.writes(), 0);
  },
);

test(
  "real asynchronous update hook is awaited; real veto and thrown hook retain original config without persistence",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    let release;
    const asynchronous = f.ctx.on(
      "internal/update",
      async function (_config, noSave, next) {
        if (this !== f.entry.fiber) return next();
        assert.equal(noSave, true);
        await new Promise((resolve) => {
          release = resolve;
        });
        return next();
      },
      { global: true, prepend: true },
    );
    let settled = false;
    const task = f.adapter.apply().then((result) => {
      settled = true;
      return result;
    });
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(f.entry.fiber.config, f.original);
    release();
    assert.equal((await task)[0].state, "active");
    asynchronous();
    await f.adapter.revert();
    const veto = f.entry.fiber.ctx.on("internal/update", () => {});
    await assert.rejects(
      f.adapter.apply(),
      (error) => error.code === "CONFIG_NOT_APPLIED" && error.partial.restored,
    );
    assert.deepEqual(f.entry.fiber.config, f.original);
    veto();
    const rejecting = f.entry.fiber.ctx.on("internal/update", () => {
      throw new Error("Synthetic update hook refusal");
    });
    await assert.rejects(f.adapter.apply(), /Synthetic update hook refusal/);
    rejecting();
    assert.equal(f.writes(), 0);
    assert.equal(JSON.stringify(f.entry.options.config), f.rawBytes);
  },
);

test(
  "real lifecycle startup failure rolls back and cancellation in HMR queue/after update leaves the original config",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    let resolutions = 0;
    let failOnce = true;
    const injectFailure = f.ctx.on(
      "internal/config",
      function (config, next) {
        if (
          this === f.entry.fiber &&
          config.exclude?.includes("*") &&
          ++resolutions === 2 &&
          failOnce
        ) {
          failOnce = false;
          throw new Error("Synthetic startup failure after configuration assignment");
        }
        return next();
      },
      { global: true, prepend: true },
    );
    await assert.rejects(f.adapter.apply(), (error) => error.partial.restored === true);
    injectFailure();
    assert.equal(f.entry.fiber.state, 2);
    assert.deepEqual(f.entry.fiber.config, f.original);
    assert.equal(f.adapter.capabilities()[0].owned, false);
    let release;
    const blocker = f.ctx.hmr.runExclusive(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    const before = f.entry.fiber.config;
    const abort = new AbortController();
    const cancelled = f.adapter.apply({ signal: abort.signal });
    abort.abort();
    release();
    await blocker;
    await assert.rejects(cancelled, { code: "ABORTED" });
    assert.equal(f.entry.fiber.config, before);
    const after = new AbortController();
    const cancelUpdate = f.ctx.on(
      "internal/update",
      async function (config, _noSave, next) {
        const result = await next();
        if (this === f.entry.fiber && config.exclude.includes("*")) after.abort();
        return result;
      },
      { global: true },
    );
    await assert.rejects(
      f.adapter.apply({ signal: after.signal }),
      (error) => error.code === "ABORTED" && error.partial.restored,
    );
    cancelUpdate();
    assert.deepEqual(f.entry.fiber.config, f.original);
    assert.equal(f.writes(), 0);
    assert.equal(JSON.stringify(f.entry.options.config), f.rawBytes);
  },
);

test(
  "external official config lifecycle replacement is preserved and cannot be overwritten by owner restore",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    await f.adapter.apply();
    await f.ctx.hmr.runExclusive(async () => {
      f.entry.fiber.update({ ...f.entry.fiber.config, argumentsPreviewChars: 111 }, true);
      await f.entry.fiber.await();
    });
    const external = f.entry.fiber.config;
    f.expectOwnershipConflict();
    assert.equal(f.adapter.capabilities()[0].code, "CONFLICT");
    await assert.rejects(f.adapter.apply(), { code: "CONFLICT" });
    await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
    assert.equal(f.entry.fiber.config, external);
    assert.equal(f.entry.fiber.config.argumentsPreviewChars, 111);
    assert.equal(f.writes(), 0);
    assert.equal(JSON.stringify(f.entry.options.config), f.rawBytes);
  },
);
