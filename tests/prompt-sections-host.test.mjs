import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { DesktopRuntime } from "../src/host/runtime.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for official prompt-section isolation; no profile is read",
  timeout: 10000,
};
let official;
async function loadOfficial() {
  official ??= (async () => {
    const root = realpathSync(runtimeRoot);
    const inventory = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
    assert.equal(inventory.release.version, "0.2.1-rc.2");
    const requireHost = createRequire(join(root, "package.json"));
    const names = {
      cordis: "@deepseek-ai/cordis",
      prompt: "@deepseek-ai/dsh-system-prompt",
      tools: "@deepseek-ai/dsh-tools",
      plan: "@deepseek-ai/dsh-plan-mode",
      sessions: "@deepseek-ai/dsh-session",
      projections: "@deepseek-ai/dsh-session-projection",
      scope: "@deepseek-ai/dsh-scope",
    };
    return Object.fromEntries(
      await Promise.all(
        Object.entries(names).map(async ([key, name]) => {
          const path = requireHost.resolve(name);
          const row = inventory.files.find((item) => item.path === relative(root, path));
          assert.ok(row, `Official inventory must include ${name}`);
          assert.equal(
            createHash("sha256").update(readFileSync(path)).digest("hex"),
            row.sha256,
            `Modified official entry cannot count as clean evidence: ${name}`,
          );
          return [key, await import(pathToFileURL(path).href)];
        }),
      ),
    );
  })();
  return official;
}

const functionSections = [
  ["mcp:synthetic-source", "SYNTHETIC_MCP_INSTRUCTIONS"],
  ["mcp-resource-servers", "SYNTHETIC_MCP_RESOURCE_DIRECTORY"],
  ["context:file-reference", "SYNTHETIC_FILE_REFERENCE_GUIDANCE"],
  ["ui:deliverable-file-references", "SYNTHETIC_DELIVERABLE_GUIDANCE"],
  ["team:policy", "SYNTHETIC_TEAM_GUIDANCE"],
  ["third-party:unknown-guidance", "SYNTHETIC_UNKNOWN_GUIDANCE"],
];
const section = (assembly, name) => assembly.sections.find((item) => item.name === name);
const names = (assembly) => assembly.sections.map((item) => item.name);

