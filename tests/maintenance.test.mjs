import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { WorkspaceStore } from "../src/core/store.js";
import { DrillAdmission } from "../src/core/admission.js";
import { DesktopMaintenance } from "../src/host/maintenance.js";
import { Controller } from "../src/server/controller.js";
import { createHandler } from "../src/server/http.js";

const host = { kind: "desktop", version: "0.2.1-rc.2", supported: true };
const payload = { bundle: "dsh-unlimit", confirmed: true };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture() {
  const bundle = {
    name: "dsh-unlimit",
    installed: true,
    availability: "profile",
    removable: true,
    source: "file:synthetic-bundle.tgz",
    rows: [{ entryId: "own-entry", rowId: "dsh-unlimit", moduleName: "dsh-unlimit" }],
  };
  const calls = [];
  const manager = {
    ownerContext: {},
    async listBundles() {
      calls.push("list");
      return [bundle];
    },
    async removeBundle(name) {
      assert.equal(name, "dsh-unlimit");
      calls.push("remove");
      bundle.installed = false;
      return { changed: true, application: "applied" };
    },
  };
  // Model Cordis' contextual proxies: object identity changes on each get.
  const ctx = {
    fiber: { entry: { id: "own-entry" } },
    get: () => new Proxy(manager, {}),
  };
  const maintenance = new DesktopMaintenance(ctx, { ...host });
  return { bundle, calls, manager, ctx, maintenance };
}

function controllerFixture(t) {
  const f = fixture();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-maintenance-unit-")));
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  store.setMeta("synthetic-preserved", { content: "original synthetic data" });
  const initial = store.dispatch("settings.get");
  store.dispatch("settings.save", {
    revision: initial.revision,
    value: { ...initial.value, enabled: true, prompt: "Synthetic custom prompt" },
  });
  const admission = new DrillAdmission(store, root, { clock: () => 0 });
  const { challengeId } = admission.begin({});
  admission.dispatch("admission.read", { challengeId });
  admission.clock = () => 5000;
  admission.confirm({ challengeId, checks: { scope: true, permissions: true, evidence: true } });
  const runtime = {
    enabled: true,
    capabilities: () => ["prompt", "approval", "sandbox"].map((id) => ({ id, state: "available" })),
    apply() {
      this.enabled = true;
    },
    revert() {
      f.calls.push("controls");
      this.enabled = false;
    },
  };
  const plans = {
    capabilities: () => ({ available: true }),
    stopAll() {
      f.calls.push("plans");
      return { stopped: true };
    },
  };
  const workflow = {
    capabilities: () => ({}),
    stopAll() {
      f.calls.push("workflow");
      return { stopped: true };
    },
    presets(value) {
      assert.equal(value.operation, "unregister");
      f.calls.push("presets");
    },
  };
  const toolkit = {
    cancelProbes() {
      f.calls.push("probes");
      return { stopped: true };
    },
  };
  const controller = new Controller({
    store,
    runtime,
    admission,
    plans,
    workflow,
    toolkit,
    host,
    maintenance: f.maintenance,
  });
  return { ...f, store, admission, runtime, plans, workflow, toolkit, controller };
}

