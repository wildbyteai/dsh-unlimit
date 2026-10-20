import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { SkillLibrary } from "../src/core/skills.js";

const doc = (name = "fixture", body = "Inspect synthetic evidence only.") =>
  `---\nname: ${name}\ndescription: Synthetic fixture skill\n---\n\n${body}\n`;
const encoded = (path, content) => ({
  path,
  contentBase64: Buffer.from(content).toString("base64"),
});
const code = (expected) => (error) => error.code === expected;
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-skills-"));
  const root = join(directory, "library");
  const library = new SkillLibrary(root);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, root, library, call: (action, payload) => library.dispatch(action, payload) };
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Build synthetic ZIP fixtures without third-party tooling or real user files.
function zip(entries, options = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const content = Buffer.from(entry.content ?? "");
    const method = entry.method ?? 0;
    const compressed = Buffer.concat([
      method === 8 ? deflateRawSync(content) : content,
      entry.compressedTail ?? Buffer.alloc(0),
    ]);
    const crc = entry.crc ?? crc32(content);
    const flags = 0x800 | (entry.flags ?? 0);
    const extra = entry.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(entry.version ?? 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(flags & 8 ? 0 : crc, 14);
    local.writeUInt32LE(flags & 8 ? 0 : compressed.length, 18);
    local.writeUInt32LE(flags & 8 ? 0 : content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(entry.version ?? 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.uncompressed ?? content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((entry.mode ?? 0x8000) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0);
    if (flags & 8) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(content.length, 12);
    }
    const part = Buffer.concat([local, name, extra, compressed, descriptor]);
    locals.push(part);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += part.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length + (options.badSize ? 1 : 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function importZip(call, entries, options) {
  return call("skills.import", {
    filename: "synthetic.zip",
    contentBase64: zip(entries, options).toString("base64"),
  });
}

test("skills CRUD uses frontmatter and retains recoverable overwrite/delete backups", (t) => {
  const { call, root } = fixture(t);
  const saved = call("skills.save", {
    name: "fixture",
    description: "A synthetic skill",
    content: "Use local evidence.",
  }).item;
  assert.equal(saved.id, "fixture");
  assert.match(saved.content, /^---\nname: "fixture"/);
  assert.equal(saved.description, "A synthetic skill");
  assert.equal(call("skills.list").items[0].id, "fixture");
  const updated = call("skills.save", {
    id: "fixture",
    content: doc("fixture", "Updated body"),
  }).item;
  assert.match(updated.content, /Updated body/);
  const backups = readdirSync(join(root, ".backups"));
  assert.equal(backups.length, 1);
  assert.match(
    readFileSync(join(root, ".backups", backups[0], "SKILL.md"), "utf8"),
    /Use local evidence/,
  );
  assert.equal(call("skills.read", { name: "fixture" }).item.content, updated.content);
  assert.equal(call("skills.delete", { id: "fixture" }).item.deleted, true);
  assert.equal(call("skills.list").items.length, 0);
  assert.equal(readdirSync(join(root, ".backups")).length, 2);
  assert.throws(() => call("skills.read", { id: "fixture" }), code("NOT_FOUND"));
});

test("directory upload supports nested binary assets and whole-batch validation", (t) => {
  const { call } = fixture(t);
  const result = call("skills.import", {
    files: [
      encoded("alpha/SKILL.md", doc("alpha")),
      encoded("alpha/assets/data.bin", Buffer.from([0, 255, 42])),
      encoded("beta/SKILL.md", doc("beta")),
    ],
  });
  assert.equal(result.items.length, 2);
  assert.equal(
    call("skills.read", { id: "alpha" }).item.files.find((file) => file.path === "assets/data.bin")
      .contentBase64,
    "AP8q",
  );
  call("skills.save", { id: "alpha", content: doc("alpha", "Edited") });
  assert.equal(call("skills.read", { id: "alpha" }).item.files.length, 2);
  assert.throws(
    () =>
      call("skills.import", {
        files: [
          encoded("alpha/SKILL.md", doc("alpha", "Should not replace")),
          encoded("bad/SKILL.md", "Missing frontmatter"),
        ],
      }),
    code("INVALID_SKILL"),
  );
  assert.match(call("skills.read", { id: "alpha" }).item.content, /Edited/);
  assert.equal(call("skills.list").items.length, 2);
});

test("direct SKILL.md import infers its root and accepts folded description metadata", (t) => {
  const { call } = fixture(t);
  const content =
    "---\nname: direct\ndescription: >-\n  A synthetic\n  folded description\n---\nBody";
  call("skills.import", { files: [encoded("SKILL.md", content)] });
  assert.equal(
    call("skills.read", { id: "direct" }).item.description,
    "A synthetic folded description",
  );
});

test("synthetic store and deflate ZIPs validate CRC, support descriptors and import directories", (t) => {
  const { call } = fixture(t);
  const result = importZip(call, [
    { path: "stored/", mode: 0x4000 },
    { path: "stored/SKILL.md", content: doc("stored") },
    { path: "deflated/SKILL.md", content: doc("deflated"), method: 8, flags: 8 },
    { path: "deflated/references/synthetic.txt", content: "A".repeat(2048), method: 8 },
  ]);
  assert.equal(result.items.length, 2);
  assert.equal(call("skills.read", { id: "deflated" }).item.files.length, 2);
});

test("ZIP import rejects corruption, mismatched lengths and central directory bounds", (t) => {
  const { call } = fixture(t);
  assert.throws(
    () => importZip(call, [{ path: "x/SKILL.md", content: doc("x"), crc: 1 }]),
    code("INVALID_ZIP"),
  );
  assert.throws(
    () => importZip(call, [{ path: "x/SKILL.md", content: doc("x"), uncompressed: 2 }]),
    code("INVALID_ZIP"),
  );
  assert.throws(
    () => importZip(call, [{ path: "x/SKILL.md", content: doc("x") }], { badSize: true }),
    code("INVALID_ZIP"),
  );
  assert.throws(
    () =>
      importZip(call, [
        { path: "x/SKILL.md", content: doc("x"), method: 8, compressedTail: Buffer.from("extra") },
      ]),
    code("INVALID_ZIP"),
  );
  const truncated = zip([{ path: "x/SKILL.md", content: doc("x") }]).subarray(0, 30);
  assert.throws(
    () =>
      call("skills.import", {
        filename: "fixture.zip",
        contentBase64: truncated.toString("base64"),
      }),
    code("INVALID_ZIP"),
  );
  assert.deepEqual(call("skills.list").items, []);
});

test("a mid-batch rename failure restores overwritten skills and removes newly installed skills", (t) => {
  const { call, root } = fixture(t);
  call("skills.save", { id: "alpha", content: doc("alpha", "Original body") });
  const originalRename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && from.includes(".stage-") && from.endsWith("/charlie")) {
      injected = true;
      throw new Error("Synthetic rename failure");
    }
    return originalRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        call("skills.import", {
          files: [
            encoded("alpha/SKILL.md", doc("alpha", "Replacement")),
            encoded("beta/SKILL.md", doc("beta")),
            encoded("charlie/SKILL.md", doc("charlie")),
          ],
        }),
      /Synthetic rename failure/,
    );
  } finally {
    fs.renameSync = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.deepEqual(
    call("skills.list").items.map((item) => item.id),
    ["alpha"],
  );
  assert.match(call("skills.read", { id: "alpha" }).item.content, /Original body/);
  assert.equal(
    readdirSync(root).some((name) => name.startsWith(".stage-")),
    false,
  );
});

test("ZIP import rejects encryption, unsupported methods, ZIP64 and symlinks", (t) => {
  const { call } = fixture(t);
  for (const override of [
    { flags: 1 },
    { method: 12 },
    { version: 45 },
    { mode: 0xa000 },
    { extra: Buffer.from([1, 0, 0, 0]) },
  ]) {
    assert.throws(
      () => importZip(call, [{ path: "x/SKILL.md", content: doc("x"), ...override }]),
      code("INVALID_ZIP"),
    );
  }
  assert.equal(call("skills.list").items.length, 0);
});

test("all import forms reject path traversal, absolute paths, escapes and duplicates", (t) => {
  const { call, directory } = fixture(t);
  for (const path of [
    "../outside/SKILL.md",
    "/absolute/SKILL.md",
    "C:/escape/SKILL.md",
    "x\\..\\outside/SKILL.md",
    "x/../outside/SKILL.md",
    "x//SKILL.md",
    "x/./SKILL.md",
    "x/nul.txt",
  ]) {
    assert.throws(
      () => call("skills.import", { files: [encoded(path, doc())] }),
      code("INVALID_PATH"),
    );
    assert.throws(() => importZip(call, [{ path, content: doc() }]), code("INVALID_PATH"));
  }
  assert.throws(
    () =>
      call("skills.import", {
        files: [encoded("x/SKILL.md", doc("x")), encoded("x/skill.md", doc("x"))],
      }),
    code("INVALID_PATH"),
  );
  assert.throws(
    () =>
      importZip(call, [
        { path: "x/SKILL.md", content: doc("x") },
        { path: "x/SKILL.md", content: doc("x") },
      ]),
    code("INVALID_PATH"),
  );
  assert.throws(
    () =>
      call("skills.import", {
        files: [
          encoded("x/SKILL.md", doc("x")),
          encoded("x/assets", "file"),
          encoded("x/assets/a.txt", "child"),
        ],
      }),
    code("INVALID_PATH"),
  );
  assert.equal(existsSync(join(directory, "outside")), false);
});

test("root-only actions reject symlinks and never modify external fixture files", (t) => {
  const { call, directory, root } = fixture(t);
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), doc("outside"));
  symlinkSync(outside, join(root, "linked"));
  for (const action of ["skills.read", "skills.delete"])
    assert.throws(() => call(action, { id: "linked" }), code("INVALID_PATH"));
  assert.throws(
    () => call("skills.save", { id: "linked", content: doc("linked") }),
    code("INVALID_PATH"),
  );
  for (const action of ["skills.read", "skills.delete", "skills.save"])
    assert.throws(() => call(action, { id: "../outside", content: doc() }), code("INVALID_PATH"));
  assert.match(readFileSync(join(outside, "SKILL.md"), "utf8"), /name: outside/);
  assert.throws(() => new SkillLibrary(join(root, "linked")), code("INVALID_PATH"));
});

