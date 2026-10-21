import test from "node:test";
import assert from "node:assert/strict";
import { DATA_RECORD_KINDS, DataUpdates } from "../web/data-updates.js";
import { RECORD_KINDS } from "../src/core/validation.js";

const domains = ["assets", "findings", "links", "events", "roles", "files"];
const progressKinds = ["stage", "score-point", "score-hit"];
const evidenceKinds = DATA_RECORD_KINDS.filter((kind) => !progressKinds.includes(kind));
const context = (page, kind, workspaceId = "one") => ({ workspaceId, page, kind });
function snapshot(workspaceId = "one", revision = 0) {
  return {
    workspaceId,
    global: { workspaces: revision, knowledge: revision },
    workspace: {
      ...Object.fromEntries(domains.map((domain) => [domain, revision])),
      records: Object.fromEntries(DATA_RECORD_KINDS.map((kind) => [kind, revision])),
    },
  };
}
function increment(raw, field) {
  const parts = field.split(".");
  let target = raw;
  for (const key of parts.slice(0, -1)) target = target[key];
  target[parts.at(-1)]++;
  return raw;
}

test("browser record categories match the actual store contract", () => {
  assert.deepEqual(DATA_RECORD_KINDS, RECORD_KINDS);
  assert.ok(Object.isFrozen(DATA_RECORD_KINDS));
});

test("first observation is a baseline and returns a detached deeply frozen response", () => {
  const updates = new DataUpdates();
  const raw = snapshot("one", 7);
  const receipt = updates.observe(raw);
  assert.deepEqual(receipt, raw);
  assert.notEqual(receipt, raw);
  assert.notEqual(receipt.global, raw.global);
  assert.notEqual(receipt.workspace, raw.workspace);
  assert.notEqual(receipt.workspace.records, raw.workspace.records);
  for (const value of [receipt, receipt.global, receipt.workspace, receipt.workspace.records])
    assert.ok(Object.isFrozen(value));
  assert.throws(() => (receipt.workspace.records.credential = 90), TypeError);
  raw.global.workspaces = 90;
  raw.workspace.assets = 90;
  raw.workspace.records.credential = 90;
  assert.equal(receipt.global.workspaces, 7);
  assert.equal(receipt.workspace.assets, 7);
  assert.equal(receipt.workspace.records.credential, 7);
  for (const page of ["overview", "workspaces", "knowledge", "assets", "evidence", "progress"])
    assert.equal(updates.hasUnread(context(page)), false, page);
});

test("every domain maps to the pages and visible category dependencies actually read", () => {
  const scoring = [
    "workspace.assets",
    "workspace.records.score-point",
    "workspace.records.score-hit",
  ];
  const dependencies = new Map([
    ["workspaces", ["global.workspaces"]],
    ["knowledge", ["global.knowledge"]],
    [
      "overview",
      [
        "global.workspaces",
        "workspace.assets",
        "workspace.findings",
        "workspace.records.stage",
        ...scoring,
      ],
    ],
    ["assets", ["workspace.assets"]],
    ["findings", ["workspace.findings", "workspace.assets"]],
    ["files", ["workspace.files"]],
    ["graph", ["workspace.assets", "workspace.links", "workspace.events"]],
    ["roles", ["workspace.roles"]],
    [
      "reports",
      [
        "global.workspaces",
        "workspace.assets",
        "workspace.findings",
        "workspace.links",
        "workspace.events",
        ...DATA_RECORD_KINDS.map((kind) => `workspace.records.${kind}`),
      ],
    ],
    ...evidenceKinds.map((kind) => [
      `evidence:${kind}`,
      [`workspace.records.${kind}`, ...(kind === "credential" ? ["workspace.assets"] : [])],
    ]),
    ...progressKinds.map((kind) => [`progress:${kind}`, [...scoring, "workspace.records.stage"]]),
  ]);
  const fields = [
    "global.workspaces",
    "global.knowledge",
    ...domains.map((domain) => `workspace.${domain}`),
    ...DATA_RECORD_KINDS.map((kind) => `workspace.records.${kind}`),
  ];
  for (const field of fields) {
    const updates = new DataUpdates();
    updates.observe(snapshot());
    const captured = updates.observe(increment(snapshot(), field));
    for (const [key, dependenciesForPage] of dependencies) {
      const [page, kind] = key.split(":");
      const scope = context(page, kind);
      assert.equal(
        updates.hasUnread(scope),
        dependenciesForPage.includes(field),
        `${field} -> ${key}`,
      );
      assert.equal(updates.markRead(scope, captured), true);
      assert.equal(updates.hasUnread(scope), false, `${key} cleared its captured visible data`);
    }
  }
});

