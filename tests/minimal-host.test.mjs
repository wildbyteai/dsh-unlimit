import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { presetFixture, presetProjectRoot } from "./helpers/preset-fixture.mjs";

const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);

// An original 1x1 RGBA PNG, built from format fields and one chosen pixel.
// The synthetic EXIF orientation forces the real attachment normalizer to re-encode it.
function syntheticPng() {
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
  const exif = Buffer.alloc(26);
  exif.write("II");
  exif.writeUInt16LE(42, 2);
  exif.writeUInt32LE(8, 4);
  exif.writeUInt16LE(1, 8);
  exif.writeUInt16LE(0x112, 10);
  exif.writeUInt16LE(3, 12);
  exif.writeUInt32LE(1, 14);
  exif.writeUInt16LE(1, 18);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("eXIf", exif),
    chunk("IDAT", deflateSync(Buffer.from([0, 41, 83, 149, 128]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test(
  "complete official minimal preset drives real image reads while preserving its own composition",
  {
    skip:
      selectedRoot && cache ? false : "Set both official runtime variables; no profile is loaded",
    timeout: 45000,
  },
  async (t) => {
    // Native objects bypass the JavaScript load hook. Verify the image backend
    // before presetFixture imports any official module or mounts any service.
    const nativeInventoryBytes = readFileSync(join(selectedRoot, "desktop-runtime.json"));
    const nativeImageBackend = JSON.parse(nativeInventoryBytes)
      .files.filter(
        (row) =>
          row.path.startsWith("node_modules/@img/sharp") && /\.(?:node|dylib)$/.test(row.path),
      )
      .map((row) => {
        const bytes = readFileSync(join(selectedRoot, row.path));
        assert.equal(hash(bytes), row.sha256);
        assert.equal(bytes.length, row.bytes);
        return { path: row.path, bytes: bytes.length, sha256: hash(bytes), inventoryMatch: true };
      });
    assert.equal(nativeImageBackend.length, 2);
    const f = await presetFixture(t, selectedRoot, cache, {
      presetId: "minimal",
      modelModalities: {
        "synthetic-model": ["text", "image"],
        "synthetic-text-only": ["text"],
      },
    });
    assert.equal(f.evidence().inventorySha256, hash(nativeInventoryBytes));
    const imageBytes = syntheticPng();
    const imagePath = join(f.workspace, "synthetic-pixel.png");
    writeFileSync(imagePath, imageBytes);
    const call = { name: "read_image", arguments: { file_path: imagePath } };
    const scenarios = [],
      sessions = [],
      promptVerification = [],
      images = [],
      routeQueries = [];
    const io = { readBytes: 0, saveImage: 0 };
    const resolveModelInfo = f.ctx.llm.resolveModelInfo;
    t.mock.method(f.ctx.llm, "resolveModelInfo", async function (...args) {
      const info = await Reflect.apply(resolveModelInfo, this, args);
      const agent = f.ctx.agents.get(f.requests.at(-1)?.sessionId);
      routeQueries.push({
        provider: args[0],
        model: args[1],
        inputModalities: info.inputModalities,
        duringToolExecution:
          agent !== undefined &&
          events(agent, "tool/call").length > events(agent, "tool/result").length,
      });
      return info;
    });
    const gateQueries = () =>
      routeQueries
        .filter((row) => row.duringToolExecution)
        .map(({ duringToolExecution, ...row }) => row);
    const readBytes = f.ctx.fs.readBytes;
    t.mock.method(f.ctx.fs, "readBytes", function (...args) {
      io.readBytes++;
      return Reflect.apply(readBytes, this, args);
    });
    const saveImage = f.ctx.attachments.saveImage;
    t.mock.method(f.ctx.attachments, "saveImage", function (...args) {
      io.saveImage++;
      return Reflect.apply(saveImage, this, args);
    });
    const observed = (agent) => f.requests.filter((r) => r.sessionId === agent.id);
    const verifyComposition = (agent) => {
      assert.equal(f.composition.id, "minimal");
      assert.equal(f.composition.isDefault, true);
      assert.equal(f.composition.rows.length, 9);
      assert.equal(f.composition.rows.filter((r) => r.enabled).length, 7);
      assert.equal(f.ctx.agentPresets.serviceFor(agent, "planMode"), undefined);
      assert.equal(f.ctx.get("planMode"), undefined);
      for (const name of ["terminals", "compaction"]) {
        assert.equal(f.ctx.get(name), undefined, `${name} must stay inside the retained preset`);
        assert.ok(f.ctx.agentPresets.serviceFor(agent, name));
      }
      const terminals = f.ctx.agentPresets.serviceFor(agent, "terminals");
      assert.deepEqual(terminals.listBackends(), ["shell"]);
      assert.deepEqual(terminals.list(agent), [], "No persistent terminal is started");
      const compositions = f.ctx.agentPresets.inspectCompositions(agent.ctx);
      assert.equal(compositions.length, 1);
      assert.deepEqual(compositions[0].leakedServices, []);
      assert.equal(events(agent, "plan/mode").length, 0);
    };
    const capture = (agent) => {
      const logs = join(f.directory, "logs");
      const paths = readdirSync(logs, { recursive: true }).filter(
        (path) => path.endsWith(".jsonl") && path.split(sep).includes(agent.id),
      );
      assert.equal(paths.length, 1, "One actual plaintext JSONL artifact must exist per Agent");
      const raw = readFileSync(join(logs, paths[0]));
      const physical = raw
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((row) => JSON.parse(row));
      assert.deepEqual(
        physical.filter((row) => row.type === "tool/result"),
        events(agent, "tool/result"),
        "Actual JSONL tool results must preserve the canonical result and image reference",
      );
      sessions.push({
        id: agent.id,
        requests: observed(agent).length,
        toolCalls: events(agent, "tool/call").map((e) => e.data.name),
        persistedEvents: agent.session.snapshotEvents().length,
        physicalJsonlRows: physical.length,
        jsonlSha256: hash(raw),
        actualJsonlToolResultsEqual: true,
        preset: f.ctx.agentPresets.composedPreset(agent.ctx),
      });
    };
    const verifyImage = async (agent) => {
      const result = events(agent, "tool/result")[0].data.message;
      assert.equal(result.isError, false, text([result]));
      assert.deepEqual(
        result.content.map((b) => b.type),
        ["text", "image"],
      );
      assert.ok(text([result]).includes(imagePath));
      const ref = result.content[1].attachment;
      assert.equal(ref.width, 1);
      assert.equal(ref.height, 1);
      assert.equal(ref.name, basename(imagePath));
      assert.equal(ref.mediaType, "image/webp");
      assert.equal(ref.originalDimensions, undefined);
      const stored = await f.ctx.attachments.readImage(ref);
      const normalized = Buffer.from(stored.data);
      assert.equal(normalized.length, ref.bytes);
      assert.equal(ref.attachmentId, `sha256:${hash(normalized)}`);
      assert.notDeepEqual(normalized, imageBytes, "The EXIF-bearing source must be normalized");
      assert.equal(normalized.toString("ascii", 0, 4), "RIFF");
      assert.equal(normalized.toString("ascii", 8, 12), "WEBP");
      assert.deepEqual(readFileSync(f.ctx.attachments.imageHostPath(ref)), normalized);
      assert.deepEqual(readFileSync(imagePath), imageBytes, "Source bytes remain unchanged");
      const requests = observed(agent);
      assert.equal(requests.length, 2);
      assert.equal(
        requests[0].messages.flatMap((m) => m.content).some((b) => b.type === "image"),
        false,
      );
      assert.deepEqual(
        requests[1].messages.find((m) => m.role === "tool"),
        result,
      );
      assert.deepEqual(
        requests[1].messages.flatMap((m) => m.content).filter((b) => b.type === "image"),
        [{ type: "image", attachment: ref }],
        "The subsequent actual model request receives the durable normalized image reference",
      );
      images.push({
        sessionId: agent.id,
        source: {
          mediaType: "image/png",
          width: 1,
          height: 1,
          bytes: imageBytes.length,
          sha256: hash(imageBytes),
        },
        normalized: { ...ref, sha256: hash(normalized) },
        sourceUnchanged: true,
        actualAttachmentReadAndFileBytesEqual: true,
        subsequentModelImageReferenceEqual: true,
      });
    };
    let originalPersona;
    try {
      await t.test("MINIMAL-IMAGE-READ-AND-RETAINED-COMPOSITION", async () => {
        const agent = await f.create("image", [[call], "finish"]);
        verifyComposition(agent);
        const baseline = await f.unadaptedAssembly(agent);
        const persona = baseline.sections.find(
          (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
        );
        assert.ok(persona);
        originalPersona = f.api.prompt.renderPrompt({ ...baseline, sections: [persona] });
        assert.ok(originalPersona.length > 0);
        await f.run(agent);
        await verifyImage(agent);
        verifyComposition(agent);
        const system = text(observed(agent)[0].messages.filter((m) => m.role === "system"));
        assert.ok(system.includes(f.settings.prompt));
        assert.equal(system.includes(originalPersona), false);
        promptVerification.push({
          id: "MINIMAL-PERSONA-REPLACED",
          officialRenderedSha256: hash(originalPersona),
          result: "passed",
        });
        assert.deepEqual(
          observed(agent)[0]
            .tools.map((tool) => tool.name)
            .toSorted(),
          ["bash", "read_image"],
        );
        assert.deepEqual(io, { readBytes: 1, saveImage: 1 });
        assert.deepEqual(gateQueries(), [
          {
            provider: "synthetic-minimal-offline",
            model: "synthetic-model",
            inputModalities: ["text", "image"],
          },
        ]);
        capture(agent);
        scenarios.push({ id: "MINIMAL-IMAGE-READ-AND-RETAINED-COMPOSITION", result: "passed" });
      });
      await t.test("MINIMAL-TEXT-ONLY-ROUTE-REFUSES-BEFORE-IMAGE-IO", async () => {
        const before = { ...io };
        const agent = await f.create("text-only", [[call], "finish"], {
          model: "synthetic-text-only",
        });
        await f.run(agent);
        verifyComposition(agent);
        const result = events(agent, "tool/result")[0].data.message;
        assert.equal(result.isError, true);
        assert.match(text([result]), /model "synthetic-text-only" does not declare image input/);
        assert.deepEqual(
          io,
          before,
          "The official route gate refuses before filesystem or attachment work",
        );
        assert.deepEqual(gateQueries().at(-1), {
          provider: "synthetic-minimal-offline",
          model: "synthetic-text-only",
          inputModalities: ["text"],
        });
        assert.equal(gateQueries().length, 2);
        assert.deepEqual(
          observed(agent)[1].messages.find((m) => m.role === "tool"),
          result,
        );
        assert.equal(
          observed(agent)
            .flatMap((r) => r.messages)
            .flatMap((m) => m.content)
            .some((b) => b.type === "image"),
          false,
        );
        capture(agent);
        scenarios.push({ id: "MINIMAL-TEXT-ONLY-ROUTE-REFUSES-BEFORE-IMAGE-IO", result: "passed" });
      });
      await t.test("MINIMAL-REVERT-RESTORES-PERSONA-AND-RETAINS-CATALOG", async () => {
        f.adapter.revert();
        const agent = await f.create("restored", [[call], "finish"]);
        await f.run(agent);
        await verifyImage(agent);
        verifyComposition(agent);
        const system = text(observed(agent)[0].messages.filter((m) => m.role === "system"));
        assert.equal(system.includes(f.settings.prompt), false);
        assert.ok(system.includes(originalPersona));
        promptVerification.push({
          id: "MINIMAL-PERSONA-RESTORED",
          officialRenderedSha256: hash(originalPersona),
          result: "passed",
        });
        assert.deepEqual(io, { readBytes: 2, saveImage: 2 });
        assert.equal(gateQueries().length, 3);
        assert.deepEqual(gateQueries()[2], gateQueries()[0]);
        assert.deepEqual(images[0].normalized, images[1].normalized);
        capture(agent);
        scenarios.push({
          id: "MINIMAL-REVERT-RESTORES-PERSONA-AND-RETAINS-CATALOG",
          result: "passed",
        });
      });
      assert.equal(
        scenarios.length,
        3,
        "Every scenario must finish before success evidence is published",
      );
      assert.deepEqual(f.errors, []);
      for (const request of f.requests) {
        assert.deepEqual(request.tools, f.requests[0].tools);
        assert.equal(request.plan, undefined);
      }
      assert.deepEqual(
        sessions.flatMap((s) => s.toolCalls),
        ["read_image", "read_image", "read_image"],
      );
      assert.equal(hash(readFileSync(join(f.runtime.root, f.patchPath))), f.patchSha256);
    } finally {
      await f.dispose();
    }
    const evidence = f.evidence();
    assert.deepEqual(evidence.isolation.networkAttempts, []);
    assert.deepEqual(evidence.isolation.subprocessAttempts, []);
    assert.deepEqual(evidence.isolation.filesystemAttempts, []);
    assert.equal(evidence.isolation.guardsHeldThroughOfficialLifecycle, true);
    assert.equal(evidence.isolation.guardsHeldThroughTemporaryRootCleanup, true);
    assert.equal(evidence.isolation.rootsRemoved, true);
    for (const row of nativeImageBackend)
      assert.equal(hash(readFileSync(join(selectedRoot, row.path))), row.sha256);
    if (process.env.DSH_UNLIMIT_MINIMAL_EVIDENCE === "1") {
      const paths = [
        "tests/minimal-host.test.mjs",
        "tests/helpers/preset-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "tests/fixtures/official-preset-packages.json",
        "src/host/runtime.js",
        "src/core/prompts.js",
        "src/host/desktop.js",
        "src/host/official-package.js",
        "src/host/native-instructions.js",
        "src/host/permission-defaults.js",
        "src/host/prompt-refresh.js",
      ];
      writeFileSync(
        join(presetProjectRoot, "docs/evidence/minimal-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            behaviorId: "CORE-MODES",
            slice: "complete-minimal-image-path",
            generatedAt: new Date().toISOString(),
            node: process.version,
            platform: { os: process.platform, arch: process.arch },
            ...evidence,
            nativeImageBackend,
            scenarios,
            sessions,
            images,
            routeQueries,
            promptVerification,
            schemas: {
              sha256: hash(JSON.stringify(f.requests[0].tools)),
              names: f.requests[0].tools.map((tool) => tool.name),
              count: 2,
              allRequestsIdentical: true,
            },
            testResult: { tests: 4, passed: 4, failed: 0, skipped: 0 },
            calls: {
              syntheticModelRequests: f.requests.length,
              agentLoopToolCalls: 3,
              readImageSucceeded: 2,
              readImageRejectedByRoute: 1,
              directToolRuntimeCalls: 0,
              imageIo: io,
            },
            sourceDigests: paths.map((path) => ({
              path,
              sha256: hash(readFileSync(join(presetProjectRoot, path))),
            })),
            boundaries: {
              completeMinimalPresetMounted: true,
              originalDeclarationUnmodified: true,
              actualOfficialLoaderAndRegistry: true,
              exactRetainedRevisionScopeIdentity: true,
              actualAgentLoop: true,
              actualImageCapabilityGate: true,
              modelInfoAttachmentAndFilesystemSpiesDelegateToRealMethods: true,
              actualAttachmentDecodeNormalizationAndStorage: true,
              nativeImageSha256MatchedBeforeOfficialImportsAndAfterCleanup: true,
              actualJsonlAndEventReadback: true,
              noPlanModeOrLeakedServices: true,
              bashOrPersistentTerminalExecuted: false,
              ptcExecuted: false,
              coreModesSameTextTaskCompleted: false,
              realDesktopExecuted: false,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
