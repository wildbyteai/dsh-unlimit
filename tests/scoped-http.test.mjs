import test from "node:test";
import assert from "node:assert/strict";
import { fetchScopedHttp } from "../src/host/scoped-http.js";

class FakeWebError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const address = (value, family = 4) => ({ address: value, family });
const allowed = (reason = "country-allowed") => ({ allowed: true, reason });
const denied = (reason = "country-denied") => ({ allowed: false, reason });

/** An original in-memory provider double. It records the actual transport
 * boundary, accepts a supplied resolver and follows only synthetic responses.
 * It never imports a host runtime, creates sockets, or performs DNS.
 */
function fixture({
  resolve = async () => [address("8.8.8.8")],
  preview = () => ({ state: "ready" }),
  decide = () => allowed(),
  route = () => ({ proxied: false }),
  guard = () => {},
  transport = async (url) => ({ status: 200, body: "synthetic response", url: url.href }),
} = {}) {
  const observations = {
    instances: [],
    resolutions: [],
    previews: [],
    decisions: [],
    transports: [],
  };
  class FakeHttpFetchProvider {
    constructor(limits, resolver) {
      this.limits = limits;
      this.resolveAddresses = resolver;
      observations.instances.push(this);
    }
    async requestOnce(url, signal) {
      const addresses = await this.resolveAddresses(url.hostname, signal);
      observations.transports.push({
        provider: this,
        hostname: url.hostname,
        url: url.href,
        addresses: structuredClone(addresses),
        signal,
      });
      return transport(url, addresses, signal);
    }
    async fetch(request, signal) {
      let url = new URL(request.url);
      for (let hop = 0; hop < 4; hop++) {
        const response = await this.requestOnce(url, signal);
        if (!response.location) return response;
        url = new URL(response.location, url);
      }
      throw new Error("Synthetic redirect fixture exceeded its finite response plan");
    }
  }
  const native = {
    limits: { maxRedirects: 3, maxResponseBytes: 4096 },
    async resolveAddresses(hostname, signal) {
      observations.resolutions.push({ hostname, signal });
      return resolve(hostname, signal);
    },
  };
  const scope = {
    preview(hostname) {
      observations.previews.push(hostname);
      return preview(hostname);
    },
    decide(hostname, resolvedAddress) {
      observations.decisions.push({ hostname, address: resolvedAddress });
      return decide(hostname, resolvedAddress);
    },
  };
  const dependencies = {
    HttpFetchProvider: FakeHttpFetchProvider,
    native,
    scope,
    proxyRouteFor: route,
    guard,
    WebError: FakeWebError,
  };
  const run = (url = "https://target.synthetic.test/resource", signal, overrides = {}) =>
    fetchScopedHttp({ ...dependencies, ...overrides }, { url }, signal);
  return { observations, native, scope, run };
}

test("scoped HTTP preserves native resolver rejection before country decisions or transport", async () => {
  const nativeError = new FakeWebError(
    "Synthetic native public-only rejection",
    "NATIVE_PUBLIC_ONLY",
  );
  const f = fixture({
    resolve: async () => {
      throw nativeError;
    },
  });
  await assert.rejects(f.run(), (error) => error === nativeError);
  assert.deepEqual(
    f.observations.resolutions.map((entry) => entry.hostname),
    ["target.synthetic.test"],
  );
  assert.deepEqual(f.observations.decisions, []);
  assert.deepEqual(f.observations.transports, []);
});

test("scope preview rejection performs neither target resolution nor transport", async () => {
  for (const state of ["denied", "pending", "unavailable"]) {
    const f = fixture({ preview: () => ({ state }) });
    await assert.rejects(f.run(), { code: "WEB_SCOPE_DENIED" });
    assert.deepEqual(f.observations.previews, ["target.synthetic.test"]);
    assert.deepEqual(f.observations.resolutions, []);
    assert.deepEqual(f.observations.decisions, []);
    assert.deepEqual(f.observations.transports, []);
  }
});

