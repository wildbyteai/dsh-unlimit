import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { StoreError, fail, object, string } from "./validation.js";

const TOOLS = Object.freeze([
  ["nmap", "Nmap"],
  ["nuclei", "Nuclei"],
  ["masscan", "Masscan"],
  ["fscan", "fscan"],
  ["gogo", "gogo"],
  ["suo5", "suo5"],
  ["frpc", "frp client"],
  ["frps", "frp server"],
  ["chisel", "Chisel"],
  ["ffuf", "ffuf"],
  ["httpx", "HTTPX"],
  ["dnsx", "dnsx"],
  ["subfinder", "Subfinder"],
  ["ksubdomain", "ksubdomain"],
  ["impacket", "Impacket"],
]);
const ROOT_KEY = "toolkit.root";
const CONFIG_KEY = "toolkit.config";
const OUTPUT_LIMIT = 64 * 1024;

function fields(payload, allowed) {
  object(payload);
  if (Object.keys(payload).some((key) => !allowed.includes(key))) {
    fail("INVALID_INPUT", "Unsupported toolkit option");
  }
}

function directory(value, label = "root") {
  string(value, label);
  if (!isAbsolute(value)) fail("INVALID_INPUT", "工具目录必须是绝对路径");
  try {
    const root = realpathSync(value);
    if (!lstatSync(root).isDirectory()) fail("INVALID_INPUT", "工具目录必须是现有文件夹");
    return root;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    fail("INVALID_INPUT", "工具目录不存在或无法读取");
  }
}

function filename(id) {
  return process.platform === "win32" ? `${id}.exe` : id;
}

function inventory(root) {
  const paths = new Map();
  if (!root) return paths;
  // The saved canonical root must not silently turn into a different directory.
  if (directory(root) !== root || !lstatSync(root).isDirectory()) {
    fail("INVALID_INPUT", "已保存的工具目录已改变，请重新选择");
  }
  const accepted = new Map(TOOLS.map(([id]) => [filename(id), id]));
  const scan = (current, includeDirectories) => {
    if (realpathSync(current) !== current || !lstatSync(current).isDirectory()) return;
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name, "en"),
    );
    for (const entry of entries) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory() && includeDirectories) {
        scan(candidate, false);
      } else if (entry.isFile() && accepted.has(entry.name)) {
        // Do not follow symlinks, including a replaced intermediate directory.
        if (realpathSync(candidate) !== candidate || !lstatSync(candidate).isFile()) continue;
        try {
          accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        } catch (error) {
          if (error.code === "EACCES") continue;
          throw error;
        }
        const id = accepted.get(entry.name);
        const previous = paths.get(id);
        if (!previous || current === root) paths.set(id, candidate);
      }
    }
  };
  scan(root, true);
  return paths;
}

function executable(path) {
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) return null;
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(error.code)) return null;
    throw error;
  }
}

function explicitExecutable(value) {
  string(value, "toolPaths entry");
  if (!isAbsolute(value)) fail("INVALID_INPUT", "逐工具路径必须是绝对路径");
  let path;
  try {
    path = realpathSync(value);
  } catch {
    fail("INVALID_INPUT", "逐工具路径不存在或无法读取");
  }
  if (!executable(path)) fail("INVALID_INPUT", "逐工具路径必须指向现有可执行文件");
  return path;
}

function normalizeConfig(input) {
  const root = input.root === "" ? "" : directory(input.root);
  if (!Array.isArray(input.searchDirs)) fail("INVALID_INPUT", "searchDirs必须是目录数组");
  const searchDirs = [
    ...new Set(input.searchDirs.map((path) => directory(path, "searchDirs entry"))),
  ];
  object(input.toolPaths, "toolPaths");
  const toolPaths = Object.fromEntries(
    Object.entries(input.toolPaths).map(([id, path]) => {
      if (!TOOLS.some(([known]) => known === id)) fail("INVALID_INPUT", "未知逐工具标识");
      return [id, explicitExecutable(path)];
    }),
  );
  const templateDir = input.templateDir === "" ? "" : directory(input.templateDir, "templateDir");
  return { root, searchDirs, toolPaths, templateDir };
}

// This is product identification from declared CLI output, not a trust/signature check.
function identifyHttpx(text) {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const python =
    /httpx/i.test(clean) &&
    /next generation HTTP client/i.test(clean) &&
    /--method\b/.test(clean) &&
    /<URL>/i.test(clean);
  const vendor = /httpx/i.test(clean) && /projectdiscovery(?:\.io)?/i.test(clean);
  const toolkit =
    /httpx[^\n]*HTTP toolkit/i.test(clean) &&
    /retryablehttp/i.test(clean) &&
    /-status-code\b/.test(clean) &&
    /-tech-detect\b/.test(clean);
  if (python && (vendor || toolkit))
    return { identity: "unknown", detail: "输出包含冲突产品标识，未确认安全工具身份" };
  if (python)
    return { identity: "mismatch", detail: "检测到Python HTTPX客户端，不是ProjectDiscovery httpx" };
  if (vendor || toolkit)
    return {
      identity: "verified",
      detail: "命令输出匹配ProjectDiscovery httpx产品标识；不代表文件可信性验证",
    };
  return {
    identity: "unknown",
    detail: "版本/帮助未包含足够产品标识，不能确认是ProjectDiscovery httpx",
  };
}

