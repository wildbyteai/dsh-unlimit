import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { RepeatReminder } from "../src/host/repeat-reminder.js";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-repeat-unit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = [];
  for (const name of ["dsh-repeat-tool-reminder", "cordis", "cordis-plugin-loader"]) {
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
  const filename = join(
    root,
    "node_modules",
    "@deepseek-ai",
    "dsh-repeat-tool-reminder",
    "index.js",
  );
  const namespace = await import(pathToFileURL(filename).href);
  const settings = { enabled: false, repeatReminder: "off" };
  const original = {
    thresholds: [3, 5, 8],
    include: ["synthetic_*"],
    exclude: ["synthetic_skip"],
    argumentsPreviewChars: 72,
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
    options: { name: "@deepseek-ai/dsh-repeat-tool-reminder", config: raw },
    fiber,
    moduleNamespace: namespace,
  };
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
  const adapter = new RepeatReminder(ctx, store, host);
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
  };
}

test("off is applied even before enabled is true; noSave is idempotent, preserves other config and restores", async (t) => {
  const f = await fixture(t);
  const result = await f.adapter.apply();
  assert.equal(result[0].state, "active");
  assert.equal(result[0].advisoryOnly, true);
  assert.deepEqual(f.fiber.config, { ...f.original, exclude: [...f.original.exclude, "*"] });
  assert.deepEqual(f.entry.options.config, f.raw);
  assert.equal(f.updates[0].noSave, true);
  await f.adapter.apply();
  assert.equal(f.updates.length, 1);
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.entry.options.config, f.raw);
  assert.equal(f.observers.length, 0);
  await f.adapter.revert();
  assert.equal(f.updates.length, 2);
});

test("host/default does not remount; changed delegates explicit mode transitions without checking enabled", async (t) => {
  const f = await fixture(t);
  delete f.settings.repeatReminder;
  await f.adapter.apply();
  assert.equal(f.updates.length, 0);
  f.settings.repeatReminder = "off";
  await f.adapter.changed();
  f.settings.repeatReminder = "host";
  await f.adapter.changed();
  assert.deepEqual(f.fiber.config, f.original);
});

test("missing version, duplicate/inactive target and modified inventory reject before lifecycle writes", async (t) => {
  for (const change of [
    (f) => {
      f.host.version = "future";
    },
    (f) => f.entries([f.entry, f.entry]),
    (f) => {
      f.fiber.state = 0;
    },
    (f) => {
      f.entry.moduleNamespace = { apply() {} };
    },
    (f) => writeFileSync(f.filename, "export function apply(){return 1}"),
  ]) {
    const f = await fixture(t);
    change(f);
    assert.equal(f.adapter.capabilities()[0].state, "unsupported");
    await assert.rejects(f.adapter.apply(), { code: "UNSUPPORTED_CAPABILITY" });
    assert.equal(f.updates.length, 0);
  }
});

test("async update completes before active, veto retains original and observers are always removed", async (t) => {
  const f = await fixture(t);
  let release;
  f.hook(async (next) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return next();
  });
  let done = false;
  const applying = f.adapter.apply().then((value) => {
    done = true;
    return value;
  });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.deepEqual(f.fiber.config, f.original);
  release();
  assert.equal((await applying)[0].state, "active");
  assert.equal(f.observers.length, 0);
  f.hook(async (next) => next());
  await f.adapter.revert();
  f.hook(async () => {});
  await assert.rejects(
    f.adapter.apply(),
    (error) => error.code === "CONFIG_NOT_APPLIED" && error.partial.restored,
  );
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.observers.length, 0);
});

test("startup failure after owned config assignment rolls back, and cancellation waits for safe restoration", async (t) => {
  const f = await fixture(t);
  let failed = false;
  f.hook(async (next) => {
    await next();
    if (!failed) {
      failed = true;
      f.fiber.state = 0;
      throw new Error("Synthetic activation failed");
    }
  });
  await assert.rejects(f.adapter.apply(), (error) => error.partial.restored === true);
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(f.observers.length, 0);
  f.hook(async (next) => next());
  const abort = new AbortController();
  abort.abort();
  const count = f.updates.length;
  await assert.rejects(f.adapter.apply({ signal: abort.signal }), { code: "ABORTED" });
  assert.equal(f.updates.length, count);
  f.hook(async (next) => {
    await next();
    abortDuring.abort();
  });
  const abortDuring = new AbortController();
  await assert.rejects(
    f.adapter.apply({ signal: abortDuring.signal }),
    (error) => error.code === "ABORTED" && error.partial.restored,
  );
  assert.deepEqual(f.fiber.config, f.original);
});

test("foreign config or entry changes are never overwritten during apply/revert", async (t) => {
  const f = await fixture(t);
  await f.adapter.apply();
  const external = { ...f.fiber.config, argumentsPreviewChars: 99 };
  f.fiber.config = external;
  assert.equal(f.adapter.capabilities()[0].code, "CONFLICT");
  await assert.rejects(f.adapter.apply(), { code: "CONFLICT" });
  await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
  assert.equal(f.fiber.config, external);
  const g = await fixture(t);
  await g.adapter.apply();
  g.entry.options.config = { ...g.raw, argumentsPreviewChars: 23 };
  const before = g.updates.length;
  await assert.rejects(g.adapter.revert(), { code: "CONFLICT" });
  assert.equal(g.updates.length, before);
});
