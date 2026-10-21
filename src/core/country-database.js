import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { StoreError, fail } from "./validation.js";

const PLAIN_BYTES = 48 * 1024 * 1024;
const GZIP_BYTES = 16 * 1024 * 1024;
const EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 1_500_000;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const APPLICATION_ID = 0x44534852;
const ATTRIBUTION = Object.freeze({
  name: "DB-IP",
  url: "https://db-ip.com",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
});
// ISO 3166-1 alpha-2 plus the explicitly supported XK assignment. Unknown
// provider values are represented by NULL, never by an invented country.
const COUNTRIES = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
    "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
    "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
  ).split(" "),
);
const COUNTRY_SQL = [...COUNTRIES].map((country) => `'${country}'`).join(",");
const RANGE_SQL = `CREATE TABLE ranges (
  family INTEGER NOT NULL CHECK (family IN (4,6)),
  first TEXT NOT NULL CHECK (
    ((family = 4 AND length(first) = 8) OR (family = 6 AND length(first) = 32))
    AND first NOT GLOB '*[^0-9a-f]*'
  ),
  last TEXT NOT NULL CHECK (
    ((family = 4 AND length(last) = 8) OR (family = 6 AND length(last) = 32))
    AND last NOT GLOB '*[^0-9a-f]*'
  ),
  country TEXT CHECK (country IS NULL OR country IN (${COUNTRY_SQL})),
  PRIMARY KEY (family, first),
  CHECK (first <= last)
) STRICT, WITHOUT ROWID`;
const METADATA_SQL = `CREATE TABLE metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format INTEGER NOT NULL CHECK (format = 1),
  release TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  revision TEXT NOT NULL,
  records INTEGER NOT NULL CHECK (records > 0 AND records <= ${MAX_RECORDS}),
  ipv4 INTEGER NOT NULL CHECK (ipv4 >= 0),
  ipv6 INTEGER NOT NULL CHECK (ipv6 >= 0),
  CHECK (records = ipv4 + ipv6)
) STRICT`;
const normalizeSQL = (sql) => sql.replace(/\s+/g, " ").trim();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const revisionOf = (digest, release) => sha256(JSON.stringify([digest, release]));
const releaseValid = (value) =>
  typeof value === "string" && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
const invalidInput = () => fail("INVALID_INPUT", "Invalid offline region database import");
const limitExceeded = () =>
  fail("LIMIT_EXCEEDED", "Offline region database import exceeds its resource limit");
const invalidDatabase = () => fail("REGION_DATABASE_INVALID", "Offline region database is invalid");
const unsafePath = () =>
  fail("UNSAFE_PATH", "Offline region database storage must use ordinary files and directories");
const conflict = () =>
  fail("CONFLICT", "Offline region database revision has changed; refresh before importing");
function storageError(error) {
  if (error instanceof StoreError) throw error;
  // Filesystem and SQLite errors can include paths, source text, or SQL values.
  fail("REGION_STORAGE_ERROR", "Offline region database storage operation failed");
}
function emptyStatus() {
  return {
    available: false,
    revision: "empty",
    release: null,
    source: null,
    records: 0,
    ipv4: 0,
    ipv6: 0,
    sha256: null,
    attribution: null,
  };
}
function availableStatus(metadata) {
  const { revision, release, records, ipv4, ipv6, sha256: digest } = metadata;
  return {
    available: true,
    revision,
    release,
    source: "db-ip-lite",
    records,
    ipv4,
    ipv6,
    sha256: digest,
    attribution: { ...ATTRIBUTION },
  };
}
function optionalStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function ordinaryFile(stat) {
  if (!stat.isFile() || stat.nlink !== 1) unsafePath();
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))
  )
    unsafePath();
}
function directoryStat(directory) {
  if (
    typeof directory !== "string" ||
    directory.length > 4096 ||
    !isAbsolute(directory) ||
    directory.includes("\0") ||
    normalize(directory) !== directory ||
    directory.split(/[\\/]/).includes("..")
  )
    unsafePath();
  const root = parse(directory).root;
  let path = root;
  for (const component of directory.slice(root.length).split(sep).filter(Boolean)) {
    path = join(path, component);
    if (lstatSync(path).isSymbolicLink()) unsafePath();
  }
  const stat = lstatSync(directory);
  if (!stat.isDirectory()) unsafePath();
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))
  )
    unsafePath();
}
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

