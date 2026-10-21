import { lookup } from "node:dns/promises";
import { nat64Prefixes } from "../core/nat64.js";

/** Observe the verified 0.2.1-rc.2 resolver's own discovery, without a second query.
 * The adapter gates the native function's identity before reaching this boundary.
 */
export async function resolveNativeHttp(native, hostname, signal) {
  let records;
  let discoveries = 0;
  const addresses = await native.resolveAddresses(hostname, signal, async (name, options) => {
    const result = await lookup(name, options);
    if (name === "ipv4only.arpa") {
      discoveries++;
      // Snapshot before the native consumer receives the response. Only bounded
      // address metadata is needed; the original lookup result is returned intact.
      records =
        Array.isArray(result) && result.length <= 256
          ? result.map((entry) => ({ address: entry?.address, family: entry?.family }))
          : undefined;
    }
    return result;
  });
  return {
    addresses,
    discovery: nat64Prefixes(discoveries === 1 ? records : undefined),
  };
}
