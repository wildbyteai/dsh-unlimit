import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRuntime } from "../src/host/runtime.js";
import { composePrompt } from "../src/core/prompts.js";

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = {
    enabled: false,
    prompt: "Synthetic operator",
    promptMode: "replace",
    workspacePolicy: "fallback",
    workspaceFiles: [],
    autoApprove: true,
    fullAccess: true,
    maxDepth: 10,
    maxSubagents: 16,
    ...overrides,
  };
  const library = { items: [], activeId: null };
  const reads = [];
  const assembly = {
    sections: [{ name: "host-complete", text: "Original prompt", complete: true }],
    tools: [
      {
        name: "synthetic-tool",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    contexts: [{ name: "runtime", text: "Current workspace context" }],
    variables: { cwd: directory },
    metadata: { untouched: true },
  };
  const audit = [];
  let originalCalls = 0;
  const ctx = {
    systemPrompt: {
      async assemble() {
        originalCalls++;
        return assembly;
      },
    },
    approval: {
      async decide() {
        return "rejected";
      },
      async request(request) {
        audit.push("asked");
        const outcome = await this.decide(request);
        audit.push(["decided", outcome]);
        return outcome;
      },
    },
    sandboxPolicy: {
      resolve() {
        return { mode: "read-only", workspaceRoot: directory, sessionId: "synthetic" };
      },
    },
    subagents: { config: { maxDepth: { get: () => 3 }, maxActiveSubagents: { get: () => 4 } } },
  };
  const original = {
    assemble: ctx.systemPrompt.assemble,
    decide: ctx.approval.decide,
    request: ctx.approval.request,
    resolve: ctx.sandboxPolicy.resolve,
    depth: ctx.subagents.config.maxDepth.get,
    count: ctx.subagents.config.maxActiveSubagents.get,
  };
  const store = {
    dispatch(action) {
      reads.push(action);
      if (action === "settings.get") return { value: settings };
      if (action === "rules.list") return library;
      throw new Error(`Unexpected action ${action}`);
    },
  };
  const runtime = new DesktopRuntime(ctx, store, { supported: true, version: "0.2.1-rc.2" });
  t.after(() => runtime.revert());
  return {
    directory,
    settings,
    library,
    reads,
    assembly,
    ctx,
    runtime,
    original,
    audit,
    get originalCalls() {
      return originalCalls;
    },
  };
}

test("disabled composition preserves the exact original assembly", (t) => {
  const { assembly, settings } = fixture(t);
  assert.equal(composePrompt(assembly, settings, { rule: { content: "Ignored" } }), assembly);
});

test("disabled runtime leaves original prompt path unaffected even with unavailable selected files", async (t) => {
  const f = fixture(t, { workspaceFiles: ["/not-an-existing-synthetic-file/AGENTS.md"] });
  f.runtime.apply();
  assert.equal(
    await f.ctx.systemPrompt.assemble({ agent: { session: { header: { cwd: f.directory } } } }),
    f.assembly,
  );
});

test("enabled assembly replaces host complete section and preserves tool schemas, runtime context and variables", async (t) => {
  const f = fixture(t, { enabled: true });
  f.runtime.apply();
  const result = await f.ctx.systemPrompt.assemble({});
  assert.deepEqual(
    result.sections.map((s) => s.text),
    ["Synthetic operator"],
  );
  for (const key of ["tools", "contexts", "variables", "metadata"])
    assert.equal(result[key], f.assembly[key], key);
});

test("every model step rereads active rules, operator prompt and selected workspace instruction content", async (t) => {
  const f = fixture(t, { enabled: true });
  const path = join(f.directory, "AGENTS.md");
  writeFileSync(path, "Workspace first");
  Object.assign(f.settings, { prompt: "", workspaceFiles: [path] });
  const context = { agent: { session: { header: { cwd: f.directory } } } };
  f.runtime.apply();
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Workspace first");
  writeFileSync(path, "Workspace changed");
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Workspace changed");
  f.settings.prompt = "Prompt changed";
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Prompt changed");
  f.library.items.push({ id: "active", content: "Rule first" });
  f.library.activeId = "active";
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Rule first");
  f.library.items[0].content = "Rule changed";
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Rule changed");
  assert.equal(f.reads.filter((a) => a === "rules.list").length, 5);
});

test("model-specific rule precedes globally active rule, and model is read from agent options", async (t) => {
  const f = fixture(t, { enabled: true });
  f.library.items.push(
    { id: "global", content: "Global" },
    { id: "model", model: "synthetic-model", content: "Model-specific" },
  );
  f.library.activeId = "global";
  f.runtime.apply();
  assert.equal(
    (await f.ctx.systemPrompt.assemble({ model: "synthetic-model" })).sections[0].text,
    "Model-specific",
  );
  assert.equal(
    (await f.ctx.systemPrompt.assemble({ agent: { options: { model: "synthetic-model" } } }))
      .sections[0].text,
    "Model-specific",
  );
  assert.equal(
    (await f.ctx.systemPrompt.assemble({ model: "other-model" })).sections[0].text,
    "Global",
  );
});

test("automatic approval preserves perimeter audit and never grants a cancelled request", async (t) => {
  const f = fixture(t, { enabled: true });
  f.runtime.apply();
  assert.equal(f.ctx.approval.request, f.original.request);
  assert.equal(
    await f.ctx.approval.request({ signal: new AbortController().signal }),
    "allowed-once",
  );
  assert.deepEqual(f.audit, ["asked", ["decided", "allowed-once"]]);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await f.ctx.approval.request({ signal: controller.signal }), "cancelled");
  assert.deepEqual(f.audit.slice(-2), ["asked", ["decided", "cancelled"]]);
  f.settings.autoApprove = false;
  assert.equal(await f.ctx.approval.request({}), "rejected");
  f.settings.enabled = false;
  f.settings.autoApprove = true;
  assert.equal(await f.ctx.approval.request({}), "rejected");
});

