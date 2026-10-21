import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceStore } from "../src/core/store.js";
import { DrillAdmission } from "../src/core/admission.js";
import { CountryDatabase } from "../src/core/country-database.js";
import { NetworkScope } from "../src/core/network-scope.js";
import { ConnectionChecks } from "../src/core/connection-checks.js";

const a = (address) => ({ address, family: 4 });
const aaaa = (address) => ({ address, family: 6 });
const native = [a("192.0.0.170"), a("192.0.0.171")];
const translated = [aaaa("2001:4860:1234::c000:aa"), aaaa("2001:4860:1234::c000:ab")];
const wireCn = "2001:4860:1234::100:101";
const wireUs = "2001:4860:1234::808:808";
const nativeUs = "2001:4860:4860::8888";
const csv = [
  "1.0.1.0,1.0.1.255,CN",
  "8.8.8.0,8.8.8.255,US",
  "2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US",
  "2001:abcd::,2001:abcd:ffff:ffff:ffff:ffff:ffff:ffff,CN",
].join("\n");
const dnsError = (code) => Object.assign(new Error("SYNTHETIC_PRIVATE_DNS_DETAIL"), { code });

function fixture(t, { available = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-connection-nat64-")));
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  const database = new CountryDatabase(root);
  const admission = new DrillAdmission(store, root, { clock: () => 0 });
  const { challengeId } = admission.begin({});
  admission.dispatch("admission.read", { challengeId });
  admission.clock = () => 5000;
  admission.confirm({ challengeId, checks: { scope: true, permissions: true, evidence: true } });
  const workspaceId = store.dispatch("workspaces.save", { name: "Synthetic DNS64 checks" }).item.id;
  const calls = { dns: [], transport: [] };
  const network = {
    target: [aaaa(nativeUs)],
    discovery: native,
    resolve: async (hostname) =>
      hostname === "ipv4only.arpa" ? network.discovery : network.target,
  };
  const resolve = async (hostname, options) => {
    calls.dns.push({ hostname, options });
    return network.resolve(hostname, options);
  };
  const scope = new NetworkScope(store, { database, admission, resolve });
  const checks = new ConnectionChecks(store, {
    admission,
    scope,
    resolve,
    transport: async (endpoint, options) => {
      calls.transport.push({ endpoint, options });
      return {
        state: "reachable",
        reason: endpoint.protocol === "tcp:" ? "tcp-connected" : "http-response",
        transport: {
          type: endpoint.protocol === "tcp:" ? "tcp" : "http",
          address: endpoint.address,
          family: endpoint.family,
          ...(endpoint.protocol === "tcp:" ? {} : { httpStatus: 403 }),
        },
      };
    },
  });
  const load = (release = "2026-10") =>
    database.import({
      filename: "synthetic.csv",
      contentBase64: Buffer.from(csv).toString("base64"),
      release,
      revision: database.status().revision,
    });
  if (available) load();
  const settings = (ownServers) => {
    const current = store.dispatch("settings.get", {});
    return store.dispatch("settings.save", {
      revision: current.revision,
      value: { ...current.value, ownServers },
    });
  };
  const record = (url, extra = {}) =>
    store.dispatch("records.save", { workspaceId, kind: "webshell", data: { url }, ...extra }).item;
  const tunnel = (listenHost) =>
    store.dispatch("records.save", {
      workspaceId,
      kind: "tunnel",
      data: { listenHost, listenPort: 12345, protocol: "tcp" },
    }).item;
  const prepare = (records) =>
    checks.prepare({ workspaceId, recordIds: records.map(({ id }) => id) });
  const run = (records, extra = {}) =>
    checks.run({ ...prepare(records), confirmed: true, ...extra });
  t.after(async () => {
    await checks.close();
    await scope.close();
    database.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    database,
    admission,
    scope,
    checks,
    workspaceId,
    calls,
    network,
    resolve,
    load,
    settings,
    record,
    tunnel,
    prepare,
    run,
  };
}

test("IPv6 preparation defers country classification and never discovers before confirmed run", async (t) => {
  const f = fixture(t);
  const records = [
    f.record("https://target.example.invalid/path?q=synthetic"),
    f.record("https://[2001:abcd:1234::808:808]/"),
    f.record("https://[3001:1234::808:808]/"),
  ];
  assert.equal(f.scope.preview("2001:abcd:1234::808:808").state, "denied");
  const prepared = f.prepare(records);
  assert.ok(
    prepared.items.every((item) => item.state === "ready" && item.reason === "region-pending"),
  );
  f.checks.status({ workspaceId: f.workspaceId });
  assert.throws(() => f.checks.run(prepared), { code: "CONFIRMATION_REQUIRED" });
  assert.deepEqual(f.calls, { dns: [], transport: [] });
});

test("A-only discovery allows native IPv6 and multiple candidates share one item snapshot", async (t) => {
  const f = fixture(t);
  f.network.target = [aaaa(nativeUs), aaaa("2001:4860:4860::8844")];
  const result = await f.run([f.record("https://native.example.invalid:8443/path?approved=yes")]);
  assert.equal(result.items[0].state, "reachable");
  assert.equal(result.items[0].scope.country, "US");
  assert.equal(result.items[0].scope.countryAddress, undefined);
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["native.example.invalid", "ipv4only.arpa"],
  );
  assert.equal(f.calls.transport.length, 1);
  assert.deepEqual(
    [
      f.calls.transport[0].endpoint.hostname,
      f.calls.transport[0].endpoint.address,
      f.calls.transport[0].endpoint.port,
      f.calls.transport[0].endpoint.path,
    ],
    ["native.example.invalid", nativeUs, 8443, "/path?approved=yes"],
  );
});

test("translated country decisions use IPv4 while retaining wire IPv6, original host and path", async (t) => {
  for (const [wire, expectedState, country, countryAddress] of [
    [wireCn, "denied", "CN", "1.0.1.1"],
    [wireUs, "reachable", "US", "8.8.8.8"],
  ]) {
    const f = fixture(t);
    f.network.target = [aaaa(wire)];
    f.network.discovery = translated;
    const record = f.record("https://translated.example.invalid:8443/exact%2Fpath?approved=a%2Bb");
    const result = await f.run([record]);
    const observed = result.items[0];
    assert.equal(observed.state, expectedState);
    assert.deepEqual(
      [observed.scope.country, observed.scope.address, observed.scope.countryAddress],
      [country, wire, countryAddress],
    );
    assert.equal(observed.scope.databaseRevision, f.database.status().revision);
    assert.equal(observed.persisted, true);
    assert.equal(f.calls.transport.length, expectedState === "reachable" ? 1 : 0);
    if (expectedState === "reachable") {
      const actual = f.calls.transport[0].endpoint;
      assert.deepEqual(
        [actual.hostname, actual.address, actual.family, actual.protocol, actual.path],
        ["translated.example.invalid", wire, 6, "https:", "/exact%2Fpath?approved=a%2Bb"],
      );
    }
    const reopened = new WorkspaceStore(join(f.root, "synthetic.sqlite"));
    const reopenedChecks = new ConnectionChecks(reopened, {
      scope: new NetworkScope(reopened, { database: f.database }),
      resolve: async () => {
        throw new Error("Unexpected test DNS");
      },
      transport: async () => {
        throw new Error("Unexpected test connection");
      },
    });
    try {
      const saved = reopenedChecks.status({ workspaceId: f.workspaceId }).items[0];
      assert.equal(saved.stale, false);
      assert.deepEqual(saved.lastCheck, observed);
      assert.equal(saved.lastCheck.scope.countryAddress, countryAddress);
    } finally {
      await reopenedChecks.close();
      reopened.close();
    }
  }
});

test("IPv6 literals with denied or unknown surface country can reach an allowed decoded country", async (t) => {
  for (const prefix of ["2001:abcd:1234::", "3001:1234::"]) {
    const f = fixture(t);
    f.network.discovery = [aaaa(`${prefix}c000:aa`), aaaa(`${prefix}c000:ab`)];
    const wire = `${prefix}808:808`;
    const records = [f.record(`https://[${wire}]/literal`), f.tunnel(wire)];
    assert.ok(f.prepare(records).items.every((item) => item.state === "ready"));
    const result = await f.run(records);
    assert.ok(result.items.every((item) => item.state === "reachable"));
    assert.ok(result.items.every((item) => item.scope.countryAddress === "8.8.8.8"));
    assert.deepEqual(
      f.calls.dns.map(({ hostname }) => hostname),
      ["ipv4only.arpa", "ipv4only.arpa"],
    );
    assert.deepEqual(
      f.calls.transport.map(({ endpoint }) => endpoint.address),
      [wire, wire],
    );
    assert.equal(f.calls.transport[1].endpoint.protocol, "tcp:");
  }
});

test("unknown discovery cannot allow surface-US IPv6, but keeps a permitted IPv4 alternative", async (t) => {
  for (const snapshot of [[], [a("8.8.8.8")], [aaaa("2001:4860::1")]]) {
    const f = fixture(t);
    f.network.discovery = snapshot;
    f.network.target = [aaaa(nativeUs)];
    const denied = await f.run([f.record("https://unknown.example.invalid/")]);
    assert.equal(denied.items[0].state, "denied");
    assert.deepEqual(denied.items[0].scope, {
      allowed: false,
      reason: "ipv6-unverified",
      country: null,
      address: nativeUs,
    });
    assert.equal(f.calls.transport.length, 0);
    f.network.target = [aaaa(nativeUs), a("8.8.8.8")];
    const allowed = await f.run([f.record("https://fallback.example.invalid/")]);
    assert.equal(allowed.items[0].state, "reachable");
    assert.equal(f.calls.transport[0].endpoint.address, "8.8.8.8");
    assert.equal(f.calls.transport[0].endpoint.hostname, "fallback.example.invalid");
    assert.equal(allowed.items[0].scope.countryAddress, undefined);
    assert.equal(f.calls.dns.filter(({ hostname }) => hostname === "ipv4only.arpa").length, 2);
  }
});

test("missing database denies discovery while original exact and derived exceptions need no discovery", async (t) => {
  const f = fixture(t, { available: false });
  const blocked = await f.run([
    f.record("https://missing.example.invalid/"),
    f.record(`https://[${wireUs}]/`),
  ]);
  assert.ok(blocked.items.every((item) => item.reason === "database-unavailable"));
  assert.deepEqual(f.calls, { dns: [], transport: [] });

  f.settings(["owned.example.invalid", wireCn, "::1"]);
  f.network.target = [aaaa(wireCn)];
  const exact = await f.run([
    f.record("https://owned.example.invalid/"),
    f.record(`https://[${wireCn}]/`),
    f.record("https://[::1]/"),
  ]);
  assert.ok(
    exact.items.every((item) => item.state === "reachable" && item.scope.reason === "exact-host"),
  );
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["owned.example.invalid"],
  );

  f.settings(["derived.example.invalid"]);
  await f.scope.refresh({
    hosts: ["derived.example.invalid"],
    revision: f.scope.status().revision,
    confirmed: true,
  });
  f.calls.dns.length = 0;
  const derived = await f.run([f.record(`https://[${wireCn}]/derived`)]);
  assert.equal(derived.items[0].state, "reachable");
  assert.equal(derived.items[0].scope.reason, "resolved-exception");
  assert.equal(f.calls.dns.length, 0);
});

