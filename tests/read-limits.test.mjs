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
        }, this);
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
    extra(overrides = {}) {
      const config = { ...structuredClone(original), ...overrides };
      const extraRaw = structuredClone(config);
      const extraFiber = { ...fiber, config, runtime: fiber.runtime };
      const extraEntry = {
        options: { name: entry.options.name, config: extraRaw },
        fiber: extraFiber,
        moduleNamespace: namespace,
      };
      extraFiber.entry = extraEntry;
      fiber.runtime.fibers.push(extraFiber);
      entries.push(extraEntry);
      return {
        entry: extraEntry,
        fiber: extraFiber,
        raw: extraRaw,
        original: structuredClone(config),
      };
    },
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

test("distinct root and retained preset entries apply and restore independent original caps", async (t) => {
  const f = await fixture(t);
  const preset = f.extra({ readMaxBytes: 256, readStreamMinSize: 16, edit: false });
  f.entries([f.entry]);
  f.registry([f.fiber.runtime]);
  const capability = f.adapter.capabilities()[0];
  assert.equal(capability.state, "available");
  assert.equal(capability.targetCount, 2);
  assert.equal(capability.effectiveCaps, null);
  const active = (await f.adapter.apply())[0];
  assert.equal(active.state, "active");
  assert.equal(active.coverage, "complete");
  assert.equal(active.effective, 80);
  assert.equal(active.effectiveCaps, null, "Different stream thresholds are not aggregated");
  assert.equal(active.appliedTargetCount, 2);
  assert.equal(active.ownedTargetCount, 2);
  assert.deepEqual(
    active.targets.map((target) => target.effectiveCaps.readMaxBytes),
    [80, 80],
  );
  assert.deepEqual(
    active.targets.map((target) => target.effectiveCaps.readStreamMinSize),
    [10485760, 16],
  );
  assert.equal(preset.fiber.config.edit, false);
  f.settings.readLimit = 90;
  await f.adapter.changed();
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
  assert.deepEqual(preset.fiber.config, preset.original);
  assert.equal(f.entry.options.config, f.raw);
  assert.equal(preset.entry.options.config, preset.raw);
  assert.deepEqual(preset.raw, preset.original);
  assert.ok(f.updates.every((row) => row.noSave === true));
  assert.equal(f.updates.length, 6);
});

test("new targets need explicit apply, disabled reads stay disabled, and exited ownership stays visible", async (t) => {
  const f = await fixture(t);
  const disabled = f.extra({ read: false, readMaxBytes: 12 });
  await f.adapter.apply();
  assert.equal(f.adapter.capabilities()[0].targetCount, 1);
  assert.deepEqual(disabled.fiber.config, disabled.original);
  const added = f.extra({ readMaxBytes: 256 });
  const pending = f.adapter.capabilities()[0];
  assert.equal(pending.state, "available");
  assert.equal(pending.coverage, "partial");
  assert.equal(pending.targetCount, 2);
  assert.equal(pending.appliedTargetCount, 1);
  assert.equal(pending.effective, null);
  assert.equal(pending.effectiveCaps, null);
  assert.match(pending.detail, /需重新应用/);
  assert.equal(added.fiber.config.readMaxBytes, 256);
  assert.equal((await f.adapter.apply())[0].state, "active");
  assert.equal(f.updates.length, 2, "An unchanged owned target must not be remounted");
  f.entries([f.entry, disabled.entry]);
  const exited = f.adapter.capabilities()[0];
  assert.equal(exited.state, "unsupported");
  assert.equal(exited.coverage, "conflict");
  assert.equal(exited.targetCount, 1);
  assert.equal(exited.ownedTargetCount, 2);
  assert.equal(exited.effective, null);
  assert.equal(exited.targets.find((target) => target.state === "missing").owned, true);
  await assert.rejects(f.adapter.revert(), (error) => {
    assert.equal(error.code, "CONFLICT");
    assert.equal(error.partial.targets.length, 2);
    assert.equal(error.partial.targets.filter((target) => target.restored).length, 1);
    return error.partial.owned && !error.partial.restored;
  });
  assert.deepEqual(
    f.fiber.config,
    f.original,
    "Missing targets do not block independent restoration",
  );
  f.entries([f.entry, added.entry, disabled.entry]);
  await f.adapter.revert();
  assert.deepEqual(added.fiber.config, added.original);
  assert.deepEqual(disabled.fiber.config, disabled.original);
  assert.equal(f.adapter.capabilities()[0].ownedTargetCount, 0);
});

