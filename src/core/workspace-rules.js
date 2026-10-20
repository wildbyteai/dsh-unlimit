import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { StoreError } from "./validation.js";

export const MAX_WORKSPACE_RULE_BYTES = 256 * 1024;
const NAMES = ["AGENTS.md", "CLAUDE.md"];
function failure(code, message, bytes) {
  const error = new StoreError(code, message);
  if (bytes !== undefined) error.bytes = bytes;
  return error;
}
function filesystemError(error) {
  if (error instanceof StoreError) return error;
  return failure(
    error.code === "ENOENT"
      ? "RULE_NOT_FOUND"
      : error.code === "ELOOP"
        ? "RULE_LINK_ESCAPE"
        : "RULE_UNREADABLE",
    error.code === "ENOENT"
      ? "规则文件已失效或不存在"
      : error.code === "ELOOP"
        ? "规则文件存在循环或已变化的符号链接"
        : `规则文件无法读取（${error.code || "IO_ERROR"}）`,
  );
}
function ancestors(directory) {
  if (typeof directory !== "string" || !directory.trim() || !isAbsolute(directory))
    throw failure("INVALID_DIRECTORY", "请明确提供本地工作区的绝对目录，不会自动扫描当前进程目录");
  let root;
  try {
    root = realpathSync(directory);
    if (!lstatSync(root).isDirectory()) throw failure("INVALID_DIRECTORY", "工作区路径必须是目录");
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw failure("INVALID_DIRECTORY", `工作区目录不存在或不可访问（${error.code || "IO_ERROR"}）`);
  }
  const chain = [];
  for (let current = root, depth = 0; ; depth++) {
    chain.push({ directory: current, workspaceDirectory: root, depth });
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain.reverse().map((item, level) => ({ ...item, level }));
}
function candidates(chain) {
  return chain.flatMap((item) =>
    NAMES.map((name) => ({ ...item, name, path: join(item.directory, name) })),
  );
}
function readCandidate(candidate, allowed) {
  let fd;
  try {
    const path = candidate.path;
    const initial = lstatSync(path);
    const resolvedPath = realpathSync(path);
    if (!allowed.has(resolvedPath))
      throw failure("RULE_LINK_ESCAPE", "规则链接指向当前祖先链支持文件之外的位置");
    const target = lstatSync(resolvedPath);
    if (!target.isFile()) throw failure("RULE_NOT_FILE", "候选路径不是普通规则文件");
    if (target.size > MAX_WORKSPACE_RULE_BYTES)
      throw failure("RULE_TOO_LARGE", "规则文件超过 256 KiB，无法预览或选用", target.size);
    // Resolve allowed links first, then refuse a replaced final link and a blocking FIFO.
    fd = openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) throw failure("RULE_NOT_FILE", "候选路径不是普通规则文件");
    if (before.size > MAX_WORKSPACE_RULE_BYTES)
      throw failure("RULE_TOO_LARGE", "规则文件超过 256 KiB，无法预览或选用", before.size);
    if (
      realpathSync(path) !== resolvedPath ||
      realpathSync(resolvedPath) !== resolvedPath ||
      before.dev !== target.dev ||
      before.ino !== target.ino
    )
      throw failure("RULE_CHANGED", "规则文件或其链接在读取前发生变化，请重新扫描");
    const bytes = Buffer.alloc(MAX_WORKSPACE_RULE_BYTES + 1);
    let length = 0,
      count;
    while (
      length < bytes.length &&
      (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0
    )
      length += count;
    if (length > MAX_WORKSPACE_RULE_BYTES)
      throw failure("RULE_TOO_LARGE", "规则文件超过 256 KiB，无法预览或选用", length);
    const after = fstatSync(fd);
    if (
      before.size !== length ||
      after.size !== length ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      realpathSync(path) !== resolvedPath ||
      realpathSync(resolvedPath) !== resolvedPath
    )
      throw failure("RULE_CHANGED", "规则文件在读取期间发生变化，请重新扫描");
    const data = bytes.subarray(0, length);
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
    } catch {
      throw failure("RULE_INVALID_UTF8", "规则文件不是有效的 UTF-8 正文，无法预览或选用", length);
    }
    return {
      ...candidate,
      resolvedPath,
      linked: initial.isSymbolicLink(),
      bytes: length,
      sha256: createHash("sha256").update(data).digest("hex"),
      content,
    };
  } catch (error) {
    throw filesystemError(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Scan only the explicitly supplied directory's canonical ancestor chain. */
export function workspaceInstructions(directory) {
  const files = candidates(ancestors(directory));
  const allowed = new Set(files.map((item) => item.path));
  const result = [];
  for (const candidate of files) {
    let stat;
    try {
      stat = lstatSync(candidate.path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      const diagnostic = filesystemError(error);
      result.push({
        ...candidate,
        bytes: null,
        readable: false,
        error: { code: diagnostic.code, message: diagnostic.message },
      });
      continue;
    }
    try {
      const { content, ...item } = readCandidate(candidate, allowed);
      result.push({ ...item, readable: true });
    } catch (error) {
      result.push({
        ...candidate,
        bytes: error.bytes ?? (stat.isSymbolicLink() ? null : stat.size),
        readable: false,
        error: { code: error.code, message: error.message },
      });
    }
  }
  return result;
}

/** Read an allowed current candidate; never evaluate its instructions or accept arbitrary files. */
export function readWorkspaceRule({ directory, path } = {}) {
  const files = candidates(ancestors(directory));
  if (typeof path !== "string" || !isAbsolute(path))
    throw failure("INVALID_RULE_PATH", "请选择扫描结果中的绝对规则路径");
  let requested = resolve(path);
  if (!NAMES.includes(basename(requested)))
    throw failure("RULE_OUTSIDE_CHAIN", "规则文件名必须是 AGENTS.md 或 CLAUDE.md");
  try {
    // Canonicalize the directory alias, not the selected file's symlink target.
    // macOS /var and /tmp paths commonly refer to /private/var and /private/tmp.
    requested = join(realpathSync(dirname(requested)), basename(requested));
  } catch (error) {
    throw filesystemError(error);
  }
  const candidate = files.find((item) => item.path === requested);
  if (!candidate)
    throw failure(
      "RULE_OUTSIDE_CHAIN",
      "选中的规则不属于当前工作区祖先链中的 AGENTS.md 或 CLAUDE.md",
    );
  return readCandidate(candidate, new Set(files.map((item) => item.path)));
}