test("sandbox changes only when enabled and fullAccess, preserving root and session attribution", (t) => {
  const f = fixture(t);
  f.runtime.apply();
  assert.equal(f.ctx.sandboxPolicy.resolve().mode, "read-only");
  f.settings.enabled = true;
  f.settings.fullAccess = false;
  assert.equal(f.ctx.sandboxPolicy.resolve().mode, "read-only");
  f.settings.fullAccess = true;
  assert.deepEqual(f.ctx.sandboxPolicy.resolve(), {
    mode: "danger-full-access",
    workspaceRoot: f.directory,
    sessionId: "synthetic",
  });
  f.settings.enabled = false;
  assert.equal(f.ctx.sandboxPolicy.resolve().mode, "read-only");
});

test("subagent settings resolve per call and restore host defaults when disabled", (t) => {
  const f = fixture(t, { enabled: true });
  f.runtime.apply();
  assert.equal(f.ctx.subagents.config.maxDepth.get(), 10);
  assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 16);
  f.settings.maxDepth = 7;
  f.settings.maxSubagents = 9;
  assert.equal(f.ctx.subagents.config.maxDepth.get(), 7);
  assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 9);
  f.settings.enabled = false;
  assert.equal(f.ctx.subagents.config.maxDepth.get(), 3);
  assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 4);
});

test("repeated apply and revert do not stack wrappers and restore original descriptors", async (t) => {
  const f = fixture(t, { enabled: true });
  f.runtime.apply();
  const first = f.ctx.systemPrompt.assemble;
  f.runtime.apply();
  assert.equal(f.ctx.systemPrompt.assemble, first);
  await f.ctx.systemPrompt.assemble({});
  assert.equal(f.originalCalls, 1);
  f.runtime.revert();
  f.runtime.revert();
  assert.equal(f.ctx.systemPrompt.assemble, f.original.assemble);
  assert.equal(f.ctx.approval.decide, f.original.decide);
  assert.equal(f.ctx.sandboxPolicy.resolve, f.original.resolve);
  assert.equal(f.ctx.subagents.config.maxDepth.get, f.original.depth);
  f.runtime.apply();
  assert.notEqual(f.ctx.systemPrompt.assemble, first);
  await f.ctx.systemPrompt.assemble({});
  assert.equal(f.originalCalls, 2);
});

test("unsupported host versions reject application without changing any service", (t) => {
  const f = fixture(t);
  const runtime = new DesktopRuntime(
    f.ctx,
    { dispatch: () => ({ value: f.settings }) },
    { supported: false, version: "unverified" },
  );
  assert.throws(() => runtime.apply(), /拒绝应用/);
  assert.ok(runtime.capabilities().every((c) => c.state === "unsupported"));
  assert.equal(f.ctx.systemPrompt.assemble, f.original.assemble);
});

test("partial application failure rolls back earlier replacements", (t) => {
  const f = fixture(t);
  Object.defineProperty(f.ctx.sandboxPolicy, "resolve", {
    value: f.original.resolve,
    configurable: false,
  });
  assert.throws(() => f.runtime.apply(), TypeError);
  assert.equal(f.runtime.enabled, false);
  assert.equal(f.ctx.systemPrompt.assemble, f.original.assemble);
  assert.equal(f.ctx.approval.decide, f.original.decide);
  assert.equal(f.ctx.sandboxPolicy.resolve, f.original.resolve);
});

test("explicit per-session restriction and approval choices outrank automatic defaults", async (t) => {
  const f = fixture(t, { enabled: true });
  f.ctx.sandboxPolicy.overrideOf = () => "workspace-write";
  f.ctx.approval.overrideOf = () => "never";
  f.runtime.apply();
  assert.equal(f.ctx.sandboxPolicy.resolve({ session: { id: "synthetic" } }).mode, "read-only");
  assert.equal(
    await f.ctx.approval.request({ agent: { session: { id: "synthetic" } } }),
    "rejected",
  );
  assert.equal(f.ctx.sandboxPolicy.resolve({ mode: "read-only" }).mode, "read-only");
});

test("strict skips selected rules and replacement retains functional tool sections", async (t) => {
  const f = fixture(t, {
    enabled: true,
    workspacePolicy: "strict",
    workspaceFiles: ["/missing/synthetic/AGENTS.md"],
  });
  f.assembly.sections.push({
    name: "tool:synthetic",
    text: "Use the synthetic tool as documented.",
  });
  f.runtime.apply();
  const result = await f.ctx.systemPrompt.assemble({
    agent: { session: { header: { cwd: f.directory } } },
  });
  assert.equal(result.sections[0].text, "Synthetic operator");
  assert.equal(result.sections[1], f.assembly.sections[1]);
});
