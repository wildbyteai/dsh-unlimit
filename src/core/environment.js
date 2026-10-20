import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, normalize, parse, sep } from "node:path";
import { normalizeServers } from "./servers.js";
import { StoreError, fail, object } from "./validation.js";

export const ENVIRONMENT_LIMITS = Object.freeze({
  variables: 128,
  valueBytes: 32768,
  hosts: 128,
  privateKeys: 32,
  fileBytes: 1024 * 1024,
});
const MASK = "••••••••";
const STATES = ["pending", "configured", "skipped"];
const empty = () => ({
  version: 1,
  revision: 0,
  variables: {},
  hosts: [],
  privateKeys: [],
  onboarding: "pending",
});
const validName = (value) =>
  typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value);
const validValue = (value) =>
  typeof value === "string" &&
  !value.includes("\0") &&
  Buffer.byteLength(value) <= ENVIRONMENT_LIMITS.valueBytes;
function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "Unsupported environment field");
}
function inputName(value) {
  if (!validName(value))
    fail("INVALID_INPUT", "Variable name must use portable environment identifier syntax");
  return value;
}
function text(value, max, optional = false) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
    fail("INVALID_INPUT", "Invalid environment metadata text");
  return value;
}
function explicitPath(path) {
  if (
    typeof path !== "string" ||
    path.length > 4096 ||
    !isAbsolute(path) ||
    path.includes("\0") ||
    path.split(/[\\/]/).includes("..") ||
    normalize(path) !== path
  )
    fail("INVALID_PATH", "An explicit normalized absolute path is required");
  return path;
}
// Reject intermediate links too. Callers on macOS should supply a canonical path
// (for example /private/tmp rather than the /tmp symlink).
function noLinks(path) {
  explicitPath(path);
  const root = parse(path).root;
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink())
      fail("UNSAFE_PATH", "Symbolic links are not accepted for environment storage or key paths");
  }
  return lstatSync(path);
}
function privateMode(stat, directory = false) {
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (!directory && stat.nlink !== 1))
    fail("UNSAFE_PATH", "Environment storage must be a private ordinary file or directory");
  if (
    process.platform !== "win32" &&
    ((stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid()))
  )
    fail(
      "UNSAFE_PERMISSIONS",
      "Environment storage must be owned by the current user without group or other access",
    );
}
function configured(state) {
  return (
    Object.keys(state.variables).length > 0 ||
    state.hosts.length > 0 ||
    state.privateKeys.length > 0
  );
}
const onlyFields = (value, names) => Object.keys(value).every((key) => names.includes(key));

