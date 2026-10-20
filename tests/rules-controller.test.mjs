import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Controller } from "../src/server/controller.js";
import { WorkspaceStore } from "../src/core/store.js";
import { selectedInstructions } from "../src/core/prompts.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-rules-controller-")));
  const directory = join(root, "child");
  mkdirSync(directory);
  const parent = join(root, "AGENTS.md");
  const child = join(directory, "CLAUDE.md");
  writeFileSync(parent, "  SYNTHETIC_PARENT\r\n");
  writeFileSync(child, "\uFEFFSYNTHETIC_CHILD 中文\r\n");
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  const controller = new Controller({ store });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, parent, child, store, controller };
}

test("workspace discovery and exact preview do not select files; explicit revisioned selection persists", async (t) => {
  const f = fixture(t);
  const before = f.store.dispatch("settings.get", {});
  const result = await f.controller.dispatch("rules.workspace", { directory: f.directory });
  const own = result.items.filter((item) => item.path.startsWith(f.root + "/"));
  assert.deepEqual(
    own.map((item) => [item.path, item.depth]),
    [
      [f.parent, 1],
      [f.child, 0],
    ],
  );
  const preview = await f.controller.dispatch("rules.preview", {
    directory: f.directory,
    path: f.child,
  });
  assert.equal(preview.item.content, readFileSync(f.child, "utf8"));
  assert.deepEqual(f.store.dispatch("settings.get", {}), before);
  const saved = await f.controller.dispatch("rules.select", {
    revision: before.revision,
    paths: [f.parent, f.child],
  });
  assert.equal(saved.revision, before.revision + 1);
  assert.deepEqual(saved.value.workspaceFiles, [f.parent, f.child]);
  assert.equal(saved.value.enabled, false);
  assert.equal(
    selectedInstructions(f.directory, saved.value.workspaceFiles),
    "SYNTHETIC_PARENT\n\nSYNTHETIC_CHILD 中文",
  );
  await assert.rejects(
    f.controller.dispatch("rules.select", {
      revision: before.revision,
      paths: [],
    }),
    { code: "CONFLICT" },
  );
  await assert.rejects(f.controller.dispatch("rules.select", { paths: [] }), {
    code: "INVALID_INPUT",
  });
  assert.deepEqual(f.store.dispatch("settings.get", {}).value.workspaceFiles, [f.parent, f.child]);
  const cleared = await f.controller.dispatch("rules.select", {
    revision: saved.revision,
    paths: [],
  });
  assert.deepEqual(cleared.value.workspaceFiles, []);
});

test("workspace policy rejects a stale update and cannot overwrite another settings edit", async (t) => {
  const f = fixture(t);
  const first = f.store.dispatch("settings.get", {});
  f.store.dispatch("settings.save", {
    revision: first.revision,
    value: { ...first.value, prompt: "SYNTHETIC_LATER_EDIT" },
  });
  await assert.rejects(
    f.controller.dispatch("rules.policy", {
      revision: first.revision,
      policy: "always",
    }),
    { code: "CONFLICT" },
  );
  assert.equal(f.store.dispatch("settings.get", {}).value.prompt, "SYNTHETIC_LATER_EDIT");
});

test("selected rules keep explicit order, skip empty files, reject another workspace and enforce aggregate bytes", (t) => {
  const f = fixture(t);
  assert.equal(
    selectedInstructions(f.directory, [f.child, f.parent]),
    "SYNTHETIC_CHILD 中文\n\nSYNTHETIC_PARENT",
  );
  writeFileSync(f.child, " \r\n\t");
  assert.equal(selectedInstructions(f.directory, [f.parent, f.child]), "SYNTHETIC_PARENT");
  const other = join(f.root, "other");
  mkdirSync(other);
  const foreign = join(other, "AGENTS.md");
  writeFileSync(foreign, "SYNTHETIC_OTHER_WORKSPACE");
  assert.throws(() => selectedInstructions(f.directory, [foreign]), {
    code: "RULE_OUTSIDE_CHAIN",
  });
  writeFileSync(f.parent, "A".repeat(256 * 1024));
  writeFileSync(f.child, "B".repeat(256 * 1024));
  assert.throws(() => selectedInstructions(f.directory, [f.parent, f.child]), /512 KiB/);
  writeFileSync(f.child, "B".repeat(256 * 1024 - 2));
  assert.equal(
    Buffer.byteLength(selectedInstructions(f.directory, [f.parent, f.child])),
    512 * 1024,
  );
});
