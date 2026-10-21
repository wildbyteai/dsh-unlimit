import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/server/controller.js";
import { settings } from "../src/core/validation.js";

function controlFixture() {
  let saved = { revision: 0, value: settings({}) };
  const calls = [];
  const store = {
    dispatch(action, payload) {
      if (action === "settings.get") return structuredClone(saved);
      assert.equal(action, "settings.save");
      assert.equal(payload.revision, saved.revision);
      const value = settings(payload.value);
      saved = { revision: saved.revision + 1, value };
      calls.push(`saved:${value.enabled}`);
      return structuredClone(saved);
    },
  };
  const runtime = {
    enabled: false,
    capabilities: () => ["prompt", "approval", "sandbox"].map((id) => ({ id, state: "available" })),
    apply() {
      calls.push("runtime.apply");
      this.enabled = true;
    },
    revert() {
      calls.push("runtime.revert");
      this.enabled = false;
    },
    permissionDefaults: {
      status: () => ({ requested: saved.value.permissionDefault }),
      validate(name) {
        if (!["", "workspace-write", "danger-full-access"].includes(name))
          throw Object.assign(new Error("Unknown official preset"), {
            code: "INVALID_PERMISSION_DEFAULT",
          });
      },
      changed() {
        calls.push("permission.changed");
      },
    },
  };
  const repeat = {
    capabilities: () => [{ id: "repeatReminder", state: "available" }],
    async apply() {
      calls.push(`repeat.apply:${saved.value.enabled}`);
    },
    async changed() {
      calls.push("repeat.changed");
    },
    async revert() {
      calls.push("repeat.revert");
    },
  };
  const controller = new Controller({ store, runtime, repeat, host: { supported: true } });
  const save = (value) =>
    controller.dispatch("settings.save", {
      revision: saved.revision,
      value: { ...saved.value, ...value },
    });
  return { controller, store, runtime, repeat, calls, save };
}

test("unsupported Hook enablement is rejected before persistence, with an actionable reason", async () => {
  const f = controlFixture();
  f.controller.extensions = {
    capabilities: () => [
      { id: "hooks", state: "unsupported", detail: "No verified Hook provider" },
    ],
  };
  await assert.rejects(f.save({ hooksDeny: true }), {
    code: "UNSUPPORTED",
    message: "No verified Hook provider",
  });
  assert.equal(f.store.dispatch("settings.get").revision, 0);
  assert.deepEqual(f.calls, []);
  f.controller.extensions = undefined;
  await assert.rejects(f.save({ hooksDeny: true }), { code: "UNSUPPORTED" });
  assert.equal(f.store.dispatch("settings.get").revision, 0);
});

test("legacy unsupported Hook value remains inert and does not block editing other settings or clearing it", async () => {
  const f = controlFixture();
  const initial = f.store.dispatch("settings.get");
  f.store.dispatch("settings.save", {
    revision: initial.revision,
    value: { ...initial.value, hooksDeny: true },
  });
  const edited = await f.save({ prompt: "Synthetic new prompt" });
  assert.equal(edited.value.hooksDeny, true);
  assert.equal(edited.value.prompt, "Synthetic new prompt");
  assert.equal((await f.save({ hooksDeny: false })).value.hooksDeny, false);
});

test("revoking admission stops owned processes and reports unconfirmed cleanup", async () => {
  const f = controlFixture();
  let stops = 0;
  let stopped = true;
  f.controller.admission = { dispatch: () => ({ accepted: false, revision: 2 }) };
  f.controller.processes = {
    async stopAll() {
      stops++;
      return { stopped };
    },
  };
  assert.equal((await f.controller.dispatch("admission.revoke", {})).accepted, false);
  stopped = false;
  await assert.rejects(f.controller.dispatch("admission.revoke", {}), {
    code: "ADMISSION_REVOKED_PARTIAL",
  });
  assert.equal(stops, 2);
});

