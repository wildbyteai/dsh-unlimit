import test from "node:test";
import assert from "node:assert/strict";
import { nativeInstructionsFixture } from "./helpers/native-instructions-fixture.mjs";
import { NativeInstructions } from "../src/host/native-instructions.js";
import { DesktopRuntime } from "../src/host/runtime.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const officialPackages = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const officialOnly = {
  skip:
    runtimeRoot && officialPackages
      ? false
      : "Set DSH_UNLIMIT_RUNTIME and DSH_UNLIMIT_OFFICIAL_PACKAGES for clean-producer native-instructions acceptance; no profile or desktop is loaded",
  timeout: 20000,
};
const native = (event) =>
  event.type === "user/message" &&
  event.data.source?.kind === "agent-instructions" &&
  event.data.source.form === "instructions";
const nativeMessage = (message) =>
  message.role === "user" &&
  message.source?.kind === "agent-instructions" &&
  message.source.form === "instructions";
const texts = (messages) =>
  messages
    .flatMap((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
    )
    .join("\n");
const markers = (session) =>
  session.surface.nodes
    .map((seq) => session.eventAt(seq))
    .filter(
      (event) =>
        event.type === "developer/message" &&
        event.data.message.source?.kind === "dsh-unlimit/native-instructions",
    );

test(
  "official clean producer and per-session policy preserve auditable native-instructions control",
  officialOnly,
  async (t) => {
    const fixture = await nativeInstructionsFixture(t, runtimeRoot, officialPackages);
    const agent = await fixture.create();
    await t.test("real producer baseline and successful read refresh", async () => {
      assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_FIRST_HUMAN"), { kind: "completed" });
      assert.equal(
        fixture.requests.length,
        1,
        "Baseline preparation must not create an extra model step",
      );
      const baseline = agent.session.snapshotEvents().filter(native);
      assert.equal(baseline.length, 1);
      assert.equal(baseline[0].data.source.baseline, true);
      assert.ok(texts(fixture.requests[0].messages).includes("SYNTHETIC_PROJECT_RULE_V1"));
      assert.ok(texts(fixture.requests[0].messages).includes("SYNTHETIC_HARNESS_GLOBAL_RULE"));
      assert.ok(texts(fixture.requests[0].messages).includes("SYNTHETIC_SHARED_GLOBAL_RULE"));

      fixture.readNext(agent, () =>
        fixture.writeProjectRule("SYNTHETIC_PROJECT_RULE_V2_CHANGED\n"),
      );
      assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_REFRESH_HUMAN"), {
        kind: "completed",
      });
      assert.equal(
        fixture.requests.length,
        3,
        "One tool round and one completion must be the complete refresh turn",
      );
      const events = agent.session.snapshotEvents();
      const refreshes = events.filter(native).filter((event) => !event.data.source.baseline);
      assert.equal(refreshes.length, 1);
      assert.ok(texts([refreshes[0].data]).includes("SYNTHETIC_PROJECT_RULE_V2_CHANGED"));
      assert.ok(texts(fixture.requests[2].messages).includes("SYNTHETIC_PROJECT_RULE_V2_CHANGED"));
    });

    const settings = { enabled: true, workspacePolicy: "always", prompt: "" };
    let library = { items: [], activeId: null };
    const adapter = new NativeInstructions({
      ctx: fixture.ctx,
      host: fixture.host,
      settings: () => settings,
      store: {
        dispatch(action) {
          assert.equal(action, "rules.list");
          return library;
        },
      },
    });
    assert.equal(adapter.capabilities()[0].state, "available");
    adapter.apply();
    fixture.onCleanup(() => adapter.revert());
    assert.equal(adapter.capabilities()[0].state, "active");

    await t.test(
      "strict removes admitted and new native messages while preserving precise other sources",
      async () => {
        const originals = structuredClone(agent.session.snapshotEvents());
        const copies = [
          fixture.message("SYNTHETIC_NATIVE_WORDS_COPIED_BY_HUMAN"),
          fixture.message("SYNTHETIC_OTHER_PLUGIN", { kind: "synthetic-other-plugin" }),
          fixture.message("SYNTHETIC_OTHER_FORM", {
            kind: "agent-instructions",
            form: "synthetic-other-form",
          }),
        ];
        for (const message of copies)
          agent.session.append("user/message", message, { surfaceOp: "append" });
        settings.workspacePolicy = "strict";
        const before = fixture.requests.length;
        assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_STRICT_HUMAN"), {
          kind: "completed",
        });
        assert.equal(fixture.requests.length, before + 1);
        assert.deepEqual(
          agent.session.snapshotEvents().slice(0, originals.length),
          originals,
          "Hiding history must preserve every original raw event",
        );
        const request = fixture.requests.at(-1);
        assert.ok(!request.messages.some(nativeMessage));
        for (const message of copies)
          assert.ok(request.messages.some((item) => item.id === message.id));
        assert.equal(markers(agent.session).length, originals.filter(native).length);
        for (const event of markers(agent.session)) {
          assert.equal(event.data.message.content.length, 0);
          assert.equal(event.data.message.source.format, 1);
          assert.deepEqual(event.sourceEventSeqs, [event.data.message.source.originalSeq]);
        }
        const admittedNativeCount = agent.session.snapshotEvents().filter(native).length;
        const reads = fixture.fileReads.length;
        assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_REPEATED_STRICT_HUMAN"), {
          kind: "completed",
        });
        assert.equal(
          fixture.requests.length,
          before + 2,
          "Producer re-discovery cannot add a model loop",
        );
        assert.equal(
          agent.session.snapshotEvents().filter(native).length,
          admittedNativeCount,
          "Regenerated baselines must be filtered before durable admission",
        );
        assert.ok(
          fixture.fileReads.length > reads,
          "Strict controls admission while the official producer still discovers files",
        );
        fixture.readNext(agent, () =>
          fixture.writeProjectRule("SYNTHETIC_PROJECT_RULE_V3_STRICT_REFRESH\n"),
        );
        const refreshStart = fixture.requests.length;
        assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_STRICT_TOOL_REFRESH_HUMAN"), {
          kind: "completed",
        });
        assert.equal(
          fixture.requests.length,
          refreshStart + 2,
          "A filtered tool refresh cannot create an additional model loop",
        );
        assert.ok(
          fixture.requests.slice(refreshStart).every((item) => !item.messages.some(nativeMessage)),
        );
        assert.equal(agent.session.snapshotEvents().filter(native).length, admittedNativeCount);
      },
    );

    await t.test(
      "always and empty fallback restore original data before producer baseline checks",
      async () => {
        const hidden = markers(agent.session);
        assert.ok(hidden.length > 0);
        settings.workspacePolicy = "always";
        const before = fixture.requests.length;
        assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_ALWAYS_RESTORE_HUMAN"), {
          kind: "completed",
        });
        assert.equal(fixture.requests.length, before + 1);
        assert.equal(markers(agent.session).length, 0);
        const events = agent.session.snapshotEvents();
        for (const marker of hidden) {
          const original = agent.session.eventAt(marker.data.message.source.originalSeq);
          const restored = events.find(
            (event) => native(event) && event.surfaceOp?.startSeq === marker.seq,
          );
          assert.ok(restored);
          assert.deepEqual(restored.data, original.data);
          assert.deepEqual(restored.sourceEventSeqs, [marker.seq, original.seq]);
        }
        assert.ok(fixture.requests.at(-1).messages.some(nativeMessage));

        settings.workspacePolicy = "fallback";
        settings.prompt = "SYNTHETIC_SAVED_OPERATOR_PROMPT";
        await fixture.follow(agent, "SYNTHETIC_NONEMPTY_SAVED_PROMPT_HUMAN");
        assert.ok(!fixture.requests.at(-1).messages.some(nativeMessage));
        settings.prompt = " \n\t";
        library = { items: [{ id: "blank-active", content: " \n" }], activeId: "blank-active" };
        await fixture.follow(agent, "SYNTHETIC_EMPTY_FALLBACK_HUMAN");
        assert.ok(fixture.requests.at(-1).messages.some(nativeMessage));
        assert.equal(markers(agent.session).length, 0);

        settings.workspacePolicy = "strict";
        await fixture.follow(agent, "SYNTHETIC_ENABLE_SUPPRESS_HUMAN");
        assert.ok(markers(agent.session).length > 0);
        settings.enabled = false;
        await fixture.follow(agent, "SYNTHETIC_DISABLE_RESTORE_HUMAN");
        assert.ok(fixture.requests.at(-1).messages.some(nativeMessage));
        assert.equal(markers(agent.session).length, 0);
        settings.enabled = true;
      },
    );

    await t.test(
      "two concurrent sessions retain distinct effective model fallback policies",
      async () => {
        settings.workspacePolicy = "always";
        settings.prompt = "";
        const controlled = await fixture.create(
          "synthetic-controlled",
          "synthetic-controlled-model",
        );
        const preserved = await fixture.create("synthetic-preserved", "synthetic-preserved-model");
        await Promise.all([
          fixture.follow(controlled, "SYNTHETIC_CONTROLLED_BASELINE"),
          fixture.follow(preserved, "SYNTHETIC_PRESERVED_BASELINE"),
        ]);
        settings.workspacePolicy = "fallback";
        library = {
          items: [
            {
              id: "controlled-rule",
              model: "synthetic-controlled-model",
              content: "SYNTHETIC_MODEL_RULE",
            },
          ],
          activeId: null,
        };
        const before = fixture.requests.length;
        await Promise.all([
          fixture.follow(controlled, "SYNTHETIC_CONTROLLED_FALLBACK"),
          fixture.follow(preserved, "SYNTHETIC_PRESERVED_FALLBACK"),
        ]);
        const pair = fixture.requests.slice(before);
        assert.equal(pair.length, 2);
        assert.ok(
          !pair.find((item) => item.sessionId === controlled.id).messages.some(nativeMessage),
        );
        assert.ok(
          pair.find((item) => item.sessionId === preserved.id).messages.some(nativeMessage),
        );
        assert.ok(markers(controlled.session).length > 0);
        assert.equal(markers(preserved.session).length, 0);
        // A model-specific blank rule is the chosen rule even when a different
        // active rule has content. The policy shares the prompt selector contract.
        library = {
          items: [
            { id: "controlled-blank", model: "synthetic-controlled-model", content: " \n" },
            { id: "active-nonempty", content: "SYNTHETIC_ACTIVE_RULE" },
          ],
          activeId: "active-nonempty",
        };
        await Promise.all([
          fixture.follow(controlled, "SYNTHETIC_MODEL_BLANK"),
          fixture.follow(preserved, "SYNTHETIC_ACTIVE_NONEMPTY"),
        ]);
        const reversed = fixture.requests.slice(-2);
        assert.ok(
          reversed.find((item) => item.sessionId === controlled.id).messages.some(nativeMessage),
        );
        assert.ok(
          !reversed.find((item) => item.sessionId === preserved.id).messages.some(nativeMessage),
        );
      },
    );

    await t.test(
      "downstream rejection retains object identity and cancellation reaches the official loop",
      async () => {
        settings.workspacePolicy = "strict";
        const rejected = { kind: "reject", reason: "SYNTHETIC_NATIVE_POLICY_REJECTION" };
        const reject = fixture.ctx.on("agent/pre-step", () => rejected);
        let observed;
        const observe = fixture.ctx.on(
          "agent/pre-step",
          async (_payload, next) => (observed = await next()),
          { prepend: true },
        );
        const before = fixture.requests.length;
        assert.deepEqual(await fixture.follow(agent, "SYNTHETIC_REJECTED_HUMAN"), {
          kind: "blocked",
        });
        assert.equal(observed, rejected);
        assert.equal(fixture.requests.length, before);
        observe();
        reject();

        const began = fixture.blockNext(agent);
        agent.followup(fixture.message("SYNTHETIC_CANCELED_HUMAN"));
        await began;
        agent.cancel({ kind: "user" });
        await agent.whenIdle();
        const end = agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
        assert.equal(end.data.reason.kind, "aborted");
        assert.equal(fixture.requests.length, before + 1);
      },
    );

    await t.test(
      "unload while a request is preparing restores history and prevents late policy writes",
      async () => {
        settings.workspacePolicy = "strict";
        const started = Promise.withResolvers();
        const release = Promise.withResolvers();
        const stop = fixture.ctx.on("agent/request", async (_payload, next) => {
          const request = await next();
          started.resolve();
          await release.promise;
          return request;
        });
        const before = fixture.requests.length;
        agent.followup(fixture.message("SYNTHETIC_INFLIGHT_UNLOAD_HUMAN"));
        await started.promise;
        assert.equal(fixture.requests.length, before);
        adapter.revert();
        assert.equal(markers(agent.session).length, 0);
        release.resolve();
        await agent.whenIdle();
        stop();
        assert.equal(fixture.requests.length, before + 1);
        assert.ok(fixture.requests.at(-1).messages.some(nativeMessage));
        assert.equal(
          markers(agent.session).length,
          0,
          "A request listener already awaiting downstream cannot hide history after unload",
        );
        adapter.apply();
        assert.equal(adapter.capabilities()[0].state, "active");
      },
    );

    await t.test(
      "agent disposal restores owned placeholders before the physical JSONL handle closes",
      async () => {
        settings.workspacePolicy = "always";
        const disposable = await fixture.create("synthetic-disposed");
        await fixture.follow(disposable, "SYNTHETIC_DISPOSE_BASELINE");
        settings.workspacePolicy = "strict";
        await fixture.follow(disposable, "SYNTHETIC_DISPOSE_SUPPRESS");
        assert.ok(markers(disposable.session).length > 0);
        await fixture.dispose(disposable);
        assert.equal(fixture.ctx.agents.get(disposable.id), undefined);
        assert.equal(markers(disposable.session).length, 0);
        const log = await fixture.durable(disposable);
        const rebuilt = fixture.api.sessions.Session.create(
          disposable.id,
          log.events,
          disposable.session.header,
        );
        assert.ok(rebuilt.deriveMessages().some(nativeMessage));
        assert.ok(
          log.events.some(
            (event) =>
              event.type === "developer/message" &&
              event.data.message.source?.kind === "dsh-unlimit/native-instructions",
          ),
        );
      },
    );

    await t.test(
      "revert respects a later replacement and restores only currently visible owned placeholders",
      async () => {
        settings.workspacePolicy = "always";
        const changed = await fixture.create("synthetic-later-owner");
        await fixture.follow(changed, "SYNTHETIC_LATER_OWNER_BASELINE");
        settings.workspacePolicy = "strict";
        await fixture.follow(changed, "SYNTHETIC_LATER_OWNER_HIDE");
        const [marker] = markers(changed.session);
        assert.ok(marker);
        const later = changed.session.append(
          "user/message",
          fixture.message("SYNTHETIC_LATER_REPLACEMENT", { kind: "synthetic-later-owner" }),
          {
            surfaceOp: { op: "replace", startSeq: marker.seq, endSeq: marker.seq },
            sourceEventSeqs: [marker.seq],
          },
        );
        const before = fixture.requests.length;
        adapter.revert();
        assert.equal(adapter.capabilities()[0].state, "available");
        assert.ok(changed.session.surface.nodes.includes(later.seq));
        assert.ok(
          !changed.session.deriveMessages().some(nativeMessage),
          "Revert cannot revive history hidden by a subsequent owner",
        );
        for (const session of fixture.ctx.sessions.list()) assert.equal(markers(session).length, 0);
        await fixture.follow(agent, "SYNTHETIC_UNLOADED_HUMAN");
        assert.equal(fixture.requests.length, before + 1);
        assert.ok(
          fixture.requests.at(-1).messages.some(nativeMessage),
          "The real producer continues after unload without a plugin projection dependency",
        );
      },
    );
    await t.test("public DesktopRuntime apply and revert activate the native policy", async () => {
      Object.assign(settings, {
        enabled: true,
        workspacePolicy: "strict",
        prompt: "SYNTHETIC_DESKTOP_RUNTIME_OPERATOR",
        promptMode: "replace",
        workspaceFiles: [],
        autoApprove: false,
        fullAccess: false,
        permissionDefault: "",
        maxDepth: 3,
        maxSubagents: 3,
      });
      library = { items: [], activeId: null };
      const runtime = new DesktopRuntime(
        fixture.ctx,
        {
          dispatch(action) {
            if (action === "settings.get") return { value: settings };
            assert.equal(action, "rules.list");
            return library;
          },
        },
        fixture.host,
      );
      fixture.onCleanup(() => {
        runtime.revert();
        adapter.revert();
      });
      runtime.apply();
      assert.equal(
        runtime.capabilities().find((item) => item.id === "nativeInstructions").state,
        "active",
      );
      const before = fixture.requests.length;
      await fixture.follow(agent, "SYNTHETIC_PUBLIC_RUNTIME_STRICT");
      assert.equal(fixture.requests.length, before + 1);
      assert.ok(!fixture.requests.at(-1).messages.some(nativeMessage));
      assert.ok(
        texts(fixture.requests.at(-1).messages).includes("SYNTHETIC_DESKTOP_RUNTIME_OPERATOR"),
      );
      assert.ok(markers(agent.session).length > 0);
      runtime.revert();
      assert.equal(markers(agent.session).length, 0);
      assert.equal(
        runtime.capabilities().find((item) => item.id === "nativeInstructions").state,
        "available",
      );
      await fixture.follow(agent, "SYNTHETIC_PUBLIC_RUNTIME_REVERTED");
      assert.equal(fixture.requests.length, before + 2);
      assert.ok(fixture.requests.at(-1).messages.some(nativeMessage));
    });
    await t.test(
      "fresh unapplied adapter restores inherited markers in an unobserved loaded official fork",
      async () => {
        settings.workspacePolicy = "strict";
        adapter.apply();
        await fixture.follow(agent, "SYNTHETIC_FORK_SOURCE_SUPPRESS");
        const sourceEvents = structuredClone(agent.session.snapshotEvents());
        const inheritedMarkers = markers(agent.session);
        assert.ok(inheritedMarkers.length > 0);
        const fork = await fixture.fork(agent, "synthetic-unobserved-fork");
        assert.equal(fork.session.header.parentSession, agent.id);
        assert.equal(fork.session.header.isSeeded, true);
        assert.equal(fork.session.inheritedEventCount, sourceEvents.length);
        assert.deepEqual(fork.session.snapshotEvents().slice(0, sourceEvents.length), sourceEvents);
        assert.equal(markers(fork.session).length, inheritedMarkers.length);
        assert.ok(
          !fixture.requests.some((request) => request.sessionId === fork.id),
          "The fork must not enter a pre-step before restoration",
        );
        const before = structuredClone(fork.session.snapshotEvents());
        const fresh = new NativeInstructions({
          ctx: fixture.ctx,
          host: fixture.host,
          settings: () => settings,
          store: {
            dispatch(action) {
              assert.equal(action, "rules.list");
              return library;
            },
          },
        });
        assert.equal(fresh.capabilities()[0].state, "available");
        fresh.revert();
        assert.equal(
          fresh.capabilities()[0].state,
          "available",
          "Restoring loaded history does not activate the new adapter",
        );
        assert.equal(markers(fork.session).length, 0);
        assert.equal(markers(agent.session).length, 0);
        assert.deepEqual(
          fork.session.snapshotEvents().slice(0, before.length),
          before,
          "The inherited audit prefix remains unchanged",
        );
        const log = await fixture.durable(fork);
        const reconstructed = fixture.api.sessions.Session.create(
          fork.id,
          log.events,
          fork.session.header,
          fork.session.inheritedEventCount,
        );
        assert.ok(reconstructed.deriveMessages().some(nativeMessage));
        for (const marker of inheritedMarkers) {
          const original = agent.session.eventAt(marker.data.message.source.originalSeq);
          const restored = log.events.find(
            (event) => native(event) && event.surfaceOp?.startSeq === marker.seq,
          );
          assert.ok(restored);
          assert.deepEqual(restored.data, original.data);
          assert.deepEqual(restored.sourceEventSeqs, [marker.seq, original.seq]);
        }
        adapter.revert();
      },
    );
    const evidence = await fixture.verify();
    t.diagnostic(
      `Clean official ${evidence.version}: ${evidence.officialModules.length} inventory-verified modules; ${evidence.requests} JSONL-reconstructed requests; no profile/network/subprocess.`,
    );
  },
);
