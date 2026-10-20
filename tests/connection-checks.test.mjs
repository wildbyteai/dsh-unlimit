import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { WorkspaceStore } from "../src/core/store.js";
import { DrillAdmission } from "../src/core/admission.js";
import { ConnectionChecks } from "../src/core/connection-checks.js";
import { Controller } from "../src/server/controller.js";
import { checkEndpoint } from "../src/core/connection-transport.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const reachable = (endpoint) => ({
  state: "reachable",
  reason: endpoint.protocol === "tcp:" ? "tcp-connected" : "http-response",
  latencyMs: 1,
  transport: {
    type: endpoint.protocol === "tcp:" ? "tcp" : "http",
    address: endpoint.address,
    family: endpoint.family,
    ...(endpoint.protocol === "tcp:" ? {} : { httpStatus: 403 }),
  },
});
function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-unlimit-checks-"));
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  const admission = new DrillAdmission(store, root, { clock: () => 0 });
  const { challengeId } = admission.begin({});
  admission.dispatch("admission.read", { challengeId });
  admission.clock = () => 5000;
  admission.confirm({ challengeId, checks: { scope: true, permissions: true, evidence: true } });
  const workspaceId = store.dispatch("workspaces.save", { name: "Synthetic checks" }).item.id;
  const calls = { dns: [], transport: [] };
  const checks = new ConnectionChecks(store, {
    admission,
    resolve: async (...args) => {
      calls.dns.push(args);
      return options.resolve ? options.resolve(...args) : [{ address: "127.0.0.1", family: 4 }];
    },
    transport: async (...args) => {
      calls.transport.push(args);
      return options.transport ? options.transport(...args) : reachable(args[0]);
    },
  });
  const controller = new Controller({
    store,
    admission,
    connectionChecks: checks,
    runtime: { enabled: false, revert() {}, capabilities: () => [] },
    host: { supported: true },
  });
  const settings = (ownServers) => {
    const current = store.dispatch("settings.get", {});
    return store.dispatch("settings.save", {
      revision: current.revision,
      value: { ...current.value, ownServers },
    });
  };
  settings(["127.0.0.1", "[::1]", "user@permitted.example.invalid"]);
  const record = (data, kind = "webshell", extra = {}) =>
    store.dispatch("records.save", { workspaceId, kind, data, ...extra }).item;
  const payload = (records) => ({ workspaceId, recordIds: records.map((record) => record.id) });
  const run = (records, extra = {}) => {
    const selected = payload(records);
    return checks.run({
      ...selected,
      snapshot: checks.prepare(selected).snapshot,
      confirmed: true,
      ...extra,
    });
  };
  t.after(async () => {
    await checks.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store,
    admission,
    checks,
    controller,
    workspaceId,
    calls,
    settings,
    record,
    payload,
    run,
  };
}