test("uninstall aborts preparing processes before draining accepted tool actions", async () => {
  const f = controlFixture();
  const pending = Promise.withResolvers();
  f.controller.processes = {
    dispatch: () => pending.promise,
    async stopAll() {
      f.calls.push("process.stopAll");
      pending.reject(new Error("synthetic process preparation aborted"));
      return { stopped: true };
    },
  };
  const start = f.controller.dispatch("processes.start", {}, { agent: {} });
  const rejected = assert.rejects(start, /preparation aborted/);
  const receipt = await f.controller.prepareUninstall();
  await rejected;
  assert.equal(receipt.steps.find(({ id }) => id === "processes").status, "completed");
  assert.equal(f.calls[0], "process.stopAll");
});

test("uninstall retracts pending manual resumes before waiting for accepted actions", async () => {
  const f = controlFixture();
  const pending = Promise.withResolvers();
  f.controller.continuation = {
    continue: () => pending.promise,
    revert() {},
    async stopAll(options) {
      assert.deepEqual(options, { revoke: true });
      pending.reject(new Error("synthetic continuation preparation aborted"));
    },
  };
  const rejected = assert.rejects(
    f.controller.dispatch("continuation.continue", { sessionId: "child" }),
    /preparation aborted/,
  );
  const receipt = await f.controller.prepareUninstall();
  await rejected;
  assert.equal(receipt.steps.find(({ id }) => id === "continuation").status, "completed");
});

test("admission revoke stops only project manual continuations and reports unconfirmed cleanup", async () => {
  const f = controlFixture();
  const seen = [];
  f.controller.admission = { dispatch: () => ({ accepted: false, revision: 2 }) };
  f.controller.continuation = {
    async stopAll(options) {
      seen.push(options);
      throw new Error("synthetic owned drain failure");
    },
  };
  await assert.rejects(f.controller.dispatch("admission.revoke"), {
    code: "ADMISSION_REVOKED_PARTIAL",
  });
  assert.deepEqual(seen, [{ projectsOnly: true, revoke: true }]);
});

test("concurrent applies finish in acceptance order without stale revision rollback", async () => {
  const f = controlFixture();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const completed = [];
  let applications = 0;
  f.repeat.apply = async () => {
    const application = ++applications;
    f.calls.push(`repeat.start:${application}`);
    if (application === 1) {
      entered.resolve();
    }
    await gate.promise;
    f.calls.push(`repeat.done:${application}`);
  };
  const first = f.controller.dispatch("control.apply").then((result) => {
    completed.push("first");
    return result;
  });
  await entered.promise;
  const second = f.controller.dispatch("control.apply").then((result) => {
    completed.push("second");
    return result;
  });
  gate.resolve();
  const results = await Promise.allSettled([first, second]);
  const saved = f.store.dispatch("settings.get");
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
  assert.deepEqual(completed, ["first", "second"]);
  assert.equal(saved.value.enabled, true);
  assert.equal(f.runtime.enabled, true);
  assert.equal(f.calls.includes("runtime.revert"), false);
});

test("revert accepted during apply waits for activation and leaves no late mount", async () => {
  const f = controlFixture();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const completed = [];
  let mounted = false;
  f.repeat.apply = async () => {
    f.calls.push("repeat.start");
    entered.resolve();
    await gate.promise;
    mounted = true;
    f.calls.push("repeat.mounted");
  };
  f.repeat.revert = async () => {
    mounted = false;
    f.calls.push("repeat.revert");
  };
  const applying = f.controller.dispatch("control.apply").then((result) => {
    completed.push("apply");
    return result;
  });
  await entered.promise;
  const reverting = f.controller.dispatch("control.revert").then((result) => {
    completed.push("revert");
    return result;
  });
  gate.resolve();
  const results = await Promise.allSettled([applying, reverting]);
  const saved = f.store.dispatch("settings.get");
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled"],
  );
  assert.deepEqual(completed, ["apply", "revert"]);
  assert.equal(saved.value.enabled, false);
  assert.equal(f.runtime.enabled, false);
  assert.equal(mounted, false);
  assert.equal(f.calls.filter((call) => call === "repeat.mounted").length, 1);
  assert.equal(f.calls.filter((call) => call === "repeat.revert").length, 1);
  assert.ok(f.calls.indexOf("repeat.mounted") < f.calls.indexOf("repeat.revert"));
});

