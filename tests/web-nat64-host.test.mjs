import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { CountryDatabase } from "../src/core/country-database.js";
import { NetworkScope } from "../src/core/network-scope.js";
import { WorkspaceStore } from "../src/core/store.js";
import { WebScope } from "../src/host/web-scope.js";
import { hostOnly, raw, webFixture } from "./helpers/web-runtime.mjs";

// Original synthetic address/country assignments. None of these addresses is contacted.
const CSV = [
  "1.0.1.0,1.0.1.255,CN",
  "8.8.8.0,8.8.8.255,US",
  "93.184.216.0,93.184.216.255,US",
  "240e:bbbb::,240e:bbbb:ffff:ffff:ffff:ffff:ffff:ffff,CN",
  "2606:aaaa::,2606:aaaa:ffff:ffff:ffff:ffff:ffff:ffff,US",
].join("\n");
const DISCOVERY = "ipv4only.arpa";
const NATIVE_US = "2606:aaaa:9999::42";
const SURFACE_US_IPV4_CN = "2606:aaaa:1111:1:2:3:100:101";
const SURFACE_CN_IPV4_US = "240e:bbbb:2222:1:2:3:808:808";
const SURFACE_US_PRIVATE = "2606:aaaa:1111:1:2:3:7f00:1";
const UNKNOWN_NATIVE = "2a00:5555:1111::1";
const aaaa = (address) => ({ address, family: 6 });
const A_ONLY = [
  { address: "192.0.0.170", family: 4 },
  { address: "192.0.0.171", family: 4 },
];
const PREFIX_US = [aaaa("2606:aaaa:1111:1:2:3:c000:aa"), aaaa("2606:aaaa:1111:1:2:3:c000:ab")];
const PREFIX_CN = [aaaa("240e:bbbb:2222:1:2:3:c000:aa"), aaaa("240e:bbbb:2222:1:2:3:c000:ab")];

function refused(result, code) {
  assert.equal(result.isError, true);
  assert.equal(result.error?.info?.code, code, result.error?.message);
}
function accepted(result, url) {
  assert.equal(result.isError, false, result.error?.message);
  assert.equal(result.value.statusCode, 200);
  assert.equal(result.value.url, url);
}
const mark = (f) => ({
  dns: f.dnsCalls.length,
  requests: f.requests.length,
  decisions: f.countryDecisions.length,
});
function lookups(f, before, expected) {
  assert.deepEqual(
    f.dnsCalls.slice(before.dns).map((item) => item.hostname),
    expected,
  );
  assert.deepEqual(f.forbidden, []);
}
function decision(f, before, wireAddress) {
  const found = f.countryDecisions
    .slice(before.decisions)
    .find((item) => item.wireAddress === wireAddress);
  assert.ok(found, "The real shared policy must evaluate the native wire address");
  assert.equal(
    found.result.address,
    wireAddress,
    "Country lookup must not replace the transport address",
  );
  return found;
}

