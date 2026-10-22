import test from "node:test";
import assert from "node:assert/strict";
import fs, {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { SkillLibrary } from "../src/core/skills.js";
import { HostCatalog } from "../src/host/catalog.js";
import {
  normalizeSkillSelections,
  selectedHostSkillImages,
  selectedSkillImages,
  skillImageBudget,
} from "../src/core/skill-resources.js";

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-skill-images-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "host-skill");
  mkdirSync(join(root, "assets"), { recursive: true });
  const rawHost = Buffer.from([137, 80, 78, 71]);
  const rawProject = Buffer.from([71, 73, 70]);
  // Deliberately just raw source bytes: catalog preparation must not pretend
  // that an image decoder validated them. Native saveImages owns validation.
  writeFileSync(join(root, "assets/pixel.PNG"), rawHost);
  writeFileSync(join(root, "assets/next.png"), Buffer.from([1]));
  writeFileSync(join(root, "unselected.js"), "throw new Error('UNSELECTED_IMAGE_SCRIPT')");
  const host = {
    name: "host-image",
    description: "Original synthetic image selection",
    content: "Use only the explicitly selected synthetic image.",
    provider: "runtime",
    source: "runtime",
    resourceBase: { kind: "directory", path: root },
    metadata: { "dsh-unlimit": { requirements: [] } },
  };
  const library = new SkillLibrary(join(directory, "library"));
  library.dispatch("skills.import", {
    id: "project-image",
    files: [
      {
        path: "SKILL.md",
        contentBase64: Buffer.from(
          "---\nname: project-image\ndescription: Original synthetic image selection\ndsh-unlimit-requirements: []\n---\nUse the explicitly selected synthetic image.",
        ).toString("base64"),
      },
      { path: "assets/pixel.gif", contentBase64: rawProject.toString("base64") },
    ],
  });
  const attachments = {
    imageLimits: {
      maxImageBytes: 8,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 12,
      mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    },
    saveImages: () => assert.fail("Preflight must not write to the attachment store"),
  };
  const services = {
    skills: {
      snapshot: async () => ({ complete: true, skills: [host] }),
      get: async (id) => (id === host.name ? host : undefined),
    },
    tools: { schemas: () => [], modeFor: () => "native" },
    attachments,
  };
  const catalog = new HostCatalog(
    { get: (key) => services[key] },
    { library, toolkit: { status: () => ({ tools: [] }) } },
  );
  const hostRef = { origin: "host", id: host.name, images: ["assets/pixel.PNG"] };
  const projectRef = { origin: "project", id: "project-image", images: ["assets/pixel.gif"] };
  return {
    directory,
    root,
    host,
    library,
    attachments,
    services,
    catalog,
    hostRef,
    projectRef,
    rawHost,
    rawProject,
  };
}

test("text and image references share the exact-path, uniqueness and per-skill selection bound", () => {
  assert.deepEqual(
    normalizeSkillSelections("host", { resources: ["references/a.md"], images: ["assets/a.png"] }),
    { resources: ["references/a.md"], images: ["assets/a.png"] },
  );
  for (const selection of [
    { resources: ["assets/a.png"], images: ["assets/a.png"] },
    { resources: Array.from({ length: 15 }, (_, i) => `${i}.md`), images: ["a.png", "b.png"] },
    { images: ["../outside.png"] },
    { images: ["https://example.invalid/a.png"] },
  ])
    assert.throws(() => normalizeSkillSelections("host", selection), { code: "INVALID_INPUT" });
});

test("catalog delivers selected raw image bytes only internally and never saves or normalizes them", async (t) => {
  const f = fixture(t);
  const refs = [f.hostRef, f.projectRef];
  const metadata = await f.catalog.preflight({ skills: refs });
  assert.equal(metadata.status, "ready");
  assert.doesNotMatch(JSON.stringify(metadata), /contentBase64|UNSELECTED_IMAGE_SCRIPT/);
  assert.equal(metadata.skillBodies, undefined);
  assert.deepEqual(
    metadata.skills.map((item) => item.images[0].mediaType),
    ["image/png", "image/gif"],
  );
  const content = await f.catalog.preflight({ skills: refs }, { includeContent: true });
  assert.equal(content.status, "ready");
  for (const [index, bytes] of [f.rawHost, f.rawProject].entries()) {
    assert.equal(content.skillBodies[index].images[0].contentBase64, bytes.toString("base64"));
    assert.equal(content.skillBodies[index].images[0].bytes, bytes.length);
    assert.match(content.skillBodies[index].images[0].sha256, /^[a-f0-9]{64}$/u);
    assert.equal(content.skills[index].images[0].contentBase64, undefined);
  }
  f.host.resourceBase = { kind: "url", url: pathToFileURL(`${f.root}/`).href };
  const localURL = await f.catalog.preflight({ skills: [f.hostRef] }, { includeContent: true });
  assert.equal(localURL.status, "ready");
  assert.equal(localURL.skillBodies[0].images[0].contentBase64, f.rawHost.toString("base64"));
});

