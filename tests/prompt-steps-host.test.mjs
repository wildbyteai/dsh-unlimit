import test from "node:test";
import assert from "node:assert/strict";
import { rewindProtocolFixture, targets } from "./helpers/rewind-protocol-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const options = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME; only synthetic sessions and transport are used",
  timeout: 20000,
};
const textOf = (messages) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("\n");
const systemWire = (body) =>
  JSON.stringify([
    body.system,
    body.instructions,
    ...(body.messages ?? body.input ?? []).filter((m) => ["system", "developer"].includes(m.role)),
  ]);
const count = (text, marker) => text.split(marker).length - 1;

for (const target of targets)
  for (const mode of ["replace", "append"]) {
    test(
      `official ${target.api} ${mode}: current prompt replaces earlier text across tools and retry`,
      options,
      async (t) => {
        const f = await rewindProtocolFixture(t, runtimeRoot, target, { retry: true });
        const agent = await f.create();
        const markers = ["A", "B", "C", "D"].map((id) => `SYNTHETIC_STEP_PROMPT_${id}`);
        f.settings.promptMode = mode;
        const persona = "SYNTHETIC_HOST_PERSONA";
        agent.ctx.systemPrompt.section({
          name: "deployment:persona-prefix",
          order: -1,
          text: persona,
          interpolate: false,
        });
        const functional = "SYNTHETIC_PRESERVED_FUNCTION_GUIDANCE";
        const human = "SYNTHETIC_UNCHANGED_HUMAN_REQUEST";
        const toolResults = ["SYNTHETIC_TOOL_RESULT_ONE", "SYNTHETIC_TOOL_RESULT_TWO"];
        const calls = [];
        const toolCall = (stage) => ({
          id: `synthetic-call-${stage}`,
          name: "fixture_step",
          arguments: { stage },
        });
        f.ctx.systemPrompt.section({
          name: "fixture:function",
          order: 100,
          text: functional,
          interpolate: false,
        });
        f.ctx.tools.register(
          f.api.tools.defineTool({
            name: "fixture_step",
            description:
              "Return a fixed synthetic result; the test changes its own prompt between steps.",
            parameters: { stage: { type: "string", required: true } },
            output: {
              schema: { type: "json" },
              render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
            },
            execute({ stage }) {
              calls.push(stage);
              if (stage === "first") {
                f.settings.prompt = markers[1];
                f.failTransientNext(() => {
                  f.settings.prompt = markers[2];
                  f.replyWithTool(toolCall("second"));
                });
                return { marker: toolResults[0] };
              }
              assert.equal(stage, "second");
              f.settings.prompt = markers[3];
              return { marker: toolResults[1] };
            },
          }),
        );
        f.settings.prompt = markers[0];
        f.replyWithTool(toolCall("first"));
        assert.equal((await f.follow(agent, human)).kind, "completed");
        assert.deepEqual(
          calls,
          ["first", "second"],
          "Each actual ToolRuntime call runs exactly once",
        );
        assert.equal(f.captures.length, 4);
        assert.equal(f.snapshots.length, 4, "SDK retries must not bypass the official AgentLoop");
        assert.deepEqual(
          f.snapshots.map((s) => s.step),
          [1, 2, 2, 3],
        );
        assert.equal(new Set(f.snapshots.map((s) => s.turn)).size, 1);
        const events = (await f.durable(agent)).events;
        assert.equal(events.filter((e) => e.type === "turn/start").length, 1);
        assert.equal(events.filter((e) => e.type === "llm/retry").length, 1);
        assert.equal(events.filter((e) => e.type === "llm/retry-started").length, 1);
        assert.deepEqual(
          events.filter((e) => e.type === "tool/result").map((e) => e.data.message.isError),
          [false, false],
        );
        // Superseded prompt events remain in the immutable journal, but not in the
        // active projection sent to the model. Never erase audit to satisfy this.
        const journal = JSON.stringify(events.filter((e) => e.type === "system/message"));
        for (const marker of markers) assert.ok(journal.includes(marker));
        t.diagnostic(
          JSON.stringify({
            projectedPromptVersions: f.snapshots.map((s) =>
              markers.filter((marker) =>
                textOf(s.messages.filter((m) => m.role === "system")).includes(marker),
              ),
            ),
            wirePromptVersions: f.captures.map(({ body }) =>
              markers.filter((marker) => systemWire(body).includes(marker)),
            ),
          }),
        );
        for (const [index, snapshot] of f.snapshots.entries()) {
          const body = f.captures[index].body;
          const native = systemWire(body);
          const projected = textOf(snapshot.messages.filter((m) => m.role === "system"));
          for (const [markerIndex, marker] of markers.entries()) {
            const expected = markerIndex === index ? 1 : 0;
            assert.equal(
              count(native, marker),
              expected,
              `Request ${index + 1} native system must contain only its current prompt: ${marker}`,
            );
            assert.equal(
              count(projected, marker),
              expected,
              `Request ${index + 1} durable projection must agree: ${marker}`,
            );
          }
          assert.equal(native.includes(persona), mode === "append");
          assert.ok(native.includes(functional), "Unrelated functional guidance remains");
          const humanText = textOf(snapshot.messages.filter((m) => m.source.kind === "user"));
          assert.equal(humanText, human);
          const wireHuman = JSON.stringify(
            (body.messages ?? body.input ?? []).filter((m) => m.role === "user"),
          );
          for (const marker of markers) assert.equal(wireHuman.includes(marker), false);
          assert.ok(
            JSON.stringify(body.tools).includes("fixture_step"),
            "Tool schema remains usable",
          );
          const priorResults =
            index === 0 ? [] : index === 3 ? toolResults : toolResults.slice(0, 1);
          for (const marker of priorResults) assert.ok(JSON.stringify(body).includes(marker));
        }
        f.runtime.revert();
        assert.equal((await f.follow(agent, "SYNTHETIC_HUMAN_AFTER_REVERT")).kind, "completed");
        for (const marker of markers)
          assert.equal(systemWire(f.captures.at(-1).body).includes(marker), false);
        assert.ok(systemWire(f.captures.at(-1).body).includes(functional));
        assert.ok(systemWire(f.captures.at(-1).body).includes(persona));
        await f.durable(agent);
      },
    );
  }

