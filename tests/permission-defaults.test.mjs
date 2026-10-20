import test from "node:test";
import assert from "node:assert/strict";
import { PermissionDefaults } from "../src/host/permission-defaults.js";

const host = { supported: true, version: "0.2.1-rc.2" };
const write = Symbol.for("cosmokit.volatile.write");
function volatile(value) {
  return Object.freeze({
    get: () => value,
    [write](next) {
      value = next;
    },
  });
}
function fixture(overrides = {}) {
  const settings = { enabled: true, permissionDefault: "", autoApprove: true, ...overrides };
  const original = volatile("workspace-write");
  const config = { defaultPreset: original };
  const entry = {
    options: { name: "@deepseek-ai/dsh-permission-presets" },
    fiber: { state: 2, config },
  };
  const options = [
    { value: "workspace-write", name: "Workspace" },
    { value: "danger-full-access", name: "Full", description: "Official explicit preset" },
  ];
  const notifications = [];
  const presets = {
    emitCatalogChanged: () => notifications.push("catalog-changed"),
    ctx: { fiber: entry.fiber },
    catalog: () => ({
      options: [...options, { value: "auto", name: "Auto" }],
      defaultOptions: options,
      defaultPreset: config.defaultPreset.get(),
    }),
  };
  const ctx = {
    permissionPresets: presets,
    configEditor: {
      entries: () => [entry],
      configuration() {
        assert.fail("No profile read");
      },
      edit() {
        assert.fail("No profile write");
      },
    },
    settings: {
      update() {
        assert.fail("No host setting write");
      },
    },
  };
  const store = {
    dispatch(action) {
      assert.equal(action, "settings.get");
      return { value: settings };
    },
  };
  const adapter = new PermissionDefaults(ctx, store, host);
  return {
    adapter,
    ctx,
    settings,
    options,
    presets,
    config,
    entry,
    original,
    store,
    notifications,
  };
}
const code = (expected) => (error) => error.code === expected;

test("only official defaultOptions are selectable; auto/custom/approval policies are not guessed defaults", () => {
  const f = fixture();
  assert.equal(f.adapter.validate(""), "");
  assert.equal(f.adapter.validate("danger-full-access"), "danger-full-access");
  for (const name of ["auto", "custom", "never", "ask", "unlisted", " DANGER "])
    assert.throws(() => f.adapter.validate(name), code("INVALID_PERMISSION_DEFAULT"));
  assert.throws(() => f.adapter.validate(null), code("INVALID_INPUT"));
  assert.deepEqual(f.adapter.status().options, f.options);
  assert.equal(f.adapter.status().effective, "workspace-write");
  f.adapter.apply();
  assert.equal(
    f.config.defaultPreset.get(),
    "workspace-write",
    "autoApprove:true never selects approval never or any preset",
  );
  assert.equal(f.adapter.status().active, false);
  f.adapter.revert();
});

test("runtime choice is dynamic, empty/disabled follow current original and revert restores exact updated volatile reference", () => {
  const f = fixture({ permissionDefault: "danger-full-access" });
  const before = Object.getOwnPropertyDescriptor(f.config, "defaultPreset");
  assert.equal(f.adapter.status().active, false);
  f.adapter.apply();
  const replacement = f.config.defaultPreset;
  assert.notEqual(replacement, f.original);
  assert.equal(Object.isFrozen(replacement), true);
  assert.equal(replacement.get(), "danger-full-access");
  assert.equal(f.adapter.status().effective, "danger-full-access");
  assert.equal(f.adapter.status().active, true);
  assert.equal(f.adapter.capabilities()[0].state, "active");
  assert.equal(f.original.get(), "workspace-write");
  replacement[write]("danger-full-access");
  assert.equal(
    f.original.get(),
    "danger-full-access",
    "Official owner symbol writes still reach the original closure",
  );
  f.settings.permissionDefault = "";
  assert.equal(replacement.get(), "danger-full-access");
  replacement[write]("workspace-write");
  assert.equal(replacement.get(), "workspace-write");
  f.settings.permissionDefault = "danger-full-access";
  f.settings.enabled = false;
  assert.equal(replacement.get(), "workspace-write");
  f.settings.enabled = true;
  assert.equal(replacement.get(), "danger-full-access");
  f.adapter.apply();
  assert.equal(f.config.defaultPreset, replacement);
  f.adapter.revert();
  f.adapter.revert();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.config, "defaultPreset"), before);
  assert.equal(f.config.defaultPreset.get(), "workspace-write");
});

test("missing/ambiguous/immutable/unsupported owner is optional only when no preset was selected", () => {
  for (const change of [
    (f) => delete f.ctx.permissionPresets,
    (f) => delete f.ctx.configEditor,
    (f) => (f.entry.fiber.state = 0),
    (f) => (f.ctx.configEditor.entries = () => [f.entry, f.entry]),
    (f) => Object.freeze(f.config),
    (f) => (f.adapter.host = { supported: true, version: "unverified" }),
    (f) => (f.adapter.host = { supported: false, version: host.version }),
  ]) {
    const f = fixture();
    change(f);
    assert.equal(f.adapter.apply().available, false);
    assert.equal(f.adapter.capabilities()[0].state, "unsupported");
    assert.equal(f.config.defaultPreset, f.original);
    f.settings.permissionDefault = "danger-full-access";
    assert.throws(() => f.adapter.apply(), code("UNSUPPORTED_CAPABILITY"));
    f.adapter.revert();
  }
});

