// Fixed harmless programs against the genuine official local subprocess service.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopProcesses } from "../../src/host/processes.js";
import { installTools } from "../../src/host/tools.js";

export const processHostNode =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const installed = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (root, path) => {
  const suffix = relative(root, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep))
  );
};
const unwrap = (value) => {
  while (value?.[Symbol.for("cordis.original")]) value = value[Symbol.for("cordis.original")];
  return value;
};

export async function eventually(action, message, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await action();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(message);
}

/** In-memory official sessions/registry/policy; synthetic admission, toolkit and call context. */
export async function processHostFixture(t, selectedRoot, { preview = false } = {}) {
  assert.equal(typeof preview, "boolean");
  assert.equal(process.execPath, processHostNode, "Use the explicitly selected bundled Node only");
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(fs.realpathSync(selectedRoot), installed);
  const manifestBytes = fs.readFileSync(join(installed, "desktop-runtime.json"));
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, "arm64");
  const inventory = new Map(manifest.files.map((row) => [row.path, row]));
  const verified = new Map();
  const forbidden = [];
  const deny = (name) => () => {
    forbidden.push(name);
    throw new Error(`Process host fixture forbids ${name}`);
  };
  const verify = (path) => {
    assert.ok(within(installed, path));
    assert.equal(fs.realpathSync(path), path);
    const relativePath = relative(installed, path);
    assert.doesNotMatch(
      relativePath,
      /(?:dsh-tool-(?:bash|fs|pwsh)|dsh-agent-instructions)\/|\.bak(?:$|\.)|dshpurge/i,
      "Do not import modified tool entries or another plugin's backups",
    );
    const row = inventory.get(relativePath);
    assert.ok(row, `Official inventory must list ${relativePath}`);
    const bytes = fs.readFileSync(path);
    assert.equal(bytes.length, row.bytes, relativePath);
    assert.equal(hash(bytes), row.sha256, `Refusing modified official dependency: ${relativePath}`);
    verified.set(relativePath, row.sha256);
  };

  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), "dsh-unlimit-process-host-")));
  const workspace = join(root, "workspace");
  const environment = {
    PATH: "/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    DSH_HOME: join(root, "dsh-home"),
    DSH_AGENTS_HOME: join(root, "agents-home"),
    DSH_BUNDLED_SKILL_DIR: join(root, "bundled-skills"),
  };
  for (const directory of [
    workspace,
    ...Object.values(environment).filter((value) => within(root, value)),
  ])
    fs.mkdirSync(directory, { recursive: true });
  const oldEnvironment = { ...process.env };
  const oldCwd = process.cwd();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  process.chdir(workspace);
  const childEnvironment = {
    PATH: environment.PATH,
    HOME: environment.HOME,
    TMPDIR: environment.TMPDIR,
  };
  const script = join(workspace, "harmless-process.mjs");
  const previewBody =
    "<!doctype html><title>Synthetic preview</title><p>SYNTHETIC_PREVIEW_READY</p>\n";
  const source = preview
    ? `
import { createServer } from "node:http";
const [label, behavior, ...args] = process.argv.slice(2);
if (behavior !== "preview" || args.length !== 0) throw new Error("Unexpected preview arguments");
const body = ${JSON.stringify(previewBody)};
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/") {
    response.writeHead(404, { "Content-Length": "0", "Connection": "close" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Connection": "close" });
  response.end(body);
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ type: "ready", label, args, cwd: process.cwd(), environment: process.env, address: server.address() }) + "\\n");
  process.stderr.write("stderr:" + label + "\\n");
});
process.on("SIGTERM", () => {
  process.stdout.write("signal:" + label + ":SIGTERM\\n");
  server.close(() => {
    process.stdout.write("preview:closed\\n");
    process.exitCode = 0;
  });
});
`
    : `
const [label, behavior, ...args] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ type: "ready", label, args, cwd: process.cwd(), environment: process.env }) + "\\n");
process.stderr.write("stderr:" + label + "\\n");
if (behavior === "exit") {
  process.exitCode = 7;
} else {
  let beat = 0;
  const timer = setInterval(() => process.stdout.write("heartbeat:" + label + ":" + (++beat) + "\\n"), 100);
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.stdout.write("signal:" + label + ":SIGTERM\\n");
    process.exitCode = 0;
  });
}
`;
  fs.writeFileSync(script, source, { flag: "wx", mode: 0o600 });

  let ctx,
    adapter,
    hook,
    disposed = false;
  const fibers = [],
    scopes = [],
    handles = [],
    launches = [],
    signals = [],
    unrelatedSurvival = [];
  const expectedLaunches = [];
  const originalSpawn = childProcess.spawn;
  const originalChildSpawn = childProcess.ChildProcess.prototype.spawn;
  const originalChildKill = childProcess.ChildProcess.prototype.kill;
  const originalKill = process.kill;
  const originalConnect = net.Socket.prototype.connect;
  const connections = [];
  let previewPort,
    permittedSocket,
    toolDisposer,
    directToolRuntimeCalls = 0;
  let spawnOpen = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const errors = [];
    const cleanup = async (label, action) => {
      try {
        await action();
      } catch (cause) {
        errors.push(new Error(label, { cause }));
      }
    };
    try {
      await cleanup("plugin close", () => adapter?.close());
      await cleanup("plugin tools", () => toolDisposer?.());
      // These are captured handles only, including the intentionally unrelated process.
      for (const handle of handles)
        await cleanup("fixture child", async () => {
          handle.terminate();
          await Promise.all([handle.done.catch(() => {}), handle.waitForExit()]);
        });
      for (const row of launches) await cleanup("fixture child close", () => row.close);
      for (const scope of scopes.reverse())
        await cleanup("synthetic agent scope", () => scope.dispose());
      for (const fiber of fibers.reverse())
        if (fiber.uid !== null) await cleanup("official service", () => fiber.dispose());
      await cleanup("official context", () => ctx?.fiber.dispose());
      assert.ok(
        launches.every((row) => row.closed),
        "Every captured child must close",
      );
      assert.equal(expectedLaunches.length, 0);
      assert.deepEqual(forbidden, []);
    } finally {
      hook?.deregister();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      process.chdir(oldCwd);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, oldEnvironment);
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
    }
    if (errors.length) throw new AggregateError(errors, "Isolated process fixture cleanup failed");
  };
  t.after(dispose);

  t.mock.method(os, "homedir", () => environment.HOME);
  t.mock.method(net.Socket.prototype, "connect", function (...args) {
    if (!preview || this !== permittedSocket) return deny("socket.connect")();
    assert.ok(Number.isInteger(previewPort) && previewPort > 0 && previewPort <= 65535);
    assert.deepEqual(args, [previewPort, "127.0.0.1"]);
    permittedSocket = undefined;
    return Reflect.apply(originalConnect, this, args);
  });
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  for (const name of ["bind", "send", "connect"])
    t.mock.method(dgram.Socket.prototype, name, deny(`dgram.${name}`));
  for (const [name, api] of [
    ["dns", dns],
    ["dns/promises", dnsPromises],
  ])
    for (const key of Object.keys(api))
      if (/^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function")
        t.mock.method(api, key, deny(`${name}.${key}`));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  if (globalThis.WebSocket) t.mock.method(globalThis, "WebSocket", deny("WebSocket"));
  t.mock.method(process, "dlopen", deny("process.dlopen"));
  for (const name of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  t.mock.method(childProcess.ChildProcess.prototype, "spawn", function (...args) {
    if (!spawnOpen) return deny("ChildProcess.spawn")();
    return Reflect.apply(originalChildSpawn, this, args);
  });
  t.mock.method(childProcess, "spawn", function (command, args, options) {
    const expected = expectedLaunches.shift();
    if (!expected || launches.length >= (preview ? 1 : 6))
      return deny("child_process.spawn.extra")();
    assert.equal(command, processHostNode);
    assert.deepEqual(args, [script, expected.label, expected.behavior, ...expected.args]);
    assert.equal(fs.readFileSync(script, "utf8"), source);
    assert.deepEqual(options, {
      cwd: workspace,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      windowsHide: false,
    });
    spawnOpen = true;
    let child;
    try {
      child = Reflect.apply(originalSpawn, this, [command, args, options]);
    } finally {
      spawnOpen = false;
    }
    const row = { label: expected.label, child, closed: false, events: [] };
    launches.push(row);
    row.close = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        row.closed = true;
        row.events.push({ type: "close", code, signal });
        resolve();
      }),
    );
    child.once("spawn", () => row.events.push({ type: "spawn" }));
    child.once("exit", (code, signal) => row.events.push({ type: "exit", code, signal }));
    return child;
  });
  t.mock.method(process, "kill", function (pid, signal = "SIGTERM") {
    const row = launches.find((entry) => [entry.child.pid, -entry.child.pid].includes(pid));
    if (!row || ![0, "SIGTERM", "SIGKILL"].includes(signal) || (row.closed && signal !== 0))
      return deny("process.kill.unowned")();
    signals.push({
      label: row.label,
      target: pid < 0 ? "captured-group" : "captured-child",
      signal,
    });
    return Reflect.apply(originalKill, this, [pid, signal]);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "kill", function (signal = "SIGTERM") {
    const row = launches.find((entry) => entry.child === this && !entry.closed);
    if (!row || !["SIGTERM", "SIGKILL"].includes(signal))
      return deny("ChildProcess.kill.unowned")();
    signals.push({ label: row.label, target: "captured-child-handle", signal });
    return Reflect.apply(originalChildKill, this, [signal]);
  });
  syncBuiltinESMExports();

  hook = registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const path = fileURLToPath(url);
        assert.ok(
          within(installed, path),
          "Only verified official imports occur after fixture setup",
        );
        verify(path);
      }
      return next(url, context);
    },
  });
  const requireHost = createRequire(join(installed, "package.json"));
  const load = async (name) => {
    const path = requireHost.resolve(name);
    verify(path);
    return import(pathToFileURL(path).href);
  };
  const api = {};
  for (const [key, name] of Object.entries({
    cordis: "@deepseek-ai/cordis",
    agents: "@deepseek-ai/dsh-agent",
    scope: "@deepseek-ai/dsh-scope",
    sessions: "@deepseek-ai/dsh-session",
    projections: "@deepseek-ai/dsh-session-projection",
    policy: "@deepseek-ai/dsh-sandbox-policy",
    sandbox: "@deepseek-ai/dsh-sandbox-local",
    subprocess: "@deepseek-ai/dsh-subprocess-local",
    ...(preview
      ? { prompt: "@deepseek-ai/dsh-system-prompt", tools: "@deepseek-ai/dsh-tools" }
      : {}),
  }))
    api[key] = await load(name);
  ctx = new api.cordis.Context();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2);
    return fiber;
  };
  await mount({
    name: "synthetic-owned-process-services",
    apply(scope) {
      if (preview) {
        new api.prompt.SystemPrompt(scope, {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: "",
          personaSuffix: "",
        });
        new api.tools.ToolRuntime(scope);
      }
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.agents.AgentRegistry(scope);
      new api.policy.SandboxPolicyService(scope, {
        mode: "danger-full-access",
        workspaceRoot: workspace,
      });
    },
  });
  await mount(api.sandbox.LocalSandboxProvider, {
    runnerCommand: [],
    runnerFailureSignatures: [],
    probeTimeoutMs: 1000,
  });
  await mount(api.subprocess.LocalSubprocessRuntime);
  assert.ok(unwrap(ctx.subprocess) instanceof api.subprocess.LocalSubprocessRuntime);
  assert.ok(unwrap(ctx.sandbox) instanceof api.sandbox.LocalSandboxProvider);
  const workspaceItem = { id: "synthetic-process-workspace" };
  const bindings = new Map();
  const createAgent = async (id) => {
    const session = ctx.sessions.create(id, { meta: { cwd: workspace } });
    const agent = { id, session, options: {} };
    const scope = api.scope.createScope(ctx, agent);
    scopes.push(scope);
    agent.ctx = scope.ctx;
    await ctx.agents.register(agent);
    assert.equal(ctx.agents.get(id), agent);
    bindings.set(id, workspaceItem);
    return agent;
  };
  const agent = await createAgent("synthetic-process-owner");
  const peer = await createAgent("synthetic-process-peer");
  const store = {
    dispatch(action, payload) {
      assert.equal(action, "workspaces.forSession");
      return { item: bindings.get(payload.sessionId) ?? null };
    },
    get(table, id) {
      assert.equal(table, "workspaces");
      assert.ok([workspaceItem.id, "synthetic-other-workspace"].includes(id));
      return { id };
    },
  };
  let admissions = 0,
    calls = 0;
  adapter = new DesktopProcesses(
    ctx,
    store,
    {
      kind: "desktop",
      supported: true,
      version: manifest.release.version,
      runtimeRoot: installed,
    },
    {
      // This configured ID deliberately points at bundled Node, never a scanner binary.
      toolkit: {
        status: () => ({ tools: [{ id: "nmap", path: processHostNode, available: true }] }),
      },
      admission: {
        require() {
          admissions++;
          return true;
        },
      },
    },
  );
  const execution = (actor = agent) => ({
    agent: actor,
    callId: `synthetic-process-call-${++calls}`,
    toolName: "unlimit_processes",
    signal: new AbortController().signal,
  });
  if (preview)
    toolDisposer = await installTools(
      ctx,
      {
        dispatch(action, payload, call) {
          assert.ok(action.startsWith("processes."));
          return adapter.dispatch(action, payload, call);
        },
      },
      { runtimeRoot: installed },
    );
  const toolExecute = async (action, payload, actor = agent) => {
    const call = execution(actor);
    directToolRuntimeCalls++;
    const result = await ctx.tools.execute({
      name: "unlimit_process",
      arguments: { action, payload },
      agent: call.agent,
      callId: call.callId,
      signal: call.signal,
    });
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.equal(result.isError, false, text);
    return JSON.parse(text);
  };
  const start = async (label, { behavior = "wait", args = [], ...payload } = {}) => {
    if (preview) {
      assert.equal(label, "preview");
      assert.equal(behavior, "preview");
      assert.deepEqual(args, []);
      assert.deepEqual(payload, {});
    }
    expectedLaunches.push({ label, behavior, args });
    const input = {
      tool: "nmap",
      args: [script, label, behavior, ...args],
      ...payload,
    };
    const result = preview
      ? await toolExecute("start", input)
      : await adapter.dispatch("processes.start", input, execution());
    const run = adapter.runs.get(result.item.id);
    assert.ok(run.handle);
    handles.push(run.handle);
    return result.item;
  };
  const output = (item, extra = {}, actor = agent) =>
    preview
      ? toolExecute("output", { id: item.id, ...extra }, actor)
      : adapter.dispatch(
          "processes.output",
          {
            id: item.id,
            ...extra,
          },
          execution(actor),
        );
  const ready = (item, label) =>
    eventually(async () => {
      const result = await output(item);
      const line = result.stdout.text
        .split("\n")
        .find((line) => line.startsWith('{"type":"ready"'));
      if (!line || !result.stderr.text.includes(`stderr:${label}\n`)) return false;
      const data = JSON.parse(line);
      assert.equal(data.label, label);
      assert.equal(data.cwd, workspace);
      // The macOS bundled Node initializes this platform fact after native launch.
      // Check its closed numeric shape, without retaining the user's encoding/UID.
      const { __CF_USER_TEXT_ENCODING: encoding, ...inherited } = data.environment;
      assert.match(encoding, /^0x[\da-f]+:0x[\da-f]+:0x[\da-f]+$/i);
      assert.deepEqual(inherited, childEnvironment);
      if (preview) {
        assert.deepEqual(Object.keys(data.address).sort(), ["address", "family", "port"]);
        assert.equal(data.address.address, "127.0.0.1");
        assert.equal(data.address.family, "IPv4");
        assert.ok(
          Number.isInteger(data.address.port) &&
            data.address.port > 0 &&
            data.address.port <= 65535,
        );
        previewPort = data.address.port;
      }
      return result;
    }, `Actual stdout/stderr from ${label} were not observed`);
  let unrelated;
  const unrelatedStart = async () => {
    const label = "unrelated";
    expectedLaunches.push({ label, behavior: "wait", args: [] });
    unrelated = ctx.subprocess.spawn({
      argv: [processHostNode, script, label, "wait"],
      cwd: workspace,
      stdio: { stdin: "ignore", stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
      graceMs: 1000,
    });
    handles.push(unrelated);
    await eventually(
      () => unrelated.collected.stdout.readFrom(0).text.includes("heartbeat:unrelated:"),
      "Unrelated fixture process did not start",
    );
  };
  const assertUnrelatedAlive = async (after) => {
    const row = launches.find((entry) => entry.label === "unrelated");
    assert.ok(row && !row.closed);
    assert.equal(row.child.exitCode, null);
    assert.equal(row.child.signalCode, null);
    const before = unrelated.collected.stdout.readFrom(0).nextOffset;
    await eventually(
      () => unrelated.collected.stdout.readFrom(0).nextOffset > before,
      "Unrelated fixture stopped producing real output",
    );
    assert.equal(
      signals.some((entry) => entry.label === "unrelated" && entry.signal !== 0),
      false,
    );
    unrelatedSurvival.push({ after, outputContinued: true, noPluginStopSignal: true });
  };
  return {
    adapter,
    agent,
    peer,
    workspaceId: workspaceItem.id,
    start,
    output,
    ready,
    execution,
    ...(preview
      ? {
          previewBody,
          stop: (item) => toolExecute("stop", { id: item.id }),
          async requestPreview({ refused = false } = {}) {
            assert.ok(Number.isInteger(previewPort));
            assert.equal(
              connections.length,
              refused ? 1 : 0,
              "One real response and one post-stop refusal only",
            );
            const observation = { host: "127.0.0.1", port: previewPort, path: "/", refused };
            connections.push(observation);
            return new Promise((resolve, reject) => {
              const socket = new net.Socket();
              const chunks = [];
              socket.setTimeout(3000, () =>
                socket.destroy(new Error("Fixed preview request timed out")),
              );
              socket.once("connect", () => {
                observation.connected = true;
                socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
              });
              socket.on("data", (chunk) => chunks.push(chunk));
              socket.once("error", (error) => {
                observation.error = error.code ?? error.message;
                if (!refused || error.code !== "ECONNREFUSED") reject(error);
              });
              socket.once("close", () => {
                observation.closed = true;
                try {
                  if (refused) {
                    assert.equal(observation.connected, undefined);
                    assert.equal(observation.error, "ECONNREFUSED");
                    resolve({ refused: true, code: observation.error });
                  } else {
                    assert.equal(observation.error, undefined);
                    const raw = Buffer.concat(chunks).toString("utf8");
                    const separator = raw.indexOf("\r\n\r\n");
                    assert.ok(separator > 0);
                    const headers = raw.slice(0, separator),
                      body = raw.slice(separator + 4);
                    assert.match(headers, /^HTTP\/1\.1 200 OK\r\n/);
                    assert.match(headers, /content-type: text\/html; charset=utf-8/i);
                    assert.equal(body, previewBody);
                    observation.status = 200;
                    observation.bodySha256 = hash(body);
                    resolve({ status: 200, headers, body });
                  }
                } catch (error) {
                  reject(error);
                }
              });
              permittedSocket = socket;
              socket.connect(previewPort, "127.0.0.1");
            });
          },
        }
      : {}),
    unrelatedStart,
    assertUnrelatedAlive,
    dispose,
    async closed(label) {
      const row = launches.find((entry) => entry.label === label);
      assert.ok(row);
      await row.close;
      assert.ok(row.events.some((entry) => entry.type === "spawn"));
      assert.ok(row.events.some((entry) => entry.type === "exit"));
      assert.equal(row.closed, true);
      return row.events;
    },
    evidence() {
      return {
        hostVersion: manifest.release.version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        manifestSha256: hash(manifestBytes),
        verifiedOfficialFiles: verified.size,
        syntheticFullAccessPolicy: true,
        realHumanApprovalVerified: false,
        kernelSandboxVerified: false,
        subprocessServiceMocked: false,
        modelRequests: 0,
        ...(preview
          ? {
              preview: {
                scriptSha256: hash(source),
                bodySha256: hash(previewBody),
                directToolRuntimeCalls,
                actualPluginToolRegistered: true,
                agentLoopExecuted: false,
                syntheticExecution: true,
                syntheticAdmission: true,
                syntheticToolkitNodeMapping: true,
                connections,
                childNetworkKernelRestricted: false,
              },
            }
          : {}),
        networkAttempts: forbidden,
        admissions,
        calls,
        unrelatedSurvival,
        launches: launches.map(({ label, closed, events }) => ({ label, closed, events })),
        signalTargets: [...new Set(signals.map(({ label }) => label))],
        fixtureRootRemoved: !fs.existsSync(root),
      };
    },
  };
}