test("mixed DNS countries pass exactly one allowed address to transport and retain the original hostname", async () => {
  const answers = [
    { ...address("1.0.0.1"), syntheticCountry: "CN" },
    { ...address("1.0.0.2"), syntheticCountry: "HK" },
    { ...address("1.0.0.3"), syntheticCountry: "MO" },
    { ...address("8.8.8.8"), syntheticCountry: "US" },
    { ...address("9.9.9.9"), syntheticCountry: "DE" },
    { ...address("11.0.0.1"), syntheticCountry: null },
  ];
  const original = structuredClone(answers);
  const f = fixture({
    resolve: async () => answers,
    decide: (_host, ip) => (["8.8.8.8", "9.9.9.9"].includes(ip) ? allowed() : denied()),
  });
  const controller = new AbortController();
  const result = await f.run(
    "https://target.synthetic.test:8443/original?fixture=yes",
    controller.signal,
  );
  assert.equal(result.body, "synthetic response");
  assert.equal(f.observations.transports.length, 1);
  const actual = f.observations.transports[0];
  assert.equal(actual.hostname, "target.synthetic.test");
  assert.equal(actual.url, "https://target.synthetic.test:8443/original?fixture=yes");
  assert.deepEqual(actual.addresses, [address("8.8.8.8")]);
  assert.equal(actual.signal, controller.signal);
  assert.equal(f.observations.resolutions[0].signal, controller.signal);
  assert.deepEqual(
    f.observations.decisions,
    answers.map((answer) => ({ hostname: "target.synthetic.test", address: answer.address })),
  );
  assert.deepEqual(answers, original, "selection must not modify the native answer set");
  assert.deepEqual(f.observations.instances[0].limits, f.native.limits);
});

test("an entirely denied or empty native answer set cannot reach transport", async () => {
  for (const answers of [[address("1.0.0.1"), address("1.0.0.2")], []]) {
    const f = fixture({ resolve: async () => answers, decide: () => denied() });
    await assert.rejects(f.run(), { code: "WEB_SCOPE_DENIED" });
    assert.equal(f.observations.resolutions.length, 1);
    assert.equal(f.observations.decisions.length, answers.length);
    assert.deepEqual(f.observations.transports, []);
  }
});

test("exact-host and derived literal-IP exceptions preserve native whole-answer-set public-only checks", async () => {
  // The native test double rejects marked fixtures before returning an answer
  // set. Scope exceptions must never bypass that independent native decision.
  for (const scenario of [
    {
      url: "https://registered.synthetic.test/path",
      reason: "exact-host",
      answers: [
        { ...address("8.8.8.8"), public: true },
        { ...address("127.0.0.1"), public: false },
      ],
    },
    {
      url: "http://127.0.0.1/path",
      reason: "resolved-exception",
      answers: [{ ...address("127.0.0.1"), public: false }],
    },
    {
      url: "http://[::ffff:7f00:1]/path",
      reason: "resolved-exception",
      answers: [{ ...address("::ffff:127.0.0.1", 6), public: false }],
    },
  ]) {
    const nativeError = new FakeWebError(
      "Synthetic native public-only rejection",
      "NATIVE_PUBLIC_ONLY",
    );
    const f = fixture({
      resolve: async () => {
        if (scenario.answers.some((answer) => !answer.public)) throw nativeError;
        return scenario.answers;
      },
      preview: () => ({ state: "ready", reason: scenario.reason }),
      decide: () => allowed(scenario.reason),
    });
    await assert.rejects(f.run(scenario.url), (error) => error === nativeError);
    assert.equal(f.observations.resolutions.length, 1);
    assert.deepEqual(f.observations.decisions, []);
    assert.deepEqual(f.observations.transports, []);
  }
});

test("country-approved IPv6 without translation metadata is refused, while a verified IPv4 alternative is selected", async () => {
  const ipv6 = address("2606:4700:4700::1111", 6);
  const unsupported = fixture({ resolve: async () => [ipv6] });
  await assert.rejects(unsupported.run(), { code: "WEB_SCOPE_IPV6_UNVERIFIED" });
  assert.deepEqual(unsupported.observations.transports, []);
  assert.deepEqual(unsupported.observations.decisions, [
    { hostname: "target.synthetic.test", address: ipv6.address },
  ]);
  const fallback = fixture({ resolve: async () => [ipv6, address("8.8.8.8")] });
  await fallback.run();
  assert.deepEqual(fallback.observations.transports[0].addresses, [address("8.8.8.8")]);
});