test("multi-target failure and cancellation roll back each attempted target to its previous budget", async (t) => {
  for (const cancel of [false, true]) {
    const f = await fixture(t);
    const second = f.extra({ readMaxBytes: 128 });
    await f.adapter.apply();
    const before = [structuredClone(f.fiber.config), structuredClone(second.fiber.config)];
    f.settings.readLimit = 90;
    const abort = new AbortController();
    let once = true;
    f.hook(async (next, fiber) => {
      await next();
      if (fiber === second.fiber && once) {
        once = false;
        if (cancel) abort.abort();
        else throw new Error("Synthetic second-target failure");
      }
    });
    await assert.rejects(f.adapter.changed({ signal: abort.signal }), (error) => {
      assert.equal(error.partial.targets.length, 2);
      assert.ok(error.partial.targets.every((target) => target.restored && target.owned));
      return error.partial.restored && error.partial.owned;
    });
    assert.deepEqual([f.fiber.config, second.fiber.config], before);
    assert.equal(f.adapter.capabilities()[0].state, "available");
    f.hook(async (next) => next());
    await f.adapter.revert();
    assert.deepEqual(f.fiber.config, f.original);
    assert.deepEqual(second.fiber.config, second.original);
  }
});

test("one conflicting target cannot block other rollback or restoration, and external edits remain exact", async (t) => {
  const f = await fixture(t);
  const second = f.extra({ readMaxBytes: 128 });
  let external;
  let once = true;
  f.hook(async (next, fiber) => {
    await next();
    if (fiber === second.fiber && once) {
      once = false;
      external = { ...f.fiber.config, readMaxBytes: 77 };
      f.fiber.config = external;
      throw new Error("Synthetic failure after external first-target change");
    }
  });
  await assert.rejects(f.adapter.apply(), (error) => {
    assert.equal(error.partial.targets.filter((target) => target.restored).length, 1);
    return !error.partial.restored && error.partial.owned;
  });
  assert.equal(f.fiber.config, external);
  assert.deepEqual(second.fiber.config, second.original);
  f.hook(async (next) => next());
  f.entries([second.entry]);
  f.registry([]);
  await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
  assert.equal(f.fiber.config, external);
  assert.equal(f.adapter.capabilities()[0].ownedTargetCount, 1);

  const g = await fixture(t);
  const other = g.extra({ readMaxBytes: 256 });
  await g.adapter.apply();
  other.entry.options.config = { ...other.raw, edit: false };
  const externalRaw = other.entry.options.config;
  await assert.rejects(
    g.adapter.revert(),
    (error) =>
      error.code === "CONFLICT" &&
      error.partial.targets.filter((target) => target.restored).length === 1,
  );
  assert.deepEqual(g.fiber.config, g.original);
  assert.equal(other.entry.options.config, externalRaw);
  assert.equal(other.fiber.config.readMaxBytes, 80);
});

test("externally disabling an owned read retains conflict responsibility without counting it as an enabled target", async (t) => {
  const f = await fixture(t);
  const second = f.extra();
  await f.adapter.apply();
  const external = { ...second.fiber.config, read: false };
  second.fiber.config = external;
  const capability = f.adapter.capabilities()[0];
  assert.equal(capability.targetCount, 1);
  assert.equal(capability.appliedTargetCount, 1);
  assert.equal(capability.ownedTargetCount, 2);
  assert.equal(capability.coverage, "conflict");
  assert.equal(capability.state, "unsupported");
  assert.equal(capability.effective, null);
  await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
  assert.deepEqual(f.fiber.config, f.original);
  assert.equal(second.fiber.config, external);
});