test("reads and preparation never perform I/O; exact inventory matches do not grant neighbours or aliases", (t) => {
  const f = fixture(t);
  const records = [
    f.record({ url: "http://permitted.example.invalid/health?q=synthetic" }),
    f.record({ url: "https://PERMITTED.EXAMPLE.INVALID./" }),
    f.record({ url: "http://child.permitted.example.invalid/" }),
    f.record({ url: "http://alias.example.invalid/" }),
    f.record({ url: "http://127.0.0.2/" }),
    f.record({ listenHost: "[::1]", listenPort: 12345 }, "tunnel"),
  ];
  const prepared = f.checks.prepare(f.payload(records));
  assert.deepEqual(
    prepared.items.map((item) => item.state),
    ["ready", "ready", "denied", "denied", "denied", "ready"],
  );
  assert.doesNotMatch(JSON.stringify(prepared), /q=synthetic/);
  assert.match(prepared.items[0].target, /查询参数已隐藏/);
  assert.ok(
    f.checks.status({ workspaceId: f.workspaceId }).items.every((item) => item.lastCheck === null),
  );
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("ambiguous listeners, credential URLs and unsupported schemes are not inferred from notes", async (t) => {
  const f = fixture(t);
  const records = [
    f.record({ url: "http://synthetic:secret@127.0.0.1/" }),
    f.record({ url: "file:///tmp/example" }),
    f.record({ url: "http://127.0.0.1/#fragment" }),
    f.record({ url: " http://127.0.0.1/" }),
    f.record(
      { source: "127.0.0.1:1234", destination: "elsewhere", notes: "connect 127.0.0.1 1234" },
      "tunnel",
    ),
    f.record({ listenHost: "127.0.0.1", listenPort: 1234, protocol: "udp" }, "tunnel"),
    f.record({ listenHost: "127.0.0.1", listenPort: "1234" }, "tunnel"),
    f.record({ listenHost: "user@permitted.example.invalid", listenPort: 1234 }, "tunnel"),
  ];
  const result = await f.run(records);
  assert.ok(result.items.every((item) => item.state === "unsupported" && item.persisted));
  assert.doesNotMatch(JSON.stringify(result), /secret|elsewhere/);
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("confirmation, admission, scoped IDs and fresh snapshots are checked before any network work", (t) => {
  const f = fixture(t);
  const record = f.record({ url: "http://127.0.0.1/" });
  const prepared = f.checks.prepare(f.payload([record]));
  assert.throws(() => f.checks.run(prepared), { code: "CONFIRMATION_REQUIRED" });
  assert.throws(() => f.checks.prepare(f.payload([record, record])), { code: "INVALID_INPUT" });
  assert.throws(() => f.checks.prepare({ workspaceId: f.workspaceId, recordIds: [] }), {
    code: "INVALID_INPUT",
  });
  const second = f.store.dispatch("workspaces.save", { name: "Second" }).item;
  assert.throws(() => f.checks.prepare({ ...f.payload([record]), workspaceId: second.id }), {
    code: "NOT_FOUND",
  });
  const unrelated = f.record({ name: "Not a network endpoint" }, "session");
  assert.throws(() => f.checks.prepare(f.payload([unrelated])), { code: "NOT_FOUND" });
  f.record({ url: "http://127.0.0.1/changed" }, "webshell", { id: record.id });
  assert.throws(() => f.checks.run({ ...prepared, confirmed: true }), { code: "CONFLICT" });
  f.admission.revoke({ revision: f.admission.status().revision });
  assert.throws(() => f.run([record]), { code: "ADMISSION_REQUIRED" });
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("one system DNS snapshot pins one address, retains path, and writes trustworthy results separately", async (t) => {
  const f = fixture(t, {
    resolve: async () => [
      { address: "127.0.0.1", family: 4 },
      { address: "::1", family: 6 },
    ],
  });
  const record = f.record({
    name: "Synthetic HTTP",
    url: "http://permitted.example.invalid:12345/path?q=synthetic",
    status: "manual-online",
    probe: { state: "reachable", httpStatus: 200 },
    credential: "synthetic-unused-secret",
  });
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].lastCheck, null);
  const result = await f.run([record]);
  assert.equal(f.calls.dns.length, 1);
  assert.equal(f.calls.transport.length, 1);
  assert.equal(f.calls.transport[0][0].hostname, "permitted.example.invalid");
  assert.equal(f.calls.transport[0][0].address, "127.0.0.1");
  assert.equal(f.calls.transport[0][0].path, "/path?q=synthetic");
  assert.equal(f.calls.transport[0][0].credential, undefined);
  assert.equal(result.items[0].transport.httpStatus, 403);
  assert.equal(result.items[0].persisted, true);
  assert.ok(Number.isFinite(Date.parse(result.items[0].checkedAt)));
  assert.equal(
    f.store.get("records", record.id, f.workspaceId, "webshell").data.status,
    "manual-online",
  );
  const current = f.checks.status({ workspaceId: f.workspaceId }).items[0];
  assert.deepEqual(current.lastCheck, result.items[0]);
  assert.equal(current.stale, false);
  f.record({ ...record.data, status: "manual-change" }, "webshell", { id: record.id });
  const changed = f.checks.status({ workspaceId: f.workspaceId }).items[0];
  assert.equal(changed.stale, true);
  assert.deepEqual(changed.lastCheck, result.items[0]);
});

test("changing a record during DNS prevents the connection and does not persist its old target", async (t) => {
  const pending = Promise.withResolvers();
  const f = fixture(t, { resolve: () => pending.promise });
  const record = f.record({ url: "http://permitted.example.invalid/" });
  const running = f.run([record]);
  await tick();
  f.record({ url: "http://127.0.0.1/new" }, "webshell", { id: record.id });
  pending.resolve([{ address: "127.0.0.1", family: 4 }]);
  const result = await running;
  assert.equal(f.calls.transport.length, 0);
  assert.equal(result.items[0].state, "cancelled");
  assert.equal(result.items[0].discardReason, "record-changed");
  assert.equal(result.items[0].persisted, false);
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].lastCheck, null);
});

test("a result observed after an edit remains an unpersisted receipt; manual data cannot forge it", async (t) => {
  const pending = Promise.withResolvers();
  const f = fixture(t, { transport: () => pending.promise });
  const record = f.record({ url: "http://127.0.0.1/" });
  const running = f.run([record]);
  await tick();
  f.record({ url: "http://127.0.0.1/new", lastCheck: { state: "reachable" } }, "webshell", {
    id: record.id,
  });
  pending.resolve(reachable(f.calls.transport[0][0]));
  const result = await running;
  assert.equal(result.items[0].state, "reachable");
  assert.equal(result.items[0].persisted, false);
  assert.equal(result.items[0].discardReason, "record-changed");
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].lastCheck, null);
});

