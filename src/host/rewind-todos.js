import { randomUUID } from "node:crypto";
import { fail } from "../core/validation.js";
import { resolveOfficialPackage } from "./official-package.js";

const service = (ctx, name) => (ctx.get ? ctx.get(name) : ctx[name]);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function list(value) {
  const seen = new Set();
  if (!Array.isArray(value)) fail("INVALID_HOST_RESULT", "Todo snapshot is not a list");
  return value.map((item) => {
    if (
      !item ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content !== item.content.trim() ||
      seen.has(item.content) ||
      !["pending", "in_progress", "completed"].includes(item.status) ||
      Object.keys(item).some((key) => !["content", "status"].includes(key))
    )
      fail("INVALID_HOST_RESULT", "Todo snapshot has no unambiguous native task identity");
    seen.add(item.content);
    return { content: item.content, status: item.status };
  });
}

// Only continuous, exact-content tasks in the retained turn can be related.
// A new turn, disappearance or rename breaks that relationship.
export function planTodoReset(events, atSeq) {
  let before = null;
  for (const event of events.slice(0, atSeq + 1)) {
    if (event.type === "turn/start") before = null;
    if (event.type === "todo/write") before = list(event.data?.todos);
  }
  if (!before) return null;
  const tracked = new Map(
    before
      .filter((item) => item.status === "in_progress")
      .map((item) => [item.content, item.status]),
  );
  if (!tracked.size) return null;
  for (const event of events.slice(atSeq + 1)) {
    if (event.type === "turn/start") break;
    if (event.type !== "todo/write") continue;
    const snapshot = new Map(list(event.data?.todos).map((item) => [item.content, item.status]));
    for (const content of tracked.keys()) {
      if (!snapshot.has(content)) tracked.delete(content);
      else tracked.set(content, snapshot.get(content));
    }
  }
  const completed = new Set(
    [...tracked].filter(([, status]) => status === "completed").map(([content]) => content),
  );
  if (!completed.size) return null;
  return {
    before,
    todos: before.map((item) =>
      completed.has(item.content) ? { ...item, status: "pending" } : item,
    ),
    plannedCount: completed.size,
  };
}

export class RewindTodos {
  #active = new Set();
  #closed = false;

  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }

  check() {
    if (this.#closed) fail("TODO_RESET_UNSUPPORTED", "待办恢复接口已关闭");
    if (this.host?.supported !== true)
      fail("TODO_RESET_UNSUPPORTED", "当前宿主尚未验证待办恢复接口");
    for (const name of ["@deepseek-ai/dsh-tool-todo", "@deepseek-ai/dsh-tools"])
      if (resolveOfficialPackage(this.host.runtimeRoot, name).reason)
        fail("TODO_RESET_UNSUPPORTED", "官方待办工具或执行器与适配版本不一致");
    const tools = service(this.ctx, "tools");
    const projections = service(this.ctx, "sessionProjections");
    const sessions = service(this.ctx, "sessions");
    if (
      typeof tools?.execute !== "function" ||
      typeof tools?.resolveExecution !== "function" ||
      typeof projections?.snapshot !== "function" ||
      typeof sessions?.flush !== "function" ||
      typeof this.ctx.on !== "function"
    )
      fail("TODO_RESET_UNSUPPORTED", "当前未提供完整的官方待办写入与读回接口");
    return { tools, projections, sessions };
  }

  async apply(agent, plan, progress) {
    const { tools, projections, sessions } = this.check();
    const snapshot = () => projections.snapshot(agent.session, ["todos"]).values.todos;
    if (!tools.resolveExecution("todo_write", agent, false))
      fail("TODO_RESET_UNSUPPORTED", "新分支当前模式不能直接调用待办工具，未归档原会话");
    if (!equal(snapshot(), plan.before))
      fail("TODO_RESET_CONFLICT", "新分支待办已发生变化，未覆盖或归档原会话");
    const abort = new AbortController();
    this.#active.add(abort);
    const dispose = this.ctx.on("session/event", (session, event) => {
      if (
        session.id === agent.id &&
        ["turn/start", "user/message", "agent/inbox/spliced"].includes(event.type)
      )
        abort.abort(new Error("新分支已接纳其他输入"));
    });
    const start = agent.session.snapshotEvents().length;
    let result;
    let failed = false;
    try {
      try {
        result = await tools.execute({
          name: "todo_write",
          arguments: { todos: plan.todos },
          agent,
          callId: `dsh-unlimit-rewind-${randomUUID()}`,
          signal: abort.signal,
        });
      } catch {
        failed = true;
      }
      // A post-execution policy may reject after the official write committed.
      // Record that fact even when the overall rewind remains incomplete.
      const durable = await sessions.flush(agent.session);
      progress.verified =
        durable === true &&
        equal(snapshot(), plan.todos) &&
        agent.session
          .snapshotEvents()
          .slice(start)
          .some((event) => event.type === "todo/write" && equal(event.data?.todos, plan.todos));
      progress.resetCount = progress.verified ? plan.plannedCount : 0;
      if (failed || result?.isError !== false || abort.signal.aborted || !progress.verified)
        fail("TODO_RESET_FAILED", "待办恢复未完整完成，请检查新分支；原会话尚未归档");
    } finally {
      this.#active.delete(abort);
      dispose();
    }
  }

  close() {
    this.#closed = true;
    for (const controller of this.#active) controller.abort(new Error("待办恢复接口已关闭"));
  }
}
