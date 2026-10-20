import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, statSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { ReadLimits } from "../src/host/read-limits.js";
import { officialReadRuntime } from "./helpers/official-packages.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const optionalHost = {
  skip:
    runtimeRoot && cache
      ? false
      : "Set DSH_UNLIMIT_RUNTIME and DSH_UNLIMIT_OFFICIAL_PACKAGES for pinned clean official read/Loader tests; no profile is loaded",
  timeout: 30000,
};

async function fixture(t) {
  const calls = [];
  const deny = (name) => () => {
    calls.push(name);
    throw new Error(`Forbidden external execution: ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("dgram.bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("dgram.send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(name));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  syncBuiltinESMExports();
  let runtime,
    root,
    ctx,
    adapter,
    allowConflict = false,
    wholeReads = 0,
    streamReads = 0;
  const fibers = [],
    owned = [];
  // Guard remains active until after all official lifecycle cleanup and temporary-root disposal.
  t.after(async () => {
    try {
      try {
        await adapter?.revert();
      } catch (error) {
        if (!allowConflict || error.code !== "CONFLICT") throw error;
      }
      for (const item of owned.reverse()) await item.dispose();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx?.fiber.dispose();
    } finally {
      runtime?.dispose();
      if (root) rmSync(root, { recursive: true, force: true });
      t.mock.restoreAll();
      syncBuiltinESMExports();
      assert.deepEqual(calls, []);
    }
  });
  runtime = officialReadRuntime(runtimeRoot, cache);
  const [cordis, loader, fsTool, tools, scope, prompt, timer, hmr, fsModule] = await Promise.all(
    [
      "@deepseek-ai/cordis",
      "@deepseek-ai/cordis-plugin-loader",
      "@deepseek-ai/dsh-tool-fs",
      "@deepseek-ai/dsh-tools",
      "@deepseek-ai/dsh-scope",
      "@deepseek-ai/dsh-system-prompt",
      "@deepseek-ai/cordis-plugin-timer",
      "@deepseek-ai/dsh-hmr",
      "@deepseek-ai/dsh-fs",
    ].map(runtime.load),
  );
  root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-read-files-")));
  const file = join(root, "synthetic.txt");
  writeFileSync(file, "HEAD\nMIDDLE\nTAIL");
  ctx = new cordis.Context();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2);
    return fiber;
  };
  await mount({
    name: "synthetic-read-services",
    apply(inner) {
      new prompt.SystemPrompt(inner, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new tools.ToolRuntime(inner);
      const fs = new cordis.Service(inner, "fs");
      fs.resolve = async (path, { signal } = {}) => {
        signal?.throwIfAborted();
        if (path !== file)
          throw new fsModule.FsError("Synthetic path policy denied", "FS_ACCESS_DENIED");
        return { displayPath: file };
      };
      fs.stat = async (target, signal) => {
        signal?.throwIfAborted();
        assert.equal(target.displayPath, file);
        return { type: "file", size: statSync(file).size, version: "synthetic-version" };
      };
      fs.readText = async (target, signal) => {
        signal?.throwIfAborted();
        assert.equal(target.displayPath, file);
        wholeReads++;
        return readFileSync(file, "utf8");
      };
      fs.streamText = async (target, signal) => {
        signal?.throwIfAborted();
        assert.equal(target.displayPath, file);
        streamReads++;
        const text = readFileSync(file, "utf8");
        return (async function* () {
          for (let i = 0; i < text.length; i += 7) {
            signal?.throwIfAborted();
            yield text.slice(i, i + 7);
          }
        })();
      };
      fs.processPath = (target) => target.displayPath;
      fs.writeText = deny("fs.writeText");
      fs.editText = deny("fs.editText");
      new cordis.Service(inner, "workingDirectory").ensure = async (_agent, signal) => {
        signal?.throwIfAborted();
        return root;
      };
      new cordis.Service(inner, "attachments");
      const editor = new cordis.Service(inner, "configEditor");
      editor.configuration = deny("profile.configuration");
      editor.edit = deny("profile.edit");
      new cordis.Service(inner, "settings").write = deny("profile.settings.write");
    },
  });
  await mount(loader.default, { baseUrl: pathToFileURL(join(runtime.root, "package.json")).href });
  await mount(timer.default);
  await mount(hmr.default, { base: pathToFileURL(root + "/").href, root: [] });
  const id = await ctx.loader.create({
    id: "synthetic-read",
    name: "@deepseek-ai/dsh-tool-fs",
    config: {
      read: true,
      readImage: true,
      write: true,
      edit: true,
      readLimit: 2,
      readMaxLineLength: 4,
      readMaxBytes: 10,
      readStreamMinSize: 16,
    },
  });
  await ctx.loader.await();
  const entry = ctx.loader.resolve(id);
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2);
  assert.equal(entry.moduleNamespace.apply, fsTool.apply);
  const original = structuredClone(entry.fiber.config),
    raw = entry.options.config,
    rawBytes = JSON.stringify(raw);
  let writes = 0;
  ctx.loader.write = () => {
    writes++;
  };
  const settings = { enabled: false, readLimit: 64 };
  adapter = new ReadLimits(
    ctx,
    {
      dispatch(action) {
        assert.equal(action, "settings.get");
        return { value: settings };
      },
    },
    runtime.host,
  );
  const agent = { id: "synthetic-read-agent", session: { id: "synthetic-read-agent" } };
  const agentScope = scope.createScope(ctx, agent);
  owned.push(agentScope);
  agent.ctx = agentScope.ctx;
  let counter = 0;
  const read = (args = {}, signal = new AbortController().signal) =>
    ctx.tools.execute({
      name: "read",
      arguments: { file_path: file, ...args },
      agent,
      callId: `synthetic-${++counter}`,
      signal,
    });
  const text = (result) =>
    result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n");
  return {
    ctx,
    entry,
    adapter,
    settings,
    original,
    raw,
    rawBytes,
    read,
    text,
    file,
    root,
    runtime,
    writes: () => writes,
    reads: () => ({ whole: wholeReads, stream: streamReads }),
    allowConflict: () => {
      allowConflict = true;
    },
  };
}

test(
  "pinned clean official read tool and real Loader/HMR lifecycle in a profile-free temporary runtime",
  optionalHost,
  async (t) => {
    const f = await fixture(t);
    await t.test(
      "host caps demonstrably truncate; applying new static caps returns head and tail, preserves other tools and noSave raw config",
      async () => {
        const baseline = await f.read();
        assert.equal(baseline.isError, false);
        assert.ok(!f.text(baseline).includes("3: TAIL"));
        const cap = (await f.adapter.apply())[0];
        assert.equal(cap.state, "active");
        assert.deepEqual(cap.effectiveCaps, {
          readMaxBytes: 64,
          readLimit: 65,
          readMaxLineLength: 64,
          readStreamMinSize: 16,
        });
        const result = await f.read();
        assert.equal(result.isError, false);
        assert.match(f.text(result), /1: HEAD\n2: MIDDLE\n3: TAIL/);
        for (const name of ["read", "read_image", "write", "edit"])
          assert.ok(f.ctx.tools.get(name, undefined), name);
        assert.equal(f.entry.options.config, f.raw);
        assert.equal(JSON.stringify(f.raw), f.rawBytes);
        assert.equal(f.writes(), 0);
        await f.adapter.revert();
        assert.deepEqual(f.entry.fiber.config, f.original);
        assert.ok(!f.text(await f.read()).includes("3: TAIL"));
      },
    );
    await t.test(
      "B=1, LF, UTF-8 and non-BMP boundaries retain fitting complete lines and reject oversize lines",
      async () => {
        for (const [budget, body, expected] of [
          [1, "A", ["1: A"]],
          [1, "\n\n\n", ["1: ", "2: "]],
          [3, "中", ["1: 中"]],
          [2, "中", []],
          [4, "😀", ["1: 😀"]],
          [3, "😀", []],
          [5, "é\né", ["1: é", "2: é"]],
          [4, "é\né", ["1: é"]],
          [9, "HEAD\nTAIL", ["1: HEAD", "2: TAIL"]],
          [8, "HEAD\nTAIL", ["1: HEAD"]],
        ]) {
          f.settings.readLimit = budget;
          await f.adapter.changed();
          writeFileSync(f.file, body);
          const result = await f.read();
          assert.equal(result.isError, false, body);
          const lines = f
            .text(result)
            .split("\n")
            .filter((line) => /^\d+: /.test(line));
          assert.deepEqual(lines, expected, JSON.stringify({ budget, body }));
          assert.ok(
            Buffer.byteLength(lines.map((line) => line.replace(/^\d+: /, "")).join("\n"), "utf8") <=
              budget,
          );
        }
        // Whole-file and streamed paths enforce the same UTF-8 window even across chunks.
        f.settings.readLimit = 100;
        await f.adapter.changed();
        writeFileSync(f.file, "😀".repeat(20));
        assert.match(f.text(await f.read()), new RegExp("1: " + "😀".repeat(20)));
        f.settings.readLimit = 79;
        await f.adapter.changed();
        assert.ok(!f.text(await f.read()).includes("1: "));
        writeFileSync(f.file, "L".repeat(100));
        f.settings.readLimit = 100;
        await f.adapter.changed();
        assert.match(f.text(await f.read()), new RegExp("1: " + "L".repeat(100)));
        assert.ok(f.reads().whole > 0 && f.reads().stream > 0);
        await f.adapter.revert();
      },
    );
    await t.test(
      "read path refusals, tool pre-denial, post-block and cancellation remain effective",
      async () => {
        f.settings.readLimit = 64;
        await f.adapter.apply();
        writeFileSync(f.file, "HEAD\nTAIL");
        const outside = await f.read({ file_path: join(f.root, "not-allowed.txt") });
        assert.equal(outside.isError, true);
        assert.match(f.text(outside), /Synthetic path policy denied/);
        const count = f.reads();
        const deny = f.ctx.on("tools/pre-execute", () => ({
          kind: "deny",
          reason: "Synthetic approval denial",
        }));
        const denied = await f.read();
        assert.equal(denied.isError, true);
        assert.match(f.text(denied), /Synthetic approval denial/);
        assert.deepEqual(f.reads(), count);
        deny();
        const feedback = [{ type: "text", text: "Synthetic downstream refusal" }];
        const block = f.ctx.on("tools/post-execute", () => ({ kind: "block", feedback }));
        const blocked = await f.read();
        assert.equal(blocked.isError, true);
        assert.deepEqual(blocked.content, feedback);
        block();
        const abort = new AbortController();
        abort.abort();
        const before = f.reads();
        assert.equal((await f.read({}, abort.signal)).isError, true);
        assert.deepEqual(f.reads(), before);
        await f.adapter.revert();
      },
    );
    await t.test(
      "real async update is awaited, veto and throwing hooks leave original settings",
      async () => {
        let release;
        const dispose = f.ctx.on(
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
        let done = false;
        const pending = f.adapter.apply().then((value) => {
          done = true;
          return value;
        });
        while (!release) await new Promise((resolve) => setImmediate(resolve));
        assert.equal(done, false);
        assert.deepEqual(f.entry.fiber.config, f.original);
        release();
        assert.equal((await pending)[0].state, "active");
        dispose();
        await f.adapter.revert();
        const veto = f.entry.fiber.ctx.on("internal/update", () => {});
        await assert.rejects(
          f.adapter.apply(),
          (error) => error.code === "CONFIG_NOT_APPLIED" && error.partial.restored,
        );
        veto();
        assert.deepEqual(f.entry.fiber.config, f.original);
        const refusal = f.entry.fiber.ctx.on("internal/update", () => {
          throw new Error("Synthetic configuration refusal");
        });
        await assert.rejects(f.adapter.apply(), /Synthetic configuration refusal/);
        refusal();
        assert.deepEqual(f.entry.fiber.config, f.original);
      },
    );
    await t.test(
      "startup failure, queued and during-update cancellations roll back without persistent writes",
      async () => {
        let resolutions = 0,
          failOnce = true;
        const failure = f.ctx.on(
          "internal/config",
          function (config, next) {
            if (
              this === f.entry.fiber &&
              config.readMaxBytes === 64 &&
              ++resolutions === 2 &&
              failOnce
            ) {
              failOnce = false;
              throw new Error("Synthetic activation failure");
            }
            return next();
          },
          { global: true, prepend: true },
        );
        await assert.rejects(f.adapter.apply(), (error) => error.partial.restored);
        failure();
        assert.deepEqual(f.entry.fiber.config, f.original);
        assert.equal(f.entry.fiber.state, 2);
        let release;
        const blocker = f.ctx.hmr.runExclusive(
          () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        );
        while (!release) await new Promise((resolve) => setImmediate(resolve));
        const abort = new AbortController();
        const pending = f.adapter.apply({ signal: abort.signal });
        abort.abort();
        release();
        await blocker;
        await assert.rejects(pending, { code: "ABORTED" });
        assert.deepEqual(f.entry.fiber.config, f.original);
        const during = new AbortController();
        const cancel = f.ctx.on(
          "internal/update",
          async function (config, _noSave, next) {
            const result = await next();
            if (this === f.entry.fiber && config.readMaxBytes === 64) during.abort();
            return result;
          },
          { global: true },
        );
        await assert.rejects(
          f.adapter.apply({ signal: during.signal }),
          (error) => error.code === "ABORTED" && error.partial.restored,
        );
        cancel();
        assert.deepEqual(f.entry.fiber.config, f.original);
        assert.equal(f.writes(), 0);
        assert.equal(JSON.stringify(f.raw), f.rawBytes);
      },
    );
    await t.test(
      "external official updates cause disclosed ownership conflict and are preserved",
      async () => {
        await f.adapter.apply();
        await f.ctx.hmr.runExclusive(async () => {
          f.entry.fiber.update({ ...f.entry.fiber.config, readMaxBytes: 63 }, true);
          await f.entry.fiber.await();
        });
        const external = f.entry.fiber.config;
        f.allowConflict();
        assert.equal(f.adapter.capabilities()[0].code, "CONFLICT");
        assert.equal(f.adapter.capabilities()[0].effectiveCaps, null);
        await assert.rejects(f.adapter.changed(), { code: "CONFLICT" });
        await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
        assert.equal(f.entry.fiber.config, external);
        assert.equal(f.writes(), 0);
        assert.equal(JSON.stringify(f.raw), f.rawBytes);
      },
    );
  },
);
