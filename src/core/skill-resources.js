import { createHash } from "node:crypto";
import { fail, string } from "./validation.js";

export function normalizeSkillResources(origin, paths) {
  if (paths === undefined) return undefined;
  if (origin !== "project")
    fail("INVALID_INPUT", "Explicit resource selection currently requires a project skill");
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
