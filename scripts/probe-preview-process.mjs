// Explicit synthetic preview-process acceptance; never loads a user profile.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { processHostFixture, processHostNode } from "../tests/helpers/process-host-fixture.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const selectedRoot = process.env.DSH_UNLIMIT_RUNTIME;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceDigests = [
  "scripts/probe-preview-process.mjs",
  "tests/helpers/process-host-fixture.mjs",
  "src/host/processes.js",
  "src/host/tools.js",
  "src/host/official-package.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(projectRoot, path))) }));
let completedEvidence;
// Late node:test or cleanup failures must not publish a passed receipt.
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(projectRoot, "docs/evidence/preview-process-acceptance.json"),
      completedEvidence,
    );
});

test(
  "fixed preview responds over loopback and refuses connections after its owned process stops",
  { timeout: 30000 },
  async (t) => {
    assert.equal(process.execPath, processHostNode);
    assert.equal(process.version, "v24.21.0");
    assert.equal(process.platform, "darwin");
    assert.equal(process.arch, "arm64");
    assert.equal(typeof selectedRoot, "string", "Select the official runtime explicitly");
    assert.equal(process.env.PATH, "/usr/bin:/bin");
    assert.deepEqual(
      Object.keys(process.env)
        .filter((name) => name !== "__CF_USER_TEXT_ENCODING")
        .sort(),
      ["DSH_UNLIMIT_RUNTIME", "PATH"],
    );
    assert.deepEqual(process.execArgv, ["--expose-internals"]);
    assert.deepEqual(process.argv.slice(2), []);
    const f = await processHostFixture(t, selectedRoot, { preview: true });
    const item = await f.start("preview", { behavior: "preview" });
    assert.equal(item.status, "running");
    assert.equal(item.mode, "danger-full-access");
    assert.equal(item.enforcement, "none");
    await f.ready(item, "preview");
    const response = await f.requestPreview();
    assert.equal(response.status, 200);
    assert.equal(response.body, f.previewBody);
    const stopped = await f.stop(item);
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.item.status, "stopped");
    assert.equal(stopped.item.exitCode, 0);
    assert.equal(stopped.item.exitSignal, null);
    const lifecycle = await f.closed("preview");
    assert.deepEqual(
      lifecycle.map((event) => event.type),
      ["spawn", "exit", "close"],
    );
    assert.equal(lifecycle.at(-1).code, 0);
    const output = await f.output(item);
    assert.ok(output.stdout.text.includes("signal:preview:SIGTERM\n"));
    assert.ok(output.stdout.text.includes("preview:closed\n"));
    assert.deepEqual(await f.requestPreview({ refused: true }), {
      refused: true,
      code: "ECONNREFUSED",
    });
    await f.dispose();
    const evidence = f.evidence();
    assert.equal(evidence.launches.length, 1);
    assert.ok(evidence.launches.every((row) => row.closed));
    assert.equal(evidence.fixtureRootRemoved, true);
    assert.deepEqual(evidence.networkAttempts, []);
    assert.equal(evidence.preview.connections.length, 2);
    assert.ok(evidence.preview.connections.every((row) => row.closed));
    assert.ok(evidence.preview.directToolRuntimeCalls >= 4);
    completedEvidence =
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          behaviorId: "CORE-DELIVERABLE",
          slice: "owned-loopback-preview-process",
          status: "passed",
          command:
            "env -i PATH=/usr/bin:/bin DSH_UNLIMIT_RUNTIME=<official-runtime> <bundled-node> --expose-internals scripts/probe-preview-process.mjs",
          ...evidence,
          sourceDigests,
          cases: [
            { id: "PREVIEW-PLUGIN-TOOL-START", result: "passed" },
            { id: "PREVIEW-ACTUAL-HTTP-RESPONSE", result: "passed" },
            { id: "PREVIEW-STOP-EXIT-AND-CLOSE", result: "passed" },
            { id: "PREVIEW-POST-STOP-CONNECTION-REFUSED", result: "passed" },
          ],
          boundaries: {
            actualOfficialToolRuntime: true,
            actualPluginToolRegistration: true,
            actualOfficialSubprocessService: true,
            syntheticAgentRegistered: true,
            syntheticExecution: true,
            syntheticAdmission: true,
            syntheticFullAccessPolicy: true,
            fixtureToolIdNmapMappedToBundledNode: true,
            realToolIdentityVerified: false,
            agentLoopExecuted: false,
            modelRequests: 0,
            productionToolEventsFabricated: false,
            realHumanApprovalVerified: false,
            kernelSandboxVerified: false,
            fixedChildSourceUsesOnlyLoopback: true,
            childNetworkKernelRestricted: false,
            renderedBrowserPreviewVerified: false,
            desktopFileCardVerified: false,
            nativeApplicationOpened: false,
            realDesktopTouched: false,
            realProfileLoadedOrModified: false,
            transportAuthenticationVerified: false,
          },
        },
        null,
        2,
      ) + "\n";
    t.diagnostic(
      JSON.stringify({
        cases: 4,
        actualHttpResponse: 200,
        stopped: true,
        postStopError: "ECONNREFUSED",
        rootsRemoved: true,
      }),
    );
  },
);
