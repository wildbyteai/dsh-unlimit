import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeServers } from "./servers.js";
import { fail, object } from "./validation.js";
import { checkEndpoint, resolveAddresses } from "./connection-transport.js";

const kinds = ["webshell", "tunnel"];
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (id) => `connection-check:${id}`;
const unbracket = (value) => value.replace(/^\[|\]$/g, "");
const host = (value) => {
  if (typeof value !== "string" || value.includes("@")) throw new Error("Invalid host");
  return unbracket(normalizeServers([value])[0]);
};

function endpoint(record) {
  const data = record.data;
  if (record.kind === "webshell") {
    let url;
    try {
      if (
        typeof data.url !== "string" ||
        !/^https?:\/\//i.test(data.url) ||
        /[\s\\]/.test(data.url)
      )
        throw new Error("Invalid URL");
      url = new URL(data.url);
      if (url.username || url.password || url.hash) throw new Error("Invalid URL");
      const hostname = host(url.hostname);
      return {
        protocol: url.protocol,
        hostname,
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        path: `${url.pathname}${url.search}`,
        target: `${url.protocol}//${isIP(hostname) === 6 ? `[${hostname}]` : hostname}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search ? "?[查询参数已隐藏]" : ""}`,
        checkType: "http",
      };
    } catch {
      return { reason: "invalid-url" };
    }
  }
  if (typeof data.protocol === "string" && data.protocol.toLowerCase() === "udp")
    return { reason: "unsupported-protocol" };
  try {
    const hostname = host(data.listenHost);
    if (!Number.isInteger(data.listenPort) || data.listenPort < 1 || data.listenPort > 65535)
      throw new Error("Invalid port");
    return {
      protocol: "tcp:",
      hostname,
      port: data.listenPort,
      target: `tcp://${isIP(hostname) === 6 ? `[${hostname}]` : hostname}:${data.listenPort}`,
      checkType: "tcp",
    };
  } catch {
    return { reason: "invalid-listener" };
  }
}

/** Explicit UI checks only; the inventory, model tools and reads never start a request. */
export class ConnectionChecks {
  #active = new Map();
  #closed = false;

  constructor(
    store,
    { admission, scope, resolve = resolveAddresses, transport = checkEndpoint } = {},
  ) {
    this.store = store;
    this.admission = admission;
    this.scope = scope;
    this.resolve = resolve;
    this.transport = transport;
  }

  records(workspaceId) {
    return kinds.flatMap((kind) => this.store.list("records", workspaceId, kind));
  }

  policy() {
    const servers = this.store.dispatch("settings.get", {}).value.ownServers;
    return {
      fingerprint: this.scope?.status().revision ?? digest(servers),
      hosts: new Set(servers.map((entry) => unbracket(entry.split("@").at(-1)))),
      admissionRevision: this.admission?.status().revision ?? null,
    };
  }

  previous(record) {
    const saved = this.store.meta(key(record.id));
    if (!saved || saved.workspaceId !== record.workspaceId)
      return { lastCheck: null, stale: false };
    return {
      lastCheck: saved.result,
      stale:
        saved.fingerprint !== digest(record) ||
        ((this.scope || saved.policy !== undefined) && saved.policy !== this.policy().fingerprint),
    };
  }

  status(payload) {
    const workspaceId = this.store.workspace(payload);
    const active = this.#active.get(workspaceId);
    return {
      workspaceId,
      active: Boolean(active),
      completed: active?.completed ?? 0,
      total: active?.total ?? 0,
      items: this.records(workspaceId).map((record) => ({
        recordId: record.id,
        kind: record.kind,
        ...this.previous(record),
      })),
    };
  }

