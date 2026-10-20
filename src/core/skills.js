import { randomUUID } from "node:crypto";
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
import { dirname, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fail, object, string } from "./validation.js";

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_FILES = 200;
const MAX_STORED_FILES = 512;
// Directory entries count toward this parser bound, but not the imported file limit.
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function text(buffer) {
  try {
    return decoder.decode(buffer);
  } catch {
    fail("INVALID_SKILL", "SKILL.md and filenames must be UTF-8");
  }
}
function id(value) {
  string(value, "id");
  if (
    !/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,79}$/u.test(value) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  )
    fail("INVALID_PATH", "Skill id must be a single safe directory name");
  return value.normalize("NFC");
}
function relativePath(value, directory = false) {
  string(value, "path");
  if (
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  )
    fail("INVALID_PATH", "Absolute paths and backslashes are not allowed");
  const path = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = path.split("/");
  if (
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
    fail("INVALID_PATH", "Invalid relative file path");
  if (Buffer.byteLength(path) > 1024 || parts.some((part) => Buffer.byteLength(part) > 255))
    fail("LIMIT_EXCEEDED", "File path is too long");
  return parts.map((part) => part.normalize("NFC")).join("/");
}
function base64(value, maxBytes = MAX_BYTES) {
  string(value, "contentBase64", { empty: true });
  if (value.length > Math.ceil(maxBytes / 3) * 4)
    fail("LIMIT_EXCEEDED", "Encoded file exceeds the size limit");
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value))
    fail("INVALID_INPUT", "contentBase64 must be canonical base64");
  const buffer = Buffer.from(value, "base64");
  if (buffer.length > maxBytes || buffer.toString("base64") !== value)
    fail("INVALID_INPUT", "Invalid base64 data");
  return buffer;
}
function scalar(value) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      fail("INVALID_SKILL", "Invalid quoted frontmatter value");
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) fail("INVALID_SKILL", "Invalid quoted frontmatter value");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
function metadata(content) {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) fail("INVALID_SKILL", "SKILL.md requires YAML frontmatter");
  const end = normalized.indexOf("\n---", 4);
  if (end === -1 || !["", "\n"].includes(normalized[end + 4] ?? ""))
    fail("INVALID_SKILL", "SKILL.md frontmatter is not closed");
  const fields = {};
  const lines = normalized.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#") || /^\s/.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) fail("INVALID_SKILL", "Unsupported frontmatter syntax");
    const [, key, raw] = match;
    if (!["name", "description", "user-invocable", "disable-model-invocation"].includes(key))
      continue;
    if (fields[key] !== undefined) fail("INVALID_SKILL", `Duplicate frontmatter ${key}`);
    if (/^[|>][-+]?$/.test(raw)) {
      const parts = [];
      while (index + 1 < lines.length && (/^\s/.test(lines[index + 1]) || !lines[index + 1].trim()))
        parts.push(lines[++index].trim());
      fields[key] = parts.join(raw.startsWith(">") ? " " : "\n").trim();
    } else fields[key] = scalar(raw);
  }
  string(fields.name, "frontmatter name");
  string(fields.description, "frontmatter description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.name))
    fail("INVALID_SKILL", "Skill name must be lower-case kebab-case");
  for (const flag of ["user-invocable", "disable-model-invocation"]) {
    if (fields[flag] !== undefined && !["true", "false"].includes(fields[flag]))
      fail("INVALID_SKILL", `${flag} must be true or false`);
  }
  return {
    name: fields.name,
    description: fields.description,
    invocation: {
      userInvocable: fields["user-invocable"] !== "false",
      modelInvocable: fields["disable-model-invocation"] !== "true",
    },
  };
}
function checkFiles(files, maxFiles = MAX_FILES) {
  if (!files.length) fail("INVALID_SKILL", "Import contains no files");
  if (files.length > maxFiles) fail("LIMIT_EXCEEDED", `At most ${maxFiles} files are allowed`);
  const names = new Set();
  let total = 0;
  for (const file of files) {
    file.path = relativePath(file.path);
    const key = file.path.toLocaleLowerCase("en-US");
    if (names.has(key)) fail("INVALID_PATH", "Duplicate filenames are not allowed");
    names.add(key);
    total += file.content.length;
    if (total > MAX_BYTES) fail("LIMIT_EXCEEDED", "Combined file size exceeds 50 MiB");
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length++)
      if (names.has(parts.slice(0, length).join("/").toLocaleLowerCase("en-US")))
        fail("INVALID_PATH", "A file conflicts with a directory");
  }
  return files;
}