test("evidence navigation aggregates categories but reading one leaves hidden categories unread", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const raw = increment(
    increment(snapshot(), "workspace.records.credential"),
    "workspace.records.http",
  );
  const captured = updates.observe(raw);
  assert.equal(updates.hasUnread(context("evidence")), true);
  updates.markRead(context("evidence", "credential"), captured);
  assert.equal(updates.hasUnread(context("evidence", "credential")), false);
  assert.equal(updates.hasUnread(context("evidence", "http")), true);
  assert.equal(updates.hasUnread(context("evidence")), true);
  updates.markRead(context("evidence", "http"), captured);
  assert.equal(updates.hasUnread(context("evidence")), false);
});

test("progress receipts stay independent even for shared scoring summaries", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const captured = updates.observe(increment(snapshot(), "workspace.records.score-hit"));
  for (const kind of progressKinds)
    assert.equal(updates.hasUnread(context("progress", kind)), true);
  updates.markRead(context("progress", "stage"), captured);
  assert.equal(updates.hasUnread(context("progress", "stage")), false);
  assert.equal(updates.hasUnread(context("progress", "score-point")), true);
  assert.equal(updates.hasUnread(context("progress")), true);
  assert.equal(updates.hasUnread(context("evidence")), false);
});

test("page receipts are independent, scoped per workspace and shared for global pages", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot("one"));
  updates.observe(snapshot("two"));
  const one = increment(snapshot("one"), "workspace.assets");
  updates.observe(one);
  assert.equal(updates.hasUnread(context("assets", undefined, "two")), false);
  const two = increment(snapshot("two"), "workspace.assets");
  updates.observe(two);
  updates.markRead(context("assets"), one);
  assert.equal(updates.hasUnread(context("assets")), false);
  assert.equal(updates.hasUnread(context("overview")), true);
  assert.equal(updates.hasUnread(context("assets", undefined, "two")), true);
  const global = increment(increment(two, "global.knowledge"), "global.workspaces");
  const captured = updates.observe(global);
  for (const page of ["knowledge", "workspaces"])
    for (const workspaceId of ["one", "two", null])
      assert.equal(updates.hasUnread(context(page, undefined, workspaceId)), true);
  updates.markRead(context("knowledge", undefined, "one"), captured);
  updates.markRead(context("workspaces", undefined, null), captured);
  for (const page of ["knowledge", "workspaces"])
    for (const workspaceId of ["one", "two", null])
      assert.equal(updates.hasUnread(context(page, undefined, workspaceId)), false);
});

test("null workspace supports baseline, global pages and overview without an active project", () => {
  const updates = new DataUpdates();
  const initial = updates.observe(snapshot(null));
  updates.markRead({ page: "overview" }, initial);
  const captured = updates.observe(increment(snapshot(null), "global.workspaces"));
  assert.equal(updates.hasUnread({ page: "overview" }), true);
  assert.equal(updates.hasUnread({ page: "workspaces" }), true);
  updates.markRead({ page: "overview" }, captured);
  assert.equal(updates.hasUnread({ page: "overview" }), false);
  assert.equal(updates.hasUnread({ page: "workspaces" }), true);
});

