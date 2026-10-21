import test from "node:test";
import assert from "node:assert/strict";
import { connectPromptRefresh } from "../src/host/prompt-refresh.js";

function fixture() {
  const listeners = new Map();
  const ctx = {
    on(name, callback) {
      assert.equal(listeners.has(name), false);
      listeners.set(name, callback);
      return () => {
        if (listeners.get(name) === callback) listeners.delete(name);
      };
    },
  };
  let settingsReads = 0;
  const runtime = {
    settings() {
      settingsReads++;
      return { enabled: true };
    },
    service() {
      assert.fail("A disposed first request must not assemble a prompt");
    },
  };
  const project = function (text) {
    assert.equal(this, agent.systemPrompt);
    return { text };
  };
  const agent = { systemPrompt: { project } };
  const payload = { agent, turn: 1, step: 1, signal: new AbortController().signal };
  return { ctx, runtime, listeners, agent, payload, project, reads: () => settingsReads };
}

test("disposing prompt refresh while downstream request waits cannot install a late projection", async () => {
  const f = fixture();
  const dispose = connectPromptRefresh(f.ctx, f.runtime);
  const gate = Promise.withResolvers();
  const config = { model: "synthetic" };
  const pending = f.listeners.get("agent/request")(f.payload, () => gate.promise);
  dispose();
  gate.resolve(config);
  try {
    assert.equal(await pending, config);
    assert.equal(f.agent.systemPrompt.project, f.project);
    assert.equal(f.reads(), 0);
    assert.equal(f.listeners.size, 0);
  } finally {
    dispose();
  }
});

test("a request from the previous registration cannot replace the new registration's projection", async () => {
  const f = fixture();
  const disposeOld = connectPromptRefresh(f.ctx, f.runtime);
  const gate = Promise.withResolvers();
  const pending = f.listeners.get("agent/request")(f.payload, () => gate.promise);
  disposeOld();
  const disposeNew = connectPromptRefresh(f.ctx, f.runtime);
  await f.listeners.get("agent/request")(f.payload, async () => ({ model: "new" }));
  const current = f.agent.systemPrompt.project;
  assert.notEqual(current, f.project);
  const reads = f.reads();
  gate.resolve({ model: "old" });
  try {
    await pending;
    assert.equal(f.agent.systemPrompt.project, current);
    assert.equal(f.reads(), reads);
    assert.deepEqual(f.agent.systemPrompt.project("host text"), { text: "host text" });
  } finally {
    disposeNew();
  }
  assert.equal(f.agent.systemPrompt.project, f.project);
});

test("a preserved external wrapper can call a disposed refresh wrapper without reading closed settings", async () => {
  const f = fixture();
  const dispose = connectPromptRefresh(f.ctx, f.runtime);
  await f.listeners.get("agent/request")(f.payload, async () => ({ model: "synthetic" }));
  const owned = f.agent.systemPrompt.project;
  const external = function (text) {
    return owned.call(this, text + " / external");
  };
  f.agent.systemPrompt.project = external;
  assert.throws(dispose, /其他插件修改/);
  assert.equal(f.agent.systemPrompt.project, external);
  f.runtime.settings = () => assert.fail("Disposed wrapper must not read a closed settings store");
  assert.deepEqual(f.agent.systemPrompt.project("host text"), { text: "host text / external" });
  assert.equal(f.listeners.size, 0);
});
