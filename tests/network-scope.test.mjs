import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";
import { DrillAdmission } from "../src/core/admission.js";
import { CountryDatabase } from "../src/core/country-database.js";
import { NetworkScope } from "../src/core/network-scope.js";
import { ConnectionChecks } from "../src/core/connection-checks.js";
import { Controller } from "../src/server/controller.js";

const csv = [
  "1.0.1.0,1.0.1.255,CN",
  "1.0.2.0,1.0.2.255,HK",
  "1.0.3.0,1.0.3.255,MO",
  "8.8.8.0,8.8.8.255,US",
  "9.9.9.0,9.9.9.255,ZZ",
  "2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US",
].join("\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const cancelled = (signal) =>
  new Promise((_resolve, reject) =>
    signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("Cancelled"), { code: "DNS_CANCELLED" })),
      { once: true },
    ),
  );
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-region-test-")));
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  const database = new CountryDatabase(root);
  const admission = new DrillAdmission(store, root, { clock: () => 0 });
  const { challengeId } = admission.begin({});
  admission.dispatch("admission.read", { challengeId });
  admission.clock = () => 5000;
  admission.confirm({ challengeId, checks: { scope: true, permissions: true, evidence: true } });
  const workspaceId = store.dispatch("workspaces.save", { name: "Synthetic scope" }).item.id;
  const calls = { dns: [], transport: [] };
  const network = { resolve: async () => [{ address: "1.0.1.1", family: 4 }] };
  const resolve = async (...args) => {
    calls.dns.push(args);
    return network.resolve(...args);
  };
  const scope = new NetworkScope(store, { database, admission, resolve });
  const checks = new ConnectionChecks(store, {
    admission,
    scope,
    resolve,
    transport: async (endpoint) => {
      calls.transport.push(endpoint);
      return {
        state: "reachable",
        reason: "http-response",
        transport: {
          type: "http",
          address: endpoint.address,
          family: endpoint.family,
          httpStatus: 403,
        },
      };
    },
  });
  const controller = new Controller({
    store,
    admission,
    networkScope: scope,
    connectionChecks: checks,
    runtime: { enabled: false, revert() {}, capabilities: () => [] },
    host: { supported: true },
  });
  const settings = async (ownServers) => {
    const current = store.dispatch("settings.get", {});
    return controller.dispatch("settings.save", {
      revision: current.revision,
      value: { ...current.value, ownServers },
    });
  };
  const refresh = (hosts = ["owned.example.invalid"]) =>
    scope.refresh({ hosts, revision: scope.status().revision, confirmed: true });
  const load = (release = "2026-10") =>
    scope.import({
      filename: "synthetic.csv",
      release,
      contentBase64: Buffer.from(csv).toString("base64"),
      revision: database.status().revision,
    });
  const record = (url) =>
    store.dispatch("records.save", { workspaceId, kind: "webshell", data: { url } }).item;
  const prepare = (records) =>
    checks.prepare({ workspaceId, recordIds: records.map((item) => item.id) });
  const run = (records) => checks.run({ ...prepare(records), confirmed: true });
  t.after(async () => {
    await checks.close();
    await scope.close();
    database.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    database,
    admission,
    scope,
    checks,
    controller,
    workspaceId,
    calls,
    network,
    settings,
    refresh,
    load,
    record,
    prepare,
    run,
  };
}

