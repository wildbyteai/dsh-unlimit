import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { createConnection, isIP } from "node:net";
import { performance } from "node:perf_hooks";
import { checkServerIdentity, connect as connectTls } from "node:tls";

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

function invalidInput() {
  return Object.assign(new Error("Invalid connection request"), { code: "INVALID_INPUT" });
}

function optionsFor({ signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    (signal != null && !(signal instanceof AbortSignal))
  )
    throw invalidInput();
  return { signal, timeoutMs };
}

function resolutionError(code) {
  return Object.assign(new Error("Address resolution did not complete"), { code });
}

/** System lookup only. A late native lookup callback cannot resume a cancelled caller. */
export async function resolveAddresses(hostname, options) {
  const { signal, timeoutMs } = optionsFor(options);
  if (typeof hostname !== "string" || !hostname || /[\s\u0000]/u.test(hostname))
    throw invalidInput();
  if (signal?.aborted) throw resolutionError("DNS_CANCELLED");
  if (timeoutMs === 0) throw resolutionError("DNS_TIMEOUT");

  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, addresses) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(addresses.map(({ address, family }) => ({ address, family })));
    };
    const onAbort = () => finish(resolutionError("DNS_CANCELLED"));
    const timer = setTimeout(() => finish(resolutionError("DNS_TIMEOUT")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) finish(resolutionError("DNS_ERROR"));
        else finish(null, addresses);
      });
    } catch {
      finish(resolutionError("DNS_ERROR"));
    }
  });
}

function endpointFor(endpoint) {
  if (!endpoint || typeof endpoint !== "object") throw invalidInput();
  const { protocol, hostname, address, family, port, path = "/" } = endpoint;
  const originalHostname =
    typeof hostname === "string" && hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (
    !["http:", "https:", "tcp:"].includes(protocol) ||
    typeof originalHostname !== "string" ||
    !originalHostname ||
    originalHostname.length > 253 ||
    (!isIP(originalHostname) && !/^[a-zA-Z0-9._-]+$/.test(originalHostname)) ||
    typeof address !== "string" ||
    ![4, 6].includes(family) ||
    isIP(address) !== family ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    /[\u0000-\u0020\u007f-\uffff]/u.test(path)
  )
    throw invalidInput();
  return { protocol, hostname: originalHostname, address, family, port, path };
}

function failureReason(error) {
  if (error?.code === "ECONNREFUSED") return "refused";
  if (error?.code === "ETIMEDOUT") return "timeout";
  if (
    /^(?:ERR_(?:TLS|SSL)_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_(?:VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT(?:_LOCALLY)?|GET_CRL)$)/.test(
      error?.code ?? "",
    )
  )
    return "tls-error";
  return "network-error";
}

/** One direct connection to the already-authorized IP; no proxy, redirect or retry. */
export async function checkEndpoint(endpoint, options) {
  const target = endpointFor(endpoint);
  const { signal, timeoutMs } = optionsFor(options);
  const started = performance.now();
  const transport = {
    type: target.protocol === "tcp:" ? "tcp" : "http",
    address: target.address,
    family: target.family,
  };

  return new Promise((resolve) => {
    let finished = false;
    let timer;
    let socket;
    let socketClosed = false;
    let request;
    let requestClosed = false;
    let response;
    let outcome;
    const complete = () => {
      if (!outcome || (socket && !socketClosed) || (request && !requestClosed)) return;
      resolve({
        ...outcome,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      });
    };
    const ownSocket = (ownedSocket) => {
      socket = ownedSocket;
      socket.once("close", () => {
        socketClosed = true;
        complete();
      });
      return socket;
    };
    const finish = (state, reason, httpStatus) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      outcome = {
        state,
        reason,
        transport: httpStatus === undefined ? transport : { ...transport, httpStatus },
      };
      response?.destroy();
      request?.destroy();
      socket?.destroy();
      complete();
    };
    const onAbort = () => finish("cancelled", "cancelled");
    const onError = (error) => finish("unreachable", failureReason(error));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (timeoutMs === 0) {
      finish("unreachable", "timeout");
      return;
    }
    timer = setTimeout(() => finish("unreachable", "timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    try {
      if (target.protocol === "tcp:") {
        ownSocket(
          createConnection({
            host: target.address,
            port: target.port,
            family: target.family,
          }),
        );
        socket.once("error", onError);
        socket.once("connect", () => finish("reachable", "tcp-connected"));
        return;
      }

      const host = isIP(target.hostname) === 6 ? `[${target.hostname}]` : target.hostname;
      const client = target.protocol === "https:" ? https : http;
      request = client.request({
        protocol: target.protocol,
        hostname: target.address,
        family: target.family,
        port: target.port,
        method: "HEAD",
        path: target.path,
        headers: { Host: `${host}:${target.port}` },
        // Supplying createConnection without an Agent avoids proxies and records
        // the socket before ClientRequest's deferred "socket" event can run.
        createConnection: () => {
          const socketOptions = {
            host: target.address,
            port: target.port,
            family: target.family,
          };
          return ownSocket(
            target.protocol === "https:"
              ? connectTls({
                  ...socketOptions,
                  rejectUnauthorized: true,
                  servername: isIP(target.hostname) ? "" : target.hostname,
                  checkServerIdentity: (_hostname, certificate) =>
                    checkServerIdentity(target.hostname, certificate),
                })
              : createConnection(socketOptions),
          );
        },
      });
      request.once("error", onError);
      request.once("response", (incoming) => {
        response = incoming;
        incoming.once("error", onError);
        incoming.once("aborted", () => finish("unreachable", "network-error"));
        incoming.once("end", () => {
          if (incoming.complete) finish("reachable", "http-response", incoming.statusCode);
          else finish("unreachable", "network-error");
        });
        incoming.resume();
      });
      request.once("close", () => {
        requestClosed = true;
        if (!finished && !response) finish("unreachable", "network-error");
        complete();
      });
      request.end();
    } catch (error) {
      onError(error);
    }
  });
}
