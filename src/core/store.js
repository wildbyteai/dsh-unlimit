import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { credentialUpdate, credentialView } from "./credentials.js";
import {
  DEFAULT_SETTINGS,
  RECORD_KINDS,
  StoreError,
  enumValue,
  fail,
  json,
  object,
  settings,
  string,
  tags,
} from "./validation.js";

export { StoreError };

const DEFAULT_ROLES = Object.freeze({
  planner:
    "担任本次演练的指挥：确认目标、授权范围和验收标准，按已有证据安排侦察、检查、验证和报告工作。为每个会话明确角色和有限任务，尊重执行槽限制。涉及真实系统变更时先核实授权，汇总阻塞事项，不将计划描述成已执行结果。",
  recon:
    "负责资产侦察与证据整理：依据当前工作区提供的地址、域名和关联记录建立资产清单，注明来源、观察时间和未知项。发现候选目标时先核对授权范围，未经许可不执行网络探测，不把名称相似视为同一资产。",
  scanner:
    "负责检查任务：围绕已授权资产和明确检查项安排最小验证步骤。记录输入、观察结果和证据位置，区分已检查、未运行和无法判断；不得把导入记录或工具可用性冒充扫描结果。",
  validator:
    "负责发现验证：将每项判断对应到可复核的证据，排除配置误解和重复发现。优先采用不改变业务状态的验证；需要写入时列明影响并核实授权。证据不足时标为待验证，不能为了评分扩大操作。",
  internal:
    "负责授权范围内的内部关联分析：根据工作区已有访问、关系和会话记录梳理信任边界与潜在路径。明确每一步前置条件和证据缺口，不自动使用凭据、建立连接或迁移到新目标；任何实际操作仍需对应授权。",
  analyst:
    "仅依据当前工作区的资产和证据分析风险。区分事实、推测和未验证结论；给出可复现的本地验证步骤，不虚构扫描结果。",
  reviewer:
    "复核发现与证据是否对应、严重性是否合理、是否越过授权范围。指出结论缺口并给出最小补证建议，报告中隐藏凭据。",
  reporter:
    "根据已有发现与证据编写简明报告，列出影响、验证状态、整改建议和限制。不得将本地记录描述成已经执行的远程操作。",
});

