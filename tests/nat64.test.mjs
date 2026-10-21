import test from "node:test";
import assert from "node:assert/strict";
import { nat64Prefixes, ipv6Destination } from "../src/core/nat64.js";

const a = (address) => ({ address, family: 4 });
const aaaa = (address) => ({ address, family: 6 });
const canonical = (address) => new URL(`http://[${address}]/`).hostname.slice(1, -1);
const unknown = { known: false, prefixes: [], reason: "nat64-discovery-unknown" };
// Original synthetic addresses. The differing 13/37/42/99 destination bytes
// expose byte-order and split-u mistakes independently of discovery sentinels.
const CASES = [
  {
    length: 32,
    hex: "2610abcd000000000000000000000000",
    first: "2610:abcd:c000:aa::",
    second: "2610:abcd:c000:ab::",
    destination: "2610:abcd:d25:2a63::",
    suffix: "2610:abcd:d25:2a63:0:1234:5678:9abc",
    discoverySuffix: "2610:abcd:c000:aa:0:1234:5678:9abc",
    invalidU: "2610:abcd:d25:2a63:100::",
  },
  {
    length: 40,
    hex: "2610abcd550000000000000000000000",
    first: "2610:abcd:55c0:0:aa::",
    second: "2610:abcd:55c0:0:ab::",
    destination: "2610:abcd:550d:252a:63::",
    suffix: "2610:abcd:550d:252a:63:1234:5678:9abc",
    discoverySuffix: "2610:abcd:55c0:0:aa:1234:5678:9abc",
    invalidU: "2610:abcd:550d:252a:163::",
  },
  {
    length: 48,
    hex: "2610abcd556600000000000000000000",
    first: "2610:abcd:5566:c000:0:aa00::",
    second: "2610:abcd:5566:c000:0:ab00::",
    destination: "2610:abcd:5566:d25:2a:6300::",
    suffix: "2610:abcd:5566:d25:2a:63ab:cdef:1234",
    discoverySuffix: "2610:abcd:5566:c000:0:aaab:cdef:1234",
    invalidU: "2610:abcd:5566:d25:12a:6300::",
  },
  {
    length: 56,
    hex: "2610abcd556677000000000000000000",
    first: "2610:abcd:5566:77c0:0:aa::",
    second: "2610:abcd:5566:77c0:0:ab::",
    destination: "2610:abcd:5566:770d:25:2a63::",
    suffix: "2610:abcd:5566:770d:25:2a63:abcd:1234",
    discoverySuffix: "2610:abcd:5566:77c0:0:aa:abcd:1234",
    invalidU: "2610:abcd:5566:770d:125:2a63::",
  },
  {
    length: 64,
    hex: "2610abcd556677880000000000000000",
    first: "2610:abcd:5566:7788:c0:0:aa00:0",
    second: "2610:abcd:5566:7788:c0:0:ab00:0",
    destination: "2610:abcd:5566:7788:d:252a:6300:0",
    suffix: "2610:abcd:5566:7788:d:252a:63ab:cdef",
    discoverySuffix: "2610:abcd:5566:7788:c0:0:aaab:cdef",
    invalidU: "2610:abcd:5566:7788:10d:252a:6300:0",
  },
  {
    length: 96,
    hex: "2610abcd556677880099aabb00000000",
    first: "2610:abcd:5566:7788:99:aabb:c000:aa",
    second: "2610:abcd:5566:7788:99:aabb:c000:ab",
    destination: "2610:abcd:5566:7788:99:aabb:d25:2a63",
    invalidU: "2610:abcd:5566:7788:199:aabb:d25:2a63",
  },
];
const expected = ({ length, hex }) => ({ length, hex });
function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test("each supported RFC 6052 layout discovers both sentinels and decodes network byte order", () => {
  for (const item of CASES) {
    const discovery = nat64Prefixes([aaaa(item.first), aaaa(item.second)]);
    assert.deepEqual(discovery, { known: true, prefixes: [expected(item)] }, `/${item.length}`);
    assert.deepEqual(
      ipv6Destination(item.destination, discovery),
      { kind: "translated", address: "13.37.42.99" },
      `/${item.length}`,
    );
    assert.deepEqual(ipv6Destination(item.first, discovery), {
      kind: "translated",
      address: "192.0.0.170",
    });
    assert.deepEqual(ipv6Destination(item.second, discovery), {
      kind: "translated",
      address: "192.0.0.171",
    });
  }
});