function stopProcess(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync(
        join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { shell: false, windowsHide: true, stdio: "ignore", timeout: 1000 },
      );
    } catch {
      child.kill("SIGKILL");
    }
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") child.kill("SIGKILL");
    }
  }
}

export class Toolkit {
  constructor(store) {
    this.store = store;
    this.pending = new Map();
    this.identities = new Map();
    this.closed = false;
  }

  config() {
    return (
      this.store.meta(CONFIG_KEY, null) ?? {
        root: this.store.meta(ROOT_KEY, ""),
        searchDirs: [],
        toolPaths: {},
        templateDir: "",
      }
    );
  }

  status(config = this.config(), useCachedIdentity = true) {
    const { root, searchDirs, toolPaths, templateDir } = config;
    if (templateDir && directory(templateDir, "templateDir") !== templateDir) {
      fail("INVALID_INPUT", "已保存的模板目录已改变，请重新选择");
    }
    const roots = [
      root && { path: root, source: "root" },
      ...searchDirs.map((path) => ({ path, source: "search" })),
    ].filter(Boolean);
    const paths = new Map();
    for (const entry of roots) {
      for (const [id, path] of inventory(entry.path)) {
        if (!paths.has(id)) paths.set(id, { path, source: entry.source });
      }
    }
    return {
      root,
      searchDirs: [...searchDirs],
      toolPaths: { ...toolPaths },
      templateDir,
      tools: TOOLS.map(([id, name]) => {
        // A broken explicit override never silently falls back to a lower-priority file.
        const selected = Object.hasOwn(toolPaths, id)
          ? { path: toolPaths[id], source: "explicit" }
          : paths.get(id);
        const fingerprint = selected && executable(selected.path);
        const path = fingerprint ? selected.path : null;
        const cached = useCachedIdentity ? this.identities.get(id) : null;
        const identity =
          path && cached?.path === path && cached.fingerprint === fingerprint ? cached : null;
        return {
          id,
          name,
          path,
          source: selected?.source ?? null,
          available: Boolean(path) && (id !== "httpx" || identity?.identity === "verified"),
          identity: path
            ? (identity?.identity ?? (id === "httpx" ? "unverified" : "name-only"))
            : "missing",
          detail: !path
            ? selected
              ? "选定文件已失效或不可执行，未采用其他候选"
              : "未找到已明确配置的可执行文件"
            : (identity?.detail ??
              (id === "httpx"
                ? "存在同名可执行文件，需显式检查版本/帮助确认产品"
                : "按已配置路径登记，尚未验证版本")),
        };
      }),
      runs: [],
    };
  }

  save(payload) {
    fields(payload, ["root", "searchDirs", "toolPaths", "templateDir"]);
    if (this.closed) fail("UNSUPPORTED", "工具环境已关闭");
    const config = normalizeConfig({ ...this.config(), ...payload });
    const result = this.status(config, false);
    // One metadata write keeps the complete configuration atomic. The old root key
    // is read only for migration; old {root} requests remain partial updates.
    this.store.setMeta(CONFIG_KEY, config);
    for (const cancellation of this.pending.keys()) cancellation.abort();
    this.identities.clear();
    // Saving explicit choices revokes prior identity observations.
    return result;
  }

  adapt() {
    const status = this.status();
    return {
      root: status.root,
      searchDirs: status.searchDirs,
      toolPaths: status.toolPaths,
      templateDir: status.templateDir,
      offline: true,
      missing: status.tools
        .filter((tool) => !tool.available)
        .map(({ id, name, path, identity, detail }) => ({
          id,
          name,
          identity,
          detail,
          advice: path
            ? "请显式执行版本/帮助检查确认产品；身份不匹配时改选正确可执行文件。"
            : `在离线环境准备适合当前平台的 ${name} 可执行文件，登记精确路径或放入选定工具目录及其一级子目录，然后重新检查。`,
        })),
    };
  }

