import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { StoreError, fail, object } from "../core/validation.js";
import { resolveOfficialPackage } from "./official-package.js";
import { boundWorkspace } from "./tools.js";

const OUTPUT_BYTES = 65536;
const MODES = ["read-only", "workspace-write", "danger-full-access"];
const TERMINAL = new Set(["exited", "failed", "denied", "stopped", "timed-out"]);
const now = () => new Date().toISOString();

function fields(payload, allowed) {
  object(payload);
  if (Object.keys(payload).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "进程请求包含未知字段");
}

function text(value, label, maxBytes, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes
  )
    fail("INVALID_INPUT", `${label}必须是长度受限且不含NUL的字符串`);
  return value;
}

function directory(value) {
  text(value, "cwd", 32768);
  if (!isAbsolute(value)) fail("INVALID_INPUT", "cwd必须是现有绝对目录");
  try {
    const path = realpathSync(value);
    if (lstatSync(path).isDirectory()) return path;
  } catch {
    // Filesystem diagnostics can contain private paths; report the boundary only.
  }
  fail("INVALID_INPUT", "cwd必须是现有可读取目录");
}

function fingerprint(path) {
  try {
    if (!isAbsolute(path) || realpathSync(path) !== path) return null;
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) return null;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  } catch {
    return null;
  }
}

function cancelled() {
  return new StoreError("CANCELLED", "进程准备已取消，未接受新的启动");
}

