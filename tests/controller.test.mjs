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

test("owned active workflow sessions cannot bypass their execution slots via generic actions", async () => {
  const calls = [];
  const controller = new Controller({
    host: { supported: true },
    workflow: { controlsSession: (sessionId) => sessionId === "owned-executor" },
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
    await assert.rejects(controller.dispatch(action, { sessionId: "owned-executor" }), {
      code: "CONFLICT",
    });
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
  ]) {
    await assert.rejects(controller.dispatch(action, { operation: "register" }), {
      code: "UNSUPPORTED",
    });
  }
  assert.equal((await controller.dispatch("workflow.plan.capabilities")).available, false);
  assert.equal(calls, 0);
});
