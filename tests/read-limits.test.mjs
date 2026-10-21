import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ReadLimits } from "../src/host/read-limits.js";
import { officialReadRuntime } from "./helpers/official-packages.mjs";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-read-unit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [];
  for (const name of ["dsh-tool-fs", "cordis", "cordis-plugin-loader"]) {
    const dir = join(root, "node_modules", "@deepseek-ai", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: `@deepseek-ai/${name}`, type: "module", main: "index.js" }),
    );
    const bytes = "export function apply() {}\n";
    writeFileSync(join(dir, "index.js"), bytes);
    files.push({
      path: `node_modules/@deepseek-ai/${name}/index.js`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "desktop-runtime.json"),
    JSON.stringify({ release: { version: "0.2.1-rc.2" }, files }),
  );
  const filename = join(root, "node_modules", "@deepseek-ai", "dsh-tool-fs", "index.js");
  const namespace = await import(pathToFileURL(filename).href);
  const settings = { enabled: false, readLimit: 80 };
  const original = {
    read: true,
    readImage: true,
    write: true,
    edit: true,
    readLimit: 2000,
    readMaxLineLength: 2000,
    readMaxBytes: 51200,
    readStreamMinSize: 10485760,
  };
  const raw = { ...structuredClone(original) };
  const updates = [],
    observers = [];
  let hook = async (next) => next();
  const fiber = {
    state: 2,
    config: structuredClone(original),
    runtime: { callback: namespace.apply },
    update(next, noSave) {
      updates.push({ next, noSave });
      const continuation = () =>
        hook(async () => {
          this.config = structuredClone(next);
          this.state = 2;
        });
      if (this.state !== 2) {
        this.inertia = continuation();
        return;
      }
      const observer = observers.at(-1);
      assert.ok(observer);
      observer.call(this, next, noSave, continuation);
    },
    async await() {
      await this.inertia;
      return this;
    },
  };
  const entry = {
    options: { name: "@deepseek-ai/dsh-tool-fs", config: raw },
    fiber,
    moduleNamespace: namespace,
  };
  fiber.entry = entry;
  fiber.runtime.fibers = [fiber];
  let entries = [entry];
  const services = { loader: { entries: () => entries } };
  const ctx = {
    get: (name) => services[name],
    on(event, listener, options) {
      assert.equal(event, "internal/update");
      assert.deepEqual(options, { global: true, prepend: true });
      observers.push(listener);
      return () => observers.splice(observers.indexOf(listener), 1);
    },
  };
  const host = { kind: "desktop", supported: true, version: "0.2.1-rc.2", runtimeRoot: root };
  const store = {
    dispatch(action) {
      assert.equal(action, "settings.get");
      return { value: settings };
    },
  };
  const adapter = new ReadLimits(ctx, store, host);
  return {
    root,
    filename,
    settings,
    original,
    raw,
    entry,
    fiber,
    host,
    adapter,
    updates,
    observers,
    services,
    hook: (value) => {
      hook = value;
    },
    entries: (value) => {
      entries = value;
    },
    registry: (runtimes) => {
      ctx.registry = new Map(runtimes.map((runtime) => [runtime.callback, runtime]));
    },
  };
}

test("byte caps apply before enabled, preserve all other fields, change idempotently and restore", async (t) => {
  const f = await fixture(t);
  const active = (await f.adapter.apply())[0];
  assert.equal(active.state, "active");
  assert.equal(active.owned, true);
  assert.deepEqual(active.effectiveCaps, {
    readMaxBytes: 80,
    readLimit: 81,
    readMaxLineLength: 80,
    readStreamMinSize: 10485760,
  });
  assert.deepEqual(f.fiber.config, {
    ...f.original,
    readMaxBytes: 80,
    readLimit: 81,
    readMaxLineLength: 80,
  });
  assert.equal(f.entry.options.config, f.raw);
  assert.ok(f.updates.every((row) => row.noSave === true));
  await f.adapter.apply();
  assert.equal(f.updates.length, 1);
  f.settings.readLimit = 1;
  await f.adapter.changed();
  assert.equal(f.fiber.config.readLimit, 2);
  assert.equal(f.fiber.config.readMaxLineLength, 1);
  f.settings.readLimit = 0;
  await f.adapter.changed();
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.adapter.capabilities()[0].effective, "host");
  assert.equal(f.observers.length, 0);
  await f.adapter.revert();
  assert.equal(f.updates.length, 3);
});

