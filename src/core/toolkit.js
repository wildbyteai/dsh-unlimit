import { accessSync, constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
const OUTPUT_LIMIT = 64 * 1024;

function fields(payload, allowed) {
  object(payload);
  if (Object.keys(payload).some((key) => !allowed.includes(key))) {
    fail("INVALID_INPUT", "Unsupported toolkit option");
  }
}

function directory(value) {
  string(value, "root");
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
    this.closed = false;
  }

  status() {
    const root = this.store.meta(ROOT_KEY, "");
    const paths = inventory(root);
    return {
      root,
      tools: TOOLS.map(([id, name]) => ({
        id,
        name,
        available: paths.has(id),
        path: paths.get(id) ?? null,
      })),
      runs: [],
    };
  }

  save(payload) {
    fields(payload, ["root"]);
    const root = directory(payload.root);
    inventory(root);
    this.store.setMeta(ROOT_KEY, root);
    return this.status();
  }

  adapt() {
    const status = this.status();
    return {
      root: status.root,
      offline: true,
      missing: status.tools
        .filter((tool) => !tool.available)
        .map(({ id, name }) => ({
          id,
          name,
          advice: `在离线环境准备适合当前平台的 ${name} 可执行文件，放入选定工具目录或其一级子目录，然后重新检查。`,
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
    const { root, tools } = this.status();
    const tool = tools.find((item) => item.id === payload.tool);
    if (!tool.available) fail("NOT_FOUND", "所选工具不在已登记目录中，或不可执行");

    const cancellation = new AbortController();
    const relay = () => cancellation.abort();
    signal?.addEventListener("abort", relay, { once: true });
    const task = new Promise((resolve, reject) => {
      // Only necessary launcher environment is inherited; no API keys or user profile variables.
      const env = Object.fromEntries(
        ["PATH", "SystemRoot", "WINDIR"]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      );
      const child = spawn(tool.path, ["--version"], {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let failure = null;
      let bytes = 0;
      const output = { stdout: [], stderr: [] };
      const terminate = (code, message) => {
        if (failure) return;
        failure = new StoreError(code, message);
        stopProcess(child);
      };
      const abort = () => terminate("CANCELLED", "版本检查已取消");
      cancellation.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => terminate("TIMEOUT", "版本检查超时，进程已终止"), timeoutMs);
      for (const channel of ["stdout", "stderr"]) {
        child[channel].on("data", (chunk) => {
          const remaining = OUTPUT_LIMIT - bytes;
          if (remaining > 0) output[channel].push(chunk.subarray(0, remaining));
          bytes += chunk.length;
          if (bytes > OUTPUT_LIMIT) terminate("OUTPUT_LIMIT", "版本检查输出超过64KiB，进程已终止");
        });
      }
      child.on("error", () => {
        failure ??= new StoreError("TOOL_FAILED", "版本检查进程无法启动");
      });
      child.on("close", (exitCode, exitSignal) => {
        clearTimeout(timer);
        cancellation.signal.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (exitCode !== 0)
          return reject(
            new StoreError("TOOL_FAILED", `版本检查失败（退出码${exitCode ?? exitSignal}）`),
          );
        resolve({
          tool: tool.id,
          path: tool.path,
          exitCode,
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
        });
      });
    });
    this.pending.set(cancellation, task);
    try {
      return await task;
    } finally {
      signal?.removeEventListener("abort", relay);
      this.pending.delete(cancellation);
    }
  }

  async close() {
    this.closed = true;
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
          "仅支持工具目录登记、离线适配建议和固定--version检查，不支持启动扫描或常驻工具",
        );
    }
  }
}
