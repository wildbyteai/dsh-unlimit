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
