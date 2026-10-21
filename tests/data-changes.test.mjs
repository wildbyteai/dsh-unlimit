import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceStore } from "../src/core/store.js";
import { WorkspaceFiles } from "../src/core/files.js";
import { RECORD_KINDS } from "../src/core/validation.js";

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-unlimit-data-changes-"));
  const databasePath = join(directory, "synthetic.sqlite");
  const connections = [];
  const open = () => {
    const store = new WorkspaceStore(databasePath);
    connections.push(store);
    return store;
  };
  t.after(() => {
    for (const store of connections) if (store.db.isOpen) store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const store = open();
  const workspaceId = store.dispatch("workspaces.save", { name: "Synthetic first scope" }).item.id;
  const otherId = store.dispatch("workspaces.save", { name: "Synthetic second scope" }).item.id;
  const root = join(directory, "materials");
  const files = new WorkspaceFiles(root, store);
  const changes = (selected = workspaceId, connection = store) =>
    connection.dispatch("workspaces.changes", { workspaceId: selected });
  const call = (action, payload = {}) => files.dispatch(action, { workspaceId, ...payload });
  return { directory, databasePath, store, open, workspaceId, otherId, root, files, changes, call };
}

const emptyWorkspace = () => ({
  assets: 0,
  findings: 0,
  links: 0,
  events: 0,
  roles: 0,
  files: 0,
  records: Object.fromEntries(RECORD_KINDS.map((kind) => [kind, 0])),
});

test("change snapshots resolve the active workspace and reject explicit invalid scopes", (t) => {
  const { store, workspaceId, otherId, changes } = fixture(t);
  assert.deepEqual(store.dispatch("workspaces.changes"), {
    workspaceId: null,
    global: { workspaces: 2, knowledge: 0 },
    workspace: emptyWorkspace(),
  });
  store.dispatch("workspaces.activate", { id: workspaceId });
  assert.deepEqual(store.dispatch("workspaces.changes"), changes());
  assert.equal(changes(otherId).workspaceId, otherId);
  for (const workspaceId of [null, "", " ", 42])
    assert.throws(() => store.dispatch("workspaces.changes", { workspaceId }), {
      code: "INVALID_INPUT",
    });
  assert.throws(() => changes("absent-synthetic-workspace"), { code: "NOT_FOUND" });
  assert.deepEqual(changes().workspace, emptyWorkspace());
});

test("entry insert, update and delete advance only their global, workspace and record kind versions", (t) => {
  const { store, workspaceId, otherId, changes } = fixture(t);
  const knowledge = store.dispatch("knowledge.save", {
    title: "Synthetic note",
    content: "Evidence",
  }).item;
  store.dispatch("knowledge.save", {
    id: knowledge.id,
    title: "Synthetic note",
    content: "Revised",
  });
  store.dispatch("knowledge.delete", { id: knowledge.id });
  assert.deepEqual(changes().global, { workspaces: 2, knowledge: 3 });
  store.dispatch("workspaces.save", { id: workspaceId, name: "Renamed synthetic scope" });
  assert.equal(changes(otherId).global.workspaces, 3);

  for (const domain of ["assets", "findings", "links", "events", "roles"]) {
    const item = store.save(domain, {}, { synthetic: true }, workspaceId);
    assert.equal(changes().workspace[domain], 1, `${domain} insert`);
    store.save(domain, { id: item.id }, { synthetic: "updated" }, workspaceId);
    assert.equal(changes().workspace[domain], 2, `${domain} update`);
    store.remove(domain, item.id, workspaceId);
    assert.equal(changes().workspace[domain], 3, `${domain} delete`);
  }
  for (const kind of RECORD_KINDS) {
    const item = store.save("records", {}, { synthetic: true }, workspaceId, kind);
    assert.equal(changes().workspace.records[kind], 1, `${kind} insert`);
    store.save("records", { id: item.id }, { synthetic: "updated" }, workspaceId, kind);
    store.remove("records", item.id, workspaceId, kind);
    assert.equal(changes().workspace.records[kind], 3, `${kind} update/delete`);
  }
  assert.deepEqual(changes(otherId).workspace, emptyWorkspace());
  assert.equal(changes().workspace.files, 0);
  store.dispatch("roles.reset", { workspaceId });
  assert.equal(changes().workspace.roles, 3, "deleting no rows does not advance the version");
});

test("SQLite triggers cover direct writes, moved scopes and kinds, and roll back with their entries", (t) => {
  const { store, workspaceId, otherId, changes } = fixture(t);
  const item = store.save("records", {}, { synthetic: true }, workspaceId, "access");
  store.db
    .prepare("UPDATE entries SET workspace = ?, kind = ? WHERE id = ?")
    .run(otherId, "tunnel", item.id);
  assert.equal(changes().workspace.records.access, 2);
  assert.equal(changes(otherId).workspace.records.tunnel, 1);
  store.db.prepare("UPDATE entries SET domain = ?, kind = '' WHERE id = ?").run("assets", item.id);
  assert.equal(changes(otherId).workspace.records.tunnel, 2);
  assert.equal(changes(otherId).workspace.assets, 1);
  const before = changes(otherId);
  store.db.exec("BEGIN");
  store.db.prepare("DELETE FROM entries WHERE id = ?").run(item.id);
  store.save("findings", {}, { synthetic: true }, otherId);
  store.touchFiles(otherId);
  assert.equal(changes(otherId).workspace.assets, 2);
  store.db.exec("ROLLBACK");
  assert.deepEqual(changes(otherId), before);
  assert.equal(store.get("assets", item.id, otherId).id, item.id);
});

test("independent connections see committed versions, preserve isolation and survive reopen", (t) => {
  const { store, open, workspaceId, otherId, changes } = fixture(t);
  const second = open();
  store.db.exec("BEGIN");
  store.save("assets", {}, { synthetic: "pending" }, workspaceId);
  assert.equal(changes(workspaceId, second).workspace.assets, 0);
  store.db.exec("COMMIT");
  assert.equal(changes(workspaceId, second).workspace.assets, 1);
  second.save("assets", {}, { synthetic: "second writer" }, workspaceId);
  second.touchFiles(workspaceId);
  assert.equal(changes().workspace.assets, 2);
  assert.equal(changes().workspace.files, 1);
  assert.deepEqual(changes(otherId).workspace, emptyWorkspace());
  const before = changes();
  store.close();
  second.close();
  assert.deepEqual(changes(workspaceId, open()), before);
});

test("opening an old entries schema adds tracking without backfilling existing rows", (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "dsh-unlimit-old-changes-"));
  const path = join(directory, "old.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE entries (
    id TEXT PRIMARY KEY, domain TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '', value TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  old
    .prepare("INSERT INTO entries VALUES (?, 'workspaces', '', '', ?, 'old', 'old')")
    .run("synthetic-old", JSON.stringify({ id: "synthetic-old", name: "Old synthetic workspace" }));
  old.close();
  const store = new WorkspaceStore(path);
  t.after(() => store.close());
  const payload = { workspaceId: "synthetic-old" };
  assert.deepEqual(store.dispatch("workspaces.changes", payload), {
    ...payload,
    global: { workspaces: 0, knowledge: 0 },
    workspace: emptyWorkspace(),
  });
  store.dispatch("workspaces.save", { id: "synthetic-old", name: "Updated old workspace" });
  assert.equal(store.dispatch("workspaces.changes", payload).global.workspaces, 1);
});