test("ordinary IPv4 and exact loopback host exceptions keep their previous DNS path", async (t) => {
  const f = fixture(t);
  f.network.target = [a("8.8.8.8")];
  const result = await f.run([
    f.record("https://ipv4.example.invalid/"),
    f.record("https://8.8.8.8/"),
  ]);
  assert.ok(result.items.every((item) => item.state === "reachable"));
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["ipv4.example.invalid"],
  );
  f.settings(["loopback.example.invalid"]);
  f.network.target = [aaaa("::1")];
  await f.run([f.record("http://loopback.example.invalid/")]);
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["ipv4.example.invalid", "loopback.example.invalid"],
  );
});

test("IPv4-mapped IPv6 keeps intrinsic IPv4 classification without discovery or its timeout", async (t) => {
  const f = fixture(t);
  const mappedUs = "::ffff:808:808";
  f.network.target = [aaaa(mappedUs)];
  f.network.resolve = async (hostname) => {
    if (hostname === "ipv4only.arpa") throw dnsError("DNS_TIMEOUT");
    return f.network.target;
  };
  const mapped = await f.run([
    f.record("https://mapped.example.invalid/"),
    f.record(`https://[${mappedUs}]/literal`),
  ]);
  assert.ok(
    mapped.items.every((item) => item.state === "reachable" && item.scope.country === "US"),
  );
  assert.ok(mapped.items.every((item) => item.scope.countryAddress === undefined));
  assert.deepEqual(
    f.calls.transport.map(({ endpoint }) => endpoint.address),
    [mappedUs, mappedUs],
  );
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["mapped.example.invalid"],
  );

  f.network.target = [aaaa("::ffff:100:101"), a("8.8.8.8")];
  const mixed = await f.run([f.record("https://mapped-and-ipv4.example.invalid/")]);
  assert.equal(mixed.items[0].state, "reachable");
  assert.equal(mixed.items[0].transport.address, "8.8.8.8");
  assert.deepEqual(
    f.calls.dns.map(({ hostname }) => hostname),
    ["mapped.example.invalid", "mapped-and-ipv4.example.invalid"],
  );
});