test("image count and unusable mounted policies block before any selected host file is opened", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "assets/oversize.png"), Buffer.alloc(9));
  const opened = [];
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (path, ...args) => {
    opened.push(path);
    assert.ok(
      !path.startsWith(`${f.root}/`),
      "Unavailable selected host images must not be opened",
    );
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  f.attachments.imageLimits.maxImagesPerMessage = 1;
  let result = await f.catalog.preflight(
    { skills: [f.hostRef, f.projectRef] },
    { includeContent: true },
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.some((check) => check.code === "SKILL_IMAGE_LIMIT"));
  for (const attachments of [
    undefined,
    { saveImages() {} },
    { imageLimits: f.attachments.imageLimits },
    { ...f.attachments, imageLimits: { ...f.attachments.imageLimits, maxImageBytes: 0 } },
  ]) {
    f.services.attachments = attachments;
    result = await f.catalog.preflight({ skills: [f.hostRef] }, { includeContent: true });
    assert.equal(result.status, "blocked");
    assert.ok(result.checks.some((check) => check.code === "SKILL_IMAGE_UNSUPPORTED"));
    assert.equal(result.skillBodies[0].images, undefined);
  }
  f.services.attachments = f.attachments;
  result = await f.catalog.preflight(
    { skills: [{ ...f.hostRef, images: ["assets/oversize.png"] }] },
    { includeContent: true },
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.checks.some((check) => check.code === "SKILL_IMAGE_LIMIT"));
  assert.deepEqual(
    opened.filter((path) => path.startsWith(`${f.root}/`)),
    [],
  );
  assert.ok(
    opened.includes(join(f.directory, "library/project-image/assets/pixel.gif")),
    "The existing project library eagerly reads its validated snapshot even for catalog discovery",
  );
});

test("one mounted aggregate budget spans project and host images and stops further image reads after overflow", async (t) => {
  const f = fixture(t);
  f.attachments.imageLimits.maxMessageImageBytes = 6;
  const opened = [];
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (path, ...args) => {
    opened.push(path);
    return originalOpen(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await f.catalog.preflight(
    { skills: [f.hostRef, f.projectRef, { ...f.hostRef, images: ["assets/next.png"] }] },
    { includeContent: true },
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.skillBodies[0].images[0].bytes, f.rawHost.length);
  assert.equal(result.skillBodies[1].images, undefined);
  assert.equal(result.skillBodies[2].images, undefined);
  assert.equal(result.checks.filter((check) => check.code === "SKILL_IMAGE_LIMIT").length, 2);
  assert.deepEqual(
    opened.filter((path) => path.startsWith(`${f.root}/`)),
    [join(f.root, "assets/pixel.PNG")],
  );
  assert.ok(
    opened.includes(join(f.directory, "library/project-image/assets/pixel.gif")),
    "Project library snapshot reads precede selected image extraction; this is not a disk-I/O budget",
  );
  const item = {
    files: [
      {
        path: "a.png",
        bytes: 9,
        get contentBase64() {
          assert.fail("Oversized snapshot bytes must not be decoded");
        },
      },
    ],
  };
  assert.throws(() => selectedSkillImages(item, ["a.png"], skillImageBudget(f.attachments, 1)), {
    code: "SKILL_IMAGE_LIMIT",
  });
});

test("image selection uses supported exact extensions and mounted media types without accepting arbitrary binary files", (t) => {
  const f = fixture(t);
  const files = ["a.png", "a.jpg", "a.jpeg", "a.webp", "a.gif"].map((path) => ({
    path,
    bytes: 1,
    contentBase64: "AQ==",
  }));
  const attachments = {
    ...f.attachments,
    imageLimits: { ...f.attachments.imageLimits, maxImagesPerMessage: 5 },
  };
  assert.deepEqual(
    selectedSkillImages(
      { files },
      files.map((file) => file.path),
      skillImageBudget(attachments, 5),
    ).map((file) => file.mediaType),
    ["image/png", "image/jpeg", "image/jpeg", "image/webp", "image/gif"],
  );
  for (const path of ["a.svg", "a.bin", "a.png.js"]) {
    writeFileSync(join(f.root, path), "not an accepted image selection");
    assert.throws(
      () => selectedHostSkillImages(f.host, [path], skillImageBudget(f.attachments, 1)),
      {
        code: "SKILL_IMAGE_TYPE",
      },
    );
  }
  attachments.imageLimits.mediaTypes = ["image/png"];
  assert.throws(() => selectedSkillImages({ files }, ["a.jpg"], skillImageBudget(attachments, 1)), {
    code: "SKILL_IMAGE_TYPE",
  });
});

test("selected images keep local link and missing-file boundaries for directory and file URL roots", async (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside.png");
  writeFileSync(outside, "OUTSIDE_IMAGE_SENTINEL");
  symlinkSync(outside, join(f.root, "assets/linked.png"));
  for (const resourceBase of [
    { kind: "directory", path: f.root },
    { kind: "url", url: pathToFileURL(`${f.root}/`).href },
  ]) {
    f.host.resourceBase = resourceBase;
    for (const [path, code] of [
      ["assets/linked.png", "SKILL_RESOURCE_PATH"],
      ["assets/missing.png", "SKILL_RESOURCE_MISSING"],
    ]) {
      const result = await f.catalog.preflight(
        { skills: [{ ...f.hostRef, images: [path] }] },
        { includeContent: true },
      );
      assert.equal(result.status, "blocked");
      assert.ok(result.checks.some((check) => check.code === code));
      assert.equal(result.skillBodies[0].images, undefined);
      assert.doesNotMatch(JSON.stringify(result), /OUTSIDE_IMAGE_SENTINEL/);
    }
  }
});