// The native approval channel supports cancellation. Race as well so a provider
// that settles late cannot keep plugin teardown waiting or cause a late spawn.
function abortable(value, signal) {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function policyOf(service, session, mode) {
  const policy = service.resolve({ session, ...(mode === undefined ? {} : { mode }) });
  if (
    !MODES.includes(policy?.mode) ||
    typeof policy.workspaceRoot !== "string" ||
    !isAbsolute(policy.workspaceRoot) ||
    policy.workspaceRoot.includes("\0")
  )
    fail("HOST_PROTOCOL_ERROR", "宿主没有返回有效的会话沙箱策略");
  return policy;
}

function readerOutput(reader, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    fail("INVALID_INPUT", "输出offset必须是非负安全整数");
  const first = reader ? reader.readFrom(0) : { text: "", nextOffset: 0, lossy: false };
  if (!Number.isSafeInteger(first?.nextOffset) || first.nextOffset < 0)
    fail("HOST_PROTOCOL_ERROR", "宿主没有返回有效的输出位置");
  if (offset > first.nextOffset) fail("INVALID_INPUT", "输出offset超过当前流末尾");
  const result = offset === 0 ? first : reader.readFrom(offset);
  if (
    typeof result?.text !== "string" ||
    !Number.isSafeInteger(result.nextOffset) ||
    result.nextOffset < offset ||
    typeof result.lossy !== "boolean"
  )
    fail("HOST_PROTOCOL_ERROR", "宿主没有返回有效的进程输出");
  // Deliberately omit provider-private fields such as spillPath.
  return { text: result.text, nextOffset: result.nextOffset, lossy: result.lossy };
}

/** Exact-argv processes owned by this plugin instance, using official host services. */
export class DesktopProcesses {
  constructor(ctx, store, host, { toolkit, admission } = {}) {
    this.ctx = ctx;
    this.store = store;
    this.host = host;
    this.toolkit = toolkit;
    this.admission = admission;
    this.runs = new Map();
    this.closed = false;
  }

  service(name) {
    // Cordis rejects property reads for an uninjected optional service. get()
    // already expresses absence; only plain contexts need property lookup.
    return typeof this.ctx.get === "function" ? this.ctx.get(name) : this.ctx[name];
  }

  capabilities() {
    const reasons = [];
    if (this.closed) reasons.push("进程适配器已关闭");
    if (this.host?.supported !== true) reasons.push("当前桌面宿主版本未适配");
    if (typeof this.service("subprocess")?.spawn !== "function")
      reasons.push("官方托管进程接口不可用");
    if (typeof this.service("sandboxPolicy")?.resolve !== "function")
      reasons.push("官方会话沙箱策略不可用");
    if (typeof this.service("sandbox")?.confine !== "function")
      reasons.push("官方进程沙箱接口不可用");
    if (typeof this.service("agents")?.get !== "function") reasons.push("宿主会话身份目录不可用");
    if (typeof this.toolkit?.status !== "function") reasons.push("已登记工具目录不可用");
    if (typeof this.admission?.require !== "function") reasons.push("演练区入场校验不可用");
    const seam = resolveOfficialPackage(this.host?.runtimeRoot, "@deepseek-ai/dsh-sandbox");
    if (!seam.url) reasons.push("官方沙箱审批接口未通过发行清单校验");
    return {
      start: reasons.length === 0,
      list: true,
      output: true,
      stop: true,
      detail:
        reasons.join("；") ||
        "仅真实模型调用可启动已登记工具；使用会话权限、官方单次审批与沙箱。停止只覆盖本插件持有的宿主管理范围；逃离该范围的后代不保证收回。",
    };
  }

  actor(execution) {
    const agent = execution?.agent;
    const id = agent?.session?.id;
    if (
      !execution ||
      typeof id !== "string" ||
      this.service("agents")?.get?.(id) !== agent ||
      typeof execution.callId !== "string" ||
      !execution.callId.trim() ||
      typeof execution.toolName !== "string" ||
      !execution.toolName.trim() ||
      (execution.signal !== undefined && !(execution.signal instanceof AbortSignal))
    )
      fail("OFFICIAL_EXECUTION_REQUIRED", "启动和模型进程操作必须来自真实宿主工具调用");
    text(id, "sessionId", 256);
    text(execution.callId, "callId", 256);
    text(execution.toolName, "toolName", 128);
    return agent;
  }

  scope(payload, execution, requireActor = false) {
    if (requireActor || execution !== undefined) {
      const agent = this.actor(execution);
      const workspace = boundWorkspace(this.store, agent, this.service("agents"));
      if (!workspace) fail("WORKSPACE_REQUIRED", "本会话尚未绑定演练工作区");
      if (payload.workspaceId !== undefined && payload.workspaceId !== workspace.id)
        fail("WORKSPACE_MISMATCH", "请求工作区与本会话绑定不一致");
      return { workspaceId: workspace.id, sessionId: agent.session.id, agent };
    }
    const id = text(payload.workspaceId, "workspaceId", 128);
    return { workspaceId: this.store.get("workspaces", id).id };
  }

  snapshot(run) {
    return structuredClone(run.item);
  }

  owned(scope, id) {
    const run = this.runs.get(text(id, "id", 128));
    if (
      !run ||
      run.item.workspaceId !== scope.workspaceId ||
      (scope.sessionId !== undefined && run.item.sessionId !== scope.sessionId)
    )
      fail("NOT_FOUND", "当前作用域没有本插件拥有的进程");
    return run;
  }

  async dispatch(action, payload = {}, execution) {
    switch (action) {
      case "processes.capabilities":
        fields(payload, []);
        return this.capabilities();
      case "processes.start":
        return this.start(payload, execution);
      case "processes.list": {
        fields(payload, ["workspaceId"]);
        const scope = this.scope(payload, execution);
        return {
          items: [...this.runs.values()]
            .filter(
              (run) =>
                run.item.workspaceId === scope.workspaceId &&
                (scope.sessionId === undefined || run.item.sessionId === scope.sessionId),
            )
            .map((run) => this.snapshot(run)),
        };
      }
      case "processes.output": {
        fields(payload, ["workspaceId", "id", "stdoutOffset", "stderrOffset"]);
        const run = this.owned(this.scope(payload, execution), payload.id);
        try {
          return {
            item: this.snapshot(run),
            stdout: readerOutput(run.handle?.collected.stdout, payload.stdoutOffset),
            stderr: readerOutput(run.handle?.collected.stderr, payload.stderrOffset),
          };
        } catch (error) {
          if (error instanceof StoreError) throw error;
          fail("PROCESS_OUTPUT_FAILED", "宿主无法读取本插件进程的输出");
        }
      }
      case "processes.stop":
        fields(payload, ["workspaceId", "id"]);
        return this.stop(this.owned(this.scope(payload, execution), payload.id));
      default:
        fail("UNKNOWN_ACTION", "未知进程操作");
    }
  }

  selected(id) {
    const selected = this.toolkit.status().tools.find((tool) => tool.id === id);
    if (!selected?.available || !selected.path)
      fail("TOOL_UNAVAILABLE", "所选工具未在当前登记目录中就绪");
    const identity = fingerprint(selected.path);
    if (!identity) fail("TOOL_UNAVAILABLE", "所选工具不是现有的规范可执行文件");
    return { id, path: selected.path, fingerprint: identity };
  }

  validateStart(payload) {
    fields(payload, [
      "workspaceId",
      "tool",
      "args",
      "cwd",
      "timeoutMs",
      "sandbox_permissions",
      "justification",
    ]);
    text(payload.tool, "tool", 128);
    if (!Array.isArray(payload.args) || payload.args.length > 256)
      fail("INVALID_INPUT", "args必须是最多256项的参数数组");
    const args = Array.from(payload.args, (arg) => text(arg, "args条目", 32768, true));
    if (args.reduce((size, arg) => size + Buffer.byteLength(arg), 0) > 256 * 1024)
      fail("INVALID_INPUT", "参数总长度超过256KiB");
    if (
      payload.timeoutMs !== undefined &&
      (!Number.isSafeInteger(payload.timeoutMs) ||
        payload.timeoutMs < 50 ||
        payload.timeoutMs > 86400000)
    )
      fail("INVALID_INPUT", "timeoutMs必须是50到86400000之间的整数");
    if (
      payload.sandbox_permissions !== undefined &&
      !["workspace-write", "danger-full-access"].includes(payload.sandbox_permissions)
    )
      fail("INVALID_INPUT", "sandbox_permissions不是有效的单次提权目标");
    if (payload.justification !== undefined) text(payload.justification, "justification", 4096);
    return args;
  }

  async start(payload, execution) {
    // An HTTP payload cannot manufacture an execution Agent, call id or turn.
    this.actor(execution);
    if (this.closed) fail("CLOSED", "进程适配器已关闭");
    const args = this.validateStart(payload);
    const scope = this.scope(payload, execution, true);
    const caps = this.capabilities();
    if (!caps.start) fail("UNSUPPORTED_CAPABILITY", caps.detail);
    this.admission.require();
    if (execution.signal?.aborted) throw cancelled();
    const selected = this.selected(payload.tool);
    const cwd = directory(payload.cwd === undefined ? scope.agent.session.header.cwd : payload.cwd);
    const run = {
      item: {
        id: randomUUID(),
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        tool: selected.id,
        args,
        cwd,
        mode: null,
        status: "preparing",
        createdAt: now(),
        exitCode: null,
        exitSignal: null,
      },
      abort: new AbortController(),
      handle: null,
      stopReason: null,
      rangeExited: false,
    };
    const relay = () => run.abort.abort();
    execution.signal?.addEventListener("abort", relay, { once: true });
    const detach = () => execution.signal?.removeEventListener("abort", relay);
    this.runs.set(run.item.id, run);
    run.ready = this.prepare(run, payload, execution, scope.agent, selected, detach).finally(
      detach,
    );
    await run.ready;
    return { item: this.snapshot(run) };
  }

  guard(run) {
    if (this.closed || run.abort.signal.aborted) throw cancelled();
    this.admission.require();
  }

  async prepare(run, payload, execution, agent, selected, detach) {
    try {
      const resolved = resolveOfficialPackage(this.host.runtimeRoot, "@deepseek-ai/dsh-sandbox");
      if (!resolved.url) fail("UNSUPPORTED_CAPABILITY", "官方沙箱审批接口未通过发行清单校验");
      const native = await abortable(import(resolved.url), run.abort.signal);
      run.native = native;
      if (
        typeof native.validateEscalationArgs !== "function" ||
        typeof native.approveEscalation !== "function"
      )
        fail("UNSUPPORTED_CAPABILITY", "官方沙箱没有提供单次审批接口");
      this.guard(run);
      try {
        native.validateEscalationArgs(payload.sandbox_permissions, payload.justification);
      } catch {
        fail("INVALID_INPUT", "sandbox_permissions与非空justification必须成对提供");
      }
      const policies = this.service("sandboxPolicy");
      let policy = policyOf(policies, agent.session);
      if (payload.sandbox_permissions !== undefined) {
        let granted;
        try {
          granted = await abortable(
            native.approveEscalation(
              {
                requestedMode: payload.sandbox_permissions,
                effectiveMode: policy.mode,
                justification: payload.justification,
                subject: "command",
              },
              {
                approver: this.service("approval"),
                agent,
                toolName: execution.toolName,
                callId: execution.callId,
                signal: run.abort.signal,
              },
            ),
            run.abort.signal,
          );
        } catch (error) {
          if (run.abort.signal.aborted) throw cancelled();
          fail("PROCESS_DENIED", "本次沙箱提权未获允许，未启动进程");
        }
        this.guard(run);
        policy = policyOf(policies, agent.session, granted);
      }
      run.item.mode = policy.mode;
      const argv = [selected.path, ...run.item.args];
      if (policy.mode === "danger-full-access") {
        run.wrap = { argv, enforcement: "none" };
      } else {
        run.wrap = await abortable(
          this.service("sandbox").confine(argv, policy, run.abort.signal),
          run.abort.signal,
        );
        if (
          !Array.isArray(run.wrap?.argv) ||
          run.wrap.argv.length === 0 ||
          run.wrap.argv.some((arg) => typeof arg !== "string" || arg.includes("\0"))
        )
          fail("HOST_PROTOCOL_ERROR", "官方沙箱没有返回有效的受限启动参数");
      }
      this.guard(run);
      this.scope({ workspaceId: run.item.workspaceId }, execution, true);
      const current = this.selected(selected.id);
      if (current.path !== selected.path || current.fingerprint !== selected.fingerprint)
        fail("CONFLICT", "工具登记或可执行文件已改变，请重新发起调用");
      if (directory(run.item.cwd) !== run.item.cwd)
        fail("CONFLICT", "cwd目录已改变，请重新发起调用");
      run.item.enforcement = run.wrap.enforcement;
      run.handle = this.service("subprocess").spawn({
        argv: run.wrap.argv,
        cwd: run.item.cwd,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: OUTPUT_BYTES },
          stderr: { maxBytes: OUTPUT_BYTES },
        },
        graceMs: 1000,
        signal: run.abort.signal,
      });
      // No env override: the official subprocess provider supplies its scrubbed
      // ambient defaults. LocalEnvironment secrets never enter this adapter.
      detach();
      run.item.status = "running";
      run.item.startedAt = now();
      run.completion = this.observe(run);
      if (payload.timeoutMs !== undefined) {
        run.item.timeoutMs = payload.timeoutMs;
        run.timer = setTimeout(() => {
          this.stop(run, "timeout").catch(() => {});
        }, payload.timeoutMs);
        run.timer.unref?.();
      }
    } catch (error) {
      if (run.handle) {
        // A handle is never discarded while it might own a native process.
        this.cleanupFailed(run);
      } else {
        run.item.status =
          run.abort.signal.aborted || error?.code === "CANCELLED"
            ? "stopped"
            : error?.code === "PROCESS_DENIED"
              ? "denied"
              : "failed";
        run.item.finishedAt = now();
        run.item.error = this.failure(run, error);
      }
      const failure = new StoreError(run.item.error.code, run.item.error.message);
      failure.partial = { item: this.snapshot(run) };
      throw failure;
    }
  }

  failure(run, error) {
    if (error instanceof StoreError) return { code: error.code, message: error.message };
    const unavailable =
      error?.code === "SANDBOX_UNAVAILABLE" ||
      (run.item.mode !== "danger-full-access" &&
        run.native?.isRunnerSpawnFailure?.(error, run.wrap?.argv[0], run.item.cwd));
    return unavailable
      ? { code: "SANDBOX_UNAVAILABLE", message: "官方沙箱无法执行本次受限启动，未降级运行" }
      : { code: "PROCESS_FAILED", message: "宿主进程启动或执行失败" };
  }

  cleanupFailed(run) {
    run.rangeExited = false;
    run.item.status = "cleanup-pending";
    run.item.error = {
      code: "PROCESS_CLEANUP_FAILED",
      message: "宿主尚未确认本插件进程管理范围已退出，可再次停止重试清理",
    };
    delete run.item.finishedAt;
  }

  async observe(run) {
    run.done = Promise.resolve(run.handle.done).then(
      (result) => {
        run.outcome = result;
        run.item.exitCode = result.exitCode;
        run.item.exitSignal = result.signal;
        run.item.commandExitedAt = now();
        if (run.item.status !== "cleanup-pending")
          run.item.status = run.stopReason ? "stopping" : "settling";
      },
      (error) => {
        run.processError = this.failure(run, error);
        if (run.item.status !== "cleanup-pending") run.item.status = "settling";
      },
    );
    const range = Promise.resolve().then(() => run.handle.waitForExit());
    await Promise.all([
      run.done,
      range.then(
        () => {
          run.rangeExited = true;
        },
        () => this.cleanupFailed(run),
      ),
    ]);
    this.finish(run);
  }

  finish(run) {
    if (!run.rangeExited) return;
    clearTimeout(run.timer);
    run.item.finishedAt = now();
    delete run.item.error;
    if (run.stopReason) {
      run.item.status = run.stopReason === "timeout" ? "timed-out" : "stopped";
    } else if (run.processError) {
      run.item.status = "failed";
      run.item.error = run.processError;
    } else {
      try {
        const stderr = readerOutput(run.handle.collected.stderr).text;
        const exitCode = run.outcome.exitCode;
        if (
          run.native.classifyRunnerFailure?.(exitCode, stderr, run.wrap.runnerFailureRules ?? [])
        ) {
          run.item.status = "failed";
          run.item.error = {
            code: "SANDBOX_UNAVAILABLE",
            message: "官方沙箱运行器失败，未降级为不受限运行",
          };
        } else if (
          run.native.matchesSignature?.(exitCode, stderr, run.wrap.denialSignatures ?? [])
        ) {
          run.item.status = "denied";
          run.item.error = { code: "SANDBOX_DENIED", message: "进程操作被当前会话沙箱拒绝" };
        } else {
          run.item.status = exitCode === 0 ? "exited" : "failed";
          if (exitCode !== 0)
            run.item.error = { code: "PROCESS_EXIT_FAILED", message: "进程未成功退出" };
        }
      } catch {
        run.item.status = "failed";
        run.item.error = { code: "PROCESS_OUTPUT_FAILED", message: "宿主无法读取进程退出诊断" };
      }
    }
  }

  async stop(run, reason = "stop") {
    if (TERMINAL.has(run.item.status) && (!run.handle || run.rangeExited))
      return { item: this.snapshot(run), stopped: false };
    run.stopReason ??= reason;
    run.item.status = "stopping";
    run.abort.abort();
    if (!run.handle) {
      await run.ready.catch(() => {});
      return { item: this.snapshot(run), stopped: true };
    }
    try {
      await run.handle.terminate();
      await Promise.all([run.done, run.handle.waitForExit()]);
      run.rangeExited = true;
      this.finish(run);
    } catch {
      this.cleanupFailed(run);
      const error = new StoreError(run.item.error.code, run.item.error.message);
      error.partial = { item: this.snapshot(run) };
      throw error;
    }
    return { item: this.snapshot(run), stopped: true };
  }

  async stopAll() {
    const results = await Promise.allSettled([...this.runs.values()].map((run) => this.stop(run)));
    const items = [...this.runs.values()].map((run) => this.snapshot(run));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      const error = new StoreError("PROCESS_CLEANUP_FAILED", "部分本插件进程尚未确认停止");
      error.partial = { items, stopped: false };
      throw error;
    }
    return { items, stopped: true };
  }

  async close() {
    this.closed = true;
    return this.stopAll();
  }
}

export default DesktopProcesses;
