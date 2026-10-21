import test from "node:test";
import assert from "node:assert/strict";
import { DesktopRuntime } from "../src/host/runtime.js";

function fixture(t) {
  const owners = [],
    killed = [];
  const settings = { enabled: true, fullAccess: true, autoApprove: false };
  const ctx = {
    agents: { list: () => owners },
    sandboxPolicy: {
      resolve: ({ session }) => ({ mode: session.mode ?? "read-only" }),
      overrideOf: (session) => session.mode,
    },
    systemPrompt: { assemble: async () => ({ sections: [] }) },
    approval: { decide: async () => "rejected" },
  };
  class Backend {
    constructor() {
      this.ctx = ctx;
    }
    async spawn(spec) {
      const policy = ctx.sandboxPolicy.resolve({ session: spec.owner.session });
      await spec.owner.gate;
      if (spec.owner.spawnError) throw spec.owner.spawnError;
      return { mode: policy.mode };
    }
  }
  class Registry {
    constructor() {
      this.ctx = ctx;
      this.rows = new Map();
      this.next = 0;
    }
    async spawn(owner) {
      const id = `pty-${++this.next}`;
      const session = await new Backend().spawn({ owner, sessionId: id });
      this.rows.set(id, { owner, session });
      return { sessionId: id };
    }
    list(owner) {
      return [...this.rows]
        .filter(([, row]) => row.owner === owner)
        .map(([sessionId]) => ({ sessionId, status: { kind: "running" } }));
    }
    hasOwnerActivity(owner) {
      return this.list(owner).length > 0;
    }
    async kill(owner, id) {
      assert.equal(this.rows.get(id).owner, owner);
      await owner.closeGate;
      if (owner.closeError) throw owner.closeError;
      killed.push([owner, id]);
      this.rows.delete(id);
    }
  }
  const registry = new Registry();
  ctx.agentPresets = { serviceFor: () => registry };
  const runtime = new DesktopRuntime(
    ctx,
    { dispatch: () => ({ value: settings }) },
    { supported: true },
  );
  runtime.terminalOwnership.apply = () =>
    runtime.terminalOwnership.attach(Registry.prototype, Backend.prototype);
  const owner = (mode) => {
    const value = { id: `agent-${owners.length}`, session: { mode } };
    owners.push(value);
    return value;
  };
  t.after(async () => {
    for (const owner of owners) {
      owner.closeError = null;
      owner.closeGate = undefined;
    }
    try {
      await runtime.revert();
    } catch {
      /* Failure tests explicitly assert retained failures. */
    }
  });
  return { runtime, ctx, registry, owner, killed, Registry, Backend, settings };
}

test("revert closes exactly plugin-elevated creations, preserving old and explicitly authorized terminals", async (t) => {
  const f = fixture(t);
  const old = f.owner("danger-full-access");
  await f.registry.spawn(old);
  f.runtime.apply();
  const elevated = f.owner(),
    explicit = f.owner("danger-full-access"),
    restricted = f.owner("read-only");
  const own = await f.registry.spawn(elevated);
  await f.registry.spawn(explicit);
  await f.registry.spawn(restricted);
  assert.equal(
    f.runtime.terminalStatus().terminals.find((row) => row.agentId === elevated.id)
      .elevatedByPlugin,
    true,
  );
  await f.runtime.revert();
  assert.deepEqual(f.killed, [[elevated, own.sessionId]]);
  for (const owner of [old, explicit, restricted]) assert.equal(f.registry.list(owner).length, 1);
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: elevated.session }).mode, "read-only");
});

test("revert waits for a previously elevated spawn to publish and for actual close, excluding interleaved explicit spawn", async (t) => {
  const f = fixture(t);
  f.runtime.apply();
  const elevated = f.owner(),
    explicit = f.owner("danger-full-access");
  const launch = Promise.withResolvers(),
    close = Promise.withResolvers();
  elevated.gate = launch.promise;
  elevated.closeGate = close.promise;
  const spawning = f.registry.spawn(elevated);
  await f.registry.spawn(explicit);
  let done = false;
  const reverting = f.runtime.revert().then(() => {
    done = true;
  });
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: elevated.session }).mode, "read-only");
  assert.throws(() => f.runtime.apply(), /等待还原/);
  await Promise.resolve();
  assert.equal(done, false);
  launch.resolve();
  await spawning;
  await Promise.resolve();
  assert.equal(done, false);
  close.resolve();
  await reverting;
  assert.deepEqual(
    f.killed.map(([owner]) => owner),
    [elevated],
  );
  assert.equal(f.registry.list(explicit).length, 1);
});

test("close failure is reported, stays attributed, and an explicit revert retry closes it", async (t) => {
  const f = fixture(t);
  f.runtime.apply();
  const owner = f.owner();
  await f.registry.spawn(owner);
  owner.closeError = new Error("synthetic close failure");
  await assert.rejects(f.runtime.revert(), /撤销未完成/);
  assert.equal(f.runtime.terminalStatus().terminals[0].elevatedByPlugin, true);
  assert.throws(() => f.runtime.apply(), /仍在使用中/);
  owner.closeError = null;
  await f.runtime.revert();
  assert.equal(f.registry.list(owner).length, 0);
});

test("natural exit and concurrent revert are idempotent; stale wrappers cannot acquire new ownership", async (t) => {
  const f = fixture(t);
  f.runtime.apply();
  const stale = f.Registry.prototype.spawn;
  const owner = f.owner();
  const snapshot = await f.registry.spawn(owner);
  await f.registry.kill(owner, snapshot.sessionId);
  await Promise.all([f.runtime.revert(), f.runtime.revert()]);
  f.runtime.apply();
  const next = await stale.call(f.registry, f.owner());
  assert.equal(f.registry.rows.get(next.sessionId).session.mode, "read-only");
  await f.runtime.revert();
  assert.equal(f.killed.length, 1);
  assert.equal(f.registry.rows.has(next.sessionId), true);
});

test("another owner of the spawn interface is preserved while tracked terminals are still closed", async (t) => {
  const f = fixture(t);
  f.runtime.apply();
  const owner = f.owner();
  await f.registry.spawn(owner);
  const wrapped = f.Registry.prototype.spawn;
  const external = function (...args) {
    return wrapped.apply(this, args);
  };
  f.Registry.prototype.spawn = external;
  await assert.rejects(f.runtime.revert(), /撤销未完成/);
  assert.equal(f.Registry.prototype.spawn, external);
  assert.equal(f.registry.list(owner).length, 0);
});

test("unpublished elevated startup cleanup failures remain visible even after spawn already rejected", async (t) => {
  const f = fixture(t);
  f.runtime.apply();
  const owner = f.owner();
  owner.spawnError = new AggregateError([new Error("startup"), new Error("cleanup")]);
  await assert.rejects(f.registry.spawn(owner), AggregateError);
  assert.throws(() => f.runtime.revert(), AggregateError);
  assert.throws(() => f.runtime.revert(), AggregateError);
});