test("save failure exposes observations and stops later connections without a successful-looking fallback", async (t) => {
  const f = fixture(t);
  const records = [
    f.record({ url: "http://127.0.0.1/first" }),
    f.record({ url: "http://127.0.0.1/second" }),
  ];
  const original = f.store.setMeta.bind(f.store);
  f.store.setMeta = (key, value) => {
    if (key.startsWith("connection-check:"))
      throw new Error("synthetic-storage-detail-must-not-leak");
    return original(key, value);
  };
  await assert.rejects(f.run(records), (error) => {
    assert.equal(error.code, "CONNECTION_CHECK_PARTIAL");
    assert.doesNotMatch(error.message, /synthetic-storage-detail/);
    assert.equal(error.partial.items.length, 1);
    assert.equal(error.partial.items[0].state, "reachable");
    assert.equal(error.partial.items[0].persisted, false);
    return true;
  });
  assert.equal(f.calls.transport.length, 1);
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, false);
});

function hanging(_endpoint, { signal }) {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => setImmediate(() => resolve({ state: "cancelled", reason: "cancelled", latencyMs: 1 })),
      { once: true },
    );
  });
}

test("explicit stop awaits the owned request, cancels remaining entries and prevents duplicate batches", async (t) => {
  const f = fixture(t, { transport: hanging });
  const records = [
    f.record({ url: "http://127.0.0.1/" }),
    f.record({ url: "http://127.0.0.1/second" }),
  ];
  const running = f.run(records);
  await tick();
  assert.throws(() => f.run(records), { code: "CONFLICT" });
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, true);
  await f.checks.stop({ workspaceId: f.workspaceId });
  const result = await running;
  assert.equal(f.calls.transport.length, 1);
  assert.equal(result.cancelled, true);
  assert.ok(result.items.every((item) => item.state === "cancelled" && item.persisted));
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, false);
});

test("controller revocation cancels in-flight checks, rejects new work and still allows stop", async (t) => {
  const f = fixture(t, { transport: hanging });
  const record = f.record({ url: "http://127.0.0.1/" });
  const prepared = await f.controller.dispatch("connectionChecks.prepare", f.payload([record]));
  const running = f.controller.dispatch("connectionChecks.run", { ...prepared, confirmed: true });
  await tick();
  await f.controller.dispatch("admission.revoke", { revision: f.admission.status().revision });
  const result = await running;
  assert.equal(result.items[0].discardReason, "admission-changed");
  assert.equal(result.items[0].persisted, false);
  await assert.rejects(
    f.controller.dispatch("connectionChecks.status", { workspaceId: f.workspaceId }),
    { code: "ADMISSION_REQUIRED" },
  );
  assert.deepEqual(
    await f.controller.dispatch("connectionChecks.stop", { workspaceId: f.workspaceId }),
    { stopped: true },
  );
});

