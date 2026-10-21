import { Buffer } from "node:buffer";
import { isIP } from "node:net";

function fieldBytes(fields) {
  const bytes = [];
  for (const field of fields) {
    if (field.includes(".")) {
      bytes.push(...field.split(".").map(Number));
    } else {
      const word = Number.parseInt(field, 16);
      bytes.push(word >>> 8, word & 0xff);
    }
  }
  return bytes;
}

/** Parse a bare IP literal into a fresh Buffer in network byte order. */
export function parseIpBytes(input) {
  if (typeof input !== "string" || input.length > 45 || /[^0-9a-fA-F:.]/.test(input)) {
    return null;
  }

  const family = isIP(input);
  if (family === 0) return null;
  if (family === 4) {
    return { family, bytes: Buffer.from(input.split(".").map(Number)) };
  }

  // isIP has established the field counts, one optional gap, and IPv4-tail syntax.
  const [head, tail] = input.split("::");
  const prefix = fieldBytes(head ? head.split(":") : []);
  const suffix = fieldBytes(tail ? tail.split(":") : []);
  const bytes = Buffer.alloc(16);
  bytes.set(prefix);
  bytes.set(suffix, 16 - suffix.length);
  return { family, bytes };
}
