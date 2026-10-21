// Explicit synthetic PTY permission revocation acceptance; never loads a real profile.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { presetFixture, presetProjectRoot } from "../tests/helpers/preset-fixture.mjs";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const initialEnvironmentNames = Object.keys(process.env).sort();
delete process.env.__CF_USER_TEXT_ENCODING;
assert.equal(process.execPath, NODE);
assert.equal(process.version, "v24.21.0");
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
assert.deepEqual(process.execArgv, ["--expose-internals"]);
assert.deepEqual(process.argv.slice(2), []);
assert.deepEqual(Object.keys(process.env).sort(), ["DSH_UNLIMIT_RUNTIME", "PATH"]);
assert.equal(process.env.PATH, "/usr/bin:/bin");
assert.equal(process.env.DSH_UNLIMIT_RUNTIME, INSTALLED);
assert.equal(realpathSync(INSTALLED), INSTALLED);
assert.equal(
  hash(readFileSync(join(INSTALLED, "desktop-runtime.json"))),
  "3b264f1d9d4d3dc01e37aa382b2575a9dda6e34480af04982921b7d7720f0ef0",
);
const sourceDigests = [
  "scripts/probe-terminal-permissions.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/minimal-terminal-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/terminal-ownership.js",
  "src/host/native-instructions.js",
  "src/host/permission-defaults.js",
  "src/host/prompt-refresh.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const bash = (command) => [{ name: "bash", arguments: { command } }];
let completedEvidence;
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/terminal-revocation-acceptance.json"),
      completedEvidence,
    );
});
test(
  "persistent PTY permissions follow spawn policy and native mode-change fence",
  { timeout: 60000 },
  async (t) => {
    const f = await presetFixture(
      t,
      INSTALLED,
      join(presetProjectRoot, "artifacts/official-packages"),
      { presetId: "minimal", terminalExecution: true },
    );
    const outside = join(f.directory, "outside");
    mkdirSync(outside);
    const scenarios = [];
    const value = "SYNTHETIC_PTY_PERMISSION";
    const command = (path) => `printf '%s' ${quote(value)} > ${quote(path)}`;
    const run = async (agent, actions, modes) => {
      const before = events(agent, "tool/result").length;
      f.script(agent.id, [...actions, "finish"]);
      await f.minimalTerminal.run(() => f.run(agent), modes);
      return events(agent, "tool/result")
        .slice(before)
        .map((row) => row.data.message);
    };
    const expectWrite = (result, path, allowed) => {
      assert.equal(existsSync(path), allowed, text([result]));
      if (allowed) assert.equal(readFileSync(path, "utf8"), value);
      assert.equal(result.isError, false, "A completed command is not a failed tool invocation");
      assert.ok(
        text([result]).includes(`[Command finished with exit code ${allowed ? 0 : 1}]`),
        text([result]),
      );
      if (!allowed) assert.match(text([result]), /Operation not permitted|Permission denied/);
    };
    try {
      await t.test(
        "canonical workspace policy requires closing the old terminal before read-only",
        async () => {
          const agent = await f.create("permission-canonical", []);
          f.api.sandboxPolicy.setSandboxMode(agent.session, "workspace-write");
          const inside = join(f.workspace, "canonical-in.txt"),
            out = join(outside, "canonical-out.txt");
          const first = await run(
            agent,
            [bash(command(inside)), bash(command(out))],
            ["workspace-write"],
          );
          expectWrite(first[0], inside, true);
          expectWrite(first[1], out, false);
          const modes = events(agent, "sandbox/mode");
          assert.throws(
            () => f.api.sandboxPolicy.setSandboxMode(agent.session, "read-only"),
            /while persistent terminal sessions are open/,
          );
          assert.deepEqual(events(agent, "sandbox/mode"), modes);
          assert.equal(
            f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
            "workspace-write",
          );
          const exit = await run(agent, [bash("exit")], []);
          assert.match(text(exit), /shell exited: code 0/);
          const registry = f.ctx.agentPresets.serviceFor(agent, "terminals");
          assert.deepEqual(registry.list(agent), []);
          f.api.sandboxPolicy.setSandboxMode(agent.session, "read-only");
          const after = join(f.workspace, "canonical-after.txt"),
            afterOut = join(outside, "canonical-after-out.txt");
          const second = await run(
            agent,
            [bash(command(after)), bash(command(afterOut))],
            ["read-only"],
          );
          expectWrite(second[0], after, false);
          expectWrite(second[1], afterOut, false);
          scenarios.push({
            id: "canonical-close-then-restrict",
            result: "passed",
            liveModeChangeRejected: true,
            closedBeforeModeChange: true,
            workspaceWriteBefore: true,
            outsideWriteBefore: false,
            insideAndOutsideDeniedAfter: true,
            officialPersistenceReadbackEqual: true,
          });
        },
      );
      await t.test(
        "revert closes only tracked plugin-elevated PTYs and waits for registry cleanup",
        async () => {
          f.settings.fullAccess = true;
          const agent = await f.create("permission-full-default", []);
          assert.equal(f.ctx.sandboxPolicy.overrideOf(agent.session), undefined);
          const before = join(outside, "default-before.txt");
          expectWrite(
            (await run(agent, [bash(command(before))], ["danger-full-access"]))[0],
            before,
            true,
          );
          const launch = f.minimalTerminal.evidence().launches.at(-1);
          const explicit = await f.create("permission-explicit-full", []);
          f.api.sandboxPolicy.setSandboxMode(explicit.session, "danger-full-access");
          expectWrite(
            (
              await run(
                explicit,
                [bash(command(join(outside, "explicit-before.txt")))],
                ["danger-full-access"],
              )
            )[0],
            join(outside, "explicit-before.txt"),
            true,
          );
          const beforeInspection = agent.session.snapshotEvents();
          const inventory = f.adapter.terminalStatus();
          assert.equal(inventory.available, true);
          assert.equal(inventory.scannedAgents, 3);
          assert.equal(inventory.terminals.length, 3);
          const observed = inventory.terminals.find((row) => row.agentId === agent.id);
          assert.equal(observed.terminalId, launch.sessionId);
          assert.equal(observed.startupMode, "danger-full-access");
          assert.equal(observed.elevatedByPlugin, true);
          assert.equal(
            inventory.terminals.find((row) => row.agentId === explicit.id).elevatedByPlugin,
            "unknown",
          );
          await f.adapter.revert();
          assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, "read-only");
          const registry = f.ctx.agentPresets.serviceFor(agent, "terminals");
          assert.deepEqual(registry.list(agent), []);
          assert.deepEqual(agent.session.snapshotEvents(), beforeInspection);
          const afterInventory = f.adapter.terminalStatus();
          assert.equal(
            afterInventory.terminals.length,
            2,
            "Unrelated and explicitly authorized PTYs stay open",
          );
          const after = join(outside, "default-after-revert.txt");
          // Official persistent bash holds a cached id. Its next call reports the
          // closed session and resets that cache; never replay user commands here.
          const reset = (await run(agent, [bash(command(after))], []))[0];
          assert.equal(reset.isError, true);
          assert.match(text([reset]), /unknown PTY session/);
          assert.equal(existsSync(after), false);
          const next = join(outside, "default-after-close.txt");
          expectWrite((await run(agent, [bash(command(next))], ["read-only"]))[0], next, false);
          const explicitAfter = join(outside, "explicit-after.txt");
          expectWrite(
            (await run(explicit, [bash(command(explicitAfter))], []))[0],
            explicitAfter,
            true,
          );
          scenarios.push({
            id: "revert-closes-plugin-elevated-pty",
            result: "passed",
            resolvedModeAfterRevert: "read-only",
            pluginRegistryEmptyAfterAwaitedRevert: true,
            explicitFullAccessPtyPreserved: true,
            unownedReadOnlyPtyPreserved: true,
            firstCachedCallReportsClosedWithoutExecuting: true,
            newPtyOutsideWrite: false,
            sessionEventsUnchangedByRevert: true,
            officialPersistenceReadbackEqual: true,
            terminalInventory: inventory,
          });
        },
      );
      assert.equal(scenarios.length, 2);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.dispose();
    }
    const evidence = {
      schemaVersion: 1,
      behaviorIds: ["CORE-FILES", "CORE-PERMISSION", "DESK-REVERT"],
      developmentBasis: "89651a3abae5b29a131d11715044a4a50cec4718 plus working tree",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      ...f.evidence(),
      scenarios,
      sourceDigests,
      boundaries: {
        syntheticModelResponses: true,
        actualOfficialPersistentPty: true,
        realDesktopExecuted: false,
        realProfileModified: false,
      },
      result: "passed",
    };
    completedEvidence =
      JSON.stringify(evidence, null, 2)
        .replaceAll(f.runtime.root, "<clean-runtime>")
        .replaceAll(f.directory, "<synthetic-root>")
        .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>") + "\n";
    assert.ok(!completedEvidence.includes("/Users/"));
  },
);
