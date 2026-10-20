import test from "node:test";
import assert from "node:assert/strict";
import { MemoryDrafts } from "../web/drafts.js";
const scope = (workspaceId = "one", page = "assets", objectId = "record:a") => ({
  workspaceId,
  page,
  objectId,
});

test("drafts isolate workspaces, pages and existing/new object identities", () => {
  const drafts = new MemoryDrafts();
  const contexts = [
    scope(),
    scope("two"),
    scope("one", "findings"),
    scope("one", "assets", "record:b"),
    scope("one", "assets", "new:asset"),
  ];
  contexts.forEach((context, index) =>
    drafts.capture(context, { name: "" }, { name: `draft-${index}` }),
  );
  contexts.forEach((context, index) => assert.equal(drafts.read(context).name, `draft-${index}`));
  assert.equal(drafts.size, 5);
});
test("drafts store only edits so fresh server fields are not overwritten", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(
    scope(),
    { title: "before", note: "server-a", enabled: false },
    { title: "edited", note: "server-a", enabled: false },
  );
  const currentServer = { title: "before", note: "server-b", enabled: true };
  assert.deepEqual(
    { ...currentServer, ...drafts.read(scope()) },
    { title: "edited", note: "server-b", enabled: true },
  );
});
test("empty strings, false and zero survive draft capture and restoration", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(
    scope(),
    { text: "before", enabled: true, count: 2 },
    { text: "", enabled: false, count: 0 },
  );
  assert.deepEqual(drafts.read(scope()), { text: "", enabled: false, count: 0 });
});
test("returning to baseline removes pending draft and reload warning eligibility", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(scope(), { text: "a" }, { text: "b" });
  assert.equal(drafts.size, 1);
  drafts.capture(scope(), { text: "a" }, { text: "a" });
  assert.equal(drafts.read(scope()), null);
  assert.equal(drafts.size, 0);
});
test("save/discard clears one object while another record remains", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(scope(), {}, { note: "one" });
  drafts.capture(scope("one", "assets", "record:b"), {}, { note: "two" });
  drafts.clear(scope());
  assert.equal(drafts.read(scope()), null);
  assert.equal(drafts.read(scope("one", "assets", "record:b")).note, "two");
});
test("page discard is bounded by workspace and page", () => {
  const drafts = new MemoryDrafts();
  for (const context of [
    scope(),
    scope("one", "assets", "record:b"),
    scope("two"),
    scope("one", "roles"),
  ])
    drafts.capture(context, {}, { note: "draft" });
  drafts.clearPage("one", "assets");
  assert.equal(drafts.countPage("one", "assets"), 0);
  assert.equal(drafts.countPage("two", "assets"), 1);
  assert.equal(drafts.countPage("one", "roles"), 1);
});
test("global record deletion clears its drafts in all workspace views only", () => {
  const drafts = new MemoryDrafts();
  for (const context of [
    scope("one", "knowledge", "record:k"),
    scope("two", "knowledge", "record:k"),
    scope("two", "knowledge", "record:other"),
  ])
    drafts.capture(context, {}, { note: "draft" });
  drafts.clearObject({ page: "knowledge", objectId: "record:k", allWorkspaces: true });
  assert.equal(drafts.size, 1);
  assert.equal(drafts.read(scope("two", "knowledge", "record:other")).note, "draft");
});
test("snapshots are detached and credentials stay in the panel object only", () => {
  const drafts = new MemoryDrafts();
  const current = { secret: "SYNTHETIC_CREDENTIAL", list: ["one"] };
  drafts.capture(scope("one", "evidence", "record:credential"), {}, current);
  current.list.push("outside");
  const read = drafts.read(scope("one", "evidence", "record:credential"));
  read.list.push("outside-again");
  assert.deepEqual(drafts.read(scope("one", "evidence", "record:credential")), {
    secret: "SYNTHETIC_CREDENTIAL",
    list: ["one"],
  });
  assert.equal(new MemoryDrafts().size, 0, "a new panel session has no persisted draft");
});
test("delimiter-like identities cannot collide and invalid identities reject", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(scope("a|b", "c", "d"), {}, { value: "first" });
  drafts.capture(scope("a", "b|c", "d"), {}, { value: "second" });
  assert.equal(drafts.size, 2);
  assert.throws(
    () => drafts.capture({ workspaceId: "one", page: "", objectId: "x" }, {}, {}),
    TypeError,
  );
});

test("selected target identities remain anchored when server list defaults change", () => {
  const drafts = new MemoryDrafts();
  drafts.capture(
    scope("one", "roles", "new-assignment"),
    { sessionId: "session-a", role: "planner" },
    { sessionId: "session-a", role: "analyst" },
    { anchors: ["sessionId"] },
  );
  const newDefaults = { sessionId: "session-b", role: "planner", unrelated: "fresh server value" };
  assert.deepEqual(
    { ...newDefaults, ...drafts.read(scope("one", "roles", "new-assignment")) },
    { sessionId: "session-a", role: "analyst", unrelated: "fresh server value" },
  );
});