test("invalid new or dynamically bypassed settings never silently choose another preset", () => {
  const f = fixture({ permissionDefault: "unlisted" });
  assert.throws(() => f.adapter.apply(), code("INVALID_PERMISSION_DEFAULT"));
  assert.equal(f.config.defaultPreset, f.original);
  f.settings.permissionDefault = "workspace-write";
  f.adapter.apply();
  f.settings.permissionDefault = "unlisted";
  assert.throws(() => f.config.defaultPreset.get(), code("INVALID_PERMISSION_DEFAULT"));
  assert.equal(f.adapter.status().available, false);
  assert.equal(f.adapter.status().effective, null);
  assert.deepEqual(f.adapter.status().options, f.options);
  assert.equal(
    f.adapter.validate("danger-full-access"),
    "danger-full-access",
    "A valid correction remains selectable",
  );
  f.settings.enabled = false;
  assert.equal(f.config.defaultPreset.get(), "workspace-write");
  f.adapter.revert();
});

test("external field/descriptor replacement is preserved and reported as a conflict", () => {
  for (const metadataOnly of [false, true]) {
    const f = fixture({ permissionDefault: "danger-full-access" });
    f.adapter.apply();
    const replacement = f.config.defaultPreset;
    const external = volatile("workspace-write");
    if (metadataOnly) Object.defineProperty(f.config, "defaultPreset", { enumerable: false });
    else f.config.defaultPreset = external;
    const externalDescriptor = Object.getOwnPropertyDescriptor(f.config, "defaultPreset");
    assert.equal(
      replacement.get(),
      "workspace-write",
      "A stale wrapper stops selecting from its old table",
    );
    assert.equal(f.adapter.status().available, false);
    assert.throws(() => f.adapter.apply(), code("CONFLICT"));
    assert.throws(() => f.adapter.revert(), code("CONFLICT"));
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(f.config, "defaultPreset"),
      externalDescriptor,
    );
  }
});

test("fiber/config/service/context remount invalidates old selection and does not overwrite the new owner", () => {
  for (const field of ["fiber", "config", "service", "context"]) {
    const f = fixture({ permissionDefault: "danger-full-access" });
    f.adapter.apply();
    const old = f.config.defaultPreset;
    const nextConfig = { defaultPreset: volatile("workspace-write") };
    if (field === "fiber") f.entry.fiber = { state: 2, config: nextConfig };
    if (field === "config") f.entry.fiber.config = nextConfig;
    if (field === "service")
      f.ctx.permissionPresets = {
        catalog: () => ({
          defaultOptions: [{ value: "workspace-write" }],
          defaultPreset: "workspace-write",
        }),
      };
    if (field === "context") f.adapter.ctx = {};
    assert.equal(old.get(), "workspace-write");
    assert.equal(f.adapter.status().available, false);
    assert.throws(() => f.adapter.apply(), code("CONFLICT"));
    f.adapter.revert();
    assert.equal(f.config.defaultPreset, f.original);
    assert.equal(nextConfig.defaultPreset.get(), "workspace-write");
  }
});

test("apply failure restores its exact owned field without masking the original error", () => {
  const f = fixture({ permissionDefault: "danger-full-access" });
  const before = Object.getOwnPropertyDescriptor(f.config, "defaultPreset");
  let calls = 0;
  f.ctx.configEditor.entries = () => {
    if (++calls === 2) throw new Error("Synthetic owner registry failure");
    return [f.entry];
  };
  assert.throws(() => f.adapter.apply(), /Synthetic owner registry failure/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.config, "defaultPreset"), before);
  f.ctx.configEditor.entries = () => [f.entry];
  f.adapter.apply();
  f.adapter.revert();
});

test("catalog invalidation is explicit, reports no delivery acknowledgement and does not hide notification errors", () => {
  const f = fixture({ permissionDefault: "danger-full-access" });
  f.adapter.apply();
  assert.equal(f.notifications.length, 1);
  f.adapter.apply();
  assert.equal(f.notifications.length, 1, "Idempotent apply does not duplicate change events");
  f.settings.enabled = false;
  assert.deepEqual(f.adapter.changed(), { notified: true, deliveryConfirmed: false });
  assert.equal(f.notifications.length, 2);
  f.adapter.revert();
  assert.equal(f.notifications.length, 3);
  f.presets.emitCatalogChanged = () => {
    throw new Error("Synthetic notification failure");
  };
  assert.throws(() => f.adapter.apply(), /Synthetic notification failure/);
  assert.equal(
    f.config.defaultPreset,
    f.original,
    "Failed apply notification rolls back the owned field",
  );
  f.presets.emitCatalogChanged = () => {};
  f.adapter.apply();
  f.presets.emitCatalogChanged = () => {
    throw new Error("Synthetic revert notification failure");
  };
  assert.throws(() => f.adapter.revert(), /Synthetic revert notification failure/);
  assert.equal(
    f.config.defaultPreset,
    f.original,
    "Revert is restored even if its notification fails",
  );
  delete f.ctx.permissionPresets;
  f.settings.permissionDefault = "";
  assert.equal(f.adapter.changed().notified, false);
});