test("ordinary single-sentinel replies suffice and duplicate/expanded/uppercase records deduplicate", () => {
  for (const item of CASES) {
    const single = nat64Prefixes([aaaa(item.first)]);
    assert.deepEqual(single, { known: true, prefixes: [expected(item)] });
    assert.deepEqual(nat64Prefixes([aaaa(item.second)]), single);
    assert.deepEqual(
      nat64Prefixes([
        aaaa(item.first.toUpperCase()),
        aaaa(canonical(item.first)),
        aaaa(item.first),
        aaaa(item.second),
      ]),
      single,
    );
  }
});

test("dotted IPv6 tails and the well-known /96 prefix remain syntactic, offline conversions", () => {
  const discovery = nat64Prefixes([aaaa("64:ff9b::192.0.0.170"), aaaa("64:ff9b::c000:ab")]);
  assert.deepEqual(discovery, {
    known: true,
    prefixes: [{ length: 96, hex: "0064ff9b000000000000000000000000" }],
  });
  assert.deepEqual(ipv6Destination("64:ff9b::128.255.0.1", discovery), {
    kind: "translated",
    address: "128.255.0.1",
  });
  assert.deepEqual(ipv6Destination("0064:FF9B:0000:0000:0000:0000:80FF:0001", discovery), {
    kind: "translated",
    address: "128.255.0.1",
  });
  const mixed = nat64Prefixes([aaaa("2610:abcd:5566:7788:99:aabb:192.0.0.170")]);
  assert.deepEqual(mixed, { known: true, prefixes: [expected(CASES[5])] });
});

test("valid A-only snapshots indicate no discovered NAT64, while absent or malformed snapshots stay unknown", () => {
  for (const records of [
    [a("192.0.0.170")],
    [a("192.0.0.171")],
    [a("192.0.0.170"), a("192.0.0.171")],
  ]) {
    assert.deepEqual(nat64Prefixes(records), { known: true, prefixes: [] });
  }
  const invalid = [
    undefined,
    null,
    {},
    [],
    [null],
    ["64:ff9b::c000:aa"],
    [a("192.0.0.172")],
    [a("8.8.8.8")],
    [a("192.0.0.170"), a("8.8.8.8")],
    [{ address: "64:ff9b::c000:aa", family: "IPv6" }],
    [{ address: "64:ff9b::c000:aa", family: 4 }],
    [{ address: "192.0.0.170", family: 6 }],
    [{ address: "192.0.0.170" }],
    [aaaa("64:ff9b::c000:aa%eth0")],
    [aaaa("[64:ff9b::c000:aa]")],
    [aaaa("64:ff9b::c000:aa/96")],
    [aaaa("https://[64:ff9b::c000:aa]/")],
    [aaaa("64:ff9b::c000:gg")],
    [aaaa("2610:abcd::1")],
    [aaaa("2610:abc0:0:aa00::")],
    Array.from({ length: 257 }, () => a("192.0.0.170")),
  ];
  for (const records of invalid) assert.deepEqual(nat64Prefixes(records), unknown);
  assert.deepEqual(nat64Prefixes(Array.from({ length: 256 }, () => a("192.0.0.170"))), {
    known: true,
    prefixes: [],
  });
});

test("one unexplained AAAA or malformed record invalidates the complete mixed snapshot", () => {
  const valid = [a("192.0.0.170"), aaaa(CASES[5].first)];
  assert.deepEqual(nat64Prefixes(valid), { known: true, prefixes: [expected(CASES[5])] });
  for (const extra of [
    aaaa("2620::5"),
    aaaa("64:ff9b::c000:ac"),
    a("192.0.0.172"),
    { family: 6, address: null },
  ]) {
    assert.deepEqual(nat64Prefixes([...valid, extra]), unknown);
  }
});

test("nonzero suffixes are accepted during both discovery and destination extraction", () => {
  for (const item of CASES.filter((item) => item.length < 96)) {
    const discovery = nat64Prefixes([aaaa(item.discoverySuffix)]);
    assert.deepEqual(discovery, { known: true, prefixes: [expected(item)] }, `/${item.length}`);
    assert.deepEqual(ipv6Destination(item.suffix, discovery), {
      kind: "translated",
      address: "13.37.42.99",
    });
  }
  const discovery = nat64Prefixes([aaaa(CASES[0].first)]);
  assert.deepEqual(ipv6Destination("2610:abcd:d25:2a63::c000:aa", discovery), {
    kind: "translated",
    address: "13.37.42.99",
  });
});

