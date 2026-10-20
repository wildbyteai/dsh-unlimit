import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../src/core/store.js";
import { RECORD_KINDS } from "../src/core/validation.js";

// Inspect the displayed text as well as Markdown syntax; escaped underscores must
// not accidentally make a leaked synthetic secret pass a negative assertion.
const readable = (markdown) => markdown.replace(/\\(.)/g, "$1");

function fixture(t) {
  const store = new WorkspaceStore(":memory:");
  t.after(() => store.close());
  const call = (action, payload) => store.dispatch(action, payload);
  const workspace = (name) =>
    call("workspaces.save", {
      name,
      scope: "Fixture scope",
      authorization: "Fixture authorization",
    }).item.id;
  const record = (workspaceId, kind, data) =>
    call("records.save", { workspaceId, kind, data }).item;
  const snapshot = () => ({
    entries: store.db.prepare("SELECT * FROM entries ORDER BY rowid").all(),
    metadata: store.db.prepare("SELECT * FROM metadata ORDER BY key").all(),
  });
  function report(workspaceId) {
    const before = snapshot();
    store.db.exec("PRAGMA query_only = ON");
    try {
      const result = call("report.build", { workspaceId });
      assert.deepEqual(snapshot(), before, "report must preserve every local row");
      assert.deepEqual(
        call("report.build", { workspaceId }),
        result,
        "unchanged data yields identical report",
      );
      return result;
    } finally {
      store.db.exec("PRAGMA query_only = OFF");
    }
  }
  return { store, call, workspace, record, report, snapshot };
}