test("explicit host and derived-IP exceptions may use public IPv6 after native resolver approval", async () => {
  for (const scenario of [
    {
      url: "https://registered.synthetic.test/",
      reason: "exact-host",
      hostname: "registered.synthetic.test",
    },
    {
      url: "https://[2606:4700:4700::1111]/",
      reason: "resolved-exception",
      hostname: "[2606:4700:4700::1111]",
    },
  ]) {
    const ipv6 = address("2606:4700:4700::1111", 6);
    const f = fixture({ resolve: async () => [ipv6], decide: () => allowed(scenario.reason) });
    await f.run(scenario.url);
    assert.equal(f.observations.resolutions.length, 1);
    assert.equal(f.observations.transports[0].hostname, scenario.hostname);
    assert.deepEqual(f.observations.transports[0].addresses, [ipv6]);
  }
});

test("each synthetic redirect hop resolves and decides again while transport retains its hostname", async () => {
  const expected = new Map([
    ["first.synthetic.test", "8.8.8.8"],
    ["second.synthetic.test", "9.9.9.9"],
  ]);
  const f = fixture({
    resolve: async (host) => [address(expected.get(host))],
    decide: (host, ip) => (ip === expected.get(host) ? allowed() : denied()),
    transport: async (url) =>
      url.hostname === "first.synthetic.test"
        ? { status: 302, location: "https://second.synthetic.test/destination" }
        : { status: 200, body: "synthetic second hop", url: url.href },
  });
  const result = await f.run("https://first.synthetic.test/original");
  assert.equal(result.body, "synthetic second hop");
  assert.deepEqual(f.observations.previews, [...expected.keys()]);
  assert.deepEqual(
    f.observations.resolutions.map((entry) => entry.hostname),
    [...expected.keys()],
  );
  assert.deepEqual(
    f.observations.decisions,
    [...expected].map(([hostname, ip]) => ({ hostname, address: ip })),
  );
  assert.deepEqual(
    f.observations.transports.map(({ hostname, addresses }) => ({ hostname, addresses })),
    [...expected].map(([hostname, ip]) => ({ hostname, addresses: [address(ip)] })),
  );
});

test("same-host redirect DNS changes are checked again and a newly denied address never reaches transport", async () => {
  let resolutions = 0;
  const f = fixture({
    resolve: async () => [address(++resolutions === 1 ? "8.8.8.8" : "1.0.0.1")],
    decide: (_host, ip) => (ip === "8.8.8.8" ? allowed() : denied()),
    transport: async () => ({ status: 302, location: "/next" }),
  });
  await assert.rejects(f.run(), { code: "WEB_SCOPE_DENIED" });
  assert.deepEqual(
    f.observations.resolutions.map((entry) => entry.hostname),
    ["target.synthetic.test", "target.synthetic.test"],
  );
  assert.deepEqual(
    f.observations.decisions.map((entry) => entry.address),
    ["8.8.8.8", "1.0.0.1"],
  );
  assert.equal(f.observations.transports.length, 1);
  assert.deepEqual(f.observations.transports[0].addresses, [address("8.8.8.8")]);
});

test("a proxied first hop is rejected before scope preview, target resolution or transport", async () => {
  const f = fixture({ route: () => ({ proxied: true }) });
  await assert.rejects(f.run(), { code: "WEB_SCOPE_PROXY_UNSUPPORTED" });
  assert.deepEqual(f.observations.previews, []);
  assert.deepEqual(f.observations.resolutions, []);
  assert.deepEqual(f.observations.transports, []);
});

test("a proxy route enabled during target resolution blocks the pending connection", async () => {
  const started = deferred();
  const answers = deferred();
  let proxied = false;
  const f = fixture({
    route: () => ({ proxied }),
    resolve: async () => {
      started.resolve();
      return answers.promise;
    },
  });
  const pending = f.run();
  await started.promise;
  proxied = true;
  answers.resolve([address("8.8.8.8")]);
  await assert.rejects(pending, { code: "WEB_SCOPE_PROXY_UNSUPPORTED" });
  assert.equal(f.observations.resolutions.length, 1);
  assert.deepEqual(f.observations.transports, []);
});

test("a redirect's changed proxy route is checked before resolving its next target", async () => {
  const f = fixture({
    route: (url) => ({ proxied: url.hostname === "proxied.synthetic.test" }),
    transport: async () => ({ status: 302, location: "https://proxied.synthetic.test/next" }),
  });
  await assert.rejects(f.run(), { code: "WEB_SCOPE_PROXY_UNSUPPORTED" });
  assert.deepEqual(
    f.observations.resolutions.map((entry) => entry.hostname),
    ["target.synthetic.test"],
  );
  assert.equal(f.observations.transports.length, 1);
});

