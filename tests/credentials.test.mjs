import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-credential-"));
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const workspace = store.dispatch("workspaces.save", {
    name: "Synthetic credential project",
  }).item;
  const other = store.dispatch("workspaces.save", { name: "Independent synthetic project" }).item;
  const save = (data, extra = {}) =>
    store.dispatch("records.save", {
      workspaceId: workspace.id,
      kind: "credential",
      data,
      ...extra,
    }).item;
  const list = () =>
    store.dispatch("records.list", { workspaceId: workspace.id, kind: "credential" }).items;
  // Tests alone inspect the local fixture's storage to prove preservation/cleanup, never an API reveal.
  const raw = (id) =>
    JSON.parse(store.db.prepare("SELECT value FROM entries WHERE id = ?").get(id).value);
  const legacy = (data) => store.save("records", {}, { data }, workspace.id, "credential");
  const asset = (workspaceId = workspace.id, name = "Synthetic asset") =>
    store.dispatch("assets.save", {
      workspaceId,
      name,
      address: `${name.replaceAll(" ", "-").toLowerCase()}.invalid`,
      services: [{ port: 443, protocol: "tcp", name: "https" }],
    }).item;
  return { store, workspace, other, save, list, raw, legacy, asset };
}
const containsNone = (value, secrets) => {
  const encoded = JSON.stringify(value);
  for (const secret of secrets)
    assert.ok(!encoded.includes(secret), "A synthetic secret escaped the safe read boundary");
};

test("credential list/save/get/helper results expose metadata and state without values or masks", (t) => {
  const f = fixture(t);
  const secret = "SYNTHETIC-CREDENTIAL-SECRET-41";
  const item = f.save({
    name: "Fixture credential",
    username: "fixture-user",
    target: "fixture.invalid",
    notes: "Supplied evidence only",
    role: "reader",
    source: "Synthetic local fixture",
    secret,
  });
  assert.equal(item.data.name, "Fixture credential");
  assert.equal(item.data.username, "fixture-user");
  assert.equal(Object.hasOwn(item.data, "secret"), false);
  assert.deepEqual(item.secretState, { hasSecret: true, legacyFieldCount: 0 });
  const outputs = [
    item,
    f.list(),
    f.store.get("records", item.id, f.workspace.id, "credential"),
    f.store.list("records", f.workspace.id, "credential"),
  ];
  containsNone(outputs, [secret, "[REDACTED]", "••••••"]);
  assert.equal(f.raw(item.id).data.secret, secret);
  const helper = f.store.save(
    "records",
    { id: item.id },
    { data: { secret } },
    f.workspace.id,
    "credential",
  );
  containsNone(helper, [secret]);
  assert.equal(helper.secretState.hasSecret, true);
});

test("missing secret preserves, nonempty replaces, explicit empty clears; metadata merges and clears independently", (t) => {
  const f = fixture(t);
  const first = f.save({
    name: "Initial",
    username: "fixture-user",
    notes: "Retain this metadata",
    secret: "SYNTHETIC-FIRST",
  });
  const edited = f.save({ name: "Renamed", username: "" }, { id: first.id });
  assert.equal(edited.data.name, "Renamed");
  assert.equal(edited.data.notes, "Retain this metadata");
  assert.equal(Object.hasOwn(edited.data, "username"), false);
  assert.equal(f.raw(first.id).data.secret, "SYNTHETIC-FIRST");
  const replaced = f.save({ secret: "SYNTHETIC-SECOND" }, { id: first.id });
  assert.equal(replaced.secretState.hasSecret, true);
  assert.equal(f.raw(first.id).data.secret, "SYNTHETIC-SECOND");
  const cleared = f.save({ secret: "" }, { id: first.id });
  assert.equal(cleared.secretState.hasSecret, false);
  assert.equal(Object.hasOwn(f.raw(first.id).data, "secret"), false);
  assert.equal(cleared.data.name, "Renamed");
  containsNone([edited, replaced, cleared], ["SYNTHETIC-FIRST", "SYNTHETIC-SECOND"]);
});

