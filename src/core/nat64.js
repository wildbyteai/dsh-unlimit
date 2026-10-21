import { isIP } from "node:net";
import { parseIpBytes } from "./ip-bytes.js";

const LENGTHS = [32, 40, 48, 56, 64, 96];
const MAX_RECORDS = 256;
const SENTINELS = [170, 171];
// RFC 6052 sections 2.2/2.3: byte 8 is reserved, even in /96 prefixes.
// Each row contains the four IPv4 byte positions, in network byte order.
const POSITIONS = new Map([
  [32, [4, 5, 6, 7]],
  [40, [5, 6, 7, 9]],
  [48, [6, 7, 9, 10]],
  [56, [7, 9, 10, 11]],
  [64, [9, 10, 11, 12]],
  [96, [12, 13, 14, 15]],
]);
const unknownDiscovery = () => ({
  known: false,
  prefixes: [],
  reason: "nat64-discovery-unknown",
});
function ipv6(value) {
  const parsed = parseIpBytes(value);
  if (parsed?.family !== 6) return null;
  // WHATWG URL canonicalizes mixed dotted/hex forms without DNS or I/O.
  const address = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return { address, bytes: parsed.bytes };
}
const embedded = (bytes, length) => POSITIONS.get(length).map((index) => bytes[index]);
const sentinel = (bytes) =>
  bytes[0] === 192 && bytes[1] === 0 && bytes[2] === 0 && SENTINELS.includes(bytes[3]);
function prefixFor(bytes, length) {
  const network = Buffer.alloc(16);
  bytes.copy(network, 0, 0, length / 8);
  return { length, hex: network.toString("hex") };
}
const prefixKey = ({ length, hex }) => `${length}:${hex}`;

function occurrences(bytes, last) {
  const matches = new Set();
  const scan = (positions) => {
    for (let offset = 0; offset <= positions.length - 4; offset++) {
      const indexes = positions.slice(offset, offset + 4);
      const value = indexes.map((index) => bytes[index]);
      if (sentinel(value) && value[3] === last) matches.add(indexes.join(","));
    }
  };
  // Check every byte boundary, including prefix/suffix occurrences. Also remove
  // u for the split layouts, retaining original positions to deduplicate scans.
  const all = Array.from({ length: 16 }, (_, index) => index);
  scan(all);
  scan(all.filter((index) => index !== 8));
  return matches.size;
}

/** Discover only standard RFC 6052 layouts from a caller-supplied DNS snapshot.
 * RFC 7050 section 3 supplies the two WKA values and ambiguity rule. No query is
 * performed here; a missing or partly unexplained snapshot remains unknown.
 */
export function nat64Prefixes(records) {
  if (!Array.isArray(records) || !records.length || records.length > MAX_RECORDS)
    return unknownDiscovery();
  const observations = [];
  const prefixes = new Map();
  for (const record of records) {
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      ![4, 6].includes(record.family) ||
      typeof record.address !== "string" ||
      record.address.includes("%") ||
      isIP(record.address) !== record.family
    )
      return unknownDiscovery();
    if (record.family === 4) {
      if (!["192.0.0.170", "192.0.0.171"].includes(record.address)) return unknownDiscovery();
      continue;
    }
    const parsed = ipv6(record.address);
    if (!parsed || parsed.bytes[8] !== 0) return unknownDiscovery();
    const counts = new Map(SENTINELS.map((last) => [last, occurrences(parsed.bytes, last)]));
    const candidates = [];
    for (const length of LENGTHS) {
      const decoded = embedded(parsed.bytes, length);
      if (!sentinel(decoded)) continue;
      const prefix = prefixFor(parsed.bytes, length);
      const key = prefixKey(prefix);
      candidates.push({ key, last: decoded[3], unique: counts.get(decoded[3]) === 1 });
      if (!prefixes.has(key))
        prefixes.set(key, {
          prefix,
          sentinels: new Set(),
          unique: false,
          ambiguous: false,
          single: false,
        });
    }
    if (!candidates.length) return unknownDiscovery();
    for (const candidate of candidates) {
      const evidence = prefixes.get(candidate.key);
      evidence.sentinels.add(candidate.last);
      evidence.unique ||= candidate.unique;
      evidence.ambiguous ||= !candidate.unique;
      evidence.single ||= candidates.length === 1 && candidate.unique;
    }
    observations.push(candidates);
  }
  const confirmed = new Map();
  for (const [key, evidence] of prefixes) {
    // A repeated WKA inside a prefix/suffix cannot identify its own position.
    // A second sentinel under the same prefix can disambiguate it, provided
    // at least that alternate observation contains its WKA only once.
    if (evidence.single || (evidence.sentinels.size === 2 && evidence.unique && evidence.ambiguous))
      confirmed.set(key, evidence.prefix);
  }
  if (
    observations.some((candidates) => !candidates.some((candidate) => confirmed.has(candidate.key)))
  )
    return unknownDiscovery();
  return { known: true, prefixes: [...confirmed.values()] };
}

function discoveryPrefixes(discovery) {
  if (
    !discovery ||
    discovery.known !== true ||
    !Array.isArray(discovery.prefixes) ||
    discovery.prefixes.length > MAX_RECORDS * LENGTHS.length
  )
    return null;
  const prefixes = [];
  for (const prefix of discovery.prefixes) {
    if (
      !prefix ||
      Array.isArray(prefix) ||
      !LENGTHS.includes(prefix.length) ||
      typeof prefix.hex !== "string" ||
      !/^[a-f0-9]{32}$/.test(prefix.hex)
    )
      return null;
    const bytes = Buffer.from(prefix.hex, "hex");
    if (bytes[8] !== 0 || bytes.subarray(prefix.length / 8).some((byte) => byte !== 0)) return null;
    prefixes.push({ length: prefix.length, bytes });
  }
  return prefixes;
}
function matches(bytes, prefix) {
  for (let index = 0; index < prefix.length / 8; index++) {
    // Keep a malformed /96 u byte in the translation boundary rather than
    // misclassifying it as a different, native IPv6 prefix.
    if (index !== 8 && bytes[index] !== prefix.bytes[index]) return false;
  }
  return true;
}

/** Classify an IPv6 surface address without performing a lookup or changing
 * caller-owned discovery records. Translated destinations are dotted IPv4.
 */
export function ipv6Destination(address, discovery) {
  const parsed = ipv6(address);
  if (!parsed) return { kind: "unknown", address: "", reason: "ipv6-invalid" };
  const { bytes } = parsed;
  if (bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255)
    return { kind: "native", address: parsed.address };
  const prefixes = discoveryPrefixes(discovery);
  if (!prefixes)
    return { kind: "unknown", address: parsed.address, reason: "nat64-discovery-unknown" };
  const destinations = new Set();
  for (const prefix of prefixes) {
    if (!matches(bytes, prefix)) continue;
    if (bytes[8] !== 0) return { kind: "unknown", address: parsed.address, reason: "nat64-u-byte" };
    destinations.add(embedded(bytes, prefix.length).join("."));
  }
  if (destinations.size > 1)
    return { kind: "unknown", address: parsed.address, reason: "nat64-prefix-overlap" };
  if (destinations.size === 1) return { kind: "translated", address: [...destinations][0] };
  return { kind: "native", address: parsed.address };
}
