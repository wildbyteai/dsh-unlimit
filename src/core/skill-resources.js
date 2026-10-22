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
import { extname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

export function normalizeSkillSelections(origin, { resources, images }) {
  const textPaths = normalizeSkillResources(origin, resources);
  const imagePaths = normalizeSkillResources(origin, images);
  const paths = [...(textPaths ?? []), ...(imagePaths ?? [])];
  if (paths.length > 16 || new Set(paths).size !== paths.length)
    fail("INVALID_INPUT", "Select at most 16 unique text and image resource paths per skill");
  return {
    ...(textPaths === undefined ? {} : { resources: textPaths }),
    ...(imagePaths === undefined ? {} : { images: imagePaths }),
  };
}

const IMAGE_MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

// Preflight only reads the mounted policy. Native image validation and durable
// storage remain the execution path's responsibility; this never saves images.
export function skillImageBudget(attachments, count) {
  const limits = attachments?.imageLimits;
  if (
    typeof attachments?.saveImages !== "function" ||
    !["maxImageBytes", "maxImagesPerMessage", "maxMessageImageBytes"].every(
      (key) => Number.isSafeInteger(limits?.[key]) && limits[key] > 0,
    ) ||
    !Array.isArray(limits?.mediaTypes) ||
    !limits.mediaTypes.length ||
    limits.mediaTypes.some((type) => typeof type !== "string" || !type.length)
  )
    fail("SKILL_IMAGE_UNSUPPORTED", "The mounted attachment service has no usable image policy");
  if (!Number.isSafeInteger(count) || count < 0 || count > limits.maxImagesPerMessage)
    fail("SKILL_IMAGE_LIMIT", "Selected images exceed the mounted attachment count limit");
  return {
    maxImageBytes: limits.maxImageBytes,
    remainingBytes: limits.maxMessageImageBytes,
    remainingImages: limits.maxImagesPerMessage,
    mediaTypes: new Set(limits.mediaTypes),
    blocked: false,
  };
}

function imageMediaType(path, budget) {
  const mediaType = IMAGE_MEDIA_TYPES.get(extname(path).toLowerCase());
  if (!mediaType || !budget.mediaTypes.has(mediaType))
    fail(
      "SKILL_IMAGE_TYPE",
      `Selected image extension is not accepted by the mounted policy: ${path}`,
    );
  return mediaType;
}

function reserveImage(path, bytes, budget) {
  if (
    budget.blocked ||
    budget.remainingImages === 0 ||
    bytes > budget.maxImageBytes ||
    bytes > budget.remainingBytes
  ) {
    budget.blocked = true;
    fail(
      "SKILL_IMAGE_LIMIT",
      `Selected images exceed the mounted attachment byte or count limit: ${path}`,
    );
  }
  const maximum = Math.min(budget.maxImageBytes, budget.remainingBytes);
  budget.remainingImages -= 1;
  budget.remainingBytes -= bytes;
  return maximum;
}

function imageFile(file, budget) {
  const mediaType = imageMediaType(file.path, budget);
  reserveImage(file.path, file.bytes, budget);
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.length !== file.bytes)
    fail("SKILL_RESOURCE_CHANGED", "Selected image bytes differ from their inspected size");
  return {
    path: file.path,
    mediaType,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64"),
  };
}

