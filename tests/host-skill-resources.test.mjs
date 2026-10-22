import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { HostCatalog } from "../src/host/catalog.js";
import {
  hostSkillResourceInventory,
  selectedHostSkillResources,
} from "../src/core/skill-resources.js";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-host-resources-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "skill");
  mkdirSync(join(directory, "references"), { recursive: true });
  mkdirSync(join(directory, "scripts"));
  const content = "Read references/check.md only for this task.";
  writeFileSync(join(directory, "SKILL.md"), content);
  const reference = "\uFEFFSYNTHETIC_HOST_REFERENCE\r\nTrailing spaces.  \n";
  writeFileSync(join(directory, "references/check.md"), reference);
  writeFileSync(join(directory, "scripts/unselected.js"), "throw new Error('MUST_NOT_EXECUTE')");
  const definition = {
    name: "host-resource-skill",
    description: "Original synthetic resource skill",
    content,
    provider: "synthetic-provider",
    source: "runtime",
    resourceBase: { kind: "directory", path: directory },
    metadata: { "dsh-unlimit": { requirements: [] } },
  };
  const services = {
    skills: {
      snapshot: async () => ({ complete: true, skills: [definition] }),
      get: async (id) => (id === definition.name ? definition : undefined),
    },
    tools: { schemas: () => [], modeFor: () => "native" },
  };
  const catalog = new HostCatalog(
    { get: (name) => services[name] },
    {
      library: { dispatch: () => ({ items: [] }) },
      toolkit: { status: () => ({ tools: [] }) },
    },
  );
  const ref = { origin: "host", id: definition.name, resources: ["references/check.md"] };
  return { root, directory, definition, reference, catalog, ref };
}

test("host directory skills expose metadata, then deliver only selected exact text with provenance", async (t) => {
  const f = fixture(t);
  for (const item of [
    (await f.catalog.list()).skills[0],
    (await f.catalog.read({ origin: "host", id: f.ref.id })).item,
  ]) {
    assert.deepEqual(
      item.resources.map(({ path }) => path),
      ["references/check.md", "scripts/unselected.js"],
    );
    assert.equal(item.resourceStatus.state, "available");
    assert.equal(item.provider, "synthetic-provider");
    assert.equal(item.origin, "host");
    assert.doesNotMatch(JSON.stringify(item), /SYNTHETIC_HOST_REFERENCE|MUST_NOT_EXECUTE/);
  }
  const metadata = await f.catalog.preflight({ skills: [f.ref] });
  assert.equal(metadata.status, "ready");
  assert.doesNotMatch(JSON.stringify(metadata), /SYNTHETIC_HOST_REFERENCE|MUST_NOT_EXECUTE/);
  const prepared = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.skillBodies[0].origin, "host");
  assert.equal(prepared.skillBodies[0].id, f.ref.id);
  assert.equal(prepared.skillBodies[0].content, f.definition.content);
  assert.equal(prepared.skillBodies[0].resources[0].content, f.reference);
  assert.equal(prepared.skillBodies[0].resources[0].bytes, Buffer.byteLength(f.reference));
  assert.match(prepared.skillBodies[0].resources[0].sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(prepared), /MUST_NOT_EXECUTE/);
  writeFileSync(join(f.directory, "references/check.md"), "UPDATED_AT_EXECUTION");
  assert.equal(
    (await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true })).skillBodies[0]
      .resources[0].content,
    "UPDATED_AT_EXECUTION",
  );
});