for (const format of ["folder", "ZIP"]) {
  test(`${format} import accepts 200 regular files and rejects 201 without changing existing data`, (t) => {
    const { call, directory, root } = fixture(t);
    const sentinel = join(directory, "outside-sentinel.bin");
    const sentinelContent = Buffer.from([0, 255, 42]);
    writeFileSync(sentinel, sentinelContent);
    const original = doc("fixture", "Original body before overwrite");
    call("skills.save", { id: "fixture", content: original });
    const entries = [
      { path: "fixture/SKILL.md", content: doc("fixture", "Accepted 200-file import") },
      ...Array.from({ length: 199 }, (_, index) => ({
        path: `fixture/assets/file-${index}.bin`,
        content: Buffer.from([index, 0, 255]),
      })),
    ];
    const importEntries = (files) => {
      if (format === "ZIP")
        return importZip(call, [
          { path: "fixture/", mode: 0x4000 },
          { path: "fixture/assets/", mode: 0x4000 },
          ...files,
        ]);
      return call("skills.import", {
        files: files.map((file) => encoded(file.path, file.content)),
      });
    };

    // The ZIP contains 202 central-directory entries, but only 200 regular files.
    const imported = importEntries(entries);
    assert.equal(imported.items.length, 1);
    const accepted = call("skills.read", { id: "fixture" }).item;
    assert.equal(accepted.files.length, 200);
    assert.deepEqual(
      new Map(accepted.files.map((file) => [file.path, file.contentBase64])),
      new Map(
        entries.map((file) => [
          file.path.slice("fixture/".length),
          Buffer.from(file.content).toString("base64"),
        ]),
      ),
    );
    const backups = readdirSync(join(root, ".backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(root, ".backups", backups[0], "SKILL.md"), "utf8"), original);
    const libraryEntries = readdirSync(root).sort();

    const rejected = [
      { path: "fixture/SKILL.md", content: doc("fixture", "Rejected replacement") },
      ...entries.slice(1),
      { path: "fixture/assets/one-too-many.bin", content: "Not installed" },
    ];
    assert.equal(rejected.length, 201);
    assert.throws(() => importEntries(rejected), code("LIMIT_EXCEEDED"));
    assert.deepEqual(call("skills.read", { id: "fixture" }).item, accepted);
    assert.deepEqual(readdirSync(root).sort(), libraryEntries);
    assert.deepEqual(readdirSync(join(root, ".backups")), backups);
    assert.equal(readFileSync(join(root, ".backups", backups[0], "SKILL.md"), "utf8"), original);
    assert.deepEqual(readFileSync(sentinel), sentinelContent);
  });
}

test("existing 201-file skills remain readable while oversized saves preserve the original", (t) => {
  const { call, directory, root } = fixture(t);
  const skillRoot = join(root, "legacy");
  mkdirSync(join(skillRoot, "assets"), { recursive: true });
  writeFileSync(join(skillRoot, "SKILL.md"), doc("legacy", "Existing synthetic library"));
  for (let index = 0; index < 200; index++)
    writeFileSync(join(skillRoot, "assets", `file-${index}.txt`), `Synthetic ${index}`);
  const sentinel = join(directory, "outside-sentinel.txt");
  writeFileSync(sentinel, "Unchanged external fixture");
  const original = call("skills.read", { id: "legacy" }).item;
  assert.equal(original.files.length, 201);
  assert.equal(call("skills.list").items[0].id, "legacy");

  assert.throws(
    () => call("skills.save", { id: "legacy", content: doc("legacy", "Rejected edit") }),
    code("LIMIT_EXCEEDED"),
  );
  assert.deepEqual(call("skills.read", { id: "legacy" }).item, original);
  assert.deepEqual(readdirSync(root), ["legacy"]);
  assert.equal(readFileSync(sentinel, "utf8"), "Unchanged external fixture");
});

test("ZIP central directory retains a separate 512-entry bound including folders", (t) => {
  const { call } = fixture(t);
  const entries = [
    { path: "fixture/SKILL.md", content: doc() },
    ...Array.from({ length: 511 }, (_, index) => ({
      path: `fixture/empty-${index}/`,
      mode: 0x4000,
    })),
  ];
  importZip(call, entries);
  const original = call("skills.read", { id: "fixture" }).item;
  assert.equal(original.files.length, 1);
  assert.throws(
    () => importZip(call, [...entries, { path: "fixture/extra/", mode: 0x4000 }]),
    code("INVALID_ZIP"),
  );
  assert.deepEqual(call("skills.read", { id: "fixture" }).item, original);
});

test("imports reject file and decompressed-byte limits without visible partial skills", (t) => {
  const { call } = fixture(t);
  const tooMany = Array.from({ length: 201 }, (_, n) => encoded(`x/${n}.txt`, "x"));
  assert.throws(() => call("skills.import", { files: tooMany }), code("LIMIT_EXCEEDED"));
  const large = Buffer.alloc(50 * 1024 * 1024, 65);
  assert.throws(
    () =>
      call("skills.import", {
        files: [encoded("x/SKILL.md", doc("x")), encoded("x/assets/large.bin", large)],
      }),
    code("LIMIT_EXCEEDED"),
  );
  assert.throws(
    () =>
      importZip(call, [
        { path: "x/SKILL.md", content: doc("x") },
        { path: "x/large.bin", content: large, method: 8 },
      ]),
    code("LIMIT_EXCEEDED"),
  );
  assert.equal(call("skills.list").items.length, 0);
});

test("invalid metadata, base64 and unsupported actions fail explicitly", (t) => {
  const { call } = fixture(t);
  assert.throws(() => call("skills.save", { name: "x", content: "Body" }), code("INVALID_INPUT"));
  assert.throws(
    () =>
      call("skills.import", {
        files: [encoded("x/SKILL.md", "---\nname: x\n---\nNo description")],
      }),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () => call("skills.import", { files: [{ path: "x/SKILL.md", contentBase64: "not-base64!" }] }),
    code("INVALID_INPUT"),
  );
  assert.throws(() => call("skills.execute", { id: "x" }), code("UNKNOWN_ACTION"));
});

test("outer folders import multiple discoverable skills and preserve invocation flags", (t) => {
  const { call } = fixture(t);
  const content =
    "---\nname: selected-skill\ndescription: Synthetic\nuser-invocable: false\ndisable-model-invocation: true\n---\nOriginal test body";
  const result = call("skills.import", {
    files: [
      encoded("download/README.md", "Synthetic archive wrapper"),
      encoded("download/group/selected-skill/SKILL.md", content),
      encoded("download/group/selected-skill/references/note.txt", "Evidence"),
      encoded("download/another/SKILL.md", doc("another")),
    ],
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(call("skills.read", { id: "selected-skill" }).item.invocation, {
    userInvocable: false,
    modelInvocable: false,
  });
  assert.equal(call("skills.read", { id: "selected-skill" }).item.files.length, 2);
  assert.throws(
    () =>
      call("skills.save", {
        id: "bad",
        content: content.replace("user-invocable: false", "user-invocable: yes"),
      }),
    code("INVALID_SKILL"),
  );
  assert.throws(
    () => call("skills.save", { id: "large", content: doc("large") + "x".repeat(256 * 1024) }),
    code("LIMIT_EXCEEDED"),
  );
});