test("an exception on decoded IPv4 never grants the original IPv6 or hostname target", async (t) => {
  for (const derived of [false, true]) {
    const f = fixture(t);
    if (derived) {
      f.settings(["registered.example.invalid"]);
      f.network.target = [a("1.0.1.1")];
      await f.scope.refresh({
        hosts: ["registered.example.invalid"],
        revision: f.scope.status().revision,
        confirmed: true,
      });
      assert.equal(f.scope.exception("1.0.1.1").reason, "resolved-exception");
    } else {
      f.settings(["1.0.1.1"]);
      assert.equal(f.scope.exception("1.0.1.1").reason, "exact-host");
    }
    f.calls.dns.length = 0;
    f.network.target = [aaaa(wireCn)];
    f.network.discovery = translated;
    const result = await f.run([
      f.record("https://unregistered.example.invalid/"),
      f.record(`https://[${wireCn}]/`),
    ]);
    assert.ok(result.items.every((item) => item.state === "denied" && item.scope.country === "CN"));
    assert.ok(result.items.every((item) => item.scope.countryAddress === "1.0.1.1"));
    assert.equal(f.calls.transport.length, 0);
    assert.equal(f.calls.dns.filter(({ hostname }) => hostname === "ipv4only.arpa").length, 2);
  }
});

