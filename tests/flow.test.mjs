import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Flow } from "../src/core/flow.js";
import { WorkspaceStore } from "../src/core/store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-flow-"));
  const store = new WorkspaceStore(join(directory, "synthetic.sqlite"));
  const flow = new Flow(store);
  t.after(() => {
    flow.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const workspace = (name) => store.dispatch("workspaces.save", { name }).item.id;
  const first = workspace("One");
  const second = workspace("Two");
  const bind = (workspaceId, sessionId) =>
    store.dispatch("workspaces.bind", { id: workspaceId, sessionId });
  const call = (action, payload = {}) => flow.dispatch(action, { workspaceId: first, ...payload });
  return { store, flow, first, second, bind, call };
}
const code = (expected) => (error) => error.code === expected;

test("local flow defaults to three slots and ordinary sessions receive no role prompt", (t) => {
  const { call, flow, bind, first, second, store } = fixture(t);
  bind(first, "ordinary");
  store.dispatch("workspaces.activate", { id: second });
  assert.deepEqual(call("flow.status"), {
    workspaceId: first,
    limit: 3,
    available: 3,
    active: [],
    assignments: [],
  });
  assert.equal(flow.rolePrompt("unbound"), null);
  assert.equal(flow.rolePrompt("ordinary"), null);
  assert.throws(() => call("flow.acquire", { sessionId: "ordinary" }), code("ROLE_REQUIRED"));
});

test("explicit assignment and acquisition are workspace-bound, idempotent and refuse a full workspace", (t) => {
  const { call, flow, bind, first } = fixture(t);
  for (const [sessionId, role] of [
    ["one", "planner"],
    ["two", "recon"],
    ["three", "scanner"],
    ["four", "validator"],
  ]) {
    bind(first, sessionId);
    call("flow.assign", { sessionId, role });
  }
  assert.ok(flow.rolePrompt("one").includes("指挥"));
  const firstResult = call("flow.acquire", { sessionId: "one" });
  assert.equal(firstResult.acquired, true);
  const again = call("flow.acquire", { sessionId: "one" });
  assert.equal(again.acquired, false);
  assert.equal(again.item.acquiredAt, firstResult.item.acquiredAt);
  again.active[0].role = "forged";
  assert.equal(call("flow.status").active[0].role, "planner");
  call("flow.acquire", { sessionId: "two" });
  call("flow.acquire", { sessionId: "three" });
  assert.equal(call("flow.status").available, 0);
  assert.throws(() => call("flow.acquire", { sessionId: "four" }), code("SLOTS_FULL"));
  assert.equal(call("flow.release", { sessionId: "two" }).released, true);
  assert.equal(call("flow.release", { sessionId: "two" }).released, false);
  assert.equal(call("flow.acquire", { sessionId: "four" }).acquired, true);
});

test("cross-workspace and unbound sessions cannot receive assignments or acquire/release slots", (t) => {
  const { call, bind, first, second } = fixture(t);
  bind(second, "foreign");
  for (const sessionId of ["foreign", "unbound"]) {
    for (const action of ["flow.assign", "flow.acquire", "flow.release"])
      assert.throws(() => call(action, { sessionId, role: "planner" }), code("WORKSPACE_MISMATCH"));
  }
  bind(first, "valid");
  assert.throws(
    () => call("flow.assign", { sessionId: "valid", role: "unknown" }),
    code("INVALID_INPUT"),
  );
  call("flow.assign", { sessionId: "valid", role: "internal" });
  assert.throws(
    () => call("flow.acquire", { sessionId: "valid", role: "scanner" }),
    code("ROLE_MISMATCH"),
  );
});

test("limits persist independently per workspace and cannot undercut current usage", (t) => {
  const { call, bind, first, second } = fixture(t);
  for (const limit of [0, 11, 1.5, "3"])
    assert.throws(() => call("flow.configure", { limit }), code("INVALID_INPUT"));
  assert.equal(call("flow.configure", { limit: 10 }).limit, 10);
  assert.equal(call("flow.status", { workspaceId: second }).limit, 3);
  for (const sessionId of ["one", "two"]) {
    bind(first, sessionId);
    call("flow.assign", { sessionId, role: "reporter" });
    call("flow.acquire", { sessionId });
  }
  assert.throws(() => call("flow.configure", { limit: 1 }), code("CONFLICT"));
  assert.equal(call("flow.status").limit, 10);
});

test("revoking an assignment releases its slot and custom workspace role text is read dynamically", (t) => {
  const { call, bind, first, store, flow } = fixture(t);
  bind(first, "assigned");
  call("flow.assign", { sessionId: "assigned", role: "analyst" });
  call("flow.acquire", { sessionId: "assigned" });
  store.dispatch("roles.save", {
    workspaceId: first,
    role: "analyst",
    content: "Synthetic updated workspace role",
  });
  assert.equal(flow.rolePrompt("assigned"), "Synthetic updated workspace role");
  assert.equal(call("flow.assign", { sessionId: "assigned", role: null }).active.length, 0);
  assert.equal(flow.rolePrompt("assigned"), null);
});

test("rebinding a session drops its former workspace slot and does not inherit the former role", (t) => {
  const { call, bind, first, second, flow } = fixture(t);
  bind(first, "moving");
  call("flow.assign", { sessionId: "moving", role: "validator" });
  call("flow.acquire", { sessionId: "moving" });
  bind(second, "moving");
  assert.equal(flow.rolePrompt("moving"), null);
  assert.equal(call("flow.status").active.length, 0);
  assert.equal(call("flow.status").assignments.length, 0);
  assert.throws(() => call("flow.acquire", { sessionId: "moving" }), code("WORKSPACE_MISMATCH"));
});

test("close clears volatile slots while a new instance reads persisted limit and explicit assignments", (t) => {
  const { store, flow, call, bind, first } = fixture(t);
  bind(first, "__proto__");
  call("flow.configure", { limit: 5 });
  call("flow.assign", { sessionId: "__proto__", role: "reviewer" });
  call("flow.acquire", { sessionId: "__proto__" });
  flow.close();
  assert.throws(() => call("flow.status"), code("CLOSED"));
  const reopened = new Flow(store);
  try {
    const status = reopened.dispatch("flow.status", { workspaceId: first });
    assert.equal(status.limit, 5);
    assert.equal(status.active.length, 0);
    assert.deepEqual(status.assignments, [{ sessionId: "__proto__", role: "reviewer" }]);
    assert.ok(reopened.rolePrompt("__proto__"));
    assert.throws(
      () => reopened.dispatch("flow.execute", { workspaceId: first }),
      code("UNKNOWN_ACTION"),
    );
  } finally {
    reopened.close();
  }
});