function extra(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) fail("INVALID_ZIP", "Truncated ZIP extra field");
    const type = buffer.readUInt16LE(offset);
    const length = buffer.readUInt16LE(offset + 2);
    if (offset + 4 + length > buffer.length) fail("INVALID_ZIP", "Invalid ZIP extra length");
    if (type === 1) fail("INVALID_ZIP", "ZIP64 is not supported");
    offset += 4 + length;
  }
}

function unzip(buffer) {
  let end = -1;
  for (
    let offset = buffer.length - 22;
    offset >= Math.max(0, buffer.length - 22 - 65535);
    offset--
  ) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("INVALID_ZIP", "ZIP end record is missing");
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const start = buffer.readUInt32LE(end + 16);
  if (
    buffer.readUInt16LE(end + 4) ||
    buffer.readUInt16LE(end + 6) ||
    buffer.readUInt16LE(end + 8) !== count
  )
    fail("INVALID_ZIP", "Multi-disk ZIP is not supported");
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    fail("INVALID_ZIP", "ZIP64 is not supported");
  if (count > MAX_ARCHIVE_ENTRIES || size > MAX_ARCHIVE_BYTES || start + size !== end)
    fail("INVALID_ZIP", "Invalid ZIP central directory bounds or file count");
  const files = [];
  const names = new Set();
  const ranges = [];
  let offset = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50)
      fail("INVALID_ZIP", "Truncated ZIP central directory");
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressed = buffer.readUInt32LE(offset + 20);
    const uncompressed = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const attributes = buffer.readUInt32LE(offset + 38);
    const local = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      buffer.readUInt16LE(offset + 34) ||
      [compressed, uncompressed, local].includes(0xffffffff)
    )
      fail("INVALID_ZIP", "Invalid ZIP entry bounds");
    if (
      buffer.readUInt16LE(offset + 6) >= 45 ||
      (flags & ~0x080e) !== 0 ||
      ![0, 8].includes(method)
    )
      fail("INVALID_ZIP", "Encrypted, ZIP64 or unsupported ZIP compression");
    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength);
    if (!(flags & 0x800) && rawName.some((byte) => byte > 127))
      fail("INVALID_ZIP", "Non-UTF-8 ZIP filenames are not supported");
    const filename = text(rawName);
    const directory = filename.endsWith("/");
    const path = relativePath(filename, directory);
    const pathKey = path.toLocaleLowerCase("en-US");
    if (names.has(pathKey)) fail("INVALID_PATH", "Duplicate ZIP paths are not allowed");
    names.add(pathKey);
    const mode = (attributes >>> 16) & 0xf000;
    if (
      ![0, 0x8000, 0x4000].includes(mode) ||
      (mode === 0x4000 && !directory) ||
      (mode === 0x8000 && directory) ||
      ((attributes & 0x10) !== 0 && !directory)
    )
      fail("INVALID_ZIP", "ZIP symbolic links and special files are not supported");
    extra(buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50)
      fail("INVALID_ZIP", "Invalid ZIP local header");
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    let dataEnd = dataStart + compressed;
    if (
      dataEnd > start ||
      buffer.readUInt16LE(local + 4) >= 45 ||
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method ||
      !buffer.subarray(local + 30, local + 30 + localNameLength).equals(rawName)
    )
      fail("INVALID_ZIP", "ZIP local header does not match central directory");
    extra(buffer.subarray(local + 30 + localNameLength, dataStart));
    if (!(flags & 8)) {
      if (
        buffer.readUInt32LE(local + 14) !== crc ||
        buffer.readUInt32LE(local + 18) !== compressed ||
        buffer.readUInt32LE(local + 22) !== uncompressed
      )
        fail("INVALID_ZIP", "ZIP local lengths or CRC do not match");
    } else {
      let descriptor = dataEnd;
      if (descriptor + 4 <= start && buffer.readUInt32LE(descriptor) === 0x08074b50)
        descriptor += 4;
      if (
        descriptor + 12 > start ||
        buffer.readUInt32LE(descriptor) !== crc ||
        buffer.readUInt32LE(descriptor + 4) !== compressed ||
        buffer.readUInt32LE(descriptor + 8) !== uncompressed
      )
        fail("INVALID_ZIP", "Invalid ZIP data descriptor");
      dataEnd = descriptor + 12;
    }
    if (ranges.some((range) => local < range.end && dataEnd > range.start))
      fail("INVALID_ZIP", "Overlapping ZIP entries");
    ranges.push({ start: local, end: dataEnd });
    if (uncompressed > MAX_BYTES || total + uncompressed > MAX_BYTES)
      fail("LIMIT_EXCEEDED", "Combined ZIP size exceeds 50 MiB");
    let content;
    try {
      if (method === 0) content = buffer.subarray(dataStart, dataStart + compressed);
      else {
        const inflated = inflateRawSync(buffer.subarray(dataStart, dataStart + compressed), {
          maxOutputLength: MAX_BYTES + 1,
          info: true,
        });
        if (inflated.engine.bytesWritten !== compressed)
          fail("INVALID_ZIP", "ZIP deflate stream contains trailing data");
        content = inflated.buffer;
      }
    } catch {
      fail("INVALID_ZIP", "Invalid or oversized deflate content");
    }
    if (content.length !== uncompressed || crc32(content) !== crc)
      fail("INVALID_ZIP", "ZIP length or CRC check failed");
    if (directory && content.length) fail("INVALID_ZIP", "ZIP directory contains file data");
    if (!directory) {
      files.push({ path, content });
      total += content.length;
    }
    offset = next;
  }
  if (offset !== start + size) fail("INVALID_ZIP", "ZIP central directory length mismatch");
  return checkFiles(files);
}