test("opaque legacy fields remain internal during metadata edits and only explicit cleanup removes them", (t) => {
  const f = fixture(t);
  const legacyData = {
    name: "Legacy fixture",
    notes: { password: "SYNTHETIC-NESTED" },
    password: "SYNTHETIC-LEGACY",
    headers: { Authorization: "SYNTHETIC-HEADER" },
    custom: ["SYNTHETIC-CUSTOM"],
    secret: "SYNTHETIC-CANONICAL",
  };
  const item = f.legacy(legacyData);
  assert.deepEqual(item.secretState, { hasSecret: true, legacyFieldCount: 4 });
  assert.deepEqual(item.data, { name: "Legacy fixture" });
  const edited = f.save({ name: "Renamed legacy" }, { id: item.id });
  assert.deepEqual(f.raw(item.id).data, { ...legacyData, name: "Renamed legacy" });
  assert.equal(edited.secretState.legacyFieldCount, 4);
  containsNone(
    [edited, f.list()],
    [
      "SYNTHETIC-NESTED",
      "SYNTHETIC-LEGACY",
      "SYNTHETIC-HEADER",
      "SYNTHETIC-CUSTOM",
      "SYNTHETIC-CANONICAL",
      "password",
      "headers",
      "custom",
    ],
  );
  const cleaned = f.save({}, { id: item.id, clearLegacyFields: true });
  assert.deepEqual(f.raw(item.id).data, { name: "Renamed legacy", secret: "SYNTHETIC-CANONICAL" });
  assert.deepEqual(cleaned.secretState, { hasSecret: true, legacyFieldCount: 0 });
  const cleared = f.save({ secret: "" }, { id: item.id, clearLegacyFields: true });
  assert.deepEqual(f.raw(item.id).data, { name: "Renamed legacy" });
  assert.equal(cleared.secretState.hasSecret, false);
});

test("legacy-only values and invalid canonical type stay opaque until an explicit replacement or clearing", (t) => {
  const f = fixture(t);
  const item = f.legacy({
    password: "SYNTHETIC-OLD-ONLY",
    role: { secret: "SYNTHETIC-OLD-ROLE" },
    secret: { token: "SYNTHETIC-OLD-SHAPE" },
  });
  assert.deepEqual(item.data, {});
  assert.deepEqual(item.secretState, { hasSecret: true, legacyFieldCount: 2 });
  f.save({ source: "Synthetic migration" }, { id: item.id });
  assert.deepEqual(f.raw(item.id).data.secret, { token: "SYNTHETIC-OLD-SHAPE" });
  f.save({ secret: "" }, { id: item.id, clearLegacyFields: true });
  assert.deepEqual(f.raw(item.id).data, { source: "Synthetic migration" });
});

test("credential errors never echo secret values, unsupported field names, or display placeholders into storage", (t) => {
  const f = fixture(t);
  const item = f.save({ secret: "SYNTHETIC-UNCHANGED" });
  const invalid = [
    [{ secret: { token: "SYNTHETIC-INVALID-VALUE" } }, {}],
    [{ "SYNTHETIC-SECRET-KEY": "SYNTHETIC-INVALID-VALUE" }, {}],
    [{ notes: ["SYNTHETIC-INVALID-VALUE"] }, {}],
    [{ secret: "[REDACTED]" }, {}],
    [{ secret: "•••••• · 已隐藏" }, {}],
    [{}, { clearLegacyFields: null }],
    [{}, { clearLegacyFields: "SYNTHETIC-INVALID-VALUE" }],
  ];
  for (const [data, options] of invalid) {
    assert.throws(
      () => f.save(data, { id: item.id, ...options }),
      (error) => {
        assert.equal(error.code, "INVALID_INPUT");
        containsNone({ message: error.message }, [
          "SYNTHETIC-SECRET-KEY",
          "SYNTHETIC-INVALID-VALUE",
          "SYNTHETIC-UNCHANGED",
        ]);
        return true;
      },
    );
    assert.deepEqual(f.raw(item.id).data, { secret: "SYNTHETIC-UNCHANGED" });
  }
});