test("discovery failures remain unknown, while timeout or cancellation cannot connect an IPv4 alternative", async (t) => {
  for (const code of ["DNS_ERROR", "DNS_TIMEOUT", "DNS_CANCELLED"]) {
    const f = fixture(t);
    f.network.resolve = async (hostname) => {
      if (hostname === "ipv4only.arpa") throw dnsError(code);
      return [aaaa(nativeUs), a("8.8.8.8")];
    };
    const result = await f.run([f.record("https://failure.example.invalid/")]);
    assert.equal(
      result.items[0].state,
      code === "DNS_ERROR" ? "reachable" : code === "DNS_TIMEOUT" ? "unreachable" : "cancelled",
    );
    assert.equal(f.calls.transport.length, code === "DNS_ERROR" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_DNS_DETAIL/);
    if (code === "DNS_ERROR") {
      f.network.resolve = async (hostname) => {
        if (hostname === "ipv4only.arpa") throw dnsError(code);
        return [aaaa(nativeUs)];
      };
      const unknown = await f.run([f.record("https://failure-only-ipv6.example.invalid/")]);
      assert.equal(unknown.items[0].reason, "ipv6-unverified");
    } else assert.equal(result.items[0].reason, code === "DNS_TIMEOUT" ? "timeout" : "cancelled");
  }
});

test("target DNS, discovery and transport share the remaining item budget and expired discovery never connects", async (t) => {
  const f = fixture(t);
  f.network.resolve = async (hostname) => {
    await delay(12);
    return hostname === "ipv4only.arpa" ? native : [aaaa(nativeUs)];
  };
  const result = await f.run([f.record("https://budget.example.invalid/")], { timeoutMs: 1000 });
  assert.equal(result.items[0].state, "reachable");
  const [target, discovery] = f.calls.dns;
  assert.equal(target.options.signal, discovery.options.signal);
  assert.equal(discovery.options.signal, f.calls.transport[0].options.signal);
  assert.ok(
    discovery.options.timeoutMs > 0 && discovery.options.timeoutMs < target.options.timeoutMs,
  );
  assert.ok(
    f.calls.transport[0].options.timeoutMs > 0 &&
      f.calls.transport[0].options.timeoutMs < discovery.options.timeoutMs,
  );

  const late = fixture(t);
  late.network.resolve = async (hostname) => {
    if (hostname === "ipv4only.arpa") {
      await delay(50);
      return native;
    }
    return [aaaa(nativeUs), a("8.8.8.8")];
  };
  const expired = await late.run([late.record("https://expired.example.invalid/")], {
    timeoutMs: 25,
  });
  assert.equal(expired.items[0].state, "unreachable");
  assert.equal(expired.items[0].reason, "timeout");
  assert.equal(late.calls.transport.length, 0);
});