test("capture before page read preserves changes observed while reading", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const beforeRead = updates.observe(snapshot("one", 1));
  updates.observe(snapshot("one", 2));
  updates.markRead(context("assets"), beforeRead);
  updates.markRead(context("knowledge"), beforeRead);
  assert.equal(updates.hasUnread(context("assets")), true);
  assert.equal(updates.hasUnread(context("knowledge")), true);
  const afterRead = updates.observe(snapshot("one", 2));
  updates.markRead(context("assets"), afterRead);
  updates.markRead(context("knowledge"), afterRead);
  assert.equal(updates.hasUnread(context("assets")), false);
  assert.equal(updates.hasUnread(context("knowledge")), false);
});

test("out-of-order observations return that response but never regress latest or seen versions", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const newer = updates.observe(snapshot("one", 4));
  const older = updates.observe(snapshot("one", 2));
  assert.equal(older.workspace.assets, 2);
  assert.equal(older.global.knowledge, 2);
  updates.markRead(context("assets"), older);
  updates.markRead(context("knowledge"), older);
  assert.equal(updates.hasUnread(context("assets")), true);
  assert.equal(updates.hasUnread(context("knowledge")), true);
  for (const page of ["assets", "knowledge"]) {
    updates.markRead(context(page), newer);
    updates.markRead(context(page), older);
    assert.equal(updates.hasUnread(context(page)), false);
  }
  updates.observe(snapshot("one", 3));
  assert.equal(updates.hasUnread(context("assets")), false);
  assert.equal(updates.hasUnread(context("knowledge")), false);
});

test("non-data pages return false, including object prototype names", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  updates.observe(snapshot("one", 1));
  for (const page of [
    undefined,
    "control",
    "sessions",
    "environment",
    "skills",
    "__proto__",
    "constructor",
    "toString",
  ])
    for (const method of ["hasUnread", "markRead"])
      assert.equal(updates[method](context(page)), false, `${method}: ${page}`);
});

test("missing/invalid categories reject read receipts so hidden tabs cannot be cleared", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const captured = updates.observe(snapshot("one", 1));
  for (const page of ["evidence", "progress"])
    for (const kind of [undefined, null, "unknown", page === "evidence" ? "stage" : "credential"]) {
      assert.throws(() => updates.markRead(context(page, kind), captured), TypeError);
      if (kind !== undefined)
        assert.throws(() => updates.hasUnread(context(page, kind)), TypeError);
    }
  assert.equal(updates.hasUnread(context("evidence")), true);
  assert.equal(updates.hasUnread(context("progress")), true);
});

test("invalid snapshots and wrong-workspace receipts fail without marking anything read", () => {
  const updates = new DataUpdates();
  updates.observe(snapshot());
  const captured = updates.observe(snapshot("one", 1));
  for (const invalid of [
    null,
    {},
    { ...snapshot(), workspaceId: 1 },
    ...[-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", undefined].map((revision) => {
      const raw = snapshot();
      raw.workspace.records.credential = revision;
      return raw;
    }),
  ]) {
    assert.throws(() => updates.observe(invalid), TypeError);
    assert.throws(() => updates.markRead(context("assets"), invalid), TypeError);
  }
  assert.throws(() => updates.markRead(context("assets"), snapshot("two", 1)), /another workspace/);
  assert.equal(updates.hasUnread(context("assets")), true);
  assert.throws(() => updates.hasUnread(context("assets", undefined, 1)), TypeError);
  updates.markRead(context("assets"), captured);
  assert.equal(updates.hasUnread(context("assets")), false);
});

test("unobserved scopes have no update and a new panel has no persisted read state", () => {
  const updates = new DataUpdates();
  assert.equal(updates.hasUnread(context("assets")), false);
  assert.equal(updates.markRead(context("assets"), snapshot()), false);
  updates.observe(snapshot());
  assert.equal(updates.hasUnread(context("assets", undefined, "unobserved")), false);
  updates.observe(snapshot("one", 1));
  assert.equal(updates.hasUnread(context("assets")), true);
  const nextPanel = new DataUpdates();
  nextPanel.observe(snapshot("one", 1));
  assert.equal(nextPanel.hasUnread(context("assets")), false);
});
