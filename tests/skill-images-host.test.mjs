import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { SkillLibrary } from "../src/core/skills.js";
import { HostCatalog } from "../src/host/catalog.js";
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";
import { fixture, optionalHost, waitFor } from "./helpers/workflow-host-fixture.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Original single-pixel PNGs; no downloaded or business image is used.
function png(red) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, red, 83, 149, 128]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const image = (data, path = "assets/selected.png") => ({
  origin: "project",
  id: "synthetic-images",
  path,
  mediaType: "image/png",
  bytes: data.length,
  sha256: hash(data),
  contentBase64: data.toString("base64"),
});
const imageBlocks = (request) =>
  request.messages.flatMap((message) => message.content.filter((part) => part.type === "image"));
const task = (id, skills = []) => ({
  id,
  role: "analyst",
  task: `Inspect only the explicitly supplied synthetic ${id} input.`,
  requirements: [],
  skills,
});
async function direct(f, parent, images, signal) {
  return f.workflow.dispatch(
    "workflow.dispatch",
    {
      workspaceId: f.workspaceId,
      parentSessionId: parent.id,
      role: "analyst",
      task: "Inspect only explicitly supplied synthetic pixels.",
    },
    { images, ...(signal ? { signal } : {}) },
  );
}

test(
  "automatic planning selects project and official SkillRegistry images for native child messages, JSONL and request-image bytes",
  optionalHost,
  async (t) => {
    let generated;
    let requestCount = 0;
    const f = await fixture(t, {
      realAttachments: true,
      textOutput: () =>
        ++requestCount === 1
          ? JSON.stringify({ tasks: generated })
          : "Synthetic image evidence with no external vision-model execution.",
    });
    const parent = await f.create();
    const selected = png(41),
      hostSelected = png(74),
      unused = png(211);
    const library = new SkillLibrary(join(f.directory, "image-library"));
    library.dispatch("skills.import", {
      id: "project-images",
      files: [
        {
          path: "SKILL.md",
          contentBase64: Buffer.from(
            "---\nname: project-images\ndescription: Original synthetic pixels\ndsh-unlimit-requirements: []\n---\nUse only selected pixels.",
          ).toString("base64"),
        },
        { path: "assets/selected.png", contentBase64: selected.toString("base64") },
        { path: "assets/unused.png", contentBase64: unused.toString("base64") },
        { path: "assets/retained.bin", contentBase64: Buffer.from([0, 255, 1]).toString("base64") },
      ],
    });
    const hostRoot = join(f.directory, "host-image-skill");
    mkdirSync(join(hostRoot, "assets"), { recursive: true });
    writeFileSync(join(hostRoot, "assets/selected.png"), hostSelected);
    writeFileSync(join(hostRoot, "assets/unused.png"), unused);
    const unregister = f.ctx.skills.register({
      name: "host-images",
      description: "Original synthetic host pixels",
      content: "Use only selected host pixels.",
      source: "runtime",
      resourceBase: { kind: "directory", path: hostRoot },
      invocation: { modelInvocable: true, userInvocable: true },
      metadata: { "dsh-unlimit": { requirements: [] } },
    });
    f.onDispose(unregister);
    const catalog = new HostCatalog(f.ctx, { library, toolkit: { status: () => ({ tools: [] }) } });
    const refs = [
      { origin: "project", id: "project-images", images: ["assets/selected.png"] },
      { origin: "host", id: "host-images", images: ["assets/selected.png"] },
    ];
    generated = [task("project", [refs[0]]), task("host", [refs[1]]), task("sibling")];
    const preview = await catalog.preflight({ sessionId: parent.id, skills: refs });
    assert.equal(preview.status, "ready");
    assert.doesNotMatch(JSON.stringify(preview), /contentBase64/);
    const plans = new DesktopWorkflowPlan(f.workflow, { catalog });
    try {
      const owner = { workspaceId: f.workspaceId, parentSessionId: parent.id };
      const { item } = await plans.dispatch("workflow.plan.run", {
        ...owner,
        goal: "Inspect only each selected synthetic pixel in its owning skill task and keep a text-only sibling task separate.",
      });
      const { item: done } = await waitFor(
        () => plans.dispatch("workflow.plan.status", { ...owner, id: item.id }),
        (result) => ["completed", "failed", "blocked"].includes(result.item.state),
      );
      assert.equal(done.state, "completed", JSON.stringify(done));
      assert.doesNotMatch(JSON.stringify(done), /contentBase64/);
      assert.equal(f.requests.length, 4);
      for (const current of done.tasks) {
        const request = f.requests.find((entry) => entry.sessionId === current.receipt.sessionId);
        const blocks = imageBlocks(request);
        assert.equal(blocks.length, ["project", "host"].includes(current.id) ? 1 : 0);
        assert.equal(JSON.stringify(request.messages).includes(selected.toString("base64")), false);
        assert.equal(
          JSON.stringify(request.messages).includes(hostSelected.toString("base64")),
          false,
        );
        assert.equal(JSON.stringify(request.messages).includes(unused.toString("base64")), false);
        if (blocks.length) {
          const recorded = current.receipt.images[0];
          assert.equal(recorded.path, "assets/selected.png");
          assert.equal(recorded.origin, current.id === "host" ? "host" : "project");
          assert.equal(recorded.sha256, hash(current.id === "host" ? hostSelected : selected));
          assert.deepEqual(blocks[0].attachment, recorded.attachment);
          const projected = await f.ctx.attachments.readImageRequest(
            blocks[0].attachment,
            { width: 1, height: 1, maxBytes: 4096 },
            new AbortController().signal,
          );
          assert.equal(projected.width, 1);
          assert.equal(projected.height, 1);
          assert.equal(projected.bytes, projected.data.length);
          assert.ok(projected.data.length > 0);
          assert.equal(`sha256:${hash(projected.data)}`, blocks[0].attachment.attachmentId);
          assert.notEqual(blocks[0].attachment.attachmentId, `sha256:${hash(unused)}`);
        }
        await f.ctx.sessionPersistence.flush();
        const reader = await f.ctx.sessionPersistence.open(current.receipt.sessionId, "read");
        try {
          const events = (await reader.read()).events;
          const durableBlocks = events.flatMap(
            (event) => event.data?.message?.content ?? event.data?.content ?? [],
          );
          assert.deepEqual(
            durableBlocks.filter((part) => part.type === "image"),
            blocks,
          );
          assert.equal(JSON.stringify(events).includes(selected.toString("base64")), false);
        } finally {
          await reader.close();
        }
      }
      assert.equal(
        library
          .dispatch("skills.read", { id: "project-images" })
          .item.files.find((file) => file.path === "assets/retained.bin").contentBase64,
        Buffer.from([0, 255, 1]).toString("base64"),
      );
      assert.equal(f.flow.status(f.workspaceId).active.length, 0);
      // Captured requests are official provider-neutral AgentLoop input. The
      // synthetic stream is offline and does not prove an external vision model ran.
    } finally {
      await plans.close();
    }
  },
);

