const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

const promptHistoryNotice =
  "卸载不会批量恢复旧会话中的提示词。恢复依赖插件仍已加载，并在该会话下一次正常请求前执行；卸载后旧会话可能保留原正文，建议新建会话。本操作不会自动发送消息。";
const terminalPermissionNotice =
  "卸载前请关闭已有持久终端。还原权限接口不会收回这些终端的启动权限，它们仍可能保留全访问；在终端执行 exit 或通过宿主关闭后，新终端才使用恢复后的权限。";

export function terminalStatusSection(status) {
  if (status?.available !== true)
    return `<p class="info" role="status">${esc(status?.detail || "未返回终端检查结果，不能确认是否仍有终端运行。")}</p>`;
  const rows = status.terminals
    .map(
      (row) =>
        `<tr><td>${esc(row.agentId)}</td><td>${esc(row.terminalId)}</td><td>${row.state === "running" ? "运行中" : "进程已退出，注册待清理"}</td><td>未知</td><td>未确认</td></tr>`,
    )
    .join("");
  return `<p class="info">已检查 ${esc(status.scannedAgents)} 个活动会话。${esc(status.detail)}</p>${rows ? `<div class="tablewrap"><table><thead><tr><th>所属会话</th><th>终端</th><th>运行状态</th><th>启动权限</th><th>由本插件升权</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="info">此次检查没有发现已发布的终端注册。</p>'}${status.pendingOwners.length ? `<div class="note">以下会话仍有未发布的终端活动，不能视为已清理：${status.pendingOwners.map(esc).join("、")}</div>` : ""}`;
}

export const uninstallConfirmation =
  "确认卸载 dsh-unlimit？将先撤销本插件的运行控制与演练确认，停止所属任务和探测，再由宿主官方插件管理器卸载本插件。规则、技能、材料、数据库及无关文件保留。当前面板未保存的草稿会丢失。不会自动重启宿主；如需重启，由你稍后操作。" +
  promptHistoryNotice +
  terminalPermissionNotice;

export function uninstallSection(info) {
  const available = info?.available === true;
  return `<p class="info">先撤销运行控制与演练确认、停止所属任务和探测，再由官方插件管理器卸载。保留规则、技能、材料、数据库及无关文件，不自动重启宿主。</p><div class="note">${promptHistoryNotice}</div><div class="note">${terminalPermissionNotice}</div><button type="button" class="danger" id="uninstall-plugin" ${available ? "" : "disabled"}>卸载本插件（保留资料）</button><p class="info" role="status">${esc(info?.detail || "当前接口未提供卸载能力，请使用宿主插件管理器。")}</p>`;
}

export function renderReceipt({ receipt, error }) {
  const successful =
    !error &&
    receipt?.removed === true &&
    ["applied", "restart-required"].includes(receipt.application);
  const row = (label, value) =>
    `<div class="twocoltext"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const yesNo = (value) => (value === true ? "是" : value === false ? "否" : "未返回");
  const prepared = receipt?.prepared;
  const history = prepared?.promptHistory;
  const historyStatus =
    history?.status === "not-restored" && history.scanned === false
      ? "未批量恢复（未扫描历史会话）"
      : "未返回恢复证据";
  const steps = {
    settings: "撤销运行配置",
    admission: "撤销演练确认",
    plans: "停止所属计划",
    workflow: "停止所属执行任务",
    presets: "停止预设任务",
    controls: "还原运行控制",
    probes: "停止所属探测",
    checks: "停止连接检查",
  };
  const returnedSteps = Array.isArray(prepared?.steps) ? prepared.steps : [];
  const preparation = prepared
    ? `<div class="note"><strong>已返回的清理事实</strong>${row("运行控制已禁用", yesNo(prepared.controlsDisabled))}${row("演练确认已撤销", yesNo(prepared.admissionRevoked))}${returnedSteps.map((step) => row(steps[step?.id] || step?.id, step?.status === "completed" ? "已完成" : step?.status === "failed" ? "失败" : "未确认")).join("")}</div>`
    : '<p class="info">未返回清理回执，不能据此确认运行控制或任务已清理。</p>';
  return `<section class="panel"><div class="panelheading"><h2>${successful ? "本插件已卸载" : "卸载未确认完成"}</h2><span class="tag ${successful ? "gray" : "orange"}">只读回执</span></div>${error ? `<div class="error" role="alert">${esc(error.message || "卸载未返回可确认的结果")}${error.code ? ` [${esc(error.code)}]` : ""}</div>` : ""}${row("插件", receipt?.bundle || "dsh-unlimit")}${row("安装包已移除", yesNo(receipt?.removed))}${receipt?.installationPresent !== undefined ? row("安装记录仍存在", yesNo(receipt.installationPresent)) : ""}${receipt?.managerCalled !== undefined ? row("已调用官方移除", yesNo(receipt.managerCalled)) : ""}${row("官方管理器发生变更", yesNo(receipt?.changed))}${row("官方应用结果", receipt?.application || "未返回")}${row("本地资料", (receipt?.data || prepared?.data) === "preserved" ? "保留" : "未返回确认")}${preparation}${row("历史会话提示词", historyStatus)}<div class="note">${promptHistoryNotice}</div><div class="note">${terminalPermissionNotice}</div><p class="info">${successful ? "请回到宿主插件管理器确认卸载状态。" : "请回到宿主插件管理器核对安装与运行状态；本面板未自动重试，也不再读取插件数据。"}</p>${receipt?.restartRequired === true ? '<div class="note">官方管理器提示需要重启。请保存宿主中的工作，稍后自行重启宿主。</div>' : ""}<p class="info">本面板不会自动重启宿主。</p></section>`;
}

/** One explicit attempt; never retry a removal whose result may be unknown. */
export function uninstallFlow({ api, confirm, pending, outcome }) {
  let busy = false;
  let finished = false;
  return async () => {
    if (busy || finished) return;
    busy = true;
    try {
      if (!(await confirm(uninstallConfirmation))) return;
      pending();
      let result;
      try {
        const receipt = await api("maintenance.uninstall", {
          bundle: "dsh-unlimit",
          confirmed: true,
        });
        if (
          receipt?.bundle !== "dsh-unlimit" ||
          receipt.removed !== true ||
          !["applied", "restart-required"].includes(receipt.application)
        )
          throw Object.assign(new Error("返回结果不能确认卸载完成，请在宿主插件管理器核对。"), {
            code: "UNINSTALL_UNKNOWN",
            partial: receipt,
          });
        result = { receipt };
      } catch (error) {
        result = { receipt: error.partial, error };
      }
      finished = true;
      outcome(result);
    } finally {
      busy = false;
    }
  };
}
