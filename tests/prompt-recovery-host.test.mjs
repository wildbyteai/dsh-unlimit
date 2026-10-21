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
