const fallbackEscape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );

export const promptPreviewNotice =
  "仅预览本插件按已保存配置生成的正文；当前表单未保存的修改不计入。此操作不保存配置、不启用运行控制、不调用模型。正文不含宿主工具说明和角色段，也不代表已捕获真实模型请求。";

export function renderPromptPreview(result, esc = fallbackEscape) {
  const sources = {
    rule: "规则库正文",
    saved: "已保存提示词",
    workspace: "工作区规则",
    default: "默认提示词",
  };
  const policies = {
    strict: "排除工作区规则",
    fallback: "正文为空时保留工作区规则",
    always: "保留并合并工作区规则",
  };
  const row = (label, value) =>
    `<div class="twocoltext" style="overflow-wrap:anywhere"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const rule = result.rule;
  const workspace = result.workspace;
  return `<div class="grid2 equal"><div>${row("正文来源", sources[result.source] ?? result.source)}${row("采用规则", rule ? rule.name : "未采用规则库正文")}${rule ? row("规则模型", rule.model ?? "通用（不限定模型）") : ""}${row("预览模型", result.model ?? "无模型")}${row("保存版本", `revision ${result.revision}`)}</div><div>${row("运行控制", result.enabled ? "已启用" : "未启用，仅预览候选正文")}${row("正文模式", result.mode === "replace" ? "替换" : "追加")}${row("工作区策略", policies[workspace.policy] ?? workspace.policy)}${row("工作区正文", workspace.included ? "参与" : "未参与")}</div></div>${row("工作目录", result.directory ?? "未提供")}${workspace.selectedPaths.length ? `<details><summary>本次读取的工作区文件（${workspace.selectedPaths.length}）</summary><ul style="overflow-wrap:anywhere">${workspace.selectedPaths.map((path) => `<li>${esc(path)}</li>`).join("")}</ul></details>` : '<p class="info">本次未读取工作区文件。</p>'}<h3>完整正文 · 只读</h3>${result.text ? `<pre class="report" tabindex="0" aria-label="完整提示词正文" style="max-height:34vh">${esc(result.text)}</pre>` : '<p class="info">正文为空。</p>'}`;
}

/** Read-only saved-config preview, with no controls inside the settings form. */
export function openPromptPreview({
  api,
  document: doc = globalThis.document,
  esc = fallbackEscape,
}) {
  const dialog = doc.createElement("dialog");
  dialog.setAttribute("aria-label", "预览已保存正文");
  Object.assign(dialog.style, {
    width: "min(920px, calc(100vw - 80px))",
    maxHeight: "calc(100vh - 80px)",
    boxSizing: "border-box",
  });
  dialog.innerHTML = `<div class="dialoghead"><h2>预览已保存正文</h2><button type="button" class="quiet small" data-prompt-close aria-label="关闭正文预览">✕</button></div><p class="info">${esc(promptPreviewNotice)}</p><div class="fields"><div class="field"><label for="prompt-preview-model">模型 ID · 可选</label><input id="prompt-preview-model" data-prompt-model type="text" placeholder="不填按无模型处理"><small>填写完整模型 ID，用于匹配已保存规则。</small></div><div class="field"><label for="prompt-preview-directory">工作目录 · 可选</label><input id="prompt-preview-directory" data-prompt-directory type="text" placeholder="本地工作区绝对路径"><small>所选文件参与合并时必填；读取失败时显示具体原因。</small></div></div><div class="toolbar"><button type="button" class="primary" data-prompt-read>读取已保存正文</button></div><p class="info" data-prompt-status role="status" aria-live="polite">填写预览条件后点击读取。</p><p class="inlineerror" data-prompt-error role="alert"></p><section data-prompt-result aria-label="已保存正文预览结果"></section>`;
  const query = (selector) => dialog.querySelector(selector);
  const model = query("[data-prompt-model]");
  const directory = query("[data-prompt-directory]");
  const read = query("[data-prompt-read]");
  const status = query("[data-prompt-status]");
  const error = query("[data-prompt-error]");
  const result = query("[data-prompt-result]");
  let disposed = false;
  let busy = false;
  let generation = 0;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation++;
    result.innerHTML = "";
    dialog.close();
    dialog.remove();
  };
  const invalidate = () => {
    generation++;
    result.innerHTML = "";
    error.textContent = "";
    status.textContent = "预览条件已变化，请重新读取已保存正文。";
  };
  model.oninput = invalidate;
  directory.oninput = invalidate;
  read.onclick = async () => {
    if (disposed || busy) return;
    busy = true;
    read.disabled = true;
    const version = ++generation;
    const payload = {};
    if (model.value.trim()) payload.model = model.value;
    if (directory.value.trim()) payload.directory = directory.value;
    result.innerHTML = "";
    error.textContent = "";
    status.textContent = "正在读取已保存正文…";
    try {
      const response = await api("prompt.preview", payload);
      if (disposed || generation !== version) return;
      result.innerHTML = renderPromptPreview(response, esc);
      status.textContent = "已读取保存配置生成的正文。更改预览条件后需重新读取。";
    } catch (failure) {
      if (disposed || generation !== version) return;
      result.innerHTML = "";
      error.textContent = failure.message || String(failure);
      status.textContent = "读取未完成，请检查条件后重新读取。";
    } finally {
      if (!disposed) {
        busy = false;
        read.disabled = false;
      }
    }
  };
  query("[data-prompt-close]").onclick = dispose;
  dialog.oncancel = (event) => {
    event.preventDefault();
    dispose();
  };
  dialog.addEventListener("close", dispose);
  doc.body.append(dialog);
  dialog.showModal();
  model.focus();
  return dispose;
}
