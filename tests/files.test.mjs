import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { WorkspaceFiles, FILE_LIMITS } from "../src/core/files.js";
import { WorkspaceStore } from "../src/core/store.js";

const code = (expected) => (error) => error.code === expected;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const binary = (bytes) => ({ contentBase64: Buffer.from(bytes).toString("base64") });
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-materials-")));
  const root = join(directory, "materials");
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  const workspaceId = store.dispatch("workspaces.save", { name: "Synthetic local materials" }).item
    .id;
  const otherWorkspaceId = store.dispatch("workspaces.save", { name: "Other local materials" }).item
    .id;
  const files = new WorkspaceFiles(root, store);
  const call = (action, payload = {}) => files.dispatch(action, { workspaceId, ...payload });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, root, store, workspaceId, otherWorkspaceId, files, call };
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const header = Buffer.alloc(4),
    crc = Buffer.alloc(4),
    content = Buffer.concat([Buffer.from(type), data]);
  header.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(content));
  return Buffer.concat([header, content, crc]);
}
function png(width = 2, height = 3) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function gif() {
  return Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
}
// Synthetic bounded containers exercise header/container validation only;
// this module deliberately does not claim a JPEG or WebP pixel decoder.
function jpeg() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 3, 0, 2, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63,
    0, 0x12, 0x34, 0xff, 0xd9,
  ]);
}
function webp() {
  const payload = Buffer.from([0x2f, 1, 0x80, 0, 0, 0]); // VP8L dimensions: 2 by 3.
  const header = Buffer.alloc(20);
  header.write("RIFF");
  header.writeUInt32LE(18, 4);
  header.write("WEBPVP8L", 8);
  header.writeUInt32LE(payload.length, 16);
  return Buffer.concat([header, payload]);
}

test("HTTP/text and arbitrary bytes are actually stored and read back with hashes and evidence metadata", (t) => {
  const { call, root, store, workspaceId } = fixture(t);
  const assetId = store.dispatch("assets.save", {
    workspaceId,
    name: "Synthetic service",
    address: "https://example.invalid",
  }).item.id;
  const content = "GET /synthetic HTTP/1.1\r\nHost: example.invalid\r\n\r\n";
  const saved = call("files.write", {
    path: "http/request.http",
    content,
    assetId,
    source: "local fixture",
    purpose: "Request evidence",
  }).item;
  assert.equal(saved.bytes, Buffer.byteLength(content));
  assert.equal(saved.sha256, digest(Buffer.from(content)));
  assert.equal(saved.mediaType, "application/http");
  assert.equal(saved.assetId, assetId);
  assert.equal(saved.source, "local fixture");
  assert.equal(saved.previewable, false);
  assert.equal(readFileSync(join(root, workspaceId, "http", "request.http"), "utf8"), content);
  assert.equal(call("files.read", { path: saved.path, encoding: "utf8" }).item.content, content);
  const bytes = Buffer.from([0, 255, 42, 13, 10]);
  call("files.write", { path: "evidence/raw.bin", ...binary(bytes) });
  assert.equal(
    call("files.read", { path: "evidence/raw.bin" }).item.contentBase64,
    bytes.toString("base64"),
  );
  assert.throws(
    () => call("files.read", { path: "evidence/raw.bin", encoding: "utf8" }),
    code("INVALID_INPUT"),
  );
  const listed = call("files.list");
  assert.deepEqual(listed.items.map((item) => item.path).sort(), [
    "evidence/raw.bin",
    "http/request.http",
  ]);
  assert.equal(listed.limits.textBytes, 1024 * 1024);
});