test("material writes, batch imports, deletes and restores advance files once per operation", (t) => {
  const { call, changes, otherId, open, workspaceId } = fixture(t);
  call("files.write", { path: "one.txt", content: "Synthetic original" });
  assert.equal(changes().workspace.files, 1);
  const replaced = call("files.write", { path: "one.txt", content: "Synthetic replacement" }).item;
  assert.equal(changes().workspace.files, 2);
  call("files.import", {
    items: [
      { path: "two.txt", content: "Two" },
      { path: "three.txt", content: "Three" },
    ],
  });
  assert.equal(changes().workspace.files, 3);
  call("files.delete", { path: "one.txt" });
  assert.equal(changes().workspace.files, 4);
  call("files.restore", { backupId: replaced.backupId });
  assert.equal(changes().workspace.files, 5);
  call("files.list");
  call("files.backups");
  assert.equal(
    call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
    "Synthetic original",
  );
  assert.equal(changes().workspace.files, 5);
  assert.deepEqual(changes(otherId).workspace, emptyWorkspace());
  assert.equal(changes(workspaceId, open()).workspace.files, 5);
});

test("validation failures and fully restored filesystem operations do not advance files", (t) => {
  const { call, changes, files } = fixture(t);
  call("files.write", { path: "one.txt", content: "Synthetic original" });
  const before = changes();
  assert.throws(() => call("files.write", { path: "../escape", content: "Rejected" }), {
    code: "INVALID_PATH",
  });
  assert.throws(() => call("files.delete", { path: "absent.txt" }), { code: "NOT_FOUND" });
  const saveManifest = files.saveManifest;
  files.saveManifest = () => {
    throw new Error("Synthetic manifest failure");
  };
  try {
    for (const [action, payload] of [
      ["files.write", { path: "one.txt", content: "Must roll back" }],
      [
        "files.import",
        {
          items: [
            { path: "one.txt", content: "Must roll back" },
            { path: "new.txt", content: "Must disappear" },
          ],
        },
      ],
      ["files.delete", { path: "one.txt" }],
    ]) {
      assert.throws(() => call(action, payload), /Synthetic manifest failure/);
      assert.deepEqual(changes(), before);
      assert.equal(
        call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
        "Synthetic original",
      );
      assert.deepEqual(
        call("files.list").items.map((item) => item.path),
        ["one.txt"],
      );
    }
  } finally {
    files.saveManifest = saveManifest;
  }
});

