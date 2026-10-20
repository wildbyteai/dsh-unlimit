import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { checkEndpoint, resolveAddresses } from "../src/core/connection-transport.js";

const runFile = promisify(execFile);
const transportUrl = new URL("../src/core/connection-transport.js", import.meta.url).href;

async function listen(t, server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return { port: server.address().port, sockets };
}

function endpoint(port, overrides = {}) {
  return {
    protocol: "http:",
    hostname: "127.0.0.1",
    address: "127.0.0.1",
    family: 4,
    port,
    path: "/",
    ...overrides,
  };
}

async function socketsClosed(sockets) {
  const deadline = Date.now() + 1500;
  while (sockets.size && Date.now() < deadline) await delay(10);
  assert.equal(sockets.size, 0, "the probe must close its socket");
}

async function isolated(source, extraEnv = {}) {
  const { stdout } = await runFile(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ...extraEnv },
    timeout: 5000,
    maxBuffer: 32 * 1024,
  });
  return JSON.parse(stdout);
}

function pinnedChildSource(targets) {
  return `
    import assert from "node:assert/strict";
    import dns from "node:dns";
    import { syncBuiltinESMExports } from "node:module";
    let lookups = 0;
    dns.lookup = () => { lookups++; throw new Error("Unexpected DNS lookup"); };
    syncBuiltinESMExports();
    const { checkEndpoint } = await import(${JSON.stringify(transportUrl)});
    const results = [];
    for (const target of ${JSON.stringify(targets)}) {
      results.push(await checkEndpoint(target, { timeoutMs: 1000 }));
    }
    assert.equal(lookups, 0);
    console.log(JSON.stringify(results));
  `;
}

test("system resolver returns the literal loopback address without an external query", async () => {
  assert.deepEqual(await resolveAddresses("127.0.0.1", { timeoutMs: 1000 }), [
    { address: "127.0.0.1", family: 4 },
  ]);
});

test("resolver uses lookup(all), sanitizes failures and discards late cancelled or timed-out results", async (t) => {
  let connections = 0;
  const server = http.createServer((_request, response) => response.end());
  server.on("connection", () => connections++);
  const { port } = await listen(t, server);
  const result = await isolated(`
    import assert from "node:assert/strict";
    import dns from "node:dns";
    import { syncBuiltinESMExports } from "node:module";
    import { setTimeout as delay } from "node:timers/promises";
    const calls = [];
    let callback;
    dns.lookup = (hostname, options, done) => {
      calls.push({ hostname, options });
      callback = done;
    };
    syncBuiltinESMExports();
    const { resolveAddresses, checkEndpoint } = await import(${JSON.stringify(transportUrl)});
    const resolved = resolveAddresses("synthetic.test", { timeoutMs: 1000 });
    callback(null, [
      { address: "192.0.2.20", family: 4 },
      { address: "2001:db8::20", family: 6 },
    ]);
    assert.deepEqual(await resolved, [
      { address: "192.0.2.20", family: 4 },
      { address: "2001:db8::20", family: 6 },
    ]);
    assert.deepEqual(calls[0], { hostname: "synthetic.test", options: { all: true } });
    const failed = resolveAddresses("synthetic.test", { timeoutMs: 1000 });
    callback(Object.assign(new Error("SYNTHETIC_PRIVATE_DNS_ERROR"), { code: "ENOTFOUND" }));
    await assert.rejects(failed, (error) => error.code === "DNS_ERROR" && !error.message.includes("SYNTHETIC"));
    const controller = new AbortController();
    let resumed = false;
    const cancelled = resolveAddresses("synthetic.test", { signal: controller.signal, timeoutMs: 1000 })
      .then(async ([resolvedAddress]) => {
        resumed = true;
        return checkEndpoint({
          protocol: "http:", hostname: "127.0.0.1", port: ${port}, path: "/",
          ...resolvedAddress,
        });
      });
    const cancelledCallback = callback;
    controller.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    await assert.rejects(cancelled, { code: "DNS_CANCELLED" });
    cancelledCallback(null, [{ address: "127.0.0.1", family: 4 }]);
    const timedOut = resolveAddresses("synthetic.test", { timeoutMs: 15 });
    const timedOutCallback = callback;
    await assert.rejects(timedOut, { code: "DNS_TIMEOUT" });
    timedOutCallback(null, [{ address: "127.0.0.1", family: 4 }]);
    const before = calls.length;
    await assert.rejects(resolveAddresses("synthetic.test", { signal: controller.signal }), { code: "DNS_CANCELLED" });
    await assert.rejects(resolveAddresses("synthetic.test", { timeoutMs: 0 }), { code: "DNS_TIMEOUT" });
    assert.equal(calls.length, before);
    await delay(30);
    assert.equal(resumed, false);
    console.log(JSON.stringify({ codes: ["DNS_ERROR", "DNS_CANCELLED", "DNS_TIMEOUT"], resumed }));
  `);
  assert.equal(result.resumed, false);
  assert.equal(connections, 0);
});