/** Local configuration only. Public dispatch never resolves secret values. */
export class LocalEnvironment {
  #root;
  #file;
  constructor(dataRoot) {
    try {
      const root = explicitPath(dataRoot);
      if (!noLinks(root).isDirectory())
        fail("INVALID_PATH", "Environment data root must be an existing directory");
      this.#root = join(root, ".environment");
      try {
        mkdirSync(this.#root, { mode: 0o700 });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      this.#file = join(this.#root, "config.json");
      this.checkRoot();
      this.#read();
    } catch (error) {
      this.storageError(error);
    }
  }
  storageError(error) {
    if (error instanceof StoreError) throw error;
    // Never attach original fs errors: they can contain user supplied paths/data.
    fail("ENVIRONMENT_STORAGE_ERROR", "Environment configuration storage operation failed");
  }
  checkRoot() {
    privateMode(noLinks(this.#root), true);
  }
  capabilities() {
    return {
      variables: true,
      hosts: true,
      privateKeyMetadata: true,
      onboarding: true,
      internalEnvironmentResolution: true,
      publicSecretResolution: false,
      encryptedAtRest: false,
      permissions: process.platform === "win32" ? "platform-acl-unverified" : "owner-only-posix",
    };
  }
  #read() {
    let fd;
    try {
      this.checkRoot();
      let stat;
      try {
        stat = noLinks(this.#file);
      } catch (error) {
        if (error.code === "ENOENT") return empty();
        throw error;
      }
      privateMode(stat);
      if (stat.size > ENVIRONMENT_LIMITS.fileBytes)
        fail("ENVIRONMENT_STORAGE_INVALID", "Environment configuration exceeds its storage limit");
      fd = openSync(this.#file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      privateMode(opened);
      if (
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino ||
        opened.size > ENVIRONMENT_LIMITS.fileBytes
      )
        fail("UNSAFE_PATH", "Environment configuration changed during read");
      const state = JSON.parse(readFileSync(fd, "utf8"));
      this.validateState(state);
      return state;
    } catch (error) {
      if (error instanceof StoreError) throw error;
      fail("ENVIRONMENT_STORAGE_INVALID", "Environment configuration is unreadable or invalid");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  validateState(state) {
    const invalid = () =>
      fail("ENVIRONMENT_STORAGE_INVALID", "Environment configuration schema is invalid");
    if (
      !state ||
      !onlyFields(state, [
        "version",
        "revision",
        "variables",
        "hosts",
        "privateKeys",
        "onboarding",
      ]) ||
      state.version !== 1 ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !STATES.includes(state.onboarding) ||
      !state.variables ||
      typeof state.variables !== "object" ||
      Array.isArray(state.variables)
    )
      invalid();
    if (Object.keys(state.variables).length > ENVIRONMENT_LIMITS.variables) invalid();
    for (const [name, item] of Object.entries(state.variables)) {
      if (
        !validName(name) ||
        !item ||
        !onlyFields(item, ["secret", "value", "updatedAt"]) ||
        typeof item.secret !== "boolean" ||
        !validValue(item.value) ||
        typeof item.updatedAt !== "string"
      )
        invalid();
    }
    try {
      if (
        !Array.isArray(state.hosts) ||
        state.hosts.length > ENVIRONMENT_LIMITS.hosts ||
        JSON.stringify(normalizeServers(state.hosts)) !== JSON.stringify(state.hosts)
      )
        invalid();
    } catch {
      invalid();
    }
    if (
      !Array.isArray(state.privateKeys) ||
      state.privateKeys.length > ENVIRONMENT_LIMITS.privateKeys
    )
      invalid();
    const ids = new Set();
    for (const item of state.privateKeys) {
      if (
        !item ||
        !onlyFields(item, ["id", "label", "path", "updatedAt"]) ||
        typeof item.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(item.id) ||
        ids.has(item.id) ||
        typeof item.label !== "string" ||
        !item.label.trim() ||
        item.label.length > 128 ||
        typeof item.updatedAt !== "string"
      )
        invalid();
      try {
        explicitPath(item.path);
      } catch {
        invalid();
      }
      ids.add(item.id);
    }
  }
  keyMetadata(path, strict = false) {
    try {
      const stat = noLinks(path);
      if (!stat.isFile())
        fail("INVALID_PATH", "Private key path must identify an existing ordinary file");
      return {
        available: true,
        validation: "metadata-only",
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
      };
    } catch (error) {
      if (strict) {
        if (error instanceof StoreError) throw error;
        fail("INVALID_PATH", "Private key path is unavailable or cannot be inspected");
      }
      return {
        available: false,
        validation: "metadata-only",
        reason:
          error instanceof StoreError
            ? error.code
            : ["ENOENT", "ENOTDIR"].includes(error.code)
              ? "NOT_FOUND"
              : ["EACCES", "EPERM"].includes(error.code)
                ? "PERMISSION_DENIED"
                : "UNAVAILABLE",
      };
    }
  }
  #status(state = this.#read()) {
    return {
      revision: state.revision,
      variables: Object.entries(state.variables)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([name, item]) => ({
          name,
          secret: item.secret,
          configured: item.value.length > 0,
          updatedAt: item.updatedAt,
          ...(item.secret ? { masked: MASK } : { value: item.value }),
        })),
      hosts: [...state.hosts],
      privateKeys: state.privateKeys.map((item) => ({
        ...item,
        metadata: this.keyMetadata(item.path),
      })),
      onboarding: {
        state: state.onboarding,
        configured: configured(state),
        blocksChat: false,
        grantsAuthorization: false,
      },
    };
  }
  #mutate(revision, change) {
    if (!Number.isSafeInteger(revision) || revision < 0)
      fail("INVALID_INPUT", "An expected environment revision is required");
    let lock, temporary;
    const lockPath = join(this.#root, "write.lock");
    try {
      this.checkRoot();
      try {
        lock = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (error) {
        if (error.code === "EEXIST")
          fail(
            "BUSY",
            "Environment configuration is being written; retry after the current write completes",
          );
        throw error;
      }
      const state = this.#read();
      if (state.revision !== revision)
        fail(
          "CONFLICT",
          "Environment configuration revision has changed; refresh masked state before saving",
        );
      change(state);
      state.revision++;
      if (state.onboarding === "configured" && !configured(state)) state.onboarding = "pending";
      this.validateState(state);
      const bytes = JSON.stringify(state);
      if (Buffer.byteLength(bytes) > ENVIRONMENT_LIMITS.fileBytes)
        fail("LIMIT_EXCEEDED", "Environment configuration exceeds its storage limit");
      temporary = join(this.#root, `config-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        chmodSync(temporary, 0o600);
        writeFileSync(fd, bytes, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Recheck the destination rather than following a newly substituted link.
      this.checkRoot();
      try {
        privateMode(noLinks(this.#file));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      renameSync(temporary, this.#file);
      temporary = undefined;
      return this.#status(state);
    } catch (error) {
      this.storageError(error);
    } finally {
      if (temporary) {
        try {
          unlinkSync(temporary);
        } catch {
          /* A failed staging file is never returned publicly. */
        }
      }
      if (lock !== undefined) {
        closeSync(lock);
        unlinkSync(lockPath);
      }
    }
  }
  dispatch(action, payload = {}) {
    try {
      return this.#dispatch(action, payload);
    } catch (error) {
      this.storageError(error);
    }
  }
  #dispatch(action, payload) {
    object(payload);
    switch (action) {
      case "environment.capabilities":
        fields(payload, []);
        return this.capabilities();
      case "environment.status":
        fields(payload, []);
        return this.#status();
      case "environment.variables.save": {
        fields(payload, ["revision", "name", "secret", "value"]);
        const name = inputName(payload.name);
        if (payload.secret !== undefined && typeof payload.secret !== "boolean")
          fail("INVALID_INPUT", "Variable sensitivity must be boolean");
        if (payload.value !== undefined && !validValue(payload.value))
          fail("INVALID_INPUT", "Variable value must be a NUL-free string of at most 32 KiB");
        return this.#mutate(payload.revision, (state) => {
          const previous = Object.hasOwn(state.variables, name) ? state.variables[name] : undefined;
          if (!previous && (payload.value === undefined || payload.secret === undefined))
            fail("INVALID_INPUT", "New variables require an explicit value and sensitivity");
          if (previous && payload.secret !== undefined && payload.secret !== previous.secret)
            fail(
              "INVALID_INPUT",
              "Delete and explicitly recreate a variable to change its sensitivity",
            );
          if (!previous && Object.keys(state.variables).length >= ENVIRONMENT_LIMITS.variables)
            fail("LIMIT_EXCEEDED", "Too many environment variables");
          Object.defineProperty(state.variables, name, {
            value: {
              secret: previous?.secret ?? payload.secret,
              value: payload.value ?? previous.value,
              updatedAt: new Date().toISOString(),
            },
            writable: true,
            configurable: true,
            enumerable: true,
          });
          state.onboarding = "configured";
        });
      }
      case "environment.variables.delete": {
        fields(payload, ["revision", "name"]);
        const name = inputName(payload.name);
        return this.#mutate(payload.revision, (state) => {
          if (!Object.hasOwn(state.variables, name))
            fail("NOT_FOUND", "Environment variable is not configured");
          delete state.variables[name];
        });
      }
      case "environment.hosts.save": {
        fields(payload, ["revision", "items"]);
        if (!Array.isArray(payload.items) || payload.items.length > ENVIRONMENT_LIMITS.hosts)
          fail("INVALID_INPUT", "Hosts must be an array of at most 128 entries");
        let hosts;
        try {
          hosts = normalizeServers(payload.items);
        } catch {
          fail(
            "INVALID_INPUT",
            "Host inventory contains an invalid entry; no credentials, URLs, ports or networks are accepted",
          );
        }
        return this.#mutate(payload.revision, (state) => {
          state.hosts = hosts;
          if (hosts.length) state.onboarding = "configured";
        });
      }
      case "environment.keys.save": {
        fields(payload, ["revision", "id", "label", "path"]);
        const id = text(payload.id, 36, true);
        const label = text(payload.label, 128);
        const path = explicitPath(payload.path);
        this.keyMetadata(path, true);
        return this.#mutate(payload.revision, (state) => {
          const index = state.privateKeys.findIndex((item) => item.id === id);
          if (id !== undefined && index < 0)
            fail("NOT_FOUND", "Private key metadata entry is not configured");
          if (index < 0 && state.privateKeys.length >= ENVIRONMENT_LIMITS.privateKeys)
            fail("LIMIT_EXCEEDED", "Too many private key metadata entries");
          const item = { id: id ?? randomUUID(), label, path, updatedAt: new Date().toISOString() };
          if (index < 0) state.privateKeys.push(item);
          else state.privateKeys[index] = item;
          state.onboarding = "configured";
        });
      }
      case "environment.keys.delete": {
        fields(payload, ["revision", "id"]);
        const id = text(payload.id, 36);
        return this.#mutate(payload.revision, (state) => {
          const index = state.privateKeys.findIndex((item) => item.id === id);
          if (index < 0) fail("NOT_FOUND", "Private key metadata entry is not configured");
          state.privateKeys.splice(index, 1);
        });
      }
      case "environment.onboarding": {
        fields(payload, ["revision", "decision"]);
        if (!["configured", "skip"].includes(payload.decision))
          fail("INVALID_INPUT", "Onboarding decision must be configured or skip");
        return this.#mutate(payload.revision, (state) => {
          if (payload.decision === "configured" && !configured(state))
            fail("INVALID_INPUT", "Save an environment configuration before marking it configured");
          state.onboarding = payload.decision === "skip" ? "skipped" : "configured";
        });
      }
      default:
        fail("UNKNOWN_ACTION", "Unsupported public environment action");
    }
  }
  // Internal-only methods. Never register these as model/HTTP actions or log their results.
  resolve(name) {
    const key = inputName(name);
    const state = this.#read();
    if (!Object.hasOwn(state.variables, key))
      fail("NOT_FOUND", "Environment variable is not configured");
    return state.variables[key].value;
  }
  exportEnvironment(names) {
    if (
      !Array.isArray(names) ||
      names.length > ENVIRONMENT_LIMITS.variables ||
      names.some((name) => !validName(name))
    )
      fail("INVALID_INPUT", "Explicit environment variable names are required");
    const state = this.#read();
    const result = {};
    for (const name of new Set(names)) {
      if (!Object.hasOwn(state.variables, name))
        fail("NOT_FOUND", "Environment variable is not configured");
      Object.defineProperty(result, name, {
        value: state.variables[name].value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
}

export default LocalEnvironment;
