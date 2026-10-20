import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import childProcess from "node:child_process";
import { PermissionDefaults } from "../src/host/permission-defaults.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const officialOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME to official 0.2.1-rc.2; no profile or desktop is loaded",
  timeout: 15000,
};
async function fixture(t) {
  const attempts = [];
  const deny = (name) => () => {
    attempts.push(name);
    throw new Error(`Permission defaults fixture forbids ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket listen"));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  syncBuiltinESMExports();
  t.after(() => {
    assert.deepEqual(attempts, []);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const root = realpathSync(runtimeRoot),
    manifest = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const requireHost = createRequire(join(root, "package.json"));
  const evidence = [];
  const load = async (name) => {
    const filename = requireHost.resolve(name),
      path = relative(root, filename);
    const entry = manifest.files.find((item) => item.path === path);
    assert.ok(entry, `Missing official entry ${name}`);
    const sha256 = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(sha256, entry.sha256, `Refusing modified official module ${name}`);
    evidence.push({ name, path, sha256 });
    return import(pathToFileURL(filename).href);
  };
  const names = {
    cordis: "@deepseek-ai/cordis",
    cosmokit: "@deepseek-ai/cosmokit",
    prompt: "@deepseek-ai/dsh-system-prompt",
    projections: "@deepseek-ai/dsh-session-projection",
    sessions: "@deepseek-ai/dsh-session",
    approval: "@deepseek-ai/dsh-user-approval",
    sandbox: "@deepseek-ai/dsh-sandbox-policy",
    permission: "@deepseek-ai/dsh-permission-presets",
    persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
  };
  const api = Object.fromEntries(
    await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
  );
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-permission-default-")));
  const ctx = new api.cordis.Context(),
    fibers = [],
    entries = [],
    captures = [],
    notifications = [];
  const settings = { enabled: true, permissionDefault: "", autoApprove: true };
  const store = {
    dispatch(action) {
      assert.equal(action, "settings.get");
      return { value: settings };
    },
  };
  const adapter = new PermissionDefaults(ctx, store, {
    supported: true,
    version: manifest.release.version,
  });
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2);
    return fiber;
  };
  t.after(async () => {
    try {
      adapter.revert();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx.fiber.dispose();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await mount({
    name: "synthetic-permission-foundation",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      scope.on("permission-presets/catalog-changed", () =>
        notifications.push(ctx.permissionPresets.catalog().defaultPreset),
      );
      new api.approval.ApprovalService(scope, { policy: "ask" });
      new api.sandbox.SandboxPolicyService(scope, {
        mode: "workspace-write",
        workspaceRoot: directory,
      });
      // Only pinning reads this declared default; no executor is mounted or invoked.
      const shell = new api.cordis.Service(scope, "shell");
      shell.sandboxMode = "workspace-write";
      const editor = new api.cordis.Service(scope, "configEditor");
      editor.entries = () => entries;
      editor.configuration = deny("profile configuration read");
      editor.edit = deny("profile configuration write");
    },
  });
  await mount(api.persistence, {
    root: join(directory, "logs"),
    compression: "none",
    listConcurrency: 1,
  });
  const mountPresets = async (defaultPreset = "workspace-write") => {
    const fiber = await mount(api.permission.PermissionPresetService, { defaultPreset });
    entries.push({ options: { name: "@deepseek-ai/dsh-permission-presets" }, fiber });
    return fiber;
  };
  const fiber = await mountPresets();
  const create = (id, options = {}) => {
    const session = ctx.sessions.create(id, {
      ...options,
      meta: { cwd: directory, ...options.meta },
    });
    captures.push(session);
    return session;
  };
  const snapshot = (session) => session.snapshotEvents();
  const facts = (session) =>
    snapshot(session)
      .filter((event) =>
        ["permission/preset", "sandbox/mode", "approval/policy"].includes(event.type),
      )
      .map((event) => [event.type, event.data]);
  const verify = async () => {
    await ctx.sessionPersistence.flush();
    for (const session of captures) {
      // SessionStore alone has no AgentLoop journal owner. Explicitly persist
      // the observed official events through its public handle for readback.
      const writer = await ctx.sessionPersistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      });
      try {
        await writer.append(snapshot(session));
        await writer.flush();
      } finally {
        await writer.close();
      }
      const reader = await ctx.sessionPersistence.open(session.id, "read");
      try {
        assert.deepEqual((await reader.read()).events, snapshot(session));
      } finally {
        await reader.close();
      }
    }
    t.diagnostic(
      `Official ${manifest.release.version}: ${evidence.length} entry SHA256 checks, ${captures.length} synthetic sessions read back from temporary JSONL; no profile/network/executor.`,
    );
  };
  return {
    api,
    ctx,
    fiber,
    entries,
    mountPresets,
    adapter,
    settings,
    create,
    snapshot,
    facts,
    verify,
    evidence,
    notifications,
  };
}

test(
  "official fresh-session defaults pin selected canonical facts while existing/seeded/restricted sessions and UI switches retain their semantics",
  officialOnly,
  async (t) => {
    const f = await fixture(t),
      service = f.ctx.permissionPresets;
    const originalRef = f.fiber.config.defaultPreset;
    assert.equal(Object.isFrozen(originalRef), true);
    const existing = f.create("existing-before-override");
    const restricted = f.create("existing-explicitly-restricted");
    f.api.sandbox.setSandboxMode(restricted, "read-only");
    const before = [f.snapshot(existing), f.snapshot(restricted)];
    f.settings.permissionDefault = "danger-full-access";
    f.adapter.apply();
    assert.equal(service.catalog().defaultPreset, "danger-full-access");
    assert.equal(f.notifications.at(-1), "danger-full-access");
    assert.deepEqual(f.adapter.status().options, service.catalog().defaultOptions);
    const fresh = f.create("fresh-selected");
    assert.equal(service.current(fresh), "danger-full-access");
    assert.deepEqual(f.facts(fresh), [
      ["permission/preset", { preset: "danger-full-access" }],
      ["sandbox/mode", { mode: "danger-full-access" }],
      ["approval/policy", { policy: "never" }],
    ]);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: fresh }).mode, "danger-full-access");
    assert.equal(f.ctx.approval.overrideOf(fresh), "never");
    assert.equal(
      await f.ctx.approval.decide(
        { agent: { session: fresh }, signal: new AbortController().signal },
        fresh,
      ),
      "rejected",
      "Official never rejects an approval request; it is not automatic approval",
    );
    assert.deepEqual([f.snapshot(existing), f.snapshot(restricted)], before);
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: restricted }).mode, "read-only");
    const seeded = f.create("explicitly-empty-seed", {
      seed: [],
      meta: { isSeeded: true },
      inheritedEventCount: 0,
    });
    assert.ok(f.snapshot(seeded).some((event) => event.type === "session/end-seed"));
    assert.equal(service.current(seeded), "workspace-write");
    assert.equal(f.ctx.approval.overrideOf(seeded), "ask");
    const restrictedSeed = f.create("restricted-seed", {
      seed: [{ seq: 0, time: 1, type: "sandbox/mode", data: { mode: "read-only" } }],
    });
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: restrictedSeed }).mode, "read-only");
    assert.equal(service.current(restrictedSeed), "custom");
    service.set(fresh, "workspace-write");
    assert.equal(
      service.current(fresh),
      "workspace-write",
      "Official current-session UI write path remains authoritative",
    );
    assert.equal(f.ctx.approval.overrideOf(fresh), "ask");
    assert.equal(f.ctx.sandboxPolicy.resolve({ session: fresh }).mode, "workspace-write");
    assert.equal(
      service.current(f.create("fresh-after-ui-switch")),
      "danger-full-access",
      "UI changes one session, not the chosen future default",
    );
    f.settings.enabled = false;
    assert.deepEqual(f.adapter.changed(), { notified: true, deliveryConfirmed: false });
    assert.equal(f.notifications.at(-1), "workspace-write");
    assert.equal(service.current(f.create("fresh-disabled")), "workspace-write");
    f.settings.enabled = true;
    f.settings.permissionDefault = "";
    assert.equal(service.current(f.create("fresh-empty-choice")), "workspace-write");
    assert.equal(f.ctx.approval.overrideOf(f.create("auto-approve-does-not-map-never")), "ask");
    f.settings.permissionDefault = "danger-full-access";
    f.adapter.revert();
    assert.equal(f.fiber.config.defaultPreset, originalRef);
    assert.equal(service.current(f.create("fresh-after-revert")), "workspace-write");
    assert.deepEqual([f.snapshot(existing), f.snapshot(restricted)], before);
    await f.verify();
  },
);

test(
  "official volatile owner updates survive disabled/revert and remounts invalidate the old defaultOptions snapshot",
  officialOnly,
  async (t) => {
    const f = await fixture(t),
      original = f.fiber.config.defaultPreset;
    f.settings.permissionDefault = "workspace-write";
    f.adapter.apply();
    f.api.cosmokit.updateVolatile(
      f.fiber.config.defaultPreset,
      f.api.cosmokit.createVolatile("danger-full-access"),
    );
    assert.equal(original.get(), "danger-full-access");
    assert.equal(
      f.ctx.permissionPresets.current(f.create("overlay-owner-update")),
      "workspace-write",
    );
    f.settings.enabled = false;
    assert.equal(
      f.ctx.permissionPresets.current(f.create("disabled-owner-update")),
      "danger-full-access",
    );
    f.settings.enabled = true;
    f.settings.permissionDefault = "";
    assert.equal(
      f.ctx.permissionPresets.current(f.create("empty-owner-update")),
      "danger-full-access",
    );
    f.adapter.revert();
    assert.equal(f.fiber.config.defaultPreset, original);
    assert.equal(
      f.ctx.permissionPresets.current(f.create("reverted-owner-update")),
      "danger-full-access",
    );
    f.settings.permissionDefault = "workspace-write";
    f.adapter.apply();
    await f.fiber.dispose();
    const next = await f.mountPresets("danger-full-access");
    const nextRef = next.config.defaultPreset;
    assert.equal(f.adapter.status().available, false);
    assert.throws(
      () => f.adapter.apply(),
      (error) => error.code === "CONFLICT",
    );
    assert.equal(
      f.ctx.permissionPresets.current(f.create("new-owner-before-rebase")),
      "danger-full-access",
    );
    f.adapter.revert();
    assert.equal(next.config.defaultPreset, nextRef);
    f.adapter.apply();
    assert.equal(
      f.ctx.permissionPresets.current(f.create("new-owner-explicit-reapply")),
      "workspace-write",
    );
    const external = f.api.cosmokit.createVolatile("danger-full-access");
    next.config.defaultPreset = external;
    assert.equal(f.adapter.status().available, false);
    assert.throws(
      () => f.adapter.revert(),
      (error) => error.code === "CONFLICT",
    );
    assert.equal(next.config.defaultPreset, external);
    assert.equal(
      f.ctx.permissionPresets.current(f.create("external-owner-preserved")),
      "danger-full-access",
    );
    await f.verify();
  },
);
