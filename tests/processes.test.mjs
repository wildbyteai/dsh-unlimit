import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceStore } from "../src/core/store.js";
import { Toolkit } from "../src/core/toolkit.js";
import { StoreError } from "../src/core/validation.js";
import { DesktopProcesses } from "../src/host/processes.js";
import { SUPPORTED_HOST } from "../src/host/desktop.js";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("synthetic process condition did not settle");
}

function tail() {
  let bytes = Buffer.alloc(0),
    total = 0;
  return {
    push(text) {
      const chunk = Buffer.from(text);
      total += chunk.length;
      bytes = Buffer.concat([bytes, chunk]).subarray(-65536);
    },
    readFrom(offset) {
      const start = total - bytes.length;
      return {
        text: bytes.subarray(Math.max(0, offset - start)).toString("utf8"),
        nextOffset: total,
        lossy: offset < start,
        spillPath: "/synthetic/provider-private-output",
      };
    },
  };
}

function handle() {
  const command = deferred(),
    range = deferred();
  const value = {
    done: command.promise,
    collected: { stdout: tail(), stderr: tail() },
    nativePid: 999999,
    terminations: 0,
    waitCalls: 0,
    cleanupError: null,
    terminateError: null,
    finish(exitCode = 0, signal = null) {
      command.resolve({ exitCode, signal });
    },
    fail(error) {
      command.reject(error);
    },
    quiesce() {
      range.resolve();
    },
    terminate() {
      value.terminations++;
      if (value.terminateError) throw value.terminateError;
      value.finish(null, "SIGTERM");
      value.quiesce();
    },
    waitForExit() {
      value.waitCalls++;
      return value.cleanupError ? Promise.reject(value.cleanupError) : range.promise;
    },
  };
  return value;
}

// These original test doubles exercise the adapter contract. They do not load
// installed tools, profiles, native processes, credentials or network services.
const sandboxModule = `
export const calls = [];
export function validateEscalationArgs(mode, reason) {
  calls.push({kind:'pair',mode,reason});
  if ((mode === undefined) !== (reason === undefined)) throw Error('pair required');
  if (reason !== undefined && !reason.trim()) throw Error('reason required');
}
export async function approveEscalation(request, approval) {
  calls.push({kind:'approval',request,approval});
  if (request.requestedMode === request.effectiveMode) return request.effectiveMode;
  const rank = ['read-only','workspace-write','danger-full-access'];
  if (rank.indexOf(request.requestedMode) <= rank.indexOf(request.effectiveMode)) throw Error('not wider');
  if (!approval.approver) throw Error('no channel');
  const result = await approval.approver.request({...approval,requestedMode:request.requestedMode});
  if (result !== 'allowed-once') throw Error('synthetic denied with PRIVATE_PROVIDER_TEXT');
  return request.requestedMode;
}
export function classifyRunnerFailure(code, stderr, rules) {
  calls.push({kind:'runner',code,stderr,rules});
  if (code && rules.some(rule=>rule.fatalSignatures.some(word=>stderr.includes(word)))) return {detail:'PRIVATE_FATAL_LINE'};
}
export function matchesSignature(code, stderr, signatures) {
  calls.push({kind:'signature',code,stderr,signatures});
  return Boolean(code && signatures.some(word=>stderr.includes(word)));
}
export function isRunnerSpawnFailure(error, runner, cwd) {
  calls.push({kind:'spawn-failure',runner,cwd});
  return error?.code === 'ENOENT' && error?.path === runner;
}
`;