test("zero/default means host and invalid budgets reject before any update", async (t) => {
  const f = await fixture(t);
  delete f.settings.readLimit;
  await f.adapter.apply();
  assert.equal(f.updates.length, 0);
  for (const value of [-1, 1.5, "1", NaN, Number.MAX_SAFE_INTEGER]) {
    f.settings.readLimit = value;
    await assert.rejects(f.adapter.apply(), { code: "INVALID_INPUT" });
  }
  assert.equal(f.updates.length, 0);
});

test("retained preset entry is discovered through the real Cordis registry shape", async (t) => {
  const f = await fixture(t);
  f.entries([]);
  f.registry([f.fiber.runtime]);
  assert.equal(f.adapter.capabilities()[0].state, "available");
  assert.equal((await f.adapter.apply())[0].effective, 80);
  assert.equal(f.fiber.config.readMaxBytes, 80);
  assert.equal(f.entry.options.config, f.raw);
  assert.deepEqual(f.raw, f.original);
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
  assert.ok(f.updates.every((row) => row.noSave === true));
});

test("Loader and registry catalogs deduplicate the same Entry by identity", async (t) => {
  const f = await fixture(t);
  f.entries([f.entry, f.entry]);
  f.registry([f.fiber.runtime]);
  assert.equal((await f.adapter.apply())[0].state, "active");
  assert.equal(f.updates.length, 1);
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
});

test("distinct root and preset entries remain an unsupported ambiguous target", async (t) => {
  const f = await fixture(t);
  const presetFiber = { ...f.fiber };
  const presetEntry = { ...f.entry, fiber: presetFiber };
  presetFiber.entry = presetEntry;
  presetFiber.runtime = { callback: f.entry.moduleNamespace.apply, fibers: [presetFiber] };
  f.registry([presetFiber.runtime]);
  const capability = f.adapter.capabilities()[0];
  assert.equal(capability.state, "unsupported");
  assert.match(capability.detail, /未唯一活动/);
  assert.equal(capability.effectiveCaps, null);
  await assert.rejects(f.adapter.apply(), { code: "UNSUPPORTED_CAPABILITY" });
  assert.equal(f.updates.length, 0);
});

test("stale or mismatched registry fibers cannot identify an active preset entry", async (t) => {
  for (const change of [
    (f) => {
      f.fiber.state = 0;
    },
    (f) => {
      f.entry.fiber = { ...f.fiber };
    },
    (f) => {
      f.registry([{ callback: f.fiber.runtime.callback, fibers: [f.fiber] }]);
    },
    (f) => {
      f.entry.moduleNamespace = { apply() {} };
    },
  ]) {
    const f = await fixture(t);
    f.entries([]);
    f.registry([f.fiber.runtime]);
    change(f);
    assert.equal(f.adapter.capabilities()[0].state, "unsupported");
    await assert.rejects(f.adapter.apply(), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(f.updates.length, 0);
  }
});

test("revert locates the owned inactive preset fiber but does not invent a removed entry", async (t) => {
  const f = await fixture(t);
  f.entries([]);
  f.registry([f.fiber.runtime]);
  await f.adapter.apply();
  f.fiber.state = 0;
  assert.equal(f.adapter.capabilities()[0].state, "unsupported");
  await f.adapter.revert();
  assert.equal(f.fiber.state, 2);
  assert.deepEqual(f.fiber.config, f.original);
  await f.adapter.apply();
  f.registry([]);
  const count = f.updates.length;
  await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
  assert.equal(f.updates.length, count);
  assert.equal(f.adapter.capabilities()[0].owned, true);
});

test("unsupported versions, modified modules, duplicate/inactive/disabled targets reject before writes", async (t) => {
  for (const change of [
    (f) => {
      f.host.version = "future";
    },
    (f) => f.entries([f.entry, { ...f.entry }]),
    (f) => {
      f.fiber.state = 0;
    },
    (f) => {
      f.fiber.config.read = false;
    },
    (f) => {
      f.entry.moduleNamespace = { apply() {} };
    },
    (f) => writeFileSync(f.filename, "export function apply(){return 1}"),
  ]) {
    const f = await fixture(t);
    change(f);
    assert.equal(f.adapter.capabilities()[0].state, "unsupported");
    assert.equal(f.adapter.capabilities()[0].effectiveCaps, null);
    await assert.rejects(f.adapter.changed(), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(f.updates.length, 0);
  }
});

test("transparent lifecycle waits for async update and preserves veto and removes observer", async (t) => {
  const f = await fixture(t);
  let release;
  f.hook(async (next) => {
    f.fiber.state = 1;
    await new Promise((resolve) => {
      release = resolve;
    });
    return next();
  });
  let settled = false;
  const pending = f.adapter.apply().then((v) => {
    settled = true;
    return v;
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.adapter.capabilities()[0].state, "applying");
  assert.equal(f.adapter.capabilities()[0].effectiveCaps, null);
  release();
  assert.equal((await pending)[0].state, "active");
  release = undefined;
  const reverting = f.adapter.revert();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.adapter.capabilities()[0].state, "applying");
  release();
  await reverting;
  f.hook(async (next) => next());
  f.hook(async () => {});
  await assert.rejects(
    f.adapter.apply(),
    (error) => error.code === "CONFIG_NOT_APPLIED" && error.partial.restored,
  );
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.observers.length, 0);
});

test("startup failure and cancellation roll back; a failed changed budget retains previous ownership", async (t) => {
  const f = await fixture(t);
  let failed = false;
  f.hook(async (next) => {
    await next();
    if (!failed) {
      failed = true;
      f.fiber.state = 0;
      throw new Error("synthetic startup failure");
    }
  });
  await assert.rejects(f.adapter.apply(), (e) => e.partial.restored);
  assert.deepEqual(f.fiber.config, f.original);
  f.hook(async (next) => next());
  await f.adapter.apply();
  const previous = structuredClone(f.fiber.config);
  f.settings.readLimit = 90;
  failed = false;
  f.hook(async (next) => {
    await next();
    if (!failed) {
      failed = true;
      throw new Error("synthetic changed failure");
    }
  });
  await assert.rejects(f.adapter.changed(), (e) => e.partial.restored && e.partial.owned);
  assert.deepEqual(f.fiber.config, previous);
  const abort = new AbortController();
  abort.abort();
  const count = f.updates.length;
  await assert.rejects(f.adapter.changed({ signal: abort.signal }), { code: "ABORTED" });
  assert.equal(f.updates.length, count);
  const during = new AbortController();
  f.hook(async (next) => {
    await next();
    during.abort();
  });
  await assert.rejects(
    f.adapter.changed({ signal: during.signal }),
    (e) => e.code === "ABORTED" && e.partial.restored,
  );
  assert.deepEqual(f.fiber.config, previous);
  f.hook(async (next) => next());
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.observers.length, 0);
});