// net.isIP provides syntax validation. Numeric conversion is deliberately local
// and independent of third-party IP libraries, including dotted IPv6 tails.
function addressOf(address) {
  if (typeof address !== "string" || address.length > 45 || address.includes("%")) return null;
  const originalFamily = isIP(address);
  if (!originalFamily) return null;
  let family = originalFamily;
  let value = 0n;
  if (family === 4) {
    for (const octet of address.split(".")) value = (value << 8n) | BigInt(octet);
  } else {
    let text = address;
    if (text.includes(".")) {
      const colon = text.lastIndexOf(":");
      const octets = text
        .slice(colon + 1)
        .split(".")
        .map(Number);
      text = `${text.slice(0, colon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = text.split("::");
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const words =
      halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
        : left;
    for (const word of words) value = (value << 16n) | BigInt(`0x${word}`);
    if (value >> 32n === 0xffffn) {
      family = 4;
      value &= 0xffffffffn;
    }
  }
  return {
    family,
    originalFamily,
    value,
    key: value.toString(16).padStart(family === 4 ? 8 : 32, "0"),
  };
}
function prefix(address, bits) {
  const parsed = addressOf(address);
  const shift = BigInt((parsed.family === 4 ? 32 : 128) - bits);
  return { family: parsed.family, shift, value: parsed.value >> shift };
}
const SPECIAL_V4 = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([address, bits]) => prefix(address, bits));
const SPECIAL_V6 = [
  ["2001::", 23], // IETF protocol assignments, including transition mechanisms.
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
].map(([address, bits]) => prefix(address, bits));
function special(address) {
  // Addresses outside the allocated IPv6 global-unicast space include ::/96,
  // loopback, ULA, link-local, multicast, translation and reserved allocations.
  if (address.family === 6 && address.value >> 125n !== 1n) return true;
  const ranges = address.family === 4 ? SPECIAL_V4 : SPECIAL_V6;
  return ranges.some((range) => address.value >> range.shift === range.value);
}

// A bounded RFC 4180 parser: quotes and CRLF are supported, but a field cannot
// grow beyond an IP/header field. Invalid multiline IPs still fail IP parsing.
function* csvRows(text) {
  let row = [];
  let field = "";
  let state = "start";
  const append = (character) => {
    field += character;
    if (field.length > 64) invalidInput();
  };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (state === "quoted") {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"');
          index++;
        } else state = "closed";
      } else append(character);
      continue;
    }
    if (character === "," || character === "\r" || character === "\n") {
      row.push(field);
      if (row.length > 3) invalidInput();
      field = "";
      state = "start";
      if (character === ",") continue;
      if (character === "\r") {
        if (text[index + 1] !== "\n") invalidInput();
        index++;
      }
      if (row.length !== 3) invalidInput();
      yield row;
      row = [];
      continue;
    }
    if (state === "closed") invalidInput();
    if (character === '"') {
      if (state !== "start") invalidInput();
      state = "quoted";
    } else {
      state = "plain";
      append(character);
    }
  }
  if (state === "quoted") invalidInput();
  if (row.length || field || state !== "start") {
    row.push(field);
    if (row.length !== 3) invalidInput();
    yield row;
  }
}
function importBytes(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).some(
      (key) => !["contentBase64", "filename", "release", "revision"].includes(key),
    ) ||
    typeof payload.filename !== "string" ||
    payload.filename.length > 255 ||
    /[\\/\u0000-\u001f]/u.test(payload.filename) ||
    !/\.csv(?:\.gz)?$/i.test(payload.filename) ||
    !releaseValid(payload.release) ||
    typeof payload.contentBase64 !== "string"
  )
    invalidInput();
  const compressed = /\.gz$/i.test(payload.filename);
  const max = compressed ? GZIP_BYTES : PLAIN_BYTES;
  const encoded = payload.contentBase64;
  if (encoded.length > Math.ceil(max / 3) * 4) limitExceeded();
  if (encoded.length % 4 || /[^a-zA-Z0-9+/=]/.test(encoded)) invalidInput();
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > max) limitExceeded();
  if (bytes.toString("base64") !== encoded) invalidInput();
  if (!compressed) return bytes;
  try {
    return gunzipSync(bytes, { maxOutputLength: EXPANDED_BYTES });
  } catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") limitExceeded();
    invalidInput();
  }
}

/** Offline only. Importing a release label does not authenticate its supplier. */
export class CountryDatabase {
  #directory;
  #file;
  #database = null;
  #query = null;
  #identity = null;
  #metadata = null;
  #closed = false;

  constructor(directory) {
    this.#directory = directory;
    try {
      directoryStat(directory);
      this.#file = join(directory, "region.sqlite");
      this.#refresh();
    } catch (error) {
      this.#discard();
      storageError(error);
    }
  }
  #assertOpen() {
    if (this.#closed) fail("REGION_DATABASE_CLOSED", "Offline region database is closed");
  }
  #discard() {
    this.#database?.close();
    this.#database = null;
    this.#query = null;
    this.#identity = null;
    this.#metadata = null;
  }
  #fileStat() {
    directoryStat(this.#directory);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      if (optionalStat(`${this.#file}${suffix}`)) unsafePath();
    }
    const stat = optionalStat(this.#file);
    if (!stat) return null;
    ordinaryFile(stat);
    if (stat.size > MAX_DATABASE_BYTES) invalidDatabase();
    return stat;
  }
  #readDatabase(stat) {
    let fd;
    let database;
    try {
      fd = openSync(this.#file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      ordinaryFile(opened);
      if (identity(opened) !== identity(stat)) unsafePath();
      database = new DatabaseSync(this.#file, { readOnly: true, allowExtension: false });
      database.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
      if (
        database.prepare("PRAGMA application_id").get().application_id !== APPLICATION_ID ||
        database.prepare("PRAGMA user_version").get().user_version !== 1
      )
        invalidDatabase();
      const schema = database
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      if (
        schema.length !== 2 ||
        schema[0].type !== "table" ||
        schema[0].name !== "metadata" ||
        schema[1].type !== "table" ||
        schema[1].name !== "ranges" ||
        normalizeSQL(schema[0].sql) !== normalizeSQL(METADATA_SQL) ||
        normalizeSQL(schema[1].sql) !== normalizeSQL(RANGE_SQL)
      )
        invalidDatabase();
      if (database.prepare("PRAGMA quick_check(1)").get().quick_check !== "ok") invalidDatabase();
      const rows = database.prepare("SELECT * FROM metadata").all();
      const metadata = rows[0];
      if (
        rows.length !== 1 ||
        metadata.id !== 1 ||
        metadata.format !== 1 ||
        !releaseValid(metadata.release) ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        metadata.revision !== revisionOf(metadata.sha256, metadata.release) ||
        !Number.isSafeInteger(metadata.records) ||
        metadata.records < 1 ||
        metadata.records > MAX_RECORDS ||
        !Number.isSafeInteger(metadata.ipv4) ||
        metadata.ipv4 < 0 ||
        !Number.isSafeInteger(metadata.ipv6) ||
        metadata.ipv6 < 0 ||
        metadata.records !== metadata.ipv4 + metadata.ipv6
      )
        invalidDatabase();
      const counts = database
        .prepare("SELECT family, count(*) AS count FROM ranges GROUP BY family")
        .all();
      const count4 = counts.find((row) => row.family === 4)?.count ?? 0;
      const count6 = counts.find((row) => row.family === 6)?.count ?? 0;
      if (count4 !== metadata.ipv4 || count6 !== metadata.ipv6) invalidDatabase();
      if (
        database
          .prepare(
            `SELECT 1 FROM (
        SELECT first, lag(last) OVER (PARTITION BY family ORDER BY first) AS previous FROM ranges
      ) WHERE previous >= first LIMIT 1`,
          )
          .get()
      )
        invalidDatabase();
      if (identity(this.#fileStat()) !== identity(stat)) unsafePath();
      return { database, metadata };
    } catch (error) {
      database?.close();
      if (error instanceof StoreError) throw error;
      invalidDatabase();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  #refresh() {
    const stat = this.#fileStat();
    if (!stat) {
      this.#discard();
      return;
    }
    if (this.#database && this.#identity === identity(stat)) return;
    this.#discard();
    const { database, metadata } = this.#readDatabase(stat);
    this.#database = database;
    this.#metadata = metadata;
    this.#identity = identity(stat);
    // The primary key performs an ordered range seek, followed by one end check.
    this.#query = database.prepare(
      "SELECT last, country FROM ranges WHERE family = ? AND first <= ? ORDER BY first DESC LIMIT 1",
    );
  }
  status() {
    this.#assertOpen();
    try {
      this.#refresh();
      if (!this.#metadata) return emptyStatus();
      return availableStatus(this.#metadata);
    } catch (error) {
      storageError(error);
    }
  }
  lookup(address) {
    this.#assertOpen();
    const parsed = addressOf(address);
    if (!parsed) return { country: null, kind: "unknown", reason: "invalid-address" };
    if (special(parsed)) return { country: null, kind: "special", reason: "special-address" };
    try {
      this.#refresh();
      if (!this.#query) return { country: null, kind: "unknown", reason: "database-unavailable" };
      const row = this.#query.get(parsed.family, parsed.key);
      if (!row || row.last < parsed.key)
        return { country: null, kind: "unknown", reason: "not-listed" };
      if (row.country === null)
        return { country: null, kind: "unknown", reason: "country-unknown" };
      return { country: row.country, kind: "country" };
    } catch (error) {
      storageError(error);
    }
  }
  import(payload) {
    this.#assertOpen();
    let staged;
    let database;
    let lock;
    let lockStat;
    const lockFile = join(this.#directory, ".region-import.lock");
    try {
      if (!payload || typeof payload.revision !== "string") invalidInput();
      if (payload.revision !== this.status().revision) conflict();
      const bytes = importBytes(payload);
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        invalidInput();
      }
      try {
        lock = openSync(
          lockFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        if (error.code === "EEXIST")
          fail("CONFLICT", "An offline region database import is already in progress");
        throw error;
      }
      lockStat = fstatSync(lock);
      if (payload.revision !== this.status().revision) conflict();
      staged = join(this.#directory, `.region-import-${randomUUID()}.sqlite`);
      const fd = openSync(
        staged,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      closeSync(fd);
      database = new DatabaseSync(staged, { allowExtension: false });
      database.exec(`PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;
        PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = 1;
        ${RANGE_SQL}; ${METADATA_SQL}; BEGIN IMMEDIATE;`);
      const insert = database.prepare(
        "INSERT INTO ranges (family, first, last, country) VALUES (?, ?, ?, ?)",
      );
      let previous = null;
      let firstRow = true;
      let records = 0;
      let ipv4 = 0;
      let ipv6 = 0;
      for (const row of csvRows(text)) {
        if (firstRow && row[0] === "ip_start" && row[1] === "ip_end" && row[2] === "country") {
          firstRow = false;
          continue;
        }
        firstRow = false;
        if (++records > MAX_RECORDS) limitExceeded();
        const start = addressOf(row[0]);
        const end = addressOf(row[1]);
        const country = ["", "XX", "ZZ"].includes(row[2]) ? null : row[2];
        if (
          !start ||
          !end ||
          start.originalFamily !== end.originalFamily ||
          start.family !== end.family ||
          start.value > end.value ||
          (country !== null && !COUNTRIES.has(country)) ||
          (previous &&
            (start.family < previous.family ||
              (start.family === previous.family && start.value <= previous.value)))
        )
          invalidInput();
        insert.run(start.family, start.key, end.key, country);
        previous = { family: end.family, value: end.value };
        if (start.family === 4) ipv4++;
        else ipv6++;
      }
      if (!records) invalidInput();
      const digest = sha256(bytes);
      const revision = revisionOf(digest, payload.release);
      database
        .prepare(
          "INSERT INTO metadata (id, format, release, sha256, revision, records, ipv4, ipv6) VALUES (1, 1, ?, ?, ?, ?, ?, ?)",
        )
        .run(payload.release, digest, revision, records, ipv4, ipv6);
      database.exec("COMMIT");
      database.close();
      database = null;
      const stageFd = openSync(staged, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(stageFd);
        ordinaryFile(stat);
        if (stat.size > MAX_DATABASE_BYTES) limitExceeded();
        fsyncSync(stageFd);
      } finally {
        closeSync(stageFd);
      }
      if (payload.revision !== this.status().revision) conflict();
      this.#discard();
      renameSync(staged, this.#file);
      staged = null;
      // No fallible database reopen follows the atomic commit. The next read
      // opens the imported file; the returned metadata was validated above.
      return availableStatus({
        revision,
        release: payload.release,
        records,
        ipv4,
        ipv6,
        sha256: digest,
      });
    } catch (error) {
      storageError(error);
    } finally {
      try {
        database?.close();
        if (staged) {
          // These names are generated by this import, never supplied by a user.
          for (const suffix of ["", "-journal", "-wal", "-shm"]) {
            try {
              unlinkSync(`${staged}${suffix}`);
            } catch (error) {
              if (error.code !== "ENOENT") storageError(error);
            }
          }
        }
        if (lock !== undefined) {
          closeSync(lock);
          const current = optionalStat(lockFile);
          if (current && lockStat && current.dev === lockStat.dev && current.ino === lockStat.ino)
            unlinkSync(lockFile);
        }
      } catch (error) {
        storageError(error);
      }
    }
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#discard();
    } catch (error) {
      storageError(error);
    }
  }
}
