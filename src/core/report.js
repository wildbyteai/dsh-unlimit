import { fail } from "./validation.js";

const HIDDEN = "[REDACTED]";
const UNVERIFIED = "未独立验证（本地记录）";
const SECRET_KEY =
  /pass(word|phrase|wd)?|secret|token|cookie|authorization|private.?key|api.?key|credential/i;
const KINDS = {
  credential: "凭据（内容隐藏）",
  access: "访问权限",
  webshell: "WebShell 登记",
  tunnel: "隧道登记",
  screenshot: "截图证据",
  http: "HTTP 证据",
  chain: "链路记录",
  file: "文件证据",
  "score-point": "计分点",
  "score-hit": "计分命中与证据",
  stage: "阶段",
  session: "会话记录",
};
const LABELS = {
  id: "ID",
  name: "名称",
  title: "标题",
  address: "地址",
  type: "类型",
  names: "名称集合",
  domains: "域名",
  ports: "端口",
  services: "服务",
  product: "产品",
  version: "版本",
  fingerprints: "指纹",
  sources: "来源集合",
  source: "来源",
  scope: "范围",
  segment: "分段",
  status: "登记状态",
  priority: "优先级",
  tags: "标签",
  notes: "说明",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  firstSeenAt: "首次观察",
  lastSeenAt: "最后观察",
  recordedAt: "登记时间",
  observedAt: "观察时间",
  execution: "执行语义",
  assessment: "评估记录",
  test: "测试记录",
  evidence: "证据",
  content: "正文",
  text: "文本",
  excerpt: "摘录",
  observation: "观察",
  result: "结果",
  assetId: "关联资产",
  assetIds: "关联资产集合",
  serviceId: "关联服务",
  findingId: "关联发现",
  pointId: "关联计分点",
  stageId: "关联阶段",
  stage: "阶段声明",
  severity: "严重性",
  verified: "记录者验证声明",
  target: "目标",
  level: "权限级别",
  method: "方法",
  role: "角色声明",
  url: "URL",
  language: "语言",
  destination: "目标地址",
  protocol: "协议",
  port: "端口",
  path: "本地文件路径",
  sha256: "SHA-256",
  request: "请求内容",
  response: "响应内容",
  headers: "头部",
  from: "起点",
  to: "终点",
  relation: "关系",
  technique: "技术 / 方法",
  points: "登记分值",
  condition: "判定条件",
  awarded: "参与计分",
  progress: "进度（%）",
  sessionId: "会话 ID",
  summary: "摘要",
  kind: "记录类型",
};

// Redaction applies to all text, including titles, source strings and nested evidence.
// Credential bodies never enter the renderer, even through their safe read projection.
function redact(value, key = "") {
  if (SECRET_KEY.test(key)) return HIDDEN;
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  if (typeof value !== "string") return value;
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, HIDDEN)
    .replace(/\b((?:Bearer|Basic)\s+)[^\s,;]+/gi, `$1${HIDDEN}`)
    .replace(/\b((?:set-cookie|cookie|(?:proxy-)?authorization)\s*:\s*)[^\r\n]+/gi, `$1${HIDDEN}`)
    .replace(/(https?:\/\/)[^\s/@]+@/gi, `$1${HIDDEN}@`)
    .replace(
      /([?&](?:password|passwd|secret|token|access_token|api[_-]?key|signature)=)[^\s&#]*/gi,
      `$1${HIDDEN}`,
    )
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|cookie|authorization)\s*["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}&]+)/gi,
      `$1=${HIDDEN}`,
    );
}