test("all overwrites and deletions preserve exact recoverable bytes without exposing backups as files", (t) => {
  const { call, root, workspaceId } = fixture(t);
  const original = Buffer.from([0, 1, 2, 255]);
  call("files.write", { path: "artifact.bin", ...binary(original) });
  const replaced = call("files.write", { path: "artifact.bin", content: "Replacement" }).item;
  assert.ok(replaced.backupId);
  const backupData = readFileSync(join(root, ".backups", workspaceId, replaced.backupId, "data"));
  assert.deepEqual(backupData, original);
  const restored = call("files.restore", { backupId: replaced.backupId }).item;
  assert.equal(restored.sha256, digest(original));
  assert.ok(restored.backupId, "Restoring over a current file must preserve that current file too");
  assert.equal(
    readFileSync(join(root, ".backups", workspaceId, restored.backupId, "data"), "utf8"),
    "Replacement",
  );
  const deleted = call("files.delete", { path: "artifact.bin" }).item;
  assert.equal(deleted.deleted, true);
  assert.equal(call("files.list").items.length, 0);
  assert.equal(existsSync(join(root, workspaceId, "artifact.bin")), false);
  assert.deepEqual(
    readFileSync(join(root, ".backups", workspaceId, deleted.backupId, "data")),
    original,
  );
  call("files.restore", { backupId: deleted.backupId });
  assert.deepEqual(
    Buffer.from(call("files.read", { path: "artifact.bin" }).item.contentBase64, "base64"),
    original,
  );
});

test("workspace membership and asset associations isolate files and backups", (t) => {
  const { call, store, workspaceId, otherWorkspaceId } = fixture(t);
  call("files.write", { path: "same.txt", content: "One workspace" });
  call("files.write", {
    workspaceId: otherWorkspaceId,
    path: "same.txt",
    content: "Other workspace",
  });
  assert.equal(
    call("files.read", { path: "same.txt", encoding: "utf8" }).item.content,
    "One workspace",
  );
  assert.equal(
    call("files.read", { workspaceId: otherWorkspaceId, path: "same.txt", encoding: "utf8" }).item
      .content,
    "Other workspace",
  );
  const backupId = call("files.delete", { path: "same.txt" }).item.backupId;
  assert.throws(
    () => call("files.restore", { workspaceId: otherWorkspaceId, backupId }),
    code("NOT_FOUND"),
  );
  const foreignAsset = store.dispatch("assets.save", {
    workspaceId: otherWorkspaceId,
    name: "Foreign synthetic asset",
    address: "example.invalid",
  }).item.id;
  assert.throws(
    () =>
      call("files.write", {
        path: "wrong.txt",
        content: "No cross-scope link",
        assetId: foreignAsset,
      }),
    code("NOT_FOUND"),
  );
  assert.throws(() => call("files.list", { workspaceId: "missing-workspace" }), code("NOT_FOUND"));
  assert.equal(call("files.list", { workspaceId }).items.length, 0);
});

test("relative paths, symlinks and special internal paths cannot escape the owned workspace", (t) => {
  const { call, directory, root, workspaceId } = fixture(t);
  call("files.write", { path: "seed.txt", content: "Synthetic seed" });
  for (const path of [
    "../outside.txt",
    "/outside.txt",
    "C:/outside.txt",
    "folder\\..\\outside.txt",
    "folder//x",
    "./x",
    ".backups/x",
    ".manifest.json",
  ])
    assert.throws(
      () => call("files.write", { path, content: "Must refuse" }),
      code("INVALID_PATH"),
    );
  const outside = join(directory, "outside");
  mkdirSync(outside);
  const sentinel = join(outside, "sentinel.txt");
  writeFileSync(sentinel, "Unchanged synthetic sentinel");
  symlinkSync(outside, join(root, workspaceId, "linked"));
  symlinkSync(sentinel, join(root, workspaceId, "linked-file.txt"));
  symlinkSync(join(outside, "absent.txt"), join(root, workspaceId, "dangling.txt"));
  for (const path of ["linked/sentinel.txt", "linked-file.txt", "dangling.txt"]) {
    for (const action of ["files.read", "files.write", "files.delete"])
      assert.throws(() => call(action, { path, content: "Must refuse" }), code("INVALID_PATH"));
  }
  assert.equal(readFileSync(sentinel, "utf8"), "Unchanged synthetic sentinel");
  assert.throws(() => call("files.list"), code("INVALID_PATH"));
});

