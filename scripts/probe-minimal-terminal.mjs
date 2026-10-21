// Explicit full minimal-preset PTY acceptance using only disposable synthetic input.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
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
  "scripts/probe-minimal-terminal.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/minimal-terminal-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/native-instructions.js",
  "src/host/permission-defaults.js",
  "src/host/prompt-refresh.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((e) => e.type === type);
const readCommand =
  'printf \'PRIOR:%s\\n\' "${dsh_unlimit_line-unset}"; IFS= read -r dsh_unlimit_line < ./evidence.txt; printf \'READ:%s\\nPID:%s\\nHOME:%s\\nHISTORY:%s:%s:%s\\n\' "$dsh_unlimit_line" "$$" "$HOME" "$HISTFILE" "$HISTSIZE" "$HISTFILESIZE"';
const stateCommand = 'printf \'STATE:%s\\nPID:%s\\n\' "$dsh_unlimit_line" "$$"';
const bash = (command) => ({ name: "bash", arguments: { command } });
const unwrap = (value) => {
  while (value?.[Symbol.for("cordis.original")]) value = value[Symbol.for("cordis.original")];
  return value;
};
let completedEvidence;
// node:test also reports late asynchronous failures. Do not publish a passed
// receipt merely because the test body has finished successfully.
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/minimal-terminal-acceptance.json"),
      completedEvidence,
    );
});

