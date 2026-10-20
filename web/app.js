const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const state = {
  page: "overview",
  status: null,
  workspaces: [],
  workspaceId: "",
  settings: null,
  recordKind: "credential",
  query: "",
  request: 0,
  report: "",
  graph: null,
  bridgeReady: false,
  rewindOutcome: null,
  assetImport: null,
  knowledgeFilters: { kind: "", tags: "", verified: "" },
  knowledgeReadback: null,
  assetFilters: { scope: "", status: "", type: "" },
  assetImportError: null,
  skillImport: null,
  flowFeedback: null,
};
const pages = [
  ["overview", "◈", "工作台概览", "OVERVIEW", "掌握运行状态与当前演练进展"],
  ["control", "⌘", "破甲控制", "RUNTIME CONTROL", "配置提示词与运行时策略，在明确操作后应用"],
  ["rules", "≡", "规则管理", "RULE LIBRARY", "维护规则内容，选择当前生效规则"],
  ["skills", "◇", "技能管理", "SKILL LIBRARY", "管理插件选定目录中的本地技能"],
  ["workspaces", "▧", "演练项目", "WORKSPACES", "记录授权范围，让资产与证据按项目隔离"],
  ["assets", "⊞", "资产台账", "ASSET INVENTORY", "梳理演练资产、关联与评估记录"],
  ["findings", "⚑", "漏洞发现", "FINDINGS", "跟踪发现的严重度、状态与证据"],
  ["evidence", "▤", "证据中心", "EVIDENCE CENTER", "保存本地证据记录，不会执行远程操作"],
  ["graph", "⌁", "关系图谱", "RELATION GRAPH", "从资产关系理解当前演练范围"],
  ["progress", "◴", "阶段与评分", "PROGRESS & SCORE", "记录演练阶段、得分点与命中情况"],
  ["knowledge", "▥", "知识库", "KNOWLEDGE BASE", "积累可复用的知识与方法"],
  ["roles", "♙", "角色提示词", "ROLE PROMPTS", "按当前项目管理角色与提示词"],
  ["reports", "↗", "报告导出", "REPORTS", "汇总当前项目并导出本地 Markdown 报告"],
  ["sessions", "◷", "会话管理", "SESSIONS", "查看宿主会话，保留原会话进行回退"],
  ["environment", "⌖", "工具与环境", "TOOLKIT & ENVIRONMENT", "检查本地工具路径并管理受控进程"],
  ["diagnostics", "⊙", "诊断与维护", "DIAGNOSTICS", "检查宿主能力与离线维护状态"],
];
const groups = { 0: "工作空间", 1: "运行控制", 4: "演练管理", 10: "知识与交付", 13: "系统" };
const descriptions = Object.fromEntries(pages.map((p) => [p[0], p]));
const defaults = {
  enabled: false,
  prompt: "",
  promptMode: "replace",
  workspacePolicy: "fallback",
  workspaceFiles: [],
  fullAccess: true,
  autoApprove: true,
  hooksDeny: false,
  maxSubagents: 16,
  maxDepth: 10,
  readLimit: 1048576,
  autoReapply: true,
  retryLimit: 0,
  ownServers: [],
};
const kinds = {
  credential: "凭据",
  access: "访问权限",
  webshell: "WebShell",
  tunnel: "隧道",
  screenshot: "截图",
  http: "HTTP 请求",
  chain: "攻击链",
  file: "文件",
  "score-point": "得分点",
  "score-hit": "评分命中",
  stage: "阶段",
  session: "会话证据",
};
const field = (name, label, type = "text", extra = {}) => ({ name, label, type, ...extra });
const recordFields = {
  credential: [
    field("name", "名称"),
    field("username", "账号"),
    field("secret", "凭据内容", "password"),
    field("target", "关联目标"),
    field("notes", "说明", "textarea"),
  ],
  access: [
    field("name", "名称"),
    field("target", "目标"),
    field("level", "权限级别"),
    field("method", "获取方式"),
    field("notes", "说明", "textarea"),
  ],
  webshell: [
    field("name", "名称"),
    field("url", "地址"),
    field("language", "语言"),
    field("status", "状态"),
    field("notes", "证据说明", "textarea"),
  ],
  tunnel: [
    field("name", "名称"),
    field("source", "来源地址"),
    field("destination", "目标地址"),
    field("protocol", "协议"),
    field("notes", "说明", "textarea"),
  ],
  screenshot: [
    field("name", "名称"),
    field("path", "本地文件路径"),
    field("target", "关联目标"),
    field("notes", "截图说明", "textarea"),
  ],
  http: [
    field("name", "名称"),
    field("method", "方法", "select", {
      options: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
    }),
    field("url", "URL"),
    field("request", "请求内容", "textarea"),
    field("response", "响应内容", "textarea"),
  ],
  chain: [
    field("name", "名称"),
    field("from", "起点"),
    field("to", "终点"),
    field("technique", "技术 / 方法"),
    field("notes", "链路说明", "textarea"),
  ],
  file: [
    field("name", "名称"),
    field("path", "本地文件路径"),
    field("sha256", "SHA-256"),
    field("notes", "文件说明", "textarea"),
  ],
  "score-point": [
    field("name", "得分点名称"),
    field("points", "分值", "number", { min: 0 }),
    field("condition", "判定条件", "textarea"),
  ],
  "score-hit": [
    field("name", "命中名称"),
    field("pointId", "得分点 ID"),
    field("points", "实际分值", "number"),
    field("notes", "命中证据", "textarea"),
  ],
  stage: [
    field("name", "阶段名称"),
    field("status", "状态", "select", { options: ["planned", "in_progress", "complete"] }),
    field("progress", "进度（%）", "number", { min: 0, max: 100 }),
    field("notes", "阶段说明", "textarea"),
  ],
  session: [
    field("name", "记录名称"),
    field("sessionId", "会话 ID"),
    field("notes", "会话说明", "textarea"),
  ],
};
const schemas = {
  workspaces: {
    label: "演练项目",
    fields: [
      field("name", "项目名称", "text", { required: true }),
      field("scope", "授权范围", "textarea"),
      field("authorization", "授权依据", "textarea"),
    ],
    columns: [
      ["name", "项目名称"],
      ["scope", "范围"],
      ["authorization", "授权依据"],
    ],
    workspace: false,
    activate: true,
  },
  rules: {
    label: "规则",
    fields: [
      field("name", "规则名称", "text", { required: true }),
      field("model", "适用模型"),
      field("content", "规则内容", "textarea"),
    ],
    columns: [
      ["name", "规则名称"],
      ["model", "适用模型"],
      ["content", "规则摘要"],
    ],
    workspace: false,
    delete: true,
    activate: true,
  },
  assets: {
    label: "资产",
    fields: [
      field("name", "资产名称", "text", { required: true }),
      field("address", "地址", "text", { required: true }),
      field("type", "类型", "select", {
        options: ["host", "domain", "web", "service", "network", "other"],
      }),
      field("scope", "范围", "select", {
        options: [
          ["", "自动识别"],
          ["internal", "内网"],
          ["external", "外网"],
          ["unknown", "未分类"],
        ],
      }),
      field("segment", "网段"),
      field("status", "资产状态", "text", {
        default: "unverified",
        help: "按项目约定填写，例如 unverified、verified。",
      }),
      field("priority", "优先级", "text", {
        default: "normal",
        help: "可填写优先级名称或非负整数。",
      }),
      field("ports", "端口（逗号分隔）"),
      field("domains", "域名 · 每行一个", "textarea"),
      field("fingerprints", "指纹 · 每行一个", "textarea"),
      field("sources", "来源 · 每行一个", "textarea"),
      field("tags", "标签（逗号分隔）"),
      field("notes", "资产说明", "textarea"),
    ],
    columns: [
      ["name", "资产名称"],
      ["address", "地址"],
      ["type", "类型"],
      ["scope", "范围"],
      ["status", "状态"],
    ],
    workspace: true,
  },
  findings: {
    label: "漏洞发现",
    fields: [
      field("title", "标题", "text", { required: true }),
      field("assetId", "关联资产 ID"),
      field("severity", "严重度", "select", {
        options: ["critical", "high", "medium", "low", "info"],
      }),
      field("status", "状态", "select", {
        options: ["open", "confirmed", "resolved", "accepted", "closed"],
      }),
      field("evidence", "证据说明", "textarea"),
    ],
    columns: [
      ["title", "漏洞标题"],
      ["severity", "严重度"],
      ["status", "状态"],
      ["assetId", "关联资产"],
    ],
    workspace: true,
  },
  knowledge: {
    label: "知识条目",
    fields: [
      field("title", "标题", "text", { required: true }),
      field("kind", "分类", "text", { default: "note" }),
      field("tags", "标签（逗号分隔）"),
      field("content", "知识内容", "textarea"),
    ],
    columns: [
      ["title", "标题"],
      ["kind", "分类"],
      ["tags", "标签"],
      ["content", "内容摘要"],
    ],
    workspace: false,
    delete: true,
    use: true,
  },
};
const labels = {
  critical: "严重",
  high: "高危",
  medium: "中危",
  low: "低危",
  info: "信息",
  open: "待确认",
  confirmed: "已确认",
  verified: "已验证",
  unverified: "未验证",
  added: "新增",
  merged: "合并",
  rejected: "拒绝",
  fixed: "已修复",
  resolved: "已解决",
  closed: "已关闭",
  accepted: "已接受",
  planned: "待开始",
  in_progress: "进行中",
  complete: "已完成",
  available: "可用",
  active: "运行中",
  unsupported: "不可用",
  internal: "内网",
  external: "外网",
  unknown: "未分类",
  domain: "域名",
  host: "主机",
  web: "Web",
  service: "服务",
  network: "网络",
  other: "其他",
  running: "运行中",
  stopped: "已停止",
  fallback: "回退",
  replace: "替换",
  append: "追加",
};
function friendly(value) {
  if (Array.isArray(value)) return value.join(" · ");
  if (value && typeof value === "object")
    return Object.values(value)
      .filter((v) => typeof v !== "object")
      .join(" · ");
  return labels[value] || String(value ?? "—");
}
function badge(value) {
  const color = ["critical", "high", "unsupported", "rejected"].includes(value)
    ? "red"
    : ["medium", "open", "planned"].includes(value)
      ? "orange"
      : [
            "active",
            "available",
            "complete",
            "fixed",
            "confirmed",
            "verified",
            "added",
            "merged",
          ].includes(value)
        ? ""
        : "gray";
  return `<span class="tag ${color}">${esc(friendly(value))}</span>`;
}
function time(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(+d) ? String(value) : d.toLocaleString("zh-CN", { hour12: false });
}
async function api(action, payload = {}) {
  const res = await fetch("/dsh-unlimit/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-DSH-Unlimit": "1" },
    body: JSON.stringify({ action, payload }),
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`服务响应无效（HTTP ${res.status}）`);
  }
  if (!res.ok || !body.ok) {
    const error = new Error(
      `${body.error?.message || "请求失败"}${body.error?.code ? ` [${body.error.code}]` : ""}`,
    );
    error.code = body.error?.code;
    error.partial = body.error?.partial;
    throw error;
  }
  return body.data;
}
function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (box.style.display = "none"), 4500);
}
async function task(button, fn) {
  if (button && button.tagName !== "BUTTON") button = null;
  if (button?.disabled) return;
  const old = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = "处理中…";
  }
  try {
    await fn();
  } catch (e) {
    toast(e.message);
    throw e;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = old;
    }
  }
}
function run(button, fn) {
  task(button, fn).catch(() => {});
}
let bridgeCounter = 0;
const bridgePending = new Map();
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  const response = event.data;
  if (!response || response.type !== "dsh-unlimit:draft-bridge-response") return;
  const pending = bridgePending.get(response.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  bridgePending.delete(response.id);
  if (response.ok) pending.resolve(response);
  else {
    const error = new Error(response.error || "宿主草稿桥调用失败");
    error.draftStatus = response.draftStatus;
    pending.reject(error);
  }
});
function bridgeRequest(operation, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error("独立预览中没有宿主草稿桥"));
  return new Promise((resolve, reject) => {
    const id = `bridge-${Date.now()}-${++bridgeCounter}`;
    const timer = setTimeout(
      () => {
        bridgePending.delete(id);
        reject(new Error("宿主草稿桥未响应"));
      },
      operation === "probe" ? 2000 : 15000,
    );
    bridgePending.set(id, { resolve, reject, timer });
    try {
      window.parent.postMessage(
        { type: "dsh-unlimit:draft-bridge-request", id, operation, payload },
        location.origin,
      );
    } catch (error) {
      clearTimeout(timer);
      bridgePending.delete(id);
      reject(error);
    }
  });
}
async function probeBridge() {
  try {
    state.bridgeReady = Boolean((await bridgeRequest("probe")).ready);
  } catch {
    state.bridgeReady = false;
  }
  return state.bridgeReady;
}
function can(id) {
  const caps = state.status?.capabilities;
  if (!Array.isArray(caps)) return false;
  const hit = caps.find((c) => (typeof c === "string" ? c : c.id) === id);
  return Boolean(hit && (typeof hit === "string" || ["available", "active"].includes(hit.state)));
}
function capabilityButton(id, label, attrs = "") {
  const available = can(id);
  return `<button ${attrs} ${available ? "" : `disabled title="宿主未提供此能力"`}>${esc(label)}</button>`;
}
function workspacePayload() {
  if (!state.workspaceId) throw new Error("请先创建并激活一个演练项目");
  return { workspaceId: state.workspaceId };
}
function empty(title, desc = "点击右上方按钮开始添加。") {
  return `<div class="empty"><div class="emptyicon">◇</div><strong>${esc(title)}</strong>${esc(desc)}</div>`;
}
function panel(title, body, meta = "") {
  return `<section class="panel"><div class="panelheading"><h2>${esc(title)}</h2>${meta ? `<span class="meta">${esc(meta)}</span>` : ""}</div>${body}</section>`;
}
function heading(actions = "") {
  const p = descriptions[state.page];
  return `<div class="pageheading"><div><div class="eyebrow">${p[3]}</div><h1>${p[2]}</h1><p class="subtitle">${p[4]}</p></div><div class="headingactions">${actions}</div></div>`;
}
function skeleton() {
  return '<div class="loading">正在读取本地工作台…</div>';
}
function shell() {
  $("#app").innerHTML =
    `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark">U</span><div><strong>UNLIMIT</strong><small>DESKTOP WORKSPACE</small></div></div><nav aria-label="主导航">${pages.map((p, i) => `${groups[i] ? `<div class="navgroup">${groups[i]}</div>` : ""}<button class="navitem ${p[0] === state.page ? "active" : ""}" data-page="${p[0]}"><span class="navicon" aria-hidden="true">${p[1]}</span>${p[2]}</button>`).join("")}</nav><div class="sidebarfooter"><div class="connection"><i class="dot off" id="connection-dot"></i><span id="connection-label">连接中</span></div><div id="version-label">独立桌面工作台</div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">DSH UNLIMIT <span style="margin:0 10px">/</span> <b id="crumb">工作台概览</b></div><div class="topright"><span class="tag gray" id="instance-label">本地实例</span><span>当前项目</span><select id="workspace-select" aria-label="当前演练项目"><option value="">尚未激活项目</option></select><span class="avatar" title="本地工作台">L</span></div></header><div class="content" id="content">${skeleton()}</div></main></div>`;
  $$(".navitem").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.page)));
  $("#workspace-select").addEventListener("change", (e) =>
    run(e.target, async () => {
      if (!e.target.value) return;
      await api("workspaces.activate", { id: e.target.value });
      state.workspaceId = e.target.value;
      await refreshProjects();
      await render();
    }),
  );
}
async function refreshProjects() {
  const data = await api("workspaces.list");
  state.workspaces = data.items || [];
  state.workspaceId = data.activeId || "";
  $("#workspace-select").innerHTML =
    `<option value="">尚未激活项目</option>${state.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === state.workspaceId ? "selected" : ""}>${esc(w.name)}</option>`).join("")}`;
}
async function refreshStatus() {
  state.status = await api("status");
  if (state.status.settings) state.settings = state.status.settings;
  $("#instance-label").textContent =
    state.status.host?.kind === "synthetic-preview" ? "合成预览" : "桌面实例";
  $("#instance-label").className =
    state.status.host?.kind === "synthetic-preview" ? "tag orange" : "tag gray";
  $("#connection-label").textContent = state.status.enabled ? "运行控制已启用" : "本地服务已连接";
  $("#connection-dot").classList.toggle("off", !state.status.enabled);
  $("#version-label").textContent =
    `v${state.status.version || "—"} · ${state.status.host?.platform || "Desktop"}`;
}
function navigate(page) {
  state.page = page;
  state.query = "";
  $$(".navitem").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#crumb").textContent = descriptions[page][2];
  render();
}
async function render() {
  const serial = ++state.request;
  const content = $("#content");
  content.innerHTML = skeleton();
  try {
    let result;
    if (schemas[state.page]) result = await collectionPage(state.page);
    else
      result = await {
        overview: overviewPage,
        control: controlPage,
        skills: skillsPage,
        evidence: evidencePage,
        graph: graphPage,
        progress: progressPage,
        roles: rolesPage,
        reports: reportsPage,
        sessions: sessionsPage,
        environment: environmentPage,
        diagnostics: diagnosticsPage,
      }[state.page]();
    if (serial !== state.request) return;
    content.innerHTML =
      result.html +
      `<div class="footerline"><span>DSH UNLIMIT · 本地工作台</span><span>数据保存在当前本地实例中</span></div>`;
    result.bind?.();
  } catch (e) {
    if (serial !== state.request) return;
    content.innerHTML =
      heading() +
      `<div class="error" role="alert">${esc(e.message)}</div><button id="retry">重新读取</button>`;
    $("#retry").onclick = render;
  }
}
function redactCell(value, key = "") {
  if (
    /pass(word|phrase)?|secret|token|cookie|authorization|private.?key|api.?key|credential/i.test(
      key,
    )
  )
    return "•••••• · 已隐藏";
  if (Array.isArray(value)) return value.map((item) => redactCell(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactCell(item, name)]),
    );
  if (typeof value === "string")
    return value
      .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[已隐藏]")
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[已隐藏]",
      )
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[已隐藏]@");
  return value;
}
function table(items, columns, actions) {
  return `<div class="tablewrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c[1])}</th>`).join("")}${actions ? '<th style="text-align:right">操作</th>' : ""}</tr></thead><tbody>${items.map((item, index) => `<tr>${columns.map(([key], j) => `<td>${key === "verified" ? badge(item.verified ? "verified" : "unverified") : ["severity", "status"].includes(key) ? badge(item[key]) : `<div class="${j === 0 ? "celltitle" : ""}">${esc(friendly(item.kind === "credential" ? (key === "name" ? `凭据记录 ${index + 1}` : "•••••• · 已隐藏") : redactCell(item[key], key))).slice(0, 360)}</div>${j === 0 && item.updatedAt ? `<div class="cellsub">${esc(time(item.updatedAt))}</div>` : ""}`}</td>`).join("")}${actions ? `<td><div class="rowactions">${actions(item, index)}</div></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function renderField(f, value) {
  const v = value ?? f.default ?? "";
  const attr = `name="${esc(f.name)}" id="f-${esc(f.name)}" ${f.required ? "required" : ""} ${f.disabled ? "disabled" : ""} ${f.readonly ? "readonly" : ""} ${f.pattern ? `pattern="${esc(f.pattern)}"` : ""} ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""}`;
  let input;
  if (f.type === "textarea")
    input = `<textarea ${attr} rows="${f.name === "content" ? 8 : 4}">${esc(Array.isArray(v) ? v.join("\n") : v)}</textarea>`;
  else if (f.type === "select")
    input = `<select ${attr}>${f.options
      .map((opt) => {
        const [val, label] = Array.isArray(opt) ? opt : [opt, friendly(opt)];
        return `<option value="${esc(val)}" ${String(v) === String(val) ? "selected" : ""}>${esc(label)}</option>`;
      })
      .join("")}</select>`;
  else if (f.type === "checkbox") input = `<input type="checkbox" ${attr} ${v ? "checked" : ""}>`;
  else
    input = `<input type="${f.type}" ${attr} value="${esc(Array.isArray(v) ? v.join(", ") : v)}" ${f.type === "number" ? 'step="any"' : ""} autocomplete="off">`;
  return `<div class="field ${f.type === "textarea" ? "wide" : ""}"><label for="f-${esc(f.name)}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}${f.help ? `<small>${esc(f.help)}</small>` : ""}</div>`;
}
function openForm(title, fields, values, onSave, options = {}) {
  const dialog = $("#editor");
  dialog.innerHTML = `<form id="edit-form"><div class="dialoghead"><h2>${esc(title)}</h2><button type="button" class="quiet small" id="close-dialog" aria-label="关闭">✕</button></div>${options.note ? `<div class="note">${esc(options.note)}</div>` : ""}<div class="fields">${fields.map((f) => renderField(f, values[f.name])).join("")}</div><p class="inlineerror" id="form-error" role="alert"></p><div class="dialogfoot"><button type="button" id="cancel-dialog">取消</button><button class="primary" type="submit">${esc(options.submit || "保存")}</button></div></form>`;
  $("#close-dialog").onclick = () => dialog.close();
  $("#cancel-dialog").onclick = () => dialog.close();
  $("#edit-form").onsubmit = (e) => {
    e.preventDefault();
    const button = $("button[type=submit]", e.target);
    run(button, async () => {
      const data = Object.fromEntries(new FormData(e.target));
      fields.forEach((f) => {
        if (f.type === "number") {
          if (f.optional && data[f.name] === "") delete data[f.name];
          else data[f.name] = data[f.name] === "" ? 0 : Number(data[f.name]);
        }
        if (f.type === "checkbox") data[f.name] = e.target.elements[f.name].checked;
      });
      try {
        await onSave(data);
        dialog.close();
        toast(options.success || "已保存");
        if (!options.keepPage) await render();
      } catch (error) {
        $("#form-error").textContent = error.message;
        throw error;
      }
    });
  };
  dialog.showModal();
  options.afterOpen?.(dialog);
}
function confirmAction(title, message, onConfirm) {
  const dialog = $("#editor");
  dialog.innerHTML = `<div class="dialoghead"><h2>${esc(title)}</h2></div><p class="info">${esc(message)}</p><p class="inlineerror" id="confirm-error" role="alert"></p><div class="dialogfoot"><button id="cancel-confirm">取消</button><button class="danger" id="accept-confirm">确认${esc(title)}</button></div>`;
  $("#cancel-confirm").onclick = () => dialog.close();
  $("#accept-confirm").onclick = (e) =>
    run(e.target, async () => {
      try {
        await onConfirm();
        dialog.close();
        toast("操作完成");
        await render();
      } catch (error) {
        $("#confirm-error").textContent = error.message;
        throw error;
      }
    });
  dialog.showModal();
}
function knowledgeEvidenceText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(knowledgeEvidenceText).filter(Boolean).join("\n\n");
  if (value && typeof value === "object")
    return ["content", "text", "excerpt", "observation", "result"]
      .map((key) => knowledgeEvidenceText(value[key]))
      .filter(Boolean)
      .join("\n\n");
  return "";
}
async function collectionPage(name) {
  const schema = schemas[name];
  const payload = schema.workspace ? workspacePayload() : {};
  const filters = state.knowledgeFilters;
  const listPayload = { ...payload };
  if (name === "assets") {
    if (state.query) listPayload.query = state.query;
    for (const [key, value] of Object.entries(state.assetFilters))
      if (value.trim()) listPayload[key] = value.trim();
  }
  if (name === "knowledge") {
    if (state.query) listPayload.query = state.query;
    if (filters.kind.trim()) listPayload.kind = filters.kind.trim();
    listPayload.tags = filters.tags
      .split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (filters.verified !== "") listPayload.verified = filters.verified === "true";
  }
  const response = await api(`${name}.list`, listPayload);
  const items = response.items;
  let formFields = schema.fields;
  if (name === "findings") {
    const assets = await api("assets.list", payload);
    formFields = formFields.map((f) =>
      f.name === "assetId"
        ? field("assetId", "关联资产", "select", {
            options: [["", "未关联"], ...assets.items.map((a) => [a.id, a.name])],
          })
        : f,
    );
  }
  const filtered =
    state.query && !["knowledge", "assets"].includes(name)
      ? items.filter((i) =>
          Object.values(i).join(" ").toLowerCase().includes(state.query.toLowerCase()),
        )
      : items;
  const columns =
    name === "knowledge"
      ? [
          ["title", "标题"],
          ["kind", "分类"],
          ["tags", "标签"],
          ["verified", "验证状态"],
          ["content", "内容摘要"],
        ]
      : schema.columns;
  const actions = (item, index) =>
    `${name === "assets" ? `<button class="small quiet" data-act="services" data-index="${index}">服务详情</button><button class="small quiet" data-act="assess" data-index="${index}">记录评估</button><button class="small quiet" data-act="test" data-index="${index}">测试结果</button>` : ""}${schema.activate ? `<button class="small ${response.activeId === item.id ? "quiet" : "primary"}" data-act="activate" data-index="${index}" ${response.activeId === item.id ? "disabled" : ""}>${response.activeId === item.id ? "已激活" : "激活"}</button>` : ""}${schema.use ? `<button class="small" data-act="use" data-index="${index}">使用</button>` : ""}<button class="small quiet" data-act="edit" data-index="${index}">编辑</button>${schema.delete ? `<button class="small quiet danger" data-act="delete" data-index="${index}">删除</button>` : ""}`;
  const filterForm =
    name === "knowledge"
      ? `<form id="knowledge-filters" class="knowledge-filters"><div class="field"><label for="knowledge-kind-filter">分类</label><input id="knowledge-kind-filter" name="kind" value="${esc(filters.kind)}" placeholder="全部分类"></div><div class="field"><label for="knowledge-tags-filter">标签 · 全部匹配</label><input id="knowledge-tags-filter" name="tags" value="${esc(filters.tags)}" placeholder="多个标签用逗号分隔"></div><div class="field"><label for="knowledge-verified-filter">验证状态</label><select id="knowledge-verified-filter" name="verified"><option value="" ${filters.verified === "" ? "selected" : ""}>全部状态</option><option value="true" ${filters.verified === "true" ? "selected" : ""}>已验证</option><option value="false" ${filters.verified === "false" ? "selected" : ""}>未验证</option></select></div><button type="submit">应用筛选</button><button type="button" id="clear-knowledge-filters" class="quiet">清除筛选</button></form>`
      : name === "assets"
        ? `<form id="asset-filters" class="asset-filters"><div class="field"><label for="asset-scope-filter">范围</label><select id="asset-scope-filter" name="scope">${[
            ["", "全部范围"],
            ["internal", "内网"],
            ["external", "外网"],
            ["unknown", "未分类"],
          ]
            .map(
              ([value, label]) =>
                `<option value="${value}" ${state.assetFilters.scope === value ? "selected" : ""}>${label}</option>`,
            )
            .join(
              "",
            )}</select></div><div class="field"><label for="asset-status-filter">资产状态</label><input id="asset-status-filter" name="status" value="${esc(state.assetFilters.status)}" placeholder="全部状态"></div><div class="field"><label for="asset-type-filter">资产类型</label><input id="asset-type-filter" name="type" value="${esc(state.assetFilters.type)}" placeholder="全部类型" list="asset-type-options"><datalist id="asset-type-options">${["host", "domain", "web", "service", "network", "other"].map((value) => `<option value="${value}"></option>`).join("")}</datalist></div><button type="submit">应用筛选</button><button type="button" id="clear-asset-filters" class="quiet">清除筛选</button></form>`
        : "";
  const imported =
    name === "assets" && state.assetImport?.workspaceId === state.workspaceId
      ? state.assetImport
      : null;
  const importPanel = imported
    ? panel(
        "资产导入结果",
        `<div class="${imported.rejected ? "error" : "note"}">新增 ${imported.added} 项 · 合并 ${imported.merged} 项 · 拒绝 ${imported.rejected} 项${imported.rejected ? "。仅接受的条目已写入，请查看逐项结果。" : "。以下为服务端逐项返回结果。"}</div>${
          imported.results.length
            ? table(imported.results, [
                ["row", "文件条目"],
                ["name", "资产名称"],
                ["address", "地址"],
                ["status", "结果"],
                ["error", "拒绝原因"],
              ])
            : empty("导入文件不含条目", "没有新增或合并任何资产。")
        }`,
        imported.filename,
      )
    : "";
  const importError =
    name === "assets" && state.assetImportError?.workspaceId === payload.workspaceId
      ? `<div class="error" role="alert">资产导入未完成：${esc(state.assetImportError.message)}</div>`
      : "";
  const saved = name === "knowledge" ? state.knowledgeReadback : null;
  const readback = saved
    ? `<div class="note">已从服务端读回“${esc(redactCell(saved.title))}”：验证状态为${saved.verified ? "已验证" : "未验证"}。${saved.contentChanged && !saved.verified ? "正文已变更，旧验证状态已撤回。" : ""}</div>`
    : "";
  return {
    html:
      heading(
        `${name === "assets" ? '<button id="import-assets">导入本地 JSON</button>' : ""}<button class="primary" id="create">＋ 新建${schema.label}</button>`,
      ) +
      (name === "assets"
        ? '<input type="file" id="asset-import-file" accept=".json,application/json" hidden>'
        : "") +
      readback +
      importError +
      panel(
        `${schema.label}列表`,
        `<div class="toolbar"><input class="search" id="search" placeholder="搜索${schema.label}…" aria-label="搜索${schema.label}" value="${esc(state.query)}">${name === "rules" ? '<button id="reset-rules">清除激活规则</button>' : ""}<span class="meta">${items.length} 条记录</span></div>${filterForm}${filtered.length ? table(filtered, columns, actions) : empty(`暂无${schema.label}`, state.query || name === "knowledge" || (name === "assets" && Object.values(state.assetFilters).some(Boolean)) ? "当前条件下没有匹配的记录。" : "建立第一条记录，开始整理工作。")}`,
      ) +
      importPanel,
    bind() {
      const edit = (item) => {
        let fields =
          name === "findings" && item?.assetId
            ? formFields.map((f) =>
                f.name === "assetId" ? { ...f, options: f.options.filter(([id]) => id) } : f,
              )
            : formFields;
        let values = item || {};
        let savedId = item?.id;
        if (name === "assets")
          fields = fields.map((f) =>
            f.type === "select" &&
            item?.[f.name] &&
            !f.options.some(
              (option) => (Array.isArray(option) ? option[0] : option) === item[f.name],
            )
              ? { ...f, options: [...f.options, [item[f.name], item[f.name]]] }
              : f,
          );
        if (name === "knowledge") {
          fields = [
            ...fields,
            field("source", "证据来源 / 本地位置"),
            field("evidence", "对应当前正文的证据内容", "textarea", {
              help: "填写可复核的观察、摘录或结果正文；仅填写来源地址不足以标记为已验证。",
            }),
            field("verified", "标记为已验证", "checkbox", {
              help: "正文、标题或证据变更后会撤回勾选；如已重新核验证据，可再次明确勾选。",
            }),
          ];
          values = {
            ...values,
            source:
              item?.source ||
              (typeof item?.evidence === "object" && !Array.isArray(item.evidence)
                ? item.evidence?.source
                : "") ||
              "",
            evidence: knowledgeEvidenceText(item?.evidence),
            verified: Boolean(item?.verified),
          };
        }
        openForm(
          `${item ? "编辑" : "新建"}${schema.label}`,
          fields,
          values,
          async (data) => {
            if (name === "findings" && !data.assetId) delete data.assetId;
            if (name === "assets") {
              data.ports = data.ports.trim()
                ? data.ports.split(/[,，\s]+/).map((value) => {
                    const number = Number(value);
                    if (!Number.isInteger(number) || number < 1 || number > 65535)
                      throw new Error("端口必须是 1 到 65535 的整数，多个端口用逗号分隔");
                    return number;
                  })
                : [];
              for (const key of ["domains", "fingerprints", "sources"])
                data[key] = data[key]
                  .split("\n")
                  .map((value) => value.trim())
                  .filter(Boolean);
              for (const key of ["scope", "segment", "status", "priority"]) {
                data[key] = data[key].trim();
                if (!data[key]) delete data[key];
              }
              if (data.priority !== undefined && /^(0|[1-9]\d*)$/.test(data.priority)) {
                data.priority = Number(data.priority);
                if (!Number.isSafeInteger(data.priority))
                  throw new Error("优先级数字超出安全整数范围");
              }
            }
            if (["assets", "knowledge"].includes(name))
              data.tags = data.tags
                .split(/[,，]/)
                .map((value) => value.trim())
                .filter(Boolean);
            const contentChanged = Boolean(
              item && (data.content !== item.content || data.title !== item.title),
            );
            if (name === "knowledge") {
              const unchangedEvidence =
                item && data.evidence === values.evidence && data.source === values.source;
              data.evidence = unchangedEvidence
                ? item.evidence
                : { source: data.source, content: data.evidence };
            }
            const result = await api(`${name}.save`, {
              ...payload,
              ...data,
              ...(savedId ? { id: savedId } : {}),
            });
            savedId = result.item.id;
            if (name === "knowledge") {
              let read;
              try {
                read = await api("knowledge.list");
              } catch (error) {
                throw new Error(`条目已保存，但验证状态读回失败：${error.message}`);
              }
              const actual = read.items.find((entry) => entry.id === result.item.id);
              if (!actual) throw new Error("条目已保存，但未能从列表中读回，请重新读取确认状态");
              state.knowledgeReadback = {
                title: actual.title,
                verified: actual.verified,
                contentChanged,
              };
            }
            if (name === "workspaces") await refreshProjects();
          },
          name === "knowledge"
            ? {
                note: "验证标记是本地知识记录；需要对应当前内容的正文证据。修改后以服务端读回状态为准。",
                afterOpen(dialog) {
                  for (const key of ["title", "content", "source", "evidence"])
                    $(`[name="${key}"]`, dialog).addEventListener("input", () => {
                      $('[name="verified"]', dialog).checked = false;
                    });
                },
              }
            : name === "assets"
              ? {
                  note: "台账按地址与类型归并。端口、域名、指纹和来源会追加合并，空白不会删除已有观察记录。",
                }
              : {},
        );
      };
      $("#create").onclick = () => edit();
      $("#search").onchange = (e) => {
        state.query = e.target.value;
        render();
      };
      if (name === "rules")
        $("#reset-rules").onclick = (e) =>
          run(e.target, async () => {
            await api("rules.reset");
            await render();
          });
      if (name === "knowledge") {
        $("#knowledge-filters").onsubmit = (e) => {
          e.preventDefault();
          state.knowledgeFilters = Object.fromEntries(new FormData(e.target));
          render();
        };
        $("#clear-knowledge-filters").onclick = () => {
          state.knowledgeFilters = { kind: "", tags: "", verified: "" };
          state.query = "";
          render();
        };
      }
      if (name === "assets") {
        $("#asset-filters").onsubmit = (e) => {
          e.preventDefault();
          state.assetFilters = Object.fromEntries(new FormData(e.target));
          render();
        };
        $("#clear-asset-filters").onclick = () => {
          state.assetFilters = { scope: "", status: "", type: "" };
          state.query = "";
          render();
        };
        $("#import-assets").onclick = () => $("#asset-import-file").click();
        $("#asset-import-file").onchange = (e) =>
          run($("#import-assets"), async () => {
            const file = e.target.files[0];
            if (!file) return;
            state.assetImportError = null;
            state.assetImport = null;
            try {
              if (file.size > 72 * 1024 * 1024)
                throw new Error("JSON 文件超过服务的 72 MiB 请求上限，请拆分后导入");
              let parsed;
              try {
                parsed = JSON.parse(await file.text());
              } catch {
                throw new Error("文件不是有效的 JSON，尚未导入任何资产");
              }
              const imports = Array.isArray(parsed) ? parsed : parsed?.items;
              if (!Array.isArray(imports))
                throw new Error("导入格式必须是资产数组，或包含 items 数组的对象");
              const result = await api("assets.import", { ...payload, items: imports });
              state.assetImport = {
                workspaceId: payload.workspaceId,
                filename: file.name,
                added: result.added,
                merged: result.merged,
                rejected: result.rejected,
                results: result.results.map((row) => ({
                  row: row.index + 1,
                  name: row.item?.name || imports[row.index]?.name || "—",
                  address: row.item?.address || imports[row.index]?.address || "—",
                  status: row.status,
                  error: row.error ? `[${row.error.code}] ${row.error.message}` : "—",
                })),
              };
              toast(
                `导入结果：新增 ${result.added}，合并 ${result.merged}，拒绝 ${result.rejected}`,
              );
              await render();
            } catch (error) {
              state.assetImportError = { workspaceId: payload.workspaceId, message: error.message };
              await render();
              throw error;
            }
          });
      }
      $$("[data-act]").forEach(
        (b) =>
          (b.onclick = () => {
            const item = filtered[Number(b.dataset.index)];
            if (b.dataset.act === "edit") edit(item);
            else if (b.dataset.act === "services")
              run(b, async () => {
                const read = await api("assets.list", payload);
                const actual = read.items.find((asset) => asset.id === item.id);
                if (!actual) throw new Error("资产未能读回，请刷新台账");
                const services = (actual.services || []).map((service) => ({
                  ...service,
                  endpoint: `${service.protocol}/${service.port}`,
                  software: [service.product, service.version].filter(Boolean).join(" "),
                }));
                const dialog = $("#editor");
                dialog.innerHTML = `<div class="dialoghead"><h2>${esc(actual.name)} · 服务详情</h2><button id="close-service-detail" class="quiet">关闭</button></div><p class="info">${esc(redactCell(actual.address))} · 已从当前项目台账读回。服务按协议与端口合并，不代表已执行探测。</p>${
                  services.length
                    ? table(services, [
                        ["endpoint", "协议 / 端口"],
                        ["name", "服务"],
                        ["software", "产品版本"],
                        ["fingerprints", "指纹"],
                        ["sources", "来源"],
                        ["id", "服务 ID"],
                      ])
                    : empty("暂无登记服务", "可通过资产 JSON 导入已有服务记录。")
                }`;
                $("#close-service-detail").onclick = () => dialog.close();
                dialog.showModal();
              });
            else if (["assess", "test"].includes(b.dataset.act))
              openForm(
                b.dataset.act === "assess" ? "记录资产评估" : "记录测试结果",
                [
                  field("summary", "结果摘要", "text", { required: true }),
                  field("status", "状态", "select", { options: ["未测试", "进行中", "已完成"] }),
                  field("evidence", "证据说明", "textarea"),
                ],
                {},
                (data) => api(`assets.${b.dataset.act}`, { ...payload, id: item.id, ...data }),
                { note: "仅登记已发生的评估与测试结果，不会发起远程扫描或发送测试请求。" },
              );
            else if (b.dataset.act === "delete")
              confirmAction(
                `删除${schema.label}`,
                `将删除“${item.name || item.title}”。删除后无法从界面恢复。`,
                () => api(`${name}.delete`, { id: item.id }),
              );
            else
              run(b, async () => {
                await api(`${name}.${b.dataset.act}`, { id: item.id });
                if (name === "workspaces") await refreshProjects();
                toast(b.dataset.act === "use" ? "已记录知识条目使用次数" : "已激活");
                await render();
              });
          }),
      );
    },
  };
}
async function overviewPage() {
  await refreshStatus();
  const data = state.workspaceId
    ? await Promise.all([
        api("assets.list", workspacePayload()),
        api("findings.list", workspacePayload()),
        api("records.list", { ...workspacePayload(), kind: "stage" }),
        api("report.build", workspacePayload()),
      ])
    : [{ items: [] }, { items: [] }, { items: [] }, { stats: {} }];
  const [assets, findings, stages, report] = data;
  const high = findings.items.filter((f) => ["critical", "high"].includes(f.severity)).length;
  const enabled = state.status.enabled;
  const project = state.workspaces.find((p) => p.id === state.workspaceId);
  return {
    html:
      heading('<button id="refresh-overview">↻ 刷新状态</button>') +
      `<div class="statushero"><span class="herosymbol">${enabled ? "✓" : "⌘"}</span><div><strong>${enabled ? "运行控制已启用" : "运行控制待应用"}</strong><p>${enabled ? "当前控制已注册至宿主；设置按模型步骤读取，实际支持以能力检测为准。" : "请检查提示词与权限选项，再明确应用到当前宿主。"}</p></div><div class="herobuttons"><span class="tag ${enabled ? "" : "orange"}"><i class="dot ${enabled ? "" : "off"}"></i>${enabled ? "ACTIVE" : "STANDBY"}</span><button id="open-control" class="small">控制台 ↗</button></div></div><div class="metrics">${[
        ["资产总量", assets.items.length, "当前项目中的已登记资产", "⊞"],
        ["漏洞发现", findings.items.length, `${high} 项严重 / 高危发现`, "⚑"],
        [
          "已获分值",
          report.stats?.scoreEarned ?? 0,
          `基准分 ${report.stats?.scoreTotal ?? 0} · 按资产与服务去重计分`,
          "◴",
        ],
        [
          "演练阶段",
          stages.items.length,
          `${stages.items.filter((s) => (s.data || s).status === "complete").length} 个阶段已完成`,
          "≡",
        ],
      ]
        .map(
          ([label, value, foot, icon]) =>
            `<div class="metric"><div class="metriclabel">${label}<span class="metricicon">${icon}</span></div><div class="metricvalue">${value}</div><div class="metricfoot">${foot}</div></div>`,
        )
        .join("")}</div><div class="grid2"><div>${panel(
        "近期漏洞发现",
        findings.items.length
          ? table(findings.items.slice(-5).reverse(), [
              ["title", "漏洞名称"],
              ["severity", "严重度"],
              ["status", "状态"],
            ])
          : empty("还没有漏洞发现", "确认发现后，可在漏洞台账中记录证据。"),
        "当前项目",
      )}${panel(
        "演练进展",
        stages.items.length
          ? stages.items
              .slice(0, 4)
              .map((raw) => {
                const s = raw.data || raw;
                return `<div class="listrow"><div class="grow"><strong>${esc(s.name || "未命名阶段")}</strong><div class="progressline"><i style="width:${Math.min(100, Math.max(0, Number(s.progress) || 0))}%"></i></div></div>${badge(s.status || "planned")}</div>`;
              })
              .join("")
          : empty("阶段计划尚未建立", "进入「阶段与评分」定义当前演练目标。"),
      )}</div><div>${panel("当前演练项目", project ? `<div class="eyebrow">ACTIVE WORKSPACE</div><h3 style="font-size:18px;font-weight:500;margin:0 0 16px">${esc(project.name)}</h3><div class="twocoltext"><span>授权范围</span><span>${esc(project.scope || "未填写")}</span></div><div class="twocoltext"><span>授权依据</span><span>${esc(project.authorization || "未填写")}</span></div><div class="note" style="margin-bottom:0">仅在已获授权范围内开展演练。这里的台账与证据记录不会自动执行远程操作。</div>` : empty("尚未激活项目", "先建立项目与授权范围，资产和证据会按项目隔离。"))}${panel("环境速览", `<div class="twocoltext"><span>宿主版本</span><span>${esc(state.status.host?.version || "未知")}</span></div><div class="twocoltext"><span>运行平台</span><span>${esc(state.status.host?.platform || "未知")}</span></div><div class="twocoltext"><span>宿主会话</span><span>${state.status.sessions?.length || 0} 个</span></div><div class="twocoltext"><span>更新方式</span><span>本地离线维护</span></div><button class="small" id="view-environment">查看环境详情 ↗</button>`)}</div></div>`,
    bind() {
      $("#refresh-overview").onclick = (e) => run(e.target, render);
      $("#open-control").onclick = () => navigate("control");
      $("#view-environment").onclick = () => navigate("environment");
    },
  };
}
async function controlPage() {
  const settings = await api("settings.get");
  state.settings = settings;
  const v = { ...defaults, ...settings.value };
  const switchRow = (key, title, desc) => {
    const ids = {
      fullAccess: "sandbox",
      autoApprove: "approval",
      hooksDeny: "hooks",
      autoReapply: "autoReapply",
    };
    const available = can(ids[key]);
    return `<div class="switchrow"><div><strong>${title}</strong><p>${desc}${available ? "" : " · 当前宿主未提供此能力，保存值暂不生效。"}</p></div><input class="switch" type="checkbox" name="${key}" aria-label="${title}" ${v[key] ? "checked" : ""} ${available ? "" : "disabled"}></div>`;
  };
  return {
    html:
      heading(
        `${capabilityButton("control.revert", "还原运行控制", 'id="revert-control" class="danger"')}${capabilityButton("control.apply", "应用运行控制", 'id="apply-control" class="primary"')}`,
      ) +
      `<form id="settings-form"><div class="grid2"><div>${panel(
        "系统提示词",
        `<div class="toolbar">${renderField(
          field("promptMode", "提示词模式", "select", {
            options: [
              ["replace", "替换宿主提示词"],
              ["append", "追加到宿主提示词"],
            ],
          }),
          v.promptMode,
        )}</div><div class="field"><label for="prompt-text">提示词内容</label><textarea class="code" name="prompt" id="prompt-text" rows="12" placeholder="编写当前工作方式、任务边界与输出要求…">${esc(v.prompt)}</textarea><small>保存更新本地配置；已启用的能力会在后续步骤读取新值，首次使用需要应用运行控制。</small></div>`,
      )}${panel(
        "工作区规则策略",
        `<div class="fields">${renderField(
          field("workspacePolicy", "加载策略", "select", {
            options: [
              ["fallback", "正文为空时使用所选规则"],
              ["strict", "忽略所选规则"],
              ["always", "合并所选规则"],
            ],
          }),
          v.workspacePolicy,
        )}<div class="field wide"><label for="workspace-files">规则文件路径 · 每行一个</label><textarea name="workspaceFiles" id="workspace-files" rows="4">${esc(v.workspaceFiles.join("\n"))}</textarea><small>此策略仅控制本插件主动选取的规则文件；宿主原生工作区指令的运行上下文会保留。</small></div></div><div class="toolbar" style="margin-bottom:0"><button type="button" id="scan-rules">扫描工作区规则</button><button type="button" id="select-rule-paths">设置选定文件</button></div>`,
      )}${panel("用户自有服务器清单", `<div class="field"><label for="own-servers">用户自有服务器 · 每行一个</label><textarea name="ownServers" id="own-servers" rows="3">${esc(v.ownServers.join("\n"))}</textarea><small>仅保存用户自有服务器范围名单；当前尚未强制执行该范围，保存不表示出口或目标访问控制已经生效。</small></div>`)}</div><div>${panel("权限与执行", `${switchRow("fullAccess", "完整访问权限", "请求宿主支持的完整访问策略。")}${switchRow("autoApprove", "自动审批", "开启后可减少执行前的人工审批。")}${switchRow("hooksDeny", "禁用拦截钩子", "按宿主暴露的能力管理钩子策略。")}${switchRow("autoReapply", "设置变更后重新应用", "启用时按运行时生命周期重新注册控制。")}<div class="note" style="margin:17px 0 0">完整访问和自动审批会改变当前执行边界。请在应用前检查具体授权范围。</div>`)}${panel(
        "执行限额",
        `<div class="fields">${[
          field("maxSubagents", "最大子代理数", "number", { min: 0 }),
          field("maxDepth", "最大递归深度", "number", { min: 0 }),
          field("readLimit", "读取上限（字节）", "number", { min: 0 }),
          field("retryLimit", "重试次数", "number", { min: 0 }),
        ]
          .map((f) => {
            const id = {
              maxSubagents: "subagents",
              maxDepth: "subagents",
              readLimit: "readLimit",
              retryLimit: "retryLimit",
            }[f.name];
            return renderField(
              {
                ...f,
                disabled: !can(id),
                help: can(id) ? "" : "宿主未提供此能力；当前保存值暂不生效。",
              },
              v[f.name],
            );
          })
          .join("")}</div>`,
      )}<div class="panel"><div class="panelheading"><h2>保存当前配置</h2><span class="meta" id="settings-revision">revision ${settings.revision}</span></div><p class="info">配置采用版本校验。若其他窗口已修改配置，请刷新后重新编辑。</p><p id="settings-error" class="inlineerror" role="alert"></p><button class="primary" type="submit" style="width:100%">保存配置</button></div></div></div></form>`,
    bind() {
      const read = () => {
        const form = $("#settings-form");
        const values = { ...v };
        new FormData(form).forEach((value, key) => {
          values[key] = value;
        });
        ["fullAccess", "autoApprove", "hooksDeny", "autoReapply"].forEach(
          (key) => (values[key] = form.elements[key].checked),
        );
        ["maxSubagents", "maxDepth", "readLimit", "retryLimit"].forEach(
          (key) => (values[key] = Number(values[key])),
        );
        ["workspaceFiles", "ownServers"].forEach(
          (key) =>
            (values[key] = values[key]
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)),
        );
        return values;
      };
      const save = async () => {
        try {
          state.settings = await api("settings.save", {
            revision: state.settings.revision,
            value: read(),
          });
          $("#settings-revision").textContent = `revision ${state.settings.revision}`;
          toast("配置已保存");
          return state.settings;
        } catch (e) {
          $("#settings-error").textContent = e.message;
          throw e;
        }
      };
      $("#settings-form").onsubmit = (e) => {
        e.preventDefault();
        run($("button[type=submit]", e.target), save);
      };
      $("#apply-control").onclick = () =>
        confirmAction(
          "应用运行控制",
          "将先保存当前表单配置，再向宿主注册本插件的运行控制。请确认权限与审批选项符合当前任务授权。",
          async () => {
            await save();
            await api("control.apply");
            await refreshStatus();
          },
        );
      $("#revert-control").onclick = () =>
        confirmAction(
          "还原运行控制",
          "将撤销本插件拥有的运行时注册。已保存配置会保留。",
          async () => {
            await api("control.revert");
            await refreshStatus();
          },
        );
      $("#scan-rules").onclick = () =>
        openForm(
          "扫描工作区规则",
          [field("directory", "本地工作区目录", "text", { required: true })],
          {},
          async (data) => {
            const result = await api("rules.workspace", data);
            const paths = result.items;
            const list = paths.map((i) => i.path).filter(Boolean);
            if (list.length) {
              $("#workspace-files").value = list.join("\n");
              toast(`发现 ${list.length} 个规则文件`);
            } else toast("未发现规则文件");
          },
          { submit: "扫描", keepPage: true, success: "扫描结果已填入表单，尚未保存配置" },
        );
      $("#select-rule-paths").onclick = (e) =>
        run(e.target, async () => {
          state.settings = await api("rules.select", { paths: read().workspaceFiles });
          $("#settings-revision").textContent = `revision ${state.settings.revision}`;
          toast("已更新选定规则文件");
        });
    },
  };
}
async function encodeSkillFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
async function skillsPage() {
  const data = await api("skills.list");
  const items = data.items;
  const result = state.skillImport;
  const feedback = result
    ? result.error
      ? `<div class="error" role="alert">技能导入“${esc(redactCell(result.source))}”未完成：${esc(result.error)}</div>`
      : panel(
          "技能导入结果",
          `<div class="note">服务端已导入 ${result.items.length} 个技能、${result.importedFiles} 个文件。${result.selectedFiles !== null ? `已选择 ${result.selectedFiles} 个文件；技能根目录之外的文件不会导入。` : ""}</div>${table(
            result.items,
            [
              ["name", "技能名称"],
              ["files", "实际文件数"],
              ["bytes", "实际字节数"],
              ["id", "目录标识"],
            ],
          )}`,
          result.source,
        )
    : "";
  return {
    html:
      heading(
        `${capabilityButton("skills.import", "导入文件夹", 'id="import-skill-folder"')}${capabilityButton("skills.import", "导入文件", 'id="import-skill"')}${capabilityButton("skills.save", "＋ 新建技能", 'id="create-skill" class="primary"')}`,
      ) +
      `<input type="file" id="skill-file" accept=".zip,.md" hidden><input type="file" id="skill-folder" webkitdirectory directory multiple hidden>` +
      feedback +
      panel(
        "本地技能",
        `<div class="note">可导入技能文件夹、ZIP 或 Markdown。文件夹最多 512 个文件 / 50 MiB，SKILL.md 最大 256 KiB，ZIP 最大 12 MiB。名称与说明以 SKILL.md 的 YAML 元信息为准。</div>${
          items.length
            ? table(
                items,
                [
                  ["name", "技能名称"],
                  ["description", "用途"],
                  ["id", "目录标识"],
                ],
                (item, index) =>
                  `<button class="small quiet" data-skill-edit="${index}" ${can("skills.read") ? "" : "disabled"}>查看 / 编辑</button><button class="small quiet danger" data-skill-delete="${index}" ${can("skills.delete") ? "" : "disabled"}>删除</button>`,
              )
            : empty("技能目录为空", "新建技能，或导入本地技能文件夹 / Markdown / ZIP。")
        }`,
      ),
    bind() {
      const edit = async (item) => {
        if (item) item = (await api("skills.read", { id: item.id })).item;
        const fields = item
          ? [
              field("id", "技能目录标识", "text", { readonly: true }),
              field("content", "完整 SKILL.md · 含 YAML 元信息", "textarea", { required: true }),
            ]
          : [
              field("name", "技能名称 / 目录标识", "text", {
                required: true,
                pattern: "[a-z0-9]+(-[a-z0-9]+)*",
                help: "例如 evidence-review，仅接受小写 kebab-case。",
              }),
              field("description", "用途说明", "text", { required: true }),
              field("content", "技能正文", "textarea", { required: true }),
            ];
        openForm(
          item ? "编辑技能" : "新建技能",
          fields,
          item || {},
          (data) => api("skills.save", data),
          {
            note: item
              ? "名称与用途说明请在顶部 YAML 中修改；正文之外的资源文件会保留。"
              : "保存时自动生成包含名称和用途说明的 YAML 元信息。",
          },
        );
      };
      $("#create-skill").onclick = (e) => run(e.target, () => edit());
      $$("[data-skill-edit]").forEach(
        (b) => (b.onclick = () => run(b, () => edit(items[Number(b.dataset.skillEdit)]))),
      );
      $$("[data-skill-delete]").forEach(
        (b) =>
          (b.onclick = () => {
            const item = items[Number(b.dataset.skillDelete)];
            confirmAction(
              "删除技能",
              `将“${item.name}”移入本地备份目录，技能列表中不再显示。`,
              () => api("skills.delete", { id: item.id }),
            );
          }),
      );
      const importFiles = async (files, folder) => {
        if (!files.length) return;
        state.skillImport = null;
        const importButtons = [$("#import-skill"), $("#import-skill-folder")];
        importButtons.forEach((button) => (button.disabled = true));
        const source = folder
          ? files[0].webkitRelativePath.split("/")[0] || "已选文件夹"
          : files[0].name;
        try {
          let payload;
          if (folder) {
            if (files.length > 512) throw new Error("文件夹超过 512 个文件，请缩小导入范围");
            if (files.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024)
              throw new Error("文件夹内容超过 50 MiB");
            if (!files.some((file) => file.name === "SKILL.md"))
              throw new Error("文件夹内没有 SKILL.md，请选择技能根目录或包含技能的父目录");
            const contents = [];
            for (const file of files) {
              if (file.name === "SKILL.md" && file.size > 256 * 1024)
                throw new Error("SKILL.md 超过 256 KiB，请精简正文或移入参考文件");
              contents.push({
                path: file.webkitRelativePath,
                contentBase64: await encodeSkillFile(file),
              });
            }
            payload = { files: contents };
          } else {
            const file = files[0];
            const zipped = file.name.toLowerCase().endsWith(".zip");
            if (!zipped && !file.name.toLowerCase().endsWith(".md"))
              throw new Error("请选择 ZIP 或 Markdown 文件");
            if (file.size > (zipped ? 12 * 1024 * 1024 : 256 * 1024))
              throw new Error(zipped ? "ZIP 超过 12 MiB" : "SKILL.md 正文超过 256 KiB");
            const contentBase64 = await encodeSkillFile(file);
            payload = zipped
              ? { filename: file.name, contentBase64 }
              : { files: [{ path: "SKILL.md", contentBase64 }] };
          }
          const imported = await api("skills.import", payload);
          const summaries = imported.items.map((item) => ({
            id: item.id,
            name: item.name,
            files: item.files.length,
            bytes: item.bytes,
          }));
          state.skillImport = {
            source,
            selectedFiles: folder ? files.length : payload.files ? 1 : null,
            importedFiles: summaries.reduce((sum, item) => sum + item.files, 0),
            items: summaries,
          };
          toast(`已导入 ${summaries.length} 个技能`);
          await render();
        } catch (error) {
          state.skillImport = { source, error: error.message };
          await render();
          throw error;
        } finally {
          importButtons.forEach((button) => {
            if (button.isConnected) button.disabled = !can("skills.import");
          });
        }
      };
      $("#import-skill").onclick = () => $("#skill-file").click();
      $("#import-skill-folder").onclick = () => $("#skill-folder").click();
      $("#skill-file").onchange = (e) =>
        run($("#import-skill"), () => importFiles([...e.target.files], false));
      $("#skill-folder").onchange = (e) =>
        run($("#import-skill-folder"), () => importFiles([...e.target.files], true));
    },
  };
}
async function evidencePage(kind = state.recordKind, embedded = false) {
  if (!embedded && ["stage", "score-point", "score-hit"].includes(kind)) kind = "credential";
  const payload = { ...workspacePayload(), kind };
  const data = await api("records.list", payload);
  const items = data.items.map((item) => ({ ...item.data, ...item }));
  let fields = recordFields[kind];
  let points = [],
    assets = [],
    stages = [];
  if (["score-point", "score-hit"].includes(kind)) {
    const requests = await Promise.all([
      api("records.list", { ...workspacePayload(), kind: "stage" }),
      ...(kind === "score-hit"
        ? [
            api("records.list", { ...workspacePayload(), kind: "score-point" }),
            api("assets.list", workspacePayload()),
          ]
        : []),
    ]);
    stages = requests[0].items;
    if (kind === "score-point")
      fields = [
        ...fields,
        field("stageId", "所属阶段", "select", {
          options: [
            ["", "不关联阶段"],
            ...stages.map((stage) => [stage.id, stage.data.name || stage.id]),
          ],
        }),
      ];
    else {
      points = requests[1].items;
      assets = requests[2].items;
      fields = [
        field("name", "命中名称"),
        field("pointId", "关联得分点", "select", {
          required: true,
          options: points.map((point) => [
            point.id,
            point.data.name || point.data.title || point.id,
          ]),
        }),
        field("assetId", "关联资产", "select", {
          options: [["", "未指定资产"], ...assets.map((asset) => [asset.id, asset.name])],
        }),
        field("serviceId", "登记服务", "select", { options: [["", "未选服务（可手动填写端口）"]] }),
        field("port", "端口 · 留空按资产计分", "number", { optional: true, min: 1, max: 65535 }),
        field("protocol", "协议", "select", { options: ["tcp", "udp"] }),
        field("notes", "命中证据", "textarea"),
      ];
    }
  }
  const shown = items.map((item) =>
    kind === "score-hit"
      ? {
          ...item,
          pointLabel:
            points.find((point) => point.id === item.pointId)?.data.name ||
            points.find((point) => point.id === item.pointId)?.data.title ||
            item.pointId,
          assetLabel: assets.find((asset) => asset.id === item.assetId)?.name || "未指定资产",
          targetLabel:
            item.port !== undefined
              ? `${item.protocol || "tcp"}/${item.port}`
              : item.serviceId
                ? (assets.find((asset) => asset.id === item.assetId)?.services || [])
                    .filter((service) => service.id === item.serviceId)
                    .map((service) => `${service.protocol}/${service.port}`)
                    .join("") || item.serviceId
                : "资产级",
        }
      : kind === "score-point"
        ? {
            ...item,
            stageLabel:
              stages.find((stage) => stage.id === item.stageId)?.data.name ||
              item.stage ||
              "未分阶段",
          }
        : item,
  );
  const columns =
    kind === "score-hit"
      ? [
          ["name", "命中名称"],
          ["pointLabel", "得分点"],
          ["assetLabel", "资产"],
          ["targetLabel", "计分目标"],
        ]
      : kind === "score-point"
        ? [
            ["name", "得分点名称"],
            ["points", "基准分值"],
            ["stageLabel", "阶段"],
          ]
        : fields
            .filter((f) => !["textarea", "password"].includes(f.type))
            .slice(0, 4)
            .map((f) => [f.name, f.label]);
  const noPoints = kind === "score-hit" && !points.length;
  return {
    html:
      (embedded ? "" : heading('<button class="primary" id="create-record">＋ 新增证据</button>')) +
      panel(
        embedded ? kinds[kind] : "本地证据记录",
        `${
          embedded
            ? ""
            : `<div class="tabs" role="group" aria-label="证据类型">${Object.entries(kinds)
                .filter(([key]) => !["stage", "score-point", "score-hit"].includes(key))
                .map(
                  ([key, label]) =>
                    `<button data-kind="${key}" class="${kind === key ? "selected" : ""}">${label}</button>`,
                )
                .join(
                  "",
                )}</div><div class="note">这是本地证据台账。记录凭据、隧道或 WebShell 信息不会连接目标或执行操作；敏感字段仅在编辑时显示。</div>`
        }${noPoints ? '<div class="note">请先在「得分点」中创建计分点，再记录命中。</div>' : ""}${shown.length ? table(shown, columns, (item, index) => `<button class="small quiet" data-record-edit="${index}">编辑</button><button class="small quiet danger" data-record-delete="${index}">删除</button>`) : empty(`暂无${kinds[kind]}记录`)}${embedded ? `<button id="create-record" style="margin-top:15px" class="small" ${noPoints ? 'disabled title="请先创建得分点"' : ""}>＋ 新增记录</button>` : ""}`,
      ),
    bind() {
      const edit = (item) => {
        const values = { ...item };
        const dynamic =
          kind === "score-hit"
            ? fields.map((f) =>
                f.name === "serviceId"
                  ? {
                      ...f,
                      options: [
                        ["", "未选服务（可手动填写端口）"],
                        ...(assets.find((asset) => asset.id === item?.assetId)?.services || []).map(
                          (service) => [
                            service.id,
                            `${service.protocol}/${service.port}${service.name ? " · " + service.name : ""}`,
                          ],
                        ),
                      ],
                    }
                  : f,
              )
            : fields;
        openForm(
          `${item ? "编辑" : "新增"}${kinds[kind]}`,
          dynamic,
          values,
          async (input) => {
            const outgoing = { ...item?.data, ...input };
            if (["score-point", "score-hit"].includes(kind) && !outgoing.stageId)
              delete outgoing.stageId;
            if (kind === "score-hit") {
              if (!outgoing.assetId) delete outgoing.assetId;
              if (!outgoing.serviceId) delete outgoing.serviceId;
              const service = assets
                .find((asset) => asset.id === outgoing.assetId)
                ?.services?.find((entry) => entry.id === outgoing.serviceId);
              if (service) {
                outgoing.port = service.port;
                outgoing.protocol = service.protocol;
              } else if (input.port === undefined) {
                delete outgoing.port;
                delete outgoing.protocol;
              }
              if (outgoing.port !== undefined) {
                if (!Number.isInteger(outgoing.port) || outgoing.port < 1 || outgoing.port > 65535)
                  throw new Error("计分端口必须是 1 到 65535 的整数");
                if (!outgoing.assetId) throw new Error("按服务或端口计分前，请先选择当前项目资产");
              }
            }
            await api("records.save", {
              ...payload,
              ...(item ? { id: item.id } : {}),
              data: outgoing,
            });
          },
          {
            note:
              kind === "score-hit"
                ? "同一得分点按资产与服务分别累计；相同资产、协议和端口的重复命中只计一次。"
                : "仅保存本地记录；不会触发远程操作。",
            afterOpen(dialog) {
              if (kind !== "score-hit") return;
              const assetInput = $('[name="assetId"]', dialog),
                serviceInput = $('[name="serviceId"]', dialog),
                portInput = $('[name="port"]', dialog),
                protocolInput = $('[name="protocol"]', dialog);
              const chooseService = () => {
                const service = assets
                  .find((asset) => asset.id === assetInput.value)
                  ?.services?.find((entry) => entry.id === serviceInput.value);
                portInput.readOnly = Boolean(service);
                protocolInput.disabled = Boolean(service);
                if (service) {
                  portInput.value = String(service.port);
                  protocolInput.value = service.protocol;
                }
              };
              assetInput.onchange = () => {
                const services =
                  assets.find((asset) => asset.id === assetInput.value)?.services || [];
                serviceInput.innerHTML = `<option value="">未选服务（可手动填写端口）</option>${services.map((service) => `<option value="${esc(service.id)}">${esc(`${service.protocol}/${service.port}${service.name ? " · " + service.name : ""}`)}</option>`).join("")}`;
                portInput.value = "";
                chooseService();
              };
              serviceInput.onchange = chooseService;
              chooseService();
            },
          },
        );
      };
      $("#create-record").onclick = () => edit();
      $$("[data-kind]").forEach(
        (b) =>
          (b.onclick = () => {
            state.recordKind = b.dataset.kind;
            render();
          }),
      );
      $$("[data-record-edit]").forEach(
        (b) => (b.onclick = () => edit(items[Number(b.dataset.recordEdit)])),
      );
      $$("[data-record-delete]").forEach(
        (b) =>
          (b.onclick = () =>
            confirmAction("删除证据", `将永久删除此${kinds[kind]}记录。`, () =>
              api("records.delete", { ...payload, id: items[Number(b.dataset.recordDelete)].id }),
            )),
      );
    },
  };
}
async function graphPage() {
  const payload = workspacePayload();
  const data = await api("assets.graph", payload);
  const timeline = await api("assets.timeline", payload);
  const nodes = data.nodes || [],
    edges = data.edges || [];
  const width = 950,
    height = 470;
  const positions = new Map(
    nodes.map((n, i) => [
      n.id,
      {
        x:
          width / 2 +
          (nodes.length === 1
            ? 0
            : Math.cos((i / nodes.length) * 2 * Math.PI - Math.PI / 2) *
              Math.min(330, 70 + nodes.length * 25)),
        y:
          height / 2 +
          (nodes.length === 1
            ? 0
            : Math.sin((i / nodes.length) * 2 * Math.PI - Math.PI / 2) *
              Math.min(165, 55 + nodes.length * 15)),
      },
    ]),
  );
  const svg = nodes.length
    ? `<svg class="graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="当前项目资产关系图"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="24" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8" fill="none" stroke="#97a78c"/></marker></defs>${edges
        .map((edge) => {
          const a = positions.get(edge.from),
            b = positions.get(edge.to);
          if (!a || !b) return "";
          return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#b5c0a8" marker-end="url(#arrow)"/><text x="${(a.x + b.x) / 2}" y="${(a.y + b.y) / 2 - 7}" text-anchor="middle" fill="#87977a">${esc(edge.relation)}</text>`;
        })
        .join("")}${nodes
        .map((n) => {
          const p = positions.get(n.id);
          return `<g><circle cx="${p.x}" cy="${p.y}" r="24" fill="#e8efe0" stroke="#9eb68c"/><text x="${p.x}" y="${p.y + 5}" text-anchor="middle" fill="#536e44">⊞</text><text x="${p.x}" y="${p.y + 43}" text-anchor="middle" fill="#4f6245">${esc(n.name || n.address || n.id).slice(0, 80)}</text></g>`;
        })
        .join("")}</svg>`
    : empty("图谱中还没有资产", "先登记资产，再添加资产之间的关系。");
  return {
    html:
      heading('<button id="link-assets" class="primary">＋ 添加关系</button>') +
      panel("资产关系", svg, `${nodes.length} 个节点 · ${edges.length} 条关系`) +
      panel(
        "资产时间线",
        (timeline.items || []).length
          ? timeline.items
              .slice(-12)
              .reverse()
              .map(
                (item) =>
                  `<div class="auditline"><div><strong>${esc({ "asset.created": "资产登记", "asset.updated": "资产更新", "asset.linked": "关系登记", "assets.assess": "评估记录", "assets.test": "测试结果记录" }[item.kind] || item.kind)}</strong><p>${esc(item.data.summary || item.data.evidence || item.data.relation || "")} · ${esc(time(item.createdAt || item.time))}</p></div></div>`,
              )
              .join("")
          : empty("尚无资产事件", "资产与关系变更后，时间线会显示对应记录。"),
      ),
    bind() {
      $("#link-assets").disabled = nodes.length < 2;
      $("#link-assets").onclick = () =>
        openForm(
          "添加资产关系",
          [
            field("from", "来源资产", "select", {
              options: nodes.map((n) => [n.id, n.name || n.id]),
            }),
            field("to", "目标资产", "select", {
              options: nodes.map((n) => [n.id, n.name || n.id]),
            }),
            field("relation", "关系说明", "text", { required: true }),
          ],
          {},
          (data) => {
            if (data.from === data.to) throw new Error("请选择两个不同的资产");
            return api("assets.link", { ...payload, ...data });
          },
        );
    },
  };
}
async function progressPage() {
  const kind = ["stage", "score-point", "score-hit"].includes(state.recordKind)
    ? state.recordKind
    : "stage";
  const evidence = await evidencePage(kind, true);
  const report = await api("report.build", workspacePayload());
  return {
    html:
      heading() +
      `<div class="metrics" style="grid-template-columns:repeat(3,minmax(0,1fr))">${[
        ["累计得分", report.stats.scoreEarned],
        ["计分点基准分", report.stats.scoreTotal],
        ["有效计分命中", report.stats.scoreUniqueHits],
      ]
        .map(
          ([label, value]) =>
            `<div class="metric"><div class="metriclabel">${label}</div><div class="metricvalue">${value}</div><div class="metricfoot">同一计分点按资产与服务分别累计</div></div>`,
        )
        .join(
          "",
        )}</div><div class="tabs">${["stage", "score-point", "score-hit"].map((key) => `<button data-progress-kind="${key}" class="${key === kind ? "selected" : ""}">${kinds[key]}</button>`).join("")}</div>${kind === "score-hit" ? '<div class="note">同一计分点在相同资产与服务上的重复命中只计一次；不同资产或服务分别累计，累计得分可能高于计分点基准分。</div>' : ""}${evidence.html}`,
    bind() {
      evidence.bind();
      $$("[data-progress-kind]").forEach(
        (b) =>
          (b.onclick = () => {
            state.recordKind = b.dataset.progressKind;
            render();
          }),
      );
    },
  };
}
async function rolesPage() {
  const payload = workspacePayload();
  await refreshStatus();
  const [rolesResult, flowResult] = await Promise.allSettled([
    api("roles.list", payload),
    api("flow.status", payload),
  ]);
  if (rolesResult.status === "rejected") throw rolesResult.reason;
  const items = rolesResult.value.items;
  const roleNames = {
    planner: "规划者",
    recon: "信息整理",
    scanner: "扫描记录",
    validator: "验证复核",
    internal: "内部分析",
    reporter: "报告者",
    analyst: "分析者（兼容）",
    reviewer: "审查者（兼容）",
  };
  const sessions = state.status.sessions;
  const bound = sessions.filter((item) => item.workspaceId === state.workspaceId);
  const flow = flowResult.status === "fulfilled" ? flowResult.value : null;
  const rows = flow
    ? flow.assignments.map((item) => ({
        ...item,
        sessionName: sessions.find((s) => s.id === item.sessionId)?.name || item.sessionId,
        roleLabel: roleNames[item.role] || item.role,
        slotState: flow.active.some((slot) => slot.sessionId === item.sessionId)
          ? "已占用"
          : "未占用",
      }))
    : [];
  const feedback =
    state.flowFeedback?.workspaceId === payload.workspaceId
      ? `<div class="${state.flowFeedback.failed ? "error" : "note"}" role="status">${esc(state.flowFeedback.message)}</div>`
      : "";
  const flowBody = flow
    ? `<div id="flow-feedback">${feedback}</div><div class="toolbar"><span class="tag">已占用 ${flow.active.length} / ${flow.limit}</span><span class="tag gray">可用 ${flow.available}</span><button class="small" id="configure-flow">调整槽位上限</button><button class="small primary" id="assign-flow" ${bound.length ? "" : 'disabled title="请先将宿主会话明确绑定到本项目"'}>分配角色</button><button class="small quiet" id="refresh-flow">↻ 重新读取</button></div><div class="note">会话需先绑定到当前项目。分配角色与领取槽位不会启动任务。</div>${
        rows.length
          ? table(
              rows,
              [
                ["sessionName", "会话"],
                ["roleLabel", "明确角色"],
                ["slotState", "本地槽位"],
              ],
              (item, index) =>
                `<button class="small quiet" data-flow-edit="${index}">调整角色</button>${item.slotState === "已占用" ? `<button class="small" data-flow-release="${index}">释放槽位</button>` : `<button class="small" data-flow-acquire="${index}" ${flow.available > 0 ? "" : 'disabled title="槽位已满，请先释放"'}>占用本地槽位</button>`}<button class="small quiet danger" data-flow-unassign="${index}">撤销分配</button>`,
            )
          : empty(
              "尚未明确分配角色",
              bound.length
                ? "选择已绑定本项目的会话，明确角色后才能占用本地槽位。"
                : "先在会话管理中将宿主会话明确绑定到本项目。",
            )
      }<p class="info">角色分配按项目与会话保存；活动槽位只在当前本地运行实例内保留。释放槽位不会停止或启动宿主会话。</p>`
    : `<div class="error" role="alert">本地槽位接口不可用：${esc(flowResult.reason.message)}</div><button id="refresh-flow" class="small">重新读取槽位状态</button>`;
  return {
    html:
      heading('<button id="reset-roles" class="danger">重置角色提示词</button>') +
      panel("本地槽位管理", flowBody) +
      `<div class="grid2 equal">${items.map((item) => panel(roleNames[item.role] || item.role, `<div class="eyebrow">${esc(item.role.toUpperCase())}${["analyst", "reviewer"].includes(item.role) ? " · COMPATIBILITY" : ""}</div><p class="info" style="white-space:pre-wrap;max-height:210px;overflow:auto;min-height:100px">${esc(redactCell(item.content || "尚未配置提示词。", "content"))}</p><button data-role="${esc(item.role)}" class="small">编辑提示词</button>`)).join("")}</div>`,
    bind() {
      $$("[data-role]").forEach(
        (b) =>
          (b.onclick = () => {
            const item = items.find((i) => i.role === b.dataset.role);
            openForm(
              `编辑${roleNames[b.dataset.role] || b.dataset.role}提示词`,
              [field("content", "提示词内容", "textarea")],
              item,
              (data) => api("roles.save", { ...payload, role: b.dataset.role, ...data }),
            );
          }),
      );
      $("#reset-roles").onclick = () =>
        confirmAction("重置角色提示词", "当前项目的角色提示词将恢复为默认内容。", () =>
          api("roles.reset", payload),
        );
      $("#refresh-flow").onclick = render;
      if (!flow) return;
      const setFeedback = (message, failed = false) => {
        state.flowFeedback = { workspaceId: payload.workspaceId, message, failed };
        const target = $("#flow-feedback");
        if (target && state.workspaceId === payload.workspaceId)
          target.innerHTML = `<div class="${failed ? "error" : "note"}" role="${failed ? "alert" : "status"}">${esc(message)}</div>`;
      };
      $("#configure-flow").onclick = () =>
        openForm(
          "调整本地槽位上限",
          [field("limit", "槽位上限（1—10）", "number", { required: true, min: 1, max: 10 })],
          { limit: flow.limit },
          async (data) => {
            const result = await api("flow.configure", { ...payload, ...data });
            setFeedback(`本地槽位上限已读回为 ${result.limit}；当前占用 ${result.active.length}。`);
          },
          { note: "只管理本地槽位记录；若新上限低于当前占用数量，请先释放槽位。" },
        );
      const assign = (item) =>
        openForm(
          item ? "调整明确角色" : "分配会话角色",
          [
            item
              ? field("sessionId", "会话标识", "text", { readonly: true })
              : field("sessionId", "已绑定本项目的会话", "select", {
                  required: true,
                  options: bound.map((session) => [session.id, session.name || session.id]),
                }),
            field("role", "明确角色", "select", {
              required: true,
              options: items.map((role) => [role.role, roleNames[role.role] || role.role]),
            }),
          ],
          item || {},
          async (data) => {
            const result = await api("flow.assign", { ...payload, ...data });
            setFeedback(
              `已明确分配${roleNames[result.item.role] || result.item.role}角色；未启动任务。`,
            );
          },
          {
            note: "先明确会话与角色，再占用本地槽位。此操作不会自动绑定其他项目，也不会启动执行。",
          },
        );
      $("#assign-flow").onclick = () => assign();
      $$("[data-flow-edit]").forEach(
        (b) => (b.onclick = () => assign(rows[Number(b.dataset.flowEdit)])),
      );
      for (const operation of ["acquire", "release"])
        $$(`[data-flow-${operation}]`).forEach(
          (b) =>
            (b.onclick = () =>
              run(b, async () => {
                const row =
                  rows[Number(b.dataset[operation === "acquire" ? "flowAcquire" : "flowRelease"])];
                try {
                  const result = await api(`flow.${operation}`, {
                    ...payload,
                    sessionId: row.sessionId,
                  });
                  const message =
                    operation === "acquire"
                      ? result.acquired
                        ? "已占用本地槽位，未启动任务"
                        : "该会话已占用本地槽位，未重复领取"
                      : result.released
                        ? "已释放本地槽位"
                        : "该会话当前没有占用本地槽位";
                  setFeedback(message);
                  toast(message);
                  await render();
                } catch (error) {
                  setFeedback(error.message, true);
                  throw error;
                }
              })),
        );
      $$("[data-flow-unassign]").forEach(
        (b) =>
          (b.onclick = () => {
            const row = rows[Number(b.dataset.flowUnassign)];
            confirmAction(
              "撤销角色分配",
              "仅删除此会话的本地角色分配，并释放其本地槽位。不会停止宿主会话。",
              async () => {
                await api("flow.assign", { ...payload, sessionId: row.sessionId, role: null });
                setFeedback("已撤销本地角色分配；该会话不再占用槽位。");
              },
            );
          }),
      );
    },
  };
}
function download(filename, content, type = "text/markdown;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function reportsPage() {
  const data = await api("report.build", workspacePayload());
  state.report = data.markdown || "";
  return {
    html:
      heading('<button id="download-report" class="primary">↓ 导出 Markdown</button>') +
      panel(
        "项目报告",
        state.report
          ? `<div class="report">${esc(state.report)}</div>`
          : empty("报告内容为空", "记录资产、发现与证据后重新生成报告。"),
        "本地生成 · Markdown",
      ) +
      `<div class="note">导出文件可能包含敏感证据。保存到合适的本地目录，并按项目保密要求处理。</div>`,
    bind() {
      $("#download-report").disabled = !state.report;
      $("#download-report").onclick = () => {
        const project = state.workspaces.find((w) => w.id === state.workspaceId);
        download(`${(project?.name || "演练报告").replace(/[\\/:*?"<>|]/g, "_")}.md`, state.report);
        toast("已生成本地下载文件");
      };
    },
  };
}
function rewindSummary(outcome) {
  if (!outcome) return "";
  const archived = outcome.archived ? "原记录已保留并归档。" : "原会话归档未确认。";
  const restored = outcome.draftStatus === "restored";
  const title =
    outcome.draftStatus === "host-partial"
      ? "宿主回退尚未完成"
      : restored
        ? "回退分支已创建，草稿已恢复"
        : outcome.draftStatus === "pending-client"
          ? "新会话已创建，草稿恢复待确认"
          : "新会话已创建，草稿未恢复";
  return `<div class="${restored ? "note" : "error"}"><strong>${title}</strong><br>${archived}${outcome.newSessionId ? `新会话：<span class="mono">${esc(outcome.newSessionId)}</span>` : ""}<br>${restored ? "草稿已放入输入框，没有自动发送。" : ""}${outcome.error ? esc(outcome.error) : restored ? "" : "等待宿主恢复草稿。"}</div>`;
}
function openRewind(item) {
  const dialog = $("#editor");
  let fork = null;
  dialog.innerHTML = `<form id="rewind-form"><div class="dialoghead"><h2>会话回退</h2><button class="quiet small" type="button" id="close-rewind">关闭</button></div><div class="note">将通过官方 fork 路径创建新会话，保留并归档原记录，再把被移除的用户输入恢复到新会话草稿。不会自动发送。</div>${renderField(
    field("mode", "回退方式", "select", {
      options: [
        ["turn", "回退整轮 · 移除最近人工输入及后续事件"],
        ["step", "回退一步 · 回到前一步结束"],
      ],
    }),
    "turn",
  )}<div id="rewind-result"></div><p id="rewind-error" class="inlineerror" role="alert"></p><div class="dialogfoot"><button type="button" id="cancel-rewind">取消</button><button class="primary" type="submit" id="submit-rewind">创建回退分支</button></div></form>`;
  const close = () => {
    dialog.close();
    render();
  };
  $("#close-rewind").onclick = close;
  $("#cancel-rewind").onclick = close;
  $("#rewind-form").onsubmit = (e) => {
    e.preventDefault();
    const button = $("#submit-rewind");
    run(button, async () => {
      $("#rewind-error").textContent = "";
      try {
        if (!(await probeBridge())) throw new Error("当前宿主草稿桥不可用；未创建新的回退分支");
        if (!fork) {
          fork = await api("sessions.rewind", {
            id: item.id,
            mode: new FormData(e.target).get("mode"),
            draftBridgeReady: true,
          });
          state.rewindOutcome = { ...fork, draftStatus: "pending-client" };
          $("#f-mode").disabled = true;
        }
        try {
          const restored = await bridgeRequest("restore", {
            newSessionId: fork.newSessionId,
            draft: fork.draft,
          });
          state.rewindOutcome = { ...fork, draftStatus: restored.draftStatus };
        } catch (error) {
          state.rewindOutcome = {
            ...fork,
            draftStatus:
              error.draftStatus || (error.message.includes("未响应") ? "pending-client" : "failed"),
            error: error.message,
          };
          throw error;
        }
        $("#rewind-result").innerHTML = rewindSummary(state.rewindOutcome);
        $("#cancel-rewind").textContent = "完成";
        button.hidden = true;
      } catch (error) {
        if (!fork && error.code === "REWIND_PARTIAL") {
          state.rewindOutcome = {
            ...error.partial,
            draftStatus: "host-partial",
            error: `宿主阶段未完成${error.partial?.failedAt ? `（${error.partial.failedAt}）` : ""}：${error.message}。未自动恢复草稿。`,
          };
          $("#rewind-result").innerHTML = rewindSummary(state.rewindOutcome);
          button.hidden = true;
          $("#cancel-rewind").textContent = "关闭";
        } else if (fork) {
          $("#rewind-result").innerHTML = rewindSummary(state.rewindOutcome);
          setTimeout(() => {
            if (button.isConnected) button.textContent = "重试恢复同一分支草稿";
          }, 0);
        } else $("#rewind-error").textContent = error.message;
        throw error;
      }
    });
  };
  dialog.showModal();
}
async function sessionsPage() {
  await Promise.all([refreshStatus(), probeBridge()]);
  const items = state.status.sessions || [];
  return {
    html:
      heading('<button id="refresh-sessions">↻ 刷新会话</button>') +
      rewindSummary(state.rewindOutcome) +
      panel(
        "宿主会话",
        `<div class="note">回退将保留并归档原会话，通过官方 fork 路径创建新分支，并在客户端恢复草稿。${state.bridgeReady ? "宿主草稿桥已就绪。" : "当前未检测到可用草稿桥，回退操作保持禁用。"}</div>${
          items.length
            ? table(
                items.map((item) => ({
                  ...item,
                  workspaceName:
                    state.workspaces.find((w) => w.id === item.workspaceId)?.name || "未绑定",
                })),
                [
                  ["name", "会话标题"],
                  ["id", "会话标识"],
                  ["status", "状态"],
                  ["workspaceName", "演练项目"],
                ],
                (item, index) =>
                  `<button class="small" data-bind-session="${index}" ${state.workspaceId ? "" : 'disabled title="请先激活演练项目"'}>绑定项目</button><button class="small" data-rewind="${index}" ${can("sessions.rewind") && state.bridgeReady ? "" : 'disabled title="宿主回退能力与草稿桥都就绪后方可使用"'}>回退 / 分支</button>`,
              )
            : empty("没有可读取的宿主会话", "会话由当前宿主提供，独立预览不包含真实宿主会话。")
        }`,
      ),
    bind() {
      $("#refresh-sessions").onclick = render;
      $$("[data-bind-session]").forEach(
        (b) =>
          (b.onclick = () =>
            confirmAction(
              "绑定项目会话",
              `将此会话绑定到当前项目“${state.workspaces.find((w) => w.id === state.workspaceId)?.name || ""}”。`,
              () =>
                api("workspaces.bind", {
                  id: state.workspaceId,
                  sessionId: items[Number(b.dataset.bindSession)].id,
                }),
            )),
      );
      $$("[data-rewind]").forEach(
        (b) => (b.onclick = () => openRewind(items[Number(b.dataset.rewind)])),
      );
    },
  };
}
async function environmentPage() {
  const data = await api("toolkit.status");
  const tools = data.tools || [];
  return {
    html:
      heading(`${capabilityButton("toolkit.adapt", "离线适配建议", 'id="adapt-tools"')}`) +
      `<div class="grid2"><div>${panel(
        "工具可用性",
        `<div class="note">此页仅登记本地工具目录与检查版本。版本检查固定执行所选工具的 --version，不提供扫描参数或常驻进程入口。</div>${
          tools.length
            ? table(
                tools,
                [
                  ["name", "工具"],
                  ["path", "实际路径"],
                ],
                (item, index) =>
                  `${badge(item.available ? "available" : "unsupported")}<button class="small" data-tool-probe="${index}" ${item.available && can("toolkit.probe") ? "" : "disabled"}>检查版本</button>`,
              )
            : empty("尚未检测到工具", "设置工具目录后刷新检测。")
        }`,
      )}<div id="tool-detail"></div></div><div>${panel("工具目录", `<form id="tool-root-form"><div class="field"><label for="tool-root">本地工具根目录</label><input id="tool-root" name="root" value="${esc(data.root || "")}" placeholder="/本地/工具目录" required><small>使用已存在的绝对路径；检测工具目录及其一级子目录内的可执行文件。</small></div><button class="primary" type="submit" ${can("toolkit.save") ? "" : 'disabled title="宿主未提供工具目录设置能力"'}>保存目录</button></form>`)}${panel("环境信息", `<div class="twocoltext"><span>平台</span><span>${esc(state.status?.host?.platform || "未知")}</span></div><div class="twocoltext"><span>宿主版本</span><span>${esc(state.status?.host?.version || "未知")}</span></div><div class="twocoltext"><span>本地服务</span><span>${badge("available")}</span></div><button id="refresh-tools" class="small">↻ 刷新检测</button>`)}</div></div>`,
    bind() {
      $("#refresh-tools").onclick = render;
      $("#tool-root-form").onsubmit = (e) => {
        e.preventDefault();
        run($("button", e.target), async () => {
          await api("toolkit.save", { root: $("#tool-root").value.trim() });
          toast("工具目录已保存");
          await render();
        });
      };
      $("#adapt-tools").onclick = (e) =>
        run(e.target, async () => {
          const result = await api("toolkit.adapt");
          $("#tool-detail").innerHTML = panel(
            "离线适配建议",
            result.missing.length
              ? result.missing
                  .map(
                    (item) =>
                      `<div class="listrow"><div class="grow"><strong>${esc(item.name)}</strong><p>${esc(item.advice)}</p></div>${badge("unsupported")}</div>`,
                  )
                  .join("")
              : empty("目录内的工具均已检测到", "可逐个检查版本，确认本机启动结果。"),
          );
        });
      $$("[data-tool-probe]").forEach(
        (b) =>
          (b.onclick = () =>
            run(b, async () => {
              const tool = tools[Number(b.dataset.toolProbe)];
              const result = await api("toolkit.probe", { tool: tool.id, timeoutMs: 5000 });
              $("#tool-detail").innerHTML = panel(
                `${tool.name} · 版本检查`,
                `<div class="twocoltext"><span>执行参数</span><span class="mono">--version</span></div><div class="twocoltext"><span>退出码</span><span>${esc(result.exitCode)}</span></div><div class="field"><label>标准输出</label><pre class="report">${esc(result.stdout || "（无输出）")}</pre></div><div class="field"><label>标准错误</label><pre class="report">${esc(result.stderr || "（无输出）")}</pre></div>`,
              );
              toast("版本检查完成");
            })),
      );
    },
  };
}
async function diagnosticsPage() {
  const maintenance = await api("maintenance.info");
  const caps = state.status?.capabilities || [];
  return {
    html:
      heading('<button class="primary" id="run-diagnostics">运行诊断</button>') +
      `<div class="grid2"><div>${panel(
        "能力检测",
        caps.length
          ? table(
              caps.map((c) =>
                typeof c === "string" ? { id: c, label: c, state: "available" } : c,
              ),
              [
                ["label", "能力"],
                ["state", "状态"],
                ["detail", "说明"],
              ],
            )
          : empty("未返回能力列表", "运行诊断，检查当前宿主适配状态。"),
      )}<div id="diagnostic-result"></div></div><div>${panel("离线维护", `<div class="eyebrow">OFFLINE MAINTENANCE</div><div class="twocoltext"><span>当前版本</span><span>${esc(maintenance.version || state.status?.version || "未知")}</span></div><div class="twocoltext"><span>更新模式</span><span>离线本地包</span></div><p class="info" style="white-space:pre-wrap">${esc(Array.isArray(maintenance.instructions) ? maintenance.instructions.join("\n") : maintenance.instructions || "准备经过可信来源验证的本地更新包，然后通过宿主提供的安装接口维护。")}</p>${capabilityButton("maintenance.install", "选择本地安装包路径", 'id="install-offline"')}<div class="note" style="margin:18px 0 0">安装能力取决于宿主支持。没有可信安装接口时，此操作保持禁用。</div>`)}${panel("诊断说明", `<p class="info">诊断结果描述当前环境中的已检测能力。某项不可用时，对应操作会拒绝执行。</p><p class="info">离线工作台不会连接其他插件的发行或更新服务。</p>`)}</div></div>`,
    bind() {
      $("#run-diagnostics").onclick = (e) =>
        run(e.target, async () => {
          const result = await api("diagnostics.run");
          const checks = result.checks || [];
          $("#diagnostic-result").innerHTML = panel(
            "诊断结果",
            checks.length
              ? table(
                  checks.map((c) => ({
                    ...c,
                    label: c.label || c.name || c.id,
                    state: c.state || (c.ok ? "available" : "unsupported"),
                    detail: c.detail || c.message,
                  })),
                  [
                    ["label", "检查项"],
                    ["state", "结果"],
                    ["detail", "说明"],
                  ],
                )
              : '<p class="info">宿主已返回诊断状态，但未提供分项检查结果。</p>',
            new Date().toLocaleTimeString("zh-CN"),
          );
          toast("诊断已完成");
        });
      $("#install-offline").onclick = () =>
        openForm(
          "安装离线更新包",
          [field("path", "本地 .tgz 更新包绝对路径", "text", { required: true })],
          {},
          async (data) => {
            await api("maintenance.install", data);
            await refreshStatus();
          },
          {
            note: "此操作会调用宿主安装接口。请确认安装包来源、版本和本地备份。",
            submit: "安装本地更新",
          },
        );
    },
  };
}
shell();
(async () => {
  const outcomes = await Promise.allSettled([refreshStatus(), refreshProjects()]);
  const failed = outcomes.find((r) => r.status === "rejected");
  if (failed) {
    $("#content").innerHTML =
      heading() +
      `<div class="error" role="alert">${esc(failed.reason.message)}</div><button id="retry-start">重新连接</button>`;
    $("#connection-label").textContent = "连接失败";
    $("#retry-start").onclick = () => location.reload();
  } else await render();
})();