test("official image batch validates every member before publication", optionalHost, async (t) => {
  const f = await fixture(t, { realAttachments: true });
  const parent = await f.create();
  await assert.rejects(
    direct(f, parent, [image(png(41)), image(Buffer.from("malformed-image"), "assets/bad.png")]),
    (error) => error.partial?.item?.error?.code === "INVALID_IMAGE",
  );
  const root = f.ctx.attachments.root;
  assert.equal(existsSync(root) ? readdirSync(root, { recursive: true }).length : 0, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.flow.status(f.workspaceId).active.length, 0);
});

test("active native image count limits block dispatch", optionalHost, async (t) => {
  const f = await fixture(t, {
    realAttachments: true,
    attachmentConfig: { maxImagesPerMessage: 1 },
  });
  const parent = await f.create();
  await assert.rejects(
    direct(f, parent, [image(png(41)), image(png(99), "assets/second.png")]),
    (error) => error.partial?.item?.error?.code === "TOO_MANY_IMAGES",
  );
  assert.equal(f.requests.length, 0);
  assert.equal(f.flow.status(f.workspaceId).active.length, 0);
});

test(
  "native text-only child model refuses a saved image without model execution",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { realAttachments: true, imageModel: false });
    const parent = await f.create();
    await assert.rejects(
      direct(f, parent, [image(png(41))]),
      (error) => error.partial?.item?.error?.code === "MODEL_DOES_NOT_SUPPORT_IMAGES",
    );
    assert.equal(f.requests.length, 0);
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
  },
);

test(
  "cancellation during native image saving prevents subsequent child activation",
  optionalHost,
  async (t) => {
    const f = await fixture(t, { realAttachments: true });
    const parent = await f.create();
    const saved = Promise.withResolvers(),
      release = Promise.withResolvers();
    const nativeSave = f.ctx.attachments.saveImages.bind(f.ctx.attachments);
    t.mock.method(f.ctx.attachments, "saveImages", async (inputs) => {
      const refs = await nativeSave(inputs);
      saved.resolve(refs);
      await release.promise;
      return refs;
    });
    const cancellation = new AbortController();
    const pending = direct(f, parent, [image(png(41))], cancellation.signal);
    const rejected = assert.rejects(pending);
    const refs = await saved.promise;
    cancellation.abort(new Error("Synthetic selection revoked during image storage"));
    release.resolve();
    await rejected;
    assert.equal(f.requests.length, 0);
    assert.equal(f.flow.status(f.workspaceId).active.length, 0);
    // Already-published immutable objects are retained; cancellation must never
    // unlink shared content-addressed attachments while pretending to roll back.
    assert.ok((await f.ctx.attachments.readImage(refs[0])).data.length > 0);
  },
);
