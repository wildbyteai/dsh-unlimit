const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

export const rewindNotice =
  "将创建新分支，保留并归档原会话，清空新分支继承的待处理输入，再恢复未发送的草稿。仅将保留任务中在被切除的同一轮内完成的任务恢复为待开始，原会话的任务不变。子代理按可核验的创建来源回到主会话对应轮次或步骤，该切点之后的事件一并撤回；也可选择最近接纳的输入，需启用运行控制时留下的父调用关联记录。旧日志或来源不明的输入不作推断。";

export function rewindSummary(outcome) {
  if (!outcome) return "";
  const archived = outcome.archived ? "原记录已保留并归档。" : "原会话归档未确认。";
  const hostPartial = outcome.draftStatus === "host-partial" || outcome.failedAt === "reset-todos";
  const restored = !hostPartial && outcome.draftStatus === "restored";
  const textRestored = outcome.textStatus === "restored" || restored;
  const title = hostPartial
    ? "宿主回退尚未完成"
    : restored
      ? "回退分支已创建，草稿已恢复到新会话"
      : outcome.draftStatus === "partial"
        ? "文字已恢复，附件恢复未完成"
        : outcome.draftStatus === "pending-client"
          ? "新会话已创建，草稿恢复待确认"
          : "新会话已创建，草稿未恢复";
  const navigation =
    outcome.openStatus === "requested"
      ? "已向宿主请求打开新会话；可见页面切换尚无完成回执。"
      : outcome.openStatus === "failed"
        ? "打开新会话失败，可在宿主中按编号查找。"
        : "";
  const attachmentLabels = {
    "not-required": "无附件",
    pending: "待处理",
    reading: "读取中",
    staged: "已重建草稿",
    restored: "已加入输入框",
    failed: "未完成",
    cancelled: "已取消",
  };
  const uploadLabels = {
    "not-required": "无需上传",
    "not-requested": "未开始",
    uploading: "上传中",
    ready: "上传已就绪",
    failed: "未完成",
    cancelled: "已取消",
  };
  const attachmentInfo = outcome.attachmentBatch
    ? ` 附件：${attachmentLabels[outcome.attachmentStatus] || "未确认"}；文件上传：${uploadLabels[outcome.uploadStatus] || "未确认"}。`
    : "";
  const mapping = ["creation", "recorded-input"].includes(outcome.mapping?.basis)
    ? `<p>${outcome.mapping.basis === "creation" ? "按子代理创建来源定位" : "按子代理输入关联记录定位"}：<span class="mono">${escape(outcome.mapping.requestedSessionId)}</span> → 主会话 <span class="mono">${escape(outcome.mapping.targetSessionId)}</span>。${outcome.atSeq === undefined ? "回到首轮前的空白分支。" : `保留到事件 ${escape(outcome.atSeq)}，之后的事件一并撤回。`}</p>`
    : "";
  const queue = outcome.newSessionStop?.requested
    ? outcome.newSessionStop.settledIds?.includes(outcome.newSessionId) &&
      outcome.newSessionStop.pendingIds?.length === 0
      ? "新分支待处理输入已清空。"
      : "新分支待处理输入清理未确认。"
    : "";
  const todos = outcome.todoReset
    ? outcome.todoReset.verified === true
      ? `新分支有 ${escape(outcome.todoReset.resetCount)} 项待办已恢复为待开始。`
      : "待办恢复未确认，请检查新分支。"
    : "";
  return `<div class="${restored ? "note" : "error"}"><strong>${title}</strong><br>${archived}${outcome.newSessionId ? `新会话：<span class="mono">${escape(outcome.newSessionId)}</span>` : ""}${mapping}<br>${queue}${todos}${textRestored ? "文字草稿已恢复，没有自动发送。" : ""}${escape(attachmentInfo)}${escape(navigation)}${outcome.error ? escape(outcome.error) : restored ? "" : "等待宿主恢复草稿。"}</div>`;
}
