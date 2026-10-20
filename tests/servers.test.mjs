import test from "node:test";
import assert from "node:assert/strict";
import { normalizeServers } from "../src/core/servers.js";
import { settings } from "../src/core/validation.js";

test("server inventory normalizes exact hosts, usernames, IPv6 and IDNs without DNS", () => {
  assert.deepEqual(
    normalizeServers([
      " Example.TEST. ",
      "example.test",
      "Admin@example.TEST",
      "192.0.2.10",
      "2001:0DB8:0:0:0:0:0:1",
      "[2001:db8::1]",
      "tester@[2001:db8::1]",
      "例子.测试",
      "",
    ]),
    [
      "example.test",
      "Admin@example.test",
      "192.0.2.10",
      "[2001:db8::1]",
      "tester@[2001:db8::1]",
      "xn--fsqu00a.xn--0zwm56d",
    ],
  );
  assert.deepEqual(settings({ ownServers: [" Example.TEST ", "example.test"] }).ownServers, [
    "example.test",
  ]);
});

test("server inventory rejects credentials, URLs, ports, networks and malformed targets without echoing them", () => {
  const forbidden = [
    "user:SYNTHETIC_PASSWORD@example.test",
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_DATA",
    "https://example.test",
    "example.test/path",
    "example.test?token=SYNTHETIC_SECRET",
    "192.0.2.0/24",
    "*.example.test",
    "192.0.2.1:22",
    "[2001:db8::1]:22",
    "2001:db8::/32",
    "user@@example.test",
    "localhost",
    "-example.test",
    "example..test",
    "192.000.002.1",
    "fe80::1%en0",
    "a b.example.test",
    "[example.test]",
  ];
  for (const entry of forbidden) {
    assert.throws(
      () => normalizeServers([entry]),
      (error) => error.code === "INVALID_INPUT" && !error.message.includes(entry),
      entry,
    );
  }
  assert.throws(() => settings({ ownServers: [42] }), { code: "INVALID_INPUT" });
});