  plan(payload) {
    object(payload);
    const workspaceId = this.store.workspace(payload);
    if (
      !Array.isArray(payload.recordIds) ||
      !payload.recordIds.length ||
      payload.recordIds.length > 32 ||
      payload.recordIds.some((id) => typeof id !== "string" || !id) ||
      new Set(payload.recordIds).size !== payload.recordIds.length
    )
      fail("INVALID_INPUT", "请选择本项目 1 到 32 条不同的 WebShell 或隧道记录");
    const records = new Map(this.records(workspaceId).map((record) => [record.id, record]));
    const selected = payload.recordIds.map((id) => {
      if (!records.has(id)) fail("NOT_FOUND", "检查记录不在当前项目或不是支持的类型");
      return records.get(id);
    });
    const policy = this.policy();
    const items = selected.map((record) => {
      const address = endpoint(record);
      const scope = address.reason ? null : this.scope?.preview(address.hostname);
      const permitted =
        !address.reason && (scope ? scope.state === "ready" : policy.hosts.has(address.hostname));
      const { state: _previewState, ...decision } = scope ?? {};
      return {
        record,
        endpoint: address,
        fingerprint: digest(record),
        view: {
          recordId: record.id,
          kind: record.kind,
          name: typeof record.data.name === "string" ? record.data.name : "",
          target: address.target ?? "",
          checkType: address.checkType ?? null,
          state: address.reason ? "unsupported" : permitted ? "ready" : "denied",
          reason: address.reason ?? scope?.reason ?? (permitted ? "" : "scope-unverified"),
          ...(decision.address ? { scope: decision } : {}),
          ...this.previous(record),
        },
      };
    });
    return {
      workspaceId,
      policy,
      items,
      snapshot: digest({
        records: selected,
        policy: policy.fingerprint,
        admission: policy.admissionRevision,
      }),
    };
  }