test("HEAD preserves the confirmed path and Host without credentials or a body for all response classes", async (t) => {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(Number(request.url.match(/^\/(\d+)/)[1]), {
        Location: "/SYNTHETIC_PRIVATE_REDIRECT",
        "Set-Cookie": "SYNTHETIC_PRIVATE_COOKIE=hidden",
        "X-Synthetic-Private": "not returned",
      });
      response.end();
    });
  });
  const { port, sockets } = await listen(t, server);
  for (const status of [204, 301, 302, 401, 403, 404, 500, 503]) {
    const confirmedPath = `/${status}/probe%2Fexact?approved=yes&value=a%2Bb&value=two`;
    const result = await checkEndpoint(
      endpoint(port, {
        path: confirmedPath,
        authorization: "SYNTHETIC_PRIVATE_AUTHORIZATION",
        cookie: "SYNTHETIC_PRIVATE_COOKIE",
        headers: { Authorization: "SYNTHETIC_PRIVATE_AUTHORIZATION" },
        body: "SYNTHETIC_PRIVATE_BODY",
      }),
      { timeoutMs: 1000 },
    );
    assert.deepEqual(result, {
      state: "reachable",
      reason: "http-response",
      latencyMs: result.latencyMs,
      transport: { type: "http", address: "127.0.0.1", family: 4, httpStatus: status },
    });
    assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE"));
    const request = received.at(-1);
    assert.equal(request.method, "HEAD");
    assert.equal(request.url, confirmedPath);
    assert.equal(request.headers.host, `127.0.0.1:${port}`);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["proxy-authorization"], undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers["content-length"], undefined);
    assert.equal(request.headers["transfer-encoding"], undefined);
    assert.equal(request.body, "");
  }
  assert.equal(received.length, 8, "redirects must not produce another request");
  await socketsClosed(sockets);
});

test("pinned HTTP and TCP use no DNS or environment proxy and preserve original HTTP Host", async (t) => {
  const hosts = [];
  const server = http.createServer((request, response) => {
    hosts.push(request.headers.host);
    response.writeHead(204).end();
  });
  const target = await listen(t, server);
  let proxyRequests = 0;
  const proxy = await listen(
    t,
    http.createServer((_request, response) => {
      proxyRequests++;
      response.writeHead(418).end();
    }),
  );
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  const results = await isolated(
    pinnedChildSource([
      endpoint(target.port, { hostname: "pinned.synthetic.test" }),
      endpoint(target.port, { hostname: "pinned.synthetic.test", protocol: "tcp:" }),
    ]),
    {
      NODE_USE_ENV_PROXY: "1",
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
      NO_PROXY: "",
      no_proxy: "",
    },
  );
  assert.equal(results[0].state, "reachable");
  assert.equal(results[0].transport.httpStatus, 204);
  assert.equal(results[1].reason, "tcp-connected");
  assert.deepEqual(hosts, [`pinned.synthetic.test:${target.port}`]);
  assert.equal(proxyRequests, 0);
  await socketsClosed(target.sockets);
  await socketsClosed(proxy.sockets);
});

test("TCP only proves an accepting port and sends no application bytes", async (t) => {
  let bytes = 0;
  const server = net.createServer((socket) =>
    socket.on("data", (chunk) => (bytes += chunk.length)),
  );
  const { port, sockets } = await listen(t, server);
  const result = await checkEndpoint(endpoint(port, { protocol: "tcp:" }), { timeoutMs: 1000 });
  assert.equal(result.state, "reachable");
  assert.equal(result.reason, "tcp-connected");
  assert.deepEqual(result.transport, { type: "tcp", address: "127.0.0.1", family: 4 });
  await socketsClosed(sockets);
  assert.equal(bytes, 0);
});

test("closed loopback ports return a sanitized refused result", async (t) => {
  const server = net.createServer();
  const { port } = await listen(t, server);
  await new Promise((resolve) => server.close(resolve));
  for (const protocol of ["http:", "tcp:"]) {
    const result = await checkEndpoint(endpoint(port, { protocol }), { timeoutMs: 1000 });
    assert.equal(result.state, "unreachable");
    assert.equal(result.reason, "refused");
    assert.deepEqual(Object.keys(result).sort(), ["latencyMs", "reason", "state", "transport"]);
  }
});