async function fixture(t, { mode = "read-only" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-processes-")));
  const cwd = join(root, "workspace"),
    outside = join(root, "other cwd");
  const toolkitRoot = join(root, "tools with spaces ; $ literal");
  const runtime = join(root, "synthetic-runtime");
  const pkg = join(runtime, "node_modules", "@deepseek-ai", "dsh-sandbox");
  for (const path of [cwd, outside, toolkitRoot, pkg]) mkdirSync(path, { recursive: true });
  writeFileSync(join(runtime, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-sandbox", type: "module", main: "index.js" }),
  );
  writeFileSync(join(pkg, "index.js"), sandboxModule);
  writeFileSync(
    join(runtime, "desktop-runtime.json"),
    JSON.stringify({
      release: { version: SUPPORTED_HOST },
      files: [
        {
          path: "node_modules/@deepseek-ai/dsh-sandbox/index.js",
          sha256: createHash("sha256").update(sandboxModule).digest("hex"),
        },
      ],
    }),
  );
  const seam = await import(pathToFileURL(join(pkg, "index.js")).href);
  const toolPath = join(toolkitRoot, "nmap");
  writeFileSync(toolPath, "#!/synthetic/never-executed\n", { mode: 0o700 });
  writeFileSync(join(toolkitRoot, "httpx"), "#!/synthetic/never-executed\n", { mode: 0o700 });
  const store = new WorkspaceStore(join(root, "synthetic.sqlite"));
  const workspace = store.dispatch("workspaces.save", { name: "Synthetic process workspace" }).item;
  const other = store.dispatch("workspaces.save", { name: "Another synthetic workspace" }).item;
  const toolkit = new Toolkit(store);
  toolkit.save({ root: toolkitRoot });
  const agents = new Map();
  const f = {
    root,
    cwd,
    outside,
    toolPath,
    toolkitRoot,
    runtime,
    seam,
    store,
    workspace,
    other,
    toolkit,
    mode,
    accepted: true,
    specs: [],
    wraps: [],
    policies: [],
    approvals: [],
    handles: [],
    globalCleanupCalls: 0,
  };
  const services = {
    agents: { get: (id) => agents.get(id) },
    sandboxPolicy: {
      resolve(request) {
        f.policies.push(request);
        return {
          mode: request.mode ?? f.mode,
          workspaceRoot: request.session.header.cwd,
          sessionId: request.session.id,
        };
      },
    },
    sandbox: {
      async confine(argv, policy, signal) {
        f.wraps.push({ argv: [...argv], policy, signal });
        if (f.confine) return f.confine(argv, policy, signal);
        return {
          argv: ["synthetic-sandbox", "--", ...argv],
          enforcement: "full",
          runnerFailureRules: [{ fatalSignatures: ["synthetic runner fatal"] }],
          denialSignatures: ["synthetic file denial"],
        };
      },
    },
    approval: {
      request(request) {
        f.approvals.push(request);
        return f.approve ? f.approve(request) : "allowed-once";
      },
    },
    subprocess: {
      spawn(spec) {
        f.specs.push(spec);
        if (f.spawnError) throw f.spawnError;
        const child = f.nextHandle ?? handle();
        f.nextHandle = null;
        f.handles.push(child);
        spec.signal.addEventListener(
          "abort",
          () => {
            try {
              child.terminate();
            } catch {}
          },
          { once: true },
        );
        return child;
      },
      disposeManagedProcesses() {
        f.globalCleanupCalls++;
      },
    },
  };
  const ctx = { get: (name) => services[name] };
  const admission = {
    require() {
      if (!f.accepted) throw new StoreError("ADMISSION_REQUIRED", "Synthetic admission required");
    },
  };
  const processes = new DesktopProcesses(
    ctx,
    store,
    { supported: true, runtimeRoot: runtime },
    { toolkit, admission },
  );
  f.agent = (id, parent) => {
    const agent = {
      session: { id, header: { cwd, ...(parent ? { parentSession: parent } : {}) } },
    };
    agents.set(id, agent);
    return agent;
  };
  f.main = f.agent("synthetic-main");
  store.dispatch("workspaces.bind", { id: workspace.id, sessionId: f.main.session.id });
  f.execution = (agent = f.main, signal) => ({
    agent,
    signal,
    callId: "synthetic-call",
    toolName: "unlimit_processes",
  });
  f.start = (payload = {}, execution = f.execution()) =>
    processes.dispatch("processes.start", { tool: "nmap", args: [], ...payload }, execution);
  f.call = (action, payload = {}, execution) =>
    processes.dispatch(`processes.${action}`, payload, execution);
  f.list = (execution) => f.call("list", execution ? {} : { workspaceId: workspace.id }, execution);
  Object.assign(f, { ctx, services, admission, processes, agents });
  t.after(async () => {
    for (const child of f.handles) {
      child.cleanupError = null;
      child.terminateError = null;
    }
    await processes.close();
    await toolkit.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test("optional Cordis services stay optional and capabilities never start a process", async (t) => {
  const ctx = new Proxy(
    {
      get() {
        return undefined;
      },
    },
    {
      get(target, key) {
        if (key === "get") return target.get;
        throw new Error("uninjected property must not be accessed");
      },
    },
  );
  const processes = new DesktopProcesses(ctx, {}, { supported: false }, {});
  assert.equal(processes.capabilities().start, false);
  assert.equal(processes.capabilities().list, true);
  const f = await fixture(t);
  assert.equal(f.processes.capabilities().start, true);
  assert.deepEqual(f.specs, []);
  writeFileSync(join(f.runtime, "node_modules/@deepseek-ai/dsh-sandbox/index.js"), "export {};\n");
  assert.equal(f.processes.capabilities().start, false);
  await assert.rejects(f.start(), { code: "UNSUPPORTED_CAPABILITY" });
});

test("start needs a live official model execution, admission and matching bound workspace before effects", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.call("start", { tool: "nmap", args: [], workspaceId: f.workspace.id }), {
    code: "OFFICIAL_EXECUTION_REQUIRED",
  });
  const forged = { ...f.main, session: { ...f.main.session } };
  await assert.rejects(f.start({}, f.execution(forged)), { code: "OFFICIAL_EXECUTION_REQUIRED" });
  await assert.rejects(f.start({ workspaceId: f.other.id }), { code: "WORKSPACE_MISMATCH" });
  f.accepted = false;
  await assert.rejects(f.start(), { code: "ADMISSION_REQUIRED" });
  assert.equal(f.processes.runs.size, 0);
  assert.deepEqual(f.specs, []);
  assert.deepEqual(f.wraps, []);
});

test("exact arguments use official confinement, original session root and scrubbed provider defaults", async (t) => {
  const f = await fixture(t);
  const args = ["", "space value", "; touch not-a-command", "$(literal)", "--flag=value"];
  const { item } = await f.start({ args, cwd: f.outside });
  assert.equal(item.status, "running");
  assert.equal(item.cwd, f.outside);
  assert.equal(item.mode, "read-only");
  assert.deepEqual(f.wraps[0].argv, [f.toolPath, ...args]);
  assert.equal(f.wraps[0].policy.workspaceRoot, f.cwd);
  assert.equal(f.wraps[0].policy.sessionId, f.main.session.id);
  assert.deepEqual(f.specs[0].argv, ["synthetic-sandbox", "--", f.toolPath, ...args]);
  assert.deepEqual(f.specs[0].stdio, {
    stdin: "ignore",
    stdout: { maxBytes: 65536 },
    stderr: { maxBytes: 65536 },
  });
  assert.equal(f.specs[0].graceMs, 1000);
  assert.equal(Object.hasOwn(f.specs[0], "env"), false);
  assert.equal(Object.hasOwn(f.specs[0], "shell"), false);
  assert.equal(JSON.stringify(item).includes("999999"), false);
  item.args.push("outside mutation");
  assert.deepEqual((await f.list()).items[0].args, args);
});

test("full access follows native policy without adding a confinement grant or requesting approval", async (t) => {
  const f = await fixture(t, { mode: "danger-full-access" });
  const { item } = await f.start();
  assert.equal(item.mode, "danger-full-access");
  assert.deepEqual(f.specs[0].argv, [f.toolPath]);
  assert.equal(f.wraps.length, 0);
  assert.equal(f.approvals.length, 0);
});

test("argument, path and escalation validation rejects malformed requests without spawning", async (t) => {
  const f = await fixture(t);
  for (const payload of [
    { tool: "../nmap" },
    { tool: f.toolPath },
    { tool: "httpx" },
    { args: "--version" },
    { args: [1] },
    { args: Array(1) },
    { args: ["bad\0arg"] },
    { args: ["x".repeat(32769)] },
    { args: Array(257).fill("") },
    { args: Array(9).fill("x".repeat(32768)) },
    { cwd: null },
    { cwd: "relative" },
    { cwd: f.toolPath },
    { cwd: join(f.root, "missing") },
    { timeoutMs: 49 },
    { timeoutMs: 86400001 },
    { timeoutMs: NaN },
    { env: { SYNTHETIC_TOKEN: "not-forwarded" } },
    { command: "sh -c ignored" },
    { sandbox_permissions: "workspace-write" },
    { justification: "only reason" },
    { sandbox_permissions: "read-only", justification: "invalid target" },
    { sandbox_permissions: "workspace-write", justification: " " },
  ]) {
    await assert.rejects(f.start(payload));
  }
  assert.equal(f.specs.length, 0);
});

test("one-shot escalation uses native pairing, exact Agent/call and re-resolved policy", async (t) => {
  const f = await fixture(t);
  const { item } = await f.start({
    sandbox_permissions: "workspace-write",
    justification: "Synthetic one-shot",
  });
  assert.equal(item.mode, "workspace-write");
  assert.equal(f.mode, "read-only");
  assert.equal(f.approvals.length, 1);
  assert.equal(f.approvals[0].agent, f.main);
  assert.equal(f.approvals[0].callId, "synthetic-call");
  assert.equal(f.approvals[0].toolName, "unlimit_processes");
  assert.equal(f.policies.at(-1).mode, "workspace-write");
  assert.equal(f.policies.at(-1).session, f.main.session);
  assert.equal(f.wraps[0].policy.workspaceRoot, f.cwd);
  await f.start();
  assert.equal(f.wraps[1].policy.mode, "read-only");
  f.approve = () => "rejected";
  await assert.rejects(
    f.start({ sandbox_permissions: "workspace-write", justification: "Synthetic deny" }),
    (error) => {
      assert.equal(error.code, "PROCESS_DENIED");
      assert.equal(error.partial.item.status, "denied");
      assert.equal(JSON.stringify(error.partial).includes("PRIVATE_PROVIDER_TEXT"), false);
      return true;
    },
  );
  assert.equal(f.specs.length, 2);
});

test("changed executable, changed configuration and rebound session after approval prevent spawn", async (t) => {
  for (const change of ["file", "config", "binding"]) {
    const f = await fixture(t);
    f.approve = () => {
      if (change === "file") writeFileSync(f.toolPath, "#!/synthetic/replaced-file\n");
      if (change === "config") f.toolkit.save({ root: "" });
      if (change === "binding")
        f.store.dispatch("workspaces.bind", { id: f.other.id, sessionId: f.main.session.id });
      return "allowed-once";
    };
    await assert.rejects(
      f.start({ sandbox_permissions: "workspace-write", justification: "Synthetic race" }),
    );
    assert.equal(f.specs.length, 0);
  }
});

test("model reads and stops only its own session; UI scope sees only plugin runs in the requested project", async (t) => {
  const f = await fixture(t);
  const child = f.agent("synthetic-child", f.main.session.id);
  const a = await f.start();
  const b = await f.start({}, f.execution(child));
  assert.deepEqual(
    (await f.list(f.execution())).items.map((item) => item.id),
    [a.item.id],
  );
  assert.deepEqual(
    (await f.list(f.execution(child))).items.map((item) => item.id),
    [b.item.id],
  );
  assert.equal((await f.list()).items.length, 2);
  for (const action of ["output", "stop"])
    await assert.rejects(f.call(action, { id: b.item.id }, f.execution()), { code: "NOT_FOUND" });
  await assert.rejects(f.call("output", { id: a.item.id, workspaceId: f.other.id }), {
    code: "NOT_FOUND",
  });
  await assert.rejects(f.call("list"), { code: "INVALID_INPUT" });
  const unrelated = handle();
  const stopped = await f.call("stop", { workspaceId: f.workspace.id, id: b.item.id });
  assert.equal(stopped.item.status, "stopped");
  assert.equal(stopped.stopped, true);
  assert.equal(unrelated.terminations, 0);
  assert.equal(f.globalCleanupCalls, 0);
});

test("output offsets are independent, bounded, lossy and never disclose provider spill fields", async (t) => {
  const f = await fixture(t);
  const { item } = await f.start();
  const child = f.handles[0];
  child.collected.stdout.push("abc");
  child.collected.stderr.push("xy");
  const output = () => f.call("output", { workspaceId: f.workspace.id, id: item.id });
  const first = await output();
  assert.deepEqual(first.stdout, { text: "abc", nextOffset: 3, lossy: false });
  assert.deepEqual((await output()).stdout, first.stdout);
  child.collected.stdout.push("def");
  assert.deepEqual(
    (await f.call("output", { id: item.id, stdoutOffset: 3, stderrOffset: 2 }, f.execution()))
      .stdout,
    { text: "def", nextOffset: 6, lossy: false },
  );
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 7])
    await assert.rejects(f.call("output", { id: item.id, stdoutOffset: offset }, f.execution()), {
      code: "INVALID_INPUT",
    });
  child.collected.stdout.push("z".repeat(70000));
  const last = await output();
  assert.equal(last.stdout.lossy, true);
  assert.equal(Buffer.byteLength(last.stdout.text), 65536);
  assert.equal(last.stdout.nextOffset, 70006);
  assert.equal(JSON.stringify(last).includes("provider-private"), false);
});

test("direct command completion is settling until managed-range exit is confirmed", async (t) => {
  const f = await fixture(t);
  const { item } = await f.start();
  const child = f.handles[0];
  child.finish(0, null);
  await until(() => f.processes.runs.get(item.id).item.status === "settling");
  assert.equal((await f.list()).items[0].finishedAt, undefined);
  child.quiesce();
  await until(() => f.processes.runs.get(item.id).item.status === "exited");
  const ended = (await f.list()).items[0];
  assert.equal(ended.exitCode, 0);
  assert.equal(ended.exitSignal, null);
  assert.ok(ended.finishedAt);
  assert.equal((await f.call("stop", { id: item.id }, f.execution())).stopped, false);
});

test("runner failures, sandbox denials and provider errors stay distinct and safe", async (t) => {
  for (const [stderr, expectedStatus, expectedCode] of [
    ["synthetic runner fatal PRIVATE_OUTPUT", "failed", "SANDBOX_UNAVAILABLE"],
    ["synthetic file denial PRIVATE_OUTPUT", "denied", "SANDBOX_DENIED"],
    ["ordinary command error", "failed", "PROCESS_EXIT_FAILED"],
  ]) {
    const f = await fixture(t);
    const { item } = await f.start();
    const child = f.handles[0];
    child.collected.stderr.push(stderr);
    child.finish(7, null);
    child.quiesce();
    await until(() => f.processes.runs.get(item.id).item.finishedAt);
    const ended = (await f.list()).items[0];
    assert.equal(ended.status, expectedStatus);
    assert.equal(ended.error.code, expectedCode);
    assert.equal(JSON.stringify(ended).includes("PRIVATE_"), false);
    assert.equal(f.specs.length, 1);
    assert.ok(f.seam.calls.some((call) => call.kind === "runner" && call.code === 7));
  }
  const f = await fixture(t);
  const { item } = await f.start();
  f.handles[0].fail(
    Object.assign(new Error("PRIVATE_SPAWN_ARGUMENTS"), {
      code: "ENOENT",
      path: "synthetic-sandbox",
    }),
  );
  f.handles[0].quiesce();
  await until(() => f.processes.runs.get(item.id).item.finishedAt);
  assert.equal((await f.list()).items[0].error.code, "SANDBOX_UNAVAILABLE");
});

test("external cancellation stops preparation but detaches after accepted background start", async (t) => {
  const f = await fixture(t);
  const external = new AbortController();
  const { item } = await f.start({}, f.execution(f.main, external.signal));
  external.abort();
  await tick();
  assert.equal((await f.list()).items[0].status, "running");
  assert.equal(f.handles[0].terminations, 0);
  assert.equal(f.specs[0].signal.aborted, false);
  await f.call("stop", { id: item.id }, f.execution());
  assert.equal(f.specs[0].signal.aborted, true);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.start({}, f.execution(f.main, cancelled.signal)), { code: "CANCELLED" });
  assert.equal(f.specs.length, 1);
});

