import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopRuntime } from "../src/host/runtime.js";
import { composePrompt } from "../src/core/prompts.js";
import { WorkspaceStore } from "../src/core/store.js";

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

for (const reapply of [false, true])
  test(`pending assembly stays revoked after revert${reapply ? " and reapply" : ""}`, async (t) => {
    const f = fixture(t, { enabled: true });
    t.mock.method(f.runtime.store, "dispatch", (action) => {
      f.reads.push(action);
      // Real WorkspaceStore reads deserialize a new settings snapshot each time.
      if (action === "settings.get") return { value: structuredClone(f.settings) };
      if (action === "rules.list") return structuredClone(f.library);
      throw new Error(`Unexpected action ${action}`);
    });
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let holding = false;
    f.ctx.systemPrompt.assemble = async () => {
      if (holding) await gate;
      return f.assembly;
    };
    const roleCalls = [];
    f.runtime.rolePrompt = (sessionId) => {
      roleCalls.push(sessionId);
      return "SYNTHETIC_ROLE";
    };
    const context = { agent: { session: { id: "synthetic-pending-session" } } };
    f.runtime.apply();
    const ordinary = await f.ctx.systemPrompt.assemble(context);
    assert.equal(ordinary.sections[0].text, f.settings.prompt);
    assert.equal(ordinary.sections.at(-1).text, "SYNTHETIC_ROLE");
    f.reads.length = 0;
    roleCalls.length = 0;
    holding = true;
    const pending = f.ctx.systemPrompt.assemble(context);
    f.settings.enabled = false;
    f.runtime.revert();
    if (reapply) {
      f.settings.prompt = "SYNTHETIC_REAPPLIED_PROMPT";
      f.settings.enabled = true;
      f.runtime.apply();
    }
    release();
    const output = await pending;
    assert.deepEqual(
      {
        originalAssembly: output === f.assembly,
        ruleReads: f.reads.filter((action) => action === "rules.list").length,
        roleCalls,
      },
      { originalAssembly: true, ruleReads: 0, roleCalls: [] },
      "A revoked invocation must finish without composing or consulting rules and roles",
    );
    if (reapply) {
      const current = await f.ctx.systemPrompt.assemble(context);
      assert.equal(current.sections[0].text, "SYNTHETIC_REAPPLIED_PROMPT");
      assert.equal(current.sections.at(-1).text, "SYNTHETIC_ROLE");
    }
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

test("replacement preserves functional and unknown sections without changing their text or order", (t) => {
  const f = fixture(t, { enabled: true });
  const persona = ["harness:identity", "deployment:persona-prefix", "deployment:persona-suffix"];
  const functional = [
    "tool:synthetic",
    "plan:policy",
    "tools:ptc-only",
    "tools:sdk",
    "mcp:synthetic",
    "mcp-resource-servers",
    "team:policy",
    "context:file-reference",
    "ui:deliverable-file-references",
    "synthetic:unknown",
  ].map((name, index) => ({ name, text: `Function ${index}: {{literal}}`, interpolate: false }));
  f.assembly.sections = [...persona.map((name) => ({ name, text: "Host persona" })), ...functional];
  const result = composePrompt(f.assembly, f.settings);
  assert.equal(result.sections[0].text, "Synthetic operator");
  assert.deepEqual(result.sections.slice(1), functional);
  functional.forEach((section, index) => assert.equal(result.sections[index + 1], section));
  for (const key of ["tools", "contexts", "variables", "metadata"])
    assert.equal(result[key], f.assembly[key], key);
  assert.equal(f.assembly.sections.length, 13);
  f.settings.promptMode = "append";
  const appended = composePrompt(f.assembly, f.settings);
  assert.deepEqual(appended.sections.slice(0, -1), f.assembly.sections);
  assert.equal(appended.sections.at(-1).text, "Synthetic operator");
});

test("runtime snapshots scoped complete metadata before assembly and skips the registry when disabled or appending", async (t) => {
  const f = fixture(t, { enabled: true });
  const scope = {};
  const definition = { name: "synthetic-complete", text: "Host", complete: true };
  const definitions = new Map([[definition.name, definition]]);
  const layer = { sections: {} };
  const calls = [];
  f.assembly.sections = [{ name: definition.name, text: definition.text }];
  f.ctx.systemPrompt.layers = {
    merge(key, select) {
      assert.equal(key, scope);
      assert.equal(select(layer), layer.sections);
      calls.push("metadata");
      return definitions;
    },
  };
  f.ctx.systemPrompt.assemble = async () => {
    calls.push("assemble");
    return f.assembly;
  };
  f.runtime.apply();
  const result = await f.ctx.systemPrompt.assemble({ scope });
  assert.deepEqual(calls, ["metadata", "assemble"]);
  assert.deepEqual(
    result.sections.map((section) => section.text),
    ["Synthetic operator"],
  );
  assert.equal(definitions.get(definition.name), definition);
  f.settings.enabled = false;
  assert.equal(await f.ctx.systemPrompt.assemble({ scope }), f.assembly);
  f.settings.enabled = true;
  f.settings.promptMode = "append";
  assert.equal((await f.ctx.systemPrompt.assemble({ scope })).sections[0], f.assembly.sections[0]);
  assert.deepEqual(calls, ["metadata", "assemble", "assemble", "assemble"]);
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

test("persisted activation switches same-model rules and cannot leak them to another model", async (t) => {
  const f = fixture(t);
  const originalStore = f.runtime.store;
  const store = new WorkspaceStore(join(f.directory, "synthetic-rules.sqlite"));
  f.runtime.store = store;
  try {
    const initial = store.dispatch("settings.get");
    store.dispatch("settings.save", {
      revision: initial.revision,
      value: { ...initial.value, enabled: true, prompt: "Saved operator" },
    });
    const save = (name, content, model) =>
      store.dispatch("rules.save", { name, content, model }).item;
    const first = save("First", "RULE_A", "model-M");
    const second = save("Second", "RULE_B", "model-M");
    const global = save("Global", "GLOBAL_RULE", "");
    const compose = async (model) =>
      (await f.ctx.systemPrompt.assemble({ agent: { options: { model } } })).sections[0].text;
    f.runtime.apply();
    store.dispatch("rules.activate", { id: first.id });
    assert.equal(await compose("model-M"), "RULE_A");
    store.dispatch("rules.save", { ...first, content: "RULE_A_EDITED" });
    assert.equal(await compose("model-M"), "RULE_A_EDITED");
    store.dispatch("rules.activate", { id: second.id });
    assert.equal(store.dispatch("rules.list").activeId, second.id);
    assert.equal(await compose("model-M"), "RULE_B");
    store.dispatch("rules.save", { ...second, content: "RULE_B_EDITED" });
    assert.equal(await compose("model-M"), "RULE_B_EDITED");
    assert.equal(await compose("model-N"), "Saved operator");
    assert.equal(await compose(undefined), "Saved operator");
    store.dispatch("rules.activate", { id: global.id });
    assert.equal(await compose("model-M"), "RULE_A_EDITED");
    assert.equal(await compose("model-N"), "GLOBAL_RULE");
    f.runtime.revert();
    assert.equal(await f.ctx.systemPrompt.assemble({ model: "model-M" }), f.assembly);
    assert.equal(store.dispatch("rules.list").items.length, 3);
  } finally {
    f.runtime.revert();
    f.runtime.store = originalStore;
    store.close();
  }
});

test("an active rule for another model does not suppress that model's workspace fallback", async (t) => {
  const f = fixture(t, { enabled: true, prompt: "" });
  const path = join(f.directory, "AGENTS.md");
  writeFileSync(path, "WORKSPACE_FOR_OTHER_MODEL");
  f.settings.workspaceFiles = [path];
  f.library.items.push({ id: "specific", model: "model-M", content: "ONLY_MODEL_M" });
  f.library.activeId = "specific";
  const agent = {
    options: { model: "model-N" },
    session: { header: { cwd: f.directory } },
  };
  f.runtime.apply();
  assert.equal(
    (await f.ctx.systemPrompt.assemble({ agent })).sections[0].text,
    "WORKSPACE_FOR_OTHER_MODEL",
  );
  assert.equal(f.runtime.nativeInstructions.policy(agent), false);
  agent.options.model = "model-M";
  assert.equal((await f.ctx.systemPrompt.assemble({ agent })).sections[0].text, "ONLY_MODEL_M");
  assert.equal(f.runtime.nativeInstructions.policy(agent), true);
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

test("fallback ignores unavailable selected paths when an effective prompt or rule is present", async (t) => {
  const f = fixture(t, {
    enabled: true,
    workspacePolicy: "fallback",
    workspaceFiles: ["/missing/synthetic/AGENTS.md"],
  });
  const context = { agent: { session: { header: { cwd: f.directory } } } };
  f.runtime.apply();
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "Synthetic operator");
  f.settings.prompt = " \t";
  f.library.items.push({ id: "active", content: "SYNTHETIC_RULE" });
  f.library.activeId = "active";
  assert.equal((await f.ctx.systemPrompt.assemble(context)).sections[0].text, "SYNTHETIC_RULE");
  f.library.items[0].content = "\n";
  await assert.rejects(f.ctx.systemPrompt.assemble(context), { code: "RULE_NOT_FOUND" });
});

function retainedControls(f) {
  const decide = f.ctx.approval.decide;
  const resolve = f.ctx.sandboxPolicy.resolve;
  const depth = f.ctx.subagents.config.maxDepth;
  const count = f.ctx.subagents.config.maxActiveSubagents;
  return {
    approval: (...args) => decide.apply(f.ctx.approval, args),
    sandbox: (...args) => resolve.apply(f.ctx.sandboxPolicy, args),
    depth: () => depth.get(),
    count: () => count.get(),
  };
}
async function expectNativeControls(saved, f) {
  assert.equal(await saved.approval({}), "rejected");
  assert.deepEqual(saved.sandbox(), {
    mode: "read-only",
    workspaceRoot: f.directory,
    sessionId: "synthetic",
  });
  assert.equal(saved.depth(), 3);
  assert.equal(saved.count(), 4);
}

for (const externalOwner of [false, true])
  test(`revoked permission and limit references stay inert${externalOwner ? " inside later owners" : " after normal disposal"}`, async (t) => {
    const f = fixture(t, { enabled: true });
    f.runtime.apply();
    const saved = retainedControls(f);
    let outer;
    if (externalOwner) {
      outer = {
        decide: (...args) => saved.approval(...args),
        resolve: (...args) => saved.sandbox(...args),
        depth: { get: () => saved.depth() },
        count: { get: () => saved.count() },
      };
      f.ctx.approval.decide = outer.decide;
      f.ctx.sandboxPolicy.resolve = outer.resolve;
      f.ctx.subagents.config.maxDepth = outer.depth;
      f.ctx.subagents.config.maxActiveSubagents = outer.count;
      assert.throws(() => f.runtime.revert(), AggregateError);
      assert.equal(f.ctx.approval.decide, outer.decide);
      assert.equal(f.ctx.sandboxPolicy.resolve, outer.resolve);
      assert.equal(f.ctx.subagents.config.maxDepth, outer.depth);
      assert.equal(f.ctx.subagents.config.maxActiveSubagents, outer.count);
    } else f.runtime.revert();
    // Lifecycle disposal preserves the durable enabled setting for autoReapply.
    // Retained callbacks must use native behavior even before the store closes.
    await expectNativeControls(saved, f);
    t.mock.method(f.runtime.store, "dispatch", () => {
      throw new Error("Synthetic store is closed");
    });
    await expectNativeControls(saved, f);
  });

test("reactivation cannot revive permission or limit callbacks from a previous activation", async (t) => {
  const f = fixture(t, { enabled: true });
  f.runtime.apply();
  const previous = retainedControls(f);
  f.runtime.revert();
  f.settings.maxDepth = 6;
  f.settings.maxSubagents = 7;
  f.runtime.apply();
  const reads = f.reads.length;
  await expectNativeControls(previous, f);
  assert.equal(f.reads.length, reads, "obsolete callbacks must not read new configuration");
  assert.equal(await f.ctx.approval.decide({}), "allowed-once");
  assert.equal(f.ctx.sandboxPolicy.resolve().mode, "danger-full-access");
  assert.equal(f.ctx.subagents.config.maxDepth.get(), 6);
  assert.equal(f.ctx.subagents.config.maxActiveSubagents.get(), 7);
});

test("sandbox resolution does not apply full access if native resolution revokes the activation", (t) => {
  const f = fixture(t, { enabled: true });
  const native = { mode: "read-only", workspaceRoot: f.directory, sessionId: "synthetic" };
  f.ctx.sandboxPolicy.resolve = function (request) {
    assert.equal(this, f.ctx.sandboxPolicy);
    assert.equal(request.marker, "synthetic-request");
    f.runtime.revert();
    return native;
  };
  f.runtime.apply();
  const resolve = f.ctx.sandboxPolicy.resolve;
  assert.equal(resolve.call(f.ctx.sandboxPolicy, { marker: "synthetic-request" }), native);
});

test("failed activation invalidates permission wrappers retained during setup", async (t) => {
  const f = fixture(t, { enabled: true });
  let saved;
  f.runtime.nativeInstructions.apply = () => {
    saved = retainedControls(f);
    throw new Error("Synthetic setup failed");
  };
  assert.throws(() => f.runtime.apply(), /Synthetic setup failed/);
  assert.equal(f.runtime.enabled, false);
  t.mock.method(f.runtime.store, "dispatch", () => {
    throw new Error("Synthetic store is closed");
  });
  await expectNativeControls(saved, f);
});

test("terminal inspection keeps exact owner identities and never infers startup policy or plugin ownership", (t) => {
  const f = fixture(t);
  const owners = [{ id: "one" }, { id: "two" }, { id: "pending" }, { id: "no-terminal-preset" }];
  f.ctx.agents = { list: () => owners };
  const seen = [];
  const registry = {
    list(owner) {
      seen.push(owner);
      return owner === owners[2]
        ? []
        : [
            {
              sessionId: "pty-1",
              status: { kind: "running" },
              pid: 123,
              motd: "SECRET_OUTPUT",
              name: "PRIVATE_NAME",
              startupMode: "danger-full-access",
            },
          ];
    },
    hasOwnerActivity(owner) {
      assert.equal(owner, owners[2]);
      return true;
    },
    kill() {
      assert.fail("Read-only inspection must never close a terminal");
    },
  };
  f.ctx.agentPresets = {
    serviceFor(owner, name) {
      assert.equal(name, "terminals");
      return owner === owners[3] ? undefined : registry;
    },
  };
  f.runtime.apply();
  f.settings.enabled = true;
  assert.equal(f.ctx.sandboxPolicy.resolve().mode, "danger-full-access");
  const result = f.runtime.terminalStatus();
  assert.equal(result.available, true);
  assert.equal(result.scannedAgents, 4);
  assert.deepEqual(seen, owners.slice(0, 3));
  assert.deepEqual(result.pendingOwners, ["pending"]);
  assert.deepEqual(
    result.terminals,
    owners.slice(0, 2).map((owner) => ({
      agentId: owner.id,
      terminalId: "pty-1",
      state: "running",
      startupMode: "unknown",
      elevatedByPlugin: "unknown",
    })),
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET_OUTPUT|PRIVATE_NAME|123|danger-full-access/);
});

test("terminal inspection distinguishes unavailable, failed and verified empty inventories", (t) => {
  const f = fixture(t);
  assert.equal(f.runtime.terminalStatus().available, false);
  f.ctx.agents = { list: () => [] };
  f.ctx.agentPresets = { serviceFor: () => undefined };
  const empty = f.runtime.terminalStatus();
  assert.equal(empty.available, true);
  assert.deepEqual(empty.terminals, []);
  assert.equal(empty.scannedAgents, 0);
  f.ctx.agents.list = () => [{ id: "synthetic" }];
  f.ctx.agentPresets.serviceFor = () => ({
    list() {
      throw new Error("Synthetic inventory failure");
    },
    hasOwnerActivity() {
      return true;
    },
  });
  const failed = f.runtime.terminalStatus();
  assert.equal(failed.available, false);
  assert.match(failed.detail, /Synthetic inventory failure/);
  assert.equal(failed.terminals, undefined);
});