test("guard rejection before a request prevents all preview, resolution and transport work", async () => {
  const error = new FakeWebError("Synthetic scope revision changed", "SYNTHETIC_SCOPE_CHANGED");
  const f = fixture({
    guard: () => {
      throw error;
    },
  });
  await assert.rejects(f.run(), (actual) => actual === error);
  assert.deepEqual(f.observations.previews, []);
  assert.deepEqual(f.observations.resolutions, []);
  assert.deepEqual(f.observations.transports, []);
});

test("scope changes or cancellation during resolution discard late answers before policy or transport", async () => {
  for (const mode of ["scope-change", "cancel"]) {
    const started = deferred();
    const answers = deferred();
    const controller = new AbortController();
    let revision = 1;
    const error = new FakeWebError(`Synthetic ${mode}`, `SYNTHETIC_${mode.toUpperCase()}`);
    const f = fixture({
      resolve: async () => {
        started.resolve();
        return answers.promise;
      },
      guard: () => {
        if (revision !== 1 || controller.signal.aborted) throw error;
      },
    });
    const pending = f.run("https://target.synthetic.test/", controller.signal);
    await started.promise;
    if (mode === "cancel") controller.abort();
    else revision++;
    answers.resolve([address("8.8.8.8")]);
    await assert.rejects(pending, (actual) => actual === error);
    assert.deepEqual(f.observations.decisions, []);
    assert.deepEqual(f.observations.transports, []);
  }
});

test("guard scope changes during decisions block transport and changes after transport block result delivery", async () => {
  for (const mode of ["decision", "response"]) {
    let current = true;
    const error = new FakeWebError("Synthetic scope revision changed", "SYNTHETIC_SCOPE_CHANGED");
    const f = fixture({
      guard: () => {
        if (!current) throw error;
      },
      decide: () => {
        if (mode === "decision") current = false;
        return allowed();
      },
      transport: async () => {
        current = false;
        return { status: 200, body: "withheld synthetic response" };
      },
    });
    await assert.rejects(f.run(), (actual) => actual === error);
    assert.equal(f.observations.transports.length, mode === "decision" ? 0 : 1);
  }
});

test("concurrent scoped fetches own separate resolvers and keep opposite completion orders and policies isolated", async () => {
  const firstStarted = deferred();
  const secondStarted = deferred();
  const firstAnswers = deferred();
  const secondAnswers = deferred();
  const f = fixture({
    resolve: async (host) => {
      if (host === "first.synthetic.test") {
        firstStarted.resolve();
        return firstAnswers.promise;
      }
      secondStarted.resolve();
      return secondAnswers.promise;
    },
  });
  const originalNativeResolver = f.native.resolveAddresses;
  const firstScope = {
    preview: () => ({ state: "ready" }),
    decide: (host, ip) =>
      host === "first.synthetic.test" && ip === "8.8.8.8" ? allowed() : denied(),
  };
  const secondScope = {
    preview: () => ({ state: "ready" }),
    decide: (host, ip) =>
      host === "second.synthetic.test" && ip === "9.9.9.9" ? allowed() : denied(),
  };
  const first = f.run("https://first.synthetic.test/resource", undefined, { scope: firstScope });
  const second = f.run("https://second.synthetic.test/resource", undefined, { scope: secondScope });
  await Promise.all([firstStarted.promise, secondStarted.promise]);
  secondAnswers.resolve([address("9.9.9.9")]);
  const secondResult = await second;
  assert.equal(secondResult.url, "https://second.synthetic.test/resource");
  assert.equal(f.observations.transports.length, 1);
  firstAnswers.resolve([address("8.8.8.8")]);
  const firstResult = await first;
  assert.equal(firstResult.url, "https://first.synthetic.test/resource");
  assert.equal(f.observations.instances.length, 2);
  assert.notEqual(f.observations.instances[0], f.observations.instances[1]);
  assert.deepEqual(
    f.observations.transports.map(({ hostname, addresses }) => ({ hostname, addresses })),
    [
      { hostname: "second.synthetic.test", addresses: [address("9.9.9.9")] },
      { hostname: "first.synthetic.test", addresses: [address("8.8.8.8")] },
    ],
  );
  assert.equal(f.native.resolveAddresses, originalNativeResolver);
});