test("a failed apply releases the next accepted apply and preserves its enabled state", async () => {
  const f = controlFixture();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let applications = 0;
  f.repeat.apply = async () => {
    const application = ++applications;
    f.calls.push(`repeat.start:${application}`);
    if (application === 1) entered.resolve();
    await gate.promise;
    if (application === 1) throw new Error("Synthetic first application veto");
    f.calls.push(`repeat.done:${application}`);
  };
  const first = f.controller.dispatch("control.apply");
  await entered.promise;
  const second = f.controller.dispatch("control.apply");
  gate.resolve();
  const results = await Promise.allSettled([first, second]);
  const saved = f.store.dispatch("settings.get");
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "fulfilled"],
  );
  assert.match(results[0].reason.message, /first application veto/);
  assert.equal(saved.value.enabled, true);
  assert.equal(f.runtime.enabled, true);
  assert.ok(f.calls.indexOf("runtime.revert") < f.calls.lastIndexOf("runtime.apply"));
});

test("lifecycle cleanup waits for accepted activation while preserving reload intent", async () => {
  const f = controlFixture();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let mounted = false;
  f.repeat.apply = async () => {
    entered.resolve();
    await gate.promise;
    mounted = true;
  };
  f.repeat.revert = async () => {
    mounted = false;
  };
  const applying = f.controller.dispatch("control.apply");
  await entered.promise;
  const cleaning = f.controller.revertControls();
  gate.resolve();
  await Promise.all([applying, cleaning]);
  assert.equal(f.runtime.enabled, false);
  assert.equal(mounted, false);
  assert.equal(f.store.dispatch("settings.get").value.enabled, true);
});

test("a queued rule policy write retains revision conflicts without rolling back activation", async () => {
  const f = controlFixture();
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  f.repeat.apply = async () => {
    entered.resolve();
    await gate.promise;
  };
  const applying = f.controller.dispatch("control.apply");
  await entered.promise;
  const changing = f.controller.dispatch("rules.policy", { revision: 0, policy: "strict" });
  gate.resolve();
  const [applied, changed] = await Promise.allSettled([applying, changing]);
  assert.equal(applied.status, "fulfilled");
  assert.equal(changed.status, "rejected");
  const saved = f.store.dispatch("settings.get");
  assert.equal(saved.revision, 1);
  assert.equal(saved.value.workspacePolicy, "fallback");
  assert.equal(saved.value.enabled, true);
  assert.equal(f.runtime.enabled, true);
  assert.equal(f.calls.includes("runtime.revert"), false);
});

test("HTTP scope activation failure rolls back controls before enabled is persisted", async () => {
  const f = controlFixture();
  const gate = Promise.withResolvers();
  f.controller.webScope = {
    capabilities: () => [{ id: "webScope", state: "available", owned: false }],
    apply: () => gate.promise,
    async revert() {
      f.calls.push("http.reverted");
    },
  };
  const applying = f.controller.dispatch("control.apply");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  gate.reject(new Error("Synthetic HTTP ownership changed"));
  await assert.rejects(applying, /ownership changed/);
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  assert.equal(f.runtime.enabled, false);
  assert.ok(f.calls.indexOf("http.reverted") < f.calls.indexOf("runtime.revert"));
  f.controller.webScope.capabilities = () => [{ id: "webScope", state: "unsupported" }];
  f.controller.webScope.apply = () => assert.fail("unsupported HTTP must stay unapplied");
  const status = await f.controller.dispatch("control.apply");
  assert.equal(status.enabled, true);
  assert.equal(status.capabilities.find((item) => item.id === "webScope").state, "unsupported");
});