test("a WKA repeated in a prefix or suffix stays unknown until the other sentinel disambiguates", () => {
  for (const sample of [
    {
      first: "c000:aa:5566:7788:99:aabb:c000:aa",
      second: "c000:aa:5566:7788:99:aabb:c000:ab",
      prefix: { length: 96, hex: "c00000aa556677880099aabb00000000" },
    },
    {
      first: "26c0:0:aa66:7788:99:aabb:c000:aa",
      second: "26c0:0:aa66:7788:99:aabb:c000:ab",
      prefix: { length: 96, hex: "26c00000aa6677880099aabb00000000" },
    },
    {
      first: "2610:abcd:c000:aa:99:aabb:c000:aa",
      second: "2610:abcd:c000:aa:99:aabb:c000:ab",
      prefix: { length: 96, hex: "2610abcdc00000aa0099aabb00000000" },
    },
    {
      first: "2610:abcd:c000:ab:99:aabb:c000:ab",
      second: "2610:abcd:c000:ab:99:aabb:c000:aa",
      prefix: { length: 96, hex: "2610abcdc00000ab0099aabb00000000" },
    },
    {
      first: "2610:abcd:c000:aa::c000:aa",
      second: "2610:abcd:c000:ab::c000:aa",
      prefix: expected(CASES[0]),
    },
  ]) {
    assert.deepEqual(nat64Prefixes([aaaa(sample.first)]), unknown);
    assert.deepEqual(nat64Prefixes([aaaa(sample.first), aaaa(sample.second)]), {
      known: true,
      prefixes: [sample.prefix],
    });
    assert.deepEqual(nat64Prefixes([aaaa(sample.second), aaaa(sample.first)]), {
      known: true,
      prefixes: [sample.prefix],
    });
  }
});

test("unresolved alternative WKA positions do not invent a prefix", () => {
  // The prefix itself contains .170 and .171. Neither synthesized response
  // supplies a unique sentinel position, so guessing /32 or /96 is unsafe.
  assert.deepEqual(
    nat64Prefixes([
      aaaa("c000:aa:c000:ab:99:aabb:c000:aa"),
      aaaa("c000:aa:c000:ab:99:aabb:c000:ab"),
    ]),
    unknown,
  );
  // One response contains two different legal candidate positions. A second
  // response, not a fixed preference for one prefix length, is needed.
  assert.deepEqual(nat64Prefixes([aaaa("2610:abcd:c000:aa:99:aabb:c000:ab")]), unknown);
  // Crossed positions could mean one /32 or two different /96 prefixes. Both
  // WKA values occur once in each response, so neither disambiguates the other.
  assert.deepEqual(
    nat64Prefixes([
      aaaa("2610:abcd:c000:aa:99:aabb:c000:ab"),
      aaaa("2610:abcd:c000:ab:99:aabb:c000:aa"),
    ]),
    unknown,
  );
});

test("multiple prefixes preserve response order and overlapping translations refuse different IPv4 destinations", () => {
  const order = [CASES[5], CASES[0], CASES[2]];
  const discovery = nat64Prefixes(order.flatMap((item) => [aaaa(item.first), aaaa(item.second)]));
  assert.deepEqual(discovery, { known: true, prefixes: order.map(expected) });
  assert.deepEqual(ipv6Destination(CASES[5].destination, discovery), {
    kind: "unknown",
    address: canonical(CASES[5].destination),
    reason: "nat64-prefix-overlap",
  });
  const same = {
    known: true,
    prefixes: [expected(CASES[0]), { length: 96, hex: "2610abcd0d252a630000000000000000" }],
  };
  assert.deepEqual(ipv6Destination("2610:abcd:d25:2a63::d25:2a63", same), {
    kind: "translated",
    address: "13.37.42.99",
  });
  assert.deepEqual(ipv6Destination("2610:abcd:d25:2a63::808:808", same), {
    kind: "unknown",
    address: "2610:abcd:d25:2a63::808:808",
    reason: "nat64-prefix-overlap",
  });
});