test(
  "revert waits for an accepted host step, changes no idle log, and releases restoration listeners",
  options,
  async (t) => {
    const f = await rewindProtocolFixture(t, runtimeRoot, targets[0]);
    const agent = await f.create();
    const marker = "SYNTHETIC_REVOKED_PROMPT";
    f.ctx.systemPrompt.section({
      name: "fixture:baseline",
      order: 100,
      text: "SYNTHETIC_HOST_BASELINE",
      interpolate: false,
    });
    f.settings.prompt = marker;
    const original = agent.systemPrompt.project;
    const descriptor = Object.getOwnPropertyDescriptor(agent.systemPrompt, "project");
    await f.follow(agent, "SYNTHETIC_FIRST_INPUT");
    const before = agent.session.snapshotEvents();
    const registrations = [];
    const on = agent.ctx.on;
    const onDescriptor = Object.getOwnPropertyDescriptor(agent.ctx, "on");
    Object.defineProperty(agent.ctx, "on", {
      configurable: true,
      value: function (name, callback, ...args) {
        const dispose = on.call(this, name, callback, ...args);
        const row = { name, disposed: false };
        registrations.push(row);
        return () => {
          row.disposed = true;
          return dispose();
        };
      },
    });
    try {
      f.runtime.revert();
    } finally {
      if (onDescriptor) Object.defineProperty(agent.ctx, "on", onDescriptor);
      else delete agent.ctx.on;
    }
    assert.equal(agent.systemPrompt.project, original);
    assert.deepEqual(Object.getOwnPropertyDescriptor(agent.systemPrompt, "project"), descriptor);
    assert.deepEqual(
      agent.session.snapshotEvents(),
      before,
      "No synthetic turn or late system event is created by revert",
    );
    await f.durable(agent);
    assert.equal(registrations.length, 2);
    const reject = f.ctx.on("agent/pre-step", () => ({
      kind: "reject",
      reason: "SYNTHETIC_POLICY_REJECTION",
    }));
    assert.equal((await f.follow(agent, "SYNTHETIC_REJECTED_INPUT")).kind, "blocked");
    assert.equal(f.captures.length, 1, "Native policy rejection is preserved");
    assert.ok(registrations.every((row) => !row.disposed));
    reject();
    const cancel = f.ctx.on("agent/pre-step", async (_event, next) => {
      const decision = await next();
      agent.cancel({ kind: "user" });
      return decision;
    });
    assert.equal((await f.follow(agent, "SYNTHETIC_CANCELLED_INPUT")).kind, "aborted");
    assert.equal(f.captures.length, 1);
    assert.ok(registrations.every((row) => !row.disposed));
    cancel();
    assert.equal((await f.follow(agent, "SYNTHETIC_ACCEPTED_INPUT")).kind, "completed");
    assert.equal(systemWire(f.captures.at(-1).body).includes(marker), false);
    assert.ok(systemWire(f.captures.at(-1).body).includes("SYNTHETIC_HOST_BASELINE"));
    assert.ok(
      registrations.every((row) => row.disposed),
      "One-use restoration must release both listeners after native commit",
    );
    await f.durable(agent);
  },
);
