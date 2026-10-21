import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createGzip, gzipSync } from "node:zlib";
import { CountryDatabase } from "../src/core/country-database.js";

const SAMPLE =
  [
    "ip_start,ip_end,country",
    '"1.0.0.0","1.0.0.3","CN"',
    "1.0.0.5,1.0.0.5,HK",
    "1.0.0.6,1.0.0.6,MO",
    "1.0.0.7,1.0.0.8,US",
    "1.0.0.9,1.0.0.9,XK",
    "1.0.0.10,1.0.0.10,ZZ",
    "1.0.0.11,1.0.0.11,XX",
    '1.0.0.12,1.0.0.12,""',
    "240e::,240e::ffff,CN",
    "2606:4700::,2606:4700::ffff,US",
  ].join("\r\n") + "\r\n";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dsh-unlimit-country-")));
  const instances = [];
  const open = () => {
    const instance = new CountryDatabase(root);
    instances.push(instance);
    return instance;
  };
  t.after(() => {
    for (const instance of instances) instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const db = open();
  const load = (content = SAMPLE, options = {}) =>
    db.import({
      contentBase64: Buffer.from(content).toString("base64"),
      filename: "synthetic-only.csv",
      release: "2026-10",
      revision: db.status().revision,
      ...options,
    });
  return { root, db, open, load, file: join(root, "region.sqlite") };
}
function safeError(code, privateText = "") {
  return (error) => {
    assert.equal(error.code, code);
    if (privateText) {
      assert.equal(error.message.includes(privateText), false);
      assert.equal(error.stack.includes(privateText), false);
      assert.equal(JSON.stringify(error).includes(privateText), false);
    }
    assert.equal(Object.hasOwn(error, "cause"), false);
    return true;
  };
}
function country(db, address, expected) {
  assert.deepEqual(db.lookup(address), { country: expected, kind: "country" });
}

test("absent offline database reports no provider and performs no file or network acquisition", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.db.status(), {
    available: false,
    revision: "empty",
    release: null,
    source: null,
    records: 0,
    ipv4: 0,
    ipv6: 0,
    sha256: null,
    attribution: null,
  });
  assert.deepEqual(f.db.lookup("1.0.0.1"), {
    country: null,
    kind: "unknown",
    reason: "database-unavailable",
  });
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("synthetic CSV persists attribution, source-byte digest, revision and indexed IPv4/IPv6 boundaries", (t) => {
  const f = fixture(t);
  const workspace = join(f.root, "workspace.sqlite");
  fs.writeFileSync(workspace, "untouched synthetic workspace sentinel");
  const before = fs.readFileSync(workspace);
  const saved = f.load();
  assert.equal(saved.available, true);
  assert.equal(saved.source, "db-ip-lite");
  assert.equal(saved.records, 10);
  assert.equal(saved.ipv4, 8);
  assert.equal(saved.ipv6, 2);
  assert.equal(saved.sha256, digest(Buffer.from(SAMPLE)));
  assert.equal(saved.revision, digest(JSON.stringify([saved.sha256, "2026-10"])));
  assert.deepEqual(saved.attribution, {
    name: "DB-IP",
    url: "https://db-ip.com",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  });
  for (const address of ["1.0.0.0", "1.0.0.1", "1.0.0.3"]) country(f.db, address, "CN");
  country(f.db, "1.0.0.5", "HK");
  country(f.db, "1.0.0.6", "MO");
  for (const address of ["1.0.0.7", "1.0.0.8"]) country(f.db, address, "US");
  country(f.db, "1.0.0.9", "XK");
  for (const address of ["1.0.0.4", "1.0.0.13", "2.0.0.0"]) {
    assert.deepEqual(f.db.lookup(address), {
      country: null,
      kind: "unknown",
      reason: "not-listed",
    });
  }
  for (const address of ["1.0.0.10", "1.0.0.11", "1.0.0.12"]) {
    assert.deepEqual(f.db.lookup(address), {
      country: null,
      kind: "unknown",
      reason: "country-unknown",
    });
  }
  country(f.db, "240E:0:0:0:0:0:0:0", "CN");
  country(f.db, "240e::ffff", "CN");
  country(f.db, "2606:4700::", "US");
  country(f.db, "2606:4700::ffff", "US");
  assert.equal(f.db.lookup("240e::1:0").reason, "not-listed");
  assert.deepEqual(fs.readFileSync(workspace), before);
  if (process.platform !== "win32") assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const reader = new DatabaseSync(f.file, { readOnly: true });
  try {
    const plan = reader
      .prepare(
        "EXPLAIN QUERY PLAN SELECT last, country FROM ranges WHERE family = ? AND first <= ? ORDER BY first DESC LIMIT 1",
      )
      .all(4, "01000001");
    assert.ok(plan.some((row) => /SEARCH ranges USING PRIMARY KEY/.test(row.detail)));
  } finally {
    reader.close();
  }
  const reopened = f.open();
  assert.deepEqual(reopened.status(), saved);
  country(reopened, "1.0.0.1", "CN");
  saved.attribution.name = "mutated caller data";
  assert.equal(reopened.status().attribution.name, "DB-IP");
});

test("IPv4-mapped IPv6 uses IPv4 country and special semantics, including hexadecimal and dotted tails", (t) => {
  const f = fixture(t);
  f.load();
  for (const address of ["::ffff:1.0.0.1", "::FFFF:100:1", "0:0:0:0:0:ffff:0100:0001"]) {
    country(f.db, address, "CN");
  }
  for (const address of ["::ffff:1.0.0.5", "::ffff:100:5"]) country(f.db, address, "HK");
  for (const address of ["::ffff:127.0.0.1", "::ffff:a00:1", "::ffff:192.0.2.1"]) {
    assert.equal(f.db.lookup(address).kind, "special");
  }
  for (const address of [
    "1.0.0.1:80",
    "[240e::1]",
    "240e::1%eth0",
    "https://1.0.0.1",
    " 1.0.0.1",
    "01.0.0.1",
    "1.0.0.256",
    null,
  ]) {
    assert.deepEqual(f.db.lookup(address), {
      country: null,
      kind: "unknown",
      reason: "invalid-address",
    });
  }
});

test("IPv6 ordered keys preserve compressed middle words, dotted tails and adjacent range gaps", (t) => {
  const f = fixture(t);
  f.load(
    [
      "2001:4860:1:2::,2001:4860:1:2:ffff:ffff:ffff:ffff,CN",
      "2001:4860:1:3::,2001:4860:1:3::,HK",
      "2001:4860:2::1,2001:4860:2::1,US",
    ].join("\n"),
  );
  for (const address of [
    "2001:4860:1:2::",
    "2001:4860:1:2::abcd:1.0.0.1",
    "2001:4860:1:2:0:0:1:1",
    "2001:4860:1:2:ffff:ffff:ffff:ffff",
  ]) {
    country(f.db, address, "CN");
  }
  country(f.db, "2001:4860:1:3::", "HK");
  country(f.db, "2001:4860:2::1", "US");
  for (const address of [
    "2001:4860:1:1:ffff:ffff:ffff:ffff",
    "2001:4860:1:3::1",
    "2001:4860:2::2",
  ]) {
    assert.equal(f.db.lookup(address).reason, "not-listed");
  }
});

test("special-purpose addresses take precedence over CSV country rows even without a database", (t) => {
  const f = fixture(t);
  const addresses = [
    "0.0.0.0",
    "0.255.255.255",
    "10.0.0.0",
    "10.255.255.255",
    "100.64.0.0",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.0.1",
    "172.16.0.0",
    "172.31.255.255",
    "192.168.255.255",
    "192.0.0.9",
    "192.0.2.1",
    "198.18.0.0",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.0",
    "239.255.255.255",
    "240.0.0.0",
    "255.255.255.255",
    "::",
    "::1",
    "::8.8.8.8",
    "64:ff9b::808:808",
    "fc00::1",
    "fdff::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "2001:db8::1",
    "2001:2::1",
    "2002:100:1::1",
    "3fff::1",
  ];
  for (const address of addresses) assert.equal(f.db.lookup(address).kind, "special", address);
  f.load("0.0.0.0,255.255.255.255,US\n::,ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff,US\n");
  for (const address of addresses) {
    assert.deepEqual(
      f.db.lookup(address),
      { country: null, kind: "special", reason: "special-address" },
      address,
    );
  }
  for (const address of [
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.17.255.255",
    "198.20.0.0",
  ]) {
    country(f.db, address, "US");
  }
});

test("unknown headers, invalid country/IP/ranges and malformed CSV never replace a valid database", (t) => {
  const f = fixture(t);
  const saved = f.load();
  const originalBytes = fs.readFileSync(f.file);
  const invalid = [
    "",
    "ip_start,ip_end,country\n",
    "start,end,country\n1.0.0.0,1.0.0.1,CN\n",
    "1.0.0.0,1.0.0.1,CN,extra\n",
    "1.0.0.0,1.0.0.1\n",
    "1.0.0.0,1.0.0.1,AA\n",
    "1.0.0.0,1.0.0.1,EU\n",
    "1.0.0.0,1.0.0.1,cn\n",
    "1.0.0.2,1.0.0.1,CN\n",
    "1.0.0.0,240e::1,CN\n",
    "::ffff:1.0.0.1,1.0.0.2,CN\n",
    "240e::1%eth0,240e::2,CN\n",
    "[240e::1],[240e::2],CN\n",
    "1.0.0.0:80,1.0.0.1:80,CN\n",
    "1.0.0.0,1.0.0.1,CN\n1.0.0.0,1.0.0.1,US\n",
    "1.0.0.0,1.0.0.3,CN\n1.0.0.3,1.0.0.5,US\n",
    "1.0.0.5,1.0.0.6,CN\n1.0.0.0,1.0.0.2,US\n",
    "240e::,240e::1,CN\n1.0.0.0,1.0.0.1,US\n",
    "1.0.0.0,1.0.0.1,CN\n\n",
    '"1.0.0.0,1.0.0.1,CN\n',
    '1.0.0.0,1.0.0.1,"CN"trailing\n',
    '1.0.0.0,1.0.0.1,C"N\n',
    "1.0.0.0,1.0.0.1,CN\r",
    '"1.0.0.0\r\n",1.0.0.1,CN\r\n',
    "1.0.0.0,1.0.0.1," + "A".repeat(65),
  ];
  for (const content of invalid) {
    assert.throws(() => f.load(content), safeError("INVALID_INPUT"));
    assert.deepEqual(f.db.status(), saved);
    assert.deepEqual(fs.readFileSync(f.file), originalBytes);
    country(f.db, "1.0.0.1", "CN");
    assert.deepEqual(fs.readdirSync(f.root), ["region.sqlite"]);
  }
});

test("strict base64, UTF-8, input metadata and filename recognition use fixed safe errors", (t) => {
  const f = fixture(t);
  const saved = f.load();
  const invalid = [
    { contentBase64: "AQ" },
    { contentBase64: "AR==" },
    { contentBase64: "AQ==\n" },
    { contentBase64: "=Q==" },
    { contentBase64: "A=== " },
    { contentBase64: Buffer.from([0xc3, 0x28]).toString("base64") },
    { release: "2026-00" },
    { release: "2026-13" },
    { release: "2026-1" },
    { release: null },
    { filename: "../../private-synthetic-value.csv" },
    { filename: "C:\\private-synthetic-value.csv" },
    { filename: "private-synthetic-value.csv\0" },
    { filename: "private-synthetic-value.zip" },
    {
      filename: "private-synthetic-value.csv.gz",
      contentBase64: Buffer.from(SAMPLE).toString("base64"),
    },
    { source: "other-provider" },
    { revision: undefined },
  ];
  for (const options of invalid) {
    assert.throws(
      () => f.load(SAMPLE, options),
      safeError("INVALID_INPUT", "private-synthetic-value"),
    );
    assert.deepEqual(f.db.status(), saved);
  }
});

test("gzip import hashes expanded original bytes and malformed/truncated gzip preserves the old revision", (t) => {
  const f = fixture(t);
  const zipped = gzipSync(Buffer.from(SAMPLE));
  const saved = f.load(zipped, { filename: "synthetic-only.CSV.GZ" });
  assert.equal(saved.sha256, digest(Buffer.from(SAMPLE)));
  country(f.db, "::ffff:1.0.0.1", "CN");
  for (const content of [zipped.subarray(0, zipped.length - 4), Buffer.from("invalid gzip")]) {
    assert.throws(
      () => f.load(content, { filename: "synthetic-only.csv.gz" }),
      safeError("INVALID_INPUT"),
    );
    assert.deepEqual(f.db.status(), saved);
  }
});

test("import revisions reject stale instances and bind release changes to fresh confirmation", (t) => {
  const f = fixture(t);
  const other = f.open();
  const initial = other.status();
  const saved = f.load();
  assert.throws(
    () =>
      other.import({
        contentBase64: Buffer.from("2.0.0.0,2.0.0.1,US").toString("base64"),
        filename: "synthetic.csv",
        release: "2026-10",
        revision: initial.revision,
      }),
    safeError("CONFLICT"),
  );
  assert.deepEqual(other.status(), saved);
  const changedRelease = f.load(SAMPLE, { release: "2026-11" });
  assert.equal(changedRelease.sha256, saved.sha256);
  assert.notEqual(changedRelease.revision, saved.revision);
  assert.throws(() => f.load(SAMPLE, { revision: saved.revision }), safeError("CONFLICT"));
  assert.deepEqual(other.status(), changedRelease);
  country(other, "1.0.0.1", "CN");
});

test("storage rejects link roots, linked database files, sidecars, hard links and abnormal SQLite", (t) => {
  const f = fixture(t);
  const privateFile = join(f.root, "private-synthetic-value");
  fs.writeFileSync(privateFile, "private synthetic sentinel");
  const linkRoot = join(f.root, "linked-root");
  fs.symlinkSync(f.root, linkRoot, "dir");
  assert.throws(() => new CountryDatabase(linkRoot), safeError("UNSAFE_PATH", f.root));
  fs.unlinkSync(linkRoot);
  fs.symlinkSync(privateFile, f.file);
  assert.throws(() => new CountryDatabase(f.root), safeError("UNSAFE_PATH", f.root));
  assert.throws(() => f.db.status(), safeError("UNSAFE_PATH", f.root));
  fs.unlinkSync(f.file);
  fs.linkSync(privateFile, f.file);
  assert.throws(() => new CountryDatabase(f.root), safeError("UNSAFE_PATH", f.root));
  fs.unlinkSync(f.file);
  fs.writeFileSync(f.file, "not a database with private-synthetic-value");
  assert.throws(
    () => new CountryDatabase(f.root),
    safeError("REGION_DATABASE_INVALID", "private-synthetic-value"),
  );
  fs.unlinkSync(f.file);
  const arbitrary = new DatabaseSync(f.file);
  arbitrary.exec("CREATE TABLE private_synthetic_value(secret TEXT)");
  arbitrary.close();
  assert.throws(() => new CountryDatabase(f.root), safeError("REGION_DATABASE_INVALID", f.root));
  fs.unlinkSync(f.file);
  f.load();
  const sidecar = `${f.file}-wal`;
  fs.symlinkSync(privateFile, sidecar);
  assert.throws(() => f.db.status(), safeError("UNSAFE_PATH", f.root));
  fs.unlinkSync(sidecar);
  country(f.db, "1.0.0.1", "CN");
  assert.equal(fs.readFileSync(privateFile, "utf8"), "private synthetic sentinel");
});

test("metadata tampering, overlapping local rows and unexpected schema cannot serve trusted country answers", (t) => {
  const f = fixture(t);
  f.load();
  f.db.close();
  const original = fs.readFileSync(f.file);
  for (const sql of [
    "UPDATE metadata SET release = '2026-11'",
    "UPDATE metadata SET records = records - 1, ipv4 = ipv4 - 1",
    "INSERT INTO ranges VALUES (4, '01000002', '01000003', 'US'); UPDATE metadata SET records = records + 1, ipv4 = ipv4 + 1",
    "CREATE VIEW unexpected AS SELECT * FROM ranges",
  ]) {
    fs.writeFileSync(f.file, original);
    const database = new DatabaseSync(f.file);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    assert.throws(() => new CountryDatabase(f.root), safeError("REGION_DATABASE_INVALID", f.root));
  }
});

test("existing import lock rejects a competing writer without altering the database or lock", (t) => {
  const f = fixture(t);
  const saved = f.load();
  const lock = join(f.root, ".region-import.lock");
  fs.writeFileSync(lock, "synthetic competing importer");
  assert.throws(() => f.load(), safeError("CONFLICT"));
  assert.deepEqual(f.db.status(), saved);
  assert.equal(fs.readFileSync(lock, "utf8"), "synthetic competing importer");
});

test("atomic replacement failure retains original bytes, metadata and queries and removes staging files", (t) => {
  const f = fixture(t);
  const saved = f.load();
  const before = fs.readFileSync(f.file);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === f.file)
      throw Object.assign(new Error(`private-synthetic-value ${to}`), { code: "EACCES" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => f.load("2.0.0.0,2.0.0.1,US"),
      safeError("REGION_STORAGE_ERROR", "private-synthetic-value"),
    );
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.deepEqual(f.db.status(), saved);
  country(f.db, "1.0.0.1", "CN");
  assert.deepEqual(fs.readdirSync(f.root), ["region.sqlite"]);
});

test("closed instances reject status, lookup and import without creating files", (t) => {
  const f = fixture(t);
  f.db.close();
  f.db.close();
  for (const operation of [() => f.db.status(), () => f.db.lookup("1.0.0.1"), () => f.load()]) {
    assert.throws(operation, safeError("REGION_DATABASE_CLOSED"));
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test("plain/gzip encoded limits are checked before allocating decoded data", (t) => {
  const f = fixture(t);
  for (const [filename, bytes] of [
    ["synthetic.csv", 48 * 1024 * 1024],
    ["synthetic.csv.gz", 16 * 1024 * 1024],
  ]) {
    assert.throws(
      () =>
        f.load("", {
          filename,
          contentBase64: "A".repeat(Math.ceil(bytes / 3) * 4 + 4),
        }),
      safeError("LIMIT_EXCEEDED"),
    );
    assert.equal(f.db.status().revision, "empty");
    assert.deepEqual(fs.readdirSync(f.root), []);
  }
});

test("gzip expansion is capped at 64 MiB using a compact streamed synthetic fixture", async (t) => {
  const f = fixture(t);
  const saved = f.load();
  const gzip = createGzip();
  const output = [];
  gzip.on("data", (chunk) => output.push(chunk));
  const complete = once(gzip, "end");
  const chunk = Buffer.alloc(64 * 1024, 0x41);
  for (let index = 0; index < 1024; index++) {
    if (!gzip.write(chunk)) await once(gzip, "drain");
  }
  gzip.end(Buffer.from("A"));
  await complete;
  const compressed = Buffer.concat(output);
  assert.ok(compressed.length < 128 * 1024);
  assert.throws(
    () => f.load(compressed, { filename: "synthetic-bounded.csv.gz" }),
    safeError("LIMIT_EXCEEDED"),
  );
  assert.deepEqual(f.db.status(), saved);
  country(f.db, "1.0.0.1", "CN");
});
