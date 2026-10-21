import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { normalizeServers } from "./servers.js";
import { resolveAddresses } from "./connection-transport.js";
import { fail, object } from "./validation.js";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const snapshotsKey = "network-scope:dns";
const restricted = new Set(["CN", "HK", "MO"]);

function hostname(value) {
  const normalized = normalizeServers([value])[0]
    ?.split("@")
    .at(-1)
    .replace(/^\[|\]$/g, "");
  if (!normalized) fail("INVALID_INPUT", "需要完整主机名或 IP");
  // Treat IPv4-mapped addresses as the same destination as their IPv4 representation.
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  return normalized;
}

/** Local policy shared by owned transports. It is not a general host egress firewall. */
export class NetworkScope {
  #active = null;
  #closed = false;

  constructor(store, { database, admission, resolve = resolveAddresses } = {}) {
    this.store = store;
    this.database = database;
    this.admission = admission;
    this.resolveAddresses = resolve;
  }

  hosts() {
    return [...new Set(this.store.dispatch("settings.get", {}).value.ownServers.map(hostname))];
  }

  snapshots(hosts = this.hosts()) {
    const saved = this.store.meta(snapshotsKey);
    return saved?.roster === digest(hosts) ? saved.items : {};
  }

  status() {
    const hosts = this.hosts();
    const snapshots = this.snapshots(hosts);
    const database = this.database.status();
    return {
      revision: digest({ hosts, snapshots, database: database.revision }),
      active: Boolean(this.#active),
      database,
      hosts: hosts.map((name) => ({
        hostname: name,
        type: isIP(name) ? "ip" : "hostname",
        snapshot: snapshots[name] ?? null,
      })),
    };
  }

  exception(target) {
    const name = hostname(target);
    const hosts = this.hosts();
    if (hosts.includes(name)) return { reason: "exact-host", matchedHost: name };
    if (isIP(name)) {
      for (const [registered, snapshot] of Object.entries(this.snapshots(hosts))) {
        if (snapshot.addresses.includes(name))
          return { reason: "resolved-exception", matchedHost: registered };
      }
    }
    return null;
  }

  preview(target) {
    const name = hostname(target);
    const exception = this.exception(name);
    if (exception) return { state: "ready", ...exception };
    if (isIP(name)) {
      const decision = this.decide(name, name);
      return { state: decision.allowed ? "ready" : "denied", ...decision };
    }
    return this.database.status().available
      ? { state: "ready", reason: "region-pending" }
      : { state: "denied", reason: "database-unavailable" };
  }

  decide(target, address) {
    const name = hostname(target);
    if (typeof address !== "string" || address.includes("%") || !isIP(address))
      return { allowed: false, reason: "country-unknown", country: null, address: "" };
    const ip = hostname(address);
    if (isIP(name) && name !== ip)
      return { allowed: false, reason: "country-unknown", country: null, address: ip };
    // A shared IP does not grant an alias or subdomain the registered host's exception.
    const exception = this.exception(name);
    if (exception) return { allowed: true, ...exception, country: null, address: ip };
    const databaseRevision = this.database.status().revision;
    const result = this.database.lookup(ip);
    const reason =
      result.kind === "special"
        ? "special-address"
        : result.kind !== "country"
          ? result.reason === "database-unavailable"
            ? "database-unavailable"
            : "country-unknown"
          : restricted.has(result.country)
            ? "country-denied"
            : "country-allowed";
    return {
      allowed: reason === "country-allowed",
      reason,
      country: result.country,
      address: ip,
      databaseRevision,
    };
  }

  refresh(payload) {
    object(payload);
    if (this.#closed) fail("CLOSED", "范围服务已经关闭");
    this.admission?.require();
    if (payload.confirmed !== true) fail("CONFIRMATION_REQUIRED", "请明确确认本次域名解析");
    const before = this.status();
    if (payload.revision !== before.revision)
      fail("CONFLICT", "登记范围或地区数据已变化，请刷新后确认");
    const registered = new Set(
      before.hosts.filter((host) => host.type === "hostname").map((host) => host.hostname),
    );
    if (
      !Array.isArray(payload.hosts) ||
      !payload.hosts.length ||
      payload.hosts.length > 32 ||
      payload.hosts.some((host) => !registered.has(host)) ||
      new Set(payload.hosts).size !== payload.hosts.length
    )
      fail("INVALID_INPUT", "请选择 1 至 32 个不同的已保存域名；IP 无需解析");
    if (this.#active) fail("CONFLICT", "已有域名解析正在执行");
    const active = { controller: new AbortController() };
    this.#active = active;
    const admissionRevision = this.admission?.status().revision;
    active.done = Promise.resolve()
      .then(() => this.execute(payload.hosts, before, admissionRevision, active.controller.signal))
      .finally(() => {
        this.#active = null;
      });
    return active.done;
  }

  async execute(hosts, before, admissionRevision, signal) {
    const items = [];
    const changed = () =>
      before.revision !== this.status().revision
        ? "scope-changed"
        : admissionRevision !== this.admission?.status().revision
          ? "admission-changed"
          : signal.aborted
            ? "cancelled"
            : "";
    for (const name of hosts) {
      let reason = changed();
      let addresses;
      if (!reason) {
        try {
          const answers = await this.resolveAddresses(name, { signal, timeoutMs: 6000 });
          if (
            !answers.length ||
            answers.some((item) => !isIP(item.address) || item.address.includes("%"))
          )
            throw Object.assign(new Error("Invalid DNS response"), { code: "DNS_ERROR" });
          addresses = [...new Set(answers.map((item) => hostname(item.address)))];
        } catch (error) {
          reason =
            error.code === "DNS_CANCELLED"
              ? "cancelled"
              : error.code === "DNS_TIMEOUT"
                ? "timeout"
                : "dns-error";
        }
      }
      reason = changed() || reason;
      items.push({
        hostname: name,
        state: reason
          ? ["cancelled", "scope-changed", "admission-changed"].includes(reason)
            ? "cancelled"
            : "failed"
          : "resolved",
        reason,
        ...(addresses ? { addresses, resolvedAt: new Date().toISOString() } : {}),
        persisted: false,
      });
    }
    const invalidated = changed();
    if (invalidated) {
      for (const item of items) {
        if (item.state === "resolved") {
          item.state = "cancelled";
          item.reason = invalidated;
        }
      }
    } else if (items.some((item) => item.state === "resolved")) {
      const snapshots = { ...this.snapshots() };
      for (const item of items) {
        if (item.state === "resolved")
          snapshots[item.hostname] = { addresses: item.addresses, resolvedAt: item.resolvedAt };
      }
      try {
        this.store.setMeta(snapshotsKey, { roster: digest(this.hosts()), items: snapshots });
        for (const item of items) if (item.state === "resolved") item.persisted = true;
      } catch {
        throw Object.assign(new Error("域名解析已观察，但快照保存失败"), {
          code: "NETWORK_SCOPE_PARTIAL",
          partial: { items, status: { ...this.status(), active: false } },
        });
      }
    }
    return { items, status: { ...this.status(), active: false } };
  }

  async import(payload) {
    if (this.#closed) fail("CLOSED", "范围服务已经关闭");
    this.database.import(payload);
    await this.stopAll();
    return this.status();
  }

  async changed() {
    // Changing the saved inventory invalidates all derived-address exceptions.
    this.store.setMeta(snapshotsKey, null);
    return this.stopAll();
  }

  async stopAll() {
    const active = this.#active;
    active?.controller.abort();
    if (active) await Promise.allSettled([active.done]);
    return { stopped: true };
  }

  async close() {
    this.#closed = true;
    await this.stopAll();
  }

  dispatch(action, payload = {}) {
    const operation = {
      "networkScope.status": "status",
      "networkScope.resolve": "refresh",
      "networkScope.import": "import",
      "networkScope.stop": "stopAll",
    }[action];
    if (!operation) fail("UNKNOWN_ACTION", "未知范围管理操作");
    return this[operation](payload);
  }
}