  async probe(payload, { signal } = {}) {
    fields(payload, ["tool", "timeoutMs"]);
    string(payload.tool, "tool");
    if (!TOOLS.some(([id]) => id === payload.tool)) fail("INVALID_INPUT", "未知工具标识");
    const timeoutMs = payload.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 10000) {
      fail("INVALID_INPUT", "timeoutMs必须是50到10000之间的整数");
    }
    if (this.closed) fail("UNSUPPORTED", "工具环境已关闭");
    if (signal?.aborted) fail("CANCELLED", "版本检查已取消");
    const { tools } = this.status();
    const tool = tools.find((item) => item.id === payload.tool);
    if (!tool.path) fail("NOT_FOUND", "所选工具不在已登记路径中，或不可执行");
    const fingerprint = executable(tool.path);
    this.identities.delete(tool.id);
    const cancellation = new AbortController();
    const relay = () => cancellation.abort();
    signal?.addEventListener("abort", relay, { once: true });
    const probeHome = mkdtempSync(join(tmpdir(), "dsh-unlimit-probe-"));
    const deadline = Date.now() + timeoutMs;
    let bytes = 0;
    const attempts = [];
    const run = (args) =>
      new Promise((resolve, reject) => {
        if (cancellation.signal.aborted)
          return reject(new StoreError("CANCELLED", "版本检查已取消"));
        if (Date.now() >= deadline) return reject(new StoreError("TIMEOUT", "版本检查超时"));
        if (executable(tool.path) !== fingerprint)
          return reject(new StoreError("CONFLICT", "工具文件已改变，请重新检查"));
        // A disposable HOME and cwd avoid consulting real tool configuration/credentials.
        const env = {
          ...Object.fromEntries(
            ["PATH", "SystemRoot", "WINDIR"]
              .filter((key) => process.env[key] !== undefined)
              .map((key) => [key, process.env[key]]),
          ),
          HOME: probeHome,
          USERPROFILE: probeHome,
          XDG_CONFIG_HOME: probeHome,
          XDG_CACHE_HOME: probeHome,
          XDG_DATA_HOME: probeHome,
        };
        const child = spawn(tool.path, args, {
          cwd: probeHome,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let failure = null;
        const output = { stdout: [], stderr: [] };
        const terminate = (code, message) => {
          if (failure) return;
          failure = new StoreError(code, message);
          stopProcess(child);
        };
        const abort = () => terminate("CANCELLED", "版本检查已取消");
        cancellation.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(
          () => terminate("TIMEOUT", "版本检查超时，进程已终止"),
          Math.max(1, deadline - Date.now()),
        );
        for (const channel of ["stdout", "stderr"]) {
          child[channel].on("data", (chunk) => {
            const remaining = OUTPUT_LIMIT - bytes;
            if (remaining > 0) output[channel].push(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > OUTPUT_LIMIT)
              terminate("OUTPUT_LIMIT", "版本/帮助检查输出超过64KiB，进程已终止");
          });
        }
        child.on("error", () => {
          failure ??= new StoreError("TOOL_FAILED", "版本检查进程无法启动");
        });
        child.on("close", (exitCode, exitSignal) => {
          clearTimeout(timer);
          cancellation.signal.removeEventListener("abort", abort);
          // A POSIX process group can outlive its launcher; Windows taskkill requires a live owner.
          if (process.platform !== "win32") stopProcess(child);
          if (failure) return reject(failure);
          resolve({
            args,
            exitCode,
            exitSignal,
            stdout: Buffer.concat(output.stdout).toString("utf8"),
            stderr: Buffer.concat(output.stderr).toString("utf8"),
          });
        });
      });
    const task = (async () => {
      attempts.push(await run(tool.id === "httpx" ? ["-version"] : ["--version"]));
      let identity =
        tool.id === "httpx"
          ? identifyHttpx(attempts[0].stdout + "\n" + attempts[0].stderr)
          : { identity: "name-only", detail: "版本命令成功；未对产品签名或可信性进行验证" };
      if (tool.id === "httpx" && (attempts[0].exitCode !== 0 || identity.identity === "unknown")) {
        attempts.push(await run(["--help"]));
        identity = identifyHttpx(
          attempts
            .filter((attempt) => attempt.exitCode === 0)
            .map((attempt) => attempt.stdout + "\n" + attempt.stderr)
            .join("\n"),
        );
      }
      const successful = attempts.findLast((attempt) => attempt.exitCode === 0);
      if (!successful) fail("TOOL_FAILED", "版本/帮助检查均失败");
      if (cancellation.signal.aborted) fail("CANCELLED", "版本检查已取消");
      if (executable(tool.path) !== fingerprint) fail("CONFLICT", "工具文件已改变，请重新检查");
      this.identities.set(tool.id, { path: tool.path, fingerprint, ...identity });
      return {
        tool: tool.id,
        path: tool.path,
        source: tool.source,
        exitCode: successful.exitCode,
        stdout: attempts.map((attempt) => attempt.stdout).join(""),
        stderr: attempts.map((attempt) => attempt.stderr).join(""),
        attempts,
        ...identity,
        available: tool.id !== "httpx" || identity.identity === "verified",
      };
    })();
    this.pending.set(cancellation, task);
    try {
      return await task;
    } finally {
      signal?.removeEventListener("abort", relay);
      this.pending.delete(cancellation);
      rmSync(probeHome, { recursive: true, force: true });
    }
  }

  async close() {
    this.closed = true;
    this.identities.clear();
    const tasks = [...this.pending.values()];
    for (const cancellation of this.pending.keys()) cancellation.abort();
    await Promise.allSettled(tasks);
  }

  dispatch(action, payload = {}, options = {}) {
    switch (action) {
      case "toolkit.status":
        fields(payload, []);
        return this.status();
      case "toolkit.save":
        return this.save(payload);
      case "toolkit.adapt":
        fields(payload, []);
        return this.adapt();
      case "toolkit.probe":
        return this.probe(payload, options);
      default:
        fail(
          "UNSUPPORTED",
          "仅支持显式路径登记、离线适配建议和固定版本/帮助检查，不支持启动扫描或常驻工具",
        );
    }
  }
}