export class SkillLibrary {
  constructor(root) {
    string(root, "root");
    const absolute = resolve(root);
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink())
      fail("INVALID_PATH", "Skill library root cannot be a symlink");
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    if (!lstatSync(absolute).isDirectory())
      fail("INVALID_PATH", "Skill library root must be a directory");
    this.root = realpathSync(absolute);
  }

  safeRoot() {
    if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.root)
      fail("INVALID_PATH", "Skill library root changed");
  }
  path(skillId) {
    this.safeRoot();
    return join(this.root, id(skillId));
  }
  identity(payload) {
    return id(payload.id ?? payload.name);
  }
  collect(skillId) {
    const path = this.path(skillId);
    if (!existsSync(path)) fail("NOT_FOUND", "Skill not found");
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
      fail("INVALID_PATH", "Skill must be a real directory");
    const files = [];
    let bytes = 0;
    const walk = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const child = join(directory, entry.name);
        const stat = lstatSync(child);
        const relative = relativePath(`${prefix}${entry.name}`);
        if (stat.isSymbolicLink()) fail("INVALID_PATH", "Skill symlinks are not allowed");
        if (stat.isDirectory()) walk(child, `${relative}/`);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > MAX_BYTES || files.length >= MAX_STORED_FILES)
            fail("LIMIT_EXCEEDED", "Skill exceeds the library size limit");
          files.push({ path: relative, content: readFileSync(child) });
        } else fail("INVALID_PATH", "Skill contains a special file");
      }
    };
    walk(path);
    return checkFiles(files, MAX_STORED_FILES);
  }
  item(skillId, files, includeFiles = false) {
    const skill = files.find((file) => file.path === "SKILL.md");
    if (!skill) fail("INVALID_SKILL", "Skill is missing SKILL.md");
    if (skill.content.length > MAX_DOCUMENT_BYTES)
      fail("LIMIT_EXCEEDED", "SKILL.md exceeds 256 KiB");
    const content = text(skill.content);
    const result = {
      id: skillId,
      ...metadata(content),
      bytes: files.reduce((sum, file) => sum + file.content.length, 0),
    };
    if (includeFiles)
      Object.assign(result, {
        content,
        files: files.map((file) => ({
          path: file.path,
          contentBase64: file.content.toString("base64"),
          bytes: file.content.length,
        })),
      });
    return result;
  }
  backupRoot() {
    const path = join(this.root, ".backups");
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()))
      fail("INVALID_PATH", "Backup location must be a real directory");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }
  install(groups) {
    this.safeRoot();
    // Validate every destination and existing tree before creating any visible skill.
    for (const group of groups) {
      id(group.id);
      checkFiles(group.files);
      this.item(group.id, group.files);
      if (existsSync(this.path(group.id))) this.collect(group.id);
      const alias = readdirSync(this.root).find(
        (name) =>
          name.toLocaleLowerCase("en-US").normalize("NFC") ===
            group.id.toLocaleLowerCase("en-US") && name !== group.id,
      );
      if (alias) fail("INVALID_PATH", "Skill id conflicts with an existing directory name");
    }
    const backups = this.backupRoot();
    const stage = join(this.root, `.stage-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    const changes = [];
    let preserveStage = false;
    try {
      for (const group of groups) {
        for (const file of group.files) {
          const path = join(stage, group.id, file.path);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, file.content, { flag: "wx", mode: 0o600 });
        }
      }
      for (const group of groups) {
        const target = this.path(group.id);
        const change = { target, backup: null, installed: false };
        changes.push(change);
        if (existsSync(target)) {
          // Recheck immediately before moving; no symlink may become a destination.
          this.collect(group.id);
          change.backup = join(backups, `${group.id}-${randomUUID()}`);
          renameSync(target, change.backup);
        }
        renameSync(join(stage, group.id), target);
        change.installed = true;
      }
      return groups.map((group) => this.item(group.id, group.files, true));
    } catch (error) {
      const recoveryErrors = [];
      for (const change of changes.reverse()) {
        try {
          if (change.installed) renameSync(change.target, join(stage, `rollback-${randomUUID()}`));
          if (change.backup) renameSync(change.backup, change.target);
        } catch (recoveryError) {
          recoveryErrors.push(recoveryError);
        }
      }
      if (recoveryErrors.length) {
        preserveStage = true;
        fail(
          "RECOVERY_REQUIRED",
          `Skill import rollback failed; preserve recovery data in ${stage}`,
        );
      }
      throw error;
    } finally {
      // Keep staging evidence if rollback itself failed.
      if (!preserveStage) rmSync(stage, { recursive: true, force: true });
    }
  }
  import(payload) {
    let files;
    if (payload.files !== undefined) {
      if (!Array.isArray(payload.files) || payload.files.length > MAX_FILES)
        fail("LIMIT_EXCEEDED", "Invalid file count");
      let bytes = 0;
      files = checkFiles(
        payload.files.map((file) => {
          object(file, "file");
          const content = base64(file.contentBase64);
          bytes += content.length;
          if (bytes > MAX_BYTES) fail("LIMIT_EXCEEDED", "Combined file size exceeds 50 MiB");
          return { path: file.path, content };
        }),
      );
    } else {
      const filename = string(payload.filename, "filename");
      relativePath(filename);
      if (!filename.toLowerCase().endsWith(".zip"))
        fail("INVALID_INPUT", "Only ZIP archives are supported");
      files = unzip(base64(payload.contentBase64, MAX_ARCHIVE_BYTES));
    }
    const direct = files.find((file) => file.path === "SKILL.md");
    let groups;
    if (direct) {
      const skillId = id(payload.id ?? payload.name ?? metadata(text(direct.content)).name);
      groups = [{ id: skillId, files }];
    } else {
      const documents = files.filter((file) => file.path.endsWith("/SKILL.md"));
      if (!documents.length) fail("INVALID_SKILL", "Each imported root must contain SKILL.md");
      const roots = documents.map((file) => file.path.slice(0, -"SKILL.md".length));
      if (
        roots.some((root, index) =>
          roots.some((parent, other) => other !== index && root.startsWith(parent)),
        )
      ) {
        fail("INVALID_SKILL", "Skill roots cannot be nested inside another skill");
      }
      groups = documents.map((document, index) => ({
        id: id(metadata(text(document.content)).name),
        files: files
          .filter((file) => file.path.startsWith(roots[index]))
          .map((file) => ({ path: file.path.slice(roots[index].length), content: file.content })),
      }));
    }
    const names = groups.map((group) => group.id.toLocaleLowerCase("en-US"));
    if (new Set(names).size !== names.length) fail("INVALID_PATH", "Duplicate skill roots");
    return { items: this.install(groups) };
  }
  dispatch(action, payload = {}) {
    object(payload);
    this.safeRoot();
    switch (action) {
      case "skills.list": {
        const items = [];
        for (const entry of readdirSync(this.root, { withFileTypes: true })) {
          if (entry.name.startsWith(".")) continue;
          const skillId = id(entry.name);
          items.push(this.item(skillId, this.collect(skillId)));
        }
        return { items };
      }
      case "skills.read": {
        const skillId = this.identity(payload);
        return { item: this.item(skillId, this.collect(skillId), true) };
      }
      case "skills.save": {
        const skillId = this.identity(payload);
        const body = string(payload.content, "content", { empty: true });
        const content =
          body.replace(/^\uFEFF/, "").startsWith("---\n") ||
          body.replace(/^\uFEFF/, "").startsWith("---\r\n")
            ? body
            : `---\nname: ${JSON.stringify(payload.name ?? skillId)}\ndescription: ${JSON.stringify(string(payload.description, "description"))}\n---\n\n${body}`;
        const files = existsSync(this.path(skillId))
          ? this.collect(skillId).filter((file) => file.path !== "SKILL.md")
          : [];
        files.push({ path: "SKILL.md", content: Buffer.from(content) });
        return { item: this.install([{ id: skillId, files }])[0] };
      }
      case "skills.delete": {
        const skillId = this.identity(payload);
        const item = this.item(skillId, this.collect(skillId), true);
        const backup = join(this.backupRoot(), `${skillId}-${randomUUID()}`);
        renameSync(this.path(skillId), backup);
        return { item: { ...item, deleted: true } };
      }
      case "skills.import":
        return this.import(payload);
      default:
        fail("UNKNOWN_ACTION", `Unsupported skill action: ${action}`);
    }
  }
}

export default SkillLibrary;