test("image previews verify PNG/JPEG/GIF/WebP structure and expose bounded dimensions without claiming decoding", (t) => {
  const { call } = fixture(t);
  for (const [name, bytes, width, height] of [
    ["png", png(), 2, 3],
    ["jpeg", jpeg(), 2, 3],
    ["gif", gif(), 1, 1],
    ["webp", webp(), 2, 3],
  ]) {
    const saved = call("files.write", { path: `screenshots/test.${name}`, ...binary(bytes) }).item;
    assert.equal(saved.previewable, true, name);
    assert.deepEqual([saved.width, saved.height], [width, height], name);
    assert.equal(saved.imageValidation, "structure-only");
    assert.equal(saved.mediaType, `image/${name}`);
    assert.equal(
      call("files.preview", { path: saved.path }).item.contentBase64,
      bytes.toString("base64"),
    );
  }
});

test("fake image names, bad CRC, truncated containers and unreasonable dimensions never become previews", (t) => {
  const { call } = fixture(t);
  const badCrc = Buffer.from(png());
  badCrc[20] ^= 1;
  const tooWide = png(1, 1);
  tooWide.writeUInt32BE(FILE_LIMITS.imageDimension + 1, 16);
  tooWide.writeUInt32BE(crc32(tooWide.subarray(12, 29)), 29);
  const fixtures = [
    Buffer.from("<html>Not an image</html>"),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    png().subarray(0, 33),
    badCrc,
    tooWide,
    jpeg().subarray(0, -2),
    gif().subarray(0, -1),
    webp().subarray(0, -1),
  ];
  fixtures.forEach((bytes, index) => {
    const item = call("files.write", {
      path: `fake-${index}.png`,
      mediaType: "image/png",
      ...binary(bytes),
    }).item;
    assert.equal(item.previewable, false, `fixture ${index}`);
    assert.equal(item.mediaType, "application/octet-stream");
    assert.throws(() => call("files.preview", { path: item.path }), code("INVALID_IMAGE"));
  });
  call("files.write", {
    path: "script.html",
    content: '<script>throw new Error("never execute")</script>',
  });
  assert.equal(
    call("files.read", { path: "script.html" }).item.mediaType,
    "application/octet-stream",
  );
});

test("batch validation and write failure do not leave partially imported usable files", (t) => {
  const { call } = fixture(t);
  call("files.write", { path: "one.txt", content: "Original synthetic file" });
  assert.throws(
    () =>
      call("files.import", {
        items: [
          { path: "one.txt", content: "Should not replace" },
          { path: "../escape.txt", content: "No" },
        ],
      }),
    code("INVALID_PATH"),
  );
  assert.equal(
    call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
    "Original synthetic file",
  );
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && from.includes(".stage-") && to.endsWith("/two.txt")) {
      injected = true;
      throw new Error("Synthetic material write failure");
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        call("files.import", {
          items: [
            { path: "one.txt", content: "Replacement" },
            { path: "two.txt", content: "New file" },
          ],
        }),
      /Synthetic material write failure/,
    );
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.deepEqual(
    call("files.list").items.map((item) => item.path),
    ["one.txt"],
  );
  assert.equal(
    call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
    "Original synthetic file",
  );
});

test("material limits, invalid encodings, duplicate paths and unknown actions fail explicitly", (t) => {
  const { call } = fixture(t);
  assert.throws(
    () =>
      call("files.write", { path: "large.txt", content: "x".repeat(FILE_LIMITS.textBytes + 1) }),
    code("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      call("files.write", {
        path: "large.bin",
        ...binary(Buffer.alloc(FILE_LIMITS.fileBytes + 1)),
      }),
    code("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () => call("files.write", { path: "bad.bin", contentBase64: "not base64" }),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      call("files.import", {
        items: Array.from({ length: 129 }, (_, index) => ({ path: `${index}.txt`, content: "" })),
      }),
    code("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      call("files.import", {
        items: [
          { path: "x.txt", content: "one" },
          { path: "X.txt", content: "two" },
        ],
      }),
    code("INVALID_PATH"),
  );
  assert.throws(() => call("files.execute", { path: "script.sh" }), code("UNKNOWN_ACTION"));
  call("files.write", {
    path: "__proto__",
    content: "Safe own manifest key",
    purpose: "Synthetic property-name fixture",
  });
  assert.equal(
    call("files.read", { path: "__proto__", encoding: "utf8" }).item.purpose,
    "Synthetic property-name fixture",
  );
});

