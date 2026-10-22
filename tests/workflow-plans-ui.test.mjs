import test from "node:test";
import assert from "node:assert/strict";
import { workflowPlans } from "../web/workflow-plans.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const decode = (value) =>
  value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name],
  );
const deferred = () => Promise.withResolvers();
const task = { id: "evidence", role: "analyst", task: "整理合成材料", requirements: [] };
const plan = (id = "plan-one", changes = {}) => ({
  id,
  state: "queued",
  tasks: [{ ...task, state: "queued" }],
  ...changes,
});
const summaryPlan = (patch = {}) =>
  plan("plan-summary", {
    state: "completed",
    summaryTaskId: "$summary",
    tasks: [
      { ...task, state: "completed", runId: "run-evidence" },
      {
        id: "$summary",
        kind: "summary",
        role: "planner",
        state: "completed",
        runId: "run-summary",
        receipt: {
          disposed: true,
          slotReleased: true,
          result: { stopReason: "completed", output: [{ type: "text", text: "合成汇总正文" }] },
        },
        sources: [
          {
            taskId: "evidence",
            runId: "run-evidence",
            state: "completed",
            source: "workflow-receipt",
            independentlyVerified: false,
          },
        ],
        ...patch,
      },
    ],
  });

// Only the form, listener and text/HTML operations this page uses are modeled.
class SyntheticModule {
  constructor(html) {
    this.isConnected = true;
    this.nodes = new Map();
    for (const [, tag, id, attributes] of html.matchAll(/<(\w+)\b[^>]*id="([^"]+)"([^>]*)>/g)) {
      const handlers = [];
      const node = {
        value: decode(attributes.match(/\bvalue="([^"]*)"/)?.[1] ?? ""),
        disabled: /\bdisabled\b/.test(attributes),
        checked: /\bchecked\b/.test(attributes),
        innerHTML: "",
        textContent: "",
        className: "",
        addEventListener(type, handler, { signal }) {
          handlers.push({ type, handler, signal });
        },
        dispatchEvent(event) {
          for (const row of handlers)
            if (row.type === event.type && !row.signal.aborted) row.handler(event);
          return true;
        },
        focus() {},
        select() {},
      };
      if (tag === "textarea") {
        const content = html.match(
          new RegExp(`<textarea[^>]*id="${id}"[^>]*>([\\s\\S]*?)</textarea>`),
        );
        node.value = decode(content?.[1] ?? "");
      }
      this.nodes.set(`#${id}`, node);
    }
  }
  querySelector(selector) {
    return selector === "#workflow-plans-module" ? this : this.nodes.get(selector);
  }
  node(id) {
    const node = this.nodes.get(`#workflow-plan-${id}`);
    assert.ok(node, `Missing synthetic node ${id}`);
    return node;
  }
  emit(id, type) {
    this.node(id).dispatchEvent({ type, preventDefault() {} });
  }
}