test("deadline and explicit stop await both native outcomes and only terminate owned handles", async (t) => {
  const f = await fixture(t);
  const { item } = await f.start({ timeoutMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal((await f.list()).items.find((run) => run.id === item.id).status, "timed-out");
  const keep = await f.start();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await f.list()).items.find((run) => run.id === keep.item.id).status, "running");
  const unrelated = handle();
  const result = await f.processes.stopAll();
  assert.equal(result.stopped, true);
  assert.equal(result.items.find((run) => run.id === keep.item.id).status, "stopped");
  assert.equal(unrelated.terminations, 0);
  assert.equal(f.globalCleanupCalls, 0);
});

test("cleanup failure remains pending, retains ownership and supports a later explicit stop", async (t) => {
  const f = await fixture(t);
  const { item } = await f.start();
  const child = f.handles[0];
  child.cleanupError = new Error("PRIVATE_CLEANUP_DETAILS");
  await assert.rejects(f.call("stop", { id: item.id }, f.execution()), (error) => {
    assert.equal(error.code, "PROCESS_CLEANUP_FAILED");
    assert.equal(error.partial.item.status, "cleanup-pending");
    assert.equal(error.partial.item.finishedAt, undefined);
    assert.equal(JSON.stringify(error.partial).includes("PRIVATE_CLEANUP_DETAILS"), false);
    return true;
  });
  child.cleanupError = null;
  const result = await f.call("stop", { id: item.id }, f.execution());
  assert.equal(result.item.status, "stopped");
  assert.ok(result.item.finishedAt);
});

