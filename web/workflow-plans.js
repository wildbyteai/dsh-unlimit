const states = {
  queued: "排队中",
  checking: "检查显式依赖",
  starting: "等待启动收据",
  running: "执行中",
  completed: "执行者报告完成",
  failed: "失败",
  blocked: "依赖阻断",
  cancelled: "已取消",
  "finished-with-errors": "已结束，含失败或未执行任务",
  stopping: "停止中，等待收据处置",
  stopped: "计划已停止",
  "cleanup-pending": "清理未确认，后续启动暂停",
};

/** Page-scoped view only: no persistent state, model planning or automatic execution on load. */
export async function workflowPlans({
  api,
  esc,
  panel,
  table,
  empty,
  toast,
  run,
  workspaceId,
  sessions = [],
  roles = [],
}) {
  let capability;
  try {
    capability = await api("workflow.plan.capabilities", { workspaceId });
  } catch (error) {
    capability = { available: false, reasons: [error.message] };
  }
  const bound = sessions.filter((session) => session.workspaceId === workspaceId);
  const roleIds = new Set(roles.map((role) => role.role));
  const defaultRole = roleIds.has("analyst") ? "analyst" : roles[0]?.role || "analyst";
  const sample = JSON.stringify(
    [
      {
        id: "evidence-a",
        role: defaultRole,
        task: "仅整理本任务已提供的合成证据清单 A，列出文件名、证据出处和未验证项；未提供正文时如实说明缺失。",
        requirements: [],
        dependsOn: [],
      },
      {
        id: "evidence-b",
        role: defaultRole,
        task: "仅整理本任务已提供的合成证据清单 B，列出记录数量和证据出处；不把不存在的材料补成事实。",
        requirements: [],
        dependsOn: ["evidence-a"],
      },
    ],
    null,
    2,
  );
  const unavailable = () =>
    capability.available ? "" : "当前未检测到适配的桌面执行服务，请核对宿主版本与执行服务状态。";
  const options = bound
    .map(
      (session) =>
        `<option value="${esc(session.id)}" label="${esc(session.name || session.id)}"></option>`,
    )
    .join("");
  const html = panel(
    "明确任务计划",
    `<div id="workflow-plans-module">
    <p class="info">由你或指挥模型提供已拆好的任务。这里只负责按项目槽位排队、依赖检查和收据汇总，不会自动拆解任务或匹配工具。提交后可能产生实际子代理模型调用。</p>
    <div id="workflow-plan-capability" class="${capability.available ? "note" : "error"}" role="status">${esc(capability.available ? "当前可提交显式计划；依赖预检不增加执行授权，执行者结果仍须核实。" : `不能提交计划：${unavailable()}`)}</div>
    ${!capability.available && capability.reasons?.length ? `<details><summary>查看接口诊断详情</summary><p class="info">${esc(capability.reasons.join("；"))}</p></details>` : ""}
    <form id="workflow-plan-create-form">
      <div class="field"><label for="workflow-plan-parent">当前项目已绑定的父会话编号</label><input id="workflow-plan-parent" name="parentSessionId" list="workflow-plan-parents" value="${esc(bound[0]?.id || "")}" autocomplete="off" required><datalist id="workflow-plan-parents">${options}</datalist><small>创建需选当前已绑定会话；不替其他会话提交任务。</small></div>
      <div class="field wide"><label for="workflow-plan-json">明确任务 JSON（1–32 项）</label><textarea id="workflow-plan-json" name="tasks" rows="14" spellcheck="false" required>${esc(sample)}</textarea><small>每项填写 id、role、task、requirements，可选 dependsOn 与 usePreset。[] 只表示声明无依赖。示例没有附带真实材料，请先改为当前项目的明确任务；不要填入密钥。</small></div>
      <div class="toolbar"><button type="button" id="workflow-plan-check">检查 JSON</button><button type="submit" class="primary" id="workflow-plan-create" ${capability.available && bound.length ? "" : "disabled"}>提交明确计划</button></div>
    </form>
    <form id="workflow-plan-query-form">
      <div class="field"><label for="workflow-plan-query-parent">计划原父会话编号</label><input id="workflow-plan-query-parent" name="parentSessionId" list="workflow-plan-parents" value="${esc(bound[0]?.id || "")}" autocomplete="off" required><small>原父会话离线或改绑后，仍可用原编号读取、停止自己在本项目的计划。</small></div>
      <div class="field"><label for="workflow-plan-id">计划编号</label><input id="workflow-plan-id" name="planId" autocomplete="off" required></div>
      <div class="toolbar"><button type="submit" id="workflow-plan-refresh">读取真实状态</button><button type="button" id="workflow-plan-copy">复制编号</button><button type="button" class="danger" id="workflow-plan-stop">停止本计划</button></div>
    </form>
    <div id="workflow-plan-feedback" role="status" aria-live="polite"></div>
    <div id="workflow-plan-result">${empty("尚未读取计划", "输入计划编号和原父会话编号；只读取当前项目，不在浏览器存储或 URL 保存计划。")}</div>
  </div>`,
  );
  let disposed = false,
    busy = false;
  const listeners = new AbortController();
  function parse(value) {
    if (new TextEncoder().encode(value).length > 1024 * 1024)
      throw new Error("任务 JSON 超过 1 MiB，请缩小明确任务");
    let tasks;
    try {
      tasks = JSON.parse(value);
    } catch {
      throw new Error("任务 JSON 格式无效，请检查逗号、引号和括号");
    }
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 32)
      throw new Error("任务 JSON 须为 1–32 项数组");
    const ids = new Set();
    for (const task of tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task))
        throw new Error("每个任务须为对象");
      if (
        Object.keys(task).some(
          (key) => !["id", "role", "task", "requirements", "dependsOn", "usePreset"].includes(key),
        )
      )
        throw new Error("任务包含未知字段；不会执行额外命令选项");
      if (typeof task.id !== "string" || !task.id.trim() || ids.has(task.id))
        throw new Error("任务 id 必须填写且不能重复");
      ids.add(task.id);
      if (!roleIds.has(task.role))
        throw new Error(`角色未在当前项目登记：${task.role || "未填写"}`);
      if (typeof task.task !== "string" || !task.task.trim())
        throw new Error("每个任务须填写明确 task 正文");
      if (!Array.isArray(task.requirements))
        throw new Error("每个任务须显式填写 requirements 数组，无依赖时填写 []");
      if (
        task.dependsOn !== undefined &&
        (!Array.isArray(task.dependsOn) ||
          task.dependsOn.some((id) => typeof id !== "string" || !id.trim()))
      )
        throw new Error("dependsOn 须为任务编号数组");
      if (task.usePreset !== undefined && typeof task.usePreset !== "boolean")
        throw new Error("usePreset 须为布尔值");
    }
    return tasks;
  }
  function bind(root = document) {
    const module = root.querySelector("#workflow-plans-module");
    if (!module) return;
    const get = (id) => module.querySelector(`#workflow-plan-${id}`);
    const feedback = (message, error = false) => {
      if (disposed) return;
      get("feedback").className = error ? "error" : "note";
      get("feedback").textContent = message;
    };
    function buttons() {
      if (disposed) return;
      const selected = bound.some((session) => session.id === get("parent").value.trim());
      get("create").disabled = busy || !capability.available || !selected || roles.length === 0;
      get("create").title = !capability.available
        ? unavailable()
        : !selected
          ? "请先选择已绑定当前项目的父会话"
          : "";
      for (const id of ["refresh", "stop", "copy", "check"]) get(id).disabled = busy;
    }
    function show(item) {
      if (disposed) return;
      const rows = item.tasks.map((task) => ({
        id: task.id,
        role: task.role,
        stateLabel: `${states[task.state] || task.state} (${task.state})`,
        execution: task.receipt?.startedAt
          ? "已取得启动收据"
          : task.runId
            ? "仅有运行记录，检查收据"
            : "未取得运行记录",
        cleanup: task.runId
          ? `处置 ${task.receipt?.disposed === true ? "已确认" : "未确认"}；槽位 ${task.receipt?.slotReleased === true ? "已释放" : "仍占用"}`
          : "尚无自有收据",
      }));
      get("result").innerHTML =
        `<div class="toolbar"><span class="tag">${esc(states[item.state] || item.state)}</span><span class="meta">${esc(item.id)}</span></div><p class="info">结果来自执行者收据，未独立核实；完成状态不等于事实核验。逐任务记录包含未执行、缺依赖、错误和清理状态。</p>${table(
          rows,
          [
            ["id", "任务"],
            ["role", "角色"],
            ["stateLabel", "状态"],
            ["execution", "实际启动"],
            ["cleanup", "清理与槽位"],
          ],
        )}<details><summary>完整计划、逐任务回执与原样结果（未验证）</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto">${esc(JSON.stringify(item, null, 2))}</pre></details>`;
    }
    const scope = () => {
      const id = get("id").value.trim(),
        parentSessionId = get("query-parent").value.trim();
      if (!id || !parentSessionId) throw new Error("请填写计划编号和原父会话编号");
      return { workspaceId, parentSessionId, id };
    };
    const execute = (fn) => {
      if (busy || disposed) return;
      run(null, async () => {
        busy = true;
        buttons();
        try {
          await fn();
        } catch (error) {
          feedback(error.message, true);
          throw error;
        } finally {
          busy = false;
          buttons();
        }
      });
    };
    get("parent").addEventListener("input", buttons, { signal: listeners.signal });
    get("check").addEventListener(
      "click",
      () => {
        try {
          const tasks = parse(get("json").value);
          feedback(
            `本地 JSON 检查通过，共 ${tasks.length} 项；未启动执行者，依赖与准入仍由服务端检查。`,
          );
        } catch (error) {
          feedback(error.message, true);
        }
      },
      { signal: listeners.signal },
    );
    get("create-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        execute(async () => {
          const tasks = parse(get("json").value),
            parentSessionId = get("parent").value.trim();
          if (!bound.some((session) => session.id === parentSessionId))
            throw new Error("父会话必须已绑定当前项目");
          capability = await api("workflow.plan.capabilities", { workspaceId });
          if (!capability.available) throw new Error(`当前不能创建计划：${unavailable()}`);
          if (disposed) return;
          const { item } = await api("workflow.plan.create", {
            workspaceId,
            parentSessionId,
            tasks,
          });
          if (disposed) return;
          get("id").value = item.id;
          get("query-parent").value = parentSessionId;
          show(item);
          feedback(
            `计划登记已读回：${item.id}；当前 ${states[item.state] || item.state}。请读取状态检查实际启动和收据。`,
          );
          get("create-form").dispatchEvent(
            new CustomEvent("workflow-plan:saved", { bubbles: true }),
          );
        });
      },
      { signal: listeners.signal },
    );
    get("query-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        execute(async () => {
          const { item } = await api("workflow.plan.status", scope());
          show(item);
          feedback(`已读回当前计划状态：${states[item.state] || item.state}。`);
        });
      },
      { signal: listeners.signal },
    );
    get("stop").addEventListener(
      "click",
      () =>
        execute(async () => {
          const result = await api("workflow.plan.stop", scope());
          show(result.item);
          feedback(
            result.stopped
              ? "本计划停止已确认；请核对各任务真实结果。"
              : "停止未完全确认，仍可能占用槽位；已保留真实回执，可再次显式停止。",
            !result.stopped,
          );
        }),
      { signal: listeners.signal },
    );
    get("copy").addEventListener(
      "click",
      () =>
        execute(async () => {
          const id = get("id").value.trim();
          if (!id) throw new Error("请先填写或创建计划编号");
          try {
            await navigator.clipboard.writeText(id);
            if (!disposed) toast("计划编号已复制");
          } catch {
            if (!disposed) {
              get("id").focus();
              get("id").select();
              feedback("浏览器未提供剪贴板写入，已选中编号，请手动复制。");
            }
          }
        }),
      { signal: listeners.signal },
    );
    buttons();
  }
  return {
    html,
    bind,
    dispose() {
      disposed = true;
      listeners.abort();
    },
  };
}

export default workflowPlans;