async function fixture(t) {
  const f = await webFixture(t);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-web-nat64-")));
  const store = new WorkspaceStore(join(directory, "synthetic-workspace.sqlite"));
  const database = new CountryDatabase(directory);
  database.import({
    filename: "original-synthetic-country.csv",
    release: "2026-10",
    contentBase64: Buffer.from(CSV).toString("base64"),
    revision: database.status().revision,
  });
  const settings = (ownServers = []) => {
    const current = store.dispatch("settings.get", {});
    store.dispatch("settings.save", {
      revision: current.revision,
      value: { ...current.value, enabled: true, ownServers },
    });
  };
  settings();
  const scope = new NetworkScope(store, {
    database,
    resolve: async () => {
      throw new Error("Policy inventory refresh is outside this fixture");
    },
  });
  const countryDecisions = [];
  const decide = scope.decide.bind(scope);
  scope.decide = (target, wireAddress, options) => {
    const result = decide(target, wireAddress, options);
    countryDecisions.push({
      target,
      wireAddress,
      options,
      result,
      agent: raw(f.ctx.agents).currentInitiator(),
    });
    return result;
  };
  const adapter = new WebScope(f.ctx, store, f.api.host, { scope });
  t.after(async () => {
    await adapter.revert();
    await scope.close();
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const nativeResolver = f.native.resolveAddresses;
  await adapter.apply();
  assert.equal(adapter.capabilities()[0].state, "active");
  assert.equal(f.native.resolveAddresses, nativeResolver);
  const root = f.createAgent("synthetic-nat64-root");
  const child = f.createAgent("synthetic-nat64-child", root);
  return {
    ...f,
    store,
    database,
    scope,
    adapter,
    countryDecisions,
    settings,
    nativeResolver,
    root,
    child,
  };
}

test(
  "official HTTP NAT64 decisions use this call's discovery and retain the native IPv6 wire address",
  hostOnly,
  async (t) => {
    const f = await fixture(t);

    await t.test(
      "native AAAA with A-only discovery uses the IPv6 country, with no second discovery",
      async () => {
        const url = "https://native-v6.invalid/allow";
        f.reply(url);
        f.answers.set("native-v6.invalid", [aaaa(NATIVE_US)]);
        f.answers.set(DISCOVERY, A_ONLY);
        const before = mark(f);
        accepted(await f.invoke(f.root, url), url);
        const evaluated = decision(f, before, NATIVE_US);
        assert.equal(evaluated.result.country, "US");
        assert.equal(evaluated.result.allowed, true);
        assert.equal(evaluated.options?.ipv4Destination, undefined);
        assert.equal(f.requests.length, before.requests + 1);
        lookups(f, before, ["native-v6.invalid", DISCOVERY]);
      },
    );

    await t.test(
      "a discovered /96 NSP cannot use its US surface country to allow embedded CN",
      async () => {
        const url = "https://translated-cn.invalid/deny";
        f.reply(url);
        f.answers.set("translated-cn.invalid", [aaaa(SURFACE_US_IPV4_CN)]);
        f.answers.set(DISCOVERY, PREFIX_US);
        const before = mark(f);
        refused(await f.invoke(f.root, url), "WEB_SCOPE_DENIED");
        const evaluated = decision(f, before, SURFACE_US_IPV4_CN);
        assert.equal(evaluated.options.ipv4Destination, "1.0.1.1");
        assert.equal(evaluated.result.countryAddress, "1.0.1.1");
        assert.equal(evaluated.result.country, "CN");
        assert.equal(f.database.lookup(SURFACE_US_IPV4_CN).country, "US");
        assert.equal(f.requests.length, before.requests);
        lookups(f, before, ["translated-cn.invalid", DISCOVERY]);
      },
    );

    await t.test(
      "a discovered /96 NSP allows embedded US despite CN surface, without rewriting the URL",
      async () => {
        const url = "https://translated-us.invalid/allow";
        f.reply(url);
        f.answers.set("translated-us.invalid", [aaaa(SURFACE_CN_IPV4_US)]);
        f.answers.set(DISCOVERY, PREFIX_CN);
        const before = mark(f);
        accepted(await f.invoke(f.child, url), url);
        const evaluated = decision(f, before, SURFACE_CN_IPV4_US);
        assert.equal(evaluated.options.ipv4Destination, "8.8.8.8");
        assert.equal(evaluated.result.countryAddress, "8.8.8.8");
        assert.equal(evaluated.result.country, "US");
        assert.equal(f.database.lookup(SURFACE_CN_IPV4_US).country, "CN");
        assert.equal(f.requests.at(-1).origin, new URL(url).origin);
        assert.equal(f.requests.length, before.requests + 1);
        lookups(f, before, ["translated-us.invalid", DISCOVERY]);
      },
    );

    await t.test(
      "an IPv6 literal with CN surface and translated US is allowed after only one discovery lookup",
      async () => {
        const url = `https://[${SURFACE_CN_IPV4_US}]/literal`;
        f.reply(url);
        f.answers.set(DISCOVERY, PREFIX_CN);
        const before = mark(f);
        accepted(await f.invoke(f.root, url), url);
        const evaluated = decision(f, before, SURFACE_CN_IPV4_US);
        assert.equal(evaluated.result.countryAddress, "8.8.8.8");
        assert.equal(evaluated.result.country, "US");
        assert.equal(f.requests.at(-1).origin, `https://[${SURFACE_CN_IPV4_US}]`);
        assert.equal(f.requests.length, before.requests + 1);
        lookups(f, before, [DISCOVERY]);
      },
    );

    await t.test(
      "an exact host exception still cannot override native rejection of a private embedded destination",
      async () => {
        const url = "https://private-embedded.invalid/deny";
        f.settings(["private-embedded.invalid"]);
        f.reply(url);
        f.answers.set("private-embedded.invalid", [aaaa(SURFACE_US_PRIVATE)]);
        f.answers.set(DISCOVERY, PREFIX_US);
        const before = mark(f);
        try {
          refused(await f.invoke(f.child, url), "WEB_BLOCKED_URL");
          assert.equal(
            f.countryDecisions.length,
            before.decisions,
            "Native rejection precedes the shared policy",
          );
          assert.equal(f.requests.length, before.requests);
          lookups(f, before, ["private-embedded.invalid", DISCOVERY]);
        } finally {
          f.settings();
        }
      },
    );

    for (const [name, answer, expectedCode] of [
      ["empty", [], "WEB_SCOPE_IPV6_UNVERIFIED"],
      ["malformed", [{ address: "synthetic-invalid-ip", family: 6 }], "WEB_SCOPE_IPV6_UNVERIFIED"],
      [
        "failure",
        () => {
          throw Object.assign(new Error("Synthetic discovery failure"), { code: "EAI_AGAIN" });
        },
        "WEB_PROVIDER_ERROR",
      ],
    ])
      await t.test(
        `${name} discovery refuses IPv6 before transport and does not retry discovery`,
        async () => {
          const hostname = `discovery-${name}.invalid`;
          const url = `https://${hostname}/deny`;
          f.reply(url);
          f.answers.set(hostname, [aaaa(NATIVE_US)]);
          f.answers.set(DISCOVERY, answer);
          const before = mark(f);
          refused(await f.invoke(f.root, url), expectedCode);
          assert.equal(f.requests.length, before.requests);
          lookups(f, before, [hostname, DISCOVERY]);
        },
      );

    await t.test(
      "mixed DNS skips an unknown IPv6 country and selects the allowed IPv4",
      async () => {
        const url = "https://mixed-native.invalid/allow";
        f.reply(url);
        f.answers.set("mixed-native.invalid", [
          aaaa(UNKNOWN_NATIVE),
          { address: "8.8.8.8", family: 4 },
        ]);
        f.answers.set(DISCOVERY, A_ONLY);
        const before = mark(f);
        accepted(await f.invoke(f.child, url), url);
        assert.equal(decision(f, before, UNKNOWN_NATIVE).result.allowed, false);
        assert.equal(decision(f, before, "8.8.8.8").result.allowed, true);
        assert.equal(f.requests.length, before.requests + 1);
        lookups(f, before, ["mixed-native.invalid", DISCOVERY]);
      },
    );

    await t.test(
      "concurrent main/child discovery responses with different prefixes cannot bleed",
      async () => {
        const rootUrl = "https://main-discovery.invalid/deny";
        const childUrl = "https://child-discovery.invalid/allow";
        f.reply(rootUrl);
        f.reply(childUrl);
        for (const hostname of ["main-discovery.invalid", "child-discovery.invalid"])
          f.answers.set(hostname, [aaaa(SURFACE_US_IPV4_CN)]);
        const entered = new Map([
          [f.root, Promise.withResolvers()],
          [f.child, Promise.withResolvers()],
        ]);
        const release = new Map([
          [f.root, Promise.withResolvers()],
          [f.child, Promise.withResolvers()],
        ]);
        f.answers.set(DISCOVERY, () => {
          const agent = raw(f.ctx.agents).currentInitiator();
          assert.ok(release.has(agent));
          entered.get(agent).resolve();
          return release.get(agent).promise;
        });
        const before = mark(f);
        const rootPending = f.invoke(f.root, rootUrl);
        const childPending = f.invoke(f.child, childUrl);
        await Promise.all([...entered.values()].map((item) => item.promise));
        release.get(f.child).resolve(PREFIX_CN);
        accepted(await childPending, childUrl);
        release.get(f.root).resolve(PREFIX_US);
        refused(await rootPending, "WEB_SCOPE_DENIED");
        const records = f.countryDecisions.slice(before.decisions);
        const rootDecision = records.find((item) => item.agent === f.root);
        const childDecision = records.find((item) => item.agent === f.child);
        assert.equal(rootDecision.result.countryAddress, "1.0.1.1");
        assert.equal(rootDecision.result.country, "CN");
        assert.equal(childDecision.options?.ipv4Destination, undefined);
        assert.equal(childDecision.result.country, "US");
        for (const [agent, hostname] of [
          [f.root, "main-discovery.invalid"],
          [f.child, "child-discovery.invalid"],
        ])
          assert.deepEqual(
            f.dnsCalls
              .slice(before.dns)
              .filter((item) => item.agent === agent)
              .map((item) => item.hostname),
            [hostname, DISCOVERY],
          );
        assert.equal(f.requests.length, before.requests + 1);
        assert.equal(f.requests.at(-1).agent, f.child);
        assert.deepEqual(f.forbidden, []);
      },
    );

    await t.test(
      "two same-origin redirects use each hop's discovery, and the denied third hop never dispatches",
      async () => {
        const hostname = "hop-discovery.invalid";
        const base = `https://${hostname}`;
        f.reply(base + "/start", { statusCode: 302, headers: { location: "/middle" } });
        f.reply(base + "/middle", { statusCode: 302, headers: { location: "/finish" } });
        f.reply(base + "/finish");
        const targets = [NATIVE_US, SURFACE_CN_IPV4_US, SURFACE_US_IPV4_CN];
        const discoveries = [A_ONLY, PREFIX_CN, PREFIX_US];
        let targetCalls = 0;
        let discoveryCalls = 0;
        f.answers.set(hostname, () => [aaaa(targets[targetCalls++])]);
        f.answers.set(DISCOVERY, () => discoveries[discoveryCalls++]);
        const before = mark(f);
        refused(await f.invoke(f.root, base + "/start"), "WEB_SCOPE_DENIED");
        assert.equal(targetCalls, 3);
        assert.equal(discoveryCalls, 3);
        assert.deepEqual(
          f.requests.slice(before.requests).map((item) => item.path),
          ["/start", "/middle"],
        );
        assert.deepEqual(
          f.countryDecisions
            .slice(before.decisions)
            .map((item) => [item.result.address, item.result.country]),
          [
            [NATIVE_US, "US"],
            [SURFACE_CN_IPV4_US, "US"],
            [SURFACE_US_IPV4_CN, "CN"],
          ],
        );
        lookups(f, before, [hostname, DISCOVERY, hostname, DISCOVERY, hostname, DISCOVERY]);
      },
    );

    await t.test("scope changes while the native discovery waits prevent dispatch", async () => {
      const hostname = "revision-discovery.invalid";
      const url = `https://${hostname}/deny`;
      f.reply(url);
      f.answers.set(hostname, [aaaa(NATIVE_US)]);
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      f.answers.set(DISCOVERY, () => {
        entered.resolve();
        return release.promise;
      });
      const before = mark(f);
      const pending = f.invoke(f.child, url);
      await entered.promise;
      f.settings(["revision-only.invalid"]);
      release.resolve(A_ONLY);
      refused(await pending, "WEB_SCOPE_CHANGED");
      assert.equal(f.requests.length, before.requests);
      lookups(f, before, [hostname, DISCOVERY]);
      f.settings();
    });

    await t.test(
      "cancellation while native discovery waits makes no request and no second discovery",
      async () => {
        const hostname = "cancel-discovery.invalid";
        const url = `https://${hostname}/deny`;
        f.reply(url);
        f.answers.set(hostname, [aaaa(NATIVE_US)]);
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        f.answers.set(DISCOVERY, () => {
          entered.resolve();
          return release.promise;
        });
        const before = mark(f);
        const control = new AbortController();
        const pending = f.invoke(f.root, url, { signal: control.signal });
        await entered.promise;
        control.abort();
        refused(await pending, "WEB_ABORTED");
        release.resolve(A_ONLY);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(f.requests.length, before.requests);
        lookups(f, before, [hostname, DISCOVERY]);
      },
    );

    await t.test(
      "the real connector's fixed lookup exposes the original IPv6 before a synthetic pre-socket stop",
      async () => {
        const hostname = "pin-discovery.invalid";
        const url = `https://${hostname}/pin`;
        f.answers.set(hostname, [aaaa(SURFACE_CN_IPV4_US)]);
        f.answers.set(DISCOVERY, PREFIX_CN);
        const prototype = f.api.undici.Agent.prototype;
        const mockDispatch = Object.getOwnPropertyDescriptor(prototype, "dispatch");
        const nativeDispatch = Object.getPrototypeOf(prototype).dispatch;
        const originalConnect = tls.connect;
        const pins = [];
        const before = mark(f);
        assert.equal(typeof nativeDispatch, "function");
        Object.defineProperty(prototype, "dispatch", { ...mockDispatch, value: nativeDispatch });
        tls.connect = function (options) {
          const pinned = {
            hostname: options.host,
            servername: options.servername,
            addresses: null,
          };
          pins.push(pinned);
          assert.equal(typeof options.lookup, "function");
          options.lookup(hostname, { all: true, family: 6 }, (failure, addresses) => {
            assert.ifError(failure);
            pinned.addresses = addresses;
          });
          throw new Error("Synthetic stop before creating any TLS socket");
        };
        syncBuiltinESMExports();
        try {
          refused(await f.invoke(f.child, url), "WEB_PROVIDER_ERROR");
          assert.deepEqual(pins, [
            {
              hostname,
              servername: hostname,
              addresses: [{ address: SURFACE_CN_IPV4_US, family: 6 }],
            },
          ]);
          assert.equal(
            f.requests.length,
            before.requests,
            "Connector probing must not use a mock or real transport",
          );
          assert.equal(decision(f, before, SURFACE_CN_IPV4_US).result.countryAddress, "8.8.8.8");
          lookups(f, before, [hostname, DISCOVERY]);
        } finally {
          tls.connect = originalConnect;
          Object.defineProperty(prototype, "dispatch", mockDispatch);
          syncBuiltinESMExports();
        }
      },
    );

    assert.equal(
      f.native.resolveAddresses,
      f.nativeResolver,
      "The production native resolver identity remains intact",
    );
    assert.equal(
      f.dnsCalls.length,
      33,
      "16 synthetic target resolutions plus 17 native discovery resolutions only",
    );
    assert.equal(f.dnsCalls.filter((item) => item.hostname === DISCOVERY).length, 17);
    assert.equal(f.requests.length, 7, "Only the seven permitted mock HTTP hops dispatch");
    assert.deepEqual(f.forbidden, []);
  },
);