test("saving a changed exception list attempts HTTP cancellation despite independent cleanup failure", async () => {
  const f = controlFixture();
  let httpStops = 0;
  f.controller.webScope = { stopAll: async () => httpStops++ };
  f.controller.networkScope = {
    changed: async () => {
      throw new Error("Synthetic snapshot cleanup failure");
    },
  };
  f.controller.connectionChecks = {
    stopAll: async () => {
      throw new Error("Synthetic check cleanup failure");
    },
  };
  await assert.rejects(f.save({ ownServers: ["owned.example.invalid"] }), (error) => {
    assert.equal(error.code, "SETTINGS_APPLIED_PARTIAL");
    assert.equal(error.partial.savedRevision, 1);
    return true;
  });
  assert.equal(httpStops, 1);
  assert.deepEqual(f.store.dispatch("settings.get").value.ownServers, ["owned.example.invalid"]);
  await f.save({ readLimit: 10 });
  assert.equal(httpStops, 1, "unrelated setting does not cancel requests");
});

test("scope replacement cancels both transports even if the operation reports a partial failure", async () => {
  const f = controlFixture();
  let revision = "before";
  const calls = [];
  f.controller.networkScope = {
    status: () => ({ revision }),
    async dispatch() {
      revision = "after";
      throw Object.assign(new Error("Synthetic operation failed after persistence"), {
        code: "PARTIAL",
      });
    },
  };
  f.controller.connectionChecks = { stopAll: async () => calls.push("checks") };
  f.controller.webScope = { stopAll: async () => calls.push("http") };
  await assert.rejects(f.controller.dispatch("networkScope.import", {}), { code: "PARTIAL" });
  assert.deepEqual(calls.sort(), ["checks", "http"]);
});

test("permission selection validates before persistence and inactive saves do not apply host controls", async () => {
  const f = controlFixture();
  await assert.rejects(f.save({ permissionDefault: "auto" }), {
    code: "INVALID_PERMISSION_DEFAULT",
  });
  await assert.rejects(f.save({ repeatReminder: "silence-all" }), { code: "INVALID_INPUT" });
  assert.equal(f.store.dispatch("settings.get").revision, 0);
  const result = await f.save({ permissionDefault: "danger-full-access", repeatReminder: "off" });
  assert.equal(result.value.enabled, false);
  assert.deepEqual(f.calls, ["saved:false"]);
  const status = await f.controller.status();
  assert.equal(status.permissionDefaults.requested, "danger-full-access");
  assert.ok(status.capabilities.some((cap) => cap.id === "repeatReminder"));
});

test("applying waits for repeat configuration before enabling and failed application rolls back all controls", async () => {
  const f = controlFixture();
  await f.save({ repeatReminder: "off" });
  f.calls.length = 0;
  const gate = Promise.withResolvers();
  f.repeat.apply = async () => {
    f.calls.push("repeat.start");
    await gate.promise;
  };
  const applying = f.controller.dispatch("control.apply");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  gate.reject(new Error("Synthetic configuration veto"));
  await assert.rejects(applying, /configuration veto/);
  assert.deepEqual(f.calls, ["runtime.apply", "repeat.start", "repeat.revert", "runtime.revert"]);
  assert.equal(f.runtime.enabled, false);
  f.calls.length = 0;
  f.repeat.apply = async () => {
    f.calls.push(`repeat.apply:${f.store.dispatch("settings.get").value.enabled}`);
  };
  const status = await f.controller.dispatch("control.apply");
  assert.equal(status.enabled, true);
  assert.deepEqual(f.calls, [
    "runtime.apply",
    "repeat.apply:false",
    "saved:true",
    "permission.changed",
  ]);
});

