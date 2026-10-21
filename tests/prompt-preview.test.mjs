import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";
import { DEFAULT_PROMPT } from "../src/core/prompts.js";
import { DesktopRuntime } from "../src/host/runtime.js";
import { Controller } from "../src/server/controller.js";

function fixture(t, overrides = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-prompt-preview-")));
  const directory = join(root, "workspace");
  mkdirSync(directory);
  const path = join(directory, "AGENTS.md");
  writeFileSync(path, "  SYNTHETIC_WORKSPACE 中文\r\n");
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  let hostCalls = 0;
  const assembly = {
    sections: [{ name: "harness:identity", text: "SYNTHETIC_HOST_PERSONA" }],
    tools: [],
    contexts: [],
    variables: {},
  };
  const ctx = {
    systemPrompt: {
      async assemble() {
        hostCalls++;
        return assembly;
      },
    },
    approval: {
      async decide() {
        return "rejected";
      },
    },
    sandboxPolicy: {
      resolve() {
        return { mode: "read-only", workspaceRoot: directory };
      },
    },
  };
  const host = { supported: true, version: "0.2.1-rc.2" };
  const runtime = new DesktopRuntime(ctx, store, host);
  const controller = new Controller({ store, runtime, host });
  t.after(() => {
    try {
      runtime.revert();
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  const save = (value) => {
    const current = store.dispatch("settings.get");
    return store.dispatch("settings.save", {
      revision: current.revision,
      value: { ...current.value, ...value },
    });
  };
  save({ enabled: true, prompt: "SYNTHETIC_SAVED", ...overrides });
  if (store.dispatch("settings.get").value.enabled) runtime.apply();
  const snapshot = () => ({
    settings: store.dispatch("settings.get"),
    rules: store.dispatch("rules.list"),
    enabled: runtime.enabled,
    assemble: ctx.systemPrompt.assemble,
    hostCalls,
  });
  const preview = async (payload = {}) => {
    const before = snapshot();
    const originalApply = runtime.apply;
    const originalRevert = runtime.revert;
    runtime.apply = () => assert.fail("Preview must not apply runtime controls");
    runtime.revert = () => assert.fail("Preview must not revert runtime controls");
    try {
      return await controller.dispatch("prompt.preview", payload);
    } finally {
      runtime.apply = originalApply;
      runtime.revert = originalRevert;
      assert.deepEqual(
        snapshot(),
        before,
        "Preview cannot mutate saved or live state or assemble host prompts",
      );
    }
  };
  const matchesRuntime = async (result, payload = {}) => {
    assert.equal(store.dispatch("settings.get").value.enabled, true);
    const before = hostCalls;
    const wasEnabled = runtime.enabled;
    runtime.apply();
    try {
      const output = await ctx.systemPrompt.assemble({
        model: payload.model,
        agent: { session: { header: { cwd: payload.directory } } },
      });
      assert.equal(hostCalls, before + 1);
      assert.equal(
        output.sections.find((item) => item.name === "dsh-unlimit/operator").text,
        result.text,
      );
    } finally {
      if (!wasEnabled) runtime.revert();
    }
  };
  return { root, directory, path, store, runtime, ctx, assembly, save, preview, matchesRuntime };
}

test("saved and default previews report saved metadata and match enabled runtime composition without host assembly", async (t) => {
  const f = fixture(t);
  const saved = await f.preview();
  assert.deepEqual(saved, {
    revision: f.store.dispatch("settings.get").revision,
    model: null,
    directory: null,
    enabled: true,
    mode: "replace",
    source: "saved",
    rule: null,
    workspace: { policy: "fallback", selectedPaths: [], included: false },
    text: "SYNTHETIC_SAVED",
  });
  await f.matchesRuntime(saved);
  f.save({ prompt: "", promptMode: "append" });
  const fallback = await f.preview();
  assert.equal(fallback.source, "default");
  assert.equal(fallback.mode, "append");
  assert.equal(fallback.text, DEFAULT_PROMPT);
  await f.matchesRuntime(fallback);
});

test("preview honors active same-model rules and never uses them for a different model", async (t) => {
  const f = fixture(t);
  const rule = (name, content, model) =>
    f.store.dispatch("rules.save", { name, content, model }).item;
  rule("First synthetic", "SYNTHETIC_FIRST", "model-M");
  const active = rule("Active synthetic", "SYNTHETIC_ACTIVE", "model-M");
  f.store.dispatch("rules.activate", { id: active.id });
  const matching = await f.preview({ model: "model-M" });
  assert.equal(matching.source, "rule");
  assert.equal(matching.model, "model-M");
  assert.deepEqual(matching.rule, { id: active.id, name: active.name, model: "model-M" });
  assert.equal(matching.text, active.content);
  await f.matchesRuntime(matching, { model: "model-M" });
  const other = await f.preview({ model: "model-N" });
  assert.equal(other.source, "saved");
  assert.equal(other.rule, null);
  assert.equal(other.text, "SYNTHETIC_SAVED");
  await f.matchesRuntime(other, { model: "model-N" });
  const global = rule("Global synthetic", "SYNTHETIC_GLOBAL", "");
  f.store.dispatch("rules.activate", { id: global.id });
  const globalPreview = await f.preview({ model: "model-N" });
  assert.equal(globalPreview.source, "rule");
  assert.deepEqual(globalPreview.rule, { id: global.id, name: global.name, model: null });
  assert.equal(globalPreview.text, global.content);
  await f.matchesRuntime(globalPreview, { model: "model-N" });
});

test("workspace fallback, always append and strict exclusion share runtime operator text", async (t) => {
  const f = fixture(t, { prompt: "" });
  f.save({ workspaceFiles: [f.path] });
  const payload = { directory: f.directory };
  const workspace = await f.preview(payload);
  assert.equal(workspace.directory, f.directory);
  assert.equal(workspace.source, "workspace");
  assert.equal(workspace.text, "SYNTHETIC_WORKSPACE 中文");
  assert.deepEqual(workspace.workspace, {
    policy: "fallback",
    selectedPaths: [f.path],
    included: true,
  });
  await f.matchesRuntime(workspace, payload);
  f.save({ prompt: "SYNTHETIC_SAVED", workspacePolicy: "always" });
  const appended = await f.preview(payload);
  assert.equal(appended.source, "saved");
  assert.equal(appended.workspace.included, true);
  assert.equal(appended.text, "SYNTHETIC_SAVED\n\nSYNTHETIC_WORKSPACE 中文");
  await f.matchesRuntime(appended, payload);
  f.save({ workspacePolicy: "strict", prompt: "" });
  const strict = await f.preview(payload);
  assert.equal(strict.source, "default");
  assert.equal(strict.workspace.included, false);
  assert.equal(strict.text, DEFAULT_PROMPT);
  await f.matchesRuntime(strict, payload);
});

test("disabled preview exposes the candidate without enabling controls or changing the host prompt", async (t) => {
  const f = fixture(t, { enabled: false, workspacePolicy: "always" });
  f.save({ workspaceFiles: [f.path] });
  const payload = { directory: f.directory };
  const candidate = await f.preview(payload);
  assert.equal(candidate.enabled, false);
  assert.equal(candidate.source, "saved");
  assert.equal(candidate.workspace.included, true);
  assert.equal(candidate.text, "SYNTHETIC_SAVED\n\nSYNTHETIC_WORKSPACE 中文");
  assert.equal(f.runtime.enabled, false);
  assert.equal(await f.ctx.systemPrompt.assemble(), f.assembly);
  f.save({ enabled: true });
  await f.matchesRuntime(candidate, payload);
});

test("workspace reads require an explicit valid directory and malformed preview inputs are rejected", async (t) => {
  const f = fixture(t, { prompt: "", workspacePolicy: "always" });
  f.save({ workspaceFiles: [f.path] });
  for (const directory of [undefined, "", " ", "relative", f.path, join(f.root, "missing")]) {
    await assert.rejects(f.preview({ directory }), { code: "INVALID_DIRECTORY" });
  }
  for (const directory of [7, null, {}, []]) {
    await assert.rejects(f.preview({ directory }), { code: "INVALID_INPUT" });
  }
  for (const model of [7, {}, []]) {
    await assert.rejects(f.preview({ model, directory: f.directory }), { code: "INVALID_INPUT" });
  }
});

test("preview preserves selected-file ancestor, symlink and regular-file boundaries", async (t) => {
  const f = fixture(t, { prompt: "" });
  const other = join(f.root, "other-workspace");
  mkdirSync(other);
  const outside = join(other, "AGENTS.md");
  writeFileSync(outside, "SYNTHETIC_OUTSIDE");
  const linked = join(f.directory, "CLAUDE.md");
  symlinkSync(outside, linked);
  const nonFileDirectory = join(f.root, "directory-workspace");
  mkdirSync(nonFileDirectory);
  const nonFile = join(nonFileDirectory, "AGENTS.md");
  mkdirSync(nonFile);
  for (const [path, directory, code] of [
    [outside, f.directory, "RULE_OUTSIDE_CHAIN"],
    [linked, f.directory, "RULE_LINK_ESCAPE"],
    [nonFile, nonFileDirectory, "RULE_NOT_FILE"],
  ]) {
    f.save({ workspaceFiles: [path] });
    await assert.rejects(f.preview({ directory }), { code });
  }
});

test("saved and strict previews do not read stale selected paths or require an unnecessary directory", async (t) => {
  const f = fixture(t);
  const stale = join(f.root, "missing-workspace", "AGENTS.md");
  f.save({ workspaceFiles: [stale] });
  const saved = await f.preview();
  assert.equal(saved.source, "saved");
  assert.deepEqual(saved.workspace, { policy: "fallback", selectedPaths: [], included: false });
  await f.matchesRuntime(saved);
  f.save({ prompt: "", workspacePolicy: "strict" });
  const strict = await f.preview();
  assert.equal(strict.source, "default");
  assert.equal(strict.workspace.included, false);
  await f.matchesRuntime(strict);
});
