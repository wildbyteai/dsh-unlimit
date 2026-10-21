import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebScope } from "../src/host/web-scope.js";

test("unknown desktop versions never touch host services or import a runtime", async () => {
  const adapter = new WebScope(
    { get: () => assert.fail("unknown host must not be queried") },
    { dispatch: () => assert.fail("no state mutation") },
    { kind: "desktop", version: "0.2.2", supported: false, runtimeRoot: "/unavailable" },
    { scope: {} },
  );
  assert.equal(adapter.capabilities()[0].state, "unsupported");
  await assert.rejects(adapter.apply(), { code: "UNSUPPORTED_CAPABILITY" });
  assert.deepEqual(await adapter.stopAll(), { stopped: true });
  await adapter.revert();
});

test("an entry digest mismatch is refused before executing even a synthetic module", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dsh-unlimit-http-gate-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relative = "node_modules/@deepseek-ai/dsh-web-fetch-http/index.js";
  mkdirSync(join(root, "node_modules/@deepseek-ai/dsh-web-fetch-http"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(root, "node_modules/@deepseek-ai/dsh-web-fetch-http/package.json"),
    '{"type":"module","main":"index.js"}',
  );
  writeFileSync(join(root, relative), "globalThis.__syntheticHttpGateExecuted = true;\n");
  writeFileSync(
    join(root, "desktop-runtime.json"),
    JSON.stringify({
      release: { version: "0.2.1-rc.2" },
      files: [{ path: relative, sha256: "mismatch" }],
    }),
  );
  const adapter = new WebScope(
    { get: () => assert.fail("unverified runtime must not access host services") },
    {},
    { kind: "desktop", version: "0.2.1-rc.2", supported: true, runtimeRoot: root },
    { scope: {} },
  );
  assert.equal(adapter.capabilities()[0].state, "unsupported");
  await assert.rejects(adapter.apply(), { code: "UNSUPPORTED_CAPABILITY" });
  assert.equal(globalThis.__syntheticHttpGateExecuted, undefined);
});
