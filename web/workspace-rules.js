const fallbackEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const formatBytes = (bytes) =>
  Number.isSafeInteger(bytes) ? `${bytes.toLocaleString("zh-CN")} B` : "未知";

/** Pure candidate table, suitable for the existing desktop dialog styles. */
export function renderWorkspaceRules({ items, selectedPaths = [], esc = fallbackEscape }) {
  const selected = new Set(selectedPaths);
  if (!items.length)
    return '<p class="info">此目录及其祖先目录中未发现 AGENTS.md 或 CLAUDE.md。</p>';
  return `<div style="overflow:auto;max-height:38vh"><table style="width:100%"><thead><tr><th scope="col">选择</th><th scope="col">层级</th><th scope="col">文件 / 目录</th><th scope="col">大小</th><th scope="col">预览</th></tr></thead><tbody>${items.map((item, index) => `<tr><td><input type="checkbox" data-rule-choice="${index}" aria-label="选择 ${esc(item.path)}" ${item.readable && selected.has(item.path) ? "checked" : ""} ${item.readable ? "" : "disabled"}></td><td>${item.depth === 0 ? "当前目录" : `上 ${esc(item.depth)} 级`}</td><td style="overflow-wrap:anywhere"><strong>${esc(item.name)}</strong><br><small>${esc(item.directory)}</small>${item.linked ? `<br><small>链接至 ${esc(item.resolvedPath)}</small>` : ""}${item.readable ? "" : `<br><span class="inlineerror">${esc(item.error?.message || "此候选无法预览")}${item.error?.code ? ` [${esc(item.error.code)}]` : ""}</span>`}</td><td style="white-space:nowrap">${esc(formatBytes(item.bytes))}</td><td><button type="button" data-rule-preview="${index}" ${item.readable ? "" : "disabled"}>查看正文</button></td></tr>`).join("")}</tbody></table></div>`;
}

