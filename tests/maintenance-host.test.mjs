import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";
import { DrillAdmission } from "../src/core/admission.js";
import { fixture, hostOnly } from "./helpers/maintenance-fixture.mjs";

const payload = { bundle: "dsh-unlimit", confirmed: true };

test(
  "official manager removes only the synthetic own dependency; self-dispose retains the HTTP response",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const first = f.ctx.get("pluginManager");
    const second = f.ctx.get("pluginManager");
    assert.notEqual(first, second, "Cordis returns a fresh contextual service proxy");
    assert.equal(
      first.ownerContext,
      second.ownerContext,
      "the manager ownership context is stable",
    );
    const before = await f.manager.listBundles();
    const own = before.find((item) => item.name === "dsh-unlimit");
    assert.equal(own.installed, true);
    assert.equal(own.availability, "profile");
    assert.equal(own.removable, true);
    assert.match(own.source, /^file:/);
    assert.equal(own.rows[0].entryId, f.ownEntry.id);
    assert.equal((await f.maintenance.info()).available, true);

    const reply = await f.post();
    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json.ok, true, reply.text);
    assert.equal(reply.json.data.removed, true);
    assert.equal(reply.json.data.application, "applied");
    assert.equal(reply.json.data.prepared.admissionAccepted, false);
    assert.equal(reply.json.data.data, "preserved");
    assert.equal(reply.json.data.automaticRestart, false);
    assert.equal(f.prepareCalls, 1);
    assert.equal(f.plugin.uid, null);
    assert.equal(f.closed, true);
    assert.equal(f.closedStoreReads, 0);
    assert.deepEqual(f.packageCalls, [["remove", "dsh-unlimit"]]);
    assert.equal(f.processAttempts, 0);
    assert.deepEqual(f.events, [{ reason: "remove" }]);
    assert.equal((await f.post()).status, 404);
    assert.equal(f.prepareCalls, 1);

    const manifest = JSON.parse(readFileSync(f.manifestPath, "utf8"));
    assert.equal(manifest.dependencies["dsh-unlimit"], undefined);
    assert.equal(manifest.dependencies["synthetic-unrelated"], "file:./synthetic-other");
    assert.deepEqual(manifest.dsh.profile.bundles, ["synthetic-unrelated"]);
    assert.equal(manifest.syntheticUnrelatedField, "retained");
    assert.equal(f.otherEntry.fiber.uid, "synthetic-unrelated-fiber");
    for (const [path, bytes] of f.originalSentinels) assert.deepEqual(readFileSync(path), bytes);
    const store = new WorkspaceStore(join(f.dataRoot, "workspace.sqlite"));
    try {
      assert.deepEqual(store.meta("synthetic-persistent-record"), { value: "SYNTHETIC-RETAINED" });
      assert.equal(new DrillAdmission(store, f.dataRoot).status().accepted, false);
    } finally {
      store.close();
    }
  },
);

test(
  "official removeBundle reports stop-profile with no HMR and does not remove an active package",
  hostOnly,
  async (t) => {
    const f = await fixture(t, { hmr: false });
    const result = await f.manager.removeBundle("dsh-unlimit");
    assert.equal(result.application, "failed");
    assert.equal(result.error.code, "stop-profile");
    assert.equal(result.changed, false);
    assert.equal(f.plugin.uid !== null, true);
    assert.equal(f.closed, false);
    assert.equal(f.prepareCalls, 0);
    assert.deepEqual(f.packageCalls, []);
    assert.deepEqual(f.events, [{ reason: "remove" }], "changed event is not a success-only event");
  },
);

test(
  "official package failure stays incomplete after self-dispose and preserves the installed dependency",
  hostOnly,
  async (t) => {
    const f = await fixture(t, { packageExitCode: 1 });
    await assert.rejects(f.maintenance.uninstall(payload, f.prepare), (error) => {
      assert.equal(error.code, "UNINSTALL_INCOMPLETE");
      assert.equal(error.partial.removed, false);
      assert.equal(error.partial.application, "failed");
      assert.equal(error.partial.prepared.admissionAccepted, false);
      return true;
    });
    assert.equal(f.closed, true);
    assert.equal(f.closedStoreReads, 0);
    assert.equal(
      (await f.manager.listBundles()).find((item) => item.name === "dsh-unlimit").installed,
      true,
    );
    assert.deepEqual(f.packageCalls, [["remove", "dsh-unlimit"]]);
    for (const [path, bytes] of f.originalSentinels) assert.deepEqual(readFileSync(path), bytes);
  },
);

test(
  "successful fake package exit without dependency removal cannot claim uninstall completion",
  hostOnly,
  async (t) => {
    const f = await fixture(t, { retainDependency: true });
    await assert.rejects(f.maintenance.uninstall(payload, f.prepare), (error) => {
      assert.equal(error.code, "UNINSTALL_INCOMPLETE");
      assert.equal(error.partial.removed, false);
      assert.equal(error.partial.application, "applied");
      return true;
    });
    assert.equal(f.closedStoreReads, 0);
  },
);

test(
  "official installation-owned metadata is unavailable to self-uninstall and skips preparation",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    writeFileSync(
      f.installAnchor,
      JSON.stringify({ name: "synthetic-installation", dependencies: { "dsh-unlimit": "0.0.0" } }),
    );
    const own = (await f.manager.listBundles()).find((item) => item.name === "dsh-unlimit");
    assert.equal(own.availability, "installation");
    assert.equal(own.removable, false);
    assert.equal(own.source, undefined);
    assert.equal((await f.maintenance.info()).available, false);
    await assert.rejects(f.maintenance.uninstall(payload, f.prepare), { code: "UNSUPPORTED" });
    assert.equal(f.prepareCalls, 0);
    assert.deepEqual(f.packageCalls, []);
  },
);

test("cancelled manager result is not reported as successful removal", hostOnly, async (t) => {
  const f = await fixture(t);
  // Cancellation is a structured-result compatibility case; this response is
  // synthetic, unlike the other tests' real PluginManager.removeBundle flow.
  f.manager.removeBundle = async () => ({
    changed: false,
    application: "cancelled",
    stage: "remove",
    target: "dsh-unlimit",
  });
  await assert.rejects(f.maintenance.uninstall(payload, f.prepare), (error) => {
    assert.equal(error.code, "UNINSTALL_INCOMPLETE");
    assert.equal(error.partial.removed, false);
    assert.equal(error.partial.application, "cancelled");
    return true;
  });
  assert.equal(f.closed, false);
  assert.deepEqual(f.packageCalls, []);
});
