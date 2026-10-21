let instance = 0;

/** Captures one workspace; this panel never launches a process or reads global app state. */
export async function processMonitor({ api, workspaceId, esc, panel, empty, run, toast }) {
  const scope = workspaceId;
  const id = `process-monitor-${++instance}`;
  let items = null;
  let error = "";
  let notice = "";
  let selected = null;
  let output = null;
  let confirmation = null;
  let refreshing = false;
  let reading = null;
  let stopping = null;
  let readSequence = 0;
  let metadataRevision = 0;
  let disposed = false;
  let host = null;
  let listeners = null;
  const message = (failure) => String(failure?.message || "操作失败，请手动刷新后重试。");
  const active = (item) =>
    ["preparing", "running", "settling", "stopping", "cleanup-pending"].includes(item.status);
  const statusText = (status) =>
    ({
      preparing: "准备中",
      running: "运行中",
      settling: "正在收尾",
      stopping: "停止中",
      stopped: "已停止",
      exited: "已退出",
      failed: "失败",
      denied: "启动被拒绝",
      "timed-out": "已超时",
      "cleanup-pending": "清理尚未确认",
    })[status] || status;
  const validItem = (item) =>
    item && typeof item.id === "string" && item.id.length > 0 && typeof item.status === "string";
  function adoptItem(item, expected) {
    if (!validItem(item) || item.id !== expected)
      throw new Error("进程响应与所选记录不匹配，请刷新列表。");
    items = items.map((current) => (current.id === expected ? item : current));
  }
  async function list() {
    const result = await api("processes.list", { workspaceId: scope });
    if (disposed) return;
    if (!Array.isArray(result?.items) || !result.items.every(validItem))
      throw new Error("进程列表响应无效，请手动刷新。");
    items = result.items;
    metadataRevision++;
  }
  if (scope) {
    try {
      await list();
    } catch (failure) {
      error = `读取进程列表失败：${message(failure)}`;
    }
  }
  function detail(item) {
    return `<div class="mono">${esc(item.id)}</div><strong>${esc(item.tool)}</strong><div>参数 <span class="mono">${esc(JSON.stringify(item.args ?? []))}</span></div><div>目录 <span class="mono">${esc(item.cwd)}</span></div><div>模式 ${esc(item.mode)} · 会话 <span class="mono">${esc(item.sessionId || "—")}</span></div>`;
  }
  function outputPane() {
    if (!selected) return "";
    const item = items?.find((current) => current.id === selected);
    if (!item) return "";
    const stream = (name, value) =>
      `<h3>${name}</h3>${value.lossy ? '<p class="info">输出已截断或部分内容已丢失；以下只显示当前保留的片段。</p>' : ""}<pre class="report">${esc(value.text || "（无输出）")}</pre><small>下次偏移 ${esc(value.nextOffset)}</small>`;
    return panel(
      "进程输出",
      `<p class="mono">${esc(selected)}</p><button type="button" class="small" data-process-action="output" data-process-index="${items.indexOf(item)}" ${reading === selected ? "disabled" : ""}>手动刷新输出</button>${reading === selected ? '<p class="info" role="status">正在读取输出…</p>' : output ? `${stream("stdout", output.stdout)}${stream("stderr", output.stderr)}` : '<p class="info">尚未读取到输出；请手动刷新。</p>'}<p class="info">仅在点击时读取，从偏移 0 显示当前保留的输出，不自动轮询。</p>`,
    );
  }
  function body() {
    if (!scope)
      return panel(
        "本插件的进程",
        empty("请先创建或选择项目，再查看该项目的进程。", "选择项目后读取本插件的进程记录。"),
      );
    const feedback = `${error ? `<div class="error" role="alert">${esc(error)}</div>` : ""}${notice ? `<p class="info" role="status">${esc(notice)}</p>` : ""}`;
    const table = items?.length
      ? `<div class="tablewrap"><table><thead><tr><th>编号 / 工具 / 参数</th><th>状态 / 时间 / 退出信息</th><th>操作</th></tr></thead><tbody>${items.map((item, index) => `<tr><td>${detail(item)}</td><td>${esc(statusText(item.status))} <span class="mono">${esc(item.status)}</span><div>${esc(item.createdAt)}</div><div>退出码 ${esc(item.exitCode ?? "—")} · 信号 ${esc(item.exitSignal || "—")}</div>${item.error ? `<div class="error">${esc(item.error.message)}${item.error.code ? ` [${esc(item.error.code)}]` : ""}</div>` : ""}${item.status === "cleanup-pending" ? '<p class="info">清理尚未确认，请刷新状态或再次明确停止。</p>' : ""}</td><td><button type="button" class="small" data-process-action="output" data-process-index="${index}" ${refreshing || reading === item.id ? "disabled" : ""}>查看输出</button> <button type="button" class="small danger" data-process-action="stop" data-process-index="${index}" ${refreshing || stopping || !active(item) ? "disabled" : ""}>停止</button></td></tr>`).join("")}</tbody></table></div>`
      : items
        ? empty(
            "本项目尚无本插件管理的进程。",
            "通过绑定当前项目的会话启动已配置工具后，手动刷新列表。",
          )
        : '<p class="info">列表尚未读取成功。</p>';
    const pending = items?.find((item) => item.id === confirmation);
    const confirm = pending
      ? `<div class="note" role="group" aria-label="确认停止进程"><h3>确认停止此进程</h3>${detail(pending)}<p>将停止此记录所属的进程；停止结果以返回状态为准。</p><div class="toolbar"><button type="button" data-process-action="cancel-stop" ${stopping ? "disabled" : ""}>取消</button><button type="button" class="danger" data-process-action="confirm-stop" ${stopping ? "disabled" : ""}>${stopping ? "正在等待停止结果…" : "确认停止此进程"}</button></div></div>`
      : "";
    return (
      panel(
        "本插件的进程",
        `<p class="info">在绑定当前项目的会话中，通过 unlimit_process 启动已配置工具；此页查看/停止本插件的进程。</p>${feedback}<div class="toolbar"><button type="button" class="small" data-process-action="refresh" ${refreshing || stopping ? "disabled" : ""}>${refreshing ? "正在刷新…" : "手动刷新进程列表"}</button></div>${table}${confirm}`,
      ) + outputPane()
    );
  }
  function redraw() {
    if (disposed || !host) return;
    listeners?.abort();
    host.innerHTML = body();
    attach();
  }
  async function refresh() {
    if (disposed || refreshing || stopping) return;
    refreshing = true;
    selected = output = confirmation = reading = null;
    readSequence++;
    notice = error = "";
    redraw();
    try {
      await list();
    } catch (failure) {
      if (!disposed) {
        items = null;
        error = `刷新进程列表失败：${message(failure)}`;
      }
    } finally {
      refreshing = false;
      redraw();
    }
  }
  async function read(item) {
    if (disposed || refreshing || reading === item.id) return;
    const sequence = ++readSequence;
    const revision = metadataRevision;
    selected = reading = item.id;
    output = null;
    error = notice = "";
    redraw();
    try {
      const result = await api("processes.output", {
        workspaceId: scope,
        id: item.id,
        stdoutOffset: 0,
        stderrOffset: 0,
      });
      if (disposed || sequence !== readSequence) return;
      for (const stream of [result?.stdout, result?.stderr]) {
        if (
          !stream ||
          typeof stream.text !== "string" ||
          !Number.isSafeInteger(stream.nextOffset) ||
          stream.nextOffset < 0 ||
          typeof stream.lossy !== "boolean"
        )
          throw new Error("进程输出响应无效，请手动刷新。");
      }
      if (!validItem(result.item) || result.item.id !== item.id)
        throw new Error("进程响应与所选记录不匹配，请刷新列表。");
      if (revision === metadataRevision) adoptItem(result.item, item.id);
      output = { stdout: result.stdout, stderr: result.stderr };
    } catch (failure) {
      if (!disposed && sequence === readSequence) error = `读取进程输出失败：${message(failure)}`;
    } finally {
      if (!disposed && sequence === readSequence) {
        reading = null;
        redraw();
      }
    }
  }
  async function stop() {
    const target = confirmation;
    if (disposed || stopping || !target) return;
    stopping = target;
    error = notice = "";
    redraw();
    try {
      const result = await api("processes.stop", { workspaceId: scope, id: target });
      if (disposed) return;
      if (typeof result?.stopped !== "boolean")
        throw new Error("停止响应无效，请刷新列表核对实际状态。");
      adoptItem(result.item, target);
      metadataRevision++;
      confirmation = null;
      notice =
        result.item.status === "cleanup-pending"
          ? "清理尚未确认（cleanup-pending）；请刷新状态核对，未宣称停止完成。"
          : result.stopped
            ? "停止请求已完成；当前状态见进程列表。"
            : "返回结果未确认本次停止（stopped: false）；当前状态见进程列表。";
      toast(notice);
    } catch (failure) {
      if (!disposed) {
        confirmation = null;
        error = `停止进程失败：${message(failure)} 请刷新列表核对；未自动重试。`;
      }
    } finally {
      stopping = null;
      redraw();
    }
  }
  function attach() {
    if (!host || !scope) return;
    listeners = new AbortController();
    for (const button of host.querySelectorAll("[data-process-action]")) {
      button.addEventListener(
        "click",
        () => {
          if (disposed || button.disabled) return;
          const action = button.dataset.processAction;
          const item = items?.[Number(button.dataset.processIndex)];
          if (action === "refresh") return run(button, refresh);
          if (action === "output" && item) return run(button, () => read(item));
          if (action === "stop" && item && active(item) && !stopping) {
            confirmation = item.id;
            redraw();
          }
          if (action === "cancel-stop" && !stopping) {
            confirmation = null;
            redraw();
          }
          if (action === "confirm-stop") return run(button, stop);
        },
        { signal: listeners.signal },
      );
    }
  }
  return {
    html: `<div id="${id}" data-process-monitor>${body()}</div>`,
    bind(element) {
      if (disposed) return;
      listeners?.abort();
      host =
        element?.id === id
          ? element
          : element?.querySelector(`#${id}`) || document.getElementById(id);
      if (!host) throw new Error("进程监控模块容器不存在。");
      attach();
    },
    dispose() {
      disposed = true;
      readSequence++;
      listeners?.abort();
      if (host) host.innerHTML = "";
      host = null;
      items = output = selected = confirmation = null;
    },
  };
}

export default processMonitor;