test("reserved u bytes are required to be zero in every layout, including the /96 near-match boundary", () => {
  for (const item of CASES) {
    const discovery = nat64Prefixes([aaaa(item.first)]);
    assert.deepEqual(
      ipv6Destination(item.invalidU, discovery),
      {
        kind: "unknown",
        address: canonical(item.invalidU),
        reason: "nat64-u-byte",
      },
      `/${item.length}`,
    );
  }
  for (const address of ["64:ff9b:0:0:100:0:c000:aa", "2610:abcd:5566:7788:199:aabb:c000:aa"]) {
    assert.deepEqual(nat64Prefixes([aaaa(address)]), unknown);
  }
  const discovery = nat64Prefixes([aaaa(CASES[5].first)]);
  const ordinary = "2610:abcd:5566:7788:199:aabc:d25:2a63";
  assert.deepEqual(ipv6Destination(ordinary, discovery), { kind: "native", address: ordinary });
});

test("normal nonmatching IPv6 keeps its canonical native address even with arbitrary interface-ID bytes", () => {
  const discovery = nat64Prefixes([aaaa(CASES[0].first)]);
  for (const address of ["2620::1", "2620:1234:abcd:ef01:ffff:abcd:1234:5678", "::1"]) {
    assert.deepEqual(ipv6Destination(address, discovery), {
      kind: "native",
      address: canonical(address),
    });
  }
  const withoutNat64 = nat64Prefixes([a("192.0.0.170")]);
  assert.deepEqual(ipv6Destination("64:ff9b::808:808", withoutNat64), {
    kind: "native",
    address: "64:ff9b::808:808",
  });
});

test("invalid IPv6 and unknown or malformed discovery data fail closed without throwing", () => {
  const known = nat64Prefixes([aaaa(CASES[5].first)]);
  for (const address of [
    undefined,
    null,
    {},
    "",
    "8.8.8.8",
    "2620::1%en0",
    "[2620::1]",
    "2620::1/64",
    "2620::gg",
    " 2620::1",
    "https://[2620::1]",
  ]) {
    assert.deepEqual(ipv6Destination(address, known), {
      kind: "unknown",
      address: "",
      reason: "ipv6-invalid",
    });
  }
  const bad = [
    undefined,
    null,
    {},
    { known: false, prefixes: [] },
    { known: "true", prefixes: [] },
    { known: true },
    { known: true, prefixes: [null] },
    { known: true, prefixes: [{ length: 72, hex: CASES[5].hex }] },
    { known: true, prefixes: [{ length: 96, hex: "2610ABCD556677880099AABB00000000" }] },
    { known: true, prefixes: [{ length: 32, hex: "2610abcd556600000000000000000000" }] },
    { known: true, prefixes: [{ length: 96, hex: "2610abcd556677880199aabb00000000" }] },
    { known: true, prefixes: [{ length: 96, hex: "2610abcd" }] },
  ];
  for (const discovery of bad) {
    assert.deepEqual(ipv6Destination("2620::1", discovery), {
      kind: "unknown",
      address: "2620::1",
      reason: "nat64-discovery-unknown",
    });
  }
});

test("IPv4-mapped IPv6 remains directly interpretable even when NAT64 discovery is unknown", () => {
  for (const discovery of [
    undefined,
    unknown,
    { known: true, prefixes: [] },
    nat64Prefixes([aaaa(CASES[0].first)]),
  ]) {
    for (const address of ["::ffff:192.0.2.1", "0:0:0:0:0:FFFF:C000:0201"]) {
      assert.deepEqual(ipv6Destination(address, discovery), {
        kind: "native",
        address: "::ffff:c000:201",
      });
    }
  }
});

test("discovery and destination classification never mutate caller-owned inputs or share result state", () => {
  const records = deepFreeze([aaaa(CASES[0].first), a("192.0.0.170"), aaaa(CASES[0].second)]);
  const before = structuredClone(records);
  const discovery = deepFreeze(nat64Prefixes(records));
  const metadataBefore = structuredClone(discovery);
  for (const address of [
    CASES[0].destination,
    CASES[0].suffix,
    CASES[0].invalidU,
    "2620::1",
    "::ffff:8.8.8.8",
  ])
    ipv6Destination(address, discovery);
  assert.deepEqual(records, before);
  assert.deepEqual(discovery, metadataBefore);
  const first = nat64Prefixes(records);
  first.prefixes[0].hex = "changed caller result";
  first.prefixes.push({ length: 96, hex: "changed caller result" });
  assert.deepEqual(nat64Prefixes(records), metadataBefore);
});
