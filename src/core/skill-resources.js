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
import { isAbsolute, join } from "node:path";
import { fail, string } from "./validation.js";

export function normalizeSkillResources(origin, paths) {
  if (paths === undefined) return undefined;
  if (!["project", "host"].includes(origin))
    fail("INVALID_INPUT", "Resource selection requires a host or project skill");
  if (!Array.isArray(paths) || paths.length > 16)
    fail("INVALID_INPUT", "Select at most 16 skill resource paths");
  const seen = new Set();
  return paths.map((path) => {
    string(path, "skill resource path");
    if (
      path === "SKILL.md" ||
      Buffer.byteLength(path) > 1024 ||
      /[\\\u0000-\u001f:*?"<>|]/u.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(path)
    )
      fail("INVALID_INPUT", "Select unique exact resource paths relative to the skill root");
    seen.add(path);
    return path;
  });
}

// Use the already validated SkillLibrary snapshot; never resolve a new disk path,
// follow links, fetch URLs or execute an imported script while preparing a task.
export function selectedSkillResources(item, paths) {
  return paths.map((path) => {
    const file = item.files.find((file) => file.path === path);
    if (!file) fail("SKILL_RESOURCE_MISSING", `Selected skill resource is missing: ${path}`);
    if (file.bytes > 32 * 1024)
      fail("SKILL_RESOURCE_LIMIT", `Selected text resource exceeds 32 KiB: ${path}`);
    const bytes = Buffer.from(file.contentBase64, "base64");
    let content;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      fail("SKILL_RESOURCE_BINARY", `Selected resource is not UTF-8 text: ${path}`);
    }
    if (content.includes("\0"))
      fail("SKILL_RESOURCE_BINARY", `Selected resource contains binary text: ${path}`);
    return {
      path,
      content,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

function directoryRoot(item) {
  const base = item.resourceBase;
  if (base?.kind !== "directory" || !isAbsolute(base.path ?? ""))
    fail("SKILL_RESOURCE_UNSUPPORTED", "Skill provider has no absolute directory resource base");
  const stat = lstatSync(base.path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("SKILL_RESOURCE_PATH", "Skill resource base must be an ordinary directory");
  return { path: realpathSync(base.path), stat };
}

const sameFile = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

function resourceStat(root, path) {
  let target = root.path;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    target = join(target, parts[index]);
    const stat = lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()) ||
      realpathSync(target) !== target
    )
      fail("SKILL_RESOURCE_PATH", "Skill resources cannot contain links or special files");
  }
  const stat = lstatSync(target);
  return { target, stat };
}

function resourceError(error) {
  if (error.code?.startsWith("SKILL_RESOURCE_")) throw error;
  if (["ENOENT", "ENOTDIR"].includes(error.code))
    fail("SKILL_RESOURCE_MISSING", "Skill resource directory or selected file is missing");
  fail("SKILL_RESOURCE_UNREADABLE", "Skill resources could not be read safely");
}

// A provider's directory is the only host resource authority. Never infer it
// from SKILL.md paths or fetch URL/opaque provider resources.
export function hostSkillResourceInventory(item) {
  try {
    const root = directoryRoot(item);
    const resources = [];
    let entries = 0;
    const walk = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 512)
          fail("SKILL_RESOURCE_LIMIT", "Skill resource inventory exceeds 512 entries");
        const path = `${prefix}${entry.name}`;
        if (path !== "SKILL.md") normalizeSkillResources("host", [path]);
        const target = join(directory, entry.name);
        const stat = lstatSync(target);
        if (stat.isSymbolicLink() || realpathSync(target) !== target)
          fail("SKILL_RESOURCE_PATH", "Skill resource inventory contains a link");
        if (stat.isDirectory()) walk(target, `${path}/`);
        else if (stat.isFile()) {
          if (path === "SKILL.md") continue;
          if (resources.length >= 200)
            fail("SKILL_RESOURCE_LIMIT", "Skill resource inventory exceeds 200 files");
          resources.push({ path, bytes: stat.size });
        } else fail("SKILL_RESOURCE_PATH", "Skill resource inventory contains a special file");
      }
    };
    walk(root.path);
    const after = directoryRoot(item);
    if (after.path !== root.path || !sameFile(root.stat, after.stat))
      fail("SKILL_RESOURCE_CHANGED", "Skill resource directory changed during inspection");
    return {
      resources: resources.sort((a, b) => a.path.localeCompare(b.path)),
      resourceStatus: { state: "available", complete: true },
    };
  } catch (error) {
    return {
      resources: [],
      resourceStatus: {
        state: "unavailable",
        complete: false,
        code: error.code?.startsWith("SKILL_RESOURCE_") ? error.code : "SKILL_RESOURCE_UNREADABLE",
        detail: "No complete safe directory inventory is available for this skill",
      },
    };
  }
}

export function selectedHostSkillResources(item, paths) {
  normalizeSkillResources("host", paths);
  if (paths.length === 0) return [];
  try {
    const root = directoryRoot(item);
    const files = paths.map((path) => {
      const before = resourceStat(root, path);
      if (before.stat.size > 32 * 1024)
        fail("SKILL_RESOURCE_LIMIT", `Selected text resource exceeds 32 KiB: ${path}`);
      const fd = openSync(before.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameFile(opened, before.stat))
          fail("SKILL_RESOURCE_CHANGED", "Selected resource changed before it was read");
        const bytes = Buffer.alloc(32 * 1024 + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > 32 * 1024)
          fail("SKILL_RESOURCE_LIMIT", `Selected text resource exceeds 32 KiB: ${path}`);
        if (!sameFile(opened, fstatSync(fd)) || !sameFile(opened, resourceStat(root, path).stat))
          fail("SKILL_RESOURCE_CHANGED", "Selected resource changed while it was read");
        return { path, bytes: length, contentBase64: bytes.subarray(0, length).toString("base64") };
      } finally {
        closeSync(fd);
      }
    });
    const after = directoryRoot(item);
    if (after.path !== root.path || !sameFile(root.stat, after.stat))
      fail("SKILL_RESOURCE_CHANGED", "Skill resource directory changed during reading");
    return selectedSkillResources({ files }, paths);
  } catch (error) {
    resourceError(error);
  }
}