test("close and admission revoke cancel pending approval without waiting for its late answer", async (t) => {
  for (const action of ["close", "revoke"]) {
    const f = await fixture(t);
    const approval = deferred();
    f.approve = () => approval.promise;
    const start = f.start({
      sandbox_permissions: "workspace-write",
      justification: "Synthetic pending",
    });
    const rejected = assert.rejects(start, { code: "CANCELLED" });
    await until(() => f.approvals.length === 1);
    if (action === "close") await f.processes.close();
    else {
      f.accepted = false;
      await f.processes.stopAll();
    }
    await rejected;
    approval.resolve("allowed-once");
    await tick();
    assert.equal(f.specs.length, 0);
    assert.equal((await f.list()).items[0].status, "stopped");
    if (action === "close") await assert.rejects(f.start(), { code: "CLOSED" });
    else await assert.rejects(f.start(), { code: "ADMISSION_REQUIRED" });
  }
});

test("sandbox and synchronous spawn failures fail closed with safe owned receipts", async (t) => {
  const f = await fixture(t);
  f.confine = () => {
    throw Object.assign(new Error("PRIVATE_RUNNER_DETAILS"), { code: "SANDBOX_UNAVAILABLE" });
  };
  await assert.rejects(f.start(), (error) => {
    assert.equal(error.code, "SANDBOX_UNAVAILABLE");
    assert.equal(error.partial.item.status, "failed");
    assert.equal(JSON.stringify(error.partial).includes("PRIVATE_RUNNER_DETAILS"), false);
    return true;
  });
  assert.equal(f.specs.length, 0);
  f.confine = null;
  f.spawnError = new Error("PRIVATE_SPAWN_DETAILS");
  await assert.rejects(f.start(), (error) => {
    assert.equal(error.code, "PROCESS_FAILED");
    assert.equal(error.partial.item.status, "failed");
    assert.equal(JSON.stringify(error.partial).includes("PRIVATE_SPAWN_DETAILS"), false);
    return true;
  });
  assert.equal(f.specs.length, 1);
  assert.equal(f.handles.length, 0);
});

test("pending confinement is cancelled on close and cannot spawn after its late completion", async (t) => {
  const f = await fixture(t);
  const confinement = deferred();
  f.confine = () => confinement.promise;
  const start = f.start();
  const rejected = assert.rejects(start, { code: "CANCELLED" });
  await until(() => f.wraps.length === 1);
  await f.processes.close();
  await rejected;
  confinement.resolve({ argv: ["late-runner", "--", f.toolPath], enforcement: "full" });
  await tick();
  assert.equal(f.specs.length, 0);
});