test("timeout covers incomplete HEAD responses and TLS handshakes and closes owned sockets", async (t) => {
  const httpServer = http.createServer((request) => request.resume());
  const httpTarget = await listen(t, httpServer);
  const tlsTarget = await listen(
    t,
    net.createServer((socket) => socket.resume()),
  );
  for (const [target, protocol] of [
    [httpTarget, "http:"],
    [tlsTarget, "https:"],
  ]) {
    const result = await checkEndpoint(endpoint(target.port, { protocol }), { timeoutMs: 60 });
    assert.equal(result.state, "unreachable");
    assert.equal(result.reason, "timeout");
    assert.ok(result.latencyMs >= 30 && result.latencyMs < 1200);
    assert.equal(result.transport.httpStatus, undefined);
    await socketsClosed(target.sockets);
  }
});

test("abort promptly closes active HTTP and TLS sockets and never exposes its reason", async (t) => {
  for (const protocol of ["http:", "https:"]) {
    const server =
      protocol === "http:"
        ? http.createServer((request) => request.resume())
        : net.createServer((socket) => socket.resume());
    const { port, sockets } = await listen(t, server);
    const connected = once(server, "connection");
    const controller = new AbortController();
    const pending = checkEndpoint(endpoint(port, { protocol }), {
      timeoutMs: 3000,
      signal: controller.signal,
    });
    await connected;
    const abortedAt = Date.now();
    controller.abort(new Error("SYNTHETIC_PRIVATE_ABORT"));
    const result = await pending;
    assert.equal(result.state, "cancelled");
    assert.equal(result.reason, "cancelled");
    assert.ok(Date.now() - abortedAt < 500);
    assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_ABORT"));
    await socketsClosed(sockets);
  }
});

test("pre-abort and exhausted budget create no connection, with cancellation taking precedence", async (t) => {
  let connections = 0;
  const server = net.createServer();
  server.on("connection", () => connections++);
  const { port } = await listen(t, server);
  const controller = new AbortController();
  controller.abort();
  for (const protocol of ["http:", "https:", "tcp:"]) {
    const target = endpoint(port, { protocol });
    assert.equal((await checkEndpoint(target, { timeoutMs: 0 })).reason, "timeout");
    assert.equal(
      (await checkEndpoint(target, { signal: controller.signal, timeoutMs: 0 })).state,
      "cancelled",
    );
  }
  await delay(20);
  assert.equal(connections, 0);
});

test("results wait for socket and request close, including abort before the deferred socket event", async (t) => {
  const success = await listen(
    t,
    http.createServer((_request, response) => response.writeHead(204).end()),
  );
  const stalled = await listen(
    t,
    http.createServer((request) => request.resume()),
  );
  const stalledTls = await listen(
    t,
    net.createServer((socket) => socket.resume()),
  );
  const results = await isolated(`
    import assert from "node:assert/strict";
    import { once } from "node:events";
    import net from "node:net";
    import tls from "node:tls";
    import http from "node:http";
    import https from "node:https";
    import { syncBuiltinESMExports } from "node:module";
    const sockets = [];
    const requests = [];
    function trackSocket(socket) {
      const tracked = { socket, closed: false };
      sockets.push(tracked);
      socket.once("close", () => tracked.closed = true);
      return socket;
    }
    const originalNet = net.createConnection;
    const originalTls = tls.connect;
    net.createConnection = (...args) => trackSocket(originalNet(...args));
    tls.connect = (...args) => trackSocket(originalTls(...args));
    for (const client of [http, https]) {
      const originalRequest = client.request;
      client.request = (...args) => {
        const request = originalRequest(...args);
        const tracked = { closed: false, socketEvents: 0 };
        requests.push(tracked);
        request.once("close", () => tracked.closed = true);
        request.on("socket", () => tracked.socketEvents++);
        return request;
      };
    }
    syncBuiltinESMExports();
    const { checkEndpoint } = await import(${JSON.stringify(transportUrl)});
    const results = [];
    async function run(target, mode = "normal") {
      const socketStart = sockets.length;
      const requestStart = requests.length;
      const controller = new AbortController();
      const pending = checkEndpoint(target, {
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 40 : 1000,
      });
      if (mode === "immediate") controller.abort();
      if (mode === "connected") {
        const socket = sockets.at(-1).socket;
        if (socket.connecting) await once(socket, "connect");
        controller.abort();
      }
      const result = await pending;
      assert.equal(sockets.length - socketStart, 1);
      assert.ok(sockets.slice(socketStart).every((item) => item.closed), "socket close must precede result");
      assert.ok(requests.slice(requestStart).every((item) => item.closed), "request close must precede result");
      if (mode === "immediate") {
        assert.ok(requests.slice(requestStart).every((item) => item.socketEvents === 0));
        assert.equal(result.state, "cancelled");
      }
      if (mode === "connected") assert.equal(result.state, "cancelled");
      if (mode === "timeout") assert.equal(result.reason, "timeout");
      if (mode === "normal") assert.equal(result.state, "reachable");
      results.push(result.reason);
    }
    await run(${JSON.stringify(endpoint(success.port))});
    await run(${JSON.stringify(endpoint(success.port, { protocol: "tcp:" }))});
    await run(${JSON.stringify(endpoint(stalled.port))}, "timeout");
    await run(${JSON.stringify(endpoint(stalledTls.port, { protocol: "https:" }))}, "timeout");
    await run(${JSON.stringify(endpoint(stalled.port))}, "connected");
    await run(${JSON.stringify(endpoint(stalledTls.port, { protocol: "https:" }))}, "connected");
    await run(${JSON.stringify(endpoint(stalled.port))}, "immediate");
    await run(${JSON.stringify(endpoint(stalledTls.port, { protocol: "https:" }))}, "immediate");
    await run(${JSON.stringify(endpoint(stalled.port, { protocol: "tcp:" }))}, "immediate");
    console.log(JSON.stringify(results));
  `);
  assert.equal(results.length, 9);
  await socketsClosed(success.sockets);
  await socketsClosed(stalled.sockets);
  await socketsClosed(stalledTls.sockets);
});