test("live save reports saved revision on partial update and still attempts independent controls", async () => {
  const f = controlFixture();
  await f.controller.dispatch("control.apply");
  f.calls.length = 0;
  f.runtime.permissionDefaults.changed = () => {
    throw new Error("Synthetic catalog notification failure");
  };
  f.repeat.changed = async () => {
    f.calls.push("repeat.changed");
    throw new Error("Synthetic repeat conflict");
  };
  await assert.rejects(
    f.save({ repeatReminder: "off", permissionDefault: "workspace-write" }),
    (error) => {
      assert.equal(error.code, "SETTINGS_APPLIED_PARTIAL");
      assert.equal(error.partial.savedRevision, 2);
      assert.match(error.message, /notification failure/);
      assert.match(error.message, /repeat conflict/);
      return true;
    },
  );
  assert.deepEqual(f.calls, ["saved:true", "repeat.changed"]);
  assert.equal(f.store.dispatch("settings.get").value.repeatReminder, "off");
  f.repeat.revert = async () => {
    throw new Error("Synthetic external ownership");
  };
  await assert.rejects(f.controller.dispatch("control.revert"), AggregateError);
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  assert.equal(f.runtime.enabled, false);
  assert.equal(f.calls.at(-1), "runtime.revert");
});

test("a post-enable catalog notification error discloses active controls without false rollback", async () => {
  const f = controlFixture();
  f.runtime.permissionDefaults.changed = () => {
    throw new Error("Synthetic catalog notification failure");
  };
  await assert.rejects(f.controller.dispatch("control.apply"), (error) => {
    assert.equal(error.code, "CONTROLS_APPLIED_PARTIAL");
    assert.deepEqual(error.partial, { enabled: true });
    return true;
  });
  assert.equal(f.runtime.enabled, true);
  assert.equal(f.store.dispatch("settings.get").value.enabled, true);
  assert.ok(!f.calls.includes("runtime.revert"));
});

test("read cap remount must complete before enabling, and activation failure restores all controls", async () => {
  const f = controlFixture();
  const gate = Promise.withResolvers();
  f.controller.readLimits = {
    capabilities: () => [{ id: "readLimit", state: "available", owned: false }],
    async apply() {
      f.calls.push("read.start");
      await gate.promise;
    },
    async revert() {
      f.calls.push("read.revert");
    },
  };
  const applying = f.controller.dispatch("control.apply");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  gate.reject(new Error("Synthetic read remount failure"));
  await assert.rejects(applying, /read remount failure/);
  assert.deepEqual(f.calls, [
    "runtime.apply",
    "repeat.apply:false",
    "read.start",
    "repeat.revert",
    "read.revert",
    "runtime.revert",
  ]);
  assert.equal(f.runtime.enabled, false);
});

test("unverified read caps stay unavailable without blocking core controls; owned conflicts are reported on save", async () => {
  const f = controlFixture();
  const capability = { id: "readLimit", state: "unsupported", owned: false, effectiveCaps: null };
  f.controller.readLimits = {
    capabilities: () => [capability],
    async apply() {
      assert.fail("unverified entry must not be applied");
    },
    async changed() {
      f.calls.push("read.changed");
    },
    async revert() {},
  };
  await f.controller.dispatch("control.apply");
  assert.equal(
    (await f.controller.status()).capabilities.find((cap) => cap.id === "readLimit").state,
    "unsupported",
  );
  f.calls.length = 0;
  await f.save({ readLimit: 2048 });
  assert.deepEqual(f.calls, ["saved:true", "permission.changed", "repeat.changed"]);
  capability.state = "applying";
  await f.save({ readLimit: 1024 });
  assert.equal(f.calls.at(-1), "read.changed");
  capability.state = "unsupported";
  capability.owned = true;
  f.controller.readLimits.changed = async () => {
    throw Object.assign(new Error("Synthetic read ownership conflict"), { code: "CONFLICT" });
  };
  await assert.rejects(f.save({ readLimit: 512 }), (error) => {
    assert.equal(error.code, "SETTINGS_APPLIED_PARTIAL");
    assert.equal(error.partial.savedRevision, 4);
    assert.match(error.message, /read ownership conflict/);
    return true;
  });
  const before = f.store.dispatch("settings.get");
  await assert.rejects(f.save({ readLimit: Number.MAX_SAFE_INTEGER }), { code: "INVALID_INPUT" });
  assert.deepEqual(f.store.dispatch("settings.get"), before);
});

