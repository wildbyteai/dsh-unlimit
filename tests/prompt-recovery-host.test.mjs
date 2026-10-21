import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rewindProtocolFixture, targets } from "./helpers/rewind-protocol-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const options = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME; only synthetic sessions and transport are used",
  timeout: 20000,
};
const systemWire = (body) =>
  JSON.stringify([
    body.system,
    body.instructions,
    ...(body.messages ?? body.input ?? []).filter((m) => ["system", "developer"].includes(m.role)),
  ]);
const owner = { version: 1, owner: "managed-prompt" };

test(
  "official maintenance cannot durably restore an idle system prompt without a real step",
  options,
  async (t) => {
    const target = targets[0];
    const f = await rewindProtocolFixture(t, runtimeRoot, target, { unloadableRuntime: true });
    f.settings.prompt = "SYNTHETIC_IDLE_MANAGED_PROMPT";
    const handle = await f.ctx.agents.create({
      sessionId: "synthetic-idle-prompt-maintenance",
      meta: { cwd: join(f.directory, "project") },
      agentOptions: { provider: target.id, model: target.model },
    });
    try {
      assert.equal((await f.follow(handle.agent, "SYNTHETIC_INPUT")).kind, "completed");
      const before = await f.durable(handle.agent);
      const position = before.events.findLast((event) => event.type === "step/end").data;
      await f.unloadRuntime();
      // Deliberately exercise a rejected candidate only in this disposable log.
      // A successful in-memory append is not proof of a valid durable repair.
      await assert.rejects(
        handle.agent.runMaintenance(async () => {
          const commits = handle.agent.systemPrompt.project("SYNTHETIC_HOST_RESTORED", {
            inHistory: false,
            startsSeries: true,
          });
          assert.ok(commits.length > 0);
          for (const { message, intent } of commits)
            handle.agent.session.append("system/message", { ...position, message }, intent);
          await f.durable(handle.agent);
        }),
        (error) => {
          assert.equal(error.cause?.message, "system/message does not match an open turn and step");
          return true;
        },
      );
      assert.deepEqual(
        handle.agent.session.snapshotEvents().slice(0, before.events.length),
        before.events,
      );
      assert.equal(f.captures.length, 1, "Maintenance must not issue a cleanup model request");
      assert.equal(
        handle.agent.session
          .snapshotEvents()
          .slice(before.events.length)
          .some((event) => ["turn/start", "step/start", "user/message"].includes(event.type)),
        false,
        "Do not invent a native turn, step or human input to make restoration legal",
      );
    } finally {
      await handle.dispose();
    }
  },
);

test(
  "official DeepSeek cold history can retain a managed prompt after plugin scope disposal",
  options,
  async (t) => {
    const target = targets[0];
    const f = await rewindProtocolFixture(t, runtimeRoot, target, { unloadableRuntime: true });
    const marker = "SYNTHETIC_REMOVED_PLUGIN_PROMPT";
    const baseline = "SYNTHETIC_HOST_AFTER_PLUGIN_REMOVAL";
    f.ctx.systemPrompt.section({
      name: "fixture:baseline",
      order: 100,
      text: baseline,
      interpolate: false,
    });
    f.settings.prompt = marker;
    const agentOptions = { provider: target.id, model: target.model };
    const first = await f.ctx.agents.create({
      sessionId: "synthetic-unloaded-prompt",
      meta: { cwd: join(f.directory, "project") },
      agentOptions,
    });
    assert.equal((await f.follow(first.agent, "SYNTHETIC_BEFORE_UNLOAD")).kind, "completed");
    assert.ok(systemWire(f.captures.at(-1).body).includes(marker));
    const before = await f.durable(first.agent);
    await first.dispose();
    f.settings.enabled = false;
    await f.unloadRuntime();
    assert.equal(f.ctx.agents.get(first.agent.id), undefined);
    assert.equal(
      f.captures.length,
      1,
      "Closing and unloading must not send a synthetic cleanup turn",
    );
    const cold = await f.ctx.agents.resume({ resumeSessionId: first.agent.id, agentOptions });
    try {
      const resumed = (await f.durable(cold.agent)).events;
      assert.deepEqual(
        resumed.slice(0, before.events.length),
        before.events,
        "Unloading must not rewrite idle history",
      );
      assert.deepEqual(
        resumed.slice(before.events.length).map(({ type, data }) => ({ type, data })),
        [{ type: "session/end-seed", data: {} }],
        "Official resume adds only its native seed marker before user input",
      );
      assert.equal((await f.follow(cold.agent, "SYNTHETIC_AFTER_UNLOAD")).kind, "completed");
      const wire = systemWire(f.captures.at(-1).body);
      assert.ok(
        wire.includes(marker),
        "Known gap: removal alone does not clear the historical prompt",
      );
      assert.ok(wire.includes(baseline));
      assert.deepEqual(
        (await f.durable(cold.agent)).events.slice(0, before.events.length),
        before.events,
      );
    } finally {
      await cold.dispose();
    }
    const fresh = await f.ctx.agents.create({
      sessionId: "synthetic-fresh-after-unload",
      meta: { cwd: join(f.directory, "project") },
      agentOptions,
    });
    try {
      assert.equal((await f.follow(fresh.agent, "SYNTHETIC_FRESH_INPUT")).kind, "completed");
      const wire = systemWire(f.captures.at(-1).body);
      assert.equal(wire.includes(marker), false);
      assert.ok(wire.includes(baseline));
      await f.durable(fresh.agent);
      assert.equal(f.captures.length, 3);
    } finally {
      await fresh.dispose();
    }
  },
);