function markdown(value) {
  return String(value)
    .replace(/[\\`*_{}\[\]<>#|!]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

function text(value) {
  if (value === undefined || value === null || value === "") return "未记录 / 未知";
  if (value === true) return "是";
  if (value === false) return "否";
  return markdown(redact(value));
}

/** Pure rendering from one workspace snapshot; does not inspect files or run tools. */
export function buildReport({ info, assets, findings, records, links, events }, scoreTarget) {
  const points = records["score-point"];
  const hits = records["score-hit"];
  const covered = new Set();
  const hitStates = new Map();
  const scoreByStage = new Map();
  let scoreEarned = 0;
  for (const hit of hits) {
    if (hit.data.awarded === false) {
      hitStates.set(hit.id, "仅留证，不计分");
      continue;
    }
    const point = points.find((item) => item.id === hit.data.pointId);
    if (!point) fail("INVALID_DATA", "Scoring evidence references a missing score point");
    const key = JSON.stringify([point.id, hit.data.assetId ?? null, scoreTarget(hit.data)]);
    if (covered.has(key)) {
      hitStates.set(hit.id, "重复覆盖，仅保留证据");
      continue;
    }
    covered.add(key);
    const earned = point.data.points ?? 0;
    hitStates.set(hit.id, `计入 ${earned} 分（计分点基准）`);
    scoreEarned += earned;
    const stage = point.data.stageId ?? point.data.stage ?? "unassigned";
    if (typeof stage !== "string") fail("INVALID_DATA", "Score point stage must be a string");
    const entry = scoreByStage.get(stage) ?? { stage, earned: 0, uniqueHits: 0 };
    entry.earned += earned;
    entry.uniqueHits++;
    scoreByStage.set(stage, entry);
  }
  const stats = {
    assets: assets.length,
    services: assets.reduce((sum, item) => sum + (item.services?.length ?? 0), 0),
    findings: findings.length,
    records: Object.values(records).reduce((sum, items) => sum + items.length, 0),
    severities: Object.fromEntries(
      ["critical", "high", "medium", "low", "info"].map((severity) => [
        severity,
        findings.filter((item) => item.severity === severity).length,
      ]),
    ),
    scorePoints: points.length,
    scoreHits: hits.length,
    scoreUniqueHits: covered.size,
    scoreByStage: [...scoreByStage.values()].map((entry) => ({
      ...entry,
      stage: redact(entry.stage),
    })),
    scoreTotal: points.reduce((sum, item) => sum + (item.data.points ?? 0), 0),
    scoreEarned,
    recordsByKind: Object.fromEntries(
      Object.entries(records).map(([kind, items]) => [kind, items.length]),
    ),
    assessments: assets.filter((item) => item.assessment !== undefined).length,
    tests: assets.filter((item) => item.test !== undefined).length,
    links: links.length,
    events: events.length,
  };
  const named = (items, id, label) => {
    const item = items.find((candidate) => candidate.id === id);
    return item
      ? `${item.name ?? item.title ?? item.data?.name ?? item.data?.title ?? label} (${id})`
      : `${id}（当前工作区未找到；未验证）`;
  };
  function reference(key, value) {
    if (typeof value !== "string" || !value) return value;
    if (key === "assetId") return named(assets, value, "资产");
    if (key === "findingId") return named(findings, value, "发现");
    if (key === "pointId") return named(points, value, "计分点");
    if (key === "stageId") return named(records.stage, value, "阶段");
    if (key === "serviceId") {
      const owner = assets.find((asset) => asset.services?.some((service) => service.id === value));
      const service = owner?.services.find((item) => item.id === value);
      return service
        ? `${owner.name} · ${service.protocol}/${service.port} (${value})`
        : `${value}（当前工作区未找到；未验证）`;
    }
    return value;
  }
  const lines = [
    `# ${text(info.name)} 演练报告`,
    "",
    `工作区 ID：${text(info.id)}`,
    "",
    `授权范围：${text(info.scope)}`,
    "",
    `授权说明（登记声明）：${text(info.authorization)}`,
    "",
    `创建时间：${text(info.createdAt)}；更新时间：${text(info.updatedAt)}`,
    "",
    "本报告汇总本地记录；记录存在不表示已执行远程验证。凭据记录内容默认隐藏。报告生成不执行网络、登录、工具、文件读取或权限变更。",
    "登记的 confirmed、complete、verified 等状态均为记录者声明，报告不独立验证。来源未填写时为未知；文件路径、URL、摘要和会话 ID 仅为引用，未读取或验证其内容。",
    "",
    "## 汇总",
    "",
    `资产 ${stats.assets}；服务 ${stats.services}；发现 ${stats.findings}；证据记录 ${stats.records}；评分累计 ${stats.scoreEarned}；计分点基准总分 ${stats.scoreTotal}（每资产/服务分别累计）。`,
    `评估记录 ${stats.assessments}；测试记录 ${stats.tests}；资产关系 ${stats.links}；观察事件 ${stats.events}；唯一有效命中 ${stats.scoreUniqueHits} / 原始命中 ${stats.scoreHits}。`,
    `发现严重性：${Object.entries(stats.severities)
      .map(([key, count]) => `${key} ${count}`)
      .join("；")}。`,
    "计分点基准总分不是上限；命中按“计分点＋资产＋服务端点”去重，采用计分点分值，忽略命中自行登记分值。阶段归属采用计分点 stageId / stage，命中声明不改变归属。",
    "",
    "## 资产与服务",
    "",
  ];
  function fields(value, indent = "", parentKey = "") {
    if (Array.isArray(value)) {
      if (!value.length) lines.push(`${indent}- 无记录 / 未知`);
      value.forEach((item, index) => {
        lines.push(`${indent}- 第 ${index + 1} 项：`);
        fields(parentKey === "assetIds" ? reference("assetId", item) : item, `${indent}  `);
      });
    } else if (value && typeof value === "object") {
      if (!Object.keys(value).length) lines.push(`${indent}- 无记录 / 未知`);
      for (const [key, item] of Object.entries(value)) {
        const label = LABELS[key] ?? key;
        const safe = redact(item, key);
        if (safe !== null && typeof safe === "object") {
          lines.push(`${indent}- ${text(label)}：`);
          fields(safe, `${indent}  `, key);
        } else lines.push(`${indent}- ${text(label)}：${text(reference(key, safe))}`);
      }
    } else lines.push(`${indent}- ${text(value)}`);
  }
  function audit(item) {
    lines.push(`验证状态：${UNVERIFIED}`, "");
    fields({
      source: item.source ?? item.sources ?? item.data?.source ?? item.data?.sources ?? "",
    });
    lines.push("");
  }
  if (!assets.length) lines.push("暂无资产；服务、评估和测试均未记录。", "");
  for (const asset of assets) {
    lines.push(`### ${text(asset.name)}`, "");
    const { workspaceId: _workspace, services, assessment, test, ...details } = asset;
    fields(details);
    audit(asset);
    lines.push("#### 服务", "");
    if (!services?.length) lines.push("未记录服务（不表示没有开放服务）。", "");
    for (const service of services ?? []) {
      fields(service);
      audit(service);
    }
    for (const [label, value] of [
      ["评估", assessment],
      ["测试", test],
    ]) {
      lines.push(`#### ${label}`, "");
      if (value === undefined) lines.push(`未记录${label}；未验证。`, "");
      else {
        fields(value);
        audit(value);
      }
    }
  }
  lines.push("## 发现与证据", "");
  if (!findings.length) lines.push("暂无发现（不表示不存在风险）。", "");
  for (const finding of findings) {
    lines.push(`### ${text(finding.title)}`, "");
    const { workspaceId: _workspace, evidence, ...details } = finding;
    fields({ ...details, assetId: finding.assetId ?? "" });
    lines.push("证据：", "");
    if (evidence === "" || evidence == null) lines.push("未提供证据；未验证。", "");
    else fields(redact(evidence));
    audit(finding);
  }
  lines.push("## 资产关系与链路", "", "关系仅反映登记方向，不证明路径可达或已执行。", "");
  if (!links.length) lines.push("未记录资产关系。", "");
  for (const link of links) {
    fields({
      id: link.id,
      from: named(assets, link.from, "资产"),
      to: named(assets, link.to, "资产"),
      relation: link.relation,
      createdAt: link.createdAt,
      updatedAt: link.updatedAt,
    });
    audit(link);
  }
  lines.push("## 阶段与计分汇总", "");
  if (!stats.scoreByStage.length) lines.push("暂无有效计分；不表示阶段已完成。", "");
  for (const stage of stats.scoreByStage)
    lines.push(
      `- ${text(stage.stage === "unassigned" ? "未分阶段" : records.stage.some((item) => item.id === stage.stage) ? reference("stageId", stage.stage) : stage.stage)}：累计 ${stage.earned} 分；唯一有效命中 ${stage.uniqueHits}。`,
    );
  lines.push("", "## 证据记录", "");
  for (const [kind, items] of Object.entries(records)) {
    lines.push(`### ${KINDS[kind]}（${kind}，${items.length}）`, "");
    if (!items.length) lines.push("未记录；未知 / 未验证。", "");
    for (const item of items) {
      fields({ id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt });
      if (kind === "credential") {
        lines.push(
          `内容：${text(HIDDEN)}；秘密存在状态：${text(item.secretState?.hasSecret)}；隐藏遗留字段数：${text(item.secretState?.legacyFieldCount)}`,
          "",
          `验证状态：${UNVERIFIED}；来源及权限声明随凭据内容隐藏。`,
          "",
        );
        continue;
      }
      fields(item.data);
      if (kind === "score-hit") lines.push(`计分结果：${text(hitStates.get(item.id))}`, "");
      audit(item);
    }
  }
  lines.push(
    "## 观察事件与来源",
    "",
    "事件为本地登记历史；重复观察不等于新增资产，旧评估和测试可能已被最新记录替代。",
    "",
  );
  if (!events.length) lines.push("未记录观察事件。", "");
  for (const event of events) {
    const { workspaceId: _workspace, ...details } = event;
    fields(details);
    audit(event);
  }
  return { markdown: lines.join("\n"), stats };
}
