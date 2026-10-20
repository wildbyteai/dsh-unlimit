import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { HostExtensions } from "../src/host/extensions.js";

function fixture() {
  const settings = { enabled: false, readLimit: 1048576, retryLimit: 3, hooksDeny: true };
  const original = Object.freeze({ get: () => true });
  const config = { enabled: original, maxBytes: 4096 };
  const entry = {
    options: { name: "@deepseek-ai/dsh-session-log-deepseek" },
    fiber: { state: 2, config },
  };
  const ctx = {
    configEditor: {
      entries: () => [entry],
      configuration() {
        assert.fail("must not read profile layers");
      },
      edit() {
        assert.fail("must not write profile");
      },
    },
    settings: {
      update() {
        assert.fail("must not persist settings");
      },
    },
  };
  const store = {
    dispatch(action) {
      assert.equal(action, "settings.get");
      return { value: settings };
    },
  };
  return {
    settings,
    original,
    config,
    entry,
    ctx,
    store,
    extensions: new HostExtensions(ctx, store),
  };
}

test("capabilities report exact missing global APIs even when related saved booleans exist", () => {
  const f = fixture();
  const capabilities = f.extensions.capabilities();
  for (const id of ["readLimit", "hooks", "memory"]) {
    const item = capabilities.find((item) => item.id === id);
    assert.equal(item.state, "unsupported");
    assert.ok(item.detail.length > 15);
  }
  assert.match(capabilities.find((item) => item.id === "readLimit").detail, /行数/);
  assert.equal(capabilities.find((item) => item.id === "sessionLogUpload").state, "available");
  const absent = new HostExtensions({}, f.store);
  assert.equal(
    absent.capabilities().find((item) => item.id === "sessionLogUpload").state,
    "unsupported",
  );
  assert.ok(absent.apply().every((item) => item.state === "unsupported"));
  absent.revert();
});

test("replace the container field, preserve frozen original, dynamically disable upload and restore the descriptor", () => {
  const f = fixture();
  const before = Object.getOwnPropertyDescriptor(f.config, "enabled");
  f.extensions.apply();
  const replacement = f.config.enabled;
  assert.notEqual(replacement, f.original);
  assert.equal(Object.isFrozen(replacement), true);
  assert.equal(f.original.get(), true);
  assert.equal(replacement.get(), true);
  f.settings.enabled = true;
  assert.equal(replacement.get(), false);
  f.settings.enabled = false;
  assert.equal(replacement.get(), true);
  f.extensions.apply();
  assert.equal(f.config.enabled, replacement);
  assert.equal(
    f.extensions.capabilities().find((item) => item.id === "sessionLogUpload").state,
    "active",
  );
  f.extensions.revert();
  f.extensions.revert();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.config, "enabled"), before);
});

test("immutable, inactive, ambiguous or wrong-package entries cannot be presented as supported", () => {
  for (const change of [
    (f) => Object.freeze(f.config),
    (f) => {
      f.entry.fiber.state = 0;
    },
    (f) => {
      f.ctx.configEditor.entries = () => [f.entry, f.entry];
    },
    (f) => {
      f.entry.options.name = "some-other-plugin";
    },
  ]) {
    const f = fixture();
    change(f);
    const before = f.config.enabled;
    assert.equal(
      f.extensions.capabilities().find((item) => item.id === "sessionLogUpload").state,
      "unsupported",
    );
    f.extensions.apply();
    assert.equal(f.config.enabled, before);
  }
});

test("an apply failure rolls back the exact config descriptor and permits a clean retry", () => {
  const f = fixture();
  const before = Object.getOwnPropertyDescriptor(f.config, "enabled");
  let calls = 0;
  f.ctx.configEditor.entries = () => {
    if (++calls === 2) throw new Error("synthetic registry failure");
    return [f.entry];
  };
  assert.throws(() => f.extensions.apply(), /synthetic registry failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.config, "enabled"), before);
  f.ctx.configEditor.entries = () => [f.entry];
  f.extensions.apply();
  f.extensions.revert();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.config, "enabled"), before);
});

