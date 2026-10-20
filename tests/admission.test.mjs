import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DrillAdmission } from "../src/core/admission.js";
import { WorkspaceStore } from "../src/core/store.js";
import { Controller } from "../src/server/controller.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-unlimit-admission-"));
  const filename = join(root, "synthetic.sqlite");
  const store = new WorkspaceStore(filename);
  let now = 1792500000000;
  const clock = () => now;
  const admission = new DrillAdmission(store, root, { clock });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, filename, store, admission, clock, advance: (ms) => (now += ms) };
}
const checks = { scope: true, permissions: true, evidence: true };
function accept(f) {
  const { challengeId } = f.admission.dispatch("admission.begin");
  f.admission.dispatch("admission.read", { challengeId });
  f.advance(5000);
  return f.admission.dispatch("admission.confirm", { challengeId, checks });
}

test("entry requires elapsed server time, read acknowledgement and all explicit checks", (t) => {
  const f = fixture(t);
  const { challengeId } = f.admission.dispatch("admission.begin");
  const confirm = (value = checks) =>
    f.admission.dispatch("admission.confirm", { challengeId, checks: value });
  assert.throws(confirm, { code: "WAIT_REQUIRED" });
  f.advance(4999);
  assert.throws(confirm, { code: "WAIT_REQUIRED" });
  f.advance(1);
  assert.throws(confirm, { code: "READ_REQUIRED" });
  f.admission.dispatch("admission.read", { challengeId });
  for (const id of Object.keys(checks))
    assert.throws(() => confirm({ ...checks, [id]: false }), {
      code: "ACKNOWLEDGEMENT_REQUIRED",
    });
  assert.throws(() => confirm({ ...checks, evidence: "true" }), {
    code: "ACKNOWLEDGEMENT_REQUIRED",
  });
  assert.throws(() => confirm({ ...checks, targetPermission: true }), { code: "INVALID_INPUT" });
  const result = confirm();
  assert.equal(result.accepted, true);
  assert.equal(result.grantsTargetAuthorization, false);
  assert.equal(result.blocksOrdinaryChat, false);
  assert.doesNotThrow(() => f.admission.require());
  assert.throws(confirm, { code: "CONFIRMATION_EXPIRED" });
});

test("consent persists for the data installation, not the package path or a copied installation", (t) => {
  const f = fixture(t);
  const original = accept(f);
  const reopened = new DrillAdmission(f.store, f.root, { clock: f.clock });
  assert.deepEqual(reopened.status(), original);
  const secondRoot = join(f.root, "second-installation");
  mkdirSync(secondRoot);
  const copy = join(secondRoot, "synthetic.sqlite");
  copyFileSync(f.filename, copy);
  const secondStore = new WorkspaceStore(copy);
  try {
    const second = new DrillAdmission(secondStore, secondRoot, { clock: f.clock });
    assert.equal(second.status().accepted, false);
    assert.notEqual(second.status().installationId, original.installationId);
    assert.equal(reopened.status().accepted, true);
  } finally {
    secondStore.close();
  }
});

test("revocation invalidates concurrent confirmations and cannot be undone by an expired challenge", (t) => {
  const f = fixture(t);
  accept(f);
  const { challengeId } = f.admission.begin({});
  const current = f.admission.status();
  assert.throws(() => f.admission.revoke({ revision: current.revision - 1 }), {
    code: "CONFLICT",
  });
  assert.equal(f.admission.revoke({ revision: current.revision }).accepted, false);
  assert.throws(() => f.admission.confirm({ challengeId, checks }), {
    code: "CONFIRMATION_EXPIRED",
  });
  assert.throws(() => f.admission.require(), { code: "ADMISSION_REQUIRED" });
  const later = f.admission.begin({});
  f.advance(15 * 60 * 1000);
  assert.throws(() => f.admission.confirm({ challengeId: later.challengeId, checks }), {
    code: "CONFIRMATION_EXPIRED",
  });
});

test("controller enforces admission before project access and execution, while settings and stops remain usable", async (t) => {
  const f = fixture(t);
  const calls = [];
  const controller = new Controller({
    host: { supported: true },
    store: f.store,
    admission: f.admission,
    workflow: {
      controlsSession: () => false,
      dispatch: (action) => calls.push(action),
      stopAll: async () => calls.push("stopAll"),
    },
  });
  for (const action of ["workspaces.list", "workspaces.save", "assets.list", "workflow.dispatch"])
    await assert.rejects(controller.dispatch(action, {}), { code: "ADMISSION_REQUIRED" });
  assert.equal(calls.length, 0);
  assert.equal((await controller.dispatch("settings.get")).value.enabled, false);
  await controller.dispatch("workflow.stop", { workspaceId: "synthetic", id: "synthetic" });
  assert.deepEqual(calls, ["workflow.stop"]);
  accept(f);
  assert.equal(
    (await controller.dispatch("workspaces.save", { name: "Synthetic" })).item.name,
    "Synthetic",
  );
  await controller.dispatch("admission.revoke", { revision: f.admission.status().revision });
  assert.equal(f.admission.status().accepted, false);
  assert.equal(calls.at(-1), "stopAll");
  await assert.rejects(controller.dispatch("workflow.dispatch"), { code: "ADMISSION_REQUIRED" });
});

test("revocation is recorded even when stopping an owned executor fails", async (t) => {
  const f = fixture(t);
  accept(f);
  const controller = new Controller({
    admission: f.admission,
    workflow: {
      stopAll: async () => {
        throw new Error("Synthetic executor has not stopped");
      },
    },
  });
  await assert.rejects(
    controller.dispatch("admission.revoke", { revision: f.admission.status().revision }),
    (error) => error.code === "ADMISSION_REVOKED_PARTIAL" && error.partial.accepted === false,
  );
  assert.equal(f.admission.status().accepted, false);
  controller.workflow.stopAll = async () => {};
  controller.plans = { stopAll: async () => ({ stopped: false }) };
  await assert.rejects(
    controller.dispatch("admission.revoke", { revision: f.admission.status().revision }),
    { code: "ADMISSION_REVOKED_PARTIAL" },
  );
  controller.plans.stopAll = async () => ({ stopped: true });
  assert.equal(
    (await controller.dispatch("admission.revoke", { revision: f.admission.status().revision }))
      .accepted,
    false,
  );
});
