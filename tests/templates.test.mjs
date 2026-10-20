import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Templates } from "../src/core/templates.js";

function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-templates-")));
  const root = join(base, "templates");
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, templates: new Templates({ config: () => ({ templateDir: root }) }) };
}

test("text templates search actual content and read exact bytes without execution", (t) => {
  const { root, templates } = fixture(t);
  mkdirSync(join(root, "checks"));
  writeFileSync(join(root, "checks", "sample.yaml"), "id: synthetic\ninfo: 合成验证\n");
  writeFileSync(join(root, "second.md"), "# Another example\n");
  const result = templates.dispatch("templates.list", { query: "合成" });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].path, "checks/sample.yaml");
  assert.equal(result.items[0].verification, "unverified");
  const read = templates.dispatch("templates.read", { path: result.items[0].path }).item;
  assert.equal(read.content, "id: synthetic\ninfo: 合成验证\n");
  assert.equal(read.sha256, result.items[0].sha256);
  assert.equal(templates.list({ query: "SECOND" }).items.length, 1);
});

test("template path traversal, symlink escape and unsupported binaries reject", (t) => {
  const { base, root, templates } = fixture(t);
  writeFileSync(join(base, "outside.md"), "must not read");
  writeFileSync(join(root, "binary.txt"), Buffer.from([0xff, 0, 0xff]));
  writeFileSync(join(root, "active.svg"), "<svg/>");
  symlinkSync(join(base, "outside.md"), join(root, "linked.md"));
  symlinkSync(base, join(root, "linked-dir"));
  for (const path of [
    "../outside.md",
    join(base, "outside.md"),
    "linked.md",
    "linked-dir/outside.md",
    "binary.txt",
    "active.svg",
  ]) {
    assert.throws(() => templates.read(path), { code: "INVALID_INPUT" });
  }
  assert.equal(templates.list().items.length, 0);
  assert.equal(templates.list().skipped, 4);
});

test("template search reports limits and keeps oversized content out", (t) => {
  const { root, templates } = fixture(t);
  writeFileSync(join(root, "a.md"), "one");
  writeFileSync(join(root, "b.md"), "two");
  writeFileSync(join(root, "large.txt"), "x".repeat(1024 * 1024 + 1));
  const bounded = templates.list({ limit: 1 });
  assert.equal(bounded.items.length, 1);
  assert.equal(bounded.truncated, true);
  const full = templates.list();
  assert.equal(full.items.length, 2);
  assert.equal(full.skipped, 1);
  assert.throws(() => templates.read("large.txt"), { code: "LIMIT_EXCEEDED" });
  assert.throws(() => templates.list({ limit: 0 }), { code: "INVALID_INPUT" });
});

test("unconfigured or replaced roots are explicit errors, not an empty successful catalog", (t) => {
  const { base, root, templates } = fixture(t);
  assert.throws(() => new Templates({ config: () => ({ templateDir: "" }) }).list(), {
    code: "NOT_CONFIGURED",
  });
  rmSync(root, { recursive: true });
  symlinkSync(base, root);
  assert.throws(() => templates.list(), { code: "CONFLICT" });
});
