import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { StoreError, fail, object, string } from "./validation.js";

export const FILE_LIMITS = Object.freeze({
  textBytes: 1024 * 1024,
  fileBytes: 10 * 1024 * 1024,
  batchBytes: 20 * 1024 * 1024,
  batchFiles: 128,
  imageDimension: 16384,
  imagePixels: 40000000,
});
const utf8 = new TextDecoder("utf-8", { fatal: true });
const MANIFEST = ".manifest.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (manifest, path) => (Object.hasOwn(manifest, path) ? manifest[path] : {});
function relative(value) {
  string(value, "path");
  const parts = value.split("/");
  if (
    value.includes("\\") ||
    /^[a-z]:/i.test(value) ||
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\u0000-\u001f:*?"<>|]/u.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    fail("INVALID_PATH", "Use a safe relative path within the selected workspace");
  if (
    parts.some(
      (part) =>
        [".backups", MANIFEST].includes(part.toLowerCase()) ||
        part.toLowerCase().startsWith(".stage-"),
    )
  )
    fail("INVALID_PATH", "Internal file-library paths are reserved");
  if (Buffer.byteLength(value) > 1024 || parts.some((part) => Buffer.byteLength(part) > 255))
    fail("LIMIT_EXCEEDED", "File path is too long");
  return parts.map((part) => part.normalize("NFC")).join("/");
}
function identifier(value) {
  string(value, "identifier");
  if (!/^[\p{L}\p{N}_-]+$/u.test(value))
    fail("INVALID_PATH", "Invalid workspace or backup identifier");
  return value;
}
function bytesOf(payload) {
  if ((payload.content === undefined) === (payload.contentBase64 === undefined))
    fail("INVALID_INPUT", "Provide exactly one of content or contentBase64");
  if (payload.content !== undefined) {
    const content = string(payload.content, "content", { empty: true });
    if (Buffer.byteLength(content) > FILE_LIMITS.textBytes)
      fail("LIMIT_EXCEEDED", "Text material exceeds 1 MiB");
    return Buffer.from(content);
  }
  const encoded = string(payload.contentBase64, "contentBase64", { empty: true });
  if (encoded.length > Math.ceil(FILE_LIMITS.fileBytes / 3) * 4)
    fail("LIMIT_EXCEEDED", "File material exceeds 10 MiB");
  if (encoded.length % 4 || /[^a-zA-Z0-9+/=]/.test(encoded))
    fail("INVALID_INPUT", "Invalid base64 material");
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > FILE_LIMITS.fileBytes) fail("LIMIT_EXCEEDED", "File material exceeds 10 MiB");
  if (bytes.toString("base64") !== encoded) fail("INVALID_INPUT", "Invalid base64 material");
  return bytes;
}
function dimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > FILE_LIMITS.imageDimension ||
    height > FILE_LIMITS.imageDimension ||
    width * height > FILE_LIMITS.imagePixels
  )
    throw new Error("Image dimensions are invalid or exceed preview limits");
  return { width, height };
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  let offset = 8,
    size,
    data = false,
    ended = false,
    count = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString("ascii", offset + 4, offset + 8),
      end = offset + 12 + length;
    if (
      end > bytes.length ||
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      throw new Error("Invalid PNG chunk length or CRC");
    if (count++ === 0) {
      if (type !== "IHDR" || length !== 13) throw new Error("PNG requires an IHDR header");
      size = dimensions(bytes.readUInt32BE(offset + 8), bytes.readUInt32BE(offset + 12));
      const depth = bytes[offset + 16],
        color = bytes[offset + 17];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (
        !depths[color]?.includes(depth) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] > 1
      )
        throw new Error("Invalid PNG header fields");
    } else if (type === "IHDR") throw new Error("Duplicate PNG header");
    if (type === "IDAT" && length > 0) data = true;
    if (type === "IEND") {
      if (length !== 0 || !data || end !== bytes.length) throw new Error("Invalid PNG end");
      ended = true;
    }
    offset = end;
  }
  if (!ended) throw new Error("PNG has no complete image body and end");
  return size;
}
function jpeg(bytes) {
  if (bytes.length < 4 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
    throw new Error("Truncated JPEG");
  let offset = 2,
    size;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) throw new Error("Invalid JPEG marker");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (offset + 2 > bytes.length - 2 || [0, 0xd8, 0xd9].includes(marker))
      throw new Error("Invalid JPEG segment");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const length = bytes.readUInt16BE(offset),
      end = offset + length;
    if (length < 2 || end > bytes.length - 2) throw new Error("Truncated JPEG segment");
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (
        length < 8 ||
        ![8, 12, 16].includes(bytes[offset + 2]) ||
        length !== 8 + 3 * bytes[offset + 7]
      )
        throw new Error("Invalid JPEG frame header");
      size = dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    if (marker === 0xda) {
      if (!size || length < 6 || end >= bytes.length - 2)
        throw new Error("JPEG scan has no valid frame or body");
      return size;
    }
    offset = end;
  }
  throw new Error("JPEG has no image scan");
}
function gif(bytes) {
  if (bytes.length < 14) throw new Error("Truncated GIF header");
  const size = dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
  let offset = 13 + (bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0),
    images = 0;
  const blocks = () => {
    let total = 0;
    while (offset < bytes.length) {
      const length = bytes[offset++];
      if (!length) return total;
      if (offset + length > bytes.length) throw new Error("Truncated GIF block");
      total += length;
      offset += length;
    }
    throw new Error("Unterminated GIF block");
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!images || offset !== bytes.length) throw new Error("Invalid GIF trailer");
      return size;
    }
    if (marker === 0x21) {
      if (offset >= bytes.length) throw new Error("Truncated GIF extension");
      offset++;
      blocks();
    } else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) throw new Error("Truncated GIF image descriptor");
      const left = bytes.readUInt16LE(offset),
        top = bytes.readUInt16LE(offset + 2),
        frame = dimensions(bytes.readUInt16LE(offset + 4), bytes.readUInt16LE(offset + 6));
      if (left + frame.width > size.width || top + frame.height > size.height)
        throw new Error("GIF frame exceeds canvas");
      const packed = bytes[offset + 8];
      offset += 9 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8)
        throw new Error("Invalid GIF image data");
      offset++;
      if (!blocks()) throw new Error("Empty GIF image data");
      images++;
    } else throw new Error("Invalid GIF block marker");
  }
  throw new Error("GIF has no complete trailer");
}
function webpFrame(bytes, type) {
  if (type === "VP8 ") {
    if (
      bytes.length < 11 ||
      bytes[0] & 1 ||
      !bytes.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      throw new Error("Invalid WebP VP8 frame");
    return dimensions(bytes.readUInt16LE(6) & 0x3fff, bytes.readUInt16LE(8) & 0x3fff);
  }
  if (bytes.length < 6 || bytes[0] !== 0x2f || bytes[4] & 0xe0)
    throw new Error("Invalid WebP VP8L frame");
  const bits = bytes.readUInt32LE(1);
  return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}
function webp(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length)
    throw new Error("Invalid WebP RIFF length");
  let offset = 12,
    canvas,
    image,
    animated = false,
    frames = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error("Truncated WebP chunk");
    const type = bytes.toString("ascii", offset, offset + 4),
      length = bytes.readUInt32LE(offset + 4),
      end = offset + 8 + length;
    if (end + (length & 1) > bytes.length) throw new Error("Truncated WebP chunk data");
    const data = bytes.subarray(offset + 8, end);
    if (type === "VP8X") {
      if (length !== 10 || canvas || data[0] & ~0x3e || data[1] || data[2] || data[3])
        throw new Error("Invalid WebP extended header");
      canvas = dimensions(data.readUIntLE(4, 3) + 1, data.readUIntLE(7, 3) + 1);
      animated = Boolean(data[0] & 2);
    } else if (type === "VP8 " || type === "VP8L") {
      if (image || animated) throw new Error("Unexpected WebP image chunk");
      image = webpFrame(data, type);
    } else if (type === "ANMF") {
      if (!animated || !canvas || length < 24) throw new Error("Invalid WebP animation frame");
      const left = data.readUIntLE(0, 3) * 2,
        top = data.readUIntLE(3, 3) * 2,
        frame = dimensions(data.readUIntLE(6, 3) + 1, data.readUIntLE(9, 3) + 1);
      if (left + frame.width > canvas.width || top + frame.height > canvas.height)
        throw new Error("WebP frame exceeds canvas");
      let part = 16,
        frameImage;
      while (part < data.length) {
        if (part + 8 > data.length) throw new Error("Truncated WebP frame chunk");
        const kind = data.toString("ascii", part, part + 4),
          count = data.readUInt32LE(part + 4),
          stop = part + 8 + count;
        if (stop + (count & 1) > data.length) throw new Error("Truncated WebP frame data");
        if (kind === "VP8 " || kind === "VP8L") {
          if (frameImage) throw new Error("Duplicate WebP frame image");
          frameImage = webpFrame(data.subarray(part + 8, stop), kind);
        }
        part = stop + (count & 1);
      }
      if (!frameImage || frameImage.width !== frame.width || frameImage.height !== frame.height)
        throw new Error("WebP frame dimensions do not match");
      frames++;
    }
    offset = end + (length & 1);
  }
  if (animated) {
    if (!frames) throw new Error("WebP animation has no frames");
    return canvas;
  }
  if (!image || (canvas && (canvas.width !== image.width || canvas.height !== image.height)))
    throw new Error("WebP has no matching image frame");
  return canvas ?? image;
}
function inspectImage(bytes) {
  let format;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) format = "png";
  else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) format = "jpeg";
  else if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) format = "gif";
  else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
    format = "webp";
  if (!format) return null;
  try {
    return { format, ...{ png, jpeg, gif, webp }[format](bytes) };
  } catch (error) {
    return { format, error: error.message };
  }
}
function describe(path, bytes, metadata = {}) {
  const image = inspectImage(bytes);
  const extension = extname(path).toLowerCase();
  const textTypes = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".http": "application/http",
    ".log": "text/plain",
    ".csv": "text/csv",
    ".yaml": "text/plain",
    ".yml": "text/plain",
  };
  const mediaType =
    image && !image.error
      ? `image/${image.format}`
      : (textTypes[extension] ?? "application/octet-stream");
  return {
    ...metadata,
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    mediaType,
    previewable: Boolean(image && !image.error),
    ...(image && !image.error
      ? { width: image.width, height: image.height, imageValidation: "structure-only" }
      : {}),
    ...(image?.error ? { imageError: image.error } : {}),
  };
}