test("local reads, registration, data import and preview do no DNS or transport work", async (t) => {
  const f = fixture(t);
  await f.settings(["user@owned.example.invalid", "127.0.0.1"]);
  assert.equal(f.scope.status().database.available, false);
  assert.equal(f.scope.preview("owned.example.invalid").state, "ready");
  assert.equal(f.scope.preview("elsewhere.example.invalid").reason, "database-unavailable");
  assert.equal(f.scope.preview("127.0.0.2").reason, "special-address");
  await f.load();
  assert.equal(f.scope.preview("elsewhere.example.invalid").reason, "region-pending");
  f.prepare([f.record("http://elsewhere.example.invalid/")]);
  f.checks.status({ workspaceId: f.workspaceId });
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("refresh requires confirmation, current revision, registered distinct domains and admission", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid", "127.0.0.1"]);
  const payload = { hosts: ["owned.example.invalid"], revision: f.scope.status().revision };
  assert.throws(() => f.scope.refresh(payload), { code: "CONFIRMATION_REQUIRED" });
  assert.throws(() => f.scope.refresh({ ...payload, confirmed: true, revision: "old" }), {
    code: "CONFLICT",
  });
  for (const hosts of [
    [],
    ["127.0.0.1"],
    ["elsewhere.example.invalid"],
    Array(33).fill("owned.example.invalid"),
    ["owned.example.invalid", "owned.example.invalid"],
  ])
    assert.throws(() => f.scope.refresh({ ...payload, confirmed: true, hosts }), {
      code: "INVALID_INPUT",
    });
  f.admission.revoke({ revision: f.admission.status().revision });
  assert.throws(() => f.scope.refresh({ ...payload, confirmed: true }), {
    code: "ADMISSION_REQUIRED",
  });
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("derived IP exceptions persist locally but do not spread to aliases, subdomains or adjacent IPs", async (t) => {
  const f = fixture(t);
  await f.settings(["user@owned.example.invalid"]);
  const result = await f.refresh();
  assert.equal(result.items[0].persisted, true);
  assert.equal(result.status.active, false);
  assert.deepEqual(result.status.hosts[0].snapshot.addresses, ["1.0.1.1"]);
  assert.equal(f.scope.decide("1.0.1.1", "1.0.1.1").reason, "resolved-exception");
  assert.equal(f.scope.decide("::ffff:1.0.1.1", "::ffff:100:101").allowed, true);
  assert.equal(f.scope.decide("alias.example.invalid", "1.0.1.1").allowed, false);
  assert.equal(f.scope.decide("sub.owned.example.invalid", "1.0.1.1").allowed, false);
  assert.equal(f.scope.decide("1.0.1.2", "1.0.1.2").allowed, false);
  assert.equal(f.scope.decide("1.0.1.1", "1.0.1.2").allowed, false);
  const reopened = new WorkspaceStore(join(f.root, "synthetic.sqlite"));
  try {
    const scope = new NetworkScope(reopened, { database: f.database });
    assert.equal(scope.decide("1.0.1.1", "1.0.1.1").reason, "resolved-exception");
  } finally {
    reopened.close();
  }
  assert.equal(f.calls.dns.length, 1);
  assert.equal(f.calls.transport.length, 0);
});

test("failed refresh preserves the old timestamp; successful refresh replaces it and inventory changes invalidate all derived IPs", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid"]);
  await f.refresh();
  const before = f.scope.status();
  f.network.resolve = async () => {
    throw Object.assign(new Error("synthetic-secret"), { code: "DNS_ERROR" });
  };
  const failed = await f.refresh();
  assert.equal(failed.items[0].state, "failed");
  assert.equal(failed.status.revision, before.revision);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic-secret/);
  f.network.resolve = async () => [{ address: "1.0.1.2", family: 4 }];
  await f.refresh();
  assert.equal(f.scope.decide("1.0.1.1", "1.0.1.1").allowed, false);
  assert.equal(f.scope.decide("1.0.1.2", "1.0.1.2").allowed, true);
  await f.settings([]);
  await f.settings(["owned.example.invalid"]);
  assert.equal(f.scope.status().hosts[0].snapshot, null);
  assert.equal(f.scope.decide("1.0.1.2", "1.0.1.2").allowed, false);
});

test("country decisions reject CN HK MO, unknown and special destinations, and honor exact exceptions", async (t) => {
  const f = fixture(t);
  await f.load();
  for (const [address, country] of [
    ["1.0.1.1", "CN"],
    ["1.0.2.1", "HK"],
    ["1.0.3.1", "MO"],
  ]) {
    const decision = f.scope.decide("target.example.invalid", address);
    assert.deepEqual(
      [decision.allowed, decision.country, decision.reason],
      [false, country, "country-denied"],
    );
  }
  for (const address of ["8.8.8.8", "2001:4860:4860::8888"]) {
    assert.equal(f.scope.decide("target.example.invalid", address).reason, "country-allowed");
  }
  for (const address of ["9.9.9.9", "7.7.7.7", "bad", "fe80::1%lo0"]) {
    assert.equal(f.scope.decide("target.example.invalid", address).allowed, false);
  }
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ]) {
    assert.equal(f.scope.decide("target.example.invalid", address).reason, "special-address");
  }
  await f.settings(["owned.example.invalid", "[::ffff:1.0.1.1]", "127.0.0.1"]);
  assert.equal(f.scope.decide("owned.example.invalid", "1.0.2.1").reason, "exact-host");
  assert.equal(f.scope.decide("1.0.1.1", "1.0.1.1").allowed, true);
  assert.equal(f.scope.decide("127.0.0.1", "127.0.0.1").allowed, true);
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("verified IPv6 translation classifies the IPv4 country while preserving the wire address", async (t) => {
  const f = fixture(t);
  await f.load();
  const wire = "2001:4860:1234::100:101";
  assert.equal(f.scope.decide("target.invalid", wire).country, "US");
  const denied = f.scope.decide("target.invalid", wire, { ipv4Destination: "1.0.1.1" });
  assert.deepEqual(
    [denied.allowed, denied.reason, denied.country, denied.address, denied.countryAddress],
    [false, "country-denied", "CN", wire, "1.0.1.1"],
  );
  const unknownSurface = "3001:1234::808:808";
  assert.equal(f.scope.decide("target.invalid", unknownSurface).allowed, false);
  const allowed = f.scope.decide(unknownSurface, unknownSurface, { ipv4Destination: "8.8.8.8" });
  assert.deepEqual(
    [allowed.allowed, allowed.country, allowed.address, allowed.countryAddress],
    [true, "US", unknownSurface, "8.8.8.8"],
  );
  assert.equal(
    f.scope.decide("target.invalid", wire, { ipv4Destination: "127.0.0.1" }).reason,
    "special-address",
  );
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("translation metadata cannot change the literal target or grant a decoded address exception", async (t) => {
  const f = fixture(t);
  await f.load();
  const wire = "3001:1234::100:101";
  await f.settings(["1.0.1.1", "owned.invalid"]);
  assert.equal(
    f.scope.decide("target.invalid", wire, { ipv4Destination: "1.0.1.1" }).allowed,
    false,
  );
  assert.equal(
    f.scope.decide("owned.invalid", wire, { ipv4Destination: "1.0.1.1" }).reason,
    "exact-host",
  );
  assert.equal(f.scope.decide("1.0.1.1", wire, { ipv4Destination: "8.8.8.8" }).allowed, false);
  assert.equal(f.scope.decide("3001:1234::2", wire, { ipv4Destination: "8.8.8.8" }).allowed, false);
  for (const ipv4Destination of ["bad", "::1", "1.2.3.4%lo0", null, 42]) {
    assert.equal(f.scope.decide("target.invalid", wire, { ipv4Destination }).allowed, false);
  }
  assert.equal(
    f.scope.decide("target.invalid", "1.0.1.1", { ipv4Destination: "8.8.8.8" }).allowed,
    false,
  );
  assert.equal(
    f.scope.decide("::ffff:1.0.1.1", "::ffff:1.0.1.1", { ipv4Destination: "8.8.8.8" }).allowed,
    false,
  );
});

test("HTTP IPv6 literal preview defers surface classification only while discovery is pending", async (t) => {
  const f = fixture(t);
  const wire = "3001:1234::808:808";
  assert.equal(f.scope.preview(wire, { translationPending: true }).state, "denied");
  await f.load();
  assert.equal(f.scope.preview(wire).state, "denied");
  assert.deepEqual(f.scope.preview(wire, { translationPending: true }), {
    state: "ready",
    reason: "region-pending",
  });
  assert.equal(f.scope.preview("1.0.1.1", { translationPending: true }).state, "denied");
  assert.equal(f.scope.preview("::ffff:1.0.1.1", { translationPending: true }).state, "denied");
  await f.settings([wire]);
  assert.equal(f.scope.preview(wire, { translationPending: true }).reason, "exact-host");
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("mixed DNS selects only the first permitted address, preserves original host/path, and records its country", async (t) => {
  const f = fixture(t);
  await f.load();
  f.network.resolve = async () => [
    { address: "1.0.1.1", family: 4 },
    { address: "8.8.8.8", family: 4 },
    { address: "2001:4860:4860::8888", family: 6 },
  ];
  const record = f.record("https://target.example.invalid/health?q=synthetic");
  assert.equal(f.prepare([record]).items[0].reason, "region-pending");
  const result = await f.run([record]);
  assert.deepEqual(
    f.calls.dns.map(([hostname]) => hostname),
    ["target.example.invalid", "ipv4only.arpa"],
  );
  assert.equal(f.calls.transport.length, 1);
  assert.equal(f.calls.transport[0].address, "8.8.8.8");
  assert.equal(f.calls.transport[0].hostname, "target.example.invalid");
  assert.equal(f.calls.transport[0].path, "/health?q=synthetic");
  assert.equal(result.items[0].scope.country, "US");
  assert.equal(result.items[0].scope.databaseRevision, f.database.status().revision);
  assert.equal(result.items[0].persisted, true);
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].stale, false);
});

test("blocked mixed answers never reach transport and literal checks never resolve", async (t) => {
  const f = fixture(t);
  await f.load();
  f.network.resolve = async () => [
    { address: "1.0.2.1", family: 4 },
    { address: "10.1.1.1", family: 4 },
    { address: "9.9.9.9", family: 4 },
  ];
  const result = await f.run([
    f.record("http://target.example.invalid/"),
    f.record("http://1.0.3.1/"),
  ]);
  assert.deepEqual(
    result.items.map((item) => item.state),
    ["denied", "denied"],
  );
  assert.equal(result.items[0].scope.country, "HK");
  assert.equal(f.calls.dns.length, 1);
  assert.equal(f.calls.transport.length, 0);
  const allowed = await f.run([f.record("http://8.8.8.8/")]);
  assert.equal(allowed.items[0].scope.country, "US");
  assert.equal(f.calls.dns.length, 1);
});

test("DNS snapshots and country releases invalidate prepared confirmations and old check receipts", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid"]);
  const record = f.record("http://owned.example.invalid/");
  const prepared = f.prepare([record]);
  await f.refresh();
  assert.throws(() => f.checks.run({ ...prepared, confirmed: true }), { code: "CONFLICT" });
  await f.run([record]);
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].stale, false);
  const before = f.prepare([record]);
  await f.load();
  assert.throws(() => f.checks.run({ ...before, confirmed: true }), { code: "CONFLICT" });
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].stale, true);
  const first = f.database.status();
  await f.load("2026-11");
  assert.equal(first.sha256, f.database.status().sha256);
  assert.notEqual(first.revision, f.database.status().revision);
});