async function fixture(t) {
  const denied = [],
    executed = [];
  const deny = (name) => () => {
    denied.push(name);
    throw new Error(`Prompt isolation forbids ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("datagram.bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("datagram.send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  syncBuiltinESMExports();
  let directory, ctx, owner, runtime;
  const scopes = [];
  t.after(async () => {
    try {
      runtime?.revert();
      for (const scope of scopes.reverse()) await scope.dispose();
      await owner?.dispose();
      await ctx?.fiber.dispose();
      assert.deepEqual(denied, [], "No network or subprocess attempt is permitted");
      assert.deepEqual(executed, [], "Neither synthetic tools nor run_code may execute");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
  const api = await loadOfficial();
  directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-prompt-sections-")));
  ctx = new api.cordis.Context();
  const observed = [];
  owner = ctx.plugin({
    name: "synthetic-prompt-section-foundation",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: true,
        includeRuntimeContext: true,
        personaPrefix: "SYNTHETIC_HOST_PREFIX",
        personaSuffix: "SYNTHETIC_HOST_SUFFIX",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.tools.ToolRuntime(scope, { mode: "native" });
      // This descriptor permits official SDK/schema rendering only. It offers no execution method.
      const ptc = new api.cordis.Service(scope, "ptcRuntime");
      ptc.language = "typescript";
      ptc.programFormat = "function-body";
      const approval = new api.cordis.Service(scope, "approval");
      approval.decide = async () => "rejected";
      const sandbox = new api.cordis.Service(scope, "sandboxPolicy");
      sandbox.resolve = () => ({ mode: "read-only", workspaceRoot: directory });
      scope.tools.register(
        api.tools.defineTool({
          name: "fixture_evidence",
          description:
            "Inspect an explicitly supplied synthetic evidence identifier; this acceptance never executes it.",
          parameters: { reference: { type: "string", required: true } },
          output: {
            schema: { type: "json" },
            render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
          },
          execute() {
            executed.push("fixture_evidence");
            throw new Error("Rendering-only fixture must not execute tools");
          },
        }),
      );
      new api.plan.PlanModeController(scope, { section: "SYNTHETIC_PLAN_POLICY" });
      for (const [name, text] of functionSections)
        scope.systemPrompt.section({ name, order: 4000, interpolate: false, text });
      scope.systemPrompt.context({
        name: "fixture:runtime",
        order: 1,
        text: "SYNTHETIC_RUNTIME_CONTEXT",
      });
      scope.systemPrompt.context({
        name: "fixture:required",
        order: 2,
        required: true,
        text: "SYNTHETIC_REQUIRED_CONTEXT",
      });
      scope.systemPrompt.variable("fixture_value", () => "SYNTHETIC_VARIABLE");
      scope.systemPrompt.section({
        name: "fixture:variable-guidance",
        order: 4100,
        text: "Fixture value {{fixture_value}}",
      });
      scope.on("system-prompt/assemble", async (_assembly, _context, next) => {
        const output = await next();
        observed.push({ output, before: structuredClone(output) });
        return output;
      });
    },
  });
  await owner.await();
  assert.equal(owner.state, 2, "All required official services must be active");
  const settings = {
    enabled: true,
    prompt: "SYNTHETIC_OPERATOR",
    promptMode: "replace",
    workspacePolicy: "strict",
    workspaceFiles: [],
    autoApprove: false,
    fullAccess: false,
    maxDepth: 2,
    maxSubagents: 2,
  };
  const store = {
    dispatch(action) {
      if (action === "settings.get") return { value: settings };
      if (action === "rules.list") return { items: [], activeId: null };
      throw new Error(`Unexpected local action: ${action}`);
    },
  };
  runtime = new DesktopRuntime(ctx, store, { supported: true, version: "0.2.1-rc.2", runtimeRoot });
  function agent(id, parent) {
    const session = ctx.sessions.create(id, {
      meta: { cwd: directory, ...(parent ? { parentSession: parent.session.id } : {}) },
    });
    const agent = { id, session, options: { model: "synthetic-model" } };
    const scope = api.scope.createScope(owner.ctx, agent, parent ? { parent } : undefined);
    scopes.push(scope);
    agent.ctx = scope.ctx;
    return { agent, scope };
  }
  const parent = agent("synthetic-parent");
  const context = (agent = parent.agent) => ({
    agent,
    scope: agent,
    signal: new AbortController().signal,
  });
  const assemble = (agent) => ctx.systemPrompt.assemble(context(agent));
  const preserved = (assembly) => {
    const captured = observed.at(-1);
    assert.deepEqual(
      captured.output,
      captured.before,
      "The accepted official assembly must not be mutated",
    );
    for (const key of ["tools", "contexts", "variables"])
      assert.equal(assembly[key], captured.output[key], `Preserve original ${key} reference`);
  };
  return {
    api,
    ctx,
    owner,
    runtime,
    settings,
    store,
    observed,
    parent,
    agent,
    context,
    assemble,
    preserved,
    executed,
  };
}

test(
  "real native/PTC presentation and plan projection retain functional sections while persona is replaced",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const baseline = await f.assemble();
    assert.ok(baseline.tools.some((item) => item.name === "fixture_evidence"));
    assert.ok(!baseline.tools.some((item) => item.name === "run_code"));
    assert.equal(section(baseline, "plan:policy").text, "");
    f.parent.agent.session.append("plan/mode", { active: true });
    assert.equal(f.ctx.planMode.get(f.parent.agent).active, true);
    const ptc = f.parent.agent.ctx.tools.presentAs("ptc");
    const originalPtc = await f.assemble();
    assert.deepEqual(
      originalPtc.tools.map((item) => item.name),
      ["run_code"],
    );
    assert.ok(section(originalPtc, "tools:ptc-only").text.length > 0);
    assert.match(section(originalPtc, "tools:sdk").text, /fixture_evidence/);
    f.runtime.apply();
    const composed = await f.assemble();
    f.preserved(composed);
    assert.deepEqual(
      composed.sections.slice(1),
      originalPtc.sections.filter(
        (item) =>
          !["harness:identity", "deployment:persona-prefix", "deployment:persona-suffix"].includes(
            item.name,
          ),
      ),
      "Retained functional definitions and ordering must remain exact",
    );
    assert.deepEqual(composed.tools, originalPtc.tools);
    assert.deepEqual(composed.contexts, originalPtc.contexts);
    assert.deepEqual(composed.variables, originalPtc.variables);
    for (const name of ["tools:ptc-only", "tools:sdk", "plan:policy"])
      assert.equal(section(composed, name).text, section(originalPtc, name).text);
    const rendered = f.api.prompt.renderPrompt(composed);
    assert.ok(rendered.includes("SYNTHETIC_PLAN_POLICY"));
    assert.ok(rendered.includes("fixture_evidence"));
    assert.ok(rendered.includes("SYNTHETIC_OPERATOR"));
    assert.ok(rendered.includes("SYNTHETIC_VARIABLE"));
    for (const [name, text] of functionSections) {
      assert.ok(names(composed).includes(name));
      assert.ok(rendered.includes(text));
    }
    for (const name of [
      "harness:identity",
      "deployment:persona-prefix",
      "deployment:persona-suffix",
    ])
      assert.ok(!names(composed).includes(name));
    ptc();
    f.parent.agent.session.append("plan/mode", { active: false });
    assert.equal(f.ctx.planMode.get(f.parent.agent).active, false);
    const native = await f.assemble();
    assert.ok(native.tools.some((item) => item.name === "fixture_evidence"));
    assert.ok(!native.tools.some((item) => item.name === "run_code"));
    assert.ok(!names(native).includes("tools:sdk"));
    assert.ok(!f.api.prompt.renderPrompt(native).includes("SYNTHETIC_PLAN_POLICY"));
    f.preserved(native);
  },
);

test(
  "scoped native child overrides real parent PTC presentation and disposal restores its inherited SDK",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const child = f.agent("synthetic-child", f.parent.agent);
    const parentPtc = f.parent.agent.ctx.tools.presentAs("ptc");
    const childNative = child.agent.ctx.tools.presentAs("native");
    f.runtime.apply();
    const parent = await f.assemble(f.parent.agent),
      native = await f.assemble(child.agent);
    assert.deepEqual(
      parent.tools.map((item) => item.name),
      ["run_code"],
    );
    assert.ok(section(parent, "tools:sdk").text.length > 0);
    assert.ok(native.tools.some((item) => item.name === "fixture_evidence"));
    assert.equal(section(native, "tools:sdk").text, "");
    childNative();
    const inherited = await f.assemble(child.agent);
    assert.deepEqual(
      inherited.tools.map((item) => item.name),
      ["run_code"],
    );
    assert.match(section(inherited, "tools:sdk").text, /fixture_evidence/);
    parentPtc();
    assert.ok(!names(await f.assemble(child.agent)).includes("tools:sdk"));
  },
);

test(
  "complete definitions survive only in the registry; replace removes the rendered complete without rebuilding suppressed functionality",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const remove = f.owner.ctx.systemPrompt.section({
      name: "synthetic:whole-prompt",
      order: 100,
      complete: true,
      text: "SYNTHETIC_COMPLETE_PROMPT",
    });
    const original = await f.assemble();
    assert.deepEqual(names(original), ["synthetic:whole-prompt"]);
    assert.equal(
      Object.hasOwn(original.sections[0], "complete"),
      false,
      "Official rendered metadata omits complete",
    );
    const definitions = f.ctx.systemPrompt.layers.merge(f.parent.agent, (layer) => layer.sections);
    const definition = definitions.get("synthetic:whole-prompt");
    assert.equal(definition.complete, true);
    f.runtime.apply();
    const composed = await f.assemble();
    assert.deepEqual(names(composed), ["dsh-unlimit/operator"]);
    assert.equal(f.api.prompt.renderPrompt(composed), "SYNTHETIC_OPERATOR");
    assert.equal(
      f.ctx.systemPrompt.layers
        .merge(f.parent.agent, (layer) => layer.sections)
        .get("synthetic:whole-prompt"),
      definition,
    );
    assert.equal(definition.complete, true, "The definition is neither mutated nor unregistered");
    f.preserved(composed);
    remove();
    const restoredFunctions = await f.assemble();
    assert.ok(names(restoredFunctions).includes("third-party:unknown-guidance"));
  },
);

test(
  "effective complete detection follows parent/child same-name shadows and their exact disposers",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const child = f.agent("synthetic-child", f.parent.agent);
    const global = f.owner.ctx.systemPrompt.section({
      name: "synthetic:shared-slot",
      order: 300,
      complete: true,
      text: "SYNTHETIC_GLOBAL_COMPLETE",
    });
    const parent = f.parent.agent.ctx.systemPrompt.section({
      name: "synthetic:shared-slot",
      order: 300,
      complete: false,
      text: "SYNTHETIC_PARENT_FUNCTION",
    });
    const scoped = child.agent.ctx.systemPrompt.section({
      name: "synthetic:shared-slot",
      order: 300,
      complete: true,
      text: "SYNTHETIC_CHILD_COMPLETE",
    });
    f.runtime.apply();
    const parentOutput = await f.assemble(f.parent.agent);
    assert.equal(section(parentOutput, "synthetic:shared-slot").text, "SYNTHETIC_PARENT_FUNCTION");
    assert.ok(names(parentOutput).includes("context:file-reference"));
    assert.deepEqual(names(await f.assemble(child.agent)), ["dsh-unlimit/operator"]);
    scoped();
    const inheritedParent = await f.assemble(child.agent);
    assert.equal(
      section(inheritedParent, "synthetic:shared-slot").text,
      "SYNTHETIC_PARENT_FUNCTION",
    );
    assert.ok(names(inheritedParent).includes("context:file-reference"));
    parent();
    assert.deepEqual(names(await f.assemble(child.agent)), ["dsh-unlimit/operator"]);
    f.runtime.revert();
    const original = await f.assemble(child.agent);
    assert.deepEqual(names(original), ["synthetic:shared-slot"]);
    assert.equal(f.api.prompt.renderPrompt(original), "SYNTHETIC_GLOBAL_COMPLETE");
    global();
  },
);

test(
  "disabled and append keep original complete semantics and avoid the extra registry snapshot; revert restores descriptors",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    f.owner.ctx.systemPrompt.section({
      name: "synthetic:complete",
      order: 300,
      complete: true,
      text: "SYNTHETIC_ORIGINAL_COMPLETE",
    });
    const promptService = f.ctx.get("systemPrompt"),
      approval = f.ctx.get("approval"),
      sandbox = f.ctx.get("sandboxPolicy");
    const originals = [promptService, approval, sandbox].map((service, index) =>
      Object.getOwnPropertyDescriptor(service, ["assemble", "decide", "resolve"][index]),
    );
    const layers = promptService.layers;
    const originalMerge = layers.merge;
    const calls = [];
    t.mock.method(layers, "merge", function (...args) {
      calls.push(args[0]);
      return originalMerge.apply(this, args);
    });
    const count = async () => {
      calls.length = 0;
      const assembly = await f.assemble();
      return { assembly, calls: calls.length };
    };
    const ordinary = await count();
    f.settings.enabled = false;
    f.runtime.apply();
    const disabled = await count();
    assert.equal(disabled.calls, ordinary.calls);
    assert.deepEqual(disabled.assembly, ordinary.assembly);
    assert.equal(
      f.observed.at(-1).output.sections.some((item) => item.name === "harness:identity"),
      true,
    );
    f.settings.enabled = true;
    f.settings.promptMode = "append";
    const append = await count();
    assert.equal(append.calls, ordinary.calls);
    assert.deepEqual(names(append.assembly), ["synthetic:complete", "dsh-unlimit/operator"]);
    assert.ok(f.api.prompt.renderPrompt(append.assembly).includes("SYNTHETIC_ORIGINAL_COMPLETE"));
    assert.ok(
      !names(append.assembly).includes("context:file-reference"),
      "Do not rebuild functions already suppressed by official complete semantics",
    );
    f.preserved(append.assembly);
    f.settings.promptMode = "replace";
    const replacement = await count();
    assert.equal(
      replacement.calls,
      ordinary.calls + 1,
      "Only enabled replace takes the extra effective-definition snapshot",
    );
    assert.deepEqual(names(replacement.assembly), ["dsh-unlimit/operator"]);
    f.runtime.revert();
    for (const [index, service] of [promptService, approval, sandbox].entries())
      assert.deepEqual(
        Object.getOwnPropertyDescriptor(service, ["assemble", "decide", "resolve"][index]),
        originals[index],
      );
    const reverted = await count();
    assert.equal(reverted.calls, ordinary.calls);
    assert.deepEqual(reverted.assembly, ordinary.assembly);
  },
);
