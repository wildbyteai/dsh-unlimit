const states = {
  queued: "排队中",
  checking: "检查显式依赖",
  starting: "等待启动收据",
  running: "执行中",
  completed: "执行者报告完成",
  failed: "失败",
  blocked: "已阻断",
  cancelled: "已取消",
  "finished-with-errors": "已结束，含失败或未执行任务",
  stopping: "停止中，等待收据处置",
  stopped: "计划已停止",
  "cleanup-pending": "清理未确认，后续启动暂停",
};

/** Page-scoped view: planning is explicit; loading the page starts no model or executor. */
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
    "任务规划与执行",
    `<div id="workflow-plans-module">
    <p class="info">可以直接填写明确任务，也可以描述目标，让规划者根据当前能力目录拆分草稿。可先检查草稿再提交，也可选择规划后直接执行。两种方式都会产生模型调用。</p>
    <div id="workflow-plan-capability" class="${capability.available ? "note" : "error"}" role="status">${esc(capability.available ? "当前可提交显式计划；依赖预检不增加执行授权，执行者结果仍须核实。" : `不能提交计划：${unavailable()}`)}</div>
    ${!capability.available && capability.reasons?.length ? `<details><summary>查看接口诊断详情</summary><p class="info">${esc(capability.reasons.join("；"))}</p></details>` : ""}
    <form id="workflow-plan-create-form">
      <div class="field"><label for="workflow-plan-parent">当前项目已绑定的父会话编号</label><input id="workflow-plan-parent" name="parentSessionId" list="workflow-plan-parents" value="${esc(bound[0]?.id || "")}" autocomplete="off" required><datalist id="workflow-plan-parents">${options}</datalist><small>创建需选当前已绑定会话；不替其他会话提交任务。</small></div>
      <div class="field wide"><label for="workflow-plan-goal">想完成什么</label><textarea id="workflow-plan-goal" rows="3" placeholder="描述目标、允许操作的范围和完成条件；不要填入密钥。"></textarea><small>生成草稿会启动一次规划者。提示要求只规划，但其工具和权限仍由宿主管理，不是无工具沙箱。“生成任务草稿”只规划；“规划并执行目标”会直接启动检查通过的生成任务，沿用下方汇总选项。</small></div>
      <div class="toolbar"><button type="button" id="workflow-plan-propose" ${capability.available && capability.planDrafting ? "" : "disabled"}>生成任务草稿</button><button type="button" id="workflow-plan-run-goal" class="primary" disabled>规划并执行目标</button><button type="button" id="workflow-plan-use-draft" disabled>将当前草稿填入任务表</button></div>
      <div class="field wide"><label for="workflow-plan-json">明确任务 JSON（1–32 项）</label><textarea id="workflow-plan-json" name="tasks" rows="14" spellcheck="false" required>${esc(sample)}</textarea><small>每项填写 id、role、task、requirements，可选 dependsOn、usePreset 和 skills:[{origin,id}]；项目技能可加 resources:["references/checklist.md"]，只随附显式选中的 UTF-8 文本（最多16个，任务总计32KiB），不执行脚本。[] 只表示声明无依赖。示例没有附带真实材料，请先改为当前项目的明确任务；不要填入密钥。</small></div>
      <div class="field wide"><label><input type="checkbox" id="workflow-plan-summarize" name="summarize" ${capability.available && capability.evidenceSummary === true ? "" : "disabled"}> 任务结束后生成指挥汇总</label><small>使用当前项目的规划者角色，增加一次模型调用；引用任务结果与失败、未执行状态，不会自动核实事实。</small><small id="workflow-plan-summary-availability">${capability.evidenceSummary === true ? "" : "当前服务不支持指挥汇总。"}</small></div>
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
    busy = false,
    selectionRevision = 0,
    loadedProposal = null;
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
          (key) =>
            !["id", "role", "task", "requirements", "dependsOn", "usePreset", "skills"].includes(
              key,
            ),
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
      if (
        task.skills !== undefined &&
        (!Array.isArray(task.skills) ||
          task.skills.some(
            (ref) =>
              !ref ||
              !["host", "project"].includes(ref.origin) ||
              typeof ref.id !== "string" ||
              !ref.id.trim() ||
              Object.keys(ref).some((key) => !["origin", "id", "resources"].includes(key)) ||
              (ref.resources !== undefined &&
                (ref.origin !== "project" ||
                  !Array.isArray(ref.resources) ||
                  ref.resources.length > 16 ||
                  ref.resources.some((path) => typeof path !== "string" || !path.trim()))),
          ))
      )
        throw new Error(
          "skills 须为准确的 {origin,id} 引用；仅项目技能可选 resources 路径数组，不允许覆盖依赖声明",
        );
      if (task.usePreset !== undefined && typeof task.usePreset !== "boolean")
        throw new Error("usePreset 须为布尔值");
    }
    return tasks;
  }
  function bind(root = document) {
    const module = root.querySelector("#workflow-plans-module");
    if (!module) return;
    const attached = () => !disposed && module.isConnected !== false;
    const get = (id) => module.querySelector(`#workflow-plan-${id}`);
    const feedback = (message, error = false) => {
      if (!attached()) return;
      get("feedback").className = error ? "error" : "note";
      get("feedback").textContent = message;
    };
    function buttons() {
      if (!attached()) return;
      const selected = bound.some((session) => session.id === get("parent").value.trim());
      get("create").disabled = busy || !capability.available || !selected || roles.length === 0;
      get("propose").disabled =
        busy ||
        !capability.available ||
        !capability.planDrafting ||
        !selected ||
        !roleIds.has("planner");
      get("run-goal").disabled =
        busy ||
        !capability.available ||
        !capability.automaticTaskMatching ||
        !selected ||
        !roleIds.has("planner");
      get("use-draft").disabled = busy || !loadedProposal;
      get("create").title = !capability.available
        ? unavailable()
        : !selected
          ? "请先选择已绑定当前项目的父会话"
          : "";
      for (const id of ["refresh", "stop", "copy", "check"]) get(id).disabled = busy;
      get("summarize").disabled =
        busy || !capability.available || capability.evidenceSummary !== true;
      if (capability.evidenceSummary !== true) get("summarize").checked = false;
      get("summary-availability").textContent =
        capability.evidenceSummary === true ? "" : "当前服务不支持指挥汇总。";
    }
    function diagnostic(task) {
      const error = task.error || task.receipt?.error;
      const stopReason = task.receipt?.result?.stopReason;
      return [
        error ? [error.code, error.message].filter(Boolean).join("：") : "",
        ...(task.blockedBy ?? []).map(
          (source) => `依赖任务 ${source.id}：${states[source.reason] || source.reason}`,
        ),
        stopReason && stopReason !== "completed" ? `结束原因：${stopReason}` : "",
      ]
        .filter(Boolean)
        .join("；");
    }
    function summary(item) {
      const task = item.tasks.find(
        (task) => task.id === item.summaryTaskId || task.kind === "summary",
      );
      if (!task) return "";
      const output = task.receipt?.result?.output ?? [];
      const texts = output.filter((block) => block.type === "text").map((block) => block.text);
      const nonText = output.some((block) => block.type !== "text");
      const error = diagnostic(task);
      const cleanup = !task.runId
        ? "尚未取得运行收据。"
        : task.receipt?.disposed === true && task.receipt?.slotReleased === true
          ? "清理完成，执行名额已释放。"
          : "资源清理尚未确认，执行名额可能仍被占用。";
      const sources = (task.sources ?? []).map((source) => ({
        taskId: source.taskId,
        runId: source.runId || "无运行编号",
        state: `${states[source.state] || source.state} (${source.state})`,
        source:
          {
            "workflow-receipt": "任务结果（证据待核实）",
            "plan-task-state": "任务状态（证据待核实）",
          }[source.source] || source.source,
      }));
      const incomplete = item.tasks
        .filter(
          (current) =>
            current !== task && ["failed", "blocked", "cancelled"].includes(current.state),
        )
        .map((current) => ({
          taskId: current.id,
          runId: current.runId || "未执行，无运行编号",
          state: `${states[current.state] || current.state} (${current.state})`,
          error: diagnostic(current) || "—",
        }));
      return panel(
        "任务汇总",
        `<p><span class="tag">${esc(states[task.state] || task.state)}</span> <span class="mono">${esc(task.id)}</span></p><p class="info">汇总引用以下任务结果，证据待核实。${esc(cleanup)}</p>${task.runId ? `<p class="meta">汇总运行编号：${esc(task.runId)}</p>` : ""}${error ? `<p class="error">${esc(error)}</p>` : ""}${texts.length ? `<pre class="report" style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(texts.join("\n"))}</pre>` : `<p class="info">${["failed", "blocked", "cancelled"].includes(task.state) ? "未生成汇总文本，请查看任务状态与诊断。" : "尚未返回汇总文本。"}</p>`}${nonText ? '<p class="info">非文本输出保留在下方完整计划的原始收据中，此处不转换展示。</p>' : ""}<h3>引用来源</h3>${
          sources.length
            ? table(sources, [
                ["taskId", "任务编号"],
                ["runId", "运行编号"],
                ["state", "任务状态"],
                ["source", "来源与核实状态"],
              ])
            : '<p class="info">尚无引用来源；汇总尚未取得任务结果。</p>'
        }${
          incomplete.length
            ? `<h3>失败或未执行任务</h3>${table(incomplete, [
                ["taskId", "任务编号"],
                ["runId", "运行编号"],
                ["state", "状态"],
                ["error", "诊断"],
              ])}`
            : ""
        }`,
      );
    }
    function show(item) {
      if (!attached()) return;
      const proposal = item.proposal;
      const proposalTasks = proposal?.state === "ready" ? proposal.tasks : null;
      loadedProposal = proposal?.execute ? null : proposalTasks;
      const proposalView = !proposal
        ? ""
        : panel(
            proposal.execute ? "自动执行计划" : "生成的任务草稿",
            `<p class="info">${esc({ pending: "正在生成，请读取状态。", ready: proposal.execute ? "生成任务已通过结构与目录名称检查，已进入本计划队列。实际启动、失败与结果以逐任务收据为准；不要重复提交。" : "草稿格式与目录名称已检查；任务范围和模型判断仍需检查。尚未启动这些任务。", invalid: "模型输出未通过检查，未生成可提交草稿。", failed: "规划者未完成，未生成可提交草稿。", cancelled: "草稿生成已取消。" }[proposal.state] ?? proposal.state)}</p>${proposal.error ? `<p class="error">${esc(proposal.error.message)}</p>` : ""}${
              proposalTasks
                ? table(
                    proposalTasks.map((task) => ({
                      ...task,
                      requirements:
                        task.requirements.map((item) => `${item.kind}: ${item.name}`).join("；") ||
                        "未声明",
                      dependsOn: task.dependsOn.join("、") || "无",
                      skills:
                        (task.skills ?? [])
                          .map(
                            (ref) =>
                              `${ref.origin}/${ref.id}${ref.resources?.length ? ` [${ref.resources.join(", ")}]` : ""}`,
                          )
                          .join("；") || "未选择",
                    })),
                    [
                      ["id", "任务"],
                      ["role", "角色"],
                      ["task", "内容与完成条件"],
                      ["requirements", "匹配能力"],
                      ["skills", "技能正文来源"],
                      ["dependsOn", "前置任务"],
                    ],
                  )
                : ""
            }`,
          );
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
        )}${proposalView}${summary(item)}<details><summary>完整计划、逐任务回执与原样结果（未验证）</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto">${esc(JSON.stringify(item, null, 2))}</pre></details>`;
    }
    const scope = () => {
      const id = get("id").value.trim(),
        parentSessionId = get("query-parent").value.trim();
      if (!id || !parentSessionId) throw new Error("请填写计划编号和原父会话编号");
      return { workspaceId, parentSessionId, id };
    };
    const execute = (fn) => {
      if (busy || !attached()) return;
      const revision = selectionRevision;
      const current = () => attached() && revision === selectionRevision;
      run(null, async () => {
        busy = true;
        buttons();
        try {
          await fn(current);
        } catch (error) {
          if (!current()) return;
          feedback(error.message, true);
          throw error;
        } finally {
          busy = false;
          buttons();
        }
      });
    };
    for (const id of ["parent", "query-parent", "id"])
      get(id).addEventListener(
        "input",
        () => {
          selectionRevision++;
          loadedProposal = null;
          buttons();
        },
        { signal: listeners.signal },
      );
    for (const [button, action] of [
      ["propose", "workflow.plan.propose"],
      ["run-goal", "workflow.plan.run"],
    ])
      get(button).addEventListener(
        "click",
        () =>
          execute(async (current) => {
            const automatic = action === "workflow.plan.run";
            const goal = get("goal").value.trim(),
              parentSessionId = get("parent").value.trim(),
              summarize = automatic && get("summarize").checked;
            if (!goal) throw new Error("请先描述目标、允许范围和完成条件");
            if (!bound.some((session) => session.id === parentSessionId))
              throw new Error("父会话必须已绑定当前项目");
            capability = await api("workflow.plan.capabilities", { workspaceId });
            if (!current()) return;
            if (
              !capability.available ||
              !(automatic ? capability.automaticTaskMatching : capability.planDrafting)
            )
              throw new Error("当前服务不支持所选规划方式");
            if (summarize && capability.evidenceSummary !== true)
              throw new Error("当前服务不支持指挥汇总");
            const { item } = await api(action, {
              workspaceId,
              parentSessionId,
              goal,
              ...(summarize ? { summarize: true } : {}),
            });
            if (!current()) return;
            get("id").value = item.id;
            get("query-parent").value = parentSessionId;
            show(item);
            feedback(
              automatic
                ? "自动执行目标已登记；规划通过检查后会直接分派任务。可读取状态或停止本计划。"
                : "规划请求已登记，请读取状态；生成的任务不会自动执行。",
            );
          }),
        { signal: listeners.signal },
      );
    get("use-draft").addEventListener(
      "click",
      () => {
        if (busy || !loadedProposal || !attached()) return;
        get("json").value = JSON.stringify(loadedProposal, null, 2);
        feedback("草稿已填入任务表。请检查目标范围、角色和能力，再提交明确计划。");
      },
      { signal: listeners.signal },
    );
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
        execute(async (current) => {
          const tasks = parse(get("json").value),
            parentSessionId = get("parent").value.trim(),
            summarize = get("summarize").checked;
          if (!bound.some((session) => session.id === parentSessionId))
            throw new Error("父会话必须已绑定当前项目");
          const latestCapability = await api("workflow.plan.capabilities", { workspaceId });
          if (!current()) return;
          capability = latestCapability;
          if (!capability.available) throw new Error(`当前不能创建计划：${unavailable()}`);
          if (summarize && capability.evidenceSummary !== true)
            throw new Error("当前服务不支持指挥汇总，请重新核对计划选项。");
          const { item } = await api("workflow.plan.create", {
            workspaceId,
            parentSessionId,
            tasks,
            ...(summarize ? { summarize: true } : {}),
          });
          if (!current()) return;
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
        execute(async (current) => {
          const target = scope();
          const { item } = await api("workflow.plan.status", target);
          if (!current()) return;
          if (item.id !== target.id) throw new Error("状态响应与所选计划编号不一致，请重新读取。");
          show(item);
          feedback(`已读回当前计划状态：${states[item.state] || item.state}。`);
        });
      },
      { signal: listeners.signal },
    );
    get("stop").addEventListener(
      "click",
      () =>
        execute(async (current) => {
          const target = scope();
          const result = await api("workflow.plan.stop", target);
          if (!current()) return;
          if (result.item.id !== target.id)
            throw new Error("停止响应与所选计划编号不一致，请重新读取。");
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
        execute(async (current) => {
          const id = get("id").value.trim();
          if (!id) throw new Error("请先填写或创建计划编号");
          try {
            await navigator.clipboard.writeText(id);
            if (current()) toast("计划编号已复制");
          } catch {
            if (current()) {
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
      selectionRevision++;
      listeners.abort();
    },
  };
}

export default workflowPlans;