test("separate writes cannot alias existing file or directory spelling on case-insensitive desktops", (t) => {
  const { call, root, workspaceId } = fixture(t);
  call("files.write", {
    path: "Evidence.txt",
    content: "Original case",
    purpose: "Original metadata",
  });
  call("files.write", { path: "Reports/first.txt", content: "Original directory" });
  assert.throws(
    () => call("files.write", { path: "evidence.txt", content: "Must not overwrite" }),
    code("INVALID_PATH"),
  );
  assert.throws(
    () =>
      call("files.write", {
        path: "reports/second.txt",
        content: "Must not add an alias directory",
      }),
    code("INVALID_PATH"),
  );
  assert.equal(
    call("files.read", { path: "Evidence.txt", encoding: "utf8" }).item.content,
    "Original case",
  );
  assert.equal(call("files.read", { path: "Evidence.txt" }).item.purpose, "Original metadata");
  assert.deepEqual(
    call("files.list")
      .items.map((item) => item.path)
      .sort(),
    ["Evidence.txt", "Reports/first.txt"],
  );
  const manifest = JSON.parse(readFileSync(join(root, workspaceId, ".manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["Evidence.txt", "Reports/first.txt"]);
  const written = call("files.write", { path: "Café.txt", content: "NFC material" }).item;
  assert.equal(
    call("files.read", { path: written.path, encoding: "utf8" }).item.content,
    "NFC material",
  );
  assert.ok(call("files.list").items.some((item) => item.path === "Café.txt"));
  // On case-sensitive filesystems an externally present decomposed spelling
  // must not cause a second canonical file to be created by this library.
  const decomposed = "Autre-Cafe\u0301.txt";
  writeFileSync(join(root, workspaceId, decomposed), "Externally prepared synthetic material");
  if (!existsSync(join(root, workspaceId, decomposed.normalize("NFC")))) {
    assert.throws(
      () =>
        call("files.write", {
          path: decomposed.normalize("NFC"),
          content: "Must not create an alias",
        }),
      code("INVALID_PATH"),
    );
    assert.equal(
      readFileSync(join(root, workspaceId, decomposed), "utf8"),
      "Externally prepared synthetic material",
    );
  }
});

test("persistent backup listing discovers and restores overwritten and deleted versions after reopening", (t) => {
  const { call, root, store, workspaceId, otherWorkspaceId } = fixture(t);
  call("files.write", {
    path: "history.txt",
    content: "First version",
    purpose: "Initial evidence",
    source: "Synthetic fixture",
  });
  const overwritten = call("files.write", {
    path: "history.txt",
    content: "Second version",
    purpose: "Reviewed evidence",
  }).item;
  const deleted = call("files.delete", { path: "history.txt" }).item;
  const reopened = new WorkspaceFiles(root, store);
  const backups = reopened.dispatch("files.backups", { workspaceId }).items;
  assert.equal(backups.length, 2);
  assert.ok(
    backups.every(
      (item) =>
        item.path === "history.txt" &&
        item.mediaType === "text/plain" &&
        item.workspaceId === workspaceId,
    ),
  );
  const first = backups.find((item) => item.sha256 === digest(Buffer.from("First version")));
  const second = backups.find((item) => item.sha256 === digest(Buffer.from("Second version")));
  assert.equal(first.backupId, overwritten.backupId);
  assert.equal(first.bytes, Buffer.byteLength("First version"));
  assert.equal(first.purpose, "Initial evidence");
  assert.equal(second.backupId, deleted.backupId);
  assert.equal(second.purpose, "Reviewed evidence");
  assert.deepEqual(reopened.dispatch("files.backups", { workspaceId: otherWorkspaceId }), {
    items: [],
  });
  assert.throws(
    () =>
      reopened.dispatch("files.restore", {
        workspaceId: otherWorkspaceId,
        backupId: first.backupId,
      }),
    code("NOT_FOUND"),
  );
  reopened.dispatch("files.restore", { workspaceId, backupId: first.backupId });
  assert.equal(
    call("files.read", { path: "history.txt", encoding: "utf8" }).item.content,
    "First version",
  );
  reopened.dispatch("files.restore", { workspaceId, backupId: second.backupId });
  assert.equal(
    call("files.read", { path: "history.txt", encoding: "utf8" }).item.content,
    "Second version",
  );
});

test("backup listing excludes metadata-only rollback shells and corrupt copies", (t) => {
  const { call, root, workspaceId } = fixture(t);
  call("files.write", { path: "shell.txt", content: "Synthetic shell source" });
  const shell = call("files.write", { path: "shell.txt", content: "Current shell source" }).item
    .backupId;
  rmSync(join(root, ".backups", workspaceId, shell, "data"));
  call("files.write", { path: "corrupt.txt", content: "Synthetic original" });
  const corrupt = call("files.write", { path: "corrupt.txt", content: "Synthetic current" }).item
    .backupId;
  writeFileSync(join(root, ".backups", workspaceId, corrupt, "data"), "Checksum no longer matches");
  assert.deepEqual(call("files.backups"), { items: [] });
  assert.throws(() => call("files.restore", { backupId: shell }), code("NOT_FOUND"));
  assert.throws(() => call("files.restore", { backupId: corrupt }), code("INVALID_DATA"));
});

test("backup paths reject symlink directories and data without reading outside the owned root", (t) => {
  const { call, root, workspaceId, directory } = fixture(t);
  call("files.write", { path: "one.txt", content: "Original file" });
  const backupId = call("files.delete", { path: "one.txt" }).item.backupId;
  const outside = join(directory, "outside.txt");
  writeFileSync(outside, "Unrelated synthetic sentinel");
  const data = join(root, ".backups", workspaceId, backupId, "data");
  rmSync(data);
  symlinkSync(outside, data);
  assert.throws(() => call("files.backups"), code("INVALID_PATH"));
  assert.throws(() => call("files.restore", { backupId }), code("INVALID_PATH"));
  assert.equal(readFileSync(outside, "utf8"), "Unrelated synthetic sentinel");
});

test("failed rollback returns relative staging and backup references that remain discoverable for explicit recovery", (t) => {
  const { call, root, workspaceId } = fixture(t);
  call("files.write", { path: "one.txt", content: "Preserved original bytes" });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (
      (from.includes(".stage-") && to.endsWith("/two.txt")) ||
      (from.endsWith("/data") && to.endsWith("/one.txt"))
    )
      throw new Error("Synthetic forward/rollback failure");
    return rename(from, to);
  };
  syncBuiltinESMExports();
  let failure;
  try {
    assert.throws(
      () =>
        call("files.import", {
          items: [
            { path: "one.txt", content: "Replacement bytes" },
            { path: "two.txt", content: "Another import" },
          ],
        }),
      (error) => {
        failure = error;
        return error.code === "RECOVERY_REQUIRED";
      },
    );
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(failure.partial.workspaceId, workspaceId);
  assert.ok(failure.partial.stagingPath.startsWith(`${workspaceId}/.stage-`));
  assert.ok(!JSON.stringify(failure.partial).includes(root));
  assert.ok(existsSync(join(root, failure.partial.stagingPath)));
  assert.equal(failure.partial.backups.length, 1);
  const backup = call("files.backups").items[0];
  assert.equal(backup.backupId, failure.partial.backups[0].backupId);
  assert.equal(backup.sha256, digest(Buffer.from("Preserved original bytes")));
  call("files.restore", { backupId: backup.backupId });
  assert.equal(
    call("files.read", { path: "one.txt", encoding: "utf8" }).item.content,
    "Preserved original bytes",
  );
});