for (const target of targets)
  for (const mode of ["replace", "append"]) {
    test(
      `official ${target.api} ${mode}: disabled controls recover cold and untouched fork prompts`,
      options,
      async (t) => {
        const f = await rewindProtocolFixture(t, runtimeRoot, target);
        const marker = "SYNTHETIC_PERSISTED_CUSTOM_PROMPT";
        const baseline = "SYNTHETIC_CURRENT_HOST_BASELINE";
        f.ctx.systemPrompt.section({
          name: "fixture:baseline",
          order: 100,
          text: baseline,
          interpolate: false,
        });
        f.settings.prompt = marker;
        f.settings.promptMode = mode;
        const agentOptions = { provider: target.id, model: target.model };
        const original = await f.ctx.agents.create({
          sessionId: "synthetic-prompt-cold",
          meta: { cwd: join(f.directory, "project") },
          agentOptions,
        });
        const first = original.agent;
        assert.equal((await f.follow(first, "SYNTHETIC_FIRST_HUMAN_INPUT")).kind, "completed");
        assert.ok(systemWire(f.captures[0].body).includes(marker));
        const before = await f.durable(first);
        const created = await f.ctx.sessionController.fork({
          sessionId: first.id,
          atSeq: before.events.at(-1).seq,
        });
        const fork = f.ctx.agents.get(created.sessionId);
        assert.equal(fork.systemPrompt.project, Object.getPrototypeOf(fork.systemPrompt).project);
        f.runtime.revert();
        f.settings.enabled = false;
        assert.deepEqual(
          (await f.durable(first)).events,
          before.events,
          "Revert must not write an idle log",
        );
        await original.dispose();
        assert.equal(f.ctx.agents.get(first.id), undefined);
        assert.equal(f.ctx.sessions.get(first.id), undefined);
        const restored = await f.ctx.agents.resume({ resumeSessionId: first.id, agentOptions });
        try {
          const cold = restored.agent;
          assert.notEqual(cold, first);
          assert.notEqual(cold.session, first.session);
          assert.equal(cold.id, first.id);
          for (const agent of [cold, fork]) {
            assert.deepEqual(
              agent.session.snapshotEvents().slice(0, before.events.length),
              before.events,
            );
            assert.equal((await f.follow(agent, "SYNTHETIC_AFTER_REVERT")).kind, "completed");
            const wire = systemWire(f.captures.at(-1).body);
            assert.equal(
              wire.includes(marker),
              false,
              "First request after restoration must not send the old custom prompt",
            );
            assert.ok(wire.includes(baseline));
            const log = await f.durable(agent);
            assert.deepEqual(
              log.events.slice(0, before.events.length),
              before.events,
              "Recovery preserves the original journal",
            );
            assert.ok(JSON.stringify(log.events).includes(marker));
            assert.ok(
              agent.session.deriveMessages().every((m) => m.source["dsh-unlimit"] === undefined),
            );
          }
          const oldSystem = before.events.find((e) => e.type === "system/message").data.message;
          assert.equal(oldSystem.source.kind, "system-prompt");
          assert.deepEqual(oldSystem.source["dsh-unlimit"], owner);
          assert.ok(
            f.captures.every(
              ({ body }) => !JSON.stringify(body).includes('"owner":"managed-prompt"'),
            ),
            "Ownership metadata stays out of all wire protocols",
          );
          assert.equal(
            f.captures.length,
            3,
            "Revert, close, resume and fork do not themselves send requests",
          );
        } finally {
          await restored.dispose();
        }
      },
    );
  }
