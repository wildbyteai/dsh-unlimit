import { rewindSummary, rewindNotice } from "./rewind.js";
import { networkScopeFlow, networkScopePanel, networkScopePreview } from "./network-scope.js";
import { DataUpdates } from "./data-updates.js";
import { MemoryDrafts } from "./drafts.js";
import { admissionPage } from "./admission.js";
import { environmentSettings } from "./environment-settings.js";
import { processMonitor } from "./processes.js";
import { workflowPlans } from "./workflow-plans.js";
import { openWorkspaceRules } from "./workspace-rules.js";
import { openPromptPreview } from "./prompt-preview.js";
import { uninstallSection, uninstallFlow, renderReceipt } from "./maintenance.js";
import {
  connectionCheckFlow,
  connectionCheckPanel,
  connectionPreview,
  connectionResultText,
} from "./connection-checks.js";

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
  admission: null,
  workspaces: [],
  workspaceId: "",
  settings: null,
  recordKind: "credential",
  query: "",
  request: 0,
  graph: null,
  bridgeReady: false,
  bridgeSupports: { attachments: false },
  rewindOutcome: null,
  assetImport: null,
  knowledgeFilters: { kind: "", tags: "", verified: "" },
  knowledgeReadback: null,
  assetFilters: { scope: "", status: "", type: "" },
  assetImportError: null,
  skillImport: null,
  flowFeedback: null,
  environmentFeedback: null,
  environmentDetail: "",
  fileFeedback: new Map(),
  fileBackups: new Map(),
  graphPaths: new Map(),
  uninstallPending: false,
  uninstallOutcome: null,
};
const drafts = new MemoryDrafts();
const dataUpdates = new DataUpdates();
const dataPages = new Set([
  "overview",
  "workspaces",
  "assets",
  "findings",
  "evidence",
  "files",
  "graph",
  "progress",
  "knowledge",
  "roles",
  "reports",
]);
let mountedDrafts = [];
let disposePage;
let editorDraft = null;
const draftScope = (objectId, context = state) => ({
  workspaceId: context.workspaceId || "",
  page: context.page,
  objectId,
});
function formControls(form) {
  return (form.elements ? [...form.elements] : [form]).filter(
    (input) =>
      input.name &&
      ["INPUT", "SELECT", "TEXTAREA"].includes(input.tagName) &&
      !["file", "password"].includes(input.type) &&
      input.dataset.draft !== "off",
  );
}
function readDraftFields(form) {
  return Object.fromEntries(
    formControls(form).map((input) => [
      input.name,
      input.dataset.draftMissing ??
        (input.type === "checkbox"
          ? input.checked
          : input.multiple
            ? [...input.selectedOptions].map((option) => option.value)
            : input.value),
    ]),
  );
}
function updateDraftNotice() {
  const notice = $("#draft-notice");
  if (!notice) return;
  const count = drafts.countPage(state.workspaceId, state.page);
  notice.innerHTML = drafts.size
    ? `<div class="draft-notice"><span>${count ? `本页有 ${count} 份未保存编辑。` : `其他页面或项目有 ${drafts.size} 份未保存编辑。`}草稿仅保留在本面板内存；刷新或卸载会丢失。</span>${count ? '<button type="button" id="discard-page-drafts" class="small quiet danger">丢弃本页草稿</button>' : ""}</div>`
    : "";
  const discard = $("#discard-page-drafts");
  if (discard)
    discard.onclick = () => {
      for (const binding of mountedDrafts) binding.discard();
      if (editorDraft) {
        editorDraft.binding.discard();
        editorDraft = null;
        $("#editor").close();
      }
      drafts.clearPage(state.workspaceId, state.page);
      render();
    };
}
function bindMemoryDraft(form, scope, { dependentSelects = [] } = {}) {
  let baseline = readDraftFields(form);
  const restored = drafts.read(scope);
  if (restored) {
    for (const input of formControls(form)) {
      if (!Object.hasOwn(restored, input.name)) continue;
      if (input.type === "checkbox") input.checked = restored[input.name];
      else if (input.multiple)
        for (const option of input.options)
          option.selected = restored[input.name].includes(option.value);
      else {
        input.value = restored[input.name];
        if (input.tagName === "SELECT" && String(restored[input.name]) !== input.value) {
          input.dataset.draftMissing = restored[input.name];
          input.setCustomValidity("草稿原选择已不可用，请重新选择；不会套用到其他记录。");
        }
      }
      if (dependentSelects.includes(input.name))
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  const binding = {
    scope,
    form,
    capture() {
      const patch = drafts.capture(scope, baseline, readDraftFields(form), {
        anchors: [
          "id",
          "sessionId",
          "assetId",
          "pointId",
          "serviceId",
          "stageId",
          "from",
          "to",
          "role",
        ],
      });
      updateDraftNotice();
      return patch;
    },
    commit() {
      baseline = readDraftFields(form);
      drafts.clear(scope);
      updateDraftNotice();
    },
    commitFields(names) {
      const current = readDraftFields(form);
      for (const name of names) baseline[name] = current[name];
      this.capture();
    },
    discard() {
      baseline = readDraftFields(form);
      drafts.clear(scope);
      updateDraftNotice();
    },
  };
  form.addEventListener("input", () => binding.capture());
  form.addEventListener("change", (event) => {
    if (event.target.dataset?.draftMissing !== undefined) {
      delete event.target.dataset.draftMissing;
      event.target.setCustomValidity("");
    }
    if (event.target.name === "assetId") {
      const service = formControls(form).find((input) => input.name === "serviceId");
      if (service?.dataset.draftMissing !== undefined) {
        delete service.dataset.draftMissing;
        service.setCustomValidity("");
      }
    }
    binding.capture();
  });
  binding.capture();
  return binding;
}
function captureMountedDrafts() {
  for (const binding of mountedDrafts) if (binding.form.isConnected) binding.capture();
}
function commitInlineDraft(formId, fields) {
  const binding = mountedDrafts.find((item) => item.form.id === formId);
  if (binding) fields ? binding.commitFields(fields) : binding.commit();
}
function canLeaveEditor() {
  if (
    editorDraft?.saving ||
    mountedDrafts.some(
      (binding) => binding.form.querySelector?.('button[type="submit"]')?.textContent === "处理中…",
    )
  ) {
    toast("正在保存，请稍候再切换");
    return false;
  }
  if (editorDraft) {
    const pending = editorDraft.binding.capture();
    editorDraft = null;
    $("#editor").close();
    if (pending) toast("未保存编辑已保留，重新编辑同一记录可恢复");
  }
  captureMountedDrafts();
  return true;
}
function clearObjectDraft(
  page,
  objectId,
  { workspaceId = state.workspaceId, allWorkspaces = false } = {},
) {
  drafts.clearObject({ page, objectId, workspaceId, allWorkspaces });
  updateDraftNotice();
}
window.addEventListener("beforeunload", (event) => {
  captureMountedDrafts();
  editorDraft?.binding.capture();
  if (
    drafts.size ||
    (state.rewindOutcome?.draft && state.rewindOutcome.draftStatus !== "restored")
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
const pages = [
  ["overview", "◈", "工作台概览", "OVERVIEW", "掌握运行状态与当前演练进展"],
  ["control", "⌘", "破甲控制", "RUNTIME CONTROL", "配置提示词与运行时策略，在明确操作后应用"],
  ["rules", "≡", "规则管理", "RULE LIBRARY", "维护规则内容，选择当前生效规则"],
  ["skills", "◇", "技能管理", "SKILL LIBRARY", "管理插件选定目录中的本地技能"],
  ["workspaces", "▧", "演练项目", "WORKSPACES", "记录授权范围，让资产与证据按项目隔离"],
  ["assets", "⊞", "资产台账", "ASSET INVENTORY", "梳理演练资产、关联与评估记录"],
  ["findings", "⚑", "漏洞发现", "FINDINGS", "跟踪发现的严重度、状态与证据"],
  ["evidence", "▤", "证据中心", "EVIDENCE CENTER", "保存本地证据记录，不会执行远程操作"],
  ["files", "▣", "文件与证据", "LOCAL MATERIALS", "按项目保存本地材料并恢复备份版本"],
  ["graph", "⌁", "关系图谱", "RELATION GRAPH", "从资产关系理解当前演练范围"],
  ["progress", "◴", "阶段与评分", "PROGRESS & SCORE", "记录演练阶段、得分点与命中情况"],
  ["knowledge", "▥", "知识库", "KNOWLEDGE BASE", "积累可复用的知识与方法"],
  ["roles", "♙", "角色与执行", "ROLES & EXECUTION", "按当前项目管理角色、分派任务并核对执行结果"],
  ["reports", "↗", "报告导出", "REPORTS", "汇总当前项目并导出本地 Markdown 报告"],
  ["sessions", "◷", "会话管理", "SESSIONS", "查看宿主会话，保留原会话进行回退"],
  [
    "environment",
    "⌖",
    "工具与环境",
    "TOOLKIT & ENVIRONMENT",
    "设置本地工具路径并检查版本与产品标识",
  ],
  ["diagnostics", "⊙", "诊断与维护", "DIAGNOSTICS", "检查宿主能力与离线维护状态"],
];
const groups = { 0: "工作空间", 1: "运行控制", 4: "演练管理", 11: "知识与交付", 14: "系统" };
const descriptions = Object.fromEntries(pages.map((p) => [p[0], p]));
const defaults = {
  enabled: false,
  prompt: "",
  promptMode: "replace",
  workspacePolicy: "fallback",
  workspaceFiles: [],
  fullAccess: true,
  autoApprove: true,
  permissionDefault: "",
  repeatReminder: "host",
  hooksDeny: false,
  maxSubagents: 16,
  maxDepth: 10,
  readLimit: 1048576,
  autoReapply: true,
  retryLimit: 0,
  retryOverride: false,
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
    field("secret", "替换凭据内容", "password", {
      help: "留空保留已保存内容；填写新值才替换。不会回显原值，也不保留密码草稿。",
    }),
    field("clearSecret", "明确清空已保存的凭据内容", "checkbox", { draft: false }),
    field("target", "关联目标"),
    field("role", "登记角色 / 权限说明"),
    field("source", "资料来源"),
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
    field("status", "手工登记状态"),
    field("notes", "证据说明", "textarea"),
  ],
  tunnel: [
    field("name", "名称"),
    field("source", "来源地址"),
    field("destination", "目标地址"),
    field("protocol", "协议"),
    field("listenHost", "监听端地址", "text", {
      help: "仅检查此明确登记的监听地址，不从来源或目标推断。",
    }),
    field("listenPort", "监听端口（可选）", "number", {
      optional: true,
      min: 1,
      max: 65535,
      step: 1,
    }),
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
  if (state.uninstallOutcome || (state.uninstallPending && action !== "maintenance.uninstall"))
    throw new Error("卸载操作已开始，请在回执或宿主插件管理器核对状态。");
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
    for (const key of [
      "draftStatus",
      "textStatus",
      "attachmentStatus",
      "uploadStatus",
      "openStatus",
      "navigationConfirmed",
      "newSessionId",
      "code",
    ])
      error[key] = response[key];
    pending.reject(error);
  }
});
function cancelBridge(id) {
  if (window.parent === window) return;
  window.parent.postMessage(
    {
      type: "dsh-unlimit:draft-bridge-request",
      id: `cancel-${Date.now()}-${++bridgeCounter}`,
      operation: "cancel",
      payload: { requestId: id },
    },
    location.origin,
  );
}
window.addEventListener("pagehide", () => {
  for (const [id, pending] of bridgePending) {
    cancelBridge(id);
    clearTimeout(pending.timer);
    pending.reject(
      Object.assign(new Error("工作台已离开，草稿恢复已请求取消"), { code: "CANCELLED" }),
    );
  }
  bridgePending.clear();
});
function bridgeRequest(operation, payload = {}) {
  if (window.parent === window) return Promise.reject(new Error("独立预览中没有宿主草稿桥"));
  return new Promise((resolve, reject) => {
    const id = `bridge-${Date.now()}-${++bridgeCounter}`;
    const timeout = operation === "probe" ? 2000 : 15000;
    const timer = setTimeout(() => {
      bridgePending.delete(id);
      cancelBridge(id);
      reject(
        Object.assign(new Error("宿主草稿桥未响应，已请求取消；恢复状态未确认"), {
          code: "BRIDGE_TIMEOUT",
        }),
      );
    }, timeout);
    bridgePending.set(id, { resolve, reject, timer });
    try {
      window.parent.postMessage(
        {
          type: "dsh-unlimit:draft-bridge-request",
          id,
          operation,
          payload,
          expiresAt: Date.now() + timeout,
        },
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
    const result = await bridgeRequest("probe");
    state.bridgeReady = Boolean(result.ready);
    state.bridgeSupports = { attachments: result.supports?.attachments === true };
  } catch {
    state.bridgeReady = false;
    state.bridgeSupports = { attachments: false };
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
    `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brandmark">U</span><div><strong>UNLIMIT</strong><small>DESKTOP WORKSPACE</small></div></div><nav aria-label="主导航">${pages.map((p, i) => `${groups[i] ? `<div class="navgroup">${groups[i]}</div>` : ""}<button class="navitem ${p[0] === state.page ? "active" : ""}" data-page="${p[0]}"><span class="navicon" aria-hidden="true">${p[1]}</span>${p[2]}<span class="update-badge" data-updates="${p[0]}" hidden>有更新</span></button>`).join("")}</nav><div class="sidebarfooter"><div class="connection"><i class="dot off" id="connection-dot"></i><span id="connection-label">连接中</span></div><div id="version-label">独立桌面工作台</div></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">DSH UNLIMIT <span style="margin:0 10px">/</span> <b id="crumb">工作台概览</b></div><div class="topright"><span class="tag gray" id="instance-label">本地实例</span><span>当前项目</span><select id="workspace-select" aria-label="当前演练项目"><option value="">尚未激活项目</option></select><button id="refresh-data" class="small" title="重新读取项目与当前页数据；保留本面板草稿">↻ 刷新数据</button></div></header><div class="content" id="content">${skeleton()}</div></main></div>`;
  $("#refresh-data").onclick = () => {
    if (canLeaveEditor()) render();
  };
  $$(".navitem").forEach((b) => b.addEventListener("click", () => navigate(b.dataset.page)));
  $("#workspace-select").addEventListener("change", (e) =>
    run(e.target, async () => {
      if (!e.target.value) return;
      if (!canLeaveEditor()) {
        e.target.value = state.workspaceId;
        return;
      }
      const id = e.target.value;
      ++state.request; // Abandon old page reads before activating another project.
      await api("workspaces.activate", { id });
      await render();
    }),
  );
}
async function refreshProjects(read = api) {
  state.admission = await read("admission.status");
  if (!state.admission.accepted) {
    state.workspaces = [];
    state.workspaceId = "";
    $("#workspace-select").innerHTML = '<option value="">演练入口待确认</option>';
    return;
  }
  const data = await read("workspaces.list");
  state.workspaces = data.items || [];
  state.workspaceId = data.activeId || "";
  $("#workspace-select").innerHTML =
    `<option value="">尚未激活项目</option>${state.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === state.workspaceId ? "selected" : ""}>${esc(w.name)}</option>`).join("")}`;
}
async function refreshStatus(read = api) {
  state.status = await read("status");
  state.admission = state.status.admission;
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
  if (state.uninstallPending || state.uninstallOutcome) return;
  if (!canLeaveEditor()) return;
  state.page = page;
  state.query = "";
  $$(".navitem").forEach((b) => b.classList.toggle("active", b.dataset.page === page));
  $("#crumb").textContent = descriptions[page][2];
  render();
}
function updateDataBadges() {
  for (const badge of $$("[data-updates]"))
    badge.hidden =
      !state.admission?.accepted ||
      !dataUpdates.hasUnread({
        workspaceId: state.workspaceId || null,
        page: badge.dataset.updates,
      });
  for (const button of $$("[data-kind], [data-progress-kind]")) {
    const page = button.dataset.progressKind ? "progress" : "evidence";
    const kind = button.dataset.progressKind || button.dataset.kind;
    const unread = dataUpdates.hasUnread({ workspaceId: state.workspaceId || null, page, kind });
    button.classList.toggle("has-update", unread);
    button.title = unread ? "有尚未读取的更新" : "";
  }
}
function dataContext() {
  const context = { workspaceId: state.workspaceId || null, page: state.page };
  if (context.page === "progress")
    context.kind = ["stage", "score-point", "score-hit"].includes(state.recordKind)
      ? state.recordKind
      : "stage";
  if (context.page === "evidence")
    context.kind = ["stage", "score-point", "score-hit"].includes(state.recordKind)
      ? "credential"
      : state.recordKind;
  return context;
}
async function render() {
  if (state.uninstallOutcome) {
    showUninstallOutcome();
    return;
  }
  if (state.uninstallPending) return;
  captureMountedDrafts();
  mountedDrafts = [];
  disposePage?.();
  disposePage = undefined;
  const serial = ++state.request;
  const content = $("#content");
  content.innerHTML = skeleton();
  const read = async (...args) => {
    if (serial !== state.request) throw new Error("页面已切换");
    const value = await api(...args);
    if (serial !== state.request) throw new Error("页面已切换");
    return value;
  };
  read.assertCurrent = () => {
    if (serial !== state.request) throw new Error("页面已切换");
  };
  let result;
  try {
    const tracked = dataPages.has(state.page);
    await refreshProjects(read);
    const context = dataContext();
    const track = tracked && state.admission?.accepted;
    const changes = async () => {
      const snapshot = await read(
        "workspaces.changes",
        context.workspaceId ? { workspaceId: context.workspaceId } : {},
      );
      if (snapshot.workspaceId !== context.workspaceId)
        throw new Error("当前项目已变化，请刷新数据");
      return dataUpdates.observe(snapshot);
    };
    const before = track ? await changes() : null;
    updateDataBadges();
    if (tracked && state.page !== "overview" && !state.admission.accepted)
      result = await admissionPage({
        api,
        esc,
        panel,
        accepted: async () => {
          await render();
        },
        later: () => navigate("control"),
      });
    else if (schemas[state.page]) result = await collectionPage(state.page, read);
    else if (state.page === "evidence") result = await evidencePage(context.kind, false, read);
    else
      result = await {
        overview: overviewPage,
        control: controlPage,
        skills: skillsPage,
        graph: graphPage,
        files: filesPage,
        progress: progressPage,
        roles: rolesPage,
        reports: reportsPage,
        sessions: sessionsPage,
        environment: environmentPage,
        diagnostics: diagnosticsPage,
      }[state.page](read);
    if (track) await changes();
    if (serial !== state.request) {
      result.dispose?.();
      return;
    }
    content.innerHTML =
      `<div id="draft-notice"></div><div id="data-read-status" role="status"></div>` +
      result.html +
      `<div class="footerline"><span>DSH UNLIMIT · 本地工作台</span><span>数据保存在当前本地实例中</span></div>`;
    result.bind?.();
    disposePage = result.dispose;
    for (const form of $$('#content form:not([data-draft="off"])'))
      mountedDrafts.push(bindMemoryDraft(form, draftScope(`inline:${form.id}`)));
    const search = $("#search");
    if (search) mountedDrafts.push(bindMemoryDraft(search, draftScope("inline:search")));
    updateDraftNotice();
    if (track) {
      if (result.dataReadComplete !== false) dataUpdates.markRead(context, before);
      const unread = dataUpdates.hasUnread(context);
      const project = state.workspaces.find((w) => w.id === context.workspaceId);
      $("#data-read-status").innerHTML =
        `<div class="data-status"><span>${esc(project?.name || "尚未激活项目")} · ${esc(new Date().toLocaleTimeString())} 读取</span><span>${result.dataReadComplete === false ? "部分读取失败，更新提示保留" : unread ? "读取期间又有更新，请再次刷新" : "当前页已读取"} · 切页或点击“刷新数据”检查更新</span></div>`;
    }
    updateDataBadges();
  } catch (e) {
    result?.dispose?.();
    if (serial !== state.request) return;
    updateDataBadges();
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
  return `<div class="tablewrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c[1])}</th>`).join("")}${actions ? '<th style="text-align:right">操作</th>' : ""}</tr></thead><tbody>${items.map((item, index) => `<tr>${columns.map(([key], j) => `<td>${key === "verified" ? badge(item.verified ? "verified" : "unverified") : ["severity", "status"].includes(key) ? badge(item[key]) : `<div class="${j === 0 ? "celltitle" : ""}">${esc(friendly(redactCell(item[key], key))).slice(0, 360)}</div>${j === 0 && item.updatedAt ? `<div class="cellsub">${esc(time(item.updatedAt))}</div>` : ""}`}</td>`).join("")}${actions ? `<td><div class="rowactions">${actions(item, index)}</div></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function renderField(f, value) {
  const v = f.type === "password" ? "" : (value ?? f.default ?? "");
  const attr = `name="${esc(f.name)}" id="f-${esc(f.name)}" ${f.draft === false ? 'data-draft="off"' : ""} ${f.required ? "required" : ""} ${f.disabled ? "disabled" : ""} ${f.readonly ? "readonly" : ""} ${f.pattern ? `pattern="${esc(f.pattern)}"` : ""} ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""}`;
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
    input = `<input type="${f.type}" ${attr} value="${esc(Array.isArray(v) ? v.join(", ") : v)}" ${f.type === "number" ? `step="${f.step ?? "any"}"` : ""} autocomplete="off">`;
  return `<div class="field ${f.type === "textarea" ? "wide" : ""}"><label for="f-${esc(f.name)}">${esc(f.label)}${f.required ? " *" : ""}</label>${input}${f.help ? `<small>${esc(f.help)}</small>` : ""}</div>`;
}
function openForm(title, fields, values, onSave, options = {}) {
  if (!canLeaveEditor()) return;
  const context = { workspaceId: state.workspaceId, page: state.page };
  const identity =
    options.draftId ||
    (values.id
      ? `record:${values.id}`
      : values.sessionId
        ? `session:${values.sessionId}:${title}`
        : values.role
          ? `role:${values.role}`
          : `new:${title}`);
  const scope = draftScope(identity, context);
  const dialog = $("#editor");
  dialog.innerHTML = `<form id="edit-form" method="post"><div class="dialoghead"><h2>${esc(title)}</h2><button type="button" class="quiet small" id="close-dialog" aria-label="关闭">✕</button></div>${options.note ? `<div class="note">${esc(options.note)}</div>` : ""}<p class="draft-help">非秘密编辑仅保留在本面板内存；重新编辑同一对象可恢复，刷新会丢失。密码和清空选项不进入草稿。</p><div class="fields">${fields.map((f) => renderField(f, values[f.name])).join("")}</div><p class="inlineerror" id="form-error" role="alert"></p><div class="dialogfoot"><button type="button" id="cancel-dialog">放弃修改</button><button class="primary" type="submit">${esc(options.submit || "保存")}</button></div></form>`;
  dialog.showModal();
  options.afterOpen?.(dialog);
  const form = $("#edit-form");
  const clearSensitiveInputs = () => {
    $$('input[type="password"]', form).forEach((input) => {
      input.value = "";
    });
    $$('input[type="checkbox"][data-draft="off"]', form).forEach((input) => {
      input.checked = false;
    });
  };
  dialog.addEventListener("close", clearSensitiveInputs, { once: true });
  const binding = bindMemoryDraft(form, scope, {
    dependentSelects: fields.some((field) => field.name === "serviceId")
      ? ["assetId", "serviceId"]
      : [],
  });
  const editor = { binding, saving: false };
  editorDraft = editor;
  const close = (discard) => {
    if (editor.saving) return;
    const pending = discard ? (binding.discard(), null) : binding.capture();
    if (editorDraft === editor) editorDraft = null;
    dialog.close();
    if (pending) toast("未保存编辑已保留，重新编辑同一对象可恢复");
    updateDraftNotice();
  };
  $("#close-dialog").onclick = () => close(false);
  $("#cancel-dialog").onclick = () => close(true);
  dialog.oncancel = (event) => {
    event.preventDefault();
    close(false);
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    const button = $("button[type=submit]", form);
    run(button, async () => {
      editor.saving = true;
      $("#close-dialog").disabled = true;
      $("#cancel-dialog").disabled = true;
      const data = Object.fromEntries(new FormData(form));
      fields.forEach((field) => {
        if (field.type === "number") {
          if (field.optional && data[field.name] === "") delete data[field.name];
          else data[field.name] = data[field.name] === "" ? 0 : Number(data[field.name]);
        }
        if (field.type === "checkbox") data[field.name] = form.elements[field.name].checked;
      });
      try {
        await onSave(data);
        binding.commit();
        if (editorDraft === editor) editorDraft = null;
        dialog.close();
        toast(options.success || "已保存");
        if (!options.keepPage) await render();
        else captureMountedDrafts();
      } catch (error) {
        $("#form-error", form).textContent = error.message;
        binding.capture();
        throw error;
      } finally {
        clearSensitiveInputs();
        editor.saving = false;
        if (form.isConnected) {
          $("#close-dialog", form).disabled = false;
          $("#cancel-dialog", form).disabled = false;
        }
      }
    });
  };
}
function confirmAction(title, message, onConfirm, options = {}) {
  if (!canLeaveEditor()) return;
  const dialog = $("#editor");
  dialog.innerHTML = `<div class="dialoghead"><h2>${esc(title)}</h2></div><p class="info">${esc(message)}</p><p class="inlineerror" id="confirm-error" role="alert"></p><div class="dialogfoot"><button id="cancel-confirm">取消</button><button class="danger" id="accept-confirm">确认${esc(title)}</button></div>`;
  dialog.oncancel = null;
  $("#cancel-confirm").onclick = () => dialog.close();
  const accept = $("#accept-confirm");
  const errorBox = $("#confirm-error");
  accept.onclick = (e) =>
    run(e.target, async () => {
      try {
        const result = await onConfirm();
        if (!accept.isConnected || (options.keepPage && result === false)) return;
        dialog.close();
        toast("操作完成");
        if (!options.keepPage) await render();
      } catch (error) {
        if (errorBox.isConnected) errorBox.textContent = error.message;
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
async function collectionPage(name, read = api) {
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
  const response = await read(`${name}.list`, listPayload);
  const items = response.items;
  let formFields = schema.fields;
  if (name === "findings") {
    const assets = await read("assets.list", payload);
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
    ? `<div class="note">已从服务端读回“${esc(redactCell(saved.title))}”：验证状态为${saved.verified ? "已验证" : "未验证"}。${saved.verificationWithdrawn ? "原有验证标记已撤回。" : ""}</div>`
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
        `<div class="toolbar"><input class="search" id="search" name="query" placeholder="搜索${schema.label}…" aria-label="搜索${schema.label}" value="${esc(state.query)}">${name === "rules" ? '<button id="reset-rules">清除激活规则</button>' : ""}<span class="meta">${items.length} 条记录</span></div>${filterForm}${filtered.length ? table(filtered, columns, actions) : empty(`暂无${schema.label}`, state.query || name === "knowledge" || (name === "assets" && Object.values(state.assetFilters).some(Boolean)) ? "当前条件下没有匹配的记录。" : "建立第一条记录，开始整理工作。")}`,
      ) +
      importPanel +
      (name === "knowledge"
        ? panel(
            "本地模板目录",
            '<form id="template-search"><div class="field"><label for="template-query">按路径或正文检索</label><input id="template-query" name="query" placeholder="留空列出模板"></div><button type="submit">检索本地模板</button></form><p class="info">使用“工具与环境”中选择的目录，只读取文本，不执行模板。检索结果不代表已验证。</p><div id="template-results"></div><div id="template-readback"></div>',
          )
        : ""),
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
          `${item?.id ? "编辑" : "新建"}${schema.label}`,
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
                verificationWithdrawn: Boolean(item?.verified && !actual.verified),
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
        const binding = mountedDrafts.find((item) => item.form.id === "search");
        binding?.commit();
        render();
      };
      if (name === "rules")
        $("#reset-rules").onclick = (e) =>
          run(e.target, async () => {
            await api("rules.reset");
            await render();
          });
      if (name === "knowledge") {
        $("#template-search").onsubmit = (event) => {
          event.preventDefault();
          const form = event.target;
          run($('button[type="submit"]', form), async () => {
            const result = await api("templates.list", { query: new FormData(form).get("query") });
            if (state.page !== "knowledge" || !form.isConnected) return;
            commitInlineDraft("template-search");
            $("#template-results").innerHTML =
              `<p class="info">${result.items.length} 个结果 · 检查 ${result.inspected} 项 · 跳过 ${result.skipped} 项${result.truncated ? " · 已达检索上限，请缩小目录或搜索范围" : ""}</p>${
                result.items.length
                  ? table(
                      result.items,
                      [
                        ["path", "相对路径"],
                        ["bytes", "字节数"],
                        ["excerpt", "正文片段"],
                      ],
                      (_item, index) =>
                        `<button class="small" data-template-read="${index}">读取全文</button>`,
                    )
                  : empty("没有匹配模板", "未读取到满足条件的 UTF-8 文本模板。")
              }`;
            $("#template-readback").innerHTML = "";
            $$("[data-template-read]").forEach((button) => {
              button.onclick = () =>
                run(button, async () => {
                  const { item } = await api("templates.read", {
                    path: result.items[Number(button.dataset.templateRead)].path,
                  });
                  if (state.page !== "knowledge" || !form.isConnected) return;
                  $("#template-readback").innerHTML = panel(
                    "模板全文",
                    `<p class="info">${esc(item.path)} · ${item.bytes} 字节 · SHA-256 ${esc(item.sha256)}</p><pre class="code">${esc(item.content)}</pre><button id="template-to-knowledge">整理为知识条目</button>`,
                  );
                  $("#template-to-knowledge").onclick = () =>
                    edit({
                      title: item.path,
                      kind: "template",
                      content: item.content,
                      tags: ["本地模板"],
                      verified: false,
                      source: `local-template:${item.path}#sha256=${item.sha256}`,
                    });
                });
            });
          });
        };
        $("#knowledge-filters").onsubmit = (e) => {
          e.preventDefault();
          state.knowledgeFilters = Object.fromEntries(new FormData(e.target));
          commitInlineDraft("knowledge-filters");
          render();
        };
        $("#clear-knowledge-filters").onclick = () => {
          commitInlineDraft("knowledge-filters");
          commitInlineDraft("search");
          state.knowledgeFilters = { kind: "", tags: "", verified: "" };
          state.query = "";
          render();
        };
      }
      if (name === "assets") {
        $("#asset-filters").onsubmit = (e) => {
          e.preventDefault();
          state.assetFilters = Object.fromEntries(new FormData(e.target));
          commitInlineDraft("asset-filters");
          render();
        };
        $("#clear-asset-filters").onclick = () => {
          commitInlineDraft("asset-filters");
          commitInlineDraft("search");
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
                dialog.oncancel = null;
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
                {
                  draftId: `asset:${item.id}:${b.dataset.act}`,
                  note: "仅登记已发生的评估与测试结果，不会发起远程扫描或发送测试请求。",
                },
              );
            else if (b.dataset.act === "delete")
              confirmAction(
                `删除${schema.label}`,
                `将删除“${item.name || item.title}”。删除后无法从界面恢复。`,
                async () => {
                  await api(`${name}.delete`, { id: item.id });
                  clearObjectDraft(name, `record:${item.id}`, { allWorkspaces: !schema.workspace });
                },
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
async function overviewPage(read = api) {
  await refreshStatus(read);
  if (!state.admission?.accepted)
    return {
      html:
        heading() +
        `<div class="statushero"><span class="herosymbol">⌘</span><div><strong>桌面工作台已连接</strong><p>运行控制与演练数据分开配置。进入演练区前，请完成当前安装的使用确认。</p></div></div>` +
        `<div class="grid2">${panel("演练工作区", '<p class="info">确认后可管理项目、资产、证据和执行计划。尚未读取演练数据。</p><button class="primary" id="open-admission">进入演练工作区</button>')}${panel("运行控制", `<p class="info">${state.status.enabled ? "运行控制已启用，可查看当前配置或还原。" : "提示词、规则、技能与运行控制可独立配置。"}</p><button id="open-control">打开运行控制</button>`)}</div>`,
      bind() {
        $("#open-admission").onclick = () => navigate("workspaces");
        $("#open-control").onclick = () => navigate("control");
      },
    };
  const data = state.workspaceId
    ? await Promise.all([
        read("assets.list", workspacePayload()),
        read("findings.list", workspacePayload()),
        read("records.list", { ...workspacePayload(), kind: "stage" }),
        read("report.build", workspacePayload()),
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
  const serial = state.request;
  const scopeReads = await Promise.allSettled([
    api("networkScope.status", {}),
    api("admission.status"),
  ]);
  let scopeRoot;
  let scopeDialog;
  let disposePromptPreview;
  const inScopeContext = () =>
    state.page === "control" && state.request === serial && scopeRoot?.isConnected;
  const scope = networkScopeFlow({
    api,
    initialStatus: scopeReads[0].status === "fulfilled" ? scopeReads[0].value : null,
    initialError: scopeReads[0].status === "rejected" ? scopeReads[0].reason.message : "",
    admissionAccepted:
      scopeReads[1].status === "fulfilled" && scopeReads[1].value.accepted === true,
    isCurrent: inScopeContext,
    confirm: (hosts) => {
      if (!canLeaveEditor() || !inScopeContext()) return Promise.resolve(false);
      const dialog = $("#editor");
      scopeDialog = dialog;
      dialog.innerHTML = `<div class="dialoghead"><h2>确认本次域名解析</h2></div>${networkScopePreview(hosts)}<div class="dialogfoot"><button type="button" data-scope-cancel>取消</button><button type="button" class="primary" data-scope-accept>确认并解析这些域名</button></div>`;
      dialog.oncancel = null;
      return new Promise((resolve) => {
        dialog.addEventListener(
          "close",
          () => {
            scopeDialog = null;
            resolve(false);
          },
          { once: true },
        );
        $("[data-scope-cancel]", dialog).onclick = () => dialog.close();
        $("[data-scope-accept]", dialog).onclick = (event) => {
          event.target.disabled = true;
          resolve(true);
          dialog.close();
        };
        dialog.showModal();
      });
    },
    changed(view) {
      const release = $("[name=release]", scopeRoot)?.value || "";
      scopeRoot.innerHTML = networkScopePanel(view);
      $("[name=release]", scopeRoot).value = release;
      bindScope();
    },
  });
  function bindScope() {
    $("[data-scope-refresh]", scopeRoot).onclick = () => scope.refresh();
    $("[data-scope-stop]", scopeRoot).onclick = () => scope.stop();
    $("[data-scope-batch]", scopeRoot).onclick = () =>
      scope.resolve(
        scope
          .view()
          .status.hosts.filter((host) => host.type === "hostname")
          .map((host) => host.hostname),
      );
    $$("[data-scope-host]", scopeRoot).forEach((button) => {
      button.onclick = () =>
        scope.resolve([scope.view().status.hosts[Number(button.dataset.scopeHost)].hostname]);
    });
    $("[data-scope-import]", scopeRoot).onsubmit = (event) => {
      event.preventDefault();
      const form = event.target;
      scope.importFile(form.elements.file.files[0], form.elements.release.value);
    };
  }
  const settings = await api("settings.get");
  state.settings = settings;
  const v = { ...defaults, ...settings.value };
  const permission = state.status.permissionDefaults;
  const readCapability = state.status.capabilities?.find((item) => item.id === "readLimit");
  const readBudget = readCapability?.effective;
  const readBudgetHelp =
    (typeof readBudget === "number"
      ? `当前统一预算：${readBudget} B。`
      : readCapability?.coverage === "host"
        ? "当前沿用各项宿主预算。"
        : "保存的预算尚未覆盖全部读取配置。") +
    (readCapability?.targetCount
      ? `已应用 ${readCapability.appliedTargetCount}/${readCapability.targetCount} 个启用读取配置。`
      : "") +
    (["pending", "partial"].includes(readCapability?.coverage) ? "请重新应用运行控制。" : "") +
    "0 沿用宿主；新加载的预设需重新应用。仅限制 read 返回正文，行号与封装、实际文件 I/O 另计。";
  const permissionOptions = [
    ["", "跟随宿主默认"],
    ...(permission?.options ?? []).map((option) => [option.value, option.label ?? option.value]),
  ];
  if (v.permissionDefault && !permissionOptions.some(([value]) => value === v.permissionDefault))
    permissionOptions.push([v.permissionDefault, `${v.permissionDefault} · 当前不可用`]);
  const sessionDefaults = panel(
    "新会话与重复提醒",
    `<div class="fields">${renderField(
      field("permissionDefault", "新会话默认权限", "select", {
        options: permissionOptions,
        disabled: !can("permissionDefault"),
        help: can("permissionDefault")
          ? `当前有效默认：${permission?.effective ?? "未知"}。只影响未来全新会话，已有会话和显式选择保持不变。`
          : "尚未取得可用的宿主权限预设目录。",
      }),
      v.permissionDefault,
    )}${renderField(
      field("repeatReminder", "重复调用提醒", "select", {
        options: [
          ["host", "沿用宿主提醒"],
          ["off", "关闭重复建议提醒"],
        ],
        disabled: !can("repeatReminder"),
        help: can("repeatReminder")
          ? "仅控制建议提醒，工具拒绝结果保持有效。切换会重置提醒计数，历史消息保留。"
          : "尚未取得已验证的重复提醒配置入口。",
      }),
      v.repeatReminder,
    )}</div><p class="info">新会话权限采用宿主提供的完整预设。“不询问”策略会拒绝需要确认的请求，不代表自动批准。</p>`,
  );
  const switchRow = (key, title, desc) => {
    const ids = {
      fullAccess: "sandbox",
      autoApprove: "approval",
      hooksDeny: "hooks",
      autoReapply: "autoReapply",
      retryOverride: "retryLimit",
      autoContinue: "continuation.auto",
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
        )}<button type="button" id="preview-saved-prompt">预览已保存正文</button></div><div class="field"><label for="prompt-text">提示词内容</label><textarea class="code" name="prompt" id="prompt-text" rows="12" placeholder="编写当前工作方式、任务边界与输出要求…">${esc(v.prompt)}</textarea><small>保存更新本地配置；已启用的能力会在后续步骤读取新值，首次使用需要应用运行控制。</small></div>`,
      )}${panel(
        "工作区规则策略",
        `<div class="fields">${renderField(
          field("workspacePolicy", "加载策略", "select", {
            options: [
              ["fallback", "正文为空时保留工作区规则"],
              ["strict", "排除工作区规则"],
              ["always", "保留并合并工作区规则"],
            ],
          }),
          v.workspacePolicy,
        )}<div class="field wide"><label for="workspace-files">规则文件路径 · 每行一个</label><textarea name="workspaceFiles" id="workspace-files" rows="4">${esc(v.workspaceFiles.join("\n"))}</textarea><small>${
          can("nativeInstructions")
            ? "此策略同时处理所选规则与原生规则，在后续步骤生效。原生历史保留原日志；还原仅恢复仍属本插件的节点，其他工具说明保持。"
            : "当前仅处理本插件所选规则；原生规则接口尚未通过检查，宿主原生基线与刷新消息继续保留。"
        }</small></div></div><div class="toolbar" style="margin-bottom:0"><button type="button" id="scan-rules">浏览并选择规则</button><button type="button" id="select-rule-paths">保存路径列表</button></div>`,
      )}${panel("用户自有服务器清单", `<div class="field"><label for="own-servers">用户自有服务器 · 每行一个</label><textarea name="ownServers" id="own-servers" rows="3">${esc(v.ownServers.join("\n"))}</textarea><small>可填写 IP、完整主机名或 user@host；不要填写密码、URL、网段、端口或通配符。此清单仍不是出口访问控制。</small></div>`)}</div><div>${panel("权限与执行", `${switchRow("fullAccess", "完整访问权限", "仅在会话未明确选择权限时请求完整访问；新会话采用下方默认预设。")}${switchRow("autoApprove", "自动审批", "仅处理未明确指定审批策略的会话；显式选择仍由宿主执行。")}${switchRow("hooksDeny", "禁用拦截钩子", "按宿主暴露的能力管理钩子策略。")}${switchRow("autoReapply", "重载后恢复运行控制", "已保存为启用时，插件重新加载后恢复控制；保存设置仍在后续步骤生效。")}${switchRow("retryOverride", "接管请求重试次数", "关闭时沿用提供方；开启且运行控制已启用后按 0—20 次设置，0 表示不重试。")}<div class="note" style="margin:17px 0 0">完整访问和自动审批会改变当前执行边界。请在应用前检查具体授权范围。</div>`)}${sessionDefaults}${panel(
        "执行限额",
        `<div class="fields">${[
          field("maxSubagents", "代理树并发子代理数", "number", { min: 1, max: 128 }),
          field("maxDepth", "最大递归深度", "number", { min: 0, max: 64 }),
          field("readLimit", "读取正文预算（字节）", "number", { min: 0, step: 1 }),
          field("retryLimit", "重试次数", "number", { min: 0, max: 20, step: 1 }),
        ]
          .map((f) => {
            const id = {
              maxSubagents: "subagents",
              maxDepth: "subagents",
              readLimit: "readLimit",
              retryLimit: "retryLimit",
            }[f.name];
            const scopeHelp = {
              maxSubagents:
                "同一活动代理树共享并发上限，包含孙代理；其他根会话独立计数。演练执行槽另行配置。",
              maxDepth: "0 禁止新建子代理，1 允许一层；调整限额不主动停止已运行的代理。",
            }[f.name];
            return renderField(
              {
                ...f,
                disabled: !can(id),
                help: scopeHelp
                  ? `${scopeHelp}${can(id) ? "" : " 当前宿主未提供此能力，保存值暂不生效。"}`
                  : id === "readLimit"
                    ? can(id)
                      ? readBudgetHelp
                      : `${readCapability?.detail ?? "宿主未提供此能力"}；当前保存值暂不生效。0 表示沿用宿主。`
                    : can(id)
                      ? ""
                      : "宿主未提供此能力；当前保存值暂不生效。",
              },
              v[f.name],
            );
          })
          .join("")}</div>`,
      )}${panel("截断后继续", `${switchRow("autoContinue", "自动继续截断输出", "仅处理明确的输出长度截断；支持根会话，以及启用控制后创建的受管本地子代理。用户停止、传输错误和限流不触发续轮。")}<div class="fields">${renderField(field("continueLimit", "每条输入链的自动继续上限", "number", { min: 0, max: 20, step: 1, disabled: !can("continuation.auto") }), v.continueLimit)}${renderField(field("continueText", "继续用语", "textarea", { disabled: !can("continuation.manual") }), v.continueText)}</div><p class="info">默认关闭。根会话和符合条件的已结束本地子会话可在会话管理中手动继续；子会话恢复会创建新执行。消息保留本插件来源，停止仅处理本插件所属的自动继续或子会话手动续跑输入。</p>`)}<div class="panel"><div class="panelheading"><h2>保存当前配置</h2><span class="meta" id="settings-revision">revision ${settings.revision}</span></div><p class="info">配置采用版本校验。若其他窗口已修改配置，请刷新后重新编辑。</p><p id="settings-error" class="inlineerror" role="alert"></p><button class="primary" type="submit" style="width:100%">保存配置</button></div></div></div></form>` +
      `<div id="network-scope">${networkScopePanel(scope.view())}</div>`,
    bind() {
      scopeRoot = $("#network-scope");
      bindScope();
      $("#preview-saved-prompt").onclick = () => {
        disposePromptPreview?.();
        disposePromptPreview = openPromptPreview({ api, esc });
      };
      const read = () => {
        const form = $("#settings-form");
        const values = { ...v };
        new FormData(form).forEach((value, key) => {
          values[key] = value;
        });
        [
          "fullAccess",
          "autoApprove",
          "hooksDeny",
          "autoReapply",
          "retryOverride",
          "autoContinue",
        ].forEach((key) => (values[key] = form.elements[key].checked));
        ["maxSubagents", "maxDepth", "readLimit", "retryLimit", "continueLimit"].forEach(
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
          commitInlineDraft("settings-form");
          toast("配置已保存");
          return state.settings;
        } catch (e) {
          $("#settings-error").textContent = e.message;
          throw e;
        }
      };
      $("#settings-form").onsubmit = (e) => {
        e.preventDefault();
        run($("button[type=submit]", e.target), async () => {
          await save();
          await refreshStatus();
          await render();
        });
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
          "将撤销本插件拥有的运行时注册，保留已保存配置。已有持久终端不会自动关闭，仍可能保留全访问权限；请先在终端执行 exit，或通过宿主关闭终端，再继续使用恢复后的权限。",
          async () => {
            await api("control.revert");
            await refreshStatus();
          },
        );
      $("#scan-rules").onclick = () =>
        openForm(
          "选择工作区目录",
          [field("directory", "本地工作区目录", "text", { required: true })],
          {},
          async (data) => {
            openWorkspaceRules({
              api,
              esc,
              directory: data.directory,
              selectedPaths: read().workspaceFiles,
              async onSelect(paths) {
                state.settings = await api("rules.select", {
                  revision: state.settings.revision,
                  paths,
                });
                $("#workspace-files").value = paths.join("\n");
                $("#settings-revision").textContent = `revision ${state.settings.revision}`;
                commitInlineDraft("settings-form", ["workspaceFiles"]);
                toast(`已保存 ${paths.length} 个选定规则文件`);
              },
            });
          },
          { submit: "浏览规则", keepPage: true, success: "请选择规则，可先查看完整正文" },
        );
      $("#select-rule-paths").onclick = (e) =>
        run(e.target, async () => {
          state.settings = await api("rules.select", {
            revision: state.settings.revision,
            paths: read().workspaceFiles,
          });
          $("#settings-revision").textContent = `revision ${state.settings.revision}`;
          commitInlineDraft("settings-form", ["workspaceFiles"]);
          toast("已更新选定规则文件");
        });
    },
    dispose() {
      scope.dispose();
      scopeDialog?.close();
      disposePromptPreview?.();
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
  await refreshStatus();
  const workspaceId = state.workspaceId;
  skillsPage.views ||= new Map();
  const view = skillsPage.views.get(workspaceId) || {
    sessionId: "",
    origin: "",
    read: null,
    preflight: null,
    error: "",
  };
  skillsPage.views.set(workspaceId, view);
  const scopePayload = view.sessionId ? { sessionId: view.sessionId } : {};
  const data = await api("skills.list");
  let catalog = null,
    catalogError = "";
  if (can("catalog.list")) {
    try {
      catalog = await api("catalog.list", scopePayload);
    } catch (error) {
      catalogError = error.message;
    }
  }
  const sessions = state.status?.sessions || [];
  const choices = sessions.map((session) => [session.id, session.name || session.id]);
  if (view.sessionId && !choices.some(([id]) => id === view.sessionId))
    choices.push([view.sessionId, `${view.sessionId} · 当前未列出，请重新选择`]);
  const catalogItems = (catalog?.skills || []).filter(
    (item) => !view.origin || item.origin === view.origin,
  );
  const originLabel = (origin) => (origin === "host" ? "宿主注册表" : "项目技能库");
  const checkState = (value) =>
    ({
      available: "已检测到",
      ready: "已配置",
      missing: "缺失",
      unknown: "未知",
      invalid: "声明无效",
    })[value] || value;
  const preflightHTML = (value) => {
    if (!value) return "";
    const labels = { ready: "声明范围内通过", unknown: "仍有未知项", blocked: "存在依赖缺口" };
    const rows = value.checks.map((check) => ({
      ...check,
      subject: check.skill ? `${originLabel(check.skill.origin)} · ${check.skill.id}` : "本次声明",
      target: check.name || check.path || check.id || "依赖声明",
      kindLabel:
        {
          tool: "宿主工具",
          toolkit: "本机工具",
          directory: "本地目录",
          skill: "注册表技能",
          declaration: "声明完整性",
          catalog: "目录来源",
          "skill-body": "技能正文",
          "environment-variable": "环境变量",
          "environment-host": "主机登记",
          "environment-key": "私钥元信息",
        }[check.kind] || check.kind,
      result: checkState(check.state),
    }));
    return panel(
      "依赖预检结果",
      `<div class="note">${esc(labels[value.status] || value.status)}。仅检查明确声明、本地目录与配置状态；不代表目标授权，也不启动任务、下载或执行工具。</div>${
        rows.length
          ? table(rows, [
              ["subject", "技能 / 范围"],
              ["kindLabel", "检查项"],
              ["target", "依赖"],
              ["result", "结果"],
              ["detail", "说明"],
            ])
          : '<p class="info">本次显式声明为空，未列出额外依赖。</p>'
      }`,
    );
  };
  const readHTML = (value) =>
    value
      ? panel(
          "已读取技能正文",
          `<div class="toolbar"><strong>${esc(value.item.name)}</strong><span class="tag gray">${originLabel(value.item.origin)}</span><span class="tag">正文可读</span><span class="tag orange">${value.item.dependency.state === "declared" ? "已有依赖声明 · 尚需预检" : value.item.dependency.state === "invalid" ? "依赖声明无效" : "依赖可用性未知"}</span></div><p class="info">${esc(value.item.provider || "dsh-unlimit")} · ${esc(value.item.source || "本地库")}。以下是上次明确读取的正文；读取不等于执行技能。</p><pre class="report">${esc(value.item.content)}</pre>`,
        )
      : "";
  const sourcesHTML = catalog
    ? `<details><summary>目录来源状态</summary>${table(
        Object.entries(catalog.sources).map(([name, source]) => ({
          name:
            {
              skills: "宿主技能注册表",
              project: "项目技能库",
              tools: "宿主工具注册表",
              toolkit: "本机工具目录",
            }[name] || name,
          result:
            {
              available: source.complete === false ? "部分结果" : "已读取",
              unsupported: "未提供",
              error: "读取失败",
            }[source.state] || source.state,
          detail:
            source.detail ||
            (source.complete === false ? "目录不完整，不能据此证明依赖不存在。" : ""),
        })),
        [
          ["name", "来源"],
          ["result", "状态"],
          ["detail", "说明"],
        ],
      )}</details>`
    : "";
  const catalogHTML = panel(
    "会话技能目录",
    `<form id="skill-catalog-filters" class="toolbar"><div class="field"><label for="skill-catalog-session">会话作用域</label><select id="skill-catalog-session" name="sessionId"><option value="">宿主全局 · 无会话</option>${choices.map(([id, label]) => `<option value="${esc(id)}" ${view.sessionId === id ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div><div class="field"><label for="skill-catalog-origin">技能来源</label><select id="skill-catalog-origin" name="origin"><option value="">全部来源</option><option value="host" ${view.origin === "host" ? "selected" : ""}>宿主注册表（含官方）</option><option value="project" ${view.origin === "project" ? "selected" : ""}>本项目技能库</option></select></div><button type="submit" ${can("catalog.list") ? "" : "disabled"}>读取目录</button></form><p class="info">目录范围：${esc(view.sessionId || "宿主全局")}。宿主来源保留真实 provider；项目库条目不保证在该会话中胜出。正文可读与依赖可用分别显示。</p>${catalogError ? `<div class="error" role="alert">目录读取失败：${esc(catalogError)}</div>` : !can("catalog.list") ? '<div class="note">当前未提供会话目录聚合接口，本地技能管理仍可使用。</div>' : ""}<div id="skill-catalog-error" class="inlineerror" role="alert">${esc(view.error)}</div>${
      catalogItems.length
        ? table(
            catalogItems.map((item) => ({
              ...item,
              originLabel: originLabel(item.origin),
              dependencyLabel: "需单独预检",
            })),
            [
              ["name", "技能"],
              ["originLabel", "来源"],
              ["provider", "提供方"],
              ["source", "注册来源"],
              ["description", "用途"],
              ["dependencyLabel", "依赖状态"],
            ],
            (item, index) =>
              `<button class="small" data-catalog-read="${index}" ${can("catalog.read") ? "" : "disabled"}>读取正文</button><button class="small" data-catalog-preflight="${index}" ${can("catalog.preflight") ? "" : "disabled"}>预检依赖</button>`,
          )
        : empty(
            "当前目录无匹配技能",
            catalogError
              ? "请重新读取目录；失败不会被视为完整空目录。"
              : "可切换来源或会话；宿主注册表未提供的项目技能仍可在下方管理。",
          )
    }${sourcesHTML}`,
  );
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
      catalogHTML +
      `<div id="skill-catalog-read-result">${readHTML(view.read)}</div><div id="skill-catalog-preflight-result">${preflightHTML(view.preflight)}</div>` +
      panel(
        "本地技能",
        `<div class="note">可导入技能文件夹、ZIP 或 Markdown。文件夹或 ZIP 最多 200 个普通文件 / 展开 50 MiB，SKILL.md 最大 256 KiB，ZIP 最大 12 MiB。名称与说明以 SKILL.md 的 YAML 元信息为准。</div>${
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
      const inContext = () =>
        state.page === "skills" &&
        state.workspaceId === workspaceId &&
        view.sessionId === (scopePayload.sessionId || "");
      $("#skill-catalog-filters").onsubmit = (event) => {
        event.preventDefault();
        if (!canLeaveEditor()) return;
        const values = Object.fromEntries(new FormData(event.target));
        const scopeChanged = view.sessionId !== values.sessionId;
        view.sessionId = values.sessionId;
        view.origin = values.origin;
        view.error = "";
        if (scopeChanged) {
          view.read = null;
          view.preflight = null;
        }
        commitInlineDraft("skill-catalog-filters");
        render();
      };
      const reportCatalogError = (error) => {
        if (view.sessionId !== (scopePayload.sessionId || "")) return;
        view.error = error.message;
        if (inContext()) $("#skill-catalog-error").textContent = error.message;
      };
      $$("[data-catalog-read]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, async () => {
              const item = catalogItems[Number(button.dataset.catalogRead)];
              try {
                if ($("#skill-catalog-session").value !== (scopePayload.sessionId || ""))
                  throw new Error("请先点击“读取目录”应用所选会话范围");
                const result = await api("catalog.read", {
                  ...scopePayload,
                  origin: item.origin,
                  id: item.id,
                });
                if (view.sessionId !== (scopePayload.sessionId || "")) return;
                view.read = result;
                view.error = "";
                if (inContext()) {
                  $("#skill-catalog-read-result").innerHTML = readHTML(result);
                  $("#skill-catalog-error").textContent = "";
                }
                toast("正文已读取；依赖需单独预检");
              } catch (error) {
                reportCatalogError(error);
                throw error;
              }
            })),
      );
      $$("[data-catalog-preflight]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, async () => {
              const item = catalogItems[Number(button.dataset.catalogPreflight)];
              try {
                if ($("#skill-catalog-session").value !== (scopePayload.sessionId || ""))
                  throw new Error("请先点击“读取目录”应用所选会话范围");
                const result = await api("catalog.preflight", {
                  ...scopePayload,
                  skills: [{ origin: item.origin, id: item.id }],
                });
                if (view.sessionId !== (scopePayload.sessionId || "")) return;
                view.preflight = result;
                view.error = "";
                if (inContext()) {
                  $("#skill-catalog-preflight-result").innerHTML = preflightHTML(result);
                  $("#skill-catalog-error").textContent = "";
                }
                toast("依赖预检已完成，未启动任务");
              } catch (error) {
                reportCatalogError(error);
                throw error;
              }
            })),
      );
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
              async () => {
                await api("skills.delete", { id: item.id });
                clearObjectDraft("skills", `record:${item.id}`, { allWorkspaces: true });
              },
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
            if (files.length > 200) throw new Error("文件夹超过 200 个文件，请缩小导入范围");
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
async function evidencePage(kind = state.recordKind, embedded = false, read = api) {
  if (!embedded && ["stage", "score-point", "score-hit"].includes(kind)) kind = "credential";
  const payload = { ...workspacePayload(), kind };
  const data = await read("records.list", payload);
  const items = data.items.map((item) => ({ ...item.data, ...item }));
  const checkable = ["webshell", "tunnel"].includes(kind);
  const page = state.page;
  const serial = state.request;
  const checkStatus = checkable
    ? await read("connectionChecks.status", { workspaceId: payload.workspaceId })
    : null;
  let checkRoot;
  let checkDialog;
  const inCheckContext = () =>
    state.workspaceId === payload.workspaceId &&
    state.page === page &&
    state.request === serial &&
    checkRoot?.isConnected;
  const checks = checkable
    ? connectionCheckFlow({
        api,
        workspaceId: payload.workspaceId,
        initialStatus: checkStatus,
        isCurrent: inCheckContext,
        confirm: (prepared) => {
          if (!canLeaveEditor() || !inCheckContext()) return Promise.resolve(false);
          const dialog = $("#editor");
          checkDialog = dialog;
          const ready = prepared.items.some((item) => item.state === "ready");
          dialog.innerHTML = `<div class="dialoghead"><h2>确认本次连接检查</h2><button type="button" class="quiet small" data-check-close aria-label="关闭">✕</button></div>${connectionPreview(prepared)}<div class="dialogfoot"><button type="button" data-check-cancel>${ready ? "取消" : "关闭"}</button>${ready ? '<button type="button" class="primary" data-check-accept>确认并检查允许的项目</button>' : ""}</div>`;
          dialog.oncancel = null;
          return new Promise((resolve) => {
            dialog.addEventListener(
              "close",
              () => {
                checkDialog = null;
                resolve(false);
              },
              { once: true },
            );
            $("[data-check-close]", dialog).onclick = () => dialog.close();
            $("[data-check-cancel]", dialog).onclick = () => dialog.close();
            const accept = $("[data-check-accept]", dialog);
            if (accept)
              accept.onclick = () => {
                accept.disabled = true;
                resolve(true);
                dialog.close();
              };
            dialog.showModal();
          });
        },
        changed(view) {
          checkRoot.innerHTML = connectionCheckPanel(view);
          bindChecks();
          const results = new Map((view.status?.items || []).map((item) => [item.recordId, item]));
          $$("[data-record-check]").forEach((button) => {
            button.disabled = view.busy || view.refreshing || view.status?.active === true;
            const item = items[Number(button.dataset.recordCheck)];
            const cell = button
              .closest("tr")
              .querySelector(`td:nth-child(${columns.length}) > div`);
            if (cell) cell.textContent = connectionResultText(results.get(item.id));
          });
        },
      })
    : null;
  function bindChecks() {
    if (!checkRoot) return;
    $("[data-connection-batch]", checkRoot).onclick = () =>
      checks.start(items.map((item) => item.id));
    $("[data-connection-stop]", checkRoot).onclick = () => checks.stop();
    $("[data-connection-refresh]", checkRoot).onclick = () => checks.refresh();
  }
  let fields = recordFields[kind];
  let points = [],
    assets = [],
    stages = [];
  if (kind === "credential") {
    assets = (await read("assets.list", { workspaceId: payload.workspaceId })).items;
    fields = [
      ...fields,
      field("assetId", "关联本项目资产", "select", {
        options: [["", "未关联"], ...assets.map((asset) => [asset.id, asset.name])],
      }),
      field("serviceId", "关联资产服务", "select", { options: [["", "未关联服务"]] }),
    ];
  }
  if (["score-point", "score-hit"].includes(kind)) {
    const requests = await Promise.all([
      read("records.list", { workspaceId: payload.workspaceId, kind: "stage" }),
      ...(kind === "score-hit"
        ? [
            read("records.list", { workspaceId: payload.workspaceId, kind: "score-point" }),
            read("assets.list", { workspaceId: payload.workspaceId }),
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
        : kind === "credential"
          ? {
              ...item,
              storedContent: `${item.secretState.hasSecret ? "标准内容已保存 · 不回显" : "标准内容未保存"}${item.secretState.legacyFieldCount ? ` · ${item.secretState.legacyFieldCount} 个旧隐藏字段` : ""}`,
            }
          : checkable
            ? {
                ...item,
                registeredStatus: item.status,
                connectionStatus: connectionResultText(
                  checkStatus.items.find((entry) => entry.recordId === item.id),
                ),
              }
            : item,
  );
  const columns =
    kind === "webshell"
      ? [
          ["name", "名称"],
          ["url", "登记地址"],
          ["language", "语言"],
          ["registeredStatus", "手工登记状态"],
          ["connectionStatus", "上次连接检查（只读）"],
        ]
      : kind === "tunnel"
        ? [
            ["name", "名称"],
            ["source", "来源地址"],
            ["destination", "目标地址"],
            ["protocol", "协议"],
            ["listenHost", "监听地址"],
            ["listenPort", "监听端口"],
            ["connectionStatus", "上次连接检查（只读）"],
          ]
        : kind === "score-hit"
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
            : kind === "credential"
              ? [
                  ["name", "名称"],
                  ["username", "账号"],
                  ["target", "登记目标"],
                  ["storedContent", "内容状态"],
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
                )}</div><div class="note">这是本地证据台账。保存凭据、隧道或 WebShell 信息不会连接目标或执行操作；连接检查需要单独预览并确认。凭据内容不回显，编辑留空保留，明确勾选才清空；普通说明字段不适合填写秘密。</div>`
        }${noPoints ? '<div class="note">请先在「得分点」中创建计分点，再记录命中。</div>' : ""}${shown.length ? table(shown, columns, (item, index) => `${checkable ? `<button class="small" data-record-check="${index}" ${checkStatus.active ? "disabled" : ""}>检查连接</button>` : ""}<button class="small quiet" data-record-edit="${index}">编辑</button><button class="small quiet danger" data-record-delete="${index}">删除</button>`) : empty(`暂无${kinds[kind]}记录`)}${embedded ? `<button id="create-record" style="margin-top:15px" class="small" ${noPoints ? 'disabled title="请先创建得分点"' : ""}>＋ 新增记录</button>` : ""}`,
      ) +
      (checks ? `<div id="connection-checks">${connectionCheckPanel(checks.view())}</div>` : ""),
    bind() {
      if (checks) {
        checkRoot = $("#connection-checks");
        bindChecks();
        $$("[data-record-check]").forEach((button) => {
          button.onclick = () => checks.start([items[Number(button.dataset.recordCheck)].id]);
        });
      }
      const edit = (item) => {
        const values = { ...item };
        let dynamic = ["score-hit", "credential"].includes(kind)
          ? fields.map((f) =>
              f.name === "serviceId"
                ? {
                    ...f,
                    options: [
                      ["", kind === "credential" ? "未关联服务" : "未选服务（可手动填写端口）"],
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
        if (kind === "credential" && item?.secretState.legacyFieldCount)
          dynamic = [
            ...dynamic,
            field(
              "clearLegacyFields",
              `删除 ${item.secretState.legacyFieldCount} 个旧隐藏字段`,
              "checkbox",
              {
                draft: false,
                help: "仅在明确不再需要旧字段时勾选；未勾选会原样保留，标准凭据内容另行管理。",
              },
            ),
          ];
        openForm(
          `${item ? "编辑" : "新增"}${kinds[kind]}`,
          dynamic,
          values,
          async (input) => {
            const outgoing = kind === "credential" ? { ...input } : { ...item?.data, ...input };
            if (kind === "credential") {
              if (input.clearSecret && input.secret)
                throw new Error("替换和清空不能同时选择，请明确本次修改");
              delete outgoing.clearSecret;
              delete outgoing.clearLegacyFields;
              if (input.clearSecret) outgoing.secret = "";
              else if (!input.secret) delete outgoing.secret;
            }
            if (kind === "tunnel") {
              if (input.listenPort === undefined) delete outgoing.listenPort;
              else if (
                !Number.isInteger(input.listenPort) ||
                input.listenPort < 1 ||
                input.listenPort > 65535
              )
                throw new Error("监听端口必须是 1 到 65535 的整数");
            }
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
              ...(kind === "credential"
                ? { clearLegacyFields: input.clearLegacyFields === true }
                : {}),
            });
          },
          {
            note:
              kind === "credential"
                ? `凭据内容${item?.secretState.hasSecret ? "已保存" : "尚未保存"}，不会读回或预填。登记的角色和来源只是资料记录，不授予访问权限。文件权限保护不等于存储加密。`
                : kind === "score-hit"
                  ? "同一得分点按资产与服务分别累计；相同资产、协议和端口的重复命中只计一次。"
                  : "仅保存本地记录；不会触发远程操作。",
            afterOpen(dialog) {
              if (kind === "credential") {
                const assetInput = $('[name="assetId"]', dialog);
                const serviceInput = $('[name="serviceId"]', dialog);
                assetInput.onchange = () => {
                  const services =
                    assets.find((asset) => asset.id === assetInput.value)?.services || [];
                  serviceInput.innerHTML = `<option value="">未关联服务</option>${services.map((service) => `<option value="${esc(service.id)}">${esc(`${service.protocol}/${service.port}${service.name ? " · " + service.name : ""}`)}</option>`).join("")}`;
                };
                return;
              }
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
            if (!canLeaveEditor()) return;
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
            confirmAction("删除证据", `将永久删除此${kinds[kind]}记录。`, async () => {
              const id = items[Number(b.dataset.recordDelete)].id;
              await api("records.delete", { ...payload, id });
              clearObjectDraft(state.page, `record:${id}`, { workspaceId: payload.workspaceId });
            })),
      );
    },
    dispose() {
      checks?.dispose();
      if (checkDialog?.open) checkDialog.close();
    },
  };
}
function fileErrorMessage(error) {
  if (error.code !== "RECOVERY_REQUIRED" || !error.partial) return error.message;
  const partial = error.partial;
  return `${error.message}\n需人工恢复；请保留暂存目录：${partial.stagingPath || "未返回"}\n项目：${partial.workspaceId || "未返回"}\n备份：${(partial.backups || []).map((item) => (typeof item === "string" ? item : `${item.backupId || "未知编号"} · ${item.path || ""}`)).join("；") || "未返回"}\n请勿重复写入以尝试修复。`;
}
function rememberFileResult(workspaceId, result, message) {
  const items = result.items || (result.item ? [result.item] : []);
  const backups = state.fileBackups.get(workspaceId) || new Map();
  for (const item of items)
    if (item.backupId)
      backups.set(item.backupId, {
        backupId: item.backupId,
        path: item.path,
        bytes: null,
        operation: "变更前版本",
      });
  state.fileBackups.set(workspaceId, backups);
  state.fileFeedback.set(workspaceId, {
    message,
    paths: items.map((item) => item.path),
    backupIds: items.map((item) => item.backupId).filter(Boolean),
  });
}
function rememberFileError(workspaceId, error) {
  const backups = state.fileBackups.get(workspaceId) || new Map();
  for (const item of error.partial?.backups || []) {
    const value = typeof item === "string" ? { backupId: item, path: "待人工确认" } : item;
    if (value.backupId) backups.set(value.backupId, value);
  }
  state.fileBackups.set(workspaceId, backups);
  state.fileFeedback.set(workspaceId, { error: true, message: fileErrorMessage(error) });
}
function checkedBitmapSource(item) {
  if (
    !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(item.mediaType) ||
    item.imageValidation !== "structure-only"
  )
    throw new Error("仅预览已通过结构检查的 PNG、JPEG、GIF 或 WebP；不打开 HTML 或 SVG。");
  if (
    !Number.isInteger(item.width) ||
    !Number.isInteger(item.height) ||
    item.width < 1 ||
    item.height < 1 ||
    item.width > 16384 ||
    item.height > 16384 ||
    item.width * item.height > 40000000
  )
    throw new Error("图片尺寸无效或超过预览限制");
  const value = item.contentBase64;
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((10 * 1024 * 1024) / 3) * 4 ||
    value.length % 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("图片数据无效");
  const binary = atob(value);
  const code = (index) => binary.charCodeAt(index);
  const magic =
    item.mediaType === "image/png"
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => code(i) === v)
      : item.mediaType === "image/jpeg"
        ? code(0) === 255 && code(1) === 216
        : item.mediaType === "image/gif"
          ? ["GIF87a", "GIF89a"].includes(binary.slice(0, 6))
          : binary.slice(0, 4) === "RIFF" && binary.slice(8, 12) === "WEBP";
  if (!magic || binary.length !== item.bytes) throw new Error("图片类型或长度不匹配，未生成预览");
  return `data:${item.mediaType};base64,${value}`;
}
async function filesPage(read = api) {
  const payload = workspacePayload();
  const outcomes = await Promise.allSettled([
    read("files.list", payload),
    read("files.backups", payload),
  ]);
  read.assertCurrent?.();
  const items = outcomes[0].status === "fulfilled" ? outcomes[0].value.items : [];
  const backups = state.fileBackups.get(payload.workspaceId) || new Map();
  if (outcomes[1].status === "fulfilled")
    for (const item of outcomes[1].value.items) backups.set(item.backupId, item);
  state.fileBackups.set(payload.workspaceId, backups);
  const versions = [...backups.values()];
  const feedback = state.fileFeedback.get(payload.workspaceId);
  const failures = outcomes.filter((result) => result.status === "rejected");
  const feedbackHTML = feedback
    ? `<div class="${feedback.error ? "error" : "note"}" role="status" style="white-space:pre-wrap">${esc(feedback.message)}${feedback.paths?.length ? `\n${esc(feedback.paths.join(" · "))}` : ""}${feedback.backupIds?.length ? `\n已保留 ${feedback.backupIds.length} 个变更前版本，见下方“备份版本”。` : ""}</div>`
    : "";
  return {
    dataReadComplete: failures.length === 0,
    html:
      heading(
        `${capabilityButton("files.import", "导入本地文件", 'id="import-files"')}${capabilityButton("files.write", "＋ 新建文本文件", 'id="create-file" class="primary"')}`,
      ) +
      `<div class="note">文件保存在当前项目的本机材料库，不会上传远程。文本编辑上限 1 MiB；单个导入文件 10 MiB，每批最多 128 项、合计 20 MiB。同路径写入会覆盖并保留备份。</div><input type="file" id="material-file-input" multiple hidden><div id="file-feedback">${feedbackHTML}</div>` +
      failures
        .map(
          (result) =>
            `<div class="error" role="alert">读取未完成：${esc(result.reason.message)}</div>`,
        )
        .join("") +
      panel(
        "项目文件",
        `<div class="toolbar"><span class="meta">${items.length} 个文件 · 相对路径区分现有拼写</span><button id="refresh-files" class="small">↻ 刷新文件与备份</button></div>${
          items.length
            ? table(
                items,
                [
                  ["path", "文件路径"],
                  ["bytes", "字节数"],
                  ["mediaType", "类型"],
                  ["sha256", "SHA-256"],
                ],
                (item, index) =>
                  `<button class="small" data-file-read="${index}" ${item.bytes <= 1048576 && can("files.read") ? "" : 'disabled title="文本读取限 1 MiB"'}>查看 / 编辑文本</button><button class="small" data-file-preview="${index}" ${item.previewable && can("files.preview") ? "" : 'disabled title="仅已检查结构的位图可预览"'}>图片预览</button><button class="small danger" data-file-delete="${index}" ${can("files.delete") ? "" : "disabled"}>删除</button>`,
              )
            : empty(
                "尚无本地文件",
                outcomes[0].status === "rejected"
                  ? "读取失败，请刷新；不会将失败视为空库。"
                  : "新建文本或选择本机材料导入当前项目。",
              )
        }`,
      ) +
      panel(
        "备份版本",
        `<details ${versions.length ? "open" : ""}><summary>${versions.length} 个可恢复版本</summary><p class="info">恢复会写回原路径；若当前路径已有文件，也会先保留当前版本。备份列表可从本机重新读取。</p>${
          versions.length
            ? table(
                versions,
                [
                  ["path", "原文件路径"],
                  ["bytes", "字节数"],
                  ["backupId", "备份编号"],
                ],
                (item, index) =>
                  `<button class="small" data-file-restore="${index}" ${can("files.restore") ? "" : "disabled"}>恢复此版本</button>`,
              )
            : empty("暂无备份版本", "覆盖或删除文件后可在此恢复旧版本。")
        }</details>`,
      ) +
      '<div id="file-preview"></div>',
    bind() {
      const inContext = () => state.page === "files" && state.workspaceId === payload.workspaceId;
      const showError = (error) => {
        rememberFileError(payload.workspaceId, error);
        if (inContext())
          $("#file-feedback").innerHTML =
            `<div class="error" role="alert" style="white-space:pre-wrap">${esc(fileErrorMessage(error))}</div>`;
      };
      const edit = (item) =>
        openForm(
          item ? "编辑本地文本文件" : "新建本地文本文件",
          [
            field("path", "项目内相对路径", "text", {
              required: true,
              readonly: Boolean(item),
              help: "例如 evidence/notes.md；不接受绝对路径或父目录跳转。",
            }),
            field("content", "UTF-8 文本正文", "textarea"),
          ],
          item || {},
          async (values) => {
            try {
              if (new TextEncoder().encode(values.content).length > 1048576)
                throw new Error("文本正文超过 1 MiB，未写入");
              const result = await api("files.write", { ...payload, ...values });
              rememberFileResult(
                payload.workspaceId,
                result,
                "文本已保存。已有同路径文件时，变更前版本已备份。",
              );
            } catch (error) {
              showError(error);
              throw error;
            }
          },
          {
            draftId: item ? `file:${item.path}` : "file:new",
            note: "保存会覆盖同路径文件；旧版本可在“备份版本”恢复。此编辑器只保存文字，不执行内容。",
          },
        );
      $("#create-file").onclick = () => edit();
      $("#refresh-files").onclick = render;
      $("#import-files").onclick = () => $("#material-file-input").click();
      $("#material-file-input").onchange = (event) => {
        const selected = [...event.target.files];
        event.target.value = "";
        if (!selected.length) return;
        run($("#import-files"), async () => {
          try {
            if (
              selected.length > 128 ||
              selected.some((file) => file.size > 10 * 1024 * 1024) ||
              selected.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024
            )
              throw new Error("超出导入限制：最多 128 项，每项 10 MiB，每批合计 20 MiB");
            const imports = await Promise.all(
              selected.map(async (file) => ({
                path: file.name,
                contentBase64: await encodeSkillFile(file),
                ...(file.type ? { mediaType: file.type } : {}),
              })),
            );
            if (!inContext()) return;
            confirmAction(
              "导入本地文件",
              `将 ${imports.length} 个文件导入当前项目。同路径文件将覆盖并保留备份；不会执行导入内容。`,
              async () => {
                try {
                  const result = await api("files.import", { ...payload, items: imports });
                  rememberFileResult(
                    payload.workspaceId,
                    result,
                    `已导入 ${result.items.length} 个文件。`,
                  );
                } catch (error) {
                  showError(error);
                  throw error;
                }
              },
            );
          } catch (error) {
            showError(error);
            throw error;
          }
        });
      };
      $$("[data-file-read]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, async () => {
              try {
                const result = await api("files.read", {
                  ...payload,
                  path: items[Number(button.dataset.fileRead)].path,
                  encoding: "utf8",
                });
                if (inContext()) edit(result.item);
              } catch (error) {
                showError(error);
                throw error;
              }
            })),
      );
      $$("[data-file-preview]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, async () => {
              try {
                const result = await api("files.preview", {
                  ...payload,
                  path: items[Number(button.dataset.filePreview)].path,
                });
                const source = checkedBitmapSource(result.item);
                if (!inContext()) return;
                $("#file-preview").innerHTML = panel(
                  "图片预览",
                  `<p class="info">${esc(result.item.path)} · ${result.item.width} × ${result.item.height}。已检查文件结构，浏览器仍需解码图片；不代表完整内容或可信性验证。</p><img id="material-preview-image" class="material-image" alt="${esc(result.item.path)}"><p id="material-preview-error" class="inlineerror" role="alert"></p>`,
                );
                const image = $("#material-preview-image");
                image.onerror = () => {
                  image.removeAttribute("src");
                  $("#material-preview-error").textContent =
                    "浏览器无法解码此图片，未显示预览。原文件保留。";
                };
                image.src = source;
              } catch (error) {
                showError(error);
                throw error;
              }
            })),
      );
      $$("[data-file-delete]").forEach(
        (button) =>
          (button.onclick = () => {
            const item = items[Number(button.dataset.fileDelete)];
            confirmAction("删除文件", `将删除 ${item.path}。删除前会保留可恢复版本。`, async () => {
              try {
                const result = await api("files.delete", { ...payload, path: item.path });
                rememberFileResult(payload.workspaceId, result, "文件已删除，删除前版本已保留。");
                clearObjectDraft("files", `file:${item.path}`, {
                  workspaceId: payload.workspaceId,
                });
              } catch (error) {
                showError(error);
                throw error;
              }
            });
          }),
      );
      $$("[data-file-restore]").forEach(
        (button) =>
          (button.onclick = () => {
            const backup = versions[Number(button.dataset.fileRestore)];
            confirmAction(
              "恢复备份",
              `将恢复 ${backup.path || "该备份的原路径"}。当前同路径文件会先备份，未保存的编辑仍保留为草稿。`,
              async () => {
                try {
                  const result = await api("files.restore", {
                    ...payload,
                    backupId: backup.backupId,
                  });
                  rememberFileResult(
                    payload.workspaceId,
                    result,
                    `备份版本已恢复：${backup.backupId}`,
                  );
                } catch (error) {
                  showError(error);
                  throw error;
                }
              },
            );
          }),
      );
    },
  };
}
async function graphPage(read = api) {
  const payload = workspacePayload();
  const data = await read("assets.graph", payload);
  const timeline = await read("assets.timeline", payload);
  const pathState = state.graphPaths.get(payload.workspaceId);
  const pathResult = (value) =>
    !value
      ? '<p class="info">选择起点与终点，查询已保存关系中的最短路径。</p>'
      : value.error
        ? `<div class="error" role="alert">${esc(value.error)}</div>`
        : !value.data.found
          ? empty("未找到关系路径", "在所选方向下，起点与终点之间没有已保存的连接。")
          : `<p class="info">${value.data.direction === "undirected" ? "忽略方向" : "按关系方向"} · ${value.data.edges.length} 条关系</p><ol class="path-steps">${value.data.nodes.map((node, index) => `<li><strong>${esc(redactCell(node.name || node.address || node.id))}</strong>${index < value.data.edges.length ? `<p>${esc(redactCell(value.data.edges[index].relation || "已登记关系"))}${value.data.edges[index].from !== node.id ? " · 反向经过" : ""}</p>` : ""}</li>`).join("")}</ol>`;
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
        "最短关系路径",
        `<form id="graph-path-form" class="graph-path-form"><div class="field"><label for="graph-path-from">起点资产</label><select id="graph-path-from" name="from" required>${nodes.map((node) => `<option value="${esc(node.id)}" ${pathState?.query?.from === node.id ? "selected" : ""}>${esc(node.name || node.address || node.id)}</option>`).join("")}</select></div><div class="field"><label for="graph-path-to">终点资产</label><select id="graph-path-to" name="to" required>${nodes.map((node) => `<option value="${esc(node.id)}" ${pathState?.query?.to === node.id ? "selected" : ""}>${esc(node.name || node.address || node.id)}</option>`).join("")}</select></div><div class="field"><label for="graph-path-direction">关系方向</label><select id="graph-path-direction" name="direction"><option value="directed">按关系方向</option><option value="undirected" ${pathState?.query?.direction === "undirected" ? "selected" : ""}>忽略方向</option></select></div><button type="submit" ${nodes.length ? "" : "disabled"}>查询路径</button></form><div id="graph-path-result">${pathResult(pathState)}</div>`,
      ) +
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
      $("#graph-path-form").onsubmit = (event) => {
        event.preventDefault();
        const form = event.target;
        const query = Object.fromEntries(new FormData(form));
        run($('button[type="submit"]', form), async () => {
          try {
            const data = await api("assets.path", { ...payload, ...query });
            const value = { query, data };
            state.graphPaths.set(payload.workspaceId, value);
            if (state.page === "graph" && state.workspaceId === payload.workspaceId) {
              commitInlineDraft("graph-path-form");
              $("#graph-path-result").innerHTML = pathResult(value);
            }
            toast(data.found ? "已找到最短关系路径" : "未找到关系路径");
          } catch (error) {
            const value = { query, error: error.message };
            state.graphPaths.set(payload.workspaceId, value);
            if (state.page === "graph" && state.workspaceId === payload.workspaceId)
              $("#graph-path-result").innerHTML = pathResult(value);
            throw error;
          }
        });
      };
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
async function progressPage(read = api) {
  const kind = ["stage", "score-point", "score-hit"].includes(state.recordKind)
    ? state.recordKind
    : "stage";
  const payload = workspacePayload();
  const evidence = await evidencePage(kind, true, read);
  const report = await read("report.build", payload);
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
            if (!canLeaveEditor()) return;
            state.recordKind = b.dataset.progressKind;
            render();
          }),
      );
    },
  };
}
async function rolesPage(read = api) {
  const payload = workspacePayload();
  await refreshStatus(read);
  const [rolesResult, flowResult, workflowResult, presetResult] = await Promise.allSettled([
    read("roles.list", payload),
    read("flow.status", payload),
    read("workflow.status", payload),
    read("workflow.presets", { operation: "status" }),
  ]);
  read.assertCurrent?.();
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
  const plansView = await workflowPlans({
    api,
    esc,
    panel,
    table,
    empty,
    toast,
    run,
    workspaceId: payload.workspaceId,
    sessions,
    roles: items,
  });
  const flow = flowResult.status === "fulfilled" ? flowResult.value : null;
  const runs = workflowResult.status === "fulfilled" ? workflowResult.value.items : [];
  const preset = presetResult.status === "fulfilled" ? presetResult.value : null;
  const ownedSessions = new Set(
    runs.filter((run) => !run.slotReleased).map((run) => run.sessionId),
  );
  const workflowBody = `<div class="toolbar"><button class="primary" id="dispatch-workflow" ${can("workflow.dispatch") && bound.length ? "" : 'disabled title="需要官方执行者服务及已绑定当前项目的父会话"'}>分派执行任务</button><button id="refresh-workflow">刷新执行结果</button><button id="register-workflow-preset" ${can("workflow.presets") ? "" : "disabled"}>${preset?.owned ? "撤销本项目预设" : "注册本项目预设"}</button></div><p class="info">分派会真正创建官方子代理，先占用本项目执行槽，再开始任务。完成或确认停止后释放；停止未确认时保留占用。预设和运行列表只在当前插件进程有效，真实会话由宿主留存。</p>${
    workflowResult.status === "rejected"
      ? `<div class="error">${esc(workflowResult.reason.message)}</div>`
      : runs.length
        ? table(
            runs.map((run) => ({
              ...run,
              roleLabel: roleNames[run.role] || run.role,
              slot: run.slotReleased ? "已释放" : "仍占用",
            })),
            [
              ["id", "运行编号"],
              ["roleLabel", "角色"],
              ["status", "执行状态"],
              ["slot", "槽位"],
            ],
            (run, index) =>
              `<button class="small" data-workflow-result="${index}">详情与结果</button><button class="small danger" data-workflow-stop="${index}" ${!run.slotReleased && can("workflow.stop") ? "" : "disabled"}>停止执行者</button>`,
          )
        : empty("尚无执行任务", "先绑定父会话，再明确角色和本次任务。")
  }<div id="workflow-outcome"></div>`;
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
                ownedSessions.has(item.sessionId)
                  ? '<span class="meta">由执行任务管理</span>'
                  : `<button class="small quiet" data-flow-edit="${index}">调整角色</button>${item.slotState === "已占用" ? `<button class="small" data-flow-release="${index}">释放槽位</button>` : `<button class="small" data-flow-acquire="${index}" ${flow.available > 0 ? "" : 'disabled title="槽位已满，请先释放"'}>占用本地槽位</button>`}<button class="small quiet danger" data-flow-unassign="${index}">撤销分配</button>`,
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
    dataReadComplete: [flowResult, workflowResult, presetResult].every(
      (r) => r.status === "fulfilled",
    ),
    html:
      heading('<button id="reset-roles" class="danger">重置角色提示词</button>') +
      panel("执行任务", workflowBody) +
      plansView.html +
      panel("本地槽位管理", flowBody) +
      `<div class="grid2 equal">${items.map((item) => panel(roleNames[item.role] || item.role, `<div class="eyebrow">${esc(item.role.toUpperCase())}${["analyst", "reviewer"].includes(item.role) ? " · COMPATIBILITY" : ""}</div><p class="info" style="white-space:pre-wrap;max-height:210px;overflow:auto;min-height:100px">${esc(redactCell(item.content || "尚未配置提示词。", "content"))}</p><button data-role="${esc(item.role)}" class="small">编辑提示词</button>`)).join("")}</div>`,
    bind() {
      plansView.bind();
      $("#workflow-plan-create-form")?.addEventListener("workflow-plan:saved", () => {
        commitInlineDraft("workflow-plan-create-form");
      });
      $("#refresh-workflow").onclick = render;
      $("#register-workflow-preset").onclick = () =>
        confirmAction(
          preset?.owned ? "撤销运行期预设" : "注册运行期预设",
          "仅注册或撤销本项目拥有的预设。保留用户同名定义和角色自定义内容，不写宿主 profile。",
          async () => {
            await api("workflow.presets", { operation: preset?.owned ? "unregister" : "register" });
          },
        );
      $("#dispatch-workflow").onclick = () =>
        openForm(
          "分派执行任务",
          [
            field("parentSessionId", "已绑定本项目的父会话", "select", {
              required: true,
              options: bound
                .filter((session) => !ownedSessions.has(session.id))
                .map((session) => [session.id, session.name || session.id]),
            }),
            field("role", "执行角色", "select", {
              required: true,
              options: items.map((role) => [role.role, roleNames[role.role] || role.role]),
            }),
            field("task", "本次明确任务", "textarea", { required: true }),
            field("usePreset", "采用本项目运行期预设", "checkbox", { disabled: !preset?.owned }),
          ],
          {},
          async (values) => {
            try {
              const result = await api("workflow.dispatch", { ...payload, ...values });
              state.flowFeedback = {
                workspaceId: payload.workspaceId,
                message: `执行任务已读回：${result.item.id} · ${result.item.status}。请在执行结果中核对实际完成内容。`,
              };
            } catch (error) {
              if (error.partial?.item)
                state.flowFeedback = {
                  workspaceId: payload.workspaceId,
                  failed: true,
                  message: `分派未完成：${error.partial.item.id}，槽位${error.partial.item.slotReleased ? "已释放" : "仍占用"}。${error.message}`,
                };
              throw error;
            }
          },
          {
            draftId: "workflow:new-task",
            submit: "启动执行者",
            note: "会创建实际子代理并提交上述任务，可能产生模型调用费用。任务须处于当前项目和宿主已经允许的范围内。",
          },
        );
      $$("[data-workflow-result]").forEach((button) => {
        button.onclick = () =>
          run(button, async () => {
            const result = await api("workflow.status", {
              ...payload,
              id: runs[Number(button.dataset.workflowResult)].id,
            });
            if (state.page !== "roles" || state.workspaceId !== payload.workspaceId) return;
            $("#workflow-outcome").innerHTML = panel(
              "执行结果读回",
              `<pre class="code">${esc(JSON.stringify(redactCell(result.item), null, 2))}</pre>`,
            );
          });
      });
      $$("[data-workflow-stop]").forEach((button) => {
        button.onclick = () =>
          confirmAction(
            "停止执行者",
            "仅停止本项目创建的这一执行者。确认停止后才会释放其执行槽。",
            async () => {
              const result = await api("workflow.stop", {
                ...payload,
                id: runs[Number(button.dataset.workflowStop)].id,
              });
              state.flowFeedback = {
                workspaceId: payload.workspaceId,
                message: `停止结果：${result.item.status}；槽位${result.item.slotReleased ? "已释放" : "仍占用"}。`,
              };
            },
          );
      });
      $$("[data-role]").forEach(
        (b) =>
          (b.onclick = () => {
            const item = items.find((i) => i.role === b.dataset.role);
            openForm(
              `编辑${roleNames[b.dataset.role] || b.dataset.role}提示词`,
              [field("content", "提示词内容", "textarea")],
              item,
              (data) => api("roles.save", { ...payload, role: b.dataset.role, ...data }),
              { draftId: `role:${b.dataset.role}` },
            );
          }),
      );
      $("#reset-roles").onclick = () =>
        confirmAction("重置角色提示词", "当前项目的角色提示词将恢复为默认内容。", async () => {
          await api("roles.reset", payload);
          for (const item of items)
            clearObjectDraft("roles", `role:${item.role}`, { workspaceId: payload.workspaceId });
        });
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
            draftId: item ? `flow:assignment:${item.sessionId}` : "flow:new-assignment",
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
                clearObjectDraft("roles", `flow:assignment:${row.sessionId}`, {
                  workspaceId: payload.workspaceId,
                });
                const pendingAssignment = drafts.read(
                  draftScope("flow:new-assignment", {
                    ...state,
                    workspaceId: payload.workspaceId,
                    page: "roles",
                  }),
                );
                if (pendingAssignment?.sessionId === row.sessionId)
                  clearObjectDraft("roles", "flow:new-assignment", {
                    workspaceId: payload.workspaceId,
                  });
                setFeedback("已撤销本地角色分配；该会话不再占用槽位。");
              },
            );
          }),
      );
    },
    dispose: () => plansView.dispose?.(),
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
async function reportsPage(read = api) {
  const project = state.workspaces.find((w) => w.id === state.workspaceId);
  const data = await read("report.build", workspacePayload());
  const markdown = data.markdown || "";
  return {
    html:
      heading('<button id="download-report" class="primary">↓ 导出 Markdown</button>') +
      panel(
        "项目报告",
        markdown
          ? `<div class="report">${esc(markdown)}</div>`
          : empty("报告内容为空", "记录资产、发现与证据后重新生成报告。"),
        "本地生成 · Markdown",
      ) +
      `<div class="note">导出文件可能包含敏感证据。保存到合适的本地目录，并按项目保密要求处理。</div>`,
    bind() {
      $("#download-report").disabled = !markdown;
      $("#download-report").onclick = () => {
        download(`${(project?.name || "演练报告").replace(/[\\/:*?"<>|]/g, "_")}.md`, markdown);
        toast("已生成本地下载文件");
      };
    },
  };
}
function openRewind(item) {
  if (!canLeaveEditor()) return;
  const dialog = $("#editor");
  let fork = null;
  dialog.innerHTML = `<form id="rewind-form"><div class="dialoghead"><h2>会话回退</h2><button class="quiet small" type="button" id="close-rewind">关闭</button></div><div class="note">${esc(rewindNotice)}</div>${renderField(
    field("mode", "回退方式", "select", {
      options: [
        ["turn", "回退整轮"],
        ["step", "回退一步 · 回到前一步结束"],
      ],
    }),
    "turn",
  )}${renderField(
    field("childOrigin", "子代理定位依据（普通会话忽略）", "select", {
      options: [
        ["creation", "创建来源"],
        ["latest", "最近接纳输入 · 需有来源记录"],
      ],
    }),
    "creation",
  )}<div id="rewind-result"></div><p id="rewind-error" class="inlineerror" role="alert"></p><div class="dialogfoot"><button type="button" id="cancel-rewind">取消</button><button class="primary" type="submit" id="submit-rewind">创建回退分支</button></div></form>`;
  const binding = bindMemoryDraft($("#rewind-form"), draftScope(`rewind:${item.id}`));
  const editor = { binding, saving: false };
  editorDraft = editor;
  const close = () => {
    if (editor.saving) return;
    binding.capture();
    editorDraft = null;
    dialog.close();
    render();
  };
  dialog.oncancel = (event) => {
    event.preventDefault();
    close();
  };
  $("#close-rewind").onclick = close;
  $("#cancel-rewind").onclick = close;
  $("#rewind-form").onsubmit = (e) => {
    e.preventDefault();
    const button = $("#submit-rewind");
    run(button, async () => {
      editor.saving = true;
      $("#rewind-error").textContent = "";
      try {
        if (!(await probeBridge())) throw new Error("当前宿主草稿桥不可用；未创建新的回退分支");
        if (!fork) {
          fork = await api("sessions.rewind", {
            id: item.id,
            mode: new FormData(e.target).get("mode"),
            childOrigin: new FormData(e.target).get("childOrigin"),
            draftBridgeReady: true,
            draftBridgeSupports: state.bridgeSupports,
          });
          binding.commit();
          state.rewindOutcome = { ...fork, draftStatus: "pending-client" };
          $("#f-mode").disabled = true;
          $("#f-childOrigin").disabled = true;
        }
        try {
          const restored = await bridgeRequest("restore", {
            newSessionId: fork.newSessionId,
            draft: fork.draft,
            ...(fork.attachmentBatch ? { attachmentBatch: fork.attachmentBatch } : {}),
          });
          state.rewindOutcome = {
            ...fork,
            draftStatus: restored.draftStatus,
            textStatus: restored.textStatus,
            attachmentStatus: restored.attachmentStatus,
            uploadStatus: restored.uploadStatus,
            openStatus: restored.openStatus,
            navigationConfirmed: restored.navigationConfirmed,
          };
        } catch (error) {
          state.rewindOutcome = {
            ...fork,
            draftStatus:
              error.draftStatus || (error.message.includes("未响应") ? "pending-client" : "failed"),
            error: error.message,
            textStatus: error.textStatus,
            attachmentStatus: error.attachmentStatus,
            uploadStatus: error.uploadStatus,
            openStatus: error.openStatus,
            navigationConfirmed: error.navigationConfirmed,
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
          if (state.rewindOutcome?.draftStatus === "restored" || fork.attachmentBatch) {
            button.hidden = true;
            $("#cancel-rewind").textContent = "关闭";
            if (fork.attachmentBatch && state.rewindOutcome.draftStatus !== "restored")
              $("#rewind-error").textContent =
                "本次附件恢复已结束，原会话和原附件仍保留。请按新会话编号检查文字和附件状态；不会重复创建分支或用已释放的批次重试。";
          } else
            setTimeout(() => {
              if (button.isConnected) button.textContent = "重试恢复同一分支草稿";
            }, 0);
        } else $("#rewind-error").textContent = error.message;
        throw error;
      } finally {
        editor.saving = false;
      }
    });
  };
  dialog.showModal();
}
function continuationDetails(result, sessionId) {
  const row = (label, value) =>
    `<div class="twocoltext"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
  const manual = result.manualRun;
  const statuses = {
    starting: "正在启动",
    running: "运行中",
    completed: "已完成",
    truncated: "输出再次截断",
    failed: "失败",
    stopped: "已停止",
    released: "控制权已释放",
  };
  const stopReasons = {
    "max-tokens": "输出达到长度上限",
    aborted: "已取消",
    completed: "正常结束",
  };
  const manualDetails = manual
    ? `<div class="note"><strong>子会话手动续跑 · 新执行</strong>${row("执行状态", statuses[manual.status] || manual.status)}${manual.stopReason ? row("结束原因", stopReasons[manual.stopReason] || manual.stopReason) : ""}${row("并发名额", manual.slotHeld ? "占用中" : "未占用")}${manual.status === "released" ? '<p class="info">当前输入已由宿主接管，本插件已释放控制权。</p>' : ""}${manual.error ? `<div class="error" role="alert">${esc(manual.error.message || manual.error)}</div>` : ""}<details><summary>查看执行记录</summary>${row("当前会话", sessionId)}${row("执行标识", manual.id)}${row("宿主运行标识", manual.runId || "尚未分配")}${row("父会话", manual.parentSessionId)}${manual.workspaceId ? row("项目标识", manual.workspaceId) : ""}${manual.messageId ? row("消息标识", manual.messageId) : ""}${manual.stopReason ? row("原始结束原因", manual.stopReason) : ""}</details></div>`
    : "";
  return panel(
    "截断后继续",
    `<p class="info">${result.child ? "使用当前提示词和角色恢复子任务；新执行单独记录，原任务记录保持不变。" : "根会话可手动或自动继续截断内容。"}</p>${manual ? "" : row("当前会话", sessionId)}${row("最近结束原因", stopReasons[result.eligibleReason] || result.eligibleReason || "无可用结束记录")}${row("本次输入链已自动继续", `${result.automaticCount} / ${result.limit}`)}${manualDetails}${result.unsupportedReason ? `<div class="note">${esc(result.unsupportedReason)}</div>` : ""}${result.lastError ? `<div class="error" role="alert">${esc(result.lastError.message)}</div>` : ""}<div class="toolbar"><button id="manual-continue" ${result.manualAvailable ? "" : "disabled"}>${result.child ? "手动继续子会话（新执行）" : "手动继续截断内容"}</button><button id="stop-continuation" class="danger">停止本插件续跑</button><button id="reload-continuation">刷新状态</button></div><p class="info">${result.autoEnabled ? "自动继续已开启" : "自动继续已关闭"}${result.pending ? " · 等待提交" : ""}${result.stopped ? " · 本次链已停止" : ""}。停止仅控制本插件所属的自动继续或子会话手动续跑输入。</p>`,
  );
}
function continuationView({ api, element, run, confirmAction, isCurrent }) {
  let disposed = false;
  let serial = 0;
  const active = () => !disposed && isCurrent() && element.isConnected;
  const current = (version) => active() && version === serial;
  const assertCurrent = (version) => {
    if (!current(version)) throw new Error("会话或页面已切换，请重新查看继续状态。");
  };
  const show = async (sessionId) => {
    if (!active()) return false;
    const version = ++serial;
    element.innerHTML = panel(
      "截断后继续",
      `<p class="info">正在读取 ${esc(sessionId)} 的继续状态…</p>`,
    );
    let result;
    try {
      result = await api("continuation.status", { sessionId });
    } catch (error) {
      if (current(version)) throw error;
      return false;
    }
    if (!current(version)) return false;
    element.innerHTML = continuationDetails(result, sessionId);
    element.querySelector("#reload-continuation").onclick = (event) =>
      run(event.target, () => show(sessionId));
    element.querySelector("#manual-continue").onclick = () => {
      assertCurrent(version);
      if (!result.manualAvailable) return;
      confirmAction(
        "继续截断内容",
        result.child
          ? "将采用当前保存的继续用语、系统提示词和角色恢复子会话并创建新执行，不复用原工作流任务回执；宿主可能通知父会话。消息保留本插件来源，可能产生模型调用费用。"
          : "将采用当前继续用语和系统提示词提交新一轮，消息保留本插件来源，可能产生模型调用费用。",
        async () => {
          assertCurrent(version);
          await api("continuation.continue", { sessionId });
          return current(version) ? show(sessionId) : false;
        },
        { keepPage: true },
      );
    };
    element.querySelector("#stop-continuation").onclick = (event) =>
      run(event.target, async () => {
        assertCurrent(version);
        await api("continuation.stop", { sessionId });
        if (current(version)) await show(sessionId);
      });
    return true;
  };
  return {
    show,
    dispose() {
      disposed = true;
      serial++;
    },
  };
}
async function sessionsPage(read = api) {
  const request = state.request;
  await Promise.all([refreshStatus(read), probeBridge()]);
  const items = state.status.sessions || [];
  let continuation;
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
                  `<button class="small" data-bind-session="${index}" ${state.workspaceId && state.admission?.accepted ? "" : 'disabled title="请先完成演练入口确认并激活项目"'}>绑定项目</button><button class="small" data-rewind="${index}" ${can("sessions.rewind") && state.bridgeReady ? "" : 'disabled title="宿主回退能力与草稿桥都就绪后方可使用"'}>回退 / 分支</button><button class="small" data-continuation="${index}" ${can("continuation.status") ? "" : "disabled"}>继续状态</button>`,
              )
            : empty("没有可读取的宿主会话", "会话由当前宿主提供，独立预览不包含真实宿主会话。")
        }`,
      ) +
      '<div id="continuation-detail"></div>',
    bind() {
      $("#refresh-sessions").onclick = render;
      continuation = continuationView({
        api,
        element: $("#continuation-detail"),
        run,
        confirmAction,
        isCurrent: () => state.page === "sessions" && state.request === request,
      });
      $$("[data-continuation]").forEach((button) => {
        button.onclick = () =>
          run(button, () => continuation.show(items[Number(button.dataset.continuation)].id));
      });
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
    dispose: () => continuation?.dispose(),
  };
}
async function environmentPage(read = api) {
  await refreshStatus(read);
  const localEnvironment = await environmentSettings({ api: read, esc, panel, toast, run });
  const workspaceId = state.workspaceId;
  environmentPage.views ||= new Map();
  const view = environmentPage.views.get(workspaceId) || {
    sessionId: "",
    preflight: null,
    error: "",
  };
  environmentPage.views.set(workspaceId, view);
  const scopePayload = view.sessionId ? { sessionId: view.sessionId } : {};
  const requirementsFormId = `environment-requirements-${[...view.sessionId].map((character) => character.codePointAt(0).toString(16)).join("-") || "host"}`;
  let catalog = null,
    catalogError = "";
  if (can("catalog.list")) {
    try {
      catalog = await read("catalog.list", scopePayload);
    } catch (error) {
      catalogError = error.message;
    }
  }
  const choices = (state.status?.sessions || []).map((session) => [
    session.id,
    session.name || session.id,
  ]);
  if (view.sessionId && !choices.some(([id]) => id === view.sessionId))
    choices.push([view.sessionId, `${view.sessionId} · 当前未列出，请重新选择`]);
  const preflightHTML = (value) =>
    !value
      ? ""
      : panel(
          "环境依赖预检",
          `<div class="note">${esc({ ready: "声明范围内通过", unknown: "仍有未知项", blocked: "存在依赖缺口" }[value.status] || value.status)}。预检只检查明确声明、注册表、本地目录与配置状态；不读取秘密值或私钥内容，不代表授权、连接健康或任务执行成功。${value.environment?.revision !== undefined ? ` 环境配置版本 ${esc(value.environment.revision)}。` : ""}</div>${
            value.checks.length
              ? table(
                  value.checks.map((check) => ({
                    ...check,
                    target: check.name || check.path || "声明完整性",
                    result:
                      {
                        available: "已检测到",
                        ready: "已配置",
                        missing: "缺失",
                        unknown: "未知",
                        invalid: "声明无效",
                      }[check.state] || check.state,
                    kindLabel:
                      {
                        tool: "宿主工具",
                        toolkit: "本机工具",
                        directory: "本地目录",
                        skill: "技能",
                        catalog: "目录来源",
                        declaration: "声明完整性",
                        "environment-variable": "环境变量",
                        "environment-host": "主机登记",
                        "environment-key": "私钥元信息",
                      }[check.kind] || check.kind,
                  })),
                  [
                    ["kindLabel", "检查项"],
                    ["target", "依赖"],
                    ["result", "结果"],
                    ["detail", "说明"],
                  ],
                )
              : '<p class="info">本次明确声明为空，未列出额外依赖。</p>'
          }`,
        );
  const registered = catalog?.tools || [];
  const catalogHTML = panel(
    "会话工具目录与预检",
    `<form id="environment-catalog-scope" class="toolbar"><div class="field"><label for="environment-catalog-session">会话作用域</label><select id="environment-catalog-session" name="sessionId"><option value="">宿主全局 · 无会话</option>${choices.map(([id, label]) => `<option value="${esc(id)}" ${view.sessionId === id ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></div><button type="submit" ${can("catalog.list") ? "" : "disabled"}>读取工具目录</button></form><p class="info">当前目录范围：${esc(view.sessionId || "宿主全局")}。下表来自官方公开工具注册表；MCP 来源仅保留公开名称，不探测连接或执行工具。</p>${catalogError ? `<div class="error" role="alert">工具目录读取失败：${esc(catalogError)}</div>` : !can("catalog.list") ? '<div class="note">当前未提供聚合目录接口，本机路径设置仍可使用。</div>' : ""}<p id="environment-catalog-error" class="inlineerror" role="alert">${esc(view.error)}</p>${
      registered.length
        ? table(
            registered.map((tool) => ({
              ...tool,
              sourceLabel:
                tool.source.namespace === "mcp"
                  ? "MCP 公开名称 · 未验证连接"
                  : "ToolRuntime 注册表",
              modeLabel:
                { native: "原生工具", code: "原生与代码", ptc: "通过代码调用", unknown: "未知" }[
                  tool.mode
                ] || tool.mode,
              directLabel:
                tool.modelDirect === null
                  ? "未知"
                  : tool.modelDirect
                    ? "模型可直接调用"
                    : "通过代码工具调用",
            })),
            [
              ["name", "公开工具名称"],
              ["description", "用途"],
              ["sourceLabel", "来源"],
              ["modeLabel", "呈现模式"],
              ["directLabel", "调用方式"],
            ],
            (tool, index) =>
              `<button class="small" data-environment-tool-check="${index}" ${can("catalog.preflight") ? "" : "disabled"}>预检此工具声明</button>`,
          )
        : empty(
            "当前会话目录没有已登记工具",
            catalogError ? "请重新读取；失败不代表工具目录为空。" : "检查会话选择及目录来源状态。",
          )
    }${
      catalog
        ? `<details><summary>目录来源状态</summary>${table(
            Object.entries(catalog.sources).map(([name, source]) => ({
              name:
                {
                  skills: "宿主技能",
                  project: "项目技能库",
                  tools: "宿主工具",
                  toolkit: "本机工具目录",
                }[name] || name,
              result:
                source.state === "available"
                  ? source.complete === false
                    ? "部分结果"
                    : "已读取"
                  : source.state === "unsupported"
                    ? "未提供"
                    : "读取失败",
              detail: source.detail || "",
            })),
            [
              ["name", "来源"],
              ["result", "状态"],
              ["detail", "说明"],
            ],
          )}</details>`
        : ""
    }<form id="${requirementsFormId}"><details><summary>明确声明本次所需依赖</summary><div class="fields" style="margin-top:16px"><div class="field"><label for="required-host-tools">所需宿主工具 · 每行公开名称</label><textarea id="required-host-tools" name="hostTools" rows="3" placeholder="例如已登记的工具名称"></textarea></div><div class="field"><label for="required-local-tools">所需本机工具 · 每行标识</label><textarea id="required-local-tools" name="localTools" rows="3" placeholder="例如 nmap"></textarea></div><div class="field wide"><label for="required-directories">所需本地目录 · 每行一个</label><textarea id="required-directories" name="directories" rows="3" placeholder="绝对路径，或相对于当前会话工作目录的路径"></textarea></div><div class="field"><label for="required-variables">所需环境变量 · 每行名称</label><textarea id="required-variables" name="variables" rows="3" placeholder="SYNTHETIC_TOKEN"></textarea><small>只检查已配置且非空，不返回值。</small></div><div class="field"><label for="required-hosts">所需登记主机 · 每行一个</label><textarea id="required-hosts" name="hosts" rows="3" placeholder="operator@example.invalid"></textarea><small>只核对本安装登记，不连接或授予权限。</small></div><div class="field wide"><label for="required-keys">所需私钥登记编号 · 每行一个</label><textarea id="required-keys" name="keys" rows="3" placeholder="使用上方私钥登记编号"></textarea><small>只检查登记编号与文件元信息，不读取内容或验证密钥有效性。</small></div></div></details><p class="info">留空表示本次未声明额外依赖；仍检查已配置的工具目录。未声明的技能依赖不会被猜测或自动安装。</p><button type="submit" ${can("catalog.preflight") ? "" : "disabled"}>预检明确依赖</button></form>`,
  );
  const data = await read("toolkit.status");
  const monitor = await processMonitor({ api: read, workspaceId, esc, panel, empty, run, toast });
  const tools = data.tools || [];
  const feedback = state.environmentFeedback;
  const identityLabel = (value) =>
    ({
      verified: "产品标识已匹配",
      unverified: "待检查产品标识",
      "name-only": "仅按路径登记",
      missing: "未找到",
      mismatch: "产品不匹配",
      unknown: "身份未确认",
    })[value] || value;
  return {
    html:
      heading(capabilityButton("toolkit.adapt", "离线适配建议", 'id="adapt-tools"')) +
      monitor.html +
      localEnvironment.html +
      (feedback
        ? `<div class="${feedback.error ? "error" : "note"}" role="status">${esc(feedback.message)}</div>`
        : "") +
      `<div class="grid2"><div>${panel(
        "工具可用性",
        `<div class="note">仅检查本地版本与帮助信息，不启动扫描。HTTPX 需检查产品标识；同名的 Python 客户端不能标为可用。</div>${
          tools.length
            ? table(
                tools.map((tool) => ({
                  ...tool,
                  identityLabel: identityLabel(tool.identity),
                  sourceLabel:
                    { explicit: "逐工具路径", root: "根目录", search: "搜索目录" }[tool.source] ||
                    "—",
                })),
                [
                  ["name", "工具"],
                  ["path", "实际路径"],
                  ["sourceLabel", "来源"],
                  ["identityLabel", "产品标识"],
                  ["detail", "说明"],
                ],
                (item, index) =>
                  `${badge(item.available ? "available" : "unsupported")}<button class="small" data-tool-probe="${index}" ${item.path && can("toolkit.probe") ? "" : "disabled"}>检查版本</button>`,
              )
            : empty("尚未检测到工具", "设置工具路径后刷新检测。")
        }`,
      )}<div id="tool-detail">${state.environmentDetail}</div></div><div>${panel("工具目录", `<form id="tool-root-form"><div class="field"><label for="tool-root">本地工具根目录</label><input id="tool-root" name="root" value="${esc(data.root || "")}" placeholder="/本地/工具目录"><small>留空清除根目录。目录及其一级子目录参与检测。</small></div><div class="field"><label for="tool-search-dirs">额外搜索目录 · 每行一个</label><textarea id="tool-search-dirs" name="searchDirs" rows="3">${esc((data.searchDirs || []).join("\n"))}</textarea></div><div class="field"><label for="tool-template-dir">模板目录</label><input id="tool-template-dir" name="templateDir" value="${esc(data.templateDir || "")}" placeholder="/本地/模板目录"></div><details><summary>逐工具可执行文件路径</summary><div class="tool-path-fields">${tools.map((tool) => `<div class="field"><label for="tool-path-${esc(tool.id)}">${esc(tool.name)}</label><input id="tool-path-${esc(tool.id)}" name="path:${esc(tool.id)}" value="${esc(data.toolPaths?.[tool.id] || "")}" placeholder="留空移除此工具的单独路径"></div>`).join("")}</div></details><p class="info">优先级：逐工具路径 → 根目录 → 按顺序的搜索目录。仅使用已配置的本地绝对路径，不搜索系统 PATH。所有字段均可清空。</p><p id="tool-config-error" class="inlineerror" role="alert"></p><button class="primary" type="submit" ${can("toolkit.save") ? "" : 'disabled title="当前未提供工具目录设置能力"'}>保存目录</button></form>`)}${panel("环境信息", `<div class="twocoltext"><span>平台</span><span>${esc(state.status?.host?.platform || "未知")}</span></div><div class="twocoltext"><span>宿主版本</span><span>${esc(state.status?.host?.version || "未知")}</span></div><button id="refresh-tools" class="small">↻ 刷新检测</button>`)}</div></div>` +
      catalogHTML +
      `<div id="environment-preflight-result">${preflightHTML(view.preflight)}</div>`,
    bind() {
      localEnvironment.bind();
      monitor.bind($("#content"));
      const inContext = () =>
        state.page === "environment" &&
        state.workspaceId === workspaceId &&
        view.sessionId === (scopePayload.sessionId || "");
      $("#environment-catalog-scope").onsubmit = (event) => {
        event.preventDefault();
        if (!canLeaveEditor()) return;
        const values = Object.fromEntries(new FormData(event.target));
        if (view.sessionId !== values.sessionId) {
          view.preflight = null;
          view.error = "";
        }
        view.sessionId = values.sessionId;
        commitInlineDraft("environment-catalog-scope");
        render();
      };
      const preflight = async (requirements) => {
        try {
          if ($("#environment-catalog-session").value !== (scopePayload.sessionId || ""))
            throw new Error("请先点击“读取工具目录”应用所选会话范围");
          const result = await api("catalog.preflight", { ...scopePayload, requirements });
          if (view.sessionId !== (scopePayload.sessionId || "")) return;
          view.preflight = result;
          view.error = "";
          if (inContext()) {
            $("#environment-preflight-result").innerHTML = preflightHTML(result);
            $("#environment-catalog-error").textContent = "";
          }
          toast("依赖预检完成，未执行工具或授予操作权限");
        } catch (error) {
          if (view.sessionId === (scopePayload.sessionId || "")) {
            view.error = error.message;
            if (inContext()) $("#environment-catalog-error").textContent = error.message;
          }
          throw error;
        }
      };
      $(`#${requirementsFormId}`).onsubmit = (event) => {
        event.preventDefault();
        const form = event.target;
        const values = Object.fromEntries(new FormData(form));
        const lines = (name) =>
          values[name]
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean);
        const requirements = [
          ...lines("hostTools").map((name) => ({ kind: "tool", name })),
          ...lines("localTools").map((name) => ({ kind: "toolkit", name })),
          ...lines("directories").map((path) => ({ kind: "directory", path })),
          ...lines("variables").map((name) => ({ kind: "environment-variable", name })),
          ...lines("hosts").map((name) => ({ kind: "environment-host", name })),
          ...lines("keys").map((name) => ({ kind: "environment-key", name })),
        ];
        run($('button[type="submit"]', form), () => preflight(requirements));
      };
      $$("[data-environment-tool-check]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, () =>
              preflight([
                {
                  kind: "tool",
                  name: registered[Number(button.dataset.environmentToolCheck)].name,
                },
              ]),
            )),
      );
      $("#refresh-tools").onclick = render;
      $("#tool-root-form").onsubmit = (event) => {
        event.preventDefault();
        const form = event.target;
        run($('button[type="submit"]', form), async () => {
          try {
            const values = Object.fromEntries(new FormData(form));
            const next = {
              root: values.root.trim(),
              templateDir: values.templateDir.trim(),
              searchDirs: values.searchDirs
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
              toolPaths: Object.fromEntries(
                tools
                  .map((tool) => [tool.id, values[`path:${tool.id}`].trim()])
                  .filter(([, path]) => path),
              ),
            };
            const payload = Object.fromEntries(
              Object.entries(next).filter(
                ([key, value]) => JSON.stringify(value) !== JSON.stringify(data[key]),
              ),
            );
            if (Object.keys(payload).length) await api("toolkit.save", payload);
            commitInlineDraft("tool-root-form");
            state.environmentFeedback = { message: "工具路径已保存并重新检测。" };
            state.environmentDetail = "";
            toast("工具目录已保存");
            await render();
          } catch (error) {
            $("#tool-config-error", form).textContent = error.message;
            throw error;
          }
        });
      };
      $("#adapt-tools").onclick = (event) =>
        run(event.target, async () => {
          try {
            const result = await api("toolkit.adapt");
            state.environmentDetail = panel(
              "离线适配建议",
              result.missing.length
                ? result.missing
                    .map(
                      (item) =>
                        `<div class="listrow"><div class="grow"><strong>${esc(item.name)}</strong><p>${esc(item.advice)}</p></div>${badge("unsupported")}</div>`,
                    )
                    .join("")
                : empty("已配置的工具均可用", "仍可逐个检查版本，查看本机返回结果。"),
            );
            $("#tool-detail").innerHTML = state.environmentDetail;
          } catch (error) {
            state.environmentFeedback = { error: true, message: error.message };
            $("#tool-detail").innerHTML =
              `<div class="error" role="alert">${esc(error.message)}</div>`;
            throw error;
          }
        });
      $$("[data-tool-probe]").forEach(
        (button) =>
          (button.onclick = () =>
            run(button, async () => {
              const tool = tools[Number(button.dataset.toolProbe)];
              try {
                const result = await api("toolkit.probe", { tool: tool.id, timeoutMs: 5000 });
                const args =
                  (result.attempts || []).map((attempt) => attempt.args.join(" ")).join(" / ") ||
                  "--version";
                state.environmentDetail = panel(
                  `${tool.name} · 版本与产品检查`,
                  `<div class="twocoltext"><span>固定检查参数</span><span class="mono">${esc(args)}</span></div><div class="twocoltext"><span>产品标识</span><span>${esc(identityLabel(result.identity))}</span></div><p class="info">${esc(result.detail)}</p><div class="twocoltext"><span>退出码</span><span>${esc(result.exitCode)}</span></div><div class="field"><label>标准输出</label><pre class="report">${esc(result.stdout || "（无输出）")}</pre></div><div class="field"><label>标准错误</label><pre class="report">${esc(result.stderr || "（无输出）")}</pre></div>`,
                );
                state.environmentFeedback = {
                  error: !result.available,
                  message: result.available
                    ? `${tool.name} 版本检查完成。`
                    : `${tool.name} 检查完成，但产品身份尚未确认可用。`,
                };
                toast(state.environmentFeedback.message);
                await render();
              } catch (error) {
                state.environmentFeedback = {
                  error: true,
                  message: `${tool.name} 检查失败：${error.message}`,
                };
                $("#tool-detail").innerHTML =
                  `<div class="error" role="alert">${esc(state.environmentFeedback.message)}</div>`;
                throw error;
              }
            })),
      );
    },
    dispose() {
      monitor.dispose();
      localEnvironment.dispose?.();
    },
  };
}
function confirmUninstall(message) {
  if (!canLeaveEditor()) return Promise.resolve(false);
  const dialog = $("#editor");
  dialog.innerHTML = `<div class="dialoghead"><h2>卸载本插件（保留资料）</h2></div><p class="info">${esc(message)}</p><div class="dialogfoot"><button type="button" id="cancel-uninstall">取消</button><button type="button" class="danger" id="accept-uninstall">确认卸载本插件</button></div>`;
  dialog.oncancel = null;
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(false), { once: true });
    $("#cancel-uninstall").onclick = () => dialog.close();
    $("#accept-uninstall").onclick = (event) => {
      event.target.disabled = true;
      resolve(true);
      dialog.close();
    };
    dialog.showModal();
  });
}
function lockUninstallPage() {
  state.request++;
  disposePage?.();
  disposePage = undefined;
  mountedDrafts = [];
  $$(".navitem, #workspace-select").forEach((input) => (input.disabled = true));
}
function showUninstallOutcome() {
  $("#content").innerHTML = heading() + renderReceipt(state.uninstallOutcome);
  $("#connection-label").textContent = state.uninstallOutcome.error
    ? "卸载状态待核对"
    : "本插件已卸载";
  $("#connection-dot").classList.add("off");
}
async function diagnosticsPage() {
  const maintenance = await api("maintenance.info");
  const admission = await api("admission.status");
  const caps = state.status?.capabilities || [];
  return {
    html:
      heading('<button class="primary" id="run-diagnostics">运行诊断</button>') +
      panel(
        "演练入口确认",
        `<p class="info">${admission.accepted ? `当前安装已确认 · ${esc(admission.acceptedAt)}` : "当前安装尚未确认演练区使用说明。"}撤销会阻止新的演练任务，并尝试停止本项目管理的执行者；普通聊天和运行控制继续可用。若停止未确认，可再次执行撤销以重试清理。</p><button id="revoke-admission" class="danger">撤销确认 / 重试清理</button><button id="enter-admission">查看演练入口</button>`,
      ) +
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
      )}<div id="diagnostic-result"></div></div><div>${panel("离线维护", `<div class="eyebrow">OFFLINE MAINTENANCE</div><div class="twocoltext"><span>当前版本</span><span>${esc(maintenance.version || state.status?.version || "未知")}</span></div><div class="twocoltext"><span>更新模式</span><span>离线本地包</span></div><p class="info" style="white-space:pre-wrap">${esc(Array.isArray(maintenance.instructions) ? maintenance.instructions.join("\n") : maintenance.instructions || "准备经过可信来源验证的本地更新包，然后通过宿主提供的安装接口维护。")}</p>${capabilityButton("maintenance.install", "选择本地安装包路径", 'id="install-offline"')}<div class="note" style="margin:18px 0 0">安装能力取决于宿主支持。没有可信安装接口时，此操作保持禁用。</div>`)}${panel("卸载与资料保留", uninstallSection(maintenance.uninstall))}${panel("诊断说明", `<p class="info">诊断结果描述当前环境中的已检测能力。某项不可用时，对应操作会拒绝执行。</p><p class="info">离线工作台不会连接其他插件的发行或更新服务。</p>`)}</div></div>`,
    bind() {
      if (maintenance.uninstall?.available === true)
        $("#uninstall-plugin").onclick = uninstallFlow({
          api,
          confirm: confirmUninstall,
          pending() {
            state.uninstallPending = true;
            lockUninstallPage();
            $("#content").innerHTML =
              heading() +
              panel(
                "正在卸载本插件",
                '<p class="info" role="status">正在撤销运行控制与演练确认、停止所属任务和探测，并等待官方管理器的卸载回执。请勿重复操作。</p>',
              );
          },
          outcome(result) {
            state.uninstallOutcome = result;
            state.uninstallPending = false;
            showUninstallOutcome();
          },
        });
      $("#enter-admission").onclick = () => navigate("workspaces");
      $("#revoke-admission").onclick = () =>
        confirmAction(
          "撤销演练确认",
          "将停止本项目管理的待调度计划，并尝试停止所属执行者；只有确认清理完成的执行槽才会释放。已保存的项目资料保留。",
          async () => {
            try {
              await api("admission.revoke", { revision: admission.revision });
            } finally {
              await refreshProjects();
              await refreshStatus();
              Object.assign(admission, state.admission);
            }
          },
        );
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
