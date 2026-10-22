import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HostCatalog } from "../src/host/catalog.js";
import { SkillLibrary } from "../src/core/skills.js";
import { Toolkit } from "../src/core/toolkit.js";
import { connectSkills } from "../src/host/skills.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME to an official 0.2.1-rc.2 runtime; no profile is loaded",
  timeout: 10000,
};
async function fixture(t) {
  const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(descriptor.release.version, "0.2.1-rc.2");
  const require = createRequire(join(runtimeRoot, "package.json"));
  const load = async (name) => {
    const filename = require.resolve(name);
    const entry = descriptor.files.find((item) => item.path === relative(runtimeRoot, filename));
    assert.ok(entry, `${name} entry must be in the official inventory`);
    assert.equal(
      createHash("sha256").update(readFileSync(filename)).digest("hex"),
      entry.sha256,
      `${name} entry differs from the official inventory`,
    );
    return import(pathToFileURL(filename).href);
  };
  const [cordis, prompt, skills, tools, scope, mcp] = await Promise.all([
    load("@deepseek-ai/cordis"),
    load("@deepseek-ai/dsh-system-prompt"),
    load("@deepseek-ai/dsh-skill"),
    load("@deepseek-ai/dsh-tools"),
    load("@deepseek-ai/dsh-scope"),
    load("@deepseek-ai/dsh-mcp-client"),
  ]);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-catalog-host-")));
  const library = new SkillLibrary(join(directory, "library"));
  library.dispatch("skills.save", {
    id: "project-synthetic",
    name: "project-synthetic",
    description: "Synthetic project skill",
    content: "Original synthetic project body.",
  });
  const entries = new Map();
  const metadata = new Map();
  const toolkit = new Toolkit({
    meta: (key, fallback) => (metadata.has(key) ? metadata.get(key) : fallback),
    setMeta: (key, value) => metadata.set(key, value),
  });
  const ctx = new cordis.Context();
  const scoped = [];
  const owner = ctx.plugin({
    name: "synthetic-catalog-foundation",
    apply(inner) {
      new prompt.SystemPrompt(inner, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new tools.ToolRuntime(inner);
      new skills.SkillRegistry(inner);
      const registry = new cordis.Service(inner, "agents");
      registry.get = (id) => entries.get(id);
    },
  });
  t.after(async () => {
    try {
      for (const item of scoped.reverse()) await item.dispose();
      await owner.dispose();
      await ctx.fiber.dispose();
      await toolkit.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await owner.await();
  const providerOwner = ctx.plugin({
    name: "synthetic-project-catalog",
    inject: ["skills"],
    apply: (inner) => {
      connectSkills(inner, library);
    },
  });
  scoped.push(providerOwner);
  await providerOwner.await();
  const agent = (id) => {
    const value = { id, session: { id, header: { cwd: directory } } };
    const owned = scope.createScope(ctx, value);
    scoped.push(owned);
    value.ctx = owned.ctx;
    entries.set(id, value);
    return value;
  };
  const define = (name) =>
    tools.defineTool({
      name,
      description: `Synthetic ${name}`,
      parameters: {},
      output: { schema: { type: "json" }, render: () => [] },
      execute: () => assert.fail("catalog must never execute synthetic tools"),
    });
  const skill = (name, content, extra = {}) => ({
    name,
    description: `Synthetic ${name}`,
    content,
    source: "runtime",
    invocation: { modelInvocable: true, userInvocable: true },
    ...extra,
  });
  return {
    ctx,
    agent,
    skill,
    define,
    tools,
    mcp,
    library,
    toolkit,
    directory,
    catalog: new HostCatalog(ctx, { library, toolkit }),
  };
}

test(
  "official scoped skills retain directory resource authority and deliver only selected host text",
  hostOnly,
  async (t) => {
    const { ctx, agent, skill, directory, catalog } = await fixture(t);
    const globalRoot = join(directory, "global-resources");
    const scopedRoot = join(directory, "scoped-resources");
    for (const root of [globalRoot, scopedRoot])
      mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(join(globalRoot, "references/check.md"), "GLOBAL_SYNTHETIC_REFERENCE");
    writeFileSync(join(scopedRoot, "references/check.md"), "SCOPED_SYNTHETIC_REFERENCE");
    const first = agent("resource-first");
    const second = agent("resource-second");
    const extra = (path) => ({
      resourceBase: { kind: "directory", path },
      metadata: { "dsh-unlimit": { requirements: [] } },
    });
    ctx.get("skills").register(skill("resource-skill", "GLOBAL_BODY", extra(globalRoot)));
    first.ctx.get("skills").register(skill("resource-skill", "SCOPED_BODY", extra(scopedRoot)));
    const ref = { origin: "host", id: "resource-skill", resources: ["references/check.md"] };
    for (const [current, body, resource] of [
      [first, "SCOPED_BODY", "SCOPED_SYNTHETIC_REFERENCE"],
      [second, "GLOBAL_BODY", "GLOBAL_SYNTHETIC_REFERENCE"],
    ]) {
      const listed = await catalog.list({ sessionId: current.id });
      const entry = listed.skills.find((item) => item.origin === "host" && item.id === ref.id);
      assert.deepEqual(entry.resources, [
        { path: "references/check.md", bytes: Buffer.byteLength(resource) },
      ]);
      assert.equal(entry.resourceStatus.state, "available");
      assert.doesNotMatch(JSON.stringify(listed), /SYNTHETIC_REFERENCE/);
      const prepared = await catalog.preflight(
        { sessionId: current.id, skills: [ref] },
        { includeContent: true },
      );
      assert.equal(prepared.status, "ready");
      assert.equal(prepared.skillBodies[0].content, body);
      assert.equal(prepared.skillBodies[0].resources[0].content, resource);
      assert.equal(prepared.skillBodies[0].origin, "host");
    }
  },
);

test(
  "official SkillRegistry/ToolRuntime preserve session layers, restriction and scoped shadowing",
  hostOnly,
  async (t) => {
    const { ctx, agent, skill, define, catalog } = await fixture(t);
    ctx.get("tools").register(define("global_tool"));
    ctx.get("tools").register(define("hidden_tool"));
    ctx.get("skills").register(skill("same-skill", "global body"));
    const first = agent("catalog-first");
    const second = agent("catalog-second");
    first.ctx.get("skills").register(
      skill("same-skill", "first scoped body", {
        invocation: { userInvocable: false, modelInvocable: true },
      }),
    );
    first.ctx.get("tools").register(define("first_tool"));
    first.ctx.get("tools").restrict({ deny: ["hidden_tool"] });
    second.ctx.get("tools").register(define("second_tool"));
    const one = await catalog.list({ sessionId: first.session.id });
    const two = await catalog.list({ sessionId: second.session.id });
    assert.deepEqual(one.tools.map((item) => item.name).sort(), ["first_tool", "global_tool"]);
    assert.deepEqual(two.tools.map((item) => item.name).sort(), [
      "global_tool",
      "hidden_tool",
      "second_tool",
    ]);
    assert.equal(
      one.skills.find((item) => item.origin === "host" && item.name === "same-skill").invocation
        .userInvocable,
      false,
    );
    assert.equal(
      (await catalog.read({ sessionId: first.session.id, origin: "host", id: "same-skill" })).item
        .content,
      "first scoped body",
    );
    assert.equal(
      (await catalog.read({ sessionId: second.session.id, origin: "host", id: "same-skill" })).item
        .content,
      "global body",
    );
    assert.equal(
      (await catalog.read({ sessionId: first.session.id, origin: "host", id: "project-synthetic" }))
        .item.content,
      "Original synthetic project body.",
    );
    const preflight = await catalog.preflight({
      sessionId: first.session.id,
      skills: [{ origin: "host", id: "same-skill" }],
    });
    assert.equal(
      preflight.status,
      "unknown",
      "official body readability must not manufacture dependency availability",
    );
    assert.equal(preflight.skills[0].readStatus, "readable");
    assert.equal(preflight.executionAuthorized, false);
  },
);

test(
  "official MCP bridge schemas are observed without connecting/calling and declaration metadata remains explicit",
  hostOnly,
  async (t) => {
    const { ctx, agent, skill, mcp, catalog } = await fixture(t);
    const first = agent("catalog-mcp");
    const definition = mcp.createMcpToolDefinition(ctx, {
      name: "mcp__synthetic__lookup",
      rawName: "lookup",
      description: "Synthetic in-memory MCP bridge",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: () => assert.fail("No MCP request may be sent"),
    });
    first.ctx.get("tools").register(definition);
    first.ctx.get("skills").register(
      skill("declared-skill", "No command is run", {
        metadata: {
          "dsh-unlimit": { requirements: [{ kind: "tool", name: "mcp__synthetic__lookup" }] },
        },
      }),
    );
    const result = await catalog.list({ sessionId: first.id });
    assert.deepEqual(result.tools[0].source, {
      registry: "ToolRuntime",
      publicName: "mcp__synthetic__lookup",
      attribution: "public-name-only",
      namespace: "mcp",
    });
    assert.equal(result.tools[0].availability, "registered");
    assert.equal(result.sources.skills.complete, true);
    const read = await catalog.read({ sessionId: first.id, origin: "host", id: "declared-skill" });
    assert.equal(read.item.dependency.state, "declared");
    assert.equal(read.item.dependencyStatus, "unknown", "read does not execute a preflight");
    const checked = await catalog.preflight({
      sessionId: first.id,
      skills: [{ origin: "host", id: "declared-skill" }],
    });
    assert.equal(checked.status, "ready");
    assert.match(checked.checks[0].detail, /connection health are not tested/);
    assert.equal(checked.executionAuthorized, false);
  },
);