test("foreign active or persistent config conflicts are reported without overwrite", async (t) => {
  const f = await fixture(t);
  await f.adapter.apply();
  const external = { ...f.fiber.config, readMaxBytes: 99 };
  f.fiber.config = external;
  assert.equal(f.adapter.capabilities()[0].code, "CONFLICT");
  assert.equal(f.adapter.capabilities()[0].effectiveCaps, null);
  await assert.rejects(
    f.adapter.changed(),
    (e) => e.code === "CONFLICT" && e.partial.owned && !e.partial.restored,
  );
  await assert.rejects(f.adapter.revert(), (e) => e.code === "CONFLICT" && e.partial.owned);
  assert.equal(f.fiber.config, external);
  const g = await fixture(t);
  await g.adapter.apply();
  g.entry.options.config = { ...g.raw, edit: false };
  const count = g.updates.length;
  await assert.rejects(g.adapter.revert(), { code: "CONFLICT" });
  assert.equal(g.updates.length, count);
});

test("restore rechecks ownership after asynchronous module identity verification", async (t) => {
  const f = await fixture(t);
  await f.adapter.apply();
  const verify = f.adapter.moduleIdentity.bind(f.adapter);
  let external;
  f.adapter.moduleIdentity = async (target) => {
    await verify(target);
    external = { ...f.fiber.config, readMaxBytes: 71 };
    f.fiber.config = external;
  };
  const before = f.updates.length;
  await assert.rejects(
    f.adapter.revert(),
    (e) => e.code === "CONFLICT" && e.partial.owned && !e.partial.restored,
  );
  assert.equal(f.updates.length, before);
  assert.equal(f.fiber.config, external);
  assert.equal(f.adapter.capabilities()[0].effectiveCaps, null);
});

test("explicit mismatched official-package cache fails its pinned integrity gate before loading", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-read-cache-negative-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    join(root, "desktop-runtime.json"),
    JSON.stringify({
      release: { version: "0.2.1-rc.2" },
      files: [
        {
          path: "node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js",
          sha256: "b11d3fa50b9042019a91cc38a6abe35d74ed651374278f95e60b42734e079df1",
        },
      ],
    }),
  );
  writeFileSync(
    join(root, "dsh-tool-fs-0.2.1-rc.2.tgz"),
    "synthetic mismatched public package fixture",
  );
  assert.throws(() => officialReadRuntime(root, root), /pinned npm SRI/);
});
