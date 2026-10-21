import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolveNativeHttp } from "../src/host/native-http-resolution.js";

function lookupFixture(t, callback) {
  const original = dns.lookup;
  dns.lookup = callback;
  syncBuiltinESMExports();
  t.after(() => {
    dns.lookup = original;
    syncBuiltinESMExports();
  });
}

test("native lookup observer forwards the exact arguments and answers without another query", async (t) => {
  const signal = new AbortController().signal;
  const options = { all: true, order: "verbatim" };
  const target = [{ address: "2606:4700::1111", family: 6 }];
  const discovery = [{ address: "192.0.0.170", family: 4 }];
  const calls = [];
  lookupFixture(t, async (hostname, actualOptions) => {
    calls.push(hostname);
    assert.equal(actualOptions, options);
    return hostname === "ipv4only.arpa" ? discovery : target;
  });
  const native = {
    async resolveAddresses(hostname, actualSignal, lookup) {
      assert.equal(this, native);
      assert.equal(hostname, "target.invalid");
      assert.equal(actualSignal, signal);
      assert.equal(await lookup(hostname, options), target);
      assert.equal(await lookup("ipv4only.arpa", options), discovery);
      return target;
    },
  };
  const original = native.resolveAddresses;
  const result = await resolveNativeHttp(native, "target.invalid", signal);
  assert.equal(result.addresses, target);
  assert.deepEqual(result.discovery, { known: true, prefixes: [] });
  assert.deepEqual(calls, ["target.invalid", "ipv4only.arpa"]);
  assert.equal(native.resolveAddresses, original);
});

test("discovery is a snapshot of the answer delivered to the native consumer", async (t) => {
  const response = [{ address: "192.0.0.171", family: 4 }];
  lookupFixture(t, async () => response);
  const native = {
    async resolveAddresses(_hostname, _signal, lookup) {
      const received = await lookup("ipv4only.arpa", { all: true });
      received[0].address = "8.8.8.8";
      received.push({ address: "bad", family: 6 });
      return [{ address: "2606:4700::1111", family: 6 }];
    },
  };
  assert.deepEqual((await resolveNativeHttp(native, "target.invalid")).discovery, {
    known: true,
    prefixes: [],
  });
});

test("native errors and lookup failures propagate intact without substitute answers", async (t) => {
  const failure = Object.assign(new Error("Synthetic DNS failure"), { code: "EAI_AGAIN" });
  let calls = 0;
  lookupFixture(t, async () => {
    calls++;
    throw failure;
  });
  await assert.rejects(
    resolveNativeHttp(
      {
        resolveAddresses(_hostname, _signal, lookup) {
          return lookup("ipv4only.arpa", { all: true });
        },
      },
      "target.invalid",
    ),
    (error) => error === failure,
  );
  const nativeFailure = new Error("Synthetic native public-only rejection");
  await assert.rejects(
    resolveNativeHttp(
      {
        resolveAddresses: async () => {
          throw nativeFailure;
        },
      },
      "target.invalid",
    ),
    (error) => error === nativeFailure,
  );
  assert.equal(calls, 1);
});

test("missing or repeated discovery cannot become proof of native IPv6", async (t) => {
  let calls = 0;
  lookupFixture(t, async () => {
    calls++;
    return [{ address: "192.0.0.170", family: 4 }];
  });
  for (const repetitions of [0, 2]) {
    const result = await resolveNativeHttp(
      {
        async resolveAddresses(_hostname, _signal, lookup) {
          for (let i = 0; i < repetitions; i++) await lookup("ipv4only.arpa", { all: true });
          return [{ address: "2606:4700::1111", family: 6 }];
        },
      },
      "target.invalid",
    );
    assert.equal(result.discovery.known, false);
  }
  assert.equal(calls, 2);
});

test("oversized lookup metadata is not retained or interpreted as absent DNS64", async (t) => {
  lookupFixture(t, async () =>
    Array.from({ length: 257 }, () => ({ address: "192.0.0.170", family: 4 })),
  );
  const result = await resolveNativeHttp(
    {
      async resolveAddresses(_hostname, _signal, lookup) {
        await lookup("ipv4only.arpa", { all: true });
        return [{ address: "2606:4700::1111", family: 6 }];
      },
    },
    "target.invalid",
  );
  assert.equal(result.discovery.known, false);
});