test("an equal-valued external parsed-config replacement remains a conflict during multi-target rollback", async (t) => {
  const f = await fixture(t);
  const second = f.extra({ readMaxBytes: 128 });
  let external;
  let once = true;
  f.hook(async (next, fiber) => {
    await next();
    if (fiber === second.fiber && once) {
      once = false;
      external = structuredClone(f.fiber.config);
      f.fiber.config = external;
      throw new Error("Synthetic equal-valued external replacement");
    }
  });
  await assert.rejects(f.adapter.apply(), (error) => {
    assert.equal(error.partial.targets.filter((target) => target.restored).length, 1);
    assert.equal(error.partial.targets.find((target) => !target.restored).error.code, "CONFLICT");
    return error.partial.owned && !error.partial.restored;
  });
  assert.equal(f.fiber.config, external);
  assert.equal(f.fiber.config.readMaxBytes, 80);
  assert.deepEqual(second.fiber.config, second.original);
  assert.equal(f.adapter.capabilities()[0].code, "CONFLICT");
  const count = f.updates.length;
  await assert.rejects(f.adapter.revert(), { code: "CONFLICT" });
  assert.equal(f.updates.length, count);
});

test("a restoration veto retains only that target and permits an explicit retry", async (t) => {
  const f = await fixture(t);
  const second = f.extra({ readMaxBytes: 128 });
  await f.adapter.apply();
  f.hook(async (next, fiber) => (fiber === f.fiber ? undefined : next()));
  await assert.rejects(f.adapter.revert(), (error) => {
    assert.equal(error.code, "CONFIG_NOT_APPLIED");
    assert.equal(error.partial.targets.length, 2);
    assert.equal(error.partial.targets.filter((target) => target.restored).length, 1);
    return error.partial.owned && !error.partial.restored;
  });
  assert.equal(f.fiber.config.readMaxBytes, 80);
  assert.deepEqual(second.fiber.config, second.original);
  assert.equal(f.adapter.capabilities()[0].ownedTargetCount, 1);
  f.hook(async (next) => next());
  await f.adapter.revert();
  assert.deepEqual(f.fiber.config, f.original);
});

test("targets appearing during asynchronous verification or update cannot produce global active", async (t) => {
  for (const duringUpdate of [false, true]) {
    const f = await fixture(t);
    let added;
    if (duringUpdate)
      f.hook(async (next) => {
        await next();
        added ??= f.extra({ readMaxBytes: 256 });
      });
    else {
      const verify = f.adapter.moduleIdentity.bind(f.adapter);
      f.adapter.moduleIdentity = async (target) => {
        await verify(target);
        added ??= f.extra({ readMaxBytes: 256 });
      };
    }
    await assert.rejects(f.adapter.apply(), { code: "CONFLICT" });
    assert.deepEqual(f.fiber.config, f.original);
    assert.deepEqual(added.fiber.config, added.original);
    assert.equal(f.adapter.capabilities()[0].state, "available");
    assert.equal(f.adapter.capabilities()[0].appliedTargetCount, 0);
  }
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

test("an owned Loader entry losing its fiber reports conflict without losing restoration responsibility", async (t) => {
  for (const remove of [
    (entry) => {
      delete entry.fiber;
    },
    (entry) => {
      entry.fiber = undefined;
    },
  ]) {
    const f = await fixture(t);
    await f.adapter.apply();
    const applied = f.fiber.config;
    const snapshot = structuredClone(applied);
    const count = f.updates.length;
    remove(f.entry);
    const capability = f.adapter.capabilities()[0];
    assert.equal(capability.state, "unsupported");
    assert.equal(capability.code, "CONFLICT");
    assert.equal(capability.coverage, "conflict");
    assert.equal(capability.targetCount, 0);
    assert.equal(capability.appliedTargetCount, 0);
    assert.equal(capability.ownedTargetCount, 1);
    assert.equal(capability.effective, null);
    assert.equal(capability.effectiveCaps, null);
    assert.deepEqual(
      capability.targets.map(({ state, owned, effectiveCaps }) => ({
        state,
        owned,
        effectiveCaps,
      })),
      [{ state: "conflict", owned: true, effectiveCaps: null }],
    );
    for (const operation of ["apply", "revert"])
      await assert.rejects(
        f.adapter[operation](),
        (error) => error.code === "CONFLICT" && !error.partial.restored && error.partial.owned,
      );
    assert.equal(f.updates.length, count);
    assert.equal(f.fiber.config, applied);
    assert.deepEqual(applied, snapshot);
    assert.equal(f.entry.options.config, f.raw);
    assert.deepEqual(f.raw, f.original);
    assert.equal(f.adapter.capabilities()[0].ownedTargetCount, 1);
    f.entry.fiber = f.fiber;
    await f.adapter.revert();
    assert.deepEqual(f.fiber.config, f.original);
    assert.equal(f.adapter.capabilities()[0].ownedTargetCount, 0);
  }
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