test("unverified desktop versions cannot prepare or perform a destructive session transition", async () => {
  let calls = 0;
  const host = { supported: false };
  const sessions = {
    prepare() {
      calls++;
      return { ready: true };
    },
    rewind() {
      calls++;
      return { newSessionId: "synthetic" };
    },
    attachment() {
      calls++;
      return { item: {} };
    },
  };
  const controller = new Controller({ host, sessions });
  for (const action of ["sessions.prepare", "sessions.rewind", "sessions.attachment"]) {
    await assert.rejects(controller.dispatch(action), { code: "UNSUPPORTED" });
  }
  assert.equal(calls, 0);
  host.supported = true;
  assert.deepEqual(await controller.dispatch("sessions.prepare"), { ready: true });
  assert.equal(calls, 1);
});

test("owned active workflow and manual continuation sessions cannot bypass their execution slots via generic actions", async () => {
  const calls = [];
  const controller = new Controller({
    host: { supported: true },
    workflow: { controlsSession: (sessionId) => sessionId === "owned-executor" },
    continuation: { controlsSession: (sessionId) => sessionId === "owned-continuation" },
    store: {
      dispatch: (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
    flow: {
      dispatch: (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
  });
  for (const action of ["workspaces.bind", "flow.assign", "flow.release"]) {
    for (const sessionId of ["owned-executor", "owned-continuation"])
      await assert.rejects(controller.dispatch(action, { sessionId }), { code: "CONFLICT" });
  }
  assert.equal(calls.length, 0);
  await controller.dispatch("flow.release", { sessionId: "ordinary-session" });
  assert.equal(calls.length, 1);
});

test("unknown versions cannot start workflow or continuation mutations", async () => {
  let calls = 0;
  const controller = new Controller({
    host: { supported: false },
    workflow: {
      dispatch: () => {
        calls++;
      },
    },
    continuation: {
      continue: () => {
        calls++;
      },
      stop: () => {
        calls++;
      },
    },
    plans: {
      capabilities: () => ({ available: true }),
      dispatch: () => {
        calls++;
      },
    },
  });
  for (const action of [
    "workflow.dispatch",
    "workflow.stop",
    "workflow.presets",
    "continuation.continue",
    "continuation.stop",
    "workflow.plan.create",
    "workflow.plan.propose",
    "workflow.plan.run",
  ]) {
    await assert.rejects(controller.dispatch(action, { operation: "register" }), {
      code: "UNSUPPORTED",
    });
  }
  assert.equal((await controller.dispatch("workflow.plan.capabilities")).available, false);
  assert.equal(calls, 0);
});

test("status exposes terminal inspection independently of control activation and performs no writes", async () => {
  const f = controlFixture();
  assert.equal((await f.controller.dispatch("status")).terminalPermissions.available, false);
  const inventory = {
    available: true,
    scannedAgents: 1,
    terminals: [
      {
        agentId: "synthetic",
        terminalId: "pty-1",
        state: "running",
        startupMode: "unknown",
        elevatedByPlugin: "unknown",
      },
    ],
    pendingOwners: [],
  };
  f.runtime.terminalStatus = () => structuredClone(inventory);
  const result = await f.controller.dispatch("status");
  assert.equal(result.enabled, false);
  assert.deepEqual(result.terminalPermissions, inventory);
  assert.deepEqual(f.calls, []);
});