function redact(value, key = "") {
  if (
    /pass(word|phrase)?|secret|token|cookie|authorization|private.?key|api.?key|credential/i.test(
      key,
    )
  )
    return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  if (typeof value === "string")
    return value
      .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(
        /\b(password|passwd|secret|token|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi,
        "$1=[REDACTED]",
      )
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  return value;
}

function markdown(value) {
  return String(value)
    .replace(/[\\`*_{}\[\]<>#|]/g, "\\$&")
    .replace(/\r?\n/g, " ");
}

function address(value) {
  const input = string(value, "address").trim();
  if (/\s/.test(input)) fail("INVALID_INPUT", "address cannot contain whitespace");
  if (/^https?:\/\//i.test(input)) {
    let parsed;
    try {
      parsed = new URL(input);
    } catch {
      fail("INVALID_INPUT", "Invalid HTTP asset address");
    }
    if (!parsed.hostname) fail("INVALID_INPUT", "HTTP asset address requires a hostname");
    parsed.hash = "";
    return parsed.href;
  }
  const hostPort = /^[^/:]+:\d{1,5}(?:\/|$)/.test(input);
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !hostPort && isIP(input) !== 6)
    fail(
      "INVALID_INPUT",
      "Asset URL schemes are limited to HTTP and HTTPS; plain hosts and IPs are also accepted",
    );
  const slash = input.indexOf("/");
  return slash < 0 ? input.toLowerCase() : input.slice(0, slash).toLowerCase() + input.slice(slash);
}

function evidencePresent(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(evidencePresent);
  if (value && typeof value === "object")
    return ["content", "text", "excerpt", "observation", "result"].some((key) =>
      evidencePresent(value[key]),
    );
  return false;
}

function ruleContent(value) {
  const content = string(value, "content", { empty: true });
  if (Buffer.byteLength(content) > 256 * 1024)
    fail("LIMIT_EXCEEDED", "Rule content exceeds 256 KiB");
  return content;
}

function port(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535)
    fail("INVALID_INPUT", "port must be an integer from 1 to 65535");
  return value;
}
function ports(value = []) {
  if (!Array.isArray(value)) fail("INVALID_INPUT", "ports must be an array");
  return [...new Set(value.map(port))];
}
function protocol(value = "tcp") {
  return enumValue(string(value, "protocol").toLowerCase(), "protocol", ["tcp", "udp"]);
}
function serviceFields(value) {
  object(value, "service");
  return {
    port: port(value.port),
    protocol: protocol(value.protocol),
    ...(value.name === undefined ? {} : { name: string(value.name, "service name") }),
    ...(value.product === undefined ? {} : { product: string(value.product, "service product") }),
    ...(value.version === undefined ? {} : { version: string(value.version, "service version") }),
    fingerprints: tags(value.fingerprints),
    sources: tags(value.sources),
    tags: tags(value.tags),
  };
}
function mergeServices(before = [], incoming = []) {
  const result = before.map((item) => ({ ...item }));
  for (const observed of incoming) {
    const index = result.findIndex(
      (item) => item.port === observed.port && (item.protocol ?? "tcp") === observed.protocol,
    );
    const previous = index < 0 ? null : result[index];
    const item = {
      ...previous,
      ...observed,
      id: previous?.id ?? randomUUID(),
      fingerprints: tags([...(previous?.fingerprints ?? []), ...observed.fingerprints]),
      sources: tags([...(previous?.sources ?? []), ...observed.sources]),
      tags: tags([...(previous?.tags ?? []), ...observed.tags]),
    };
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}
function hostname(value) {
  if (/^https?:\/\//i.test(value)) return new URL(value).hostname.replace(/^\[|\]$/g, "");
  const host = value.split("/")[0].split("@").at(-1);
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  return isIP(host) === 6 ? host : host.replace(/:\d+$/, "");
}
function scopeOf(value) {
  const host = hostname(value);
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
      ? "internal"
      : "external";
  }
  if (isIP(host) === 6)
    return host === "::1" || /^(fc|fd|fe[89ab])/i.test(host) ? "internal" : "external";
  return "unknown";
}
function priority(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return string(value, "priority");
}

export class WorkspaceStore {
  constructor(databasePath) {
    string(databasePath, "databasePath");
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY, domain TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT '', value TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_scope ON entries(domain, workspace, kind);
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)")
      .run("settings", JSON.stringify({ revision: 0, value: DEFAULT_SETTINGS }));
  }

  close() {
    this.db.close();
  }
  meta(key, fallback = null) {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setMeta(key, value) {
    this.db
      .prepare(
        "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  list(domain, workspace = "", kind = "") {
    return this.db
      .prepare(
        "SELECT value FROM entries WHERE domain = ? AND workspace = ? AND kind = ? ORDER BY created_at, rowid",
      )
      .all(domain, workspace, kind)
      .map((row) => {
        const item = JSON.parse(row.value);
        return domain === "records" && kind === "credential" ? credentialView(item) : item;
      });
  }
  get(domain, id, workspace = "", kind = "") {
    const item = this.#entry(domain, id, workspace, kind);
    return domain === "records" && kind === "credential" ? credentialView(item) : item;
  }
  #entry(domain, id, workspace = "", kind = "") {
    string(id, "id");
    const row = this.db
      .prepare(
        "SELECT value FROM entries WHERE id = ? AND domain = ? AND workspace = ? AND kind = ?",
      )
      .get(id, domain, workspace, kind);
    if (!row) fail("NOT_FOUND", `${domain} item not found in this scope`);
    return JSON.parse(row.value);
  }
  save(domain, payload, fields, workspace = "", kind = "") {
    const previous =
      payload.id === undefined ? null : this.#entry(domain, payload.id, workspace, kind);
    const now = new Date().toISOString();
    const item = {
      ...previous,
      ...fields,
      id: previous?.id ?? randomUUID(),
      ...(workspace ? { workspaceId: workspace } : {}),
      ...(kind ? { kind } : {}),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO entries(id, domain, workspace, kind, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      )
      .run(item.id, domain, workspace, kind, JSON.stringify(item), item.createdAt, now);
    return domain === "records" && kind === "credential" ? credentialView(item) : item;
  }
  remove(domain, id, workspace = "", kind = "") {
    this.get(domain, id, workspace, kind);
    this.db
      .prepare("DELETE FROM entries WHERE id = ? AND domain = ? AND workspace = ? AND kind = ?")
      .run(id, domain, workspace, kind);
    return { deleted: true };
  }
  workspace(payload) {
    return this.get("workspaces", string(payload.workspaceId, "workspaceId")).id;
  }
  references(data, workspace) {
    if (data.assetId !== undefined) this.get("assets", data.assetId, workspace);
    if (data.assetIds !== undefined) {
      if (!Array.isArray(data.assetIds)) fail("INVALID_INPUT", "assetIds must be an array");
      for (const id of data.assetIds) this.get("assets", id, workspace);
    }
    if (data.findingId !== undefined) this.get("findings", data.findingId, workspace);
    if (data.pointId !== undefined) this.get("records", data.pointId, workspace, "score-point");
  }
  search(items, query) {
    if (query === undefined) return items;
    string(query, "query", { empty: true });
    const needle = query.toLowerCase();
    return items.filter((item) => JSON.stringify(item).toLowerCase().includes(needle));
  }
  event(workspace, assetId, kind, data) {
    return this.save("events", {}, { assetId, kind, data }, workspace);
  }

  assetFields(payload, workspace) {
    object(payload, "asset");
    if (payload.workspaceId !== undefined && payload.workspaceId !== workspace)
      fail("INVALID_INPUT", "Asset workspaceId does not match the import workspace");
    const previous = payload.id === undefined ? null : this.get("assets", payload.id, workspace);
    if (payload.services !== undefined && !Array.isArray(payload.services))
      fail("INVALID_INPUT", "services must be an array");
    const fields = {
      name: string(payload.name, "name"),
      address: address(payload.address),
      type: string(payload.type ?? previous?.type ?? "host", "type")
        .trim()
        .toLowerCase(),
      ...(payload.tags === undefined ? {} : { tags: tags(payload.tags) }),
      ...(payload.notes === undefined
        ? {}
        : { notes: string(payload.notes, "notes", { empty: true }) }),
    };
    for (const key of ["names", "domains", "fingerprints", "sources"])
      if (payload[key] !== undefined) fields[key] = tags(payload[key]);
    if (payload.source !== undefined)
      fields.sources = tags([...(fields.sources ?? []), string(payload.source, "source")]);
    if (payload.ports !== undefined) fields.ports = ports(payload.ports);
    if (payload.services !== undefined) fields.services = payload.services.map(serviceFields);
    for (const key of ["scope", "segment", "status"])
      if (payload[key] !== undefined) fields[key] = string(payload[key], key);
    if (payload.priority !== undefined) fields.priority = priority(payload.priority);
    return { previous, fields };
  }
  saveAsset(payload, workspace) {
    const { previous, fields } = this.assetFields(payload, workspace);
    const duplicate = this.list("assets", workspace).find(
      (item) =>
        address(item.address) === fields.address && item.type.trim().toLowerCase() === fields.type,
    );
    if (previous && duplicate && duplicate.id !== previous.id)
      fail("CONFLICT", "The address and type already belong to another asset");
    const target = previous ?? duplicate;
    const notes = [
      ...new Set(
        [target?.notes, fields.notes].filter((note) => typeof note === "string" && note.trim()),
      ),
    ].join("\n");
    const now = new Date().toISOString();
    const services = mergeServices(target?.services, fields.services);
    const host = hostname(fields.address);
    const names = tags([
      ...(target?.names ?? []),
      ...(target?.name ? [target.name] : []),
      ...(fields.names ?? []),
      fields.name,
    ]);
    const domains = tags([
      ...(target?.domains ?? []),
      ...(fields.domains ?? []).map((value) => value.toLowerCase()),
      ...(!isIP(host) && host.includes(".") ? [host.toLowerCase()] : []),
    ]);
    const item = this.save(
      "assets",
      target ? { id: target.id } : {},
      {
        ...fields,
        names,
        domains,
        services,
        ports: ports([
          ...(target?.ports ?? []),
          ...(fields.ports ?? []),
          ...services.map((service) => service.port),
        ]),
        fingerprints: tags([
          ...(target?.fingerprints ?? []),
          ...(fields.fingerprints ?? []),
          ...services.flatMap((service) => service.fingerprints),
        ]),
        sources: tags([
          ...(target?.sources ?? []),
          ...(fields.sources ?? []),
          ...services.flatMap((service) => service.sources),
        ]),
        scope: fields.scope ?? target?.scope ?? scopeOf(fields.address),
        segment: fields.segment ?? target?.segment ?? "",
        status: fields.status ?? target?.status ?? "unverified",
        priority: fields.priority ?? target?.priority ?? "normal",
        firstSeenAt: target?.firstSeenAt ?? target?.createdAt ?? now,
        lastSeenAt: now,
        tags: tags([...(target?.tags ?? []), ...(fields.tags ?? [])]),
        notes,
      },
      workspace,
    );
    this.event(workspace, item.id, target ? "asset.updated" : "asset.created", {
      observedAt: now,
      sources: fields.sources ?? [],
    });
    return { item, merged: Boolean(target) };
  }
  findAssets(payload) {
    let items = this.list("assets", this.workspace(payload));
    for (const key of ["scope", "segment", "status", "type"])
      if (payload[key] !== undefined) {
        string(payload[key], key, { empty: key === "segment" });
        items = items.filter(
          (item) =>
            (key === "scope" ? (item.scope ?? scopeOf(item.address)) : item[key]) === payload[key],
        );
      }
    if (payload.priority !== undefined) {
      priority(payload.priority);
      items = items.filter((item) => item.priority === payload.priority);
    }
    if (payload.port !== undefined) {
      port(payload.port);
      items = items.filter((item) => item.ports?.includes(payload.port));
    }
    for (const [field, key] of [
      ["source", "sources"],
      ["fingerprint", "fingerprints"],
    ])
      if (payload[field] !== undefined) {
        const needle = string(payload[field], field).toLowerCase();
        items = items.filter((item) =>
          item[key]?.some((value) => value.toLowerCase().includes(needle)),
        );
      }
    const selectedTags = tags(payload.tags);
    items = items.filter((item) => selectedTags.every((tag) => item.tags.includes(tag)));
    if (payload.service !== undefined) {
      const needle = string(payload.service, "service").toLowerCase();
      items = items.filter((item) =>
        item.services?.some(
          (service) =>
            service.id === needle ||
            service.name?.toLowerCase().includes(needle) ||
            `${service.protocol}/${service.port}` === needle,
        ),
      );
    }
    if (payload.view !== undefined) {
      enumValue(payload.view, "view", ["all", "internal", "external", "domains", "web"]);
      if (["internal", "external"].includes(payload.view))
        items = items.filter((item) => (item.scope ?? scopeOf(item.address)) === payload.view);
      if (payload.view === "domains")
        items = items.filter((item) => item.type === "domain" || item.domains?.length > 0);
      if (payload.view === "web")
        items = items.filter(
          (item) =>
            /^https?:\/\//i.test(item.address) ||
            item.type === "web" ||
            item.services?.some((service) => /^https?$/i.test(service.name ?? "")),
        );
    }
    items = this.search(items, payload.query);
    return { items, total: items.length };
  }
  timeline(workspace) {
    const items = this.list("events", workspace);
    const days = new Map();
    const day = (date) => {
      if (!days.has(date))
        days.set(date, { date, discovered: 0, observations: 0, assetIds: new Set() });
      return days.get(date);
    };
    for (const asset of this.list("assets", workspace)) {
      const entry = day((asset.firstSeenAt ?? asset.createdAt).slice(0, 10));
      entry.discovered++;
      entry.assetIds.add(asset.id);
    }
    for (const item of items)
      if (["asset.created", "asset.updated"].includes(item.kind)) {
        const entry = day((item.data.observedAt ?? item.createdAt).slice(0, 10));
        entry.observations++;
        entry.assetIds.add(item.assetId);
      }
    return {
      items,
      daily: [...days.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => ({ ...entry, assetIds: [...entry.assetIds] })),
    };
  }
  scoreTarget(data, workspace) {
    if (data.serviceId !== undefined) {
      string(data.serviceId, "serviceId");
      if (data.assetId === undefined) fail("INVALID_INPUT", "serviceId requires assetId");
      const asset = this.get("assets", data.assetId, workspace);
      const service = asset.services?.find((item) => item.id === data.serviceId);
      if (!service) fail("NOT_FOUND", "Service does not belong to the selected asset");
      if (
        data.port !== undefined &&
        (data.port !== service.port || protocol(data.protocol) !== service.protocol)
      )
        fail("INVALID_INPUT", "Service and port identities do not match");
      return `${service.protocol}/${service.port}`;
    }
    if (data.port !== undefined) {
      if (data.assetId === undefined) fail("INVALID_INPUT", "A scored port requires assetId");
      return `${protocol(data.protocol)}/${port(data.port)}`;
    }
    if (data.protocol !== undefined)
      fail("INVALID_INPUT", "A scored protocol requires port or serviceId");
    return "asset";
  }
  importAssets(payload) {
    const workspace = this.workspace(payload);
    if (!Array.isArray(payload.items)) fail("INVALID_INPUT", "items must be an array");
    const results = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < payload.items.length; index++) {
        // Validate an item completely before its first write. Input rejection is
        // reported per item; storage failures abort and roll back the full batch.
        try {
          const candidate = payload.items[index];
          this.assetFields(candidate, workspace);
          const result = this.saveAsset(candidate, workspace);
          results.push({ index, status: result.merged ? "merged" : "added", item: result.item });
        } catch (error) {
          if (
            !(error instanceof StoreError) ||
            !["INVALID_INPUT", "NOT_FOUND", "CONFLICT"].includes(error.code)
          )
            throw error;
          results.push({
            index,
            status: "rejected",
            error: { code: error.code, message: error.message },
          });
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      added: results.filter((item) => item.status === "added").length,
      merged: results.filter((item) => item.status === "merged").length,
      rejected: results.filter((item) => item.status === "rejected").length,
      results,
    };
  }
  saveKnowledge(payload) {
    const previous = payload.id === undefined ? null : this.get("knowledge", payload.id);
    const title = string(payload.title, "title");
    const content = string(payload.content, "content", { empty: true });
    const changed =
      previous &&
      (title !== previous.title || content !== previous.content || payload.evidence !== undefined);
    if (payload.verified !== undefined && typeof payload.verified !== "boolean")
      fail("INVALID_INPUT", "verified must be boolean");
    const verified = payload.verified ?? (changed ? false : (previous?.verified ?? false));
    const evidence =
      payload.evidence === undefined
        ? (previous?.evidence ?? "")
        : json({ evidence: payload.evidence }, "evidence").evidence;
    if (verified && (!evidencePresent(evidence) || (changed && payload.evidence === undefined)))
      fail(
        "INVALID_INPUT",
        "Verified knowledge requires non-empty evidence for the current content",
      );
    const metadata =
      payload.metadata === undefined
        ? (previous?.metadata ?? {})
        : json(payload.metadata, "metadata");
    return this.save("knowledge", payload, {
      title,
      content,
      tags: payload.tags === undefined ? (previous?.tags ?? []) : tags(payload.tags),
      kind: string(payload.kind ?? previous?.kind ?? "note", "kind"),
      verified,
      evidence,
      metadata,
      ...(payload.source === undefined
        ? {}
        : { source: string(payload.source, "source", { empty: true }) }),
      verifiedAt: verified ? new Date().toISOString() : null,
    });
  }

  dispatch(action, payload = {}) {
    string(action, "action");
    object(payload);
    switch (action) {
      case "settings.get":
        return this.meta("settings");
      case "settings.save": {
        if (!Number.isSafeInteger(payload.revision) || payload.revision < 0)
          fail("INVALID_INPUT", "revision must be a non-negative integer");
        const value = settings(payload.value);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const current = this.meta("settings");
          if (current.revision !== payload.revision)
            fail("CONFLICT", "Settings changed; reload before saving");
          const next = { revision: current.revision + 1, value };
          this.setMeta("settings", next);
          this.db.exec("COMMIT");
          return next;
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      }
      case "rules.list":
        return { items: this.list("rules"), activeId: this.meta("activeRule") };
      case "rules.save":
        return {
          item: this.save("rules", payload, {
            name: string(payload.name, "name"),
            content: ruleContent(payload.content),
            ...(payload.model === undefined
              ? {}
              : { model: string(payload.model, "model", { empty: true }) }),
          }),
        };
      case "rules.delete": {
        const result = this.remove("rules", payload.id);
        if (this.meta("activeRule") === payload.id) this.setMeta("activeRule", null);
        return result;
      }
      case "rules.activate":
        this.get("rules", payload.id);
        this.setMeta("activeRule", payload.id);
        return { activeId: payload.id };
      case "rules.reset":
        this.setMeta("activeRule", null);
        return { activeId: null };
      case "workspaces.list":
        return { items: this.list("workspaces"), activeId: this.meta("activeWorkspace") };
      case "workspaces.save": {
        const item = this.save("workspaces", payload, {
          name: string(payload.name, "name"),
          scope: string(payload.scope ?? "", "scope", { empty: true }),
          authorization: string(payload.authorization ?? "", "authorization", { empty: true }),
        });
        return { item };
      }
      case "workspaces.activate":
        this.get("workspaces", payload.id);
        this.setMeta("activeWorkspace", payload.id);
        return { activeId: payload.id };
      case "workspaces.bind": {
        const item = this.get("workspaces", payload.id);
        const sessionId = string(payload.sessionId, "sessionId");
        this.setMeta(`sessionWorkspace:${sessionId}`, item.id);
        return { item, sessionId };
      }
      case "workspaces.forSession": {
        const sessionId = string(payload.sessionId, "sessionId");
        const id = this.meta(`sessionWorkspace:${sessionId}`);
        return { item: id === null ? null : this.get("workspaces", id), sessionId };
      }
      case "assets.list":
        return this.findAssets(payload);
      case "assets.save":
        return this.saveAsset(payload, this.workspace(payload));
      case "assets.import":
        return this.importAssets(payload);
      case "assets.link": {
        const workspace = this.workspace(payload);
        this.get("assets", payload.from, workspace);
        this.get("assets", payload.to, workspace);
        const relation = string(payload.relation, "relation");
        const item = this.save(
          "links",
          {},
          { from: payload.from, to: payload.to, relation },
          workspace,
        );
        this.event(workspace, payload.from, "asset.linked", { to: payload.to, relation });
        return { item };
      }
      case "assets.assess":
      case "assets.test": {
        const workspace = this.workspace(payload);
        const asset = this.get("assets", payload.id, workspace);
        const { workspaceId: _workspaceId, id: _id, ...details } = json(payload);
        this.references(details, workspace);
        const field = action === "assets.assess" ? "assessment" : "test";
        const recorded = {
          ...details,
          recordedAt: new Date().toISOString(),
          execution: "local-record-only",
        };
        const item = this.save("assets", { id: asset.id }, { [field]: recorded }, workspace);
        this.event(workspace, asset.id, action, recorded);
        return { item };
      }
      case "assets.graph": {
        const workspace = this.workspace(payload);
        return { nodes: this.list("assets", workspace), edges: this.list("links", workspace) };
      }
      case "assets.path": {
        const workspace = this.workspace(payload);
        this.get("assets", payload.from, workspace);
        this.get("assets", payload.to, workspace);
        const direction = enumValue(payload.direction ?? "directed", "direction", [
          "directed",
          "undirected",
        ]);
        const nodes = new Map(this.list("assets", workspace).map((item) => [item.id, item]));
        const adjacent = new Map([...nodes.keys()].map((id) => [id, []]));
        for (const edge of this.list("links", workspace)) {
          adjacent.get(edge.from).push({ next: edge.to, edge });
          if (direction === "undirected") adjacent.get(edge.to).push({ next: edge.from, edge });
        }
        const queue = [payload.from];
        const previous = new Map([[payload.from, null]]);
        for (let index = 0; index < queue.length && !previous.has(payload.to); index++) {
          for (const { next, edge } of adjacent.get(queue[index])) {
            if (previous.has(next)) continue;
            previous.set(next, { id: queue[index], edge });
            queue.push(next);
          }
        }
        if (!previous.has(payload.to)) return { found: false, direction, nodes: [], edges: [] };
        const pathNodes = [];
        const pathEdges = [];
        let cursor = payload.to;
        while (cursor !== null) {
          pathNodes.push(nodes.get(cursor));
          const parent = previous.get(cursor);
          if (parent) pathEdges.push(parent.edge);
          cursor = parent?.id ?? null;
        }
        return {
          found: true,
          direction,
          nodes: pathNodes.reverse(),
          edges: pathEdges.reverse(),
        };
      }
      case "assets.timeline":
        return this.timeline(this.workspace(payload));
      case "findings.list":
        return {
          items: this.search(this.list("findings", this.workspace(payload)), payload.query),
        };
      case "findings.save": {
        const workspace = this.workspace(payload);
        const fields = {
          title: string(payload.title, "title"),
          severity: enumValue(payload.severity, "severity", [
            "critical",
            "high",
            "medium",
            "low",
            "info",
          ]),
          status: enumValue(payload.status ?? "open", "status", [
            "open",
            "confirmed",
            "resolved",
            "accepted",
            "closed",
          ]),
          evidence:
            payload.evidence === undefined
              ? ""
              : json({ value: payload.evidence }, "evidence").value,
          ...(payload.assetId === undefined ? {} : { assetId: payload.assetId }),
        };
        this.references(fields, workspace);
        return { item: this.save("findings", payload, fields, workspace) };
      }
      case "records.list":
        return {
          items: this.list(
            "records",
            this.workspace(payload),
            enumValue(payload.kind, "kind", RECORD_KINDS),
          ),
        };
      case "records.save": {
        const workspace = this.workspace(payload);
        const kind = enumValue(payload.kind, "kind", RECORD_KINDS);
        let data = json(payload.data);
        if (kind === "credential") {
          const previous =
            payload.id === undefined ? null : this.#entry("records", payload.id, workspace, kind);
          data = credentialUpdate(previous?.data, data, {
            clearLegacyFields:
              payload.clearLegacyFields === undefined ? false : payload.clearLegacyFields,
          });
          if (typeof data.assetId === "string") this.get("assets", data.assetId, workspace);
          if (typeof data.serviceId === "string") {
            if (typeof data.assetId !== "string")
              fail("INVALID_INPUT", "Credential serviceId requires assetId");
            const asset = this.get("assets", data.assetId, workspace);
            if (!asset.services?.some((service) => service.id === data.serviceId))
              fail("NOT_FOUND", "Credential service does not belong to the selected asset");
          }
        } else if (payload.clearLegacyFields !== undefined) {
          fail("INVALID_INPUT", "clearLegacyFields is only valid for credential records");
        }
        if (kind !== "credential") this.references(data, workspace);
        if (kind === "score-hit" && data.pointId === undefined)
          fail("INVALID_INPUT", "score-hit requires data.pointId");
        if (kind === "score-hit") {
          this.scoreTarget(data, workspace);
          if (data.awarded !== undefined && typeof data.awarded !== "boolean")
            fail("INVALID_INPUT", "awarded must be boolean");
        }
        if (["score-point", "score-hit"].includes(kind) && data.stageId !== undefined)
          this.get("records", data.stageId, workspace, "stage");
        if (kind === "score-point" && data.stage !== undefined) string(data.stage, "stage");
        if (
          kind === "score-point" &&
          data.points !== undefined &&
          (typeof data.points !== "number" || !Number.isFinite(data.points) || data.points < 0)
        )
          fail("INVALID_INPUT", "points must be a non-negative finite number");
        return { item: this.save("records", payload, { data }, workspace, kind) };
      }
      case "records.delete": {
        const workspace = this.workspace(payload);
        const kind = enumValue(payload.kind, "kind", RECORD_KINDS);
        if (
          kind === "score-point" &&
          this.list("records", workspace, "score-hit").some(
            (hit) => hit.data.pointId === payload.id,
          )
        )
          fail("IN_USE", "Score point is referenced by score hits");
        if (
          kind === "stage" &&
          ["score-point", "score-hit"].some((recordKind) =>
            this.list("records", workspace, recordKind).some(
              (item) => item.data.stageId === payload.id,
            ),
          )
        )
          fail("IN_USE", "Stage is referenced by scoring records");
        return this.remove("records", payload.id, workspace, kind);
      }
      case "knowledge.list": {
        if (payload.kind !== undefined) string(payload.kind, "kind");
        if (payload.verified !== undefined && typeof payload.verified !== "boolean")
          fail("INVALID_INPUT", "verified must be boolean");
        const selectedTags = tags(payload.tags);
        return {
          items: this.search(
            this.list("knowledge").filter(
              (item) =>
                (payload.kind === undefined || item.kind === payload.kind) &&
                (payload.verified === undefined || Boolean(item.verified) === payload.verified) &&
                selectedTags.every((tag) => item.tags.includes(tag)),
            ),
            payload.query,
          ),
        };
      }
      case "knowledge.save":
        return { item: this.saveKnowledge(payload) };
      case "knowledge.delete":
        return this.remove("knowledge", payload.id);
      case "knowledge.use": {
        const item = this.get("knowledge", payload.id);
        return {
          item: this.save(
            "knowledge",
            { id: item.id },
            { useCount: (item.useCount ?? 0) + 1, lastUsedAt: new Date().toISOString() },
          ),
        };
      }
      case "roles.list":
        return { items: this.roles(this.workspace(payload)) };
      case "roles.save": {
        const workspace = this.workspace(payload);
        const role = enumValue(payload.role, "role", Object.keys(DEFAULT_ROLES));
        const existing = this.list("roles", workspace).find((item) => item.role === role);
        this.save(
          "roles",
          existing ? { id: existing.id } : {},
          { role, content: string(payload.content, "content", { empty: true }) },
          workspace,
        );
        return { items: this.roles(workspace) };
      }
      case "roles.reset": {
        const workspace = this.workspace(payload);
        if (payload.role === undefined)
          this.db
            .prepare("DELETE FROM entries WHERE domain = ? AND workspace = ?")
            .run("roles", workspace);
        else {
          const role = enumValue(payload.role, "role", Object.keys(DEFAULT_ROLES));
          const existing = this.list("roles", workspace).find((item) => item.role === role);
          if (existing) this.remove("roles", existing.id, workspace);
        }
        return { items: this.roles(workspace) };
      }
      case "report.build":
        return this.report(this.workspace(payload));
      default:
        fail("UNKNOWN_ACTION", `Unsupported data action: ${action}`);
    }
  }

  roles(workspace) {
    const overrides = this.list("roles", workspace);
    return Object.entries(DEFAULT_ROLES).map(
      ([role, content]) =>
        overrides.find((item) => item.role === role) ?? {
          role,
          content,
          workspaceId: workspace,
          isDefault: true,
        },
    );
  }

  report(workspace) {
    const info = this.get("workspaces", workspace);
    const assets = this.list("assets", workspace);
    const findings = this.list("findings", workspace);
    const records = Object.fromEntries(
      RECORD_KINDS.map((kind) => [kind, this.list("records", workspace, kind)]),
    );
    const points = records["score-point"];
    const hits = records["score-hit"];
    const covered = new Set();
    const scoreByStage = new Map();
    let scoreEarned = 0;
    for (const hit of hits) {
      if (hit.data.awarded === false) continue;
      const point = points.find((item) => item.id === hit.data.pointId);
      if (!point) fail("INVALID_DATA", "Scoring evidence references a missing score point");
      const key = JSON.stringify([
        point.id,
        hit.data.assetId ?? null,
        this.scoreTarget(hit.data, workspace),
      ]);
      if (covered.has(key)) continue;
      covered.add(key);
      const earned = point.data.points ?? 0;
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
      scoreByStage: [...scoreByStage.values()],
      scoreTotal: points.reduce((sum, item) => sum + (item.data.points ?? 0), 0),
      scoreEarned,
    };
    const lines = [
      `# ${markdown(redact(info.name))} 演练报告`,
      "",
      `授权范围：${markdown(redact(info.scope))}`,
      "",
      "本报告汇总本地记录；记录存在不表示已执行远程验证。凭据记录内容默认隐藏。",
      "",
      `资产 ${stats.assets}；服务 ${stats.services}；发现 ${stats.findings}；证据记录 ${stats.records}；评分累计 ${stats.scoreEarned}；计分点基准总分 ${stats.scoreTotal}（每资产/服务分别累计）。`,
      "",
      "## 资产",
      ...assets.map(
        (item) =>
          `- ${markdown(redact(item.name))} · ${markdown(redact(item.address))} (${markdown(item.type)})`,
      ),
      "",
      "## 发现",
      ...findings.flatMap((item) => [
        `### ${markdown(redact(item.title))}`,
        `严重性：${item.severity}；状态：${item.status}；关联资产：${item.assetId ?? "无"}`,
        "",
        markdown(JSON.stringify(redact(item.evidence))),
        "",
      ]),
      "## 证据记录",
    ];
    for (const [kind, items] of Object.entries(records)) {
      if (!items.length) continue;
      lines.push(`### ${kind}`);
      for (const item of items)
        lines.push(
          `- ${item.id}: ${kind === "credential" ? "[REDACTED]" : markdown(JSON.stringify(redact(item.data)))}`,
        );
    }
    return { markdown: lines.join("\n"), stats };
  }
}

export default WorkspaceStore;