async function setup({ capability = { available: true, evidenceSummary: true }, respond } = {}) {
  const calls = [];
  const errors = [];
  const jobs = [];
  const view = await workflowPlans({
    api: async (action, payload) => {
      calls.push({ action, payload: structuredClone(payload) });
      if (respond) return respond(action, payload);
      return action === "workflow.plan.capabilities"
        ? capability
        : { item: plan(payload.id), stopped: true };
    },
    esc,
    panel: (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    table: (rows, columns) =>
      `<table>${rows.map((row) => `<tr>${columns.map(([field]) => `<td>${esc(row[field])}</td>`).join("")}</tr>`).join("")}</table>`,
    empty: (title, detail) => `<p>${esc(title)} ${esc(detail)}</p>`,
    toast() {},
    run(_button, work) {
      const job = work().catch((error) => errors.push(error));
      jobs.push(job);
      return job;
    },
    workspaceId: "workspace-one",
    sessions: [{ id: "parent-one", name: "合成父会话", workspaceId: "workspace-one" }],
    roles: [{ role: "analyst" }, { role: "planner" }],
  });
  const host = new SyntheticModule(view.html);
  view.bind(host);
  host.node("json").value = JSON.stringify([task]);
  const flush = async () => {
    while (jobs.length) await Promise.all(jobs.splice(0));
  };
  const emit = async (id, type) => {
    host.emit(id, type);
    await flush();
  };
  const select = (id) => {
    host.node("id").value = id;
    host.node("query-parent").value = "parent-one";
    host.emit("id", "input");
  };
  return { view, host, calls, errors, flush, emit, select };
}

test("goal planning displays a checked draft, fills JSON only on request and never auto-submits", async () => {
  const draft = {
    ...task,
    dependsOn: [],
    task: "整理合成材料 <script>never-run</script>",
    skills: [{ origin: "project", id: "evidence-review", resources: ["references/count.md"] }],
  };
  const ui = await setup({
    respond(action, payload) {
      if (action === "workflow.plan.capabilities") return { available: true, planDrafting: true };
      if (action === "workflow.plan.propose")
        return { item: plan("draft-one", { proposal: { state: "pending" } }) };
      if (action === "workflow.plan.status")
        return { item: plan("draft-one", { proposal: { state: "ready", tasks: [draft] } }) };
      return { item: plan(payload.id) };
    },
  });
  assert.equal(ui.host.node("propose").disabled, false);
  assert.equal(ui.host.node("use-draft").disabled, true);
  ui.host.node("goal").value = "盘点合成材料";
  await ui.emit("propose", "click");
  assert.deepEqual(ui.calls.at(-1), {
    action: "workflow.plan.propose",
    payload: { workspaceId: "workspace-one", parentSessionId: "parent-one", goal: "盘点合成材料" },
  });
  assert.equal(ui.host.node("id").value, "draft-one");
  assert.equal(ui.host.node("use-draft").disabled, true);
  await ui.emit("query-form", "submit");
  assert.match(ui.host.node("result").innerHTML, /生成的任务草稿/);
  assert.match(ui.host.node("result").innerHTML, /project\/evidence-review/);
  assert.match(ui.host.node("result").innerHTML, /&lt;script&gt;/);
  assert.doesNotMatch(ui.host.node("result").innerHTML, /<script>/);
  assert.deepEqual(JSON.parse(ui.host.node("json").value), [task]);
  assert.equal(ui.host.node("use-draft").disabled, false);
  await ui.emit("use-draft", "click");
  assert.deepEqual(JSON.parse(ui.host.node("json").value), [draft]);
  assert.equal(
    ui.calls.some(({ action }) => action === "workflow.plan.create"),
    false,
  );
  await ui.emit("create-form", "submit");
  assert.equal(ui.calls.at(-1).action, "workflow.plan.create");
  assert.deepEqual(ui.calls.at(-1).payload.tasks, [draft]);
});

test("task receipts show native image storage and source separately from actual startup", async () => {
  const ui = await setup({
    respond: () => ({
      item: plan("image-plan", {
        state: "finished-with-errors",
        tasks: [
          {
            ...task,
            state: "failed",
            runId: "saved-run",
            receipt: {
              imageStorage: "saved",
              images: [{ origin: "host", id: "evidence", path: "assets/<chart>.png" }],
            },
          },
          { ...task, id: "unknown", state: "failed", receipt: { imageStorage: "unconfirmed" } },
        ],
      }),
    }),
  });
  ui.select("image-plan");
  await ui.emit("query-form", "submit");
  const html = ui.host.node("result").innerHTML;
  assert.match(html, /已保存原生附件：host\/evidence\/assets\/&lt;chart&gt;\.png/);
  assert.match(html, /保存结果未确认/);
  assert.match(html, /仅有运行记录，检查收据/);
  assert.doesNotMatch(html, /已取得启动收据|<chart>/);
});

test("unavailable, invalid and late proposals cannot fill an unrelated plan", async () => {
  const unsupported = await setup();
  assert.equal(unsupported.host.node("propose").disabled, true);
  const result = deferred();
  const ui = await setup({
    respond(action) {
      if (action === "workflow.plan.capabilities") return { available: true, planDrafting: true };
      return result.promise;
    },
  });
  ui.host.node("goal").value = "合成目标";
  ui.host.emit("propose", "click");
  await Promise.resolve();
  ui.select("another-plan");
  result.resolve({ item: plan("draft", { proposal: { state: "ready", tasks: [task] } }) });
  await ui.flush();
  assert.equal(ui.host.node("id").value, "another-plan");
  assert.equal(ui.host.node("use-draft").disabled, true);
  const invalid = await setup({
    respond(action) {
      if (action === "workflow.plan.capabilities") return { available: true, planDrafting: true };
      return {
        item: plan("draft", {
          proposal: { state: "invalid", error: { message: "Unknown tool <b>bad</b>" } },
        }),
      };
    },
  });
  invalid.select("draft");
  await invalid.emit("query-form", "submit");
  assert.match(invalid.host.node("result").innerHTML, /Unknown tool &lt;b&gt;bad&lt;\/b&gt;/);
  assert.equal(invalid.host.node("use-draft").disabled, true);
});

test("automatic goal execution is a separate explicit action and its generated plan cannot be submitted again by the fill button", async () => {
  const ui = await setup({
    respond(action) {
      if (action === "workflow.plan.capabilities")
        return {
          available: true,
          planDrafting: true,
          automaticTaskMatching: true,
          evidenceSummary: true,
        };
      return {
        item: plan("automatic-one", {
          proposal: { state: "ready", execute: true, tasks: [{ ...task, dependsOn: [] }] },
        }),
      };
    },
  });
  assert.equal(ui.host.node("run-goal").disabled, false);
  ui.host.node("goal").value = "只整理明确提供的合成材料";
  ui.host.node("summarize").checked = true;
  await ui.emit("run-goal", "click");
  assert.deepEqual(ui.calls.at(-1), {
    action: "workflow.plan.run",
    payload: {
      workspaceId: "workspace-one",
      parentSessionId: "parent-one",
      goal: "只整理明确提供的合成材料",
      summarize: true,
    },
  });
  assert.match(ui.host.node("result").innerHTML, /自动执行计划/);
  assert.match(ui.host.node("result").innerHTML, /不要重复提交/);
  assert.equal(ui.host.node("use-draft").disabled, true);
  await ui.emit("use-draft", "click");
  assert.deepEqual(JSON.parse(ui.host.node("json").value), [task]);
  assert.equal(
    ui.calls.some(({ action }) => action === "workflow.plan.create"),
    false,
  );
});

test("missing or withdrawn automatic execution capability does not silently fall back to another action", async () => {
  const missing = await setup();
  assert.equal(missing.host.node("run-goal").disabled, true);
  let calls = 0;
  const ui = await setup({
    respond(action) {
      assert.equal(action, "workflow.plan.capabilities");
      return { available: true, planDrafting: true, automaticTaskMatching: ++calls === 1 };
    },
  });
  ui.host.node("goal").value = "Synthetic goal";
  await ui.emit("run-goal", "click");
  assert.equal(ui.errors.length, 1);
  assert.equal(
    ui.calls.some(({ action }) => action === "workflow.plan.run"),
    false,
  );
});

test("summary is opt-in, discloses the extra model call and never changes the default create payload", async () => {
  const ui = await setup();
  assert.equal(ui.host.node("summarize").checked, false);
  assert.equal(ui.host.node("summarize").disabled, false);
  assert.match(ui.view.html, /任务结束后生成指挥汇总/);
  assert.match(ui.view.html, /增加一次模型调用/);
  assert.match(ui.view.html, /不会自动核实事实/);
  await ui.emit("create-form", "submit");
  assert.deepEqual(ui.calls.at(-1), {
    action: "workflow.plan.create",
    payload: { workspaceId: "workspace-one", parentSessionId: "parent-one", tasks: [task] },
  });
  ui.host.node("summarize").checked = true;
  await ui.emit("create-form", "submit");
  assert.equal(ui.calls.at(-1).payload.summarize, true);
  assert.equal(ui.errors.length, 0);
});

test("unsupported summary is disabled and a capability change cannot submit an unsupported opt-in", async () => {
  for (const capability of [{ available: true }, { available: true, evidenceSummary: false }]) {
    const ui = await setup({ capability });
    assert.equal(ui.host.node("summarize").disabled, true);
    assert.equal(ui.host.node("summarize").checked, false);
    await ui.emit("create-form", "submit");
    assert.equal(Object.hasOwn(ui.calls.at(-1).payload, "summarize"), false);
  }
  let capabilityCalls = 0;
  const ui = await setup({
    respond(action) {
      assert.equal(action, "workflow.plan.capabilities");
      return { available: true, evidenceSummary: ++capabilityCalls === 1 };
    },
  });
  ui.host.node("summarize").checked = true;
  await ui.emit("create-form", "submit");
  assert.equal(ui.calls.length, 2);
  assert.match(ui.host.node("feedback").textContent, /不支持指挥汇总/);
  assert.equal(ui.host.node("summarize").disabled, true);
  assert.equal(ui.host.node("summarize").checked, false);
});

test("summary text and task/run sources are readable outside JSON and all remote text stays escaped", async () => {
  const hostile = '<img src=x onerror="bad">&';
  const item = summaryPlan({
    receipt: {
      disposed: true,
      slotReleased: true,
      result: {
        output: [
          { type: "text", text: hostile },
          { type: "image", path: hostile },
        ],
      },
    },
    sources: [
      {
        taskId: hostile,
        runId: hostile,
        state: "failed",
        source: "workflow-receipt",
        independentlyVerified: false,
      },
      {
        taskId: "blocked-task",
        state: "blocked",
        source: "plan-task-state",
        independentlyVerified: false,
      },
    ],
  });
  item.tasks.unshift({
    id: "blocked-task",
    role: "analyst",
    state: "blocked",
    error: { code: "MISSING_<INPUT>", message: hostile },
  });
  const ui = await setup({
    respond: (action) =>
      action === "workflow.plan.capabilities"
        ? { available: true, evidenceSummary: true }
        : { item },
  });
  ui.select(item.id);
  await ui.emit("query-form", "submit");
  const html = ui.host.node("result").innerHTML;
  const inline = html.slice(0, html.indexOf("<details>"));
  for (const fact of [
    "任务汇总",
    "引用来源",
    "run-summary",
    "失败或未执行任务",
    "blocked-task",
    "未执行，无运行编号",
    "非文本输出保留",
    "清理完成",
    "证据待核实",
  ])
    assert.ok(inline.includes(fact), fact);
  assert.match(inline, /&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;/);
  assert.match(inline, /MISSING_&lt;INPUT&gt;/);
  assert.doesNotMatch(html, /<img|\[object Object\]/);
});

test("summary status distinguishes pending text, failure and completed work whose cleanup is still pending", async () => {
  for (const state of ["queued", "running", "completed", "blocked", "failed", "cancelled"]) {
    const item = summaryPlan({
      state,
      receipt: { disposed: false, slotReleased: false },
      error:
        state === "blocked"
          ? { code: "SUMMARY_CONTEXT_LIMIT", message: "原样结果超过上下文上限" }
          : undefined,
    });
    const ui = await setup({
      respond: (action) =>
        action === "workflow.plan.capabilities"
          ? { available: true, evidenceSummary: true }
          : { item },
    });
    ui.select(item.id);
    await ui.emit("query-form", "submit");
    const html = ui.host.node("result").innerHTML;
    assert.match(html, /资源清理尚未确认/);
    assert.ok(
      html.includes(
        ["blocked", "failed", "cancelled"].includes(state) ? "未生成汇总文本" : "尚未返回汇总文本",
      ),
    );
    if (state === "blocked") assert.match(html, /SUMMARY_CONTEXT_LIMIT.*原样结果超过上下文上限/);
  }
  const ui = await setup();
  ui.select("legacy-plan");
  await ui.emit("query-form", "submit");
  assert.doesNotMatch(ui.host.node("result").innerHTML, /<h2>任务汇总/);
  assert.match(ui.host.node("result").innerHTML, /legacy-plan/);
});

test("blocked task causes and failed executor stop reasons are visible without opening raw JSON", async () => {
  const item = summaryPlan();
  item.tasks.unshift(
    {
      id: "blocked-task",
      state: "blocked",
      blockedBy: [{ id: "missing-<task>", reason: "missing-<dependency>" }],
    },
    {
      id: "failed-task",
      state: "failed",
      runId: "run-failed",
      receipt: { result: { stopReason: "max-tokens", output: [] } },
    },
  );
  const ui = await setup({
    respond: (action) =>
      action === "workflow.plan.capabilities"
        ? { available: true, evidenceSummary: true }
        : { item },
  });
  ui.select(item.id);
  await ui.emit("query-form", "submit");
  const html = ui.host.node("result").innerHTML.split("<details>")[0];
  assert.match(html, /已阻断/);
  assert.doesNotMatch(html, /依赖阻断/);
  assert.match(html, /依赖任务 missing-&lt;task&gt;：missing-&lt;dependency&gt;/);
  assert.match(html, /结束原因：max-tokens/);
  assert.doesNotMatch(html, /结束原因：completed/);
  assert.doesNotMatch(html, /missing-<task>|missing-<dependency>/);
});

test("a changed plan selection rejects late status/stop results and errors without contaminating the next plan", async () => {
  for (const action of ["workflow.plan.status", "workflow.plan.stop"])
    for (const failure of [false, true]) {
      const pending = deferred();
      const ui = await setup({
        respond(method, payload) {
          if (method === "workflow.plan.capabilities")
            return { available: true, evidenceSummary: true };
          return payload.id === "old-plan"
            ? pending.promise
            : { item: plan(payload.id), stopped: true };
        },
      });
      ui.select("old-plan");
      ui.host.emit(
        action === "workflow.plan.status" ? "query-form" : "stop",
        action === "workflow.plan.status" ? "submit" : "click",
      );
      ui.select("new-plan");
      const before = ui.host.node("result").innerHTML;
      if (failure) pending.reject(new Error("OLD_PLAN_FAILURE"));
      else pending.resolve({ item: plan("old-plan"), stopped: true });
      await ui.flush();
      assert.equal(ui.host.node("result").innerHTML, before);
      assert.doesNotMatch(ui.host.node("feedback").textContent, /OLD_PLAN_FAILURE/);
      assert.equal(ui.errors.length, 0);
      await ui.emit("query-form", "submit");
      assert.match(ui.host.node("result").innerHTML, /new-plan/);
      assert.doesNotMatch(ui.host.node("result").innerHTML, /old-plan/);
    }
});

test("disposal or a detached page prevents late create responses and disables old event listeners", async () => {
  for (const leave of [
    (ui) => ui.view.dispose(),
    (ui) => {
      ui.host.isConnected = false;
    },
  ]) {
    const pending = deferred();
    const ui = await setup({
      respond: (action) =>
        action === "workflow.plan.capabilities"
          ? { available: true, evidenceSummary: true }
          : pending.promise,
    });
    ui.host.emit("create-form", "submit");
    await Promise.resolve();
    assert.equal(ui.calls.at(-1).action, "workflow.plan.create");
    leave(ui);
    const before = ui.host.node("result").innerHTML;
    pending.resolve({ item: summaryPlan() });
    await ui.flush();
    assert.equal(ui.host.node("result").innerHTML, before);
    assert.equal(ui.host.node("id").value, "");
    const count = ui.calls.length;
    await ui.emit("create-form", "submit");
    await ui.emit("query-form", "submit");
    assert.equal(ui.calls.length, count);
  }
});

test("leaving while capability revalidation is pending never creates a plan", async () => {
  const pending = deferred();
  let initial = true;
  const ui = await setup({
    respond(action) {
      assert.equal(action, "workflow.plan.capabilities");
      if (initial) {
        initial = false;
        return { available: true, evidenceSummary: true };
      }
      return pending.promise;
    },
  });
  ui.host.node("summarize").checked = true;
  ui.host.emit("create-form", "submit");
  ui.view.dispose();
  pending.resolve({ available: true, evidenceSummary: true });
  await ui.flush();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.errors.length, 0);
});

