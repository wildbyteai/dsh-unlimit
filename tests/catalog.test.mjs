import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostCatalog } from "../src/host/catalog.js";
import { SkillLibrary } from "../src/core/skills.js";

const policy = { userInvocable: true, modelInvocable: true };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "dsh-unlimit-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "templates"));
  writeFileSync(join(root, "not-directory"), "synthetic");
  const library = new SkillLibrary(join(root, "skills"));
  library.dispatch("skills.save", {
    id: "local-one",
    name: "same-name",
    description: "Synthetic library entry",
    content: "Local body mentions imaginary-command but declares no dependencies.",
  });
  const first = { session: { id: "first", header: { cwd: join(root, "old-header") } } };
  const second = { session: { id: "second", header: { cwd: root } } };
  const sessions = new Map([
    ["first", first],
    ["second", second],
  ]);
  let body = "Host body";
  let metadata;
  const observed = [];
  const services = {
    agents: { get: (id) => sessions.get(id) },
    workingDirectory: {
      get: () => root,
      ensure: () => assert.fail("must not commit directory recovery"),
    },
    skills: {
      snapshot: async (options) => {
        observed.push(["list", options]);
        return {
          complete: true,
          skills: [
            {
              name: "same-name",
              description: "Synthetic host winner",
              provider: "bundled-synthetic",
              source: "bundled",
              invocation: policy,
            },
          ],
        };
      },
      get: async (name, options) => {
        observed.push(["get", options]);
        if (name !== "same-name") return undefined;
        return {
          name,
          description: "Synthetic host winner",
          provider: "bundled-synthetic",
          source: "bundled",
          content: body,
          invocation: policy,
          ...(metadata ? { metadata } : {}),
        };
      },
    },
    tools: {
      modeFor: () => "native",
      schemas: (scope) => [
        {
          name: scope === second ? "second_tool" : "mcp__synthetic__lookup",
          description: "Synthetic registered MCP namespace",
          parameters: { type: "object", properties: {} },
        },
      ],
      execute: () => assert.fail("catalog must not execute a registered tool"),
    },
  };
  const toolkit = {
    status: () => ({
      root,
      searchDirs: [],
      toolPaths: {},
      templateDir: join(root, "templates"),
      tools: [
        { id: "nmap", available: true, path: join(root, "synthetic-nmap"), identity: "name-only" },
        {
          id: "httpx",
          available: false,
          path: join(root, "synthetic-httpx"),
          identity: "unverified",
          detail: "Product is not verified",
        },
      ],
    }),
    probe: () => assert.fail("catalog must not probe binaries"),
  };
  const catalog = new HostCatalog({ get: (name) => services[name] }, { library, toolkit });
  return {
    catalog,
    root,
    library,
    services,
    observed,
    first,
    second,
    setBody: (value) => (body = value),
    setMetadata: (value) => (metadata = value),
    toolkit,
  };
}
const code = (expected) => (error) => error.code === expected;

test("session catalog preserves host/project collisions, invocation flags and MCP public names", async (t) => {
  const { catalog, first, observed, root } = fixture(t);
  const result = await catalog.list({ sessionId: "first" });
  assert.equal(result.context.cwd, root);
  assert.equal(result.context.cwdSource, "workingDirectory.get");
  assert.deepEqual(
    result.skills.map((item) => [item.origin, item.id, item.name]),
    [
      ["host", "same-name", "same-name"],
      ["project", "local-one", "same-name"],
    ],
  );
  assert.equal(result.skills[0].provider, "bundled-synthetic");
  assert.deepEqual(result.skills[0].invocation, policy);
  assert.equal(result.skills[1].exposure, "project-library");
  assert.equal(result.tools[0].name, "mcp__synthetic__lookup");
  assert.equal(result.tools[0].source.attribution, "public-name-only");
  assert.equal(result.tools[0].source.namespace, "mcp");
  assert.equal(result.tools[0].availability, "registered");
  assert.equal(observed.length, 1, "listing must not load bodies");
  assert.equal(observed[0][1].scope, first);
  assert.equal(observed[0][1].cwd, root);
  result.skills[0].invocation.modelInvocable = false;
  assert.equal(policy.modelInvocable, true, "returned flags must not mutate borrowed definitions");
});

test("unknown or mismatched sessions reject rather than exposing global schemas", async (t) => {
  const { catalog, observed, services } = fixture(t);
  await assert.rejects(catalog.list({ sessionId: "absent" }), code("NOT_FOUND"));
  services.agents.get = () => ({ session: { id: "other" } });
  await assert.rejects(
    catalog.read({ sessionId: "first", origin: "host", id: "same-name" }),
    code("NOT_FOUND"),
  );
  assert.equal(observed.length, 0);
  await assert.rejects(catalog.list({ cwd: "/forged", scope: {} }), code("INVALID_INPUT"));
});

test("body reads use the exact source and reread changed provider content without dependencies guessed from prose", async (t) => {
  const { catalog, setBody } = fixture(t);
  const host = await catalog.read({ sessionId: "first", origin: "host", id: "same-name" });
  assert.equal(host.item.content, "Host body");
  assert.equal(host.item.readStatus, "readable");
  assert.equal(host.item.dependencyStatus, "unknown");
  setBody("A second current body; run phantom-tool.");
  assert.match(
    (await catalog.read({ sessionId: "first", origin: "host", id: "same-name" })).item.content,
    /second current/,
  );
  const local = await catalog.read({ sessionId: "first", origin: "project", id: "local-one" });
  assert.match(local.item.content, /Local body/);
  assert.equal(local.item.dependency.state, "unknown");
  const check = await catalog.preflight({
    sessionId: "first",
    skills: [{ origin: "project", id: "local-one" }],
  });
  assert.equal(check.status, "unknown");
  assert.equal(check.skills[0].readStatus, "readable");
  assert.equal(check.executionAuthorized, false);
  assert.equal(
    check.checks.some((item) => item.name === "imaginary-command"),
    false,
  );
});

