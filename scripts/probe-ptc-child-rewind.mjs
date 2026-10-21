// Explicit fixed-backend acceptance; never part of automatic npm test.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { presetFixture, presetProjectRoot } from "../tests/helpers/preset-fixture.mjs";
import { DesktopSessions } from "../src/host/sessions.js";
import { CHILD_INPUT_RECORD } from "../src/host/child-origins.js";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const hash = (value) => createHash("sha256").update(value).digest("hex");
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
  "scripts/probe-ptc-child-rewind.mjs",
  "tests/helpers/preset-fixture.mjs",
  "tests/helpers/ptc-process-guard.mjs",
  "tests/helpers/official-packages.mjs",
  "tests/fixtures/official-preset-packages.json",
  "src/host/runtime.js",
  "src/host/native-instructions.js",
  "src/host/permission-defaults.js",
  "src/host/prompt-refresh.js",
  "src/host/child-origins.js",
  "src/host/child-rewind.js",
  "src/host/sessions.js",
].map((path) => ({ path, sha256: hash(readFileSync(join(presetProjectRoot, path))) }));
const text = (message) =>
  message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
const events = (agent, type) => agent.session.snapshotEvents().filter((row) => row.type === type);
let completedEvidence;
process.once("exit", (code) => {
  if (code === 0 && completedEvidence !== undefined)
    writeFileSync(
      join(presetProjectRoot, "docs/evidence/ptc-child-rewind-acceptance.json"),
      completedEvidence,
    );
});

function heldResponse() {
  const entered = Promise.withResolvers();
  return {
    entered: entered.promise,
    action: {
      kind: "hold",
      async wait(request) {
        request.signal.throwIfAborted();
        entered.resolve();
        await new Promise((_, reject) => {
          const abort = () => {
            request.signal.removeEventListener("abort", abort);
            reject(request.signal.reason);
          };
          request.signal.addEventListener("abort", abort, { once: true });
          if (request.signal.aborted) abort();
        });
      },
    },
  };
}