test("local file directory URLs preserve encoded names, source metadata and exact selected text", async (t) => {
  const f = fixture(t);
  const root = join(f.root, "技能 100% #");
  const path = "references/含空格 100% #.md";
  mkdirSync(join(root, "references"), { recursive: true });
  writeFileSync(join(root, path), f.reference);
  writeFileSync(join(root, "references/unused.md"), "UNSELECTED_URL_RESOURCE");
  f.ref.resources = [path];
  const local = pathToFileURL(`${root}/`).href;
  for (const url of [local, local.replace("file:///", "file://localhost/")]) {
    f.definition.resourceBase = { kind: "url", url };
    const listed = (await f.catalog.list()).skills[0];
    assert.deepEqual(listed.resourceBase, f.definition.resourceBase);
    assert.equal(listed.resourceStatus.state, "available");
    assert.ok(listed.resources.some((item) => item.path === path));
    assert.doesNotMatch(JSON.stringify(listed), /SYNTHETIC_HOST_REFERENCE|UNSELECTED_URL_RESOURCE/);
    const result = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
    assert.equal(result.status, "ready");
    assert.deepEqual(result.skillBodies[0].resources, [
      {
        ...result.skills[0].resources[0],
        content: f.reference,
      },
    ]);
    assert.equal(result.skillBodies[0].resources[0].path, path);
    assert.equal(result.skillBodies[0].resources[0].bytes, Buffer.byteLength(f.reference));
    assert.doesNotMatch(JSON.stringify(result), /UNSELECTED_URL_RESOURCE/);
  }
});

test("file URL resources reject remote, ambiguous, decorated and malformed bases without path fallback", async (t) => {
  const f = fixture(t);
  const local = pathToFileURL(`${f.directory}/`).href;
  for (const url of [
    "https://example.invalid/skill/",
    local.replace("file:///", "file://example.invalid/"),
    local.replace("file:///", "file://127.0.0.1/"),
    local.replace("file:///", "file://[::1]/"),
    local.slice(0, -1),
    `${local}?query`,
    `${local}#fragment`,
    `${local}?`,
    `${local}#`,
    `${local}bad%2fpath/`,
    `${local}bad%5Cpath/`,
    `${local}bad%zzpath/`,
    "file:relative/",
    `${f.directory}/`,
    `${local}bad\\path/`,
  ]) {
    f.definition.resourceBase = { kind: "url", url };
    assert.equal(hostSkillResourceInventory(f.definition).resourceStatus.complete, false, url);
    assert.throws(() => selectedHostSkillResources(f.definition, f.ref.resources), {
      code: "SKILL_RESOURCE_UNSUPPORTED",
    });
    const result = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
    assert.equal(result.status, "blocked", url);
    assert.ok(result.checks.some((check) => check.code === "SKILL_RESOURCE_UNSUPPORTED"));
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_HOST_REFERENCE/);
  }
});

test("file directory URLs retain link, binary and size rejection before task delivery", async (t) => {
  const f = fixture(t);
  f.definition.resourceBase = { kind: "url", url: pathToFileURL(`${f.directory}/`).href };
  for (const [bytes, code] of [
    [Buffer.from([0xff]), "SKILL_RESOURCE_BINARY"],
    [Buffer.from([65, 0, 66]), "SKILL_RESOURCE_BINARY"],
    [Buffer.alloc(32 * 1024 + 1), "SKILL_RESOURCE_LIMIT"],
  ]) {
    writeFileSync(join(f.directory, "references/check.md"), bytes);
    const result = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
    assert.equal(result.status, "blocked");
    assert.ok(result.checks.some((check) => check.code === code));
    assert.equal(result.skillBodies[0].resources, undefined);
  }
  const linked = join(f.root, "linked-root");
  symlinkSync(f.directory, linked);
  for (const resourceBase of [
    { kind: "url", url: pathToFileURL(`${linked}/`).href },
    { kind: "directory", path: `${linked}/` },
  ]) {
    f.definition.resourceBase = resourceBase;
    assert.throws(() => selectedHostSkillResources(f.definition, f.ref.resources), {
      code: "SKILL_RESOURCE_PATH",
    });
  }
  f.definition.resourceBase = { kind: "url", url: pathToFileURL(`${f.directory}/`).href };
  unlinkSync(join(f.directory, "references/check.md"));
  const outside = join(f.root, "outside.md");
  writeFileSync(outside, "OUTSIDE_URL_SENTINEL");
  symlinkSync(outside, join(f.directory, "references/check.md"));
  const result = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.some((check) => check.code === "SKILL_RESOURCE_PATH"));
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE_URL_SENTINEL/);
});