test("explicit host and project resource paths pass through the task form and invalid resource types do not submit", async () => {
  for (const origin of ["host", "project"]) {
    const ui = await setup();
    const selected = {
      ...task,
      skills: [
        {
          origin,
          id: "evidence-review",
          resources: ["references/count.md"],
          images: ["assets/diagram.png"],
        },
      ],
    };
    ui.host.node("json").value = JSON.stringify([selected]);
    await ui.emit("create-form", "submit");
    assert.deepEqual(
      ui.calls.find((call) => call.action === "workflow.plan.create").payload.tasks,
      [selected],
    );
    assert.match(ui.view.html, /resources:/);
    assert.match(ui.view.html, /images:/);
  }
  for (const ref of [
    { origin: "unknown", id: "example", resources: ["a.md"] },
    { origin: "project", id: "example", resources: "a.md" },
    { origin: "project", id: "example", images: "a.png" },
    { origin: "host", id: "example", resources: ["a.png"], images: ["a.png"] },
    {
      origin: "host",
      id: "example",
      resources: Array.from({ length: 16 }, (_, i) => `${i}.md`),
      images: ["a.png"],
    },
  ]) {
    const invalid = await setup();
    invalid.host.node("json").value = JSON.stringify([{ ...task, skills: [ref] }]);
    await invalid.emit("create-form", "submit");
    assert.equal(
      invalid.calls.some((call) => call.action === "workflow.plan.create"),
      false,
    );
  }
});