export function selectedSkillImages(item, paths, budget) {
  normalizeSkillResources("project", paths);
  return paths.map((path) => {
    const file = item.files.find((file) => file.path === path);
    if (!file) fail("SKILL_RESOURCE_MISSING", `Selected skill image is missing: ${path}`);
    return imageFile(file, budget);
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
  let path = base?.kind === "directory" ? base.path : undefined;
  if (base?.kind === "url") {
    try {
      if (typeof base.url !== "string" || !/^file:\/\//iu.test(base.url) || base.url.includes("\\"))
        throw new Error();
      const url = new URL(base.url);
      if (
        url.protocol !== "file:" ||
        url.host !== "" ||
        !url.pathname.endsWith("/") ||
        /[?#]/u.test(url.href) ||
        /%2f|%5c/iu.test(url.pathname)
      )
        throw new Error();
      // URL bases must name directories explicitly. resolve removes their
      // trailing separator so lstat still detects a linked root directory.
      path = resolve(fileURLToPath(url));
    } catch {
      fail(
        "SKILL_RESOURCE_UNSUPPORTED",
        "Skill URL resources require a local file directory URL without query or fragment",
      );
    }
  }
  if (!isAbsolute(path ?? ""))
    fail(
      "SKILL_RESOURCE_UNSUPPORTED",
      "Skill provider has no absolute local directory resource base",
    );
  const rootLength = parse(path).root.length;
  while (path.length > rootLength && path.endsWith(sep)) path = path.slice(0, -1);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    fail("SKILL_RESOURCE_PATH", "Skill resource base must be an ordinary directory");
  return { path: realpathSync(path), stat };
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
  if (error.code?.startsWith("SKILL_RESOURCE_") || error.code?.startsWith("SKILL_IMAGE_"))
    throw error;
  if (["ENOENT", "ENOTDIR"].includes(error.code))
    fail("SKILL_RESOURCE_MISSING", "Skill resource directory or selected file is missing");
  fail("SKILL_RESOURCE_UNREADABLE", "Skill resources could not be read safely");
}

// A provider's directory or local file directory URL is the resource authority.
// Never infer it from SKILL.md paths or fetch network/opaque provider resources.
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

function hostSkillFiles(item, paths, limitFor) {
  try {
    const root = directoryRoot(item);
    const files = paths.map((path) => {
      const before = resourceStat(root, path);
      const { maximum, code, message } = limitFor(path, before.stat.size);
      if (before.stat.size > maximum) fail(code, message);
      const fd = openSync(before.target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || !sameFile(opened, before.stat))
          fail("SKILL_RESOURCE_CHANGED", "Selected resource changed before it was read");
        const bytes = Buffer.alloc(Math.min(opened.size, maximum) + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > maximum) fail(code, message);
        if (
          length !== opened.size ||
          !sameFile(opened, fstatSync(fd)) ||
          !sameFile(opened, resourceStat(root, path).stat)
        )
          fail("SKILL_RESOURCE_CHANGED", "Selected resource changed while it was read");
        return { path, bytes: length, contentBase64: bytes.subarray(0, length).toString("base64") };
      } finally {
        closeSync(fd);
      }
    });
    const after = directoryRoot(item);
    if (after.path !== root.path || !sameFile(root.stat, after.stat))
      fail("SKILL_RESOURCE_CHANGED", "Skill resource directory changed during reading");
    return files;
  } catch (error) {
    resourceError(error);
  }
}

export function selectedHostSkillResources(item, paths) {
  normalizeSkillResources("host", paths);
  if (paths.length === 0) return [];
  const files = hostSkillFiles(item, paths, (path) => ({
    maximum: 32 * 1024,
    code: "SKILL_RESOURCE_LIMIT",
    message: `Selected text resource exceeds 32 KiB: ${path}`,
  }));
  return selectedSkillResources({ files }, paths);
}

export function selectedHostSkillImages(item, paths, budget) {
  normalizeSkillResources("host", paths);
  if (paths.length === 0) return [];
  const files = hostSkillFiles(item, paths, (path, bytes) => {
    imageMediaType(path, budget);
    return {
      maximum: reserveImage(path, bytes, budget),
      code: "SKILL_IMAGE_LIMIT",
      message: `Selected images exceed the mounted attachment byte limit: ${path}`,
    };
  });
  // The bounded host read already reserved these exact bytes in the shared
  // budget; construct their content and provenance without reserving twice.
  return files.map((file) => ({
    path: file.path,
    mediaType: imageMediaType(file.path, budget),
    bytes: file.bytes,
    sha256: createHash("sha256").update(Buffer.from(file.contentBase64, "base64")).digest("hex"),
    contentBase64: file.contentBase64,
  }));
}