test("credential asset and service associations are checked against the same project and selected asset", (t) => {
  const f = fixture(t);
  const a = f.asset(),
    b = f.asset(f.workspace.id, "Second asset"),
    foreign = f.asset(f.other.id, "Foreign asset");
  const item = f.save({
    assetId: a.id,
    serviceId: a.services[0].id,
    role: "declared-reader",
    source: "Human-supplied fixture",
  });
  assert.equal(item.data.serviceId, a.services[0].id);
  for (const data of [
    { assetId: foreign.id },
    { assetId: a.id, serviceId: b.services[0].id },
    { assetId: a.id, serviceId: foreign.services[0].id },
  ]) {
    assert.throws(() => f.save(data), { code: "NOT_FOUND" });
  }
  assert.throws(() => f.save({ serviceId: a.services[0].id }), { code: "INVALID_INPUT" });
  assert.throws(() => f.save({ assetId: "" }, { id: item.id }), { code: "INVALID_INPUT" });
  const detached = f.save({ assetId: "", serviceId: "" }, { id: item.id });
  assert.equal(Object.hasOwn(detached.data, "assetId"), false);
  assert.equal(Object.hasOwn(detached.data, "serviceId"), false);
});

test("same record ID cannot change kind, project or domain to bypass credential projection", (t) => {
  const f = fixture(t);
  const item = f.save({ secret: "SYNTHETIC-NO-BYPASS" });
  for (const kind of ["access", "http", "file"]) {
    assert.throws(
      () =>
        f.store.dispatch("records.save", {
          workspaceId: f.workspace.id,
          id: item.id,
          kind,
          data: {},
        }),
      { code: "NOT_FOUND" },
    );
    assert.deepEqual(
      f.store.dispatch("records.list", { workspaceId: f.workspace.id, kind }).items,
      [],
    );
  }
  assert.throws(() => f.save({}, { id: item.id, workspaceId: f.other.id }), { code: "NOT_FOUND" });
  assert.throws(
    () =>
      f.store.dispatch("assets.save", {
        workspaceId: f.workspace.id,
        id: item.id,
        name: "Cannot move",
        address: "fixture.invalid",
      }),
    { code: "NOT_FOUND" },
  );
  assert.throws(() => f.store.get("records", item.id, f.workspace.id, "access"), {
    code: "NOT_FOUND",
  });
  assert.equal(f.raw(item.id).data.secret, "SYNTHETIC-NO-BYPASS");
  containsNone(f.list(), ["SYNTHETIC-NO-BYPASS"]);
});

test("credential reporting remains fully hidden, no login/network call occurs, and unrelated records retain their contract", (t) => {
  const f = fixture(t);
  let requests = 0;
  t.mock.method(globalThis, "fetch", () => {
    requests++;
    throw new Error("Network is forbidden in synthetic credential registration");
  });
  f.save({
    name: "SYNTHETIC-PRIVATE-NAME",
    username: "SYNTHETIC-PRIVATE-ACCOUNT",
    secret: "SYNTHETIC-REPORT-SECRET",
    notes: "SYNTHETIC-PRIVATE-NOTE",
  });
  f.legacy({ password: "SYNTHETIC-REPORT-LEGACY" });
  const report = f.store.dispatch("report.build", { workspaceId: f.workspace.id });
  containsNone(report, [
    "SYNTHETIC-PRIVATE-NAME",
    "SYNTHETIC-PRIVATE-ACCOUNT",
    "SYNTHETIC-REPORT-SECRET",
    "SYNTHETIC-PRIVATE-NOTE",
    "SYNTHETIC-REPORT-LEGACY",
  ]);
  const data = {
    name: "HTTP evidence",
    headers: { fixture: "Opaque evidence retained" },
    arbitrary: { shape: [1, 2] },
  };
  const evidence = f.store.dispatch("records.save", {
    workspaceId: f.workspace.id,
    kind: "http",
    data,
  }).item;
  assert.deepEqual(evidence.data, data);
  assert.throws(
    () =>
      f.store.dispatch("records.save", {
        workspaceId: f.workspace.id,
        kind: "http",
        id: evidence.id,
        data,
        clearLegacyFields: true,
      }),
    { code: "INVALID_INPUT" },
  );
  assert.equal(requests, 0);
  assert.deepEqual(f.store.dispatch("assets.timeline", { workspaceId: f.workspace.id }).items, []);
});