test(
  "complete official PTC preset preserves exact child relay origins across rewind and outer failure",
  { timeout: 45000 },
  async (t) => {
    const f = await presetFixture(
      t,
      INSTALLED,
      join(presetProjectRoot, "artifacts/official-packages"),
      { presetId: "ptc", ptcExecution: true },
    );
    const workspaceLookups = [];
    // The scenario is intentionally unbound: this stand-in only supplies the
    // existing null lookup contract, never writes bindings or business state.
    const store = {
      dispatch(action, payload) {
        assert.equal(action, "workspaces.forSession");
        workspaceLookups.push(payload.sessionId);
        return { item: null };
      },
    };
    const desktop = new DesktopSessions(f.ctx, store, {
      host: f.runtime.host,
      enabled: () => f.adapter.enabled && f.settings.enabled,
    });
    const receipts = new Set();
    const deliveries = [];
    const observe = f.ctx.on("tools/result", (exec, result) => {
      if (exec.name !== "send_message") return;
      deliveries.push({
        parentSessionId: exec.agent.id,
        childSessionId: exec.arguments.agent_id,
        callId: exec.callId,
        rootCallId: exec.rootCallId,
        nested: typeof exec.parent === "symbol",
        arguments: structuredClone(exec.arguments),
        isError: result.isError,
        value: structuredClone(result.value),
      });
    });
    const scenarios = [];
    const readbacks = [];
    const actualPrograms = [];
    const readback = async (agent, phase) => {
      await f.ctx.sessionPersistence.flush();
      const journal = agent.session.snapshotEvents();
      const reader = await f.ctx.sessionPersistence.open(agent.id, "read");
      let header;
      try {
        const stored = await reader.read();
        assert.deepEqual(stored.events, journal);
        header = structuredClone(reader.header);
      } finally {
        await reader.close();
      }
      const logs = join(f.directory, "logs");
      const paths = readdirSync(logs, { recursive: true }).filter(
        (path) => path.endsWith(".jsonl") && path.split(sep).includes(agent.id),
      );
      assert.equal(paths.length, 1);
      const bytes = readFileSync(join(logs, paths[0]));
      const physical = bytes
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(physical[0].type, "session");
      for (const field of [
        "version",
        "id",
        "createdAt",
        "cwd",
        "isSeeded",
        "parentSession",
        "origin",
        "agentPreset",
      ])
        assert.deepEqual(physical[0][field], header[field], `physical header ${field}`);
      assert.equal(physical[0].delegationDepth, header.delegationDepth ?? 0);
      assert.equal(physical.length, journal.length + 1);
      assert.deepEqual(physical.slice(1), journal);
      readbacks.push({
        phase,
        sessionId: agent.id,
        eventCount: journal.length,
        physicalRows: physical.length,
        headerComparedSeparately: true,
        physicalEventsEqual: true,
        jsonlSha256: hash(bytes),
      });
      return journal;
    };
    const sendHuman = async (agent, instruction) => {
      agent.followup(
        f.api.llm.createUserMessage({
          source: { kind: "user" },
          content: [{ type: "text", text: instruction }],
        }),
      );
      await agent.whenIdle();
      assert.equal(agent.status, "idle");
      assert.equal(events(agent, "turn/end").at(-1).data.reason.kind, "completed");
    };
    try {
      assert.deepEqual(await desktop.origins.connect(), { state: "active" });
      for (const spec of [
        { id: "PTC-SAME-TEXT-TWO-DELIVERIES", ordinal: 1, count: 2, outerError: false },
        { id: "PTC-DELIVERED-BEFORE-OUTER-ERROR", ordinal: 2, count: 1, outerError: true },
      ]) {
        await t.test(spec.id, async () => {
          const childId = `synthetic-ptc-child-${spec.ordinal}`;
          const childHold = heldResponse();
          f.script(childId, [childHold.action]);
          let parent, child, receipt;
          const creation = `SYNTHETIC_CREATE_CHILD_${spec.id}`;
          const withdrawn = `SYNTHETIC_PARENT_RELAY_TURN_${spec.id}`;
          parent = await f.create(`child-rewind-${spec.ordinal}`, [
            {
              kind: "hold",
              async wait(request) {
                // Transport is synthetic; creation itself is the official API
                // inside the real parent's already-open first turn and step.
                assert.equal(parent.phase.kind, "running");
                assert.equal(parent.phase.turn, 1);
                assert.equal(parent.phase.step, 1);
                receipt = await f.ctx.subagents.startActivation({
                  provider: "spawn",
                  childId,
                  label: "Synthetic PTC child-origin acceptance",
                  request: {
                    parent,
                    maxDepth: f.ctx.subagents.resolveMaxDepth(),
                    agentPreset: "ptc",
                    prompt: [{ type: "text", text: "SYNTHETIC_CHILD_WAIT_FOR_CANCELLATION" }],
                  },
                  signal: request.signal,
                  delivery: "caller",
                });
                receipts.add(receipt);
                child = f.ctx.agents.get(childId);
                assert.ok(child);
                await childHold.entered;
              },
            },
          ]);
          await sendHuman(parent, creation);
          assert.equal(child.status, "running");
          assert.equal(f.ctx.agents.isOwnedBy(child.id, parent), true);
          assert.equal(child.session.header.origin, "subagent");
          assert.equal(child.session.header.parentSession, parent.id);
          assert.equal(f.ctx.agentPresets.composedPreset(child.ctx), "ptc");
          assert.equal(events(child, "subagent/descriptor")[0].data.mode, "continuable");
          const catalog = events(parent, "subagent/catalog");
          assert.equal(catalog.length, 1);
          assert.equal(catalog[0].data.childId, child.id);
          assert.equal(catalog[0].data.childCreatedAt, child.session.header.createdAt);
          const childComposition = f.ctx.agentPresets.inspectCompositions(child.ctx);
          assert.equal(childComposition.length, 1);
          assert.deepEqual(childComposition[0].leakedServices, []);
          assert.deepEqual(
            childComposition[0].modules.map((row) => row.moduleName).sort(),
            f.composition.rows
              .filter((row) => row.enabled)
              .map((row) => row.moduleName)
              .sort(),
          );
          assert.deepEqual(
            (await f.assemble(parent)).tools.map((tool) => tool.name),
            ["run_code"],
          );
          assert.ok(f.ctx.tools.sdkSchemas(parent).some((tool) => tool.name === "send_message"));
          assert.equal(f.ctx.tools.resolveExecution("send_message", parent, false), undefined);
          const args = { agent_id: child.id, message: "SYNTHETIC_IDENTICAL_PTC_RELAY" };
          // These are the complete programs actually sent to the official PTC
          // process: no imports, eval, network operation, or additional tool.
          const program = [
            'if (Object.keys(process.env).length !== 0) throw new Error("unexpected environment");',
            `const args = ${JSON.stringify(args)};`,
            "const first = await tools.send_message(args);",
            ...(spec.count === 2 ? ["const second = await tools.send_message(args);"] : []),
            spec.outerError
              ? 'throw new Error("SYNTHETIC_AFTER_DELIVERY_FAILURE");'
              : "return { first, second, environmentNames: Object.keys(process.env) };",
          ].join("\n");
          actualPrograms.push({
            scenario: spec.id,
            sha256: hash(program),
            tool: "send_message",
            calls: spec.count,
            noImportsEvalNetworkOrOtherTools: true,
          });
          const call = {
            name: "run_code",
            arguments: {
              code: program,
              description: "Deliver only synthetic messages to the exact owned held child.",
              timeoutMs: 3000,
            },
          };
          f.script(parent.id, [[call], "finish"]);
          const requestBefore = f.requests.length;
          await f.ptc.run(() => sendHuman(parent, withdrawn));
          assert.equal(f.requests.length, requestBefore + 2);
          const parentLog = await readback(parent, `${spec.id}:delivered`);
          await readback(child, `${spec.id}:queued`);
          const outerCalls = events(parent, "tool/call");
          const outerResults = events(parent, "tool/result");
          assert.equal(outerCalls.length, 1);
          assert.equal(outerResults.length, 1);
          const root = outerCalls[0];
          const result = outerResults[0];
          assert.equal(root.data.name, "run_code");
          assert.deepEqual(JSON.parse(root.data.arguments), call.arguments);
          assert.equal(result.data.message.isError, spec.outerError);
          assert.deepEqual(result.sourceEventSeqs, [root.seq]);
          if (spec.outerError)
            assert.match(text(result.data.message), /SYNTHETIC_AFTER_DELIVERY_FAILURE/);
          const starts = events(parent, "tool/ptc-dispatch-start");
          const settled = events(parent, "tool/ptc-dispatch");
          const records = events(parent, CHILD_INPUT_RECORD);
          const observed = deliveries.filter((row) => row.parentSessionId === parent.id);
          for (const rows of [starts, settled, records, observed])
            assert.equal(rows.length, spec.count);
          assert.equal(new Set(observed.map((row) => row.value.messageId)).size, spec.count);
          for (const [index, record] of records.entries()) {
            const delivery = observed[index];
            assert.equal(delivery.nested, true);
            assert.equal(delivery.isError, false);
            assert.deepEqual(delivery.arguments, args);
            assert.deepEqual(record.data, {
              version: 2,
              parentSessionId: parent.id,
              parentCreatedAt: parent.session.header.createdAt,
              childSessionId: child.id,
              childCreatedAt: child.session.header.createdAt,
              messageId: delivery.value.messageId,
              callId: delivery.callId,
              callSeq: starts[index].seq,
              rootCallId: root.data.callId,
              rootCallSeq: root.seq,
              turnStartSeq: parentLog.find(
                (row) => row.type === "turn/start" && row.data.turn === 2,
              ).seq,
              stepStartSeq: parentLog.find(
                (row) => row.type === "step/start" && row.data.turn === 2 && row.data.step === 1,
              ).seq,
            });
            assert.equal(record.ignorable, true);
            assert.equal(record.surfaceOp, undefined);
            assert.equal(parent.session.surface.nodes.includes(record.seq), false);
            assert.equal(f.api.sessions.deriveEventMessage(record), null);
            assert.ok(!JSON.stringify(record).includes(args.message));
            for (const row of [starts[index], settled[index]]) {
              assert.equal(row.data.name, "send_message");
              assert.equal(row.data.subCallId, delivery.callId);
              assert.equal(row.data.rootCallId, root.data.callId);
              assert.equal(row.data.parentCallId, root.data.callId);
              assert.deepEqual(row.data.arguments, args);
            }
            assert.equal(settled[index].data.isError, false);
            assert.ok(starts[index].seq < record.seq && record.seq < settled[index].seq);
            const admitted = child.session
              .snapshotEvents()
              .filter((row) => row.type === "agent/inbox/spliced")
              .flatMap((row) => row.data.inserted)
              .filter((message) => message.id === delivery.value.messageId);
            assert.equal(admitted.length, 1);
            assert.deepEqual(admitted[0].source, {
              kind: "agent-message",
              form: "relay",
              senderSessionId: parent.id,
            });
            assert.deepEqual(admitted[0].content, [
              { type: "text", text: `Agent ${parent.id} sent a message: ` },
              { type: "text", text: args.message },
            ]);
            assert.equal(text(admitted[0]), `Agent ${parent.id} sent a message: \n${args.message}`);
          }
          if (!spec.outerError) {
            const returned = JSON.parse(text(result.data.message));
            assert.equal(returned.first.messageId, observed[0].value.messageId);
            assert.equal(returned.second.messageId, observed[1].value.messageId);
            assert.deepEqual(returned.environmentNames, []);
          }
          assert.equal(child.status, "running");
          assert.equal(child.inbox.nextStep.length + child.inbox.nextTurn.length, spec.count);
          const latest = records.at(-1);
          const plan = await desktop.prepare({ sessionId: child.id, childOrigin: "latest" });
          assert.equal(plan.sessionId, parent.id);
          assert.equal(plan.strategy, "fork");
          assert.equal(plan.atSeq, latest.data.turnStartSeq - 1);
          assert.equal(plan.draft, withdrawn);
          assert.equal(plan.mapping.basis, "recorded-input");
          assert.equal(plan.mapping.requestedOrigin, "latest");
          assert.equal(plan.mapping.links.length, 1);
          const link = plan.mapping.links[0];
          assert.equal(link.messageId, observed.at(-1).value.messageId);
          assert.equal(link.callId, latest.data.callId);
          assert.equal(link.callSeq, latest.data.callSeq);
          assert.equal(link.rootCallId, root.data.callId);
          assert.equal(link.rootCallSeq, root.seq);
          assert.equal(link.dispatchSeq, settled.at(-1).seq);
          const requestCount = f.requests.length;
          const rewound = await desktop.rewind({
            sessionId: child.id,
            childOrigin: "latest",
            draftBridgeReady: true,
          });
          assert.equal(rewound.newSessionId === parent.id, false);
          assert.equal(rewound.archived, true);
          assert.equal(rewound.archive.verified, true);
          assert.equal(rewound.draft, withdrawn);
          assert.equal(rewound.atSeq, plan.atSeq);
          assert.deepEqual(rewound.mapping, plan.mapping);
          assert.deepEqual(rewound.stop.pendingIds, []);
          assert.deepEqual(rewound.newSessionStop.pendingIds, []);
          assert.equal(f.requests.length, requestCount, "rewind never sends the restored draft");
          const fork = f.ctx.agents.get(rewound.newSessionId);
          assert.ok(fork);
          assert.equal(fork.status, "idle");
          assert.equal(fork.inbox.nextStep.length + fork.inbox.nextTurn.length, 0);
          assert.equal(child.status, "idle");
          assert.equal(child.inbox.nextStep.length + child.inbox.nextTurn.length, 0);
          const forkLog = await readback(fork, `${spec.id}:fork`);
          assert.deepEqual(
            forkLog.slice(0, fork.session.inheritedEventCount),
            parentLog.slice(0, plan.atSeq + 1),
          );
          assert.equal(events(fork, CHILD_INPUT_RECORD).length, 0);
          assert.equal(
            fork.session.deriveMessages().some((message) => text(message) === withdrawn),
            false,
          );
          await readback(parent, `${spec.id}:archived`);
          await readback(child, `${spec.id}:cancelled`);
          scenarios.push({
            id: spec.id,
            parentSessionId: parent.id,
            childSessionId: child.id,
            childCreatedInRealParentTurn: true,
            continuableChildHeldAtSyntheticTransport: true,
            identicalTargetAndText: spec.count === 2,
            deliveries: records.map((row) => ({ seq: row.seq, data: structuredClone(row.data) })),
            outerResultIsError: result.data.message.isError,
            successfulLeafRetainedDespiteOuterError: spec.outerError,
            latestMapping: structuredClone(plan.mapping),
            cutBeforeSecondParentTurn: true,
            newSessionId: fork.id,
            exactForkPrefix: true,
            parentArchived: true,
            oldAndNewQueuesCancelled: true,
            restoredDraftUnsent: true,
            result: "passed",
          });
          await receipt.dispose();
          receipts.delete(receipt);
        });
      }
      assert.equal(scenarios.length, 2);
      assert.equal(deliveries.length, 3);
      assert.deepEqual(f.errors, []);
      for (const request of f.requests)
        assert.deepEqual(
          request.tools.map((tool) => tool.name),
          ["run_code"],
        );
    } finally {
      observe();
      desktop.close();
      try {
        for (const receipt of receipts) await receipt.dispose();
      } finally {
        await f.dispose();
      }
    }
    const fixtureEvidence = f.evidence();
    const backend = fixtureEvidence.isolation.ptcBackend;
    // The guard also publishes hashes for its available read/review examples;
    // neither example was executed by this probe.
    delete backend.programSha256;
    delete backend.availableReviewProgramSha256;
    delete backend.reviewPlanSha256;
    backend.actualPrograms = actualPrograms;
    assert.equal(backend.launches.length, 2);
    assert.equal(backend.cleanup.verified, true);
    assert.equal(fixtureEvidence.isolation.rootsRemoved, true);
    assert.deepEqual(fixtureEvidence.isolation.cleanupErrors, []);
    for (const row of sourceDigests)
      assert.equal(hash(readFileSync(join(presetProjectRoot, row.path))), row.sha256);
    completedEvidence =
      JSON.stringify(
        {
          schemaVersion: 1,
          behaviorId: "SESSION-REWIND",
          generatedAt: new Date().toISOString(),
          node: process.version,
          platform: { os: process.platform, arch: process.arch },
          initialEnvironmentNames,
          ...fixtureEvidence,
          scenarios,
          readbacks,
          workspaceStore: {
            syntheticUnboundLookupOnly: true,
            lookups: workspaceLookups.length,
            bindingPersistenceAssessed: false,
          },
          calls: {
            syntheticModelRequests: f.requests.length,
            agentLoopRunCode: 2,
            officialPtcSendMessage: deliveries.length,
            directToolRuntimeCalls: 0,
            actualOfficialBackendProcesses: backend.launches.length,
          },
          sourceDigests,
          boundaries: {
            completePtcPresetMounted: true,
            actualOfficialLoaderAndRegistry: true,
            actualAgentLoopAndSubagentApi: true,
            actualOfficialPtcBackend: true,
            actualJsonlAndPhysicalReadback: true,
            syntheticModelTransportsOnly: true,
            childHeldOnlyAtSyntheticTransport: true,
            noFabricatedCallResultDispatchOrCatalog: true,
            realDesktopExecuted: false,
            realModelExecuted: false,
            realProfileLoaded: false,
            originalSeatbeltProfileUnmodified: true,
            kernelNetworkWhitelist: false,
          },
          testResult: { tests: 3, passed: 3, failed: 0, skipped: 0 },
          result: "passed",
        },
        null,
        2,
      )
        .replaceAll(f.directory, "<synthetic-root>")
        .replaceAll(f.runtime.root, "<clean-runtime>")
        .replaceAll(presetProjectRoot.replace(/\/$/, ""), "<project>") + "\n";
    assert.ok(!completedEvidence.includes("/Users/"));
  },
);
