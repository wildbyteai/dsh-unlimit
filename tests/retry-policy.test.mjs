import test from "node:test";
import assert from "node:assert/strict";
import { RetryPolicy } from "../src/host/retry-policy.js";

const normal = Object.freeze({
  mode: "normal",
  maxRetries: 7,
  retryableCodes: Object.freeze(["SERVER", "AUTH", "TIMEOUT"]),
  initialDelayMs: 9,
  maxDelayMs: 100,
  jitterRatio: 0.2,
});
const errorCode = (code) => (error) => error.code === code;

function fixture(policy = normal) {
  const settings = { enabled: true, retryOverride: false, retryLimit: 2 };
  const marker = Symbol("synthetic-prepared-field");
  const prepared = Object.freeze({
    retryPolicy: policy,
    config: Object.freeze({ provider: "synthetic" }),
    stream: () => "original closure",
    [marker]: "retained",
  });
  const llm = {
    async prepareCall(...args) {
      assert.equal(this, llm);
      llm.args = args;
      return prepared;
    },
  };
  const projections = {
    registrations: new Map([["llmRetry", { def: { key: "llmRetry", stateVersion: 1 }, refs: 1 }]]),
    stateOf() {},
  };
  const ctx = { llm, sessionProjections: projections };
  const adapter = new RetryPolicy(ctx, {
    dispatch(action) {
      assert.equal(action, "settings.get");
      return { value: settings };
    },
  });
  return { settings, prepared, llm, projections, ctx, adapter, marker };
}

test("retry capability requires the active versioned executor, not just an llm method", () => {
  const f = fixture();
  const before = Object.getOwnPropertyDescriptor(f.llm, "prepareCall");
  delete f.ctx.sessionProjections;
  assert.equal(f.adapter.capabilities()[0].state, "unsupported");
  assert.throws(() => f.adapter.apply(), errorCode("UNSUPPORTED"));
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.llm, "prepareCall"), before);
  f.ctx.sessionProjections = f.projections;
  f.projections.registrations.get("llmRetry").def.stateVersion = 2;
  assert.equal(f.adapter.capabilities()[0].state, "unsupported");
  f.projections.registrations.get("llmRetry").def.stateVersion = 1;
  assert.equal(f.adapter.capabilities()[0].state, "available");
  Object.defineProperty(f.llm, "prepareCall", { configurable: false, writable: false });
  assert.equal(f.adapter.capabilities()[0].state, "unsupported");
});

test("disabled override returns the exact official handle and forwards this, signal and configure", async () => {
  const f = fixture();
  f.adapter.apply();
  const config = {},
    signal = new AbortController().signal,
    configure = () => ({});
  assert.equal(await f.llm.prepareCall(config, signal, configure), f.prepared);
  assert.deepEqual(f.llm.args, [config, signal, configure]);
  f.settings.retryOverride = true;
  f.settings.enabled = false;
  assert.equal(await f.llm.prepareCall(), f.prepared);
  f.adapter.revert();
});

test("per-call override preserves frozen prepared fields and narrows normal policy without changing backoff", async () => {
  const f = fixture();
  f.settings.retryOverride = true;
  const before = Object.getOwnPropertyDescriptor(f.llm, "prepareCall");
  f.adapter.apply();
  const firstMethod = f.llm.prepareCall;
  f.adapter.apply();
  assert.equal(f.llm.prepareCall, firstMethod);
  const call = await f.llm.prepareCall();
  assert.notEqual(call, f.prepared);
  assert.equal(Object.isFrozen(call), true);
  assert.equal(call.config, f.prepared.config);
  assert.equal(call.stream, f.prepared.stream);
  assert.equal(call[f.marker], "retained");
  assert.deepEqual(call.retryPolicy, {
    mode: "normal",
    maxRetries: 2,
    retryableCodes: ["SERVER", "TIMEOUT"],
    initialDelayMs: 9,
    maxDelayMs: 100,
    jitterRatio: 0.2,
  });
  assert.equal(Object.isFrozen(call.retryPolicy.retryableCodes), true);
  f.settings.retryLimit = 0;
  assert.equal((await f.llm.prepareCall()).retryPolicy.maxRetries, 0);
  assert.equal(call.retryPolicy.maxRetries, 2, "already prepared calls keep their captured policy");
  assert.equal(f.prepared.retryPolicy, normal);
  f.adapter.revert();
  f.adapter.revert();
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.llm, "prepareCall"), before);
});

test("always becomes bounded transient-only normal and an empty original intersection stays empty", async () => {
  const f = fixture(
    Object.freeze({ mode: "always", initialDelayMs: 1, maxDelayMs: 50, jitterRatio: 0 }),
  );
  f.settings.retryOverride = true;
  f.adapter.apply();
  const policy = (await f.llm.prepareCall()).retryPolicy;
  assert.equal(policy.mode, "normal");
  assert.deepEqual(policy.retryableCodes, [
    "EMPTY_RESPONSE",
    "RATE_LIMIT",
    "SERVER",
    "TIMEOUT",
    "TRANSPORT",
  ]);
  f.adapter.revert();
  const g = fixture(Object.freeze({ ...normal, retryableCodes: ["AUTH"] }));
  g.settings.retryOverride = true;
  g.adapter.apply();
  assert.deepEqual((await g.llm.prepareCall()).retryPolicy.retryableCodes, []);
  g.adapter.revert();
});

test("invalid settings, incompatible policy and an unloaded executor reject without fake success", async () => {
  const f = fixture();
  f.settings.retryOverride = true;
  f.adapter.apply();
  for (const value of [-1, 21, 1.2, "2"]) {
    f.settings.retryLimit = value;
    await assert.rejects(f.llm.prepareCall(), errorCode("INVALID_INPUT"));
  }
  f.settings.retryLimit = 2;
  f.projections.registrations.clear();
  assert.match(f.adapter.capabilities()[0].detail, /llmRetry/);
  assert.throws(() => f.adapter.apply(), errorCode("UNSUPPORTED"));
  await assert.rejects(f.llm.prepareCall(), errorCode("UNSUPPORTED"));
  f.adapter.revert();
  for (const policy of [
    null,
    { ...normal, mode: "new-policy" },
    { ...normal, initialDelayMs: 0 },
    { ...normal, unknown: true },
    { ...normal, retryableCodes: ["SERVER", "SERVER"] },
  ]) {
    const g = fixture(policy);
    g.settings.retryOverride = true;
    g.adapter.apply();
    await assert.rejects(g.llm.prepareCall(), errorCode("UNSUPPORTED"));
    g.adapter.revert();
  }
});

test("revert restores inherited methods and preserves replacement by another owner", () => {
  const f = fixture();
  const original = f.llm.prepareCall;
  delete f.llm.prepareCall;
  Object.setPrototypeOf(f.llm, { prepareCall: original });
  f.adapter.apply();
  f.adapter.revert();
  assert.equal(Object.hasOwn(f.llm, "prepareCall"), false);
  f.adapter.apply();
  const replacement = async () => f.prepared;
  f.llm.prepareCall = replacement;
  assert.equal(f.adapter.capabilities()[0].state, "unsupported");
  assert.throws(() => f.adapter.apply(), errorCode("CONFLICT"));
  assert.throws(() => f.adapter.revert(), errorCode("CONFLICT"));
  assert.equal(f.llm.prepareCall, replacement);
});