test("empty reports disclose missing data and keep the compatible statistics shape", (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace("Empty fixture");
  const { markdown, stats } = f.report(workspaceId);
  for (const section of [
    "授权范围：Fixture scope",
    "授权说明（登记声明）：Fixture authorization",
    "## 资产与服务",
    "## 发现与证据",
    "## 资产关系与链路",
    "## 阶段与计分汇总",
    "## 证据记录",
    "## 观察事件与来源",
    "未记录",
    "未验证",
    "不表示不存在风险",
  ])
    assert.ok(markdown.includes(section), section);
  for (const key of [
    "assets",
    "services",
    "findings",
    "records",
    "scorePoints",
    "scoreHits",
    "scoreUniqueHits",
    "scoreTotal",
    "scoreEarned",
    "assessments",
    "tests",
    "links",
    "events",
  ])
    assert.equal(stats[key], 0, key);
  assert.deepEqual(stats.scoreByStage, []);
  assert.deepEqual(stats.severities, { critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  assert.deepEqual(stats.recordsByKind, Object.fromEntries(RECORD_KINDS.map((kind) => [kind, 0])));
  f.call("assets.save", { workspaceId, name: "Incomplete asset", address: "192.0.2.20" });
  f.call("findings.save", { workspaceId, title: "No evidence fixture", severity: "info" });
  const point = f.record(workspaceId, "score-point", { points: 0 });
  f.record(workspaceId, "score-hit", { pointId: point.id });
  const incomplete = f.report(workspaceId);
  for (const expected of [
    "未提供证据；未验证",
    "关联资产：未记录 / 未知",
    "未记录评估；未验证",
    "未记录测试；未验证",
    "未记录服务（不表示没有开放服务）",
    "未分阶段",
  ])
    assert.ok(incomplete.markdown.includes(expected), expected);
  assert.equal(incomplete.stats.scoreUniqueHits, 1);
  assert.deepEqual(incomplete.stats.scoreByStage, [
    { stage: "unassigned", earned: 0, uniqueHits: 1 },
  ]);
});

test("full synthetic workspace renders all existing fields, provenance, references and scoring without mutation", (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace("Full fixture");
  const asset = f.call("assets.save", {
    workspaceId,
    name: "Application fixture",
    address: "https://app.example.invalid/app",
    type: "web",
    names: ["application alias"],
    domains: ["alias.example.invalid"],
    ports: [8080],
    fingerprints: ["asset fingerprint"],
    sources: ["asset source"],
    scope: "external",
    segment: "fixture segment",
    status: "confirmed",
    priority: 7,
    tags: ["fixture tag"],
    notes: "asset notes",
    services: [
      {
        port: 443,
        protocol: "tcp",
        name: "https",
        product: "fixture server",
        version: "fixture version",
        fingerprints: ["service fingerprint"],
        sources: ["service source"],
        tags: ["service tag"],
      },
    ],
  }).item;
  const second = f.call("assets.save", {
    workspaceId,
    name: "DNS fixture",
    address: "192.0.2.9",
    services: [{ port: 53, protocol: "udp", name: "dns" }],
  }).item;
  f.call("assets.assess", {
    workspaceId,
    id: asset.id,
    summary: "assessment summary",
    notes: "assessment notes",
    evidence: { observation: "assessment observation" },
    source: "assessment source",
  });
  f.call("assets.test", {
    workspaceId,
    id: asset.id,
    result: "historical test result",
    source: "historical test source",
  });
  f.call("assets.test", {
    workspaceId,
    id: asset.id,
    result: "current test result",
    source: "test source",
    verified: true,
    evidence: { text: "test evidence" },
    assetId: asset.id,
  });
  const finding = f.call("findings.save", {
    workspaceId,
    title: "Finding fixture",
    assetId: asset.id,
    severity: "high",
    status: "confirmed",
    evidence: {
      source: "finding source",
      content: "finding content",
      excerpt: "finding excerpt",
      result: "finding result",
      nested: [{ text: "nested finding evidence" }],
    },
  }).item;
  const link = f.call("assets.link", {
    workspaceId,
    from: asset.id,
    to: second.id,
    relation: "synthetic relationship",
  }).item;
  const stage = f.record(workspaceId, "stage", {
    name: "Validation fixture",
    status: "complete",
    progress: 100,
    notes: "stage notes",
    source: "stage source",
  });
  const point = f.record(workspaceId, "score-point", {
    name: "Point fixture",
    points: 10,
    condition: "point condition",
    stageId: stage.id,
    source: "point source",
  });
  const pointTwo = f.record(workspaceId, "score-point", {
    title: "Legacy stage point",
    points: 5,
    stage: "manual stage",
  });
  const hit = f.record(workspaceId, "score-hit", {
    pointId: point.id,
    assetId: asset.id,
    serviceId: asset.services[0].id,
    name: "First fixture hit",
    notes: "hit notes",
    points: 999,
    findingId: finding.id,
    stageId: stage.id,
  });
  f.record(workspaceId, "score-hit", {
    pointId: point.id,
    assetId: asset.id,
    port: 443,
    protocol: "tcp",
    evidence: "duplicate evidence retained",
  });
  f.record(workspaceId, "score-hit", {
    pointId: point.id,
    assetId: second.id,
    serviceId: second.services[0].id,
    evidence: "second asset evidence",
  });
  f.record(workspaceId, "score-hit", {
    pointId: pointTwo.id,
    assetId: second.id,
    awarded: false,
    evidence: "unawarded evidence retained",
  });
  f.record(workspaceId, "score-hit", {
    pointId: pointTwo.id,
    assetId: asset.id,
    evidence: "legacy stage evidence",
  });
  f.record(workspaceId, "credential", {
    name: "HIDDEN_NAME",
    username: "HIDDEN_USERNAME",
    target: "HIDDEN_TARGET",
    role: "HIDDEN_ROLE",
    source: "HIDDEN_SOURCE",
    notes: "HIDDEN_NOTES",
    secret: "HIDDEN_SECRET",
    assetId: asset.id,
    serviceId: asset.services[0].id,
  });
  f.record(workspaceId, "access", {
    name: "Access fixture",
    target: "access target",
    level: "read-only",
    method: "manual grant declaration",
    notes: "access notes",
    assetId: asset.id,
    source: "access source",
    verified: false,
  });
  f.record(workspaceId, "webshell", {
    name: "Webshell fixture",
    url: "https://shell.example.invalid",
    language: "synthetic language",
    status: "unverified",
    notes: "webshell evidence",
  });
  f.record(workspaceId, "tunnel", {
    name: "Tunnel fixture",
    source: "tunnel source",
    destination: "tunnel destination",
    protocol: "synthetic protocol",
    notes: "tunnel notes",
  });
  f.record(workspaceId, "screenshot", {
    name: "Screenshot fixture",
    path: "evidence/synthetic.png",
    target: "screenshot target",
    notes: "screenshot notes",
    sha256: "fixture-image-sha",
  });
  f.record(workspaceId, "http", {
    name: "HTTP fixture",
    method: "GET",
    url: "https://http.example.invalid",
    request: "synthetic request",
    response: "synthetic response",
    headers: { "X-Trace": "fixture trace" },
  });
  f.record(workspaceId, "chain", {
    name: "Chain fixture",
    from: "fixture start",
    to: "fixture end",
    technique: "fixture technique",
    notes: "chain notes",
    assetIds: [asset.id, second.id],
    evidence: { observation: "chain observation" },
  });
  f.record(workspaceId, "file", {
    name: "File fixture",
    path: "evidence/synthetic.txt",
    sha256: "fixture-file-sha",
    notes: "file notes",
  });
  f.record(workspaceId, "session", {
    name: "Session fixture",
    sessionId: "synthetic-session-id",
    notes: "session notes",
    custom: { array: [0, false, null, {}] },
  });
  const report = f.report(workspaceId);
  for (const value of [
    asset.id,
    asset.services[0].id,
    second.id,
    finding.id,
    link.id,
    stage.id,
    point.id,
    hit.id,
    "Application fixture",
    "application alias",
    "alias.example.invalid",
    "8080",
    "asset fingerprint",
    "asset source",
    "fixture segment",
    "confirmed",
    "fixture tag",
    "asset notes",
    "tcp",
    "udp",
    "https",
    "dns",
    "fixture server",
    "fixture version",
    "service fingerprint",
    "service source",
    "service tag",
    "首次观察",
    "最后观察",
    "assessment summary",
    "assessment notes",
    "assessment observation",
    "assessment source",
    "historical test result",
    "historical test source",
    "current test result",
    "test source",
    "test evidence",
    "local-record-only",
    "Finding fixture",
    "finding source",
    "finding content",
    "finding excerpt",
    "finding result",
    "nested finding evidence",
    "synthetic relationship",
    "Validation fixture",
    "complete",
    "100",
    "stage notes",
    "stage source",
    "Point fixture",
    "point condition",
    "point source",
    "First fixture hit",
    "hit notes",
    "duplicate evidence retained",
    "unawarded evidence retained",
    "仅留证，不计分",
    "重复覆盖，仅保留证据",
    "计入 10 分",
    "manual stage",
    "Access fixture",
    "access target",
    "read-only",
    "manual grant declaration",
    "access notes",
    "access source",
    "Webshell fixture",
    "synthetic language",
    "webshell evidence",
    "Tunnel fixture",
    "tunnel source",
    "tunnel destination",
    "synthetic protocol",
    "tunnel notes",
    "Screenshot fixture",
    "evidence/synthetic.png",
    "screenshot target",
    "screenshot notes",
    "fixture-image-sha",
    "HTTP fixture",
    "synthetic request",
    "synthetic response",
    "fixture trace",
    "Chain fixture",
    "fixture start",
    "fixture end",
    "fixture technique",
    "chain notes",
    "chain observation",
    "File fixture",
    "evidence/synthetic.txt",
    "fixture-file-sha",
    "file notes",
    "Session fixture",
    "synthetic-session-id",
    "session notes",
    "custom",
    "验证状态：未独立验证",
    "来源：未记录 / 未知",
    "内容默认隐藏",
  ])
    assert.ok(report.markdown.includes(value), value);
  for (const value of [
    "HIDDEN_NAME",
    "HIDDEN_USERNAME",
    "HIDDEN_TARGET",
    "HIDDEN_ROLE",
    "HIDDEN_SOURCE",
    "HIDDEN_NOTES",
    "HIDDEN_SECRET",
  ])
    assert.ok(!readable(report.markdown).includes(value), value);
  assert.equal(report.stats.assets, 2);
  assert.equal(report.stats.services, 2);
  assert.equal(report.stats.findings, 1);
  assert.equal(report.stats.severities.high, 1);
  assert.equal(report.stats.records, 17);
  assert.equal(report.stats.assessments, 1);
  assert.equal(report.stats.tests, 1, "latest test is counted once; history stays in events");
  assert.equal(report.stats.links, 1);
  assert.equal(report.stats.events, 6);
  assert.equal(report.stats.scorePoints, 2);
  assert.equal(report.stats.scoreHits, 5);
  assert.equal(report.stats.scoreUniqueHits, 3);
  assert.equal(report.stats.scoreEarned, 25, "hit-supplied points do not override point baseline");
  assert.equal(report.stats.scoreTotal, 15);
  assert.deepEqual(report.stats.scoreByStage, [
    { stage: stage.id, earned: 20, uniqueHits: 2 },
    { stage: "manual stage", earned: 5, uniqueHits: 1 },
  ]);
  assert.deepEqual(
    report.stats.recordsByKind,
    Object.fromEntries(
      RECORD_KINDS.map((kind) => [kind, kind === "score-hit" ? 5 : kind === "score-point" ? 2 : 1]),
    ),
  );
});

test("redaction applies across free text and nested data while credentials and other workspaces remain hidden", (t) => {
  const f = fixture(t);
  const workspaceId = f.workspace("Escaped <script> ![image](x) password=TITLE_SECRET");
  const foreignId = f.workspace("FOREIGN_WORKSPACE");
  const foreign = f.call("assets.save", {
    workspaceId: foreignId,
    name: "FOREIGN_ASSET_NAME",
    address: "192.0.2.10",
  }).item;
  f.record(foreignId, "http", { response: "FOREIGN_EVIDENCE" });
  const asset = f.call("assets.save", {
    workspaceId,
    name: "Safe asset",
    address: "https://user:URL_SECRET@example.invalid/?token=QUERY_SECRET",
    notes: "Bearer BEARER_SECRET",
    source: "secret=SOURCE_SECRET",
  }).item;
  f.call("assets.assess", {
    workspaceId,
    id: asset.id,
    evidence: { apiKey: "ASSESS_SECRET" },
    notes: 'password="QUOTED SECRET"',
  });
  f.call("findings.save", {
    workspaceId,
    title: "secret=FINDING_SECRET",
    severity: "low",
    evidence: {
      tokens: ["ARRAY_SECRET"],
      nested: [{ password: "NESTED_SECRET" }],
      text: '{"password":"JSON_SECRET"}',
    },
  });
  const credential = f.record(workspaceId, "credential", { secret: "CANONICAL_SECRET" });
  const legacy = JSON.parse(
    f.store.db.prepare("SELECT value FROM entries WHERE id = ?").get(credential.id).value,
  );
  legacy.data.legacySensitiveKey = "LEGACY_SECRET";
  f.store.db
    .prepare("UPDATE entries SET value = ? WHERE id = ?")
    .run(JSON.stringify(legacy), credential.id);
  f.record(workspaceId, "http", {
    authorization: "HEADER_SECRET",
    headers: {
      "Set-Cookie": "COOKIE_SECRET",
      "X-Api-Key": "API_SECRET",
      "Proxy-Authorization": "PROXY_SECRET",
    },
    request: "Authorization: Basic BASIC_SECRET",
    response: "-----BEGIN PRIVATE KEY-----\nPEM_SECRET\n-----END PRIVATE KEY-----",
    url: "https://plainuser@example.invalid/?signature=SIGNATURE_SECRET",
    evidence: {
      private_key: "PRIVATE_SECRET",
      passphrase: "PHRASE_SECRET",
      safe: "VISIBLE_EVIDENCE",
    },
    sources: "string source",
  });
  f.record(workspaceId, "chain", {
    serviceId: foreign.services?.[0]?.id ?? "foreign-service-id",
    name: "Safe chain",
  });
  const secretStagePoint = f.record(workspaceId, "score-point", {
    points: 1,
    stage: "token=STAGE_SECRET",
  });
  f.record(workspaceId, "score-hit", { pointId: secretStagePoint.id });
  f.record(workspaceId, "http", {
    request: "Cookie: first=COOKIE_FIRST; second=COOKIE_SECOND\nX-Visible: public",
  });
  const result = f.report(workspaceId);
  for (const secret of [
    "TITLE_SECRET",
    "URL_SECRET",
    "QUERY_SECRET",
    "BEARER_SECRET",
    "SOURCE_SECRET",
    "ASSESS_SECRET",
    "QUOTED SECRET",
    "FINDING_SECRET",
    "ARRAY_SECRET",
    "NESTED_SECRET",
    "JSON_SECRET",
    "CANONICAL_SECRET",
    "legacySensitiveKey",
    "LEGACY_SECRET",
    "HEADER_SECRET",
    "COOKIE_SECRET",
    "API_SECRET",
    "PROXY_SECRET",
    "BASIC_SECRET",
    "PEM_SECRET",
    "SIGNATURE_SECRET",
    "PRIVATE_SECRET",
    "PHRASE_SECRET",
    "FOREIGN_WORKSPACE",
    "FOREIGN_ASSET_NAME",
    "FOREIGN_EVIDENCE",
    "plainuser",
    "STAGE_SECRET",
    "COOKIE_FIRST",
    "COOKIE_SECOND",
  ])
    assert.ok(
      !`${readable(result.markdown)} ${JSON.stringify(result.stats)}`.includes(secret),
      secret,
    );
  assert.ok(readable(result.markdown).includes("VISIBLE_EVIDENCE"));
  assert.ok(result.markdown.includes("string source"));
  assert.ok(result.markdown.includes("隐藏遗留字段数：1"));
  assert.ok(result.markdown.includes("当前工作区未找到；未验证"));
  assert.ok(result.markdown.includes("\\<script\\>"));
  assert.ok(result.markdown.includes("\\!\\[image\\]"));
  const foreignReport = f.report(foreignId);
  assert.equal(foreignReport.stats.assets, 1);
  assert.ok(!foreignReport.markdown.includes("VISIBLE_EVIDENCE"));
});