test("receipts created before translation-aware policy remain visible but become stale", async (t) => {
  const f = fixture(t);
  await f.load();
  const record = f.record("https://8.8.8.8/");
  await f.run([record]);
  const key = `connection-check:${record.id}`;
  const saved = f.store.meta(key);
  const legacyRevision = createHash("sha256")
    .update(
      JSON.stringify({
        hosts: f.scope.hosts(),
        snapshots: f.scope.snapshots(),
        database: f.database.status().revision,
      }),
    )
    .digest("hex");
  assert.notEqual(f.scope.status().revision, legacyRevision);
  f.store.setMeta(key, { ...saved, policy: legacyRevision });
  const status = f.checks.status({ workspaceId: f.workspaceId }).items[0];
  assert.equal(status.stale, true);
  assert.deepEqual(status.lastCheck, saved.result);
});

test("scope changes during check DNS prevent connection and stale persistence", async (t) => {
  const f = fixture(t);
  await f.load();
  let release;
  f.network.resolve = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const record = f.record("http://target.example.invalid/");
  const running = f.run([record]);
  await tick();
  // Database replacement is synchronous; already captured checks must observe its new revision.
  f.database.import({
    filename: "synthetic.csv",
    contentBase64: Buffer.from(csv).toString("base64"),
    release: "2026-11",
    revision: f.database.status().revision,
  });
  release([{ address: "8.8.8.8", family: 4 }]);
  const result = await running;
  assert.equal(result.items[0].state, "cancelled");
  assert.equal(result.items[0].discardReason, "scope-changed");
  assert.equal(result.items[0].persisted, false);
  assert.equal(f.calls.transport.length, 0);
});

