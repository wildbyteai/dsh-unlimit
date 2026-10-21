import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { parseIpBytes } from "../src/core/ip-bytes.js";

function expectAddress(input, family, expectedBytes) {
  const result = parseIpBytes(input);
  assert.ok(result, input);
  assert.equal(result.family, family, input);
  assert.ok(Buffer.isBuffer(result.bytes), input);
  assert.deepEqual([...result.bytes], expectedBytes, input);
}

test("original literal vectors preserve network byte order and family", () => {
  const vectors = [
    ["0.0.0.0", 4, "00000000"],
    ["255.255.255.255", 4, "ffffffff"],
    ["37.209.6.184", 4, "25d106b8"],
    ["::", 6, "00000000000000000000000000000000"],
    ["::b7", 6, "000000000000000000000000000000b7"],
    ["cAFE:34:9876:b:1234:5678:90ab:def0", 6, "cafe00349876000b1234567890abdef0"],
    ["0A00:0003:5:7:9:b:d:f", 6, "0a000003000500070009000b000d000f"],
    ["31ab:4::9e:2", 6, "31ab00040000000000000000009e0002"],
    ["::fFfF:37.209.6.184", 6, "00000000000000000000ffff25d106b8"],
    ["1234:56:78:9a:bc:de:37.209.6.184", 6, "123400560078009a00bc00de25d106b8"],
    ["abcd:ef01:2345:6789:abcd:ef01:255.255.255.255", 6, "abcdef0123456789abcdef01ffffffff"],
  ];
  for (const [input, family, hex] of vectors) {
    assert.equal(hex.length, family === 4 ? 8 : 32, input);
    expectAddress(input, family, [...Buffer.from(hex, "hex")]);
  }
});

test("every IPv6 compression interval expands to predetermined octets", () => {
  const words = ["102", "304", "506", "708", "90a", "b0c", "d0e", "f10"];
  const octets = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  let cases = 0;
  for (let start = 0; start < 8; start++) {
    for (let end = start + 1; end <= 8; end++) {
      const expected = octets.slice();
      expected.fill(0, start * 2, end * 2);
      const left = words.slice(0, start).join(":");
      const right = words.slice(end).join(":");
      expectAddress(`${left}::${right}`, 6, expected);
      cases++;
    }
  }
  assert.equal(cases, 36);
});

test("every compression interval before an IPv4 tail preserves the tail bytes", () => {
  const words = ["1122", "3344", "5566", "7788", "99aa", "bbcc"];
  const octets = [17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 19, 71, 142, 253];
  let cases = 0;
  for (let start = 0; start < 6; start++) {
    for (let end = start + 1; end <= 6; end++) {
      const expected = octets.slice();
      expected.fill(0, start * 2, end * 2);
      const left = words.slice(0, start).join(":");
      const right = [...words.slice(end), "19.71.142.253"].join(":");
      expectAddress(`${left}::${right}`, 6, expected);
      cases++;
    }
  }
  assert.equal(cases, 21);
});

test("deterministic IPv4 cases cover every octet value in each position", () => {
  for (let value = 0; value < 256; value++) {
    const octets = [value, 255 - value, (value * 73) % 256, (value * 131 + 17) % 256];
    expectAddress(octets.join("."), 4, octets);
  }
});

test("rejects values outside the bare literal contract without coercion", () => {
  const invalid = [
    undefined,
    null,
    true,
    0,
    123n,
    Symbol("ip"),
    [],
    {},
    new String("37.209.6.184"),
    {
      toString() {
        throw new Error("must not coerce");
      },
    },
    "",
    "a".repeat(46),
    "localhost",
    "example.test",
    "[::b7]",
    "[::b7]:443",
    "37.209.6.184:443",
    "37.209.6.184/24",
    "::b7/64",
    "fe80::b7%en0",
    "fe80::b7%3",
    " 37.209.6.184",
    "37.209.6.184 ",
    "::b7\n",
    "\t::b7",
    ":: b7",
    "::b7\u00a0",
    "37.0209.6.184",
    "037.209.6.184",
    "37.209.6.0184",
    "37.209.6.256",
    "37.209.6",
    "37.209.6.184.1",
    "37..6.184",
    "0x25.209.6.184",
    "+37.209.6.184",
    "1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7:8::",
    "1::2::3",
    ":::b7",
    "b7:",
    ":b7",
    "12345::",
    "gg::",
    "1:2:3:4:5:37.209.6.184",
    "1:2:3:4:5:6:7:37.209.6.184",
    "::37.0209.6.184",
    "::37.209.6.256",
    "37.209.6.184::",
    "::37.209.6.184:1",
  ];
  for (const input of invalid) assert.equal(parseIpBytes(input), null);
});

test("each call owns an independent writable Buffer", () => {
  for (const input of ["37.209.6.184", "::ffff:37.209.6.184"]) {
    const first = parseIpBytes(input);
    const second = parseIpBytes(input);
    const original = [...second.bytes];
    assert.notEqual(first.bytes, second.bytes);
    first.bytes.fill(0x52);
    assert.deepEqual([...second.bytes], original);
    assert.deepEqual([...parseIpBytes(input).bytes], original);
    assert.ok(first.bytes.every((byte) => byte === 0x52));
  }
});