test("external ref replacement and host remounts are visible and never overwritten", () => {
  const f = fixture();
  f.extensions.apply();
  const external = Object.freeze({ get: () => false });
  f.config.enabled = external;
  assert.equal(
    f.extensions.capabilities().find((item) => item.id === "sessionLogUpload").state,
    "unsupported",
  );
  assert.throws(
    () => f.extensions.apply(),
    (error) => error.code === "CONFLICT",
  );
  assert.throws(
    () => f.extensions.revert(),
    (error) => error.code === "CONFLICT",
  );
  assert.equal(f.config.enabled, external);

  const g = fixture();
  g.extensions.apply();
  const newConfig = { enabled: Object.freeze({ get: () => true }) };
  g.entry.fiber.config = newConfig;
  assert.equal(
    g.extensions.capabilities().find((item) => item.id === "sessionLogUpload").state,
    "unsupported",
  );
  assert.throws(
    () => g.extensions.apply(),
    (error) => error.code === "CONFLICT",
  );
  g.extensions.revert();
  assert.equal(newConfig.enabled.get(), true);
  assert.equal(g.config.enabled, g.original);
});

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
test(
  "official 0.2.1 Cordis config and log plugin honor the reversible reference in an isolated context",
  {
    skip: runtimeRoot
      ? false
      : "Set DSH_UNLIMIT_RUNTIME to a local official 0.2.1-rc.2 runtime; never loads a user profile",
  },
  async () => {
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
    assert.equal(manifest.release.version, "0.2.1-rc.2");
    const requireRuntime = createRequire(join(runtimeRoot, "package.json"));
    const load = async (name) => {
      const filename = requireRuntime.resolve(name);
      const item = manifest.files.find((item) => item.path === relative(runtimeRoot, filename));
      assert.ok(item, `official manifest must list ${name}`);
      assert.equal(
        createHash("sha256").update(readFileSync(filename)).digest("hex"),
        item.sha256,
        `${name} must be unmodified`,
      );
      return import(pathToFileURL(filename).href);
    };
    const [{ Context, Service }, { createVolatile, updateVolatile }, log] = await Promise.all([
      load("@deepseek-ai/cordis"),
      load("@deepseek-ai/cosmokit"),
      load("@deepseek-ai/dsh-session-log-deepseek"),
    ]);
    const ctx = new Context();
    const fields = new Map();
    const events = [{ type: "turn/start", seq: 0, time: 0, data: { turn: 0 } }];
    const session = {
      id: "synthetic-log-session",
      header: { version: 1, id: "synthetic-log-session", createdAt: 0 },
      seq: 1,
      eventAt: (index) => events[index],
      snapshotEvents: (offset) => events.slice(offset),
    };
    const owner = ctx.plugin({
      name: "synthetic-extension-test-services",
      apply(scope) {
        const registry = new Service(scope, "deepseekLlmApiExtensions");
        registry.register = (name, provider) => {
          fields.set(name, provider);
          return () => fields.delete(name);
        };
        const sessions = new Service(scope, "sessions");
        sessions.get = () => session;
      },
    });
    await owner.await();
    const fiber = ctx.plugin(log, { enabled: true, maxBytes: 4096 });
    let extension;
    try {
      await fiber.await();
      assert.equal(fiber.state, 2);
      const descriptor = Object.getOwnPropertyDescriptor(fiber.config, "enabled");
      assert.equal(descriptor.writable || descriptor.configurable, true);
      assert.equal(Object.isFrozen(fiber.config.enabled), true);
      const original = fiber.config.enabled;
      const settings = { enabled: true };
      const store = { dispatch: () => ({ value: settings }) };
      extension = new HostExtensions(
        {
          loader: {
            entries: () => [{ options: { name: "@deepseek-ai/dsh-session-log-deepseek" }, fiber }],
          },
        },
        store,
      );
      const prepare = () => fields.get("dsh_session_log").prepare({ sessionId: session.id });
      assert.equal(prepare().value.events.length, 1);
      extension.apply();
      assert.equal(prepare(), undefined);
      settings.enabled = false;
      assert.equal(prepare().value.events.length, 1);
      // Simulate an official owner volatile commit while the overlay is active.
      updateVolatile(fiber.config.enabled, createVolatile(false));
      assert.equal(original.get(), false);
      assert.equal(prepare(), undefined);
      updateVolatile(fiber.config.enabled, createVolatile(true));
      extension.revert();
      assert.deepEqual(Object.getOwnPropertyDescriptor(fiber.config, "enabled"), descriptor);
      assert.equal(prepare().value.events.length, 1);
    } finally {
      extension?.revert();
      await fiber.dispose();
      await owner.dispose();
    }
  },
);