test("a file counter failure reports committed material state and preserves recoverable backups", (t) => {
  const { call, store, changes } = fixture(t);
  call("files.write", { path: "one.txt", content: "Synthetic original" });
  const touch = store.touchFiles;
  store.touchFiles = () => {
    throw new Error("Synthetic SQLite failure");
  };
  try {
    let failure;
    assert.throws(
      () => call("files.write", { path: "one.txt", content: "Committed despite tracking failure" }),
      (error) => {
        failure = error;
        return error.code === "RECOVERY_REQUIRED";
      },
    );
    assert.equal(failure.partial.filesChanged, true);
    assert.equal(failure.partial.changeTrackingFailed, true);
    assert.equal(changes().workspace.files, 1);
    assert.equal(
      call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
      "Committed despite tracking failure",
    );
    assert.equal(call("files.backups").items[0].backupId, failure.partial.backups[0].backupId);
    assert.throws(
      () => call("files.delete", { path: "one.txt" }),
      (error) =>
        error.code === "RECOVERY_REQUIRED" &&
        error.partial.filesChanged &&
        error.partial.changeTrackingFailed,
    );
    assert.deepEqual(call("files.list").items, []);
    assert.equal(changes().workspace.files, 1);
  } finally {
    store.touchFiles = touch;
  }
});

test("partial filesystem rollback advances files and discloses counter failure if both systems fail", (t) => {
  const { call, store, changes, root, workspaceId } = fixture(t);
  call("files.write", { path: "one.txt", content: "Synthetic original" });
  const rename = fs.renameSync;
  const touch = store.touchFiles;
  fs.renameSync = (from, to) => {
    if (
      (from.includes(".stage-") && to.endsWith("/two.txt")) ||
      (from.endsWith("/data") && to.endsWith("/one.txt"))
    )
      throw new Error("Synthetic forward and rollback failure");
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    for (const trackingFailed of [false, true]) {
      if (trackingFailed)
        store.touchFiles = () => {
          throw new Error("Synthetic tracking failure");
        };
      let failure;
      assert.throws(
        () =>
          call("files.import", {
            items: [
              { path: "one.txt", content: "Synthetic replacement" },
              { path: "two.txt", content: "Synthetic second file" },
            ],
          }),
        (error) => {
          failure = error;
          return error.code === "RECOVERY_REQUIRED";
        },
      );
      assert.equal(failure.partial.filesChanged, true);
      assert.equal(failure.partial.changeTrackingFailed, trackingFailed);
      assert.equal(changes().workspace.files, 2);
      assert.ok(fs.existsSync(join(root, failure.partial.stagingPath)));
      if (!trackingFailed)
        fs.writeFileSync(
          join(root, workspaceId, "one.txt"),
          "Synthetic original for second failure",
        );
    }
  } finally {
    store.touchFiles = touch;
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
});