/** Owns one dialog. Only explicit confirmation invokes onSelect; no settings writes happen here. */
export function openWorkspaceRules({
  api,
  esc = fallbackEscape,
  directory,
  selectedPaths = [],
  onSelect,
  document: doc = globalThis.document,
}) {
  if (typeof api !== "function" || typeof onSelect !== "function")
    throw new TypeError("规则浏览器需要 api 和 onSelect");
  if (typeof directory !== "string" || !directory.trim())
    throw new TypeError("请先明确输入要扫描的工作区目录");
  const dialog = doc.createElement("dialog");
  dialog.setAttribute("aria-label", "选择工作区规则文件");
  Object.assign(dialog.style, {
    width: "min(1000px, calc(100vw - 80px))",
    maxHeight: "calc(100vh - 80px)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
  });
  dialog.innerHTML = `<div class="dialoghead" style="flex-shrink:0"><h2>选择工作区规则</h2><button type="button" data-rule-close aria-label="关闭规则浏览器">✕</button></div><div data-rule-body style="min-height:0;overflow:auto"><p class="info" style="overflow-wrap:anywhere">目录：${esc(directory)}<br>按祖先从远到近列出，仅加载勾选文件。正文只读，不执行内容；确认后才更新所选路径。</p><div data-rule-list aria-live="polite">正在扫描…</div><p class="inlineerror" data-rule-error role="alert"></p><section data-rule-preview-panel hidden><h3 data-rule-preview-title></h3><small data-rule-preview-meta style="display:block;overflow-wrap:anywhere"></small><pre data-rule-preview-content tabindex="0" style="max-height:30vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere"></pre></section></div><div class="dialogfoot" style="flex-shrink:0"><button type="button" data-rule-clear>清空选择</button><button type="button" data-rule-refresh>重新扫描</button><button type="button" data-rule-cancel>取消</button><button type="button" class="primary" data-rule-confirm disabled>确认所选文件</button></div>`;
  const query = (selector) => dialog.querySelector(selector);
  const selected = new Set(selectedPaths);
  let items = [],
    disposed = false,
    loading = false,
    loaded = false,
    saving = false,
    previewing = false,
    generation = 0;
  const controls = () => {
    for (const selector of ["[data-rule-clear]", "[data-rule-refresh]", "[data-rule-confirm]"])
      query(selector).disabled = loading || saving || previewing;
    query("[data-rule-confirm]").disabled ||= !loaded;
    for (const selector of ["[data-rule-cancel]", "[data-rule-close]"])
      query(selector).disabled = saving;
    for (const input of dialog.querySelectorAll("[data-rule-choice]"))
      input.disabled = saving || !items[Number(input.dataset.ruleChoice)]?.readable;
    for (const button of dialog.querySelectorAll("[data-rule-preview]"))
      button.disabled =
        loading || saving || previewing || !items[Number(button.dataset.rulePreview)]?.readable;
  };
  const showError = (error) => {
    query("[data-rule-error]").textContent = error?.message || String(error);
  };
  const dispose = () => {
    if (disposed || saving) return;
    disposed = true;
    generation++;
    dialog.close();
    dialog.remove();
  };
  const render = () => {
    const unavailable = [...selected].filter(
      (path) => !items.some((item) => item.path === path && item.readable),
    );
    query("[data-rule-list]").innerHTML =
      renderWorkspaceRules({ items, selectedPaths: [...selected], esc }) +
      (unavailable.length
        ? `<p class="note" style="overflow-wrap:anywhere">以下原选定路径不属于当前可读候选。确认将仅保留表格中勾选项；取消可保留原设置：<br>${unavailable.map(esc).join("<br>")}</p>`
        : "");
    for (const input of dialog.querySelectorAll("[data-rule-choice]"))
      input.onchange = () => {
        const item = items[Number(input.dataset.ruleChoice)];
        if (!item?.readable) return;
        if (input.checked) selected.add(item.path);
        else selected.delete(item.path);
      };
    for (const button of dialog.querySelectorAll("[data-rule-preview]"))
      button.onclick = async () => {
        if (previewing || loading || saving) return;
        const item = items[Number(button.dataset.rulePreview)];
        if (!item?.readable) return;
        previewing = true;
        query("[data-rule-error]").textContent = "";
        query("[data-rule-preview-panel]").hidden = false;
        query("[data-rule-preview-title]").textContent = `${item.name} · 只读预览`;
        query("[data-rule-preview-content]").textContent = "正在读取…";
        query("[data-rule-preview-meta]").textContent = item.path;
        controls();
        const version = generation;
        try {
          const result = await api("rules.preview", { directory, path: item.path });
          if (disposed || generation !== version) return;
          const value = result.item;
          if (!value || value.path !== item.path || typeof value.content !== "string")
            throw new Error("规则预览响应无效");
          query("[data-rule-preview-content]").textContent = value.content;
          query("[data-rule-preview-meta]").textContent =
            `${value.path} · ${formatBytes(value.bytes)} · SHA256 ${value.sha256}${value.resolvedPath !== value.path ? ` · 实际路径 ${value.resolvedPath}` : ""}`;
        } catch (error) {
          if (disposed || generation !== version) return;
          query("[data-rule-preview-content]").textContent =
            "未能读取正文。文件可能已失效或变化，请重新扫描。";
          if (typeof error.code === "string" && error.code.startsWith("RULE_")) {
            item.readable = false;
            item.error = { code: error.code, message: error.message };
            render();
          }
          showError(error);
        } finally {
          if (!disposed && generation === version) {
            previewing = false;
            controls();
          }
        }
      };
    controls();
  };
  const refresh = async () => {
    if (disposed || loading || saving || previewing) return;
    loading = true;
    loaded = false;
    generation++;
    const version = generation;
    query("[data-rule-error]").textContent = "";
    query("[data-rule-preview-panel]").hidden = true;
    query("[data-rule-preview-content]").textContent = "";
    query("[data-rule-list]").textContent = "正在扫描…";
    controls();
    try {
      const result = await api("rules.workspace", { directory });
      if (disposed || generation !== version) return;
      if (!Array.isArray(result.items)) throw new Error("规则扫描响应没有候选列表");
      items = result.items;
      loaded = true;
      render();
    } catch (error) {
      if (!disposed && generation === version) {
        items = [];
        query("[data-rule-list]").textContent = "扫描未完成，请确认目录后重试。";
        showError(error);
      }
    } finally {
      if (!disposed && generation === version) {
        loading = false;
        controls();
      }
    }
  };
  query("[data-rule-confirm]").onclick = async () => {
    if (loading || !loaded || saving || previewing || disposed) return;
    saving = true;
    query("[data-rule-error]").textContent = "";
    controls();
    const paths = items
      .filter((item) => item.readable && selected.has(item.path))
      .map((item) => item.path);
    try {
      await onSelect(paths);
      saving = false;
      dispose();
    } catch (error) {
      if (!disposed) {
        saving = false;
        showError(error);
        controls();
      }
    }
  };
  query("[data-rule-clear]").onclick = () => {
    if (!saving && !loading && !previewing) {
      selected.clear();
      render();
    }
  };
  query("[data-rule-refresh]").onclick = () => {
    void refresh();
  };
  query("[data-rule-cancel]").onclick = dispose;
  query("[data-rule-close]").onclick = dispose;
  dialog.oncancel = (event) => {
    event.preventDefault();
    dispose();
  };
  dialog.addEventListener("close", () => {
    if (!disposed && !saving) {
      disposed = true;
      generation++;
      dialog.remove();
    }
  });
  doc.body.append(dialog);
  dialog.showModal();
  void refresh();
  return { dialog, dispose, refresh };
}
