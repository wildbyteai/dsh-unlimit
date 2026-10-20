import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment, ENVIRONMENT_LIMITS } from "../src/core/environment.js";

const SECRET = "fake-test-secret-do-not-expose-7f39";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dsh-unlimit-environment-")));
  const environment = new LocalEnvironment(root);
  const call = (action, payload) => environment.dispatch(action, payload);
  const save = (payload) =>
    call("environment.variables.save", {
      revision: call("environment.status").revision,
      ...payload,
    });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    environment,
    call,
    save,
    privateRoot: join(root, ".environment"),
    file: join(root, ".environment", "config.json"),
  };
}
function noSecret(value) {
  assert.equal(JSON.stringify(value).includes(SECRET), false);
}
function safeError(expected) {
  return (error) => {
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.stack.includes(SECRET), false);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return error.code === expected;
  };
}

test("new environment is private, masked and never blocks ordinary chat or grants task authorization", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.call("environment.status"), {
    revision: 0,
    variables: [],
    hosts: [],
    privateKeys: [],
    onboarding: {
      state: "pending",
      configured: false,
      blocksChat: false,
      grantsAuthorization: false,
    },
  });
  const caps = f.call("environment.capabilities");
  assert.equal(caps.publicSecretResolution, false);
  assert.equal(caps.encryptedAtRest, false);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.privateRoot).mode & 0o777, 0o700);
});

test("secret values persist across instances while all public save/status/delete results stay masked", (t) => {
  const f = fixture(t);
  const saved = f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  noSecret(saved);
  assert.equal(saved.variables[0].value, undefined);
  assert.equal(saved.variables[0].masked, "••••••••");
  assert.equal(saved.variables[0].configured, true);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const reopened = new LocalEnvironment(f.root);
  assert.equal(reopened.resolve("FAKE_TOKEN"), SECRET);
  noSecret(reopened.dispatch("environment.status"));
  // At-rest protection is explicitly file permissions, not an encryption claim.
  assert.ok(fs.readFileSync(f.file, "utf8").includes(SECRET));
  const deleted = f.call("environment.variables.delete", {
    revision: saved.revision,
    name: "FAKE_TOKEN",
  });
  noSecret(deleted);
  assert.deepEqual(deleted.variables, []);
  assert.throws(() => reopened.resolve("FAKE_TOKEN"), safeError("NOT_FOUND"));
});

test("omitting an existing secret preserves it, explicit empty clears it, sensitivity cannot silently downgrade", (t) => {
  const f = fixture(t);
  f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  noSecret(f.save({ name: "FAKE_TOKEN" }));
  assert.equal(f.environment.resolve("FAKE_TOKEN"), SECRET);
  assert.throws(() => f.save({ name: "FAKE_TOKEN", secret: false }), safeError("INVALID_INPUT"));
  assert.equal(f.environment.resolve("FAKE_TOKEN"), SECRET);
  const cleared = f.save({ name: "FAKE_TOKEN", value: "" });
  noSecret(cleared);
  assert.equal(cleared.variables[0].configured, false);
  assert.equal(f.environment.resolve("FAKE_TOKEN"), "");
  assert.throws(() => f.save({ name: "MISSING", secret: true }), safeError("INVALID_INPUT"));
});

test("ordinary values have readable state and internal exports require an explicit finite selection", (t) => {
  const f = fixture(t);
  f.save({ name: "PUBLIC_MODE", secret: false, value: "synthetic" });
  f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  f.save({ name: "__proto__", secret: true, value: "synthetic-prototype-value" });
  assert.equal(
    f.call("environment.status").variables.find((row) => row.name === "PUBLIC_MODE").value,
    "synthetic",
  );
  const exported = f.environment.exportEnvironment(["FAKE_TOKEN", "__proto__", "FAKE_TOKEN"]);
  assert.deepEqual(Object.keys(exported), ["FAKE_TOKEN", "__proto__"]);
  assert.equal(exported.FAKE_TOKEN, SECRET);
  assert.equal(Object.getPrototypeOf(exported), Object.prototype);
  assert.equal(Object.hasOwn(exported, "__proto__"), true);
  assert.equal(process.env.FAKE_TOKEN, undefined);
  assert.deepEqual(f.environment.exportEnvironment([]), {});
  assert.throws(() => f.environment.exportEnvironment(), safeError("INVALID_INPUT"));
  assert.throws(() => f.environment.exportEnvironment(["UNKNOWN"]), safeError("NOT_FOUND"));
  for (const action of ["environment.resolve", "environment.exportEnvironment", SECRET])
    assert.throws(() => f.call(action, { name: "FAKE_TOKEN" }), safeError("UNKNOWN_ACTION"));
});