test("stop aborts and drains discovery without a connection or successful receipt", async (t) => {
  const f = fixture(t);
  const entered = Promise.withResolvers();
  f.network.resolve = (hostname, { signal }) => {
    if (hostname !== "ipv4only.arpa") return [aaaa(nativeUs), a("8.8.8.8")];
    entered.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(dnsError("DNS_CANCELLED")), { once: true });
    });
  };
  const running = f.run([f.record("https://cancel.example.invalid/")]);
  await entered.promise;
  await f.checks.stop({ workspaceId: f.workspaceId });
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.items[0].state, "cancelled");
  assert.equal(result.items[0].reason, "cancelled");
  assert.equal(f.calls.transport.length, 0);
  assert.equal(f.checks.status({ workspaceId: f.workspaceId }).active, false);
});

test("scope, admission or record changes during discovery cancel without persisting old target results", async (t) => {
  for (const type of ["scope", "admission", "record"]) {
    const f = fixture(t);
    const entered = Promise.withResolvers();
    let release;
    f.network.resolve = (hostname, { signal }) => {
      if (hostname !== "ipv4only.arpa") return [aaaa(nativeUs)];
      return new Promise((resolve, reject) => {
        release = type === "scope" ? () => reject(dnsError("DNS_ERROR")) : () => resolve(native);
        signal.addEventListener("abort", () => reject(dnsError("DNS_CANCELLED")), { once: true });
        entered.resolve();
      });
    };
    const record = f.record("https://changed.example.invalid/");
    const running = f.run([record]);
    await entered.promise;
    if (type === "scope") f.load("2026-11");
    if (type === "admission") f.admission.revoke({ revision: f.admission.status().revision });
    if (type === "record") f.record("https://changed.example.invalid/new", { id: record.id });
    release();
    const result = await running;
    assert.equal(result.items[0].state, "cancelled");
    assert.equal(result.items[0].discardReason, `${type}-changed`);
    assert.equal(result.items[0].persisted, false);
    assert.equal(f.calls.transport.length, 0);
    assert.equal(f.checks.status({ workspaceId: f.workspaceId }).items[0].lastCheck, null);
  }
});

test("scope changes after target lookup or candidate classification prevent discovery or transport", async (t) => {
  for (const stage of ["target", "classification"]) {
    const f = fixture(t);
    if (stage === "target") {
      f.network.resolve = async () => {
        f.load("2026-11");
        return [aaaa(nativeUs)];
      };
    } else {
      const decide = f.scope.decide.bind(f.scope);
      f.scope.decide = (...args) => {
        const decision = decide(...args);
        f.load("2026-11");
        return decision;
      };
    }
    const result = await f.run([f.record("https://reclassified.example.invalid/")]);
    assert.equal(result.items[0].state, "cancelled");
    assert.equal(result.items[0].discardReason, "scope-changed");
    assert.equal(result.items[0].persisted, false);
    assert.equal(f.calls.transport.length, 0);
    assert.equal(f.calls.dns.length, stage === "target" ? 1 : 2);
  }
});

test("each batch entry discovers independently and persists the country address for its own snapshot", async (t) => {
  const f = fixture(t);
  let discoveries = 0;
  f.network.resolve = async (hostname) => {
    if (hostname !== "ipv4only.arpa") return [aaaa(wireCn)];
    discoveries++;
    return discoveries === 1 ? translated : discoveries === 2 ? native : [];
  };
  const records = [1, 2, 3].map((index) => f.record(`https://batch.example.invalid/${index}`));
  const result = await f.run(records);
  assert.deepEqual(
    result.items.map((item) => item.state),
    ["denied", "reachable", "denied"],
  );
  assert.deepEqual(
    result.items.map((item) => item.reason),
    ["country-denied", "http-response", "ipv6-unverified"],
  );
  assert.deepEqual(
    result.items.map((item) => item.scope.countryAddress),
    ["1.0.1.1", undefined, undefined],
  );
  assert.equal(discoveries, 3);
  assert.equal(f.calls.dns.length, 6);
  assert.equal(f.calls.transport.length, 1);
  const saved = new Map(
    f.checks
      .status({ workspaceId: f.workspaceId })
      .items.map((item) => [item.recordId, item.lastCheck]),
  );
  assert.ok(
    result.items.every((item) => item.persisted && saved.get(item.recordId).reason === item.reason),
  );
  assert.equal(saved.get(records[0].id).scope.countryAddress, "1.0.1.1");
  assert.equal(saved.get(records[1].id).scope.countryAddress, undefined);
});
