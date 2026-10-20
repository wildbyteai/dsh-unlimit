import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { extname, isAbsolute, join } from "node:path";
import { fail, object, string } from "./validation.js";

const EXTENSIONS = new Set([".md", ".txt", ".yaml", ".yml", ".json", ".toml"]);
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_DEPTH = 12;

/** Read-only text templates under the one directory explicitly selected by the user. */
export class Templates {
  constructor(toolkit) {
    this.toolkit = toolkit;
  }

  root() {
    const root = this.toolkit.config().templateDir;
    if (!root) fail("NOT_CONFIGURED", "请先在工具与环境中选择本地模板目录");
    if (realpathSync(root) !== root || !lstatSync(root).isDirectory())
      fail("CONFLICT", "模板目录已被替换，请重新配置");
    return root;
  }

  read(path) {
    string(path, "path");
    const parts = path.split("/");
    if (
      isAbsolute(path) ||
      path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === ".." || /[\x00-\x1f:]/.test(part)) ||
      !EXTENSIONS.has(extname(path).toLowerCase())
    )
      fail("INVALID_INPUT", "只接受模板目录内的相对文本文件路径");
    const root = this.root();
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)
        fail("INVALID_INPUT", "模板路径不能包含符号链接");
    }
    const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile()) fail("INVALID_INPUT", "模板必须是普通文件");
      if (before.size > MAX_BYTES) fail("LIMIT_EXCEEDED", "单个模板不能超过 1 MiB");
      const named = lstatSync(current);
      if (named.ino !== before.ino || named.dev !== before.dev || realpathSync(current) !== current)
        fail("CONFLICT", "模板路径在读取前改变，请重试");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const bytes = buffer.subarray(0, length);
      const after = fstatSync(fd);
      if (
        bytes.length > MAX_BYTES ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        fail("CONFLICT", "模板在读取时改变，请重试");
      let content;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        fail("INVALID_INPUT", "模板不是有效 UTF-8 文本");
      }
      if (content.includes("\0")) fail("INVALID_INPUT", "模板包含二进制内容");
      return {
        path,
        content,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        verification: "unverified",
      };
    } finally {
      closeSync(fd);
    }
  }

  list({ query = "", limit = 100 } = {}) {
    string(query, "query", { empty: true });
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      fail("INVALID_INPUT", "limit 必须为 1..500");
    const root = this.root();
    const needle = query.trim().toLocaleLowerCase();
    const items = [];
    let inspected = 0;
    let skipped = 0;
    let truncated = false;
    const visit = (directory, prefix = "", depth = 0) => {
      if (depth > MAX_DEPTH) {
        truncated = true;
        return;
      }
      if (realpathSync(directory) !== directory || !lstatSync(directory).isDirectory())
        fail("CONFLICT", "模板目录在检索时改变，请重试");
      const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      );
      for (const entry of entries) {
        if (inspected >= MAX_ENTRIES || items.length >= limit) {
          truncated = true;
          return;
        }
        inspected++;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) {
          skipped++;
          continue;
        }
        if (entry.isDirectory()) {
          visit(join(directory, entry.name), path, depth + 1);
          continue;
        }
        if (!entry.isFile() || !EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          skipped++;
          continue;
        }
        let item;
        try {
          item = this.read(path);
        } catch (error) {
          if (!["LIMIT_EXCEEDED", "INVALID_INPUT"].includes(error.code)) throw error;
          skipped++;
          continue;
        }
        const pathMatch = path.toLocaleLowerCase().includes(needle);
        const offset = item.content.toLocaleLowerCase().indexOf(needle);
        if (!pathMatch && offset < 0) continue;
        items.push({
          path,
          bytes: item.bytes,
          sha256: item.sha256,
          excerpt: item.content.slice(Math.max(0, offset - 60), Math.max(0, offset - 60) + 240),
          verification: item.verification,
        });
      }
    };
    visit(root);
    return {
      items,
      inspected,
      skipped,
      truncated,
      limits: { maxBytes: MAX_BYTES, maxEntries: MAX_ENTRIES, maxDepth: MAX_DEPTH },
    };
  }

  dispatch(action, payload = {}) {
    object(payload);
    if (action === "templates.list") return this.list(payload);
    if (action === "templates.read") return { item: this.read(payload.path) };
    fail("UNKNOWN_ACTION", "未知模板操作");
  }
}
