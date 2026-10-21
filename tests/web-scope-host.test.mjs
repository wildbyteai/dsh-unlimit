import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { WebScope } from "../src/host/web-scope.js";
import { fetchScopedHttp } from "../src/host/scoped-http.js";
import { WorkspaceStore } from "../src/core/store.js";
import { CountryDatabase } from "../src/core/country-database.js";
import { NetworkScope } from "../src/core/network-scope.js";
import { hostOnly, loadWebRuntime, raw, webFixture } from "./helpers/web-runtime.mjs";

function error(result, code, message) {
  assert.equal(result.isError, true);
  if (code) assert.equal(result.error?.info?.code, code, result.error?.message);
  if (message) assert.match(result.error?.message ?? "", message);
}

test(
  "official main and child HTTP tools share the actual local country and exception policy",
  hostOnly,
  async (t) => {
    const f = await webFixture(t);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-web-policy-")));
    const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
    const database = new CountryDatabase(root);
    const scope = new NetworkScope(store, {
      database,
      resolve: async () => [{ address: "1.0.1.1", family: 4 }],
    });
    const adapter = new WebScope(f.ctx, store, f.api.host, { scope });
    t.after(async () => {
      await adapter.revert();
      await scope.close();
      database.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const save = (ownServers) => {
      const current = store.dispatch("settings.get", {});
      store.dispatch("settings.save", {
        revision: current.revision,
        value: { ...current.value, enabled: true, ownServers },
      });
    };
    save([]);
    database.import({
      filename: "synthetic.csv",
      release: "2026-10",
      revision: "empty",
      contentBase64: Buffer.from(
        "1.0.1.0,1.0.1.255,CN\n1.0.2.0,1.0.2.255,HK\n1.0.3.0,1.0.3.255,MO\n8.8.8.0,8.8.8.255,US\n",
      ).toString("base64"),
    });
    const main = f.createAgent("synthetic-database-main");
    const child = f.createAgent("synthetic-database-child", main);
    await adapter.apply();

    await t.test(
      "restricted countries and unknown addresses are denied through both actual tools",
      async () => {
        const before = f.requests.length;
        for (const [hostname, address, agent] of [
          ["cn.invalid", "1.0.1.1", main],
          ["hk.invalid", "1.0.2.1", child],
          ["mo.invalid", "1.0.3.1", main],
          ["unknown.invalid", "9.9.9.9", child],
        ]) {
          f.answers.set(hostname, [{ address, family: 4 }]);
          error(await f.invoke(agent, `https://${hostname}/`), "WEB_SCOPE_DENIED");
        }
        assert.equal(f.requests.length, before);
      },
    );

    await t.test(
      "mixed public DNS uses the shared country policy and an allowed alternative",
      async () => {
        f.reply("https://mixed-region.invalid/");
        f.answers.set("mixed-region.invalid", [
          { address: "1.0.1.1", family: 4 },
          { address: "8.8.8.8", family: 4 },
        ]);
        const before = f.requests.length;
        const result = await f.invoke(child, "https://mixed-region.invalid/");
        assert.equal(result.isError, false, result.error?.message);
        assert.equal(f.requests.length, before + 1);
      },
    );

    await t.test(
      "exact and saved derived IP exceptions work while a same-address alias remains denied",
      async () => {
        save(["owned.invalid"]);
        const refreshed = await scope.refresh({
          hosts: ["owned.invalid"],
          revision: scope.status().revision,
          confirmed: true,
        });
        assert.equal(refreshed.items[0].persisted, true);
        for (const [url, agent] of [
          ["https://owned.invalid/", main],
          ["https://1.0.1.1/", child],
        ]) {
          f.reply(url);
          f.answers.set(new URL(url).hostname, [{ address: "1.0.1.1", family: 4 }]);
          const result = await f.invoke(agent, url);
          assert.equal(result.isError, false, result.error?.message);
        }
        const before = f.requests.length;
        f.answers.set("alias.invalid", [{ address: "1.0.1.1", family: 4 }]);
        error(await f.invoke(child, "https://alias.invalid/"), "WEB_SCOPE_DENIED");
        assert.equal(f.requests.length, before);
      },
    );
  },
);

test(
  "existing official web_fetch enforces Agent scope without replacing native policy",
  hostOnly,
  async (t) => {
    const f = await webFixture(t);
    const adapter = new WebScope(f.ctx, f.store, f.api.host, { scope: f.scope });
    t.after(() => adapter.revert());
    const nativeResolve = f.native.resolveAddresses;
    const root = f.createAgent("synthetic-web-root");
    const child = f.createAgent("synthetic-web-child", root);
    const other = f.createAgent("synthetic-web-other");
    const policy = f.scope.decide;
    assert.equal(adapter.capabilities()[0].state, "available");
    await adapter.apply();
    await adapter.apply();
    assert.equal(adapter.capabilities()[0].state, "active");

    await t.test(
      "main, child and concurrent callers retain exact active identity and the existing tool",
      async () => {
        const plans = [
          [root, "https://fixture.invalid/main"],
          [child, "https://fixture.invalid/child"],
          [other, "https://fixture.invalid/other"],
        ];
        for (const [, url] of plans) f.reply(url);
        const results = await Promise.all(plans.map(([agent, url]) => f.invoke(agent, url)));
        for (const [index, result] of results.entries()) {
          assert.equal(result.isError, false, result.error?.message);
          assert.equal(result.value.url, plans[index][1]);
          assert.equal(result.value.statusCode, 200);
        }
        for (const [agent, url] of plans) {
          const request = f.requests.find((item) => item.path === new URL(url).pathname);
          assert.equal(request.agent, agent);
        }
        assert.deepEqual(
          new Set(f.decisions.map((item) => item.agent)),
          new Set([root, child, other]),
        );
        assert.equal(
          f.native.resolveAddresses,
          nativeResolve,
          "Concurrent calls never swap the native resolver",
        );
        assert.deepEqual([...f.ctx.tools.view(root).visible.keys()], ["web_fetch"]);
        assert.ok(f.actions.every((action) => action === "settings.get"));
      },
    );

    await t.test(
      "missing, mismatched, cloned and agentless-call contexts fail before DNS",
      async () => {
        const before = [f.dnsCalls.length, f.requests.length];
        error(
          await f.invoke(root, "https://identity.invalid/", { initiator: null }),
          "WEB_SCOPE_CONTEXT",
        );
        error(
          await f.invoke(root, "https://identity.invalid/", { initiator: other }),
          "WEB_SCOPE_CONTEXT",
        );
        error(await f.invoke({ ...root }, "https://identity.invalid/"), "WEB_SCOPE_CONTEXT");
        await assert.rejects(
          f.ctx.agents.withInitiator(root, () =>
            f.ctx.web.fetch({ url: "https://identity.invalid/" }),
          ),
          (failure) => failure.code === "WEB_SCOPE_CONTEXT",
        );
        assert.deepEqual([f.dnsCalls.length, f.requests.length], before);
      },
    );

    await t.test(
      "native monotonic guard, pre-denial and both cancellation gates remain authoritative",
      async () => {
        const before = [f.dnsCalls.length, f.requests.length, f.decisions.length];
        const guard = f.ctx.tools.guard(() => "Synthetic native guard refusal");
        try {
          error(await f.invoke(root, "https://guard.invalid/"), undefined, /native guard refusal/);
        } finally {
          guard();
        }
        const deny = f.ctx.on("tools/pre-execute", () => ({
          kind: "deny",
          reason: "Synthetic owner refusal",
        }));
        try {
          error(await f.invoke(root, "https://deny.invalid/"), undefined, /owner refusal/);
        } finally {
          deny();
        }
        const cancel = f.ctx.on("tools/pre-execute", () => ({ kind: "cancel" }));
        try {
          error(await f.invoke(root, "https://cancel.invalid/"), "ABORTED_BEFORE_DISPATCH");
        } finally {
          cancel();
        }
        const control = new AbortController();
        control.abort();
        error(
          await f.invoke(root, "https://aborted.invalid/", { signal: control.signal }),
          "ABORTED_BEFORE_DISPATCH",
        );
        assert.deepEqual([f.dnsCalls.length, f.requests.length, f.decisions.length], before);
      },
    );

    await t.test(
      "exact exceptions cannot weaken native private-literal or mixed-answer rejection",
      async () => {
        const before = [f.requests.length, f.decisions.length];
        f.scope.decide = (_hostname, address) => ({ allowed: true, reason: "exact-host", address });
        try {
          const dnsBefore = f.dnsCalls.length;
          error(await f.invoke(root, "http://127.0.0.1:9/private"), "WEB_BLOCKED_URL");
          assert.equal(f.dnsCalls.length, dnsBefore);
          f.answers.set("mixed.invalid", [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ]);
          error(await f.invoke(child, "https://mixed.invalid/"), "WEB_BLOCKED_URL");
          assert.deepEqual([f.requests.length, f.decisions.length], before);
        } finally {
          f.scope.decide = policy;
        }
      },
    );

    await t.test("country-denied and IPv6-unverified targets do not reach transport", async () => {
      const before = f.requests.length;
      f.answers.set("region.invalid", [{ address: "93.184.216.34", family: 4 }]);
      f.scope.decide = (_hostname, address) => ({
        allowed: false,
        reason: "country-denied",
        country: "CN",
        address,
      });
      error(await f.invoke(root, "https://region.invalid/"), "WEB_SCOPE_DENIED");
      f.scope.decide = policy;
      f.answers.set("ipv6.invalid", [{ address: "2606:4700::1111", family: 6 }]);
      f.answers.set("ipv4only.arpa", []);
      error(await f.invoke(child, "https://ipv6.invalid/"), "WEB_SCOPE_IPV6_UNVERIFIED");
      assert.equal(f.requests.length, before);
      assert.ok(
        f.dnsCalls.some((item) => item.hostname === "ipv4only.arpa"),
        "Native DNS64 check is preserved",
      );
    });

    await t.test(
      "remote provider remains uncalled and native missing-provider errors survive",
      async () => {
        let remoteCalls = 0;
        const remove = f.ctx.web.registerFetchProvider({
          id: "synthetic-remote",
          available: () => true,
          fetch() {
            remoteCalls++;
            throw new Error("Remote provider must never be called");
          },
        });
        const before = [f.dnsCalls.length, f.requests.length];
        try {
          f.setProvider("synthetic-remote");
          error(await f.invoke(root, "https://remote.invalid/"), "WEB_SCOPE_PROVIDER_UNSUPPORTED");
          f.setProvider("synthetic-missing");
          error(
            await f.invoke(child, "https://missing.invalid/"),
            "WEB_PROVIDER_CONFIGURED_MISSING",
          );
          assert.equal(remoteCalls, 0);
          assert.deepEqual([f.dnsCalls.length, f.requests.length], before);
        } finally {
          f.setProvider("http");
          remove();
        }
      },
    );

    await t.test(
      "official installed proxy route is refused before target DNS and dispatch, then restored",
      async () => {
        const url = new URL("https://proxy-route.invalid/synthetic");
        const previousRoute = f.api.proxy.proxyRouteFor(url);
        const previousDispatcher = f.api.undici.getGlobalDispatcher();
        assert.deepEqual(previousRoute, { proxied: false });
        const before = [f.dnsCalls.length, f.requests.length, f.forbidden.length];
        const diagnostics = [];
        const restore = await f.api.proxy.installProxyFromEnvironment(
          new Map([
            ["HTTP_PROXY", { value: "http://127.0.0.1:9" }],
            ["HTTPS_PROXY", { value: "http://127.0.0.1:9" }],
            ["NO_PROXY", { value: "" }],
          ]),
          (message) => diagnostics.push(message),
        );
        try {
          const route = f.api.proxy.proxyRouteFor(url);
          assert.equal(route.proxied, true);
          assert.equal(route.proxy, "http://127.0.0.1:9");
          assert.notEqual(f.api.undici.getGlobalDispatcher(), previousDispatcher);
          error(await f.invoke(root, url.href), "WEB_SCOPE_PROXY_UNSUPPORTED");
          assert.deepEqual([f.dnsCalls.length, f.requests.length, f.forbidden.length], before);
          assert.deepEqual(diagnostics, []);
        } finally {
          await restore();
        }
        assert.deepEqual(f.api.proxy.proxyRouteFor(url), previousRoute);
        assert.equal(f.api.undici.getGlobalDispatcher(), previousDispatcher);
        assert.deepEqual([f.dnsCalls.length, f.requests.length, f.forbidden.length], before);
      },
    );

    await t.test(
      "scope revision changes during native DNS refuse the evaluated request",
      async () => {
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const before = f.requests.length;
        f.answers.set("revision.invalid", () => {
          entered.resolve();
          return release.promise;
        });
        const pending = f.invoke(root, "https://revision.invalid/");
        await entered.promise;
        f.scope.revision = "synthetic-scope-2";
        release.resolve([{ address: "93.184.216.34", family: 4 }]);
        error(await pending, "WEB_SCOPE_CHANGED");
        assert.equal(f.requests.length, before);
      },
    );

    await t.test("stopAll drains a pending native DNS call without dispatching it", async () => {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const before = f.requests.length;
      f.answers.set("stop.invalid", () => {
        entered.resolve();
        return release.promise;
      });
      const pending = f.invoke(child, "https://stop.invalid/");
      await entered.promise;
      assert.deepEqual(await adapter.stopAll(), { stopped: true });
      release.resolve([{ address: "93.184.216.34", family: 4 }]);
      error(await pending, "WEB_ABORTED");
      assert.equal(f.requests.length, before);
    });

    await t.test(
      "ownership changes deny before dispatch, and revert preserves a newer owner",
      async () => {
        const before = [f.dnsCalls.length, f.requests.length];
        const originalOnce = f.native.requestOnce;
        f.native.requestOnce = async () => {
          throw new Error("Foreign requestOnce must remain uncalled");
        };
        error(await f.invoke(root, "https://ownership.invalid/"), "WEB_SCOPE_OWNERSHIP");
        assert.equal(adapter.capabilities()[0].state, "unsupported");
        assert.deepEqual([f.dnsCalls.length, f.requests.length], before);
        delete f.native.requestOnce;
        assert.equal(f.native.requestOnce, originalOnce);
        const newer = async () => ({ synthetic: "new-owner" });
        Object.defineProperty(raw(f.ctx.web), "fetch", {
          configurable: true,
          writable: true,
          value: newer,
        });
        await assert.rejects(adapter.revert(), (failure) => failure.code === "CONFLICT");
        assert.equal(raw(f.ctx.web).fetch, newer);
        delete raw(f.ctx.web).fetch;
        assert.equal(Object.hasOwn(f.native, "fetch"), false);
      },
    );

    await t.test(
      "descriptor-only external changes remain owned by the external writer during revert",
      async () => {
        await adapter.apply();
        const web = raw(f.ctx.web);
        const descriptor = Object.getOwnPropertyDescriptor(web, "fetch");
        Object.defineProperty(web, "fetch", { ...descriptor, writable: false });
        const external = Object.getOwnPropertyDescriptor(web, "fetch");
        const before = [f.dnsCalls.length, f.requests.length];
        error(await f.invoke(root, "https://descriptor.invalid/"), "WEB_SCOPE_OWNERSHIP");
        await assert.rejects(adapter.revert(), { code: "CONFLICT" });
        assert.deepEqual(Object.getOwnPropertyDescriptor(web, "fetch"), external);
        assert.equal(
          Object.hasOwn(f.native, "fetch"),
          false,
          "independent restoration still completes",
        );
        assert.deepEqual([f.dnsCalls.length, f.requests.length], before);
        delete web.fetch;
      },
    );

    await t.test(
      "the production gate refuses a fixture resolver rather than accepting a testing bypass",
      async () => {
        const resolver = f.native.resolveAddresses;
        f.native.resolveAddresses = async () => [{ address: "127.0.0.1", family: 4 }];
        try {
          await assert.rejects(
            adapter.apply(),
            (failure) => failure.code === "UNSUPPORTED_CAPABILITY",
          );
        } finally {
          f.native.resolveAddresses = resolver;
        }
        await adapter.apply();
        await adapter.revert();
        assert.equal(adapter.capabilities()[0].state, "available");
      },
    );
  },
);

test(
  "isolated scoped HTTP composition pins only a loopback fixture and preserves Host and hop boundaries",
  hostOnly,
  async (t) => {
    const api = await loadWebRuntime(t);
    const seen = [];
    const hold = Promise.withResolvers();
    const holdClosed = Promise.withResolvers();
    const server = http.createServer((request, response) => {
      seen.push({
        path: request.url,
        host: request.headers.host,
        address: request.socket.remoteAddress,
      });
      if (request.url === "/redirect") response.writeHead(302, { location: "/ok" }).end();
      else if (request.url === "/cross")
        response.writeHead(302, { location: "http://other.invalid/" }).end();
      else if (request.url === "/hold") {
        response.once("close", () => holdClosed.resolve());
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("synthetic partial body");
        hold.resolve();
      } else
        response.writeHead(200, { "content-type": "text/plain" }).end("synthetic loopback body");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = `http://fixture.invalid:${server.address().port}`;
    const dnsCalls = [];
    const lookup = dns.lookup;
    const lookupPromise = dnsPromises.lookup;
    const connect = net.connect;
    dns.lookup = dnsPromises.lookup = () => {
      dnsCalls.push("unexpected real resolution");
      throw new Error("Loopback fixture must use only the pinned lookup");
    };
    net.connect = function (options, ...rest) {
      assert.equal(typeof options.lookup, "function", "Transport must supply its fixed lookup");
      const pinned = options.lookup;
      return connect.call(
        this,
        {
          ...options,
          lookup(hostname, lookupOptions, callback) {
            return pinned(hostname, lookupOptions, (failure, address, family) => {
              if (failure) return callback(failure);
              const addresses = Array.isArray(address)
                ? address.map((item) => item.address)
                : [address];
              assert.deepEqual(
                addresses,
                ["127.0.0.1"],
                "Only the evaluated loopback address may connect",
              );
              callback(null, address, family);
            });
          },
        },
        ...rest,
      );
    };
    syncBuiltinESMExports();
    t.after(() => {
      dns.lookup = lookup;
      dnsPromises.lookup = lookupPromise;
      net.connect = connect;
      syncBuiltinESMExports();
    });
    const native = {
      limits: {
        maxResponseBytes: 4096,
        maxBodyChars: 4096,
        timeoutMs: 1000,
        maxRedirects: 3,
        userAgent: "synthetic-loopback-fixture",
      },
      async resolveAddresses() {
        return [
          { address: "192.0.2.4", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ];
      },
    };
    const scope = {
      preview: () => ({ state: "ready" }),
      decide: (_hostname, address) => ({
        allowed: address === "127.0.0.1",
        reason: "exact-host",
        address,
      }),
    };
    const options = {
      HttpFetchProvider: api.httpFetch.HttpFetchProvider,
      native,
      scope,
      proxyRouteFor: () => ({ proxied: false }),
      guard() {},
      WebError: api.web.WebError,
    };
    const invoke = (path, signal) => fetchScopedHttp(options, { url: base + path }, signal);

    await t.test("real request uses the selected IP while retaining URL Host", async () => {
      const value = await invoke("/ok");
      assert.equal(value.statusCode, 200);
      assert.equal(value.body.content, "synthetic loopback body");
      assert.deepEqual(seen.at(-1), {
        path: "/ok",
        host: `fixture.invalid:${server.address().port}`,
        address: "127.0.0.1",
      });
      assert.deepEqual(dnsCalls, []);
    });
    await t.test(
      "same-origin redirect is re-evaluated and cross-origin is not contacted",
      async () => {
        const original = native.resolveAddresses;
        let resolutions = 0;
        native.resolveAddresses = async (...args) => {
          resolutions++;
          return original(...args);
        };
        assert.equal((await invoke("/redirect")).statusCode, 200);
        assert.equal(resolutions, 2);
        const before = seen.length;
        await assert.rejects(
          invoke("/cross"),
          (failure) => failure.code === "WEB_REDIRECT_BLOCKED",
        );
        assert.equal(seen.length, before + 1);
        native.resolveAddresses = original;
      },
    );
    await t.test("second-hop scope denial makes zero second-hop connections", async () => {
      const original = native.resolveAddresses;
      let resolutions = 0;
      native.resolveAddresses = async () =>
        ++resolutions === 1
          ? [{ address: "127.0.0.1", family: 4 }]
          : [{ address: "192.0.2.4", family: 4 }];
      const before = seen.length;
      await assert.rejects(invoke("/redirect"), (failure) => failure.code === "WEB_SCOPE_DENIED");
      assert.equal(seen.length, before + 1);
      native.resolveAddresses = original;
    });
    await t.test("a proxied route is refused before resolution or connection", async () => {
      const before = seen.length;
      let resolutions = 0;
      await assert.rejects(
        fetchScopedHttp(
          {
            ...options,
            native: {
              ...native,
              async resolveAddresses() {
                resolutions++;
                return [{ address: "127.0.0.1", family: 4 }];
              },
            },
            proxyRouteFor: () => ({ proxied: true }),
          },
          { url: base + "/proxy" },
        ),
        (failure) => failure.code === "WEB_SCOPE_PROXY_UNSUPPORTED",
      );
      assert.equal(resolutions, 0);
      assert.equal(seen.length, before);
    });
    await t.test("abort during a live response drains the owned HTTP request", async () => {
      const control = new AbortController();
      const pending = invoke("/hold", control.signal);
      await hold.promise;
      control.abort();
      await assert.rejects(pending, (failure) => failure.code === "WEB_ABORTED");
      await holdClosed.promise;
      assert.deepEqual(dnsCalls, []);
    });
  },
);