test("uninstall requires explicit own-bundle confirmation and a matching profile-owned instance", async () => {
  for (const invalid of [
    {},
    { ...payload, confirmed: false },
    { ...payload, bundle: "other" },
    { ...payload, force: true },
  ]) {
    const f = fixture();
    await assert.rejects(
      f.maintenance.uninstall(invalid, () => assert.fail("no cleanup")),
      { code: "INVALID_INPUT" },
    );
    assert.deepEqual(f.calls, []);
  }
  const changes = [
    (f) => {
      f.maintenance.host.version = "unknown";
    },
    (f) => {
      f.bundle.installed = false;
    },
    (f) => {
      f.bundle.availability = "installation";
    },
    (f) => {
      f.bundle.removable = false;
    },
    (f) => {
      delete f.bundle.source;
    },
    (f) => {
      f.bundle.readOnlyReason = "synthetic read-only";
    },
    (f) => {
      f.bundle.error = "synthetic metadata error";
    },
    (f) => {
      f.bundle.rows[0].entryId = "other-entry";
    },
    (f) => {
      f.bundle.rows[0].rowId = "other";
    },
    (f) => {
      f.bundle.rows[0].moduleName = "other";
    },
    (f) => {
      f.manager.listBundles = async () => [f.bundle, f.bundle];
    },
    (f) => {
      delete f.manager.ownerContext;
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    assert.equal((await f.maintenance.info()).available, false);
    await assert.rejects(
      f.maintenance.uninstall(payload, () => assert.fail("no cleanup")),
      { code: "UNSUPPORTED" },
    );
    assert.ok(!f.calls.includes("remove"));
  }
});

test("an unavailable optional manager leaves diagnostics readable and never starts cleanup", async () => {
  const f = fixture();
  f.manager.listBundles = async () => {
    throw new Error("synthetic metadata failure");
  };
  const controller = new Controller({ maintenance: f.maintenance });
  const status = await controller.dispatch("maintenance.info");
  assert.equal(status.uninstall.available, false);
  assert.match(status.uninstall.detail, /查询失败/);
  await assert.rejects(
    f.maintenance.uninstall(payload, () => assert.fail("no cleanup")),
    /metadata failure/,
  );
  assert.ok(!f.calls.includes("remove"));
});

test("parallel removal waits for preparation once, reads back the captured manager, and keeps a terminal receipt", async () => {
  const f = fixture();
  const gate = Promise.withResolvers();
  const prepared = { controlsDisabled: true, admissionRevoked: true, data: "preserved" };
  let prepares = 0;
  const prepare = async () => {
    prepares++;
    await gate.promise;
    return prepared;
  };
  const first = f.maintenance.uninstall(payload, prepare);
  const second = f.maintenance.uninstall(payload, prepare);
  await tick();
  assert.equal(f.maintenance.busy, true);
  assert.equal(prepares, 1);
  assert.ok(!f.calls.includes("remove"));
  const original = f.manager.removeBundle;
  f.manager.removeBundle = async (name) => {
    const result = await original(name);
    f.ctx.get = () => assert.fail("disposed context must not be read");
    return result;
  };
  gate.resolve();
  const receipt = await first;
  assert.deepEqual(await second, receipt);
  assert.equal(receipt.removed, true);
  assert.equal(receipt.installationPresent, false);
  assert.equal(receipt.prepared, prepared);
  assert.equal(receipt.automaticRestart, false);
  assert.deepEqual(f.calls, ["list", "list", "remove", "list"]);
  assert.deepEqual(await f.maintenance.uninstall(payload, () => assert.fail("no repeat")), receipt);
  assert.equal((await f.maintenance.info()).available, false);
});

test("ownership changes during cleanup are reported without removing a replacement manager", async () => {
  const f = fixture();
  const prepared = { controlsDisabled: true, admissionRevoked: true };
  await assert.rejects(
    f.maintenance.uninstall(payload, async () => {
      f.ctx.get = () => ({ ...f.manager, ownerContext: {} });
      return prepared;
    }),
    (error) => {
      assert.equal(error.code, "UNINSTALL_STATE_CHANGED");
      assert.deepEqual(error.partial, { prepared, removed: false, managerCalled: false });
      return true;
    },
  );
  assert.ok(!f.calls.includes("remove"));
});

test("official application status and installed readback must agree; restart is only a returned requirement", async () => {
  for (const application of ["applied", "restart-required", "failed", "overridden", "cancelled"]) {
    for (const installed of [true, false]) {
      const f = fixture();
      f.manager.removeBundle = async () => {
        f.bundle.installed = installed;
        return { changed: true, application };
      };
      const operation = f.maintenance.uninstall(payload, async () => ({ data: "preserved" }));
      if (!installed && ["applied", "restart-required"].includes(application)) {
        const result = await operation;
        assert.equal(result.removed, true);
        assert.equal(result.restartRequired, application === "restart-required");
        assert.equal(result.automaticRestart, false);
      } else {
        await assert.rejects(operation, (error) => {
          assert.equal(error.code, "UNINSTALL_INCOMPLETE");
          assert.equal(error.partial.installationPresent, installed);
          assert.equal(error.partial.application, application);
          assert.equal(error.partial.removed, false);
          return true;
        });
      }
    }
  }
});

test("unknown official outcomes preserve cleanup facts without asserting package removal or retrying", async () => {
  for (const failure of ["throw", "format", "readback"]) {
    const f = fixture();
    let removes = 0;
    f.manager.removeBundle = async () => {
      removes++;
      if (failure === "throw") throw new Error("synthetic transport failure");
      if (failure === "format") return {};
      f.manager.listBundles = async () => {
        throw new Error("synthetic readback failure");
      };
      return { changed: true, application: "applied" };
    };
    const prepared = { controlsDisabled: true, admissionRevoked: true };
    await assert.rejects(
      f.maintenance.uninstall(payload, async () => prepared),
      (error) => {
        assert.equal(error.code, "UNINSTALL_UNKNOWN");
        assert.deepEqual(error.partial, { prepared, managerCalled: true });
        assert.equal(error.partial.removed, undefined);
        return true;
      },
    );
    assert.equal(removes, 1);
  }
});

test("controller persists disarm and admission revocation before cleanup and removal without erasing user data", async (t) => {
  const f = controllerFixture(t);
  const before = f.store.dispatch("settings.get");
  const original = f.manager.removeBundle;
  f.manager.removeBundle = async (name) => {
    assert.equal(f.store.dispatch("settings.get").value.enabled, false);
    assert.equal(f.admission.status().accepted, false);
    assert.equal(f.runtime.enabled, false);
    assert.deepEqual(
      f.calls.filter((item) => item !== "list"),
      ["plans", "workflow", "presets", "controls", "probes"],
    );
    return original(name);
  };
  const result = await f.controller.dispatch("maintenance.uninstall", payload);
  assert.equal(result.removed, true);
  assert.deepEqual(result.prepared.promptHistory, { status: "not-restored", scanned: false });
  assert.equal(result.prepared.controlsDisabled, true);
  assert.equal(result.prepared.admissionRevoked, true);
  assert.deepEqual(
    result.prepared.steps.map((item) => item.id),
    ["settings", "admission", "plans", "workflow", "presets", "controls", "probes"],
  );
  assert.ok(result.prepared.steps.every((item) => item.status === "completed"));
  const after = f.store.dispatch("settings.get");
  assert.deepEqual(after.value, { ...before.value, enabled: false });
  assert.deepEqual(f.store.meta("synthetic-preserved"), { content: "original synthetic data" });
  await assert.rejects(f.controller.dispatch("control.apply"), { code: "MAINTENANCE_BUSY" });
});

test("controller drains an accepted asynchronous apply, blocks new actions, then persists final disabled state", async (t) => {
  const f = controllerFixture(t);
  const gate = Promise.withResolvers();
  f.controller.repeat = {
    capabilities: () => [],
    apply: () => gate.promise,
    revert: () => {},
  };
  const applying = f.controller.dispatch("control.apply");
  const uninstalling = f.controller.dispatch("maintenance.uninstall", payload);
  await tick();
  assert.ok(!f.calls.includes("plans"));
  assert.ok(!f.calls.includes("remove"));
  await assert.rejects(f.controller.dispatch("settings.save", {}), { code: "MAINTENANCE_BUSY" });
  gate.resolve();
  assert.equal((await applying).enabled, true);
  assert.equal((await uninstalling).removed, true);
  assert.equal(f.store.dispatch("settings.get").value.enabled, false);
  assert.equal(f.runtime.enabled, false);
});

test("preparation failure continues independent cleanup, skips removal and can be explicitly retried", async (t) => {
  const f = controllerFixture(t);
  f.plans.stopAll = () => {
    f.calls.push("plans-failed");
    return { stopped: false };
  };
  await assert.rejects(f.controller.dispatch("maintenance.uninstall", payload), (error) => {
    assert.equal(error.code, "UNINSTALL_PREPARATION_FAILED");
    assert.equal(error.partial.managerCalled, false);
    assert.equal(error.partial.removed, false);
    assert.deepEqual(error.partial.prepared.promptHistory, {
      status: "not-restored",
      scanned: false,
    });
    assert.equal(error.partial.prepared.controlsDisabled, true);
    assert.equal(error.partial.prepared.admissionRevoked, true);
    assert.deepEqual(
      error.partial.prepared.steps.filter((step) => step.status === "failed"),
      [{ id: "plans", status: "failed" }],
    );
    return true;
  });
  assert.ok(f.calls.includes("probes"));
  assert.ok(!f.calls.includes("remove"));
  assert.equal(f.maintenance.busy, false);
  f.plans.stopAll = () => ({ stopped: true });
  assert.equal((await f.controller.dispatch("maintenance.uninstall", payload)).removed, true);
});

test("HTTP forwards known uninstall partial facts without needing a live profile or socket", async () => {
  for (const code of [
    "UNINSTALL_PREPARATION_FAILED",
    "UNINSTALL_STATE_CHANGED",
    "UNINSTALL_INCOMPLETE",
    "UNINSTALL_UNKNOWN",
  ]) {
    const partial = {
      prepared: { controlsDisabled: true },
      managerCalled: code !== "UNINSTALL_PREPARATION_FAILED",
    };
    const handler = createHandler(
      {
        dispatch() {
          throw Object.assign(new Error("Synthetic failure"), { code, partial });
        },
      },
      () => "http://127.0.0.1:4177",
    );
    const request = Readable.from([
      Buffer.from(JSON.stringify({ action: "maintenance.uninstall", payload })),
    ]);
    Object.assign(request, {
      method: "POST",
      url: "/dsh-unlimit/api",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:4177", "content-type": "application/json", "x-dsh-unlimit": "1" },
    });
    let body;
    await handler(request, {
      writeHead() {},
      end(value) {
        body = JSON.parse(value);
      },
    });
    assert.equal(body.ok, false);
    assert.equal(body.error.code, code);
    assert.deepEqual(body.error.partial, partial);
  }
});
