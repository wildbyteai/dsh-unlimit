import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  MAX_WORKSPACE_RULE_BYTES,
  workspaceInstructions,
  readWorkspaceRule,
} from "../src/core/workspace-rules.js";
import { renderWorkspaceRules } from "../web/workspace-rules.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dsh-workspace-rules-")));
  const project = join(root, "parent", "project");
  fs.mkdirSync(project, { recursive: true });
  // The real scanner walks to filesystem root. Never inspect real user/global
  // AGENTS/CLAUDE fixtures outside this test's own synthetic directory.
  const originalLstat = fs.lstatSync;
  const originalOpen = fs.openSync;
  const inside = (path) => {
    const rel = relative(root, String(path));
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
  };
  t.mock.method(fs, "lstatSync", (path, ...args) => {
    if (["AGENTS.md", "CLAUDE.md"].includes(basename(String(path))) && !inside(path))
      throw Object.assign(new Error("Synthetic outside fixture is absent"), { code: "ENOENT" });
    return originalLstat(path, ...args);
  });
  t.mock.method(fs, "openSync", (path, ...args) => {
    assert.ok(inside(path), "Never open real ancestor rules outside the synthetic root");
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const write = (directory, name, content) => {
    const path = join(directory, name);
    fs.writeFileSync(path, content);
    return path;
  };
  return { root, project, parent: join(root, "parent"), write, inside };
}
const code = (expected) => (error) => error.code === expected;

test("ancestor candidates are deterministic, far-to-near with explicit canonical directory metadata", (t) => {
  const f = fixture(t);
  const expected = [
    f.write(f.root, "AGENTS.md", "Root AGENTS"),
    f.write(f.root, "CLAUDE.md", "Root CLAUDE"),
    f.write(f.parent, "AGENTS.md", "Parent"),
    f.write(f.project, "AGENTS.md", "Project"),
  ];
  const result = workspaceInstructions(f.project);
  assert.deepEqual(
    result.map((item) => item.path),
    expected,
  );
  assert.deepEqual(
    result.map((item) => item.depth),
    [2, 2, 1, 0],
  );
  assert.ok(
    result.every(
      (item) =>
        item.workspaceDirectory === f.project &&
        item.readable === true &&
        item.bytes > 0 &&
        !Object.hasOwn(item, "content"),
    ),
  );
  assert.ok(result[0].level < result[2].level && result[2].level < result[3].level);
  assert.deepEqual(
    result.map((item) => item.directory),
    [f.root, f.root, f.parent, f.project],
  );
});

test("preview preserves complete UTF-8 text, BOM, CRLF, whitespace and exact byte hash, including empty files", (t) => {
  const f = fixture(t);
  const content = "\ufeff  原创规则\r\n\r\n<script>不执行</script>\n最后一行  \n";
  const path = f.write(f.project, "AGENTS.md", content);
  const value = readWorkspaceRule({ directory: f.project, path });
  assert.equal(value.content, content);
  assert.equal(value.path, path);
  assert.equal(value.resolvedPath, path);
  assert.equal(value.bytes, Buffer.byteLength(content));
  assert.equal(value.sha256, createHash("sha256").update(content).digest("hex"));
  const empty = f.write(f.project, "CLAUDE.md", "");
  const blank = readWorkspaceRule({ directory: f.project, path: empty });
  assert.equal(blank.content, "");
  assert.equal(blank.bytes, 0);
  assert.equal(workspaceInstructions(f.project).find((item) => item.path === empty).readable, true);
});

test("absent rules are a clear empty set, stale previews fail, and explicit directory input is mandatory", (t) => {
  const f = fixture(t);
  assert.deepEqual(workspaceInstructions(f.project), []);
  for (const directory of [undefined, "", " ", ".", null, join(f.root, "missing")])
    assert.throws(() => workspaceInstructions(directory), code("INVALID_DIRECTORY"));
  const path = f.write(f.project, "AGENTS.md", "Synthetic stale rule");
  assert.equal(workspaceInstructions(f.project).length, 1);
  fs.unlinkSync(path);
  assert.throws(() => readWorkspaceRule({ directory: f.project, path }), code("RULE_NOT_FOUND"));
});

test("256 KiB is admitted exactly; oversize, invalid UTF-8 and directories remain visible but unselectable", (t) => {
  const f = fixture(t);
  const exact = f.write(f.root, "AGENTS.md", Buffer.alloc(MAX_WORKSPACE_RULE_BYTES, 65));
  assert.equal(
    readWorkspaceRule({ directory: f.project, path: exact }).bytes,
    MAX_WORKSPACE_RULE_BYTES,
  );
  const oversized = f.write(f.parent, "AGENTS.md", Buffer.alloc(MAX_WORKSPACE_RULE_BYTES + 1, 65));
  const invalid = f.write(f.project, "AGENTS.md", Buffer.from([0xc3, 0x28]));
  fs.mkdirSync(join(f.project, "CLAUDE.md"));
  const items = workspaceInstructions(f.project);
  const bad = items.filter((item) => !item.readable);
  assert.deepEqual(
    bad.map((item) => item.error.code),
    ["RULE_TOO_LARGE", "RULE_INVALID_UTF8", "RULE_NOT_FILE"],
  );
  assert.equal(bad.find((item) => item.path === oversized).bytes, MAX_WORKSPACE_RULE_BYTES + 1);
  assert.throws(
    () => readWorkspaceRule({ directory: f.project, path: oversized }),
    code("RULE_TOO_LARGE"),
  );
  assert.throws(
    () => readWorkspaceRule({ directory: f.project, path: invalid }),
    code("RULE_INVALID_UTF8"),
  );
});

test("arbitrary paths, descendants, wrong names and sibling workspace selections are rejected before file open", (t) => {
  const f = fixture(t);
  const descendant = join(f.project, "descendant");
  fs.mkdirSync(descendant);
  const sibling = join(f.parent, "sibling");
  fs.mkdirSync(sibling);
  const bad = [
    f.write(f.root, "notes.md", "Not a rule"),
    f.write(sibling, "AGENTS.md", "Other workspace"),
    f.write(descendant, "AGENTS.md", "Descendant"),
    join(f.project, "..", "sibling", "AGENTS.md"),
  ];
  for (const path of bad)
    assert.throws(
      () => readWorkspaceRule({ directory: f.project, path }),
      code("RULE_OUTSIDE_CHAIN"),
    );
  assert.throws(
    () => readWorkspaceRule({ directory: f.project, path: "AGENTS.md" }),
    code("INVALID_RULE_PATH"),
  );
  const valid = f.write(f.parent, "CLAUDE.md", "Allowed ancestor");
  assert.equal(
    readWorkspaceRule({ directory: f.project, path: join(f.project, "..", "CLAUDE.md") }).path,
    valid,
  );
});

test("allowed ancestor links preserve candidate path; escaping, broken and cyclic links are diagnosed without reading targets", (t) => {
  const f = fixture(t);
  const parent = f.write(f.parent, "AGENTS.md", "Allowed linked ancestor");
  const allowed = join(f.project, "AGENTS.md");
  fs.symlinkSync(parent, allowed);
  const linked = readWorkspaceRule({ directory: f.project, path: allowed });
  assert.equal(linked.path, allowed);
  assert.equal(linked.resolvedPath, parent);
  assert.equal(linked.linked, true);
  assert.equal(linked.content, "Allowed linked ancestor");
  const elsewhere = join(f.root, "other");
  fs.mkdirSync(elsewhere);
  const target = f.write(elsewhere, "CLAUDE.md", "Do not read sibling target");
  const escape = join(f.project, "CLAUDE.md");
  fs.symlinkSync(target, escape);
  assert.throws(
    () => readWorkspaceRule({ directory: f.project, path: escape }),
    code("RULE_LINK_ESCAPE"),
  );
  assert.equal(
    workspaceInstructions(f.project).find((item) => item.path === escape).readable,
    false,
  );
  fs.unlinkSync(escape);
  fs.symlinkSync(join(f.root, "missing"), escape);
  assert.equal(
    workspaceInstructions(f.project).find((item) => item.path === escape).error.code,
    "RULE_NOT_FOUND",
  );
  fs.unlinkSync(escape);
  fs.symlinkSync(escape, escape);
  assert.equal(
    workspaceInstructions(f.project).find((item) => item.path === escape).error.code,
    "RULE_LINK_ESCAPE",
  );
});

test("symlinked workspace directories resolve explicitly and a rule replacement cannot escape after scanning", (t) => {
  const f = fixture(t);
  const alias = join(f.root, "alias");
  fs.symlinkSync(f.project, alias);
  const path = f.write(f.project, "AGENTS.md", "Before replacement");
  assert.equal(workspaceInstructions(alias)[0].path, path);
  assert.equal(readWorkspaceRule({ directory: alias, path }).workspaceDirectory, f.project);
  assert.equal(readWorkspaceRule({ directory: alias, path: join(alias, "AGENTS.md") }).path, path);
  fs.unlinkSync(path);
  fs.symlinkSync(f.write(f.root, "secret.txt", "Synthetic outside-name target"), path);
  assert.throws(() => readWorkspaceRule({ directory: alias, path }), code("RULE_LINK_ESCAPE"));
});

test("unreadable candidates stay visible and growth during read cannot exceed the preview bound", (t) => {
  const f = fixture(t);
  const blocked = f.write(f.parent, "AGENTS.md", "Synthetic unreadable body");
  const growing = f.write(f.project, "CLAUDE.md", "small");
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (path, ...args) => {
    if (path === blocked)
      throw Object.assign(new Error("Synthetic read denied"), { code: "EACCES" });
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  const items = workspaceInstructions(f.project);
  assert.equal(items.find((item) => item.path === blocked).error.code, "RULE_UNREADABLE");
  assert.equal(items.find((item) => item.path === growing).readable, true);
  const originalRead = fs.readSync;
  let changed = false;
  t.mock.method(fs, "readSync", (...args) => {
    if (!changed) {
      changed = true;
      fs.writeFileSync(growing, Buffer.alloc(MAX_WORKSPACE_RULE_BYTES + 1, 65));
    }
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  assert.throws(
    () => readWorkspaceRule({ directory: f.project, path: growing }),
    code("RULE_TOO_LARGE"),
  );
});

test("candidate rendering escapes rule metadata and disables unreadable entries", () => {
  const html = renderWorkspaceRules({
    items: [
      {
        path: '/synthetic/"<AGENTS>.md',
        name: "<script>",
        directory: "<directory>",
        depth: 1,
        bytes: 7,
        readable: false,
        error: { code: "RULE_TOO_LARGE", message: "<too large>" },
      },
    ],
    selectedPaths: ['/synthetic/"<AGENTS>.md'],
  });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;too large&gt;/);
  assert.match(html, /data-rule-choice="0"[^>]*disabled/);
  assert.doesNotMatch(html, /checked/);
  assert.match(renderWorkspaceRules({ items: [] }), /未发现/);
});
