import test from "node:test";
import assert from "node:assert/strict";
import { planTodoReset } from "../src/host/rewind-todos.js";

const todo = (todos) => ({ type: "todo/write", data: { todos } });
const item = (content, status) => ({ content, status });

test("only continuous tasks completed in the removed part of the same turn become pending", () => {
  const before = [
    item("Earlier task", "completed"),
    item("Affected task", "in_progress"),
    item("Unstarted task", "pending"),
  ];
  const events = [
    { type: "turn/start" },
    todo(before),
    { type: "step/end" },
    todo([
      item("Earlier task", "completed"),
      item("Affected task", "completed"),
      item("Unstarted task", "pending"),
      item("New task after cut", "completed"),
    ]),
  ];
  const original = structuredClone(events);
  assert.deepEqual(planTodoReset(events, 2), {
    before,
    todos: [before[0], item("Affected task", "pending"), before[2]],
    plannedCount: 1,
  });
  assert.deepEqual(events, original);
});

test("turn reset, removal/recreation, renamed and reopened tasks are not matched by guessed identity", () => {
  const before = [item("Task", "in_progress")];
  for (const suffix of [
    [{ type: "turn/start" }, todo([item("Task", "completed")])],
    [todo([]), todo([item("Task", "completed")])],
    [todo([item("Renamed", "completed")])],
    [todo([item("Task", "completed")]), todo([item("Task", "in_progress")])],
  ])
    assert.equal(planTodoReset([todo(before), ...suffix], 0), null);
  assert.equal(planTodoReset([todo(before)], -1), null);
  assert.equal(planTodoReset([{ type: "turn/start" }], 0), null);
  assert.equal(planTodoReset([todo([item("Task", "pending")])], 0), null);
});

test("invalid native todo history is rejected rather than silently flattened or ambiguously matched", () => {
  for (const todos of [
    null,
    [item(" Task ", "in_progress")],
    [item("Task", "other")],
    [item("Task", "in_progress"), item("Task", "pending")],
    [{ ...item("Task", "in_progress"), id: "foreign" }],
  ])
    assert.throws(() => planTodoReset([todo(todos)], 0), { code: "INVALID_HOST_RESULT" });
});