test("refresh cancellation drains owned DNS work and records no new exception", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid"]);
  f.network.resolve = (_host, { signal }) => cancelled(signal);
  const running = f.refresh();
  await tick();
  assert.equal(f.scope.status().active, true);
  assert.throws(() => f.refresh(), { code: "CONFLICT" });
  await f.scope.stopAll();
  const result = await running;
  assert.equal(result.items[0].state, "cancelled");
  assert.equal(f.scope.status().active, false);
  assert.equal(f.scope.status().hosts[0].snapshot, null);
});

test("a policy replacement observed during address classification cancels before transport", async (t) => {
  const f = fixture(t);
  await f.load();
  f.network.resolve = async () => [{ address: "8.8.8.8", family: 4 }];
  const decide = f.scope.decide.bind(f.scope);
  f.scope.decide = (host, address) => {
    const result = decide(host, address);
    f.database.import({
      filename: "synthetic.csv",
      release: "2026-11",
      contentBase64: Buffer.from(csv).toString("base64"),
      revision: f.database.status().revision,
    });
    return result;
  };
  const result = await f.run([f.record("http://target.example.invalid/")]);
  assert.equal(result.items[0].state, "cancelled");
  assert.equal(result.items[0].persisted, false);
  assert.equal(result.items[0].discardReason, "scope-changed");
  assert.equal(f.calls.transport.length, 0);
});