test("optimistic revisions prevent stale instance overwrite and a busy writer leaves existing state untouched", (t) => {
  const f = fixture(t);
  const second = new LocalEnvironment(f.root);
  const initial = second.dispatch("environment.status");
  f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  assert.throws(
    () =>
      second.dispatch("environment.variables.save", {
        revision: initial.revision,
        name: "OTHER",
        secret: false,
        value: "stale",
      }),
    safeError("CONFLICT"),
  );
  const before = fs.readFileSync(f.file);
  const lock = join(f.privateRoot, "write.lock");
  fs.writeFileSync(lock, "", { mode: 0o600 });
  assert.throws(() => f.save({ name: "FAKE_TOKEN", value: "replacement" }), safeError("BUSY"));
  assert.deepEqual(fs.readFileSync(f.file), before);
  fs.unlinkSync(lock);
  assert.equal(second.resolve("FAKE_TOKEN"), SECRET);
  assert.throws(
    () => f.call("environment.variables.delete", { name: "FAKE_TOKEN" }),
    safeError("INVALID_INPUT"),
  );
});

test("failed atomic rename preserves exact previous bytes, removes staging and never exposes secret in errors", (t) => {
  const f = fixture(t);
  f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  const before = fs.readFileSync(f.file);
  t.mock.method(fs, "renameSync", () => {
    throw new Error(SECRET);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.save({ name: "FAKE_TOKEN", value: "new-fake-secret" }),
      safeError("ENVIRONMENT_STORAGE_ERROR"),
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(fs.readdirSync(f.privateRoot), ["config.json"]);
  assert.equal(new LocalEnvironment(f.root).resolve("FAKE_TOKEN"), SECRET);
});

test("host inventory is normalized without networking and never becomes a target exception or authorization", (t) => {
  const f = fixture(t);
  const saved = f.call("environment.hosts.save", {
    revision: 0,
    items: ["operator@EXAMPLE.INVALID.", "192.0.2.7", "[2001:db8::1]", "operator@example.invalid"],
  });
  assert.deepEqual(saved.hosts, ["operator@example.invalid", "192.0.2.7", "[2001:db8::1]"]);
  assert.equal(saved.ownServers, undefined);
  assert.equal(saved.onboarding.grantsAuthorization, false);
  assert.throws(
    () =>
      f.call("environment.hosts.save", {
        revision: saved.revision,
        items: [`https://user:${SECRET}@example.invalid`],
      }),
    safeError("INVALID_INPUT"),
  );
  assert.deepEqual(f.call("environment.status").hosts, saved.hosts);
});

test("private key metadata is inspected without opening or reading its bytes; deleting metadata preserves key file", (t) => {
  const f = fixture(t);
  const path = join(f.root, "fake-key-material");
  fs.writeFileSync(path, SECRET, { mode: 0o600 });
  const open = fs.openSync;
  const reads = [];
  t.mock.method(fs, "openSync", (target, ...args) => {
    if (target === path) {
      reads.push(target);
      throw new Error("Must not open key bytes");
    }
    return open(target, ...args);
  });
  syncBuiltinESMExports();
  let saved;
  try {
    saved = f.call("environment.keys.save", { revision: 0, label: "Synthetic key path", path });
    noSecret(saved);
    assert.equal(saved.privateKeys[0].metadata.bytes, Buffer.byteLength(SECRET));
    assert.equal(saved.privateKeys[0].metadata.validation, "metadata-only");
    assert.equal(saved.privateKeys[0].metadata.available, true);
    assert.equal(
      new LocalEnvironment(f.root).dispatch("environment.status").privateKeys[0].path,
      path,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(reads, []);
  assert.equal(fs.readFileSync(f.file, "utf8").includes(SECRET), false);
  const deleted = f.call("environment.keys.delete", {
    revision: saved.revision,
    id: saved.privateKeys[0].id,
  });
  assert.deepEqual(deleted.privateKeys, []);
  assert.equal(fs.readFileSync(path, "utf8"), SECRET);
});

test("private key paths reject traversal, relative paths, directories and links, while stale metadata reads unavailable", (t) => {
  const f = fixture(t);
  const key = join(f.root, "fake-key");
  fs.writeFileSync(key, "synthetic-key", { mode: 0o600 });
  const link = join(f.root, "key-link");
  fs.symlinkSync(key, link);
  const linkedDirectory = join(f.root, "directory-link");
  fs.symlinkSync(f.root, linkedDirectory, "dir");
  for (const path of [
    "relative-key",
    join(f.root, "missing"),
    f.root,
    link,
    `${f.root}/../fake-key`,
    join(linkedDirectory, "fake-key"),
  ]) {
    assert.throws(() =>
      f.call("environment.keys.save", { revision: 0, label: "Synthetic only", path }),
    );
  }
  assert.equal(f.call("environment.status").revision, 0);
  const saved = f.call("environment.keys.save", {
    revision: 0,
    label: "Synthetic only",
    path: key,
  });
  fs.unlinkSync(key);
  const stale = f.call("environment.status").privateKeys[0];
  assert.equal(stale.metadata.available, false);
  assert.equal(stale.id, saved.privateKeys[0].id);
});

test("onboarding skip/configured state survives reopen, different data roots stay independent", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.call("environment.onboarding", { revision: 0, decision: "configured" }),
    safeError("INVALID_INPUT"),
  );
  const skipped = f.call("environment.onboarding", { revision: 0, decision: "skip" });
  assert.equal(skipped.onboarding.state, "skipped");
  assert.equal(
    new LocalEnvironment(f.root).dispatch("environment.status").onboarding.state,
    "skipped",
  );
  assert.equal(skipped.onboarding.blocksChat, false);
  assert.equal(skipped.onboarding.grantsAuthorization, false);
  const secondRoot = join(f.root, "different-installation");
  fs.mkdirSync(secondRoot);
  assert.equal(
    new LocalEnvironment(secondRoot).dispatch("environment.status").onboarding.state,
    "pending",
  );
  const saved = f.save({ name: "MODE", secret: false, value: "synthetic" });
  assert.equal(saved.onboarding.state, "configured");
  const deleted = f.call("environment.variables.delete", {
    revision: saved.revision,
    name: "MODE",
  });
  assert.equal(deleted.onboarding.state, "pending");
});

test("symbolic storage roots or files are rejected without following them or modifying their targets", (t) => {
  const f = fixture(t);
  const rootLink = join(f.root, "root-link");
  fs.symlinkSync(f.root, rootLink, "dir");
  assert.throws(() => new LocalEnvironment(rootLink), safeError("UNSAFE_PATH"));
  const otherRoot = join(f.root, "other-root");
  fs.mkdirSync(otherRoot);
  fs.symlinkSync(f.privateRoot, join(otherRoot, ".environment"), "dir");
  assert.throws(() => new LocalEnvironment(otherRoot), safeError("UNSAFE_PATH"));
  const target = join(f.root, "unrelated-synthetic-file");
  fs.writeFileSync(target, SECRET, { mode: 0o600 });
  fs.symlinkSync(target, f.file);
  assert.throws(() => f.call("environment.status"), safeError("UNSAFE_PATH"));
  assert.throws(
    () => f.call("environment.onboarding", { revision: 0, decision: "skip" }),
    safeError("UNSAFE_PATH"),
  );
  assert.equal(fs.readFileSync(target, "utf8"), SECRET);
});

test(
  "unsafe storage permissions are rejected rather than silently exposing or changing the file",
  { skip: process.platform === "win32" },
  (t) => {
    const f = fixture(t);
    f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
    fs.chmodSync(f.file, 0o644);
    assert.throws(() => f.call("environment.status"), safeError("UNSAFE_PERMISSIONS"));
    assert.throws(() => new LocalEnvironment(f.root), safeError("UNSAFE_PERMISSIONS"));
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o644);
    fs.chmodSync(f.file, 0o600);
    fs.chmodSync(f.privateRoot, 0o755);
    assert.throws(() => f.call("environment.status"), safeError("UNSAFE_PERMISSIONS"));
    fs.chmodSync(f.privateRoot, 0o700);
  },
);

test("corrupt or unexpected stored fields fail closed with generic errors and no secret diagnostics", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, `{${SECRET}`, { mode: 0o600 });
  assert.throws(() => f.call("environment.status"), safeError("ENVIRONMENT_STORAGE_INVALID"));
  fs.unlinkSync(f.file);
  f.save({ name: "FAKE_TOKEN", secret: true, value: SECRET });
  const state = JSON.parse(fs.readFileSync(f.file, "utf8"));
  state.privateKeys = [
    {
      id: "00000000-0000-0000-0000-000000000000",
      label: "Synthetic",
      path: join(f.root, "fake-key"),
      updatedAt: new Date().toISOString(),
      extra: SECRET,
    },
  ];
  fs.writeFileSync(f.file, JSON.stringify(state), { mode: 0o600 });
  assert.throws(() => f.call("environment.status"), safeError("ENVIRONMENT_STORAGE_INVALID"));
});

test("invalid fields and bounded values never mutate state or echo the submitted fake secret", (t) => {
  const f = fixture(t);
  const attempts = [
    { name: "INVALID-NAME", secret: true, value: SECRET },
    { name: "FAKE", secret: "true", value: SECRET },
    { name: "FAKE", secret: true, value: `${SECRET}\0` },
    { name: "FAKE", secret: true, value: "x".repeat(ENVIRONMENT_LIMITS.valueBytes + 1) },
    { name: "FAKE", secret: true, value: SECRET, unsupported: true },
  ];
  for (const payload of attempts) assert.throws(() => f.save(payload), safeError("INVALID_INPUT"));
  assert.equal(f.call("environment.status").revision, 0);
  assert.deepEqual(f.call("environment.status").variables, []);
});