test(
  "full minimal preset reads text and retains state in the real official PTY",
  { timeout: 45000 },
  async (t) => {
    const f = await presetFixture(
      t,
      INSTALLED,
      join(presetProjectRoot, "artifacts/official-packages"),
      { presetId: "minimal", terminalExecution: true },
    );
    const sessions = [],
      registryBindings = [],
      abortListeners = [];
    const removeAbortListeners = () => {
      for (const listener of abortListeners.splice(0))
        t.signal.removeEventListener("abort", listener);
    };
    t.after(removeAbortListeners);
    let baselineTools, persona;
    const scenario = (name, action) =>
      t.test(name, async () => {
        try {
          await action();
        } catch (error) {
          console.error(error);
          throw error;
        }
      });
    t.after(() => {
      const isolation = f.evidence().isolation;
      console.log(
        "Minimal cleanup",
        JSON.stringify({
          rootsRemoved: isolation.rootsRemoved,
          errors: isolation.cleanupErrors,
          backend: isolation.minimalTerminalBackend.cleanup,
        }),
      );
    });
    const create = async (suffix, actions) => {
      const agent = await f.create(suffix, actions);
      const cancel = () => agent.cancel({ kind: "user" });
      abortListeners.push(cancel);
      t.signal.addEventListener("abort", cancel, { once: true });
      const registry = unwrap(f.ctx.agentPresets.serviceFor(agent, "terminals"));
      assert.ok(registry);
      assert.equal(
        f.ctx.get("terminals"),
        undefined,
        "Terminal registry must stay inside the minimal preset",
      );
      assert.equal(f.ctx.agentPresets.serviceFor(agent, "planMode"), undefined);
      assert.deepEqual(registry.list(agent), []);
      registryBindings.push({ registry, agent });
      return agent;
    };
    const run = (agent) =>
      f.minimalTerminal.run(async () => {
        await f.run(agent);
        for (const result of events(agent, "tool/result"))
          assert.equal(result.data.message.isError, false, text([result.data.message]));
      });
    const capture = (agent, commands, mode) => {
      const observed = f.requests.filter((r) => r.sessionId === agent.id);
      assert.equal(observed.length, commands.length + 1);
      for (const request of observed) assert.deepEqual(request.tools, baselineTools);
      const calls = events(agent, "tool/call"),
        results = events(agent, "tool/result");
      assert.equal(calls.length, commands.length);
      assert.equal(results.length, commands.length);
      const backend = f.minimalTerminal.evidence();
      const launch = backend.launches.at(-1);
      assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
      const expected = [
        `PRIOR:unset\nREAD:${f.content}\nPID:${launch.pid}\nHOME:${join(f.directory, "home")}\nHISTORY:/dev/null:0:0`,
        `STATE:${f.content}\nPID:${launch.pid}`,
      ].map((output) => `${output}\n[Command finished with exit code 0]`);
      for (let i = 0; i < commands.length; i++) {
        assert.equal(calls[i].data.name, "bash");
        assert.equal(typeof calls[i].data.arguments, "string");
        assert.deepEqual(JSON.parse(calls[i].data.arguments), { command: commands[i] });
        assert.equal(text([results[i].data.message]), expected[i]);
        const projected = observed[i + 1].messages.filter((m) => m.role === "tool");
        assert.deepEqual(
          projected,
          results.slice(0, i + 1).map((e) => e.data.message),
        );
      }
      const system = text(observed[0].messages.filter((m) => m.role === "system"));
      assert.equal(system.includes(f.settings.prompt), mode === "replace");
      assert.equal(system.includes(persona), mode === "revert");
      const registry = registryBindings.find((row) => row.agent === agent).registry;
      const terminals = registry.list(agent);
      assert.equal(terminals.length, 1, "One persistent terminal per owning Agent");
      const logs = join(f.directory, "logs");
      const paths = readdirSync(logs, { recursive: true }).filter(
        (p) => p.endsWith(".jsonl") && p.split(sep).includes(agent.id),
      );
      assert.equal(paths.length, 1);
      const raw = readFileSync(join(logs, paths[0]));
      const physical = raw
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const type of ["tool/call", "tool/result"])
        assert.deepEqual(
          physical.filter((row) => row.type === type),
          events(agent, type),
        );
      sessions.push({
        id: agent.id,
        mode,
        requests: observed.length,
        toolCalls: calls.map((e) => e.data.name),
        terminalSessionId: terminals[0].sessionId,
        shellPid: launch.pid,
        onePersistentPty: true,
        outputs: results.map((e) => text([e.data.message])),
        persistedEvents: agent.session.snapshotEvents().length,
        physicalJsonlRows: physical.length,
        jsonlSha256: hash(raw),
        actualJsonlEventsEqual: true,
        nextModelToolResultsEqual: true,
      });
    };
    await scenario("MINIMAL-TEXT-AND-PERSISTENT-STATE", async () => {
      const agent = await create("terminal-replace", [
        [bash(readCommand)],
        [bash(stateCommand)],
        "finish",
      ]);
      const original = await f.unadaptedAssembly(agent);
      const personaSection = original.sections.find(
        (s) => s.name === f.api.prompt.PERSONA_PREFIX_SECTION,
      );
      assert.ok(personaSection);
      persona = f.api.prompt.renderPrompt({ ...original, sections: [personaSection] });
      assert.ok(persona.length > 0);
      baselineTools = structuredClone(original.tools);
      assert.deepEqual(baselineTools.map((tool) => tool.name).sort(), ["bash", "read_image"]);
      assert.deepEqual((await f.assemble(agent)).tools, baselineTools);
      await run(agent);
      capture(agent, [readCommand, stateCommand], "replace");
    });
    assert.equal(sessions.length, 1, "The persistent state scenario must pass before revert");
    await scenario("MINIMAL-TEXT-REVERT", async () => {
      f.adapter.revert();
      const agent = await create("terminal-revert", [[bash(readCommand)], "finish"]);
      assert.deepEqual((await f.assemble(agent)).tools, baselineTools);
      await run(agent);
      capture(agent, [readCommand], "revert");
      assert.notEqual(sessions[0].shellPid, sessions[1].shellPid);
      if (registryBindings[0].registry === registryBindings[1].registry)
        assert.notEqual(sessions[0].terminalSessionId, sessions[1].terminalSessionId);
    });
    assert.equal(sessions.length, 2);
    assert.equal(f.requests.length, 5);
    assert.deepEqual(f.errors, []);
    removeAbortListeners();
    await f.dispose();
    for (const { registry, agent } of registryBindings) assert.deepEqual(registry.list(agent), []);
    const evidence = {
      schemaVersion: 1,
      behaviorId: "CORE-MODES",
      developmentBasis: "977e019fc477c120ecf44375ed153e980cdc4df0",
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: { os: process.platform, arch: process.arch },
      initialEnvironmentNames,
      ...f.evidence(),
      sessions,
      schemas: {
        names: baselineTools.map((tool) => tool.name),
        sha256: hash(JSON.stringify(baselineTools)),
        allRequestsIdentical: true,
      },
      promptVerification: {
        officialPersonaSha256: hash(persona),
        replaceAndRevertActualRequests: true,
      },
      calls: {
        syntheticModelRequests: 5,
        agentLoopBashCalls: 3,
        nativePtyLaunches: 2,
        directToolRuntimeCalls: 0,
      },
      sourceDigests,
      boundaries: {
        completeMinimalPresetMounted: true,
        actualOfficialLoaderAndRegistry: true,
        actualAgentLoop: true,
        actualOfficialPersistentPty: true,
        actualJsonlReadback: true,
        ownerTerminalRegistriesEmptyAfterDispose: true,
        syntheticModelResponses: true,
        syntheticCommandsUseBashBuiltins: true,
        officialStartupUsesStty: true,
        realDesktopExecuted: false,
        originalSeatbeltProfileUnmodified: true,
        kernelReadAndNetworkWhitelist: false,
        otherToolsOrWriteRefusalVerified: false,
      },
      result: "passed",
    };
    const serialized = JSON.stringify(evidence, null, 2)
      .replaceAll(f.runtime.root, "<clean-runtime>")
      .replaceAll(f.directory, "<synthetic-root>")
      .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>");
    assert.ok(!serialized.includes("/Users/"));
    completedEvidence = serialized + "\n";
  },
);