test("admission revoke and uninstall cancel pending refresh before controller drain", async (t) => {
  for (const action of ["revoke", "uninstall"]) {
    const f = fixture(t);
    await f.settings(["owned.example.invalid"]);
    f.network.resolve = (_host, { signal }) => cancelled(signal);
    const running = f.controller.dispatch("networkScope.resolve", {
      hosts: ["owned.example.invalid"],
      revision: f.scope.status().revision,
      confirmed: true,
    });
    await tick();
    if (action === "revoke")
      await f.controller.dispatch("admission.revoke", { revision: f.admission.status().revision });
    else {
      const prepared = await f.controller.prepareUninstall();
      assert.equal(prepared.steps.find((step) => step.id === "scope").status, "completed");
    }
    const result = await running;
    assert.equal(result.items[0].state, "cancelled");
    assert.equal(result.items[0].persisted, false);
    assert.equal(f.scope.status().active, false);
  }
});

test("inventory edits abort in-flight refresh and cannot revive exceptions after remove/re-add", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid"]);
  f.network.resolve = (_host, { signal }) => cancelled(signal);
  const running = f.refresh();
  await tick();
  await f.settings([]);
  assert.equal((await running).items[0].reason, "scope-changed");
  await f.settings(["owned.example.invalid"]);
  assert.equal(f.scope.status().hosts[0].snapshot, null);
});

test("refresh persistence failure reports actual observations without claiming an exception was saved", async (t) => {
  const f = fixture(t);
  await f.settings(["owned.example.invalid"]);
  const set = f.store.setMeta.bind(f.store);
  f.store.setMeta = (key, value) => {
    if (key === "network-scope:dns") throw new Error("synthetic private storage error");
    return set(key, value);
  };
  await assert.rejects(f.refresh(), (error) => {
    assert.equal(error.code, "NETWORK_SCOPE_PARTIAL");
    assert.equal(error.partial.items[0].state, "resolved");
    assert.equal(error.partial.items[0].persisted, false);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.equal(f.scope.decide("1.0.1.1", "1.0.1.1").allowed, false);
});