  prepare(payload) {
    if (this.#closed) fail("CLOSED", "连接检查服务已经关闭");
    this.admission?.require();
    const plan = this.plan(payload);
    return {
      workspaceId: plan.workspaceId,
      recordIds: [...payload.recordIds],
      snapshot: plan.snapshot,
      items: plan.items.map((item) => item.view),
    };
  }

  run(payload) {
    if (this.#closed) fail("CLOSED", "连接检查服务已经关闭");
    this.admission?.require();
    if (payload.confirmed !== true) fail("CONFIRMATION_REQUIRED", "请明确确认本次连接检查");
    const plan = this.plan(payload);
    if (payload.snapshot !== plan.snapshot)
      fail("CONFLICT", "记录或检查范围已变化，请重新预览并确认");
    const timeoutMs = payload.timeoutMs ?? 6000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
      fail("INVALID_INPUT", "每条检查的总时限须为 1 到 10000 毫秒");
    if (this.#active.has(plan.workspaceId)) fail("CONFLICT", "本项目已有正在执行的连接检查");
    const active = { controller: new AbortController(), completed: 0, total: plan.items.length };
    this.#active.set(plan.workspaceId, active);
    // Install ownership before the first asynchronous operation, including a literal-IP request.
    active.done = Promise.resolve()
      .then(() => this.execute(plan, active, timeoutMs))
      .finally(() => this.#active.delete(plan.workspaceId));
    return active.done;
  }

  changed(plan, item) {
    const current = this.records(plan.workspaceId).find((record) => record.id === item.record.id);
    if (!current || digest(current) !== item.fingerprint) return "record-changed";
    const policy = this.policy();
    if (policy.fingerprint !== plan.policy.fingerprint) return "scope-changed";
    if (policy.admissionRevision !== plan.policy.admissionRevision) return "admission-changed";
    return null;
  }

  async inspect(item, signal, timeoutMs, changed) {
    const started = performance.now();
    const remaining = () => Math.max(0, timeoutMs - (performance.now() - started));
    let addresses;
    const family = isIP(item.endpoint.hostname);
    if (family) addresses = [{ address: item.endpoint.hostname, family }];
    else {
      try {
        addresses = await this.resolve(item.endpoint.hostname, { signal, timeoutMs: remaining() });
      } catch (error) {
        return {
          state: error.code === "DNS_CANCELLED" ? "cancelled" : "unreachable",
          reason:
            error.code === "DNS_CANCELLED"
              ? "cancelled"
              : error.code === "DNS_TIMEOUT"
                ? "timeout"
                : "dns-error",
          latencyMs: Math.round(performance.now() - started),
        };
      }
    }
    if (!addresses.length)
      return {
        state: "unreachable",
        reason: "dns-error",
        latencyMs: Math.round(performance.now() - started),
      };
    if (signal.aborted || changed())
      return {
        state: "cancelled",
        reason: "cancelled",
        latencyMs: Math.round(performance.now() - started),
      };
    const decisions = this.scope
      ? addresses.map((candidate) => ({
          candidate,
          scope: this.scope.decide(item.endpoint.hostname, candidate.address),
        }))
      : addresses.map((candidate) => ({ candidate, scope: null }));
    const selected = decisions.find((decision) => !decision.scope || decision.scope.allowed);
    if (!selected)
      return {
        state: "denied",
        reason: decisions[0].scope.reason,
        scope: decisions[0].scope,
        latencyMs: Math.round(performance.now() - started),
      };
    // Local database handles can observe replacements by another process during lookup.
    if (signal.aborted || changed())
      return {
        state: "cancelled",
        reason: "cancelled",
        latencyMs: Math.round(performance.now() - started),
      };
    // Select one permitted address from this lookup. No second DNS, redirect or retry.
    const result = await this.transport(
      { ...item.endpoint, ...selected.candidate },
      { signal, timeoutMs: remaining() },
    );
    return {
      ...result,
      ...(selected.scope ? { scope: selected.scope } : {}),
      latencyMs: Math.round(performance.now() - started),
    };
  }

  async execute(plan, active, timeoutMs) {
    const items = [];
    const signal = active.controller.signal;
    for (const item of plan.items) {
      const { lastCheck: _previous, stale: _stale, ...view } = item.view;
      let observed;
      const changed = this.changed(plan, item);
      if (signal.aborted || changed)
        observed = { state: "cancelled", reason: "cancelled", latencyMs: 0 };
      else if (view.state !== "ready")
        observed = { state: view.state, reason: view.reason, latencyMs: 0 };
      else observed = await this.inspect(item, signal, timeoutMs, () => this.changed(plan, item));
      const result = {
        ...view,
        ...observed,
        checkedAt: new Date().toISOString(),
        persisted: false,
      };
      const discardReason = changed ?? this.changed(plan, item);
      if (discardReason) result.discardReason = discardReason;
      else {
        try {
          this.store.setMeta(key(item.record.id), {
            workspaceId: plan.workspaceId,
            fingerprint: item.fingerprint,
            policy: plan.policy.fingerprint,
            result: { ...result, persisted: true },
          });
          result.persisted = true;
        } catch {
          items.push(result);
          failPartial(plan.workspaceId, items, signal.aborted);
        }
      }
      items.push(result);
      active.completed++;
    }
    return {
      workspaceId: plan.workspaceId,
      items,
      cancelled: items.some((item) => item.state === "cancelled"),
    };
  }

  async stop(payload) {
    const workspaceId = this.store.workspace(payload);
    const active = this.#active.get(workspaceId);
    active?.controller.abort();
    // A run reports its own persistence error. Cancellation still awaits resource release.
    if (active) await Promise.allSettled([active.done]);
    return { stopped: true };
  }

  async stopAll() {
    const active = [...this.#active.values()];
    for (const item of active) item.controller.abort();
    await Promise.allSettled(active.map((item) => item.done));
    return { stopped: true };
  }

  async close() {
    this.#closed = true;
    return this.stopAll();
  }

  dispatch(action, payload = {}) {
    const operation = {
      "connectionChecks.prepare": "prepare",
      "connectionChecks.run": "run",
      "connectionChecks.status": "status",
      "connectionChecks.stop": "stop",
    }[action];
    if (!operation) fail("UNKNOWN_ACTION", "未知连接检查操作");
    return this[operation](payload);
  }
}

function failPartial(workspaceId, items, cancelled) {
  throw Object.assign(
    new Error("检查结果未能完整保存，已停止后续连接；请保留本次回执后核对本地存储"),
    {
      code: "CONNECTION_CHECK_PARTIAL",
      partial: { workspaceId, items, cancelled },
    },
  );
}
