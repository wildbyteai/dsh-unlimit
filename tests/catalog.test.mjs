import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  realpathSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostCatalog, normalizeRequirements } from "../src/host/catalog.js";
import { SkillLibrary } from "../src/core/skills.js";
import { LocalEnvironment } from "../src/core/environment.js";

const policy = { userInvocable: true, modelInvocable: true };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-catalog-")));
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

test("workflow skill bodies and dependencies come from one source read; public preflight stays metadata-only", async (t) => {
  const f = fixture(t);
  const content =
    '---\nname: same-name\ndescription: Synthetic declared skill\ndsh-unlimit-requirements: [{"kind":"tool","name":"mcp__synthetic__lookup"}]\n---\n\nOriginal synthetic project instructions.';
  f.library.dispatch("skills.save", { id: "local-one", content });
  const payload = { sessionId: "first", skills: [{ origin: "project", id: "local-one" }] };
  const metadata = await f.catalog.preflight(payload);
  assert.equal(metadata.status, "ready");
  assert.equal(metadata.skillBodies, undefined);
  const read = f.catalog.load.bind(f.catalog);
  let reads = 0;
  f.catalog.load = async (...args) => {
    reads++;
    const value = await read(...args);
    f.library.dispatch("skills.save", {
      id: "local-one",
      content: content
        .replace("mcp__synthetic__lookup", "missing_tool")
        .replace("Original", "Changed"),
    });
    return value;
  };
  const prepared = await f.catalog.preflight(payload, { includeContent: true });
  assert.equal(reads, 1);
  assert.equal(prepared.status, "ready");
  assert.deepEqual(prepared.skillBodies, [
    { origin: "project", id: "local-one", name: "same-name", content },
  ]);
  const current = await f.catalog.preflight(payload, { includeContent: true });
  assert.equal(current.status, "blocked");
  assert.match(current.skillBodies[0].content, /Changed/);
  await assert.rejects(f.catalog.preflight({ ...payload, includeContent: true }), {
    code: "INVALID_INPUT",
  });
});

test("skill dependency metadata preserves unknown/empty/invalid declarations and model invocation flags", async (t) => {
  const f = fixture(t);
  const ref = { origin: "project", id: "local-one" };
  assert.equal(
    (await f.catalog.preflight({ skills: [ref] }, { includeContent: true })).status,
    "unknown",
  );
  const content =
    "---\nname: same-name\ndescription: Synthetic skill\ndsh-unlimit-requirements: []\n---\nNo dependencies.";
  f.library.dispatch("skills.save", { id: ref.id, content });
  assert.equal(
    (await f.catalog.preflight({ skills: [ref] }, { includeContent: true })).status,
    "ready",
  );
  f.library.dispatch("skills.save", {
    id: ref.id,
    content: content.replace("[]", '[{"kind":"invented","name":"bad"}]'),
  });
  assert.equal(
    (await f.catalog.preflight({ skills: [ref] }, { includeContent: true })).status,
    "blocked",
  );
  for (const value of ["invalid-json", "{}", JSON.stringify(Array(33).fill({}))])
    assert.throws(
      () =>
        f.library.dispatch("skills.save", { id: ref.id, content: content.replace("[]", value) }),
      { code: "INVALID_SKILL" },
    );
  f.library.dispatch("skills.save", {
    id: ref.id,
    content: content.replace(
      "dsh-unlimit-requirements:",
      "disable-model-invocation: true\ndsh-unlimit-requirements:",
    ),
  });
  const result = await f.catalog.preflight({ skills: [ref] }, { includeContent: true });
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.some((check) => check.kind === "skill-invocation"));
});

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