test("only explicit requirements or this plugin's namespaced metadata establish dependency evidence", async (t) => {
  const { catalog, setMetadata } = fixture(t);
  setMetadata({
    dependencies: ["phantom"],
    "dsh-unlimit": {
      requirements: [
        { kind: "toolkit", name: "nmap" },
        { kind: "tool", name: "mcp__synthetic__lookup" },
        { kind: "directory", path: "templates" },
      ],
    },
  });
  const result = await catalog.preflight({
    sessionId: "first",
    skills: [{ origin: "host", id: "same-name" }],
  });
  assert.equal(result.status, "ready");
  assert.equal(result.skills[0].declaration.source, "metadata:dsh-unlimit.requirements");
  assert.equal(
    result.checks.some((item) => item.name === "phantom"),
    false,
  );
  assert.equal(result.executionAuthorized, false);
  const overridden = await catalog.preflight({
    sessionId: "first",
    skills: [
      { origin: "host", id: "same-name", requirements: [{ kind: "tool", name: "missing-tool" }] },
    ],
  });
  assert.equal(overridden.status, "blocked");
  assert.equal(overridden.skills[0].declaration.source, "explicit");
});

test("missing executable, directory, tool and selected body block; unverified identity stays unknown", async (t) => {
  const { catalog } = fixture(t);
  const unknown = await catalog.preflight({
    sessionId: "first",
    requirements: [{ kind: "toolkit", name: "httpx" }],
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.checks[0].identity, "unverified");
  for (const requirement of [
    { kind: "toolkit", name: "missing" },
    { kind: "tool", name: "missing" },
    { kind: "directory", path: "absent" },
    { kind: "directory", path: "not-directory" },
    { kind: "skill", name: "absent" },
  ]) {
    const result = await catalog.preflight({ sessionId: "first", requirements: [requirement] });
    assert.equal(result.status, "blocked");
    assert.equal(result.checks[0].state, "missing");
  }
  const missing = await catalog.preflight({
    sessionId: "first",
    skills: [{ origin: "host", id: "absent" }],
  });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.skills[0].readStatus, "unreadable");
});

test("source discovery failures are partial observations and never ready-looking empty catalogs", async (t) => {
  const { catalog, services } = fixture(t);
  services.skills.snapshot = async () => {
    throw new Error("Synthetic provider failed");
  };
  const listed = await catalog.list({ sessionId: "first" });
  assert.equal(listed.sources.skills.state, "error");
  assert.equal(listed.skills.length, 1, "independent local source remains visible");
  const check = await catalog.preflight({ sessionId: "first", requirements: [] });
  assert.equal(check.status, "unknown");
  services.skills.snapshot = async () => ({ complete: false, skills: [] });
  const missing = await catalog.preflight({
    sessionId: "first",
    requirements: [{ kind: "skill", name: "not-observed" }],
  });
  assert.equal(missing.status, "unknown", "an incomplete catalog cannot prove absence");
  assert.equal(missing.checks[0].state, "unknown");
});

test("invalid declarations do not become pass and arbitrary commands are refused", async (t) => {
  const { catalog, setMetadata } = fixture(t);
  setMetadata({ "dsh-unlimit": { requirements: "run a command" } });
  const result = await catalog.preflight({
    sessionId: "first",
    skills: [{ origin: "host", id: "same-name" }],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.skills[0].declaration.state, "invalid");
  await assert.rejects(
    catalog.preflight({ requirements: [{ kind: "command", name: "curl example.invalid" }] }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    catalog.preflight({ requirements: [{ kind: "tool", name: "present", args: ["unsafe"] }] }),
    code("INVALID_INPUT"),
  );
  await assert.rejects(
    catalog.read({ origin: "filesystem", id: "/private-file" }),
    code("INVALID_INPUT"),
  );
});

test("configured directory gaps and absent context remain explicit", async (t) => {
  const { catalog, toolkit, root } = fixture(t);
  const original = toolkit.status;
  toolkit.status = () => ({ ...original(), searchDirs: [join(root, "missing-search")] });
  const result = await catalog.preflight({ sessionId: "first", requirements: [] });
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.find((item) => item.purpose === "toolkit-search").state, "missing");
  const host = await catalog.list();
  assert.equal(host.context.scope, "host");
  const relative = await catalog.preflight({
    requirements: [{ kind: "directory", path: "relative" }],
  });
  assert.equal(relative.checks[0].state, "unknown");
  const noSelection = await catalog.preflight();
  assert.ok(
    noSelection.checks.some((item) => item.kind === "declaration" && item.state === "unknown"),
  );
});

test("caller cancellation propagates and unsupported services are labelled instead of success", async (t) => {
  const { catalog } = fixture(t);
  const abort = new AbortController();
  abort.abort(new Error("Synthetic cancellation"));
  await assert.rejects(catalog.list({}, { signal: abort.signal }), /Synthetic cancellation/);
  const missing = new HostCatalog({ get: () => undefined });
  const list = await missing.list();
  assert.equal(list.sources.skills.state, "unsupported");
  assert.equal(list.sources.tools.state, "unsupported");
  assert.equal((await missing.preflight({ requirements: [] })).status, "unknown");
  assert.throws(() => missing.dispatch("catalog.execute"), code("UNKNOWN_ACTION"));
});