test("a server-list change aborts current requests, while unrelated prompt changes leave them running", async (t) => {
  const f = fixture(t, { transport: hanging });
  const record = f.record({ url: "http://127.0.0.1/" });
  const running = f.run([record]);
  await tick();
  const current = f.store.dispatch("settings.get");
  const saved = await f.controller.dispatch("settings.save", {
    revision: current.revision,
    value: { ...current.value, prompt: "Synthetic prompt" },
  });
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, true);
  await f.controller.dispatch("settings.save", {
    revision: saved.revision,
    value: { ...saved.value, ownServers: [] },
  });
  const result = await running;
  assert.equal(result.items[0].discardReason, "scope-changed");
  assert.equal(result.items[0].persisted, false);
  assert.equal(f.checks.prepare(f.payload([record])).items[0].state, "denied");
});

test("uninstall preparation cancels a pending controller run before draining, and close prohibits new work", async (t) => {
  const f = fixture(t, { transport: hanging });
  const record = f.record({ url: "http://127.0.0.1/" });
  const prepared = await f.controller.dispatch("connectionChecks.prepare", f.payload([record]));
  const running = f.controller.dispatch("connectionChecks.run", { ...prepared, confirmed: true });
  await tick();
  const removed = await f.controller.prepareUninstall();
  assert.deepEqual(removed.steps[0], { id: "checks", status: "completed" });
  assert.equal((await running).items[0].state, "cancelled");
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, false);
  await f.checks.close();
  assert.throws(() => f.checks.prepare(f.payload([record])), { code: "CLOSED" });
});

test("DNS errors are fixed reasons; the transport receives the remaining per-entry total budget", async (t) => {
  const f = fixture(t, {
    resolve: async (hostname) => {
      if (hostname === "bad.example.invalid")
        throw Object.assign(new Error("synthetic-private-dns-error"), { code: "DNS_ERROR" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return [{ address: "127.0.0.1", family: 4 }];
    },
  });
  f.settings(["bad.example.invalid", "permitted.example.invalid"]);
  const result = await f.run(
    [
      f.record({ url: "http://bad.example.invalid/" }),
      f.record({ url: "http://permitted.example.invalid/" }),
    ],
    { timeoutMs: 1000 },
  );
  assert.equal(result.items[0].reason, "dns-error");
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
  assert.ok(f.calls.transport[0][1].timeoutMs > 0 && f.calls.transport[0][1].timeoutMs < 1000);
});

test("real loopback HEAD returns HTTP facts and TCP listener check sends no application request", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(302, {
      Location: "http://uncontacted.example.invalid/",
      "X-Synthetic": "not-in-receipt",
    });
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const f = fixture(t, { transport: checkEndpoint });
  const port = server.address().port;
  const result = await f.run([
    f.record({ url: `http://127.0.0.1:${port}/health?sample=one`, password: "synthetic-unused" }),
    f.record({ listenHost: "127.0.0.1", listenPort: port, protocol: "tcp" }, "tunnel"),
    f.record({ url: `http://uncontacted.example.invalid:${port}/` }),
  ]);
  assert.deepEqual(
    result.items.map((item) => item.state),
    ["reachable", "reachable", "denied"],
  );
  assert.equal(result.items[0].transport.httpStatus, 302);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "HEAD");
  assert.equal(requests[0].url, "/health?sample=one");
  for (const header of ["authorization", "cookie"])
    assert.equal(requests[0].headers[header], undefined);
  assert.doesNotMatch(JSON.stringify(result), /not-in-receipt|synthetic-unused/);
  assert.equal(f.calls.dns.length, 0);
});
