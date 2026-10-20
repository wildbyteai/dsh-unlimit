import { isIP } from "node:net";
import { domainToASCII } from "node:url";

function reject(message) {
  throw Object.assign(new Error(message), { code: "INVALID_INPUT" });
}

/** Inventory parsing only. Saving a host is never a network access grant. */
export function normalizeServers(entries) {
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string"))
    reject("ownServers must be an array of strings");
  const result = new Set();
  for (const [index, entry] of entries.entries()) {
    const invalid = () =>
      reject(
        `ownServers entry ${index + 1} must be one IP or complete hostname, optionally username@host; passwords, keys, URLs, ports, wildcards and networks are not accepted`,
      );
    const value = entry.trim();
    if (!value) continue;
    if (/\s|[/\\?#*%]|:\/\//.test(value)) invalid();
    const parts = value.split("@");
    if (parts.length > 2) invalid();
    const username = parts.length === 2 ? parts[0] : "";
    if (parts.length === 2 && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(username)) invalid();
    let host = parts.at(-1);
    const bracketed = host.startsWith("[") && host.endsWith("]");
    if (bracketed) host = host.slice(1, -1);
    const version = isIP(host);
    if (bracketed && version !== 6) invalid();
    if (version === 6) {
      // URL canonicalization only: no DNS lookup or outbound request.
      host = new URL(`http://[${host}]/`).hostname;
    } else if (version !== 4) {
      host = domainToASCII(host.replace(/\.$/, "")).toLowerCase();
      if (
        !host ||
        host.length > 253 ||
        !host.includes(".") ||
        /^[\d.]+$/.test(host) ||
        host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      )
        invalid();
    }
    result.add(`${username ? `${username}@` : ""}${host}`);
  }
  return [...result];
}