test("selected host resources fail visibly after removal or link replacement without reading outside bytes", async (t) => {
  const f = fixture(t);
  const path = join(f.directory, "references/check.md");
  await f.catalog.list();
  unlinkSync(path);
  let prepared = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
  assert.equal(prepared.status, "blocked");
  assert.ok(prepared.checks.some((check) => check.code === "SKILL_RESOURCE_MISSING"));
  const outside = join(f.root, "outside-secret.md");
  writeFileSync(outside, "OUTSIDE_SENTINEL");
  symlinkSync(outside, path);
  prepared = await f.catalog.preflight({ skills: [f.ref] }, { includeContent: true });
  assert.equal(prepared.status, "blocked");
  assert.ok(prepared.checks.some((check) => check.code === "SKILL_RESOURCE_PATH"));
  assert.doesNotMatch(JSON.stringify(prepared), /OUTSIDE_SENTINEL/);
  assert.equal(readFileSync(outside, "utf8"), "OUTSIDE_SENTINEL");
  assert.equal(hostSkillResourceInventory(f.definition).resourceStatus.complete, false);
  unlinkSync(path);
  rmSync(join(f.directory, "references"), { recursive: true });
  symlinkSync(f.root, join(f.directory, "references"));
  assert.throws(() => selectedHostSkillResources(f.definition, ["references/outside-secret.md"]), {
    code: "SKILL_RESOURCE_PATH",
  });
});

test("host text resources preserve limits and reject binary data and path traversal", (t) => {
  const f = fixture(t);
  for (const [path, content, code] of [
    ["oversize.md", Buffer.alloc(32 * 1024 + 1), "SKILL_RESOURCE_LIMIT"],
    ["binary.md", Buffer.from([65, 0, 66]), "SKILL_RESOURCE_BINARY"],
    ["invalid.md", Buffer.from([0xff]), "SKILL_RESOURCE_BINARY"],
  ]) {
    writeFileSync(join(f.directory, path), content);
    assert.throws(() => selectedHostSkillResources(f.definition, [path]), { code });
  }
  for (const path of [
    "../outside.md",
    "/absolute",
    "C:/absolute",
    "references\\check.md",
    "SKILL.md",
    "https://example.invalid/a",
  ])
    assert.throws(() => selectedHostSkillResources(f.definition, [path]), {
      code: "INVALID_INPUT",
    });
  assert.throws(() => selectedHostSkillResources(f.definition, Array(17).fill("a")), {
    code: "INVALID_INPUT",
  });
  writeFileSync(join(f.directory, "exact.md"), "a".repeat(32 * 1024));
  assert.equal(selectedHostSkillResources(f.definition, ["exact.md"])[0].content.length, 32 * 1024);
});

test("URL, opaque, missing and relative bases remain readable skills but cannot masquerade as local resources", async (t) => {
  const f = fixture(t);
  for (const resourceBase of [
    undefined,
    { kind: "url", url: "https://example.invalid/skill" },
    { kind: "opaque", description: "provider-owned" },
    { kind: "directory", path: "relative" },
  ]) {
    f.definition.resourceBase = resourceBase;
    const read = await f.catalog.read({ origin: "host", id: f.ref.id });
    assert.equal(read.item.content, f.definition.content);
    assert.equal(read.item.resourceStatus.complete, false);
    assert.deepEqual(read.item.resources, []);
    const prepared = await f.catalog.preflight({ skills: [f.ref] });
    assert.equal(prepared.status, "blocked");
    assert.ok(prepared.checks.some((check) => check.code === "SKILL_RESOURCE_UNSUPPORTED"));
    const bodyOnly = await f.catalog.preflight(
      { skills: [{ origin: "host", id: f.ref.id }] },
      { includeContent: true },
    );
    assert.equal(bodyOnly.status, "ready");
  }
});

test("host resource inventory reports oversized directories instead of supplying a truncated candidate list", (t) => {
  const f = fixture(t);
  for (let i = 0; i < 198; i++) writeFileSync(join(f.directory, `resource-${i}.md`), "synthetic");
  assert.equal(hostSkillResourceInventory(f.definition).resources.length, 200);
  writeFileSync(join(f.directory, "resource-over-limit.md"), "synthetic");
  const result = hostSkillResourceInventory(f.definition);
  assert.equal(result.resourceStatus.code, "SKILL_RESOURCE_LIMIT");
  assert.equal(result.resourceStatus.complete, false);
  assert.deepEqual(result.resources, []);
});
