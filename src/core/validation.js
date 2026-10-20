import { normalizeServers } from "./servers.js";

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new StoreError(code, message);
}

export function object(value, name = "payload") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_INPUT", `${name} must be an object`);
  }
  return value;
}

export function string(value, name, { optional = false, empty = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || (!empty && !value.trim()))
    fail("INVALID_INPUT", `${name} must be a string${empty ? "" : " with content"}`);
  return value;
}

export function enumValue(value, name, allowed) {
  if (!allowed.includes(value))
    fail("INVALID_INPUT", `${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

export function tags(value = []) {
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string"))
    fail("INVALID_INPUT", "tags must be an array of strings");
  return [...new Set(value)];
}

export function json(value, name = "data") {
  object(value, name);
  try {
    const encoded = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "number" && !Number.isFinite(entry))
        fail("INVALID_INPUT", `${name} contains a non-finite number`);
      if (
        typeof entry === "undefined" ||
        typeof entry === "function" ||
        typeof entry === "symbol" ||
        typeof entry === "bigint"
      )
        fail("INVALID_INPUT", `${name} must contain only JSON values`);
      return entry;
    });
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof StoreError) throw error;
    fail("INVALID_INPUT", `${name} must be serializable JSON`);
  }
}

export const RECORD_KINDS = Object.freeze([
  "credential",
  "access",
  "webshell",
  "tunnel",
  "screenshot",
  "http",
  "chain",
  "file",
  "score-point",
  "score-hit",
  "stage",
  "session",
]);

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  prompt: "",
  promptMode: "replace",
  workspacePolicy: "fallback",
  workspaceFiles: [],
  fullAccess: true,
  autoApprove: true,
  permissionDefault: "",
  repeatReminder: "host",
  hooksDeny: false,
  maxSubagents: 16,
  maxDepth: 10,
  readLimit: 1048576,
  autoReapply: true,
  retryOverride: false,
  retryLimit: 0,
  autoContinue: false,
  continueLimit: 3,
  continueText: "请承接刚才因输出长度限制而未完成的内容，继续完成剩余部分，避免重复已有输出。",
  ownServers: [],
});

export function settings(value) {
  const result = { ...DEFAULT_SETTINGS, ...json(value, "value") };
  for (const key of [
    "enabled",
    "fullAccess",
    "autoApprove",
    "hooksDeny",
    "autoReapply",
    "retryOverride",
    "autoContinue",
  ]) {
    if (typeof result[key] !== "boolean") fail("INVALID_INPUT", `${key} must be boolean`);
  }
  string(result.prompt, "prompt", { empty: true });
  if (Buffer.byteLength(result.prompt) > 256 * 1024)
    fail("LIMIT_EXCEEDED", "Prompt exceeds 256 KiB");
  enumValue(result.promptMode, "promptMode", ["replace", "append"]);
  enumValue(result.workspacePolicy, "workspacePolicy", ["fallback", "strict", "always"]);
  string(result.permissionDefault, "permissionDefault", { empty: true });
  enumValue(result.repeatReminder, "repeatReminder", ["host", "off"]);
  for (const key of ["maxSubagents", "maxDepth", "readLimit", "retryLimit", "continueLimit"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0)
      fail("INVALID_INPUT", `${key} must be a non-negative integer`);
  }
  if (result.maxSubagents < 1 || result.maxSubagents > 128 || result.maxDepth > 64)
    fail("INVALID_INPUT", "Agent count must be 1..128 and depth 0..64");
  if (result.retryLimit > 20) fail("INVALID_INPUT", "Request retry limit must be 0..20");
  if (!Number.isSafeInteger(result.readLimit + 1))
    fail("INVALID_INPUT", "Read byte limit plus one must remain a safe integer");
  if (result.continueLimit > 20) fail("INVALID_INPUT", "Continuation limit must be 0..20");
  string(result.continueText, "continueText");
  if (Buffer.byteLength(result.continueText) > 4096)
    fail("LIMIT_EXCEEDED", "Continuation text exceeds 4 KiB");
  if (
    !Array.isArray(result.workspaceFiles) ||
    result.workspaceFiles.some((entry) => typeof entry !== "string")
  )
    fail("INVALID_INPUT", "workspaceFiles must be an array of strings");
  try {
    result.ownServers = normalizeServers(result.ownServers);
  } catch (error) {
    if (error.code === "INVALID_INPUT") fail(error.code, error.message);
    throw error;
  }
  return result;
}