test("environment dependency preflight uses one masked snapshot, preserves bytes/revision and never resolves secrets", async (t) => {
  const f = fixture(t);
  const environment = new LocalEnvironment(f.root);
  const fakeSecret = "synthetic-preflight-secret-not-for-results";
  let revision = 0;
  for (const [name, value, secret] of [
    ["TOKEN", fakeSecret, true],
    ["EMPTY", "", true],
    ["MODE", "synthetic-ordinary-value", false],
  ])
    revision = environment.dispatch("environment.variables.save", {
      revision,
      name,
      value,
      secret,
    }).revision;
  revision = environment.dispatch("environment.hosts.save", {
    revision,
    items: ["operator@example.invalid", "other.example.invalid"],
  }).revision;
  const path = join(f.root, "synthetic-private-key");
  writeFileSync(path, "synthetic key bytes must not be read", { mode: 0o600 });
  const registered = environment.dispatch("environment.keys.save", {
    revision,
    label: "Synthetic key",
    path,
  });
  const keyId = registered.privateKeys[0].id;
  const before = readFileSync(join(f.root, ".environment", "config.json"));
  let reads = 0;
  f.catalog.environment = {
    dispatch(action) {
      assert.equal(action, "environment.status");
      reads++;
      return environment.dispatch(action);
    },
    resolve() {
      assert.fail("must not resolve secret values");
    },
    exportEnvironment() {
      assert.fail("must not export an execution environment");
    },
  };
  const result = await f.catalog.preflight({
    sessionId: "first",
    requirements: [
      { kind: "environment-variable", name: "TOKEN" },
      { kind: "environment-variable", name: "EMPTY", nonEmpty: false },
      { kind: "environment-variable", name: "MODE" },
      { kind: "environment-host", name: "operator@EXAMPLE.INVALID." },
      { kind: "environment-key", name: keyId },
    ],
  });
  assert.equal(result.status, "ready");
  assert.ok(
    result.checks
      .filter((item) => item.kind.startsWith("environment-"))
      .every((item) => item.state === "ready"),
  );
  assert.equal(result.environment.revision, registered.revision);
  assert.equal(reads, 1);
  const json = JSON.stringify(result);
  for (const hidden of [
    fakeSecret,
    "synthetic-ordinary-value",
    "other.example.invalid",
    path,
    "synthetic key bytes must not be read",
  ])
    assert.equal(json.includes(hidden), false);
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(readFileSync(join(f.root, ".environment", "config.json")), before);
  assert.equal(environment.dispatch("environment.status").revision, registered.revision);
});