/** Owns local material files only. Saving HTTP, scripts or HTML never executes them. */
export class WorkspaceFiles {
  constructor(root, store) {
    string(root, "root");
    const requested = resolve(root);
    if (lstatSync(requested, { throwIfNoEntry: false })?.isSymbolicLink())
      fail("INVALID_PATH", "Material root cannot be a symlink");
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    this.root = realpathSync(requested);
    this.store = store;
  }
  safe(path, directory = false) {
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.root)
      fail("INVALID_PATH", "Material root changed");
    let current = this.root;
    for (const part of relative(path).split("/")) {
      const parent = lstatSync(current, { throwIfNoEntry: false });
      const target = join(current, part);
      if (parent?.isDirectory()) {
        const spelling = readdirSync(current).filter(
          (name) =>
            name.normalize("NFC").toLocaleLowerCase("en-US") === part.toLocaleLowerCase("en-US"),
        );
        if (spelling.length > 1 || spelling.some((name) => name.normalize("NFC") !== part))
          fail(
            "INVALID_PATH",
            "Use the existing material path spelling; case aliases are not allowed",
          );
        // macOS may report an NFD directory entry for the same NFC-addressable
        // file. Allow that one identity, but do not create a second canonically
        // equivalent entry on a filesystem that treats the spellings separately.
        if (
          spelling.length === 1 &&
          spelling[0] !== part &&
          !lstatSync(target, { throwIfNoEntry: false })
        )
          fail("INVALID_PATH", "A canonically equivalent material path already exists");
      }
      current = target;
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isSymbolicLink()) fail("INVALID_PATH", "Material paths cannot contain symlinks");
      if (current !== join(this.root, path) && !stat.isDirectory())
        fail("INVALID_PATH", "A parent path is not a directory");
      if (current === join(this.root, path) && directory && !stat.isDirectory())
        fail("INVALID_PATH", "Expected a material directory");
    }
    return current;
  }
  workspace(workspaceId) {
    identifier(workspaceId);
    this.store.get("workspaces", workspaceId);
    const directory = this.safe(workspaceId, true);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }
  // Internal paths bypass only the user-facing reserved-name rule, and are
  // still checked component by component without following a symlink.
  internal(parts, create = false) {
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.root)
      fail("INVALID_PATH", "Material root changed");
    let path = this.root;
    for (const part of parts) {
      path = join(path, part);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
        fail("INVALID_PATH", "Internal material directory is unsafe");
      if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    }
    return path;
  }
  manifest(workspaceId) {
    const path = join(this.workspace(workspaceId), MANIFEST);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return {};
    if (stat.isSymbolicLink() || !stat.isFile())
      fail("INVALID_PATH", "Material manifest is unsafe");
    try {
      return object(JSON.parse(readFileSync(path, "utf8")), "manifest");
    } catch {
      fail("INVALID_DATA", "Material manifest is unreadable");
    }
  }
  saveManifest(workspaceId, value) {
    const directory = this.workspace(workspaceId),
      path = join(directory, MANIFEST),
      stage = join(directory, `.stage-${randomUUID()}`);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat && (stat.isSymbolicLink() || !stat.isFile()))
      fail("INVALID_PATH", "Material manifest is unsafe");
    try {
      writeFileSync(stage, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(stage, path);
    } finally {
      if (existsSync(stage)) rmSync(stage);
    }
  }
  readBytes(workspaceId, path) {
    const target = this.safe(`${workspaceId}/${relative(path)}`);
    if (!existsSync(target)) fail("NOT_FOUND", "Material file was not found in this workspace");
    const stat = lstatSync(target);
    if (!stat.isFile()) fail("INVALID_PATH", "Expected a regular material file");
    if (stat.size > FILE_LIMITS.fileBytes) fail("LIMIT_EXCEEDED", "Material file exceeds 10 MiB");
    return readFileSync(target);
  }
  metadata(payload, previous = {}) {
    const result = { ...previous };
    if (payload.assetId !== undefined) {
      this.store.get("assets", payload.assetId, payload.workspaceId);
      result.assetId = payload.assetId;
    }
    for (const field of ["purpose", "source"])
      if (payload[field] !== undefined)
        result[field] = string(payload[field], field, { empty: true });
    if (payload.mediaType !== undefined) {
      const type = string(payload.mediaType, "mediaType");
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type))
        fail("INVALID_INPUT", "mediaType must be a MIME type without parameters");
      result.claimedMediaType = type;
    }
    return {
      ...result,
      createdAt: previous.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  backup(workspaceId, path, metadata) {
    const bytes = this.readBytes(workspaceId, path),
      backupId = randomUUID();
    const directory = this.internal([".backups", workspaceId, backupId], true);
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify({
        path,
        metadata,
        sha256: sha256(bytes),
        backedUpAt: new Date().toISOString(),
      }),
      { flag: "wx", mode: 0o600 },
    );
    renameSync(this.safe(`${workspaceId}/${path}`), join(directory, "data"));
    return { backupId, directory };
  }
  readBackup(workspaceId, backupId) {
    identifier(backupId);
    const source = this.internal([".backups", workspaceId, backupId]);
    const dataPath = join(source, "data"),
      metaPath = join(source, "metadata.json");
    const dataStat = lstatSync(dataPath, { throwIfNoEntry: false }),
      metaStat = lstatSync(metaPath, { throwIfNoEntry: false });
    if (!dataStat || !metaStat)
      fail("NOT_FOUND", "Recoverable backup was not found in this workspace");
    if ([dataStat, metaStat].some((stat) => stat.isSymbolicLink() || !stat.isFile()))
      fail("INVALID_PATH", "Backup contains an unsafe file");
    if (dataStat.size > FILE_LIMITS.fileBytes)
      fail("LIMIT_EXCEEDED", "Recoverable backup exceeds 10 MiB");
    let metadata;
    try {
      metadata = object(JSON.parse(readFileSync(metaPath, "utf8")), "backup metadata");
    } catch {
      fail("INVALID_DATA", "Recoverable backup metadata is invalid");
    }
    let path;
    try {
      path = relative(metadata.path);
      object(metadata.metadata, "backup file metadata");
    } catch {
      fail("INVALID_DATA", "Recoverable backup file metadata is invalid");
    }
    const bytes = readFileSync(dataPath);
    if (typeof metadata.sha256 !== "string" || sha256(bytes) !== metadata.sha256)
      fail("INVALID_DATA", "Recoverable backup checksum is invalid");
    return {
      path,
      bytes,
      metadata: metadata.metadata,
      ...(metadata.backedUpAt ? { backedUpAt: metadata.backedUpAt } : {}),
    };
  }
  backups(workspaceId) {
    const directory = this.internal([".backups", workspaceId]);
    if (!existsSync(directory)) return { items: [] };
    const items = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail("INVALID_PATH", "Backup directories cannot be symlinks");
      if (!entry.isDirectory() || !/^[\p{L}\p{N}_-]+$/u.test(entry.name)) continue;
      try {
        const backup = this.readBackup(workspaceId, entry.name);
        items.push({
          ...describe(backup.path, backup.bytes, backup.metadata),
          workspaceId,
          backupId: entry.name,
          ...(backup.backedUpAt ? { backedUpAt: backup.backedUpAt } : {}),
        });
      } catch (error) {
        // Failed rollbacks can leave a metadata-only directory. Corrupt or
        // oversized copies are never advertised as recoverable versions.
        if (!["NOT_FOUND", "INVALID_DATA", "LIMIT_EXCEEDED"].includes(error.code)) throw error;
      }
    }
    return { items };
  }
  recordChange(workspaceId, partial) {
    try {
      this.store.touchFiles(workspaceId);
    } catch {
      // Files and SQLite have no shared transaction. Never report a successful
      // write if its counter failed, or roll back already committed file data.
      const error = new StoreError(
        "RECOVERY_REQUIRED",
        "Material files changed but their change counter could not be saved; inspect the files before retrying",
      );
      error.partial = {
        workspaceId,
        ...partial,
        filesChanged: true,
        changeTrackingFailed: true,
      };
      throw error;
    }
  }
  recoveryError(workspaceId, stagingPath, backups) {
    const error = new StoreError(
      "RECOVERY_REQUIRED",
      "Material operation could not restore every file; recover the preserved versions explicitly",
    );
    error.partial = {
      workspaceId,
      stagingPath,
      backups,
      filesChanged: true,
      changeTrackingFailed: false,
    };
    this.recordChange(workspaceId, error.partial);
    return error;
  }
  install(workspaceId, items) {
    const original = this.manifest(workspaceId),
      next = { ...original },
      prepared = [],
      names = new Set();
    let total = 0;
    for (const input of items) {
      object(input, "file");
      if (input.workspaceId !== undefined && input.workspaceId !== workspaceId)
        fail("INVALID_INPUT", "Imported material workspace does not match");
      const path = relative(input.path),
        key = path.toLocaleLowerCase("en-US");
      if (names.has(key)) fail("INVALID_PATH", "Duplicate material paths are not allowed");
      names.add(key);
      const bytes = bytesOf(input);
      total += bytes.length;
      if (total > FILE_LIMITS.batchBytes) fail("LIMIT_EXCEEDED", "Import exceeds 20 MiB in total");
      const target = this.safe(`${workspaceId}/${path}`);
      if (existsSync(target)) this.readBytes(workspaceId, path);
      const metadata = this.metadata({ ...input, workspaceId }, record(original, path));
      prepared.push({ path, bytes, target, metadata });
      Object.defineProperty(next, path, {
        value: metadata,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    for (const file of prepared)
      for (const path of names)
        if (path.startsWith(`${file.path.toLocaleLowerCase("en-US")}/`))
          fail("INVALID_PATH", "A material file conflicts with a directory");
    const stageName = `.stage-${randomUUID()}`,
      stagingPath = `${workspaceId}/${stageName}`;
    const stage = this.internal([workspaceId, stageName], true),
      changes = [];
    let preserve = false,
      committed = false;
    try {
      for (let index = 0; index < prepared.length; index++)
        writeFileSync(join(stage, String(index)), prepared[index].bytes, {
          flag: "wx",
          mode: 0o600,
        });
      for (let index = 0; index < prepared.length; index++) {
        const file = prepared[index],
          change = { ...file, backup: null, installed: false };
        changes.push(change);
        if (existsSync(file.target))
          change.backup = this.backup(workspaceId, file.path, record(original, file.path));
        this.safe(`${workspaceId}/${file.path}`);
        mkdirSync(dirname(file.target), { recursive: true, mode: 0o700 });
        renameSync(join(stage, String(index)), file.target);
        change.installed = true;
      }
      this.saveManifest(workspaceId, next);
      committed = true;
    } catch (error) {
      const failures = [];
      for (const change of changes.reverse())
        try {
          if (change.installed) renameSync(change.target, join(stage, randomUUID()));
          if (change.backup) renameSync(join(change.backup.directory, "data"), change.target);
        } catch (recoveryError) {
          failures.push(recoveryError);
        }
      if (failures.length) {
        preserve = true;
        throw this.recoveryError(
          workspaceId,
          stagingPath,
          changes
            .filter((change) => change.backup)
            .map((change) => ({ path: change.path, backupId: change.backup.backupId })),
        );
      }
      throw error;
    } finally {
      try {
        if (committed)
          this.recordChange(workspaceId, {
            stagingPath,
            backups: changes
              .filter((change) => change.backup)
              .map((change) => ({ path: change.path, backupId: change.backup.backupId })),
          });
      } finally {
        if (!preserve) rmSync(stage, { recursive: true, force: true });
      }
    }
    return changes.map((file) => ({
      workspaceId,
      ...describe(file.path, file.bytes, file.metadata),
      ...(file.backup ? { backupId: file.backup.backupId } : {}),
    }));
  }
  dispatch(action, payload = {}) {
    object(payload);
    if (
      ![
        "files.list",
        "files.read",
        "files.write",
        "files.delete",
        "files.import",
        "files.preview",
        "files.restore",
        "files.backups",
      ].includes(action)
    )
      fail("UNKNOWN_ACTION", `Unsupported local material action: ${action}`);
    const workspaceId = string(payload.workspaceId, "workspaceId");
    const directory = this.workspace(workspaceId),
      manifest = this.manifest(workspaceId);
    if (action === "files.backups") return this.backups(workspaceId);
    if (action === "files.list") {
      const items = [];
      const walk = (parent, prefix = "") => {
        for (const entry of readdirSync(parent, { withFileTypes: true })) {
          if (
            entry.name === MANIFEST ||
            entry.name === ".backups" ||
            entry.name.startsWith(".stage-")
          )
            continue;
          const path = relative(`${prefix}${entry.name}`),
            target = this.safe(`${workspaceId}/${path}`),
            stat = lstatSync(target);
          if (stat.isDirectory()) walk(target, `${path}/`);
          else if (stat.isFile())
            items.push({
              workspaceId,
              ...describe(path, this.readBytes(workspaceId, path), record(manifest, path)),
            });
          else fail("INVALID_PATH", "Material library contains a special file");
        }
      };
      walk(directory);
      return { items, limits: FILE_LIMITS };
    }
    if (action === "files.write") return { item: this.install(workspaceId, [payload])[0] };
    if (action === "files.import") {
      if (
        !Array.isArray(payload.items) ||
        payload.items.length === 0 ||
        payload.items.length > FILE_LIMITS.batchFiles
      )
        fail("LIMIT_EXCEEDED", "Import requires 1 to 128 material files");
      return { items: this.install(workspaceId, payload.items) };
    }
    if (action === "files.restore") {
      const backupId = identifier(payload.backupId),
        backup = this.readBackup(workspaceId, backupId);
      const restored = this.install(workspaceId, [
        { ...backup.metadata, path: backup.path, contentBase64: backup.bytes.toString("base64") },
      ])[0];
      return { item: { ...restored, restoredFrom: backupId } };
    }
    const path = relative(payload.path),
      bytes = this.readBytes(workspaceId, path),
      item = { workspaceId, ...describe(path, bytes, record(manifest, path)) };
    if (action === "files.delete") {
      const backup = this.backup(workspaceId, path, record(manifest, path)),
        next = { ...manifest };
      delete next[path];
      try {
        this.saveManifest(workspaceId, next);
      } catch (error) {
        try {
          renameSync(join(backup.directory, "data"), this.safe(`${workspaceId}/${path}`));
        } catch {
          throw this.recoveryError(workspaceId, null, [{ path, backupId: backup.backupId }]);
        }
        throw error;
      }
      this.recordChange(workspaceId, { backups: [{ path, backupId: backup.backupId }] });
      return { item: { ...item, deleted: true, backupId: backup.backupId } };
    }
    if (action === "files.preview") {
      if (!item.previewable)
        fail(
          "INVALID_IMAGE",
          "Preview requires a complete, structurally checked PNG, JPEG, WebP or GIF; HTML and SVG are not previewed",
        );
      return { item: { ...item, contentBase64: bytes.toString("base64") } };
    }
    if ((payload.encoding ?? "base64") === "base64")
      return { item: { ...item, contentBase64: bytes.toString("base64") } };
    if (payload.encoding !== "utf8") fail("INVALID_INPUT", "encoding must be utf8 or base64");
    if (bytes.length > FILE_LIMITS.textBytes) fail("LIMIT_EXCEEDED", "Text read exceeds 1 MiB");
    let content;
    try {
      content = utf8.decode(bytes);
    } catch {
      fail("INVALID_INPUT", "Material is not valid UTF-8 text");
    }
    return { item: { ...item, content } };
  }
}

export default WorkspaceFiles;
