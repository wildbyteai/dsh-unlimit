import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { rewindProtocolFixture, targets } from "./helpers/rewind-protocol-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const options = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated official rewind-to-wire tests; no user profile is loaded",
  timeout: 20000,
};
const textOf = (messages) =>
  messages
    .flatMap((message) =>
      message.content.filter((block) => block.type === "text").map((block) => block.text),
    )
    .join("\n");
function serializedText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object")
    return Object.values(value).map(serializedText).join("\n");
  return "";
}
function nativeSystemLocations(body, marker) {
  const places = [];
  if (JSON.stringify(body.system ?? "").includes(marker)) places.push("system");
  if (JSON.stringify(body.instructions ?? "").includes(marker)) places.push("instructions");
  for (const field of ["messages", "input"])
    for (const message of Array.isArray(body[field]) ? body[field] : [])
      if (
        ["system", "developer"].includes(message.role) &&
        JSON.stringify(message).includes(marker)
      )
        places.push(`${field}:${message.role}`);
  return places;
}

for (const target of targets) {
  test(
    `official ${target.api}: rewind second turn, edit, explicitly resend, persist, fail and cancel`,
    options,
    async (t) => {
      const f = await rewindProtocolFixture(t, runtimeRoot, target);
      const { ctx, desktop, settings, captures, snapshots } = f;
      const first = `EARLIER_HUMAN_${target.id}`;
      const withdrawnMarker = `WITHDRAWN_HUMAN_${target.id}`;
      const withdrawn = `${withdrawnMarker}\nOriginal draft line two.`;
      const edited = `EDITED_HUMAN_${target.id}\nOperator changed the recovered draft.`;
      const internal = `INTERNAL_EVENT_ONLY_${target.id}`;
      const currentPrompt = `CURRENT_SYSTEM_${target.id}`;
      const original = await f.create();
      settings.prompt = `FIRST_SYSTEM_${target.id}`;
      assert.equal((await f.follow(original, first)).kind, "completed");
      settings.prompt = `SECOND_SYSTEM_${target.id}`;
      assert.equal((await f.follow(original, withdrawn)).kind, "completed");
      // This original, test-authored journal event is deliberately not a message.
      // It must stay as evidence, never become model input through rewind.
      f.api.sessions.appendPluginRecord(original.session, "plugin:synthetic/internal", {
        marker: internal,
      });
      await f.durable(original);
      const originalBefore = await ctx.sessionController.inspect(original.id);
      const requestCount = captures.length;
      assert.equal(
        requestCount,
        2,
        "Both human turns must have used the official AgentLoop and adapter",
      );
      const plan = await desktop.prepare({ sessionId: original.id });
      assert.equal(captures.length, requestCount, "Preparing a rewind must not send anything");
      const result = await desktop.rewind({ sessionId: original.id, draftBridgeReady: true });
      await setImmediate();
      assert.equal(
        captures.length,
        requestCount,
        "A rewind must leave the draft pending until explicit followup",
      );
      assert.equal(result.strategy, "fork");
      assert.equal(result.draft, withdrawn);
      assert.equal(result.draftStatus, "pending-client");
      assert.equal(result.archived, true);
      assert.deepEqual(result.stop.pendingIds, []);
      assert.notEqual(result.newSessionId, original.id);
      const child = ctx.agents.get(result.newSessionId);
      assert.ok(child);
      const childBefore = await ctx.sessionController.inspect(child.id);
      assert.equal(childBefore.meta.parentSession, original.id);
      assert.equal(childBefore.inheritedEventCount, plan.atSeq + 1);
      assert.deepEqual(
        childBefore.events.slice(0, plan.atSeq + 1),
        originalBefore.events.slice(0, plan.atSeq + 1),
      );
      assert.ok(childBefore.events.some((event) => event.type === "session/end-seed"));
      assert.equal(textOf(child.session.deriveMessages()).includes(withdrawnMarker), false);
      assert.equal(child.status, "idle");
      assert.equal(
        child.inbox.nextTurn.length + child.inbox.nextStep.length,
        0,
        JSON.stringify({ nextTurn: child.inbox.nextTurn, nextStep: child.inbox.nextStep }),
      );
      assert.deepEqual(
        (await ctx.sessionController.inspect(original.id)).events,
        originalBefore.events,
      );
      assert.equal(
        f.store.dispatch("workspaces.forSession", { sessionId: child.id }).item.id,
        f.workspaceId,
      );
      await f.durable(child);
      const durableWorkspace = JSON.parse(
        readFileSync(join(f.directory, "domains", "workspace.json"), "utf8"),
      );
      assert.ok(durableWorkspace.global.archivedSessionIds.includes(original.id));
      const visible = await desktop.list();
      assert.equal(
        visible.some((item) => item.id === original.id),
        false,
      );
      assert.ok(visible.some((item) => item.id === child.id));

      // Model sending is authorized only by this explicit human followup. The
      // recovered draft itself is neither queued nor automatically replayed.
      settings.prompt = currentPrompt;
      assert.equal((await f.follow(child, edited)).kind, "completed");
      assert.equal(captures.length, requestCount + 1);
      const sent = captures.at(-1);
      const snapshot = snapshots.at(-1);
      assert.equal(snapshot.sessionId, child.id);
      const requestText = serializedText(sent.body);
      for (const marker of [first, edited])
        assert.ok(requestText.includes(marker), `Wire request must include ${marker}`);
      for (const marker of [
        withdrawnMarker,
        internal,
        "session/end-seed",
        "synthetic/internal",
        "turn/start",
      ])
        assert.equal(
          requestText.includes(marker),
          false,
          `Internal or withdrawn material must not reach the model: ${marker}`,
        );
      const systemLocations = nativeSystemLocations(sent.body, currentPrompt);
      assert.ok(
        systemLocations.length > 0,
        "Current prompt must reach a native protocol system field",
      );
      assert.equal(
        (sent.body.messages ?? sent.body.input ?? []).some(
          (message) => message.role === "user" && JSON.stringify(message).includes(currentPrompt),
        ),
        false,
      );
      const projectedText = textOf(snapshot.messages);
      assert.ok(projectedText.includes(first));
      assert.ok(projectedText.includes(edited));
      assert.ok(projectedText.includes(currentPrompt));
      assert.equal(projectedText.includes(withdrawnMarker), false);
      assert.ok(
        snapshot.events.some(
          (event) =>
            event.type === "system/message" && JSON.stringify(event.data).includes(currentPrompt),
        ),
        "Request-time prompt must already be journaled in the official Session",
      );
      const successLog = await f.durable(child);
      assert.ok(serializedText(successLog.events).includes(edited));
      assert.equal(
        serializedText(successLog.events.filter((event) => event.type === "user/message")).includes(
          withdrawn,
        ),
        false,
        "Withdrawn inbox journal history may be inherited, but it must never become a human message on the new branch",
      );
      assert.equal(serializedText(successLog.events).includes(internal), false);
      await f.durable(original);
      assert.deepEqual(
        (await ctx.sessionController.inspect(original.id)).events,
        originalBefore.events,
        "Sending on the branch must preserve the archived source history",
      );

      const successfulReplies = child.session
        .snapshotEvents()
        .filter((event) => event.type === "assistant/message").length;
      assert.equal(
        successfulReplies,
        2,
        "The fork must retain the earlier reply and the explicitly requested new reply",
      );
      f.failNext();
      const failureStart = captures.length;
      const failure = await f.follow(child, `SYNTHETIC_REJECTED_INPUT_${target.id}`);
      assert.equal(
        failure.kind,
        "error",
        "A permanent provider rejection must not be recorded as completed",
      );
      assert.equal(captures.length, failureStart + 1);
      assert.equal(
        child.session.snapshotEvents().filter((event) => event.type === "assistant/message").length,
        successfulReplies,
      );
      const failureLog = await f.durable(child);
      assert.equal(
        failureLog.events.findLast((event) => event.type === "turn/end").data.reason.kind,
        "error",
      );

      f.cancelNext(child);
      const cancelStart = captures.length;
      const cancelled = await f.follow(child, `SYNTHETIC_CANCELLED_INPUT_${target.id}`);
      assert.equal(
        cancelled.kind,
        "aborted",
        "A cancelled transport must not be recorded as completed",
      );
      assert.equal(cancelled.reason.kind, "user");
      assert.equal(captures.length, cancelStart + 1);
      assert.equal(
        child.session.snapshotEvents().filter((event) => event.type === "assistant/message").length,
        successfulReplies,
      );
      const cancelLog = await f.durable(child);
      assert.equal(
        cancelLog.events.findLast((event) => event.type === "turn/end").data.reason.kind,
        "aborted",
      );
      assert.equal(child.status, "idle");
      assert.equal(
        captures.length,
        snapshots.length,
        "Every synthetic fetch request must have a matching official Session projection assertion",
      );
      t.diagnostic(
        JSON.stringify({
          provider: target.id,
          protocol: target.api,
          hostVersion: "0.2.1-rc.2",
          status: "verified",
          stages: [
            "two-real-loop-turns",
            "official-fork",
            "no-automatic-send",
            "edited-explicit-followup",
            "durable-readback",
            "permanent-error",
            "user-cancel",
          ],
          syntheticFetchRequests: captures.length,
          realNetworkRequests: 0,
          realProfileLoaded: false,
          requestsMatchingDurableSessionProjection: snapshots.length,
          resend: {
            endpoint: sent.path,
            currentSystemLocations: systemLocations,
            earlierInputPresent: true,
            editedInputPresent: true,
            withdrawnInputAbsent: true,
            internalMarkersAbsent: true,
          },
          moduleIntegrity: {
            scope: "imported entry files and lazy serializers; not exhaustive transitive audit",
            count: f.modules.length,
            modules: f.modules,
          },
          limitations:
            "Official adapters and SSE parsers with synthetic fetch responses and credentials; no real provider, desktop UI, profile, tool calls, subprocesses or live model quality are tested.",
        }),
      );
    },
  );
}