test("missing/empty variables, exact host identity and stale registered keys block without inspecting arbitrary paths", async (t) => {
  const f = fixture(t);
  const environment = new LocalEnvironment(f.root);
  let revision = environment.dispatch("environment.variables.save", {
    revision: 0,
    name: "EMPTY",
    secret: true,
    value: "",
  }).revision;
  revision = environment.dispatch("environment.hosts.save", {
    revision,
    items: ["operator@example.invalid"],
  }).revision;
  const path = join(f.root, "synthetic-key");
  writeFileSync(path, "synthetic", { mode: 0o600 });
  const saved = environment.dispatch("environment.keys.save", {
    revision,
    label: "Synthetic",
    path,
  });
  unlinkSync(path);
  f.catalog.environment = environment;
  const result = await f.catalog.preflight({
    requirements: [
      { kind: "environment-variable", name: "ABSENT" },
      { kind: "environment-variable", name: "EMPTY" },
      { kind: "environment-host", name: "example.invalid" },
      { kind: "environment-key", name: saved.privateKeys[0].id },
      { kind: "environment-key", name: "00000000-0000-0000-0000-000000000000" },
    ],
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.slice(0, 5).every((item) => item.state === "missing"));
  assert.match(result.checks[1].detail, /empty/);
  assert.equal(JSON.stringify(result).includes(path), false);
  await assert.rejects(
    f.catalog.preflight({ requirements: [{ kind: "environment-key", path }] }),
    code("INVALID_INPUT"),
  );
});

test("environment inspection failures stay unknown and cannot echo provider diagnostics or silently use another root", async (t) => {
  const f = fixture(t);
  const requirements = [{ kind: "environment-variable", name: "TOKEN" }];
  assert.equal((await f.catalog.preflight({ requirements })).checks[0].state, "unknown");
  f.catalog.environment = {
    dispatch() {
      throw new Error("synthetic-provider-secret");
    },
  };
  const failed = await f.catalog.preflight({ requirements });
  assert.equal(failed.status, "unknown");
  assert.equal(failed.environment.state, "error");
  assert.equal(JSON.stringify(failed).includes("synthetic-provider-secret"), false);
  const other = join(f.root, "other-install");
  mkdirSync(other);
  f.catalog.environment = new LocalEnvironment(other);
  const missing = await f.catalog.preflight({ requirements });
  assert.equal(missing.checks[0].state, "missing");
  assert.equal(missing.environment.revision, 0);
});

test("skill declarations reuse environment schema and undeclared/explicit empty dependencies remain distinct", async (t) => {
  const f = fixture(t);
  const environment = new LocalEnvironment(f.root);
  environment.dispatch("environment.variables.save", {
    revision: 0,
    name: "TOKEN",
    secret: true,
    value: "synthetic",
  });
  f.catalog.environment = environment;
  f.setMetadata({
    "dsh-unlimit": { requirements: [{ kind: "environment-variable", name: "TOKEN" }] },
  });
  const checked = await f.catalog.preflight({ skills: [{ origin: "host", id: "same-name" }] });
  assert.equal(checked.status, "ready");
  assert.equal(checked.skills[0].checks[0].state, "ready");
  f.catalog.environment = {
    dispatch() {
      assert.fail("Do not read environment for absent declarations or explicit empty list");
    },
  };
  assert.equal((await f.catalog.preflight()).status, "unknown");
  const explicit = await f.catalog.preflight({ requirements: [] });
  assert.equal(explicit.status, "ready");
  assert.equal(explicit.environment, undefined);
  assert.equal(
    (await f.catalog.preflight({ skills: [{ origin: "host", id: "same-name", requirements: [] }] }))
      .status,
    "ready",
  );
});

test("normalized environmental declarations reject guessed options and unavailable key inspection is unknown", async (t) => {
  assert.deepEqual(normalizeRequirements([{ kind: "environment-variable", name: "TOKEN" }]), [
    { kind: "environment-variable", name: "TOKEN", nonEmpty: true },
  ]);
  assert.deepEqual(
    normalizeRequirements([{ kind: "environment-host", name: "operator@EXAMPLE.INVALID." }]),
    [{ kind: "environment-host", name: "operator@example.invalid" }],
  );
  for (const requirement of [
    { kind: "environment-variable", name: "TOKEN", nonEmpty: "false" },
    { kind: "environment-variable", name: "INVALID-NAME" },
    { kind: "environment-host", name: "https://user:synthetic-secret@example.invalid" },
    { kind: "environment-key", name: "not-a-registered-id" },
    { kind: "environment-key", name: "00000000-0000-0000-0000-000000000000", nonEmpty: false },
  ])
    assert.throws(() => normalizeRequirements([requirement]), code("INVALID_INPUT"));
  const f = fixture(t);
  f.catalog.environment = {
    dispatch: () => ({
      revision: 2,
      variables: [],
      hosts: [],
      privateKeys: [
        {
          id: "00000000-0000-0000-0000-000000000000",
          metadata: { available: false, validation: "metadata-only", reason: "PERMISSION_DENIED" },
        },
      ],
    }),
  };
  const result = await f.catalog.preflight({
    requirements: [{ kind: "environment-key", name: "00000000-0000-0000-0000-000000000000" }],
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.checks[0].state, "unknown");
});

test("explicit project resources use the same skill snapshot and expose only selected text", async (t) => {
  const f = fixture(t);
  const content =
    "---\nname: same-name\ndescription: Synthetic resource skill\ndsh-unlimit-requirements: []\n---\nRead references/check.md";
  const reference = "\uFEFFSYNTHETIC_REFERENCE\r\nRetain exact whitespace.  \n";
  const install = (value) =>
    f.library.dispatch("skills.import", {
      id: "local-one",
      files: [
        { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64") },
        { path: "references/check.md", contentBase64: Buffer.from(value).toString("base64") },
        {
          path: "scripts/example.js",
          contentBase64: Buffer.from("UNSELECTED_SCRIPT").toString("base64"),
        },
      ],
    });
  install(reference);
  const inventory = await f.catalog.list({ sessionId: "first" });
  assert.deepEqual(
    inventory.skills
      .find((item) => item.origin === "project")
      .resources.map((item) => item.path)
      .sort(),
    ["references/check.md", "scripts/example.js"],
  );
  assert.doesNotMatch(JSON.stringify(inventory), /SYNTHETIC_REFERENCE|UNSELECTED_SCRIPT/);
  const ref = { origin: "project", id: "local-one", resources: ["references/check.md"] };
  const listing = await f.catalog.read({ origin: ref.origin, id: ref.id });
  assert.deepEqual(listing.item.resources.map(({ path }) => path).sort(), [
    "references/check.md",
    "scripts/example.js",
  ]);
  assert.doesNotMatch(JSON.stringify(listing), /SYNTHETIC_REFERENCE|UNSELECTED_SCRIPT/);
  const metadata = await f.catalog.preflight({ skills: [ref] });
  assert.equal(metadata.status, "ready");
  assert.doesNotMatch(JSON.stringify(metadata), /SYNTHETIC_REFERENCE|UNSELECTED_SCRIPT/);
  const load = f.catalog.load.bind(f.catalog);
  f.catalog.load = async (...args) => {
    const snapshot = await load(...args);
    install("NEW_RESOURCE");
    return snapshot;
  };
  const prepared = await f.catalog.preflight({ skills: [ref] }, { includeContent: true });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.skillBodies[0].resources[0].content, reference);
  assert.equal(prepared.skillBodies[0].resources[0].bytes, Buffer.byteLength(reference));
  assert.match(prepared.skillBodies[0].resources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(prepared.skillBodies[0].resources.length, 1);
  assert.doesNotMatch(JSON.stringify(prepared), /UNSELECTED_SCRIPT|NEW_RESOURCE/);
});

test("missing, binary and oversized resources block preparation without truncating or silently dropping files", async (t) => {
  const f = fixture(t);
  const content =
    "---\nname: same-name\ndescription: Synthetic resource skill\ndsh-unlimit-requirements: []\n---\nSynthetic";
  f.library.dispatch("skills.import", {
    id: "local-one",
    files: [
      { path: "SKILL.md", contentBase64: Buffer.from(content).toString("base64") },
      { path: "invalid.txt", contentBase64: Buffer.from([0xff, 0xfe]).toString("base64") },
      { path: "binary.txt", contentBase64: Buffer.from([65, 0, 66]).toString("base64") },
      { path: "large.txt", contentBase64: Buffer.alloc(32 * 1024 + 1, 65).toString("base64") },
    ],
  });
  for (const [path, code] of [
    ["missing.md", "SKILL_RESOURCE_MISSING"],
    ["invalid.txt", "SKILL_RESOURCE_BINARY"],
    ["binary.txt", "SKILL_RESOURCE_BINARY"],
    ["large.txt", "SKILL_RESOURCE_LIMIT"],
  ]) {
    const result = await f.catalog.preflight(
      { skills: [{ origin: "project", id: "local-one", resources: [path] }] },
      { includeContent: true },
    );
    assert.equal(result.status, "blocked");
    assert.ok(result.checks.some((check) => check.code === code));
  }
  for (const paths of [
    ["../escape"],
    ["/absolute"],
    ["C:/absolute"],
    ["ref\\file"],
    ["https://example.invalid/a"],
    ["SKILL.md"],
    ["a", "a"],
    Array(17).fill("a"),
  ])
    await assert.rejects(
      f.catalog.preflight({ skills: [{ origin: "project", id: "local-one", resources: paths }] }),
      { code: "INVALID_INPUT" },
    );
  await assert.rejects(
    f.catalog.preflight({ skills: [{ origin: "host", id: "same-name", resources: ["ref.md"] }] }),
    { code: "INVALID_INPUT" },
  );
});