test("an incomplete response is a network error without response details", async (t) => {
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nX-Synthetic: hidden\r\n"));
  });
  const { port, sockets } = await listen(t, server);
  const result = await checkEndpoint(endpoint(port), { timeoutMs: 1000 });
  assert.equal(result.state, "unreachable");
  assert.equal(result.reason, "network-error");
  assert.equal(result.transport.httpStatus, undefined);
  assert.ok(!JSON.stringify(result).includes("hidden"));
  await socketsClosed(sockets);
});

test("HTTPS keeps certificate validation, original hostname identity and SNI when pinned to an IP", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dsh-transport-cert-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const keyPath = path.join(directory, "ephemeral-key.pem");
  const certPath = path.join(directory, "ephemeral-cert.pem");
  await runFile("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-subj",
    "/CN=pinned.synthetic.test",
    "-addext",
    "subjectAltName=DNS:pinned.synthetic.test",
  ]);
  const received = [];
  const server = https.createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      received.push({ host: request.headers.host, servername: request.socket.servername });
      response.writeHead(204).end();
    },
  );
  const { port, sockets } = await listen(t, server);
  const untrusted = await checkEndpoint(endpoint(port, { protocol: "https:" }), {
    timeoutMs: 1000,
  });
  assert.equal(untrusted.state, "unreachable");
  assert.equal(untrusted.reason, "tls-error");
  assert.equal(received.length, 0);

  const results = await isolated(
    pinnedChildSource([
      endpoint(port, { protocol: "https:", hostname: "pinned.synthetic.test" }),
      endpoint(port, { protocol: "https:", hostname: "different.synthetic.test" }),
      endpoint(port, { protocol: "https:", hostname: "127.0.0.1" }),
    ]),
    { NODE_EXTRA_CA_CERTS: certPath },
  );
  assert.equal(results[0].state, "reachable");
  assert.equal(results[0].transport.httpStatus, 204);
  assert.equal(results[1].reason, "tls-error");
  assert.equal(results[2].reason, "tls-error");
  assert.deepEqual(received, [
    { host: `pinned.synthetic.test:${port}`, servername: "pinned.synthetic.test" },
  ]);
  await socketsClosed(sockets);
});

test("invalid endpoints and timeout values are rejected before network I/O without echoing input", async () => {
  const target = endpoint(12345);
  for (const change of [
    { protocol: "socks:" },
    { protocol: "udp:" },
    { address: "SYNTHETIC_PRIVATE_TARGET" },
    { family: 6 },
    { hostname: "user:SYNTHETIC_PRIVATE_PASSWORD@synthetic.test" },
    { hostname: "synthetic.test\r\nAuthorization: SYNTHETIC_PRIVATE_AUTH" },
    { port: 0 },
    { port: 65536 },
    { path: "/SYNTHETIC_PRIVATE_PATH\r\nheader" },
  ]) {
    await assert.rejects(
      checkEndpoint({ ...target, ...change }),
      (error) => error.code === "INVALID_INPUT" && !error.message.includes("SYNTHETIC_PRIVATE"),
    );
  }
  for (const timeoutMs of [-1, NaN, Infinity, 2 ** 31]) {
    await assert.rejects(checkEndpoint(target, { timeoutMs }), { code: "INVALID_INPUT" });
    await assert.rejects(resolveAddresses("127.0.0.1", { timeoutMs }), { code: "INVALID_INPUT" });
  }
});
