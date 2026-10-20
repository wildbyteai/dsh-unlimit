import test from "node:test";
import assert from "node:assert/strict";
import { Controller } from "../src/server/controller.js";

test("unverified desktop versions cannot prepare or perform a destructive session transition", async () => {
  let calls = 0;
  const host = { supported: false };
  const sessions = {
    prepare() {
      calls++;
      return { ready: true };
    },
    rewind() {
      calls++;
      return { newSessionId: "synthetic" };
    },
  };
  const controller = new Controller({ host, sessions });
  for (const action of ["sessions.prepare", "sessions.rewind"]) {
    await assert.rejects(controller.dispatch(action), { code: "UNSUPPORTED" });
  }
  assert.equal(calls, 0);
  host.supported = true;
  assert.deepEqual(await controller.dispatch("sessions.prepare"), { ready: true });
  assert.equal(calls, 1);
});

test("owned active workflow sessions cannot bypass their execution slots via generic actions", async () => {
  const calls = [];
  const controller = new Controller({
    host: { supported: true },
    workflow: { controlsSession: (sessionId) => sessionId === "owned-executor" },
    store: {
      dispatch: (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
    flow: {
      dispatch: (...args) => {
        calls.push(args);
        return { ok: true };
      },
    },
  });
  for (const action of ["workspaces.bind", "flow.assign", "flow.release"]) {
    await assert.rejects(controller.dispatch(action, { sessionId: "owned-executor" }), {
      code: "CONFLICT",
    });
  }
  assert.equal(calls.length, 0);
  await controller.dispatch("flow.release", { sessionId: "ordinary-session" });
  assert.equal(calls.length, 1);
});

test("unknown versions cannot start workflow or continuation mutations", async () => {
  let calls = 0;
  const controller = new Controller({
    host: { supported: false },
    workflow: {
      dispatch: () => {
        calls++;
      },
    },
    continuation: {
      continue: () => {
        calls++;
      },
      stop: () => {
        calls++;
      },
    },
    plans: {
      capabilities: () => ({ available: true }),
      dispatch: () => {
        calls++;
      },
    },
  });
  for (const action of [
    "workflow.dispatch",
    "workflow.stop",
    "workflow.presets",
    "continuation.continue",
    "continuation.stop",
    "workflow.plan.create",
  ]) {
    await assert.rejects(controller.dispatch(action, { operation: "register" }), {
      code: "UNSUPPORTED",
    });
  }
  assert.equal((await controller.dispatch("workflow.plan.capabilities")).available, false);
  assert.equal(calls, 0);
});
