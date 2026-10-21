// Fixed process allowance for the explicit full-preset probe, never a production backend.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import childProcess from "node:child_process";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const PACKAGE = "node_modules/@deepseek-ai/dsh-ptc-runtime-node/";
const BOOTSTRAP_SHA = "e25ce53b26bb3e96e62cb7433f74612395f3865b4627a695d3d4fd42c4706790";
const SEATBELT =
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))';
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The fixture installs its deny-all mocks before creating this opt-in guard.
const originalSpawn = childProcess.spawn;
const originalChildSpawn = childProcess.ChildProcess.prototype.spawn;
const originalChildKill = childProcess.ChildProcess.prototype.kill;
const originalKill = process.kill;
const originalDlopen = process.dlopen;
const originalRealpath = fs.realpathSync;
const unwrap = (value) => {
  while (value?.[Symbol.for("cordis.original")]) value = value[Symbol.for("cordis.original")];
  return value;
};

export function createPtcProcessGuard(t, { installedRoot, runtime, workspace, forbidden }) {
  assert.equal(installedRoot, INSTALLED);
  assert.equal(process.execPath, NODE);
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(process.env.PATH, "/usr/bin:/bin");
  assert.deepEqual(Object.keys(process.env).sort(), [
    "DSH_AGENTS_HOME",
    "DSH_BUNDLED_SKILL_DIR",
    "DSH_HOME",
    "DSH_UNLIMIT_RUNTIME",
    "PATH",
  ]);
  const manifest = JSON.parse(fs.readFileSync(join(installedRoot, "desktop-runtime.json"), "utf8"));
  const nativePath = "node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node";
  const native = manifest.files.find((row) => row.path === nativePath);
  assert.equal(native?.sha256, "e25056346e033991ed14a01f0804851f2b7a33b2c8c0b2d8de58eb3159bbb390");
  const nativeFile = join(installedRoot, nativePath);
  const verifyNative = () => {
    const bytes = fs.readFileSync(nativeFile);
    assert.equal(bytes.length, native.bytes);
    assert.equal(hash(bytes), native.sha256);
  };
  verifyNative();
  let nativeLoads = 0;
  const copied = manifest.files.filter((row) => row.path.startsWith(PACKAGE));
  assert.ok(copied.length > 0);
  for (const row of copied) {
    const bytes = fs.readFileSync(join(installedRoot, row.path));
    assert.equal(hash(bytes), row.sha256, row.path);
    assert.equal(bytes.length, row.bytes);
    const destination = join(runtime.root, row.path);
    fs.mkdirSync(dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  const originalPackage = join(installedRoot, PACKAGE).replace(/\/$/, "");
  const copiedPackage = join(runtime.root, PACKAGE).replace(/\/$/, "");
  const hook = registerHooks({
    resolve(specifier, context, next) {
      const result = next(specifier, context);
      if (result.url.startsWith("file:")) {
        const path = fileURLToPath(result.url);
        if (path.startsWith(originalPackage + "/"))
          return {
            ...result,
            url: pathToFileURL(copiedPackage + path.slice(originalPackage.length)).href,
          };
      }
      return result;
    },
  });
  const bootstrap = join(runtime.root, PACKAGE, "lib/process.js");
  assert.equal(hash(fs.readFileSync(bootstrap)), BOOTSTRAP_SHA);
  const launches = [],
    signals = [];
  let launchOpen = false,
    nativeSpawnOpen = false,
    disposed = false;
  let subprocessProvider, ptcProvider;
  const deny = (name) => {
    forbidden.push(`child_process.${name}`);
    throw new Error(`Fixed PTC preset probe forbids ${name}`);
  };
  t.mock.method(process, "dlopen", function (module, filename, ...args) {
    if (filename !== nativeFile || originalRealpath(filename) !== nativeFile) return deny("dlopen");
    verifyNative();
    const result = Reflect.apply(originalDlopen, this, [module, filename, ...args]);
    nativeLoads++;
    return result;
  });
  t.mock.method(process, "kill", (pid, signal = "SIGTERM") => {
    // The official provider probes its exact process group with signal 0 again
    // after child close. This is a real existence check, never a fabricated result.
    const row = launches.find(
      (r) => (signal === 0 || !r.closed) && [r.child.pid, -r.child.pid].includes(pid),
    );
    if (!row || ![0, "SIGTERM", "SIGKILL"].includes(signal)) return deny("kill.unowned");
    signals.push({
      launch: row.ordinal,
      target: pid < 0 ? "owned-process-group" : "owned-child",
      signal,
    });
    return originalKill(pid, signal);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "spawn", function (...args) {
    if (!nativeSpawnOpen) return deny("ChildProcess.spawn");
    return Reflect.apply(originalChildSpawn, this, args);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "kill", function (signal = "SIGTERM") {
    if (
      !launches.some((r) => r.child === this && !r.closed) ||
      !["SIGTERM", "SIGKILL"].includes(signal)
    )
      return deny("ChildProcess.kill");
    return Reflect.apply(originalChildKill, this, [signal]);
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (!launchOpen || launches.length >= 2) return deny("spawn.extra");
    launchOpen = false;
    assert.equal(command, "sandbox-exec");
    assert.equal(originalRealpath("/usr/bin/sandbox-exec"), "/usr/bin/sandbox-exec");
    const expected = ["-p", SEATBELT, "--", NODE, "--max-old-space-size=64", bootstrap, "1048576"];
    assert.deepEqual(args, expected);
    assert.equal(hash(fs.readFileSync(bootstrap)), BOOTSTRAP_SHA);
    assert.deepEqual(Object.keys(options).sort(), [
      "cwd",
      "detached",
      "env",
      "stdio",
      "windowsHide",
    ]);
    assert.equal(options.cwd, workspace);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, false);
    assert.deepEqual(options.stdio, [
      "ignore",
      "pipe",
      "pipe",
      "ignore",
      "ignore",
      "ignore",
      "ignore",
      "overlapped",
    ]);
    const environment = Object.fromEntries(
      Object.entries(options.env).filter(([, value]) => value !== undefined),
    );
    assert.deepEqual(environment, { PATH: "/usr/bin:/bin", DSH_SUBPROCESS_CONTROL: "pipe" });
    const row = {
      ordinal: launches.length + 1,
      command,
      argv: args,
      cwd: workspace,
      environment,
      stdio: options.stdio,
      bootstrapSha256: BOOTSTRAP_SHA,
      events: [],
      stdout: "",
      stderr: "",
      closed: false,
      controlClosed: false,
    };
    nativeSpawnOpen = true;
    try {
      row.child = originalSpawn(command, args, options);
    } finally {
      nativeSpawnOpen = false;
    }
    launches.push(row);
    row.close = new Promise((resolve) =>
      row.child.once("close", (code, signal) => {
        row.closed = true;
        row.events.push({ type: "close", code, signal });
        resolve();
      }),
    );
    row.child.once("spawn", () => row.events.push({ type: "spawn" }));
    row.child.once("exit", (code, signal) => row.events.push({ type: "exit", code, signal }));
    row.child.once("error", (error) => row.events.push({ type: "error", message: error.message }));
    row.child.stdout?.on("data", (bytes) => {
      row.stdout += bytes.toString("utf8");
    });
    row.child.stderr?.on("data", (bytes) => {
      row.stderr += bytes.toString("utf8");
    });
    row.control = row.child.stdio[7];
    assert.ok(row.control);
    row.controlClose = new Promise((resolve) =>
      row.control.once("close", () => {
        row.controlClosed = true;
        row.events.push({ type: "control-close" });
        resolve();
      }),
    );
    row.control.once("error", (error) =>
      row.events.push({ type: "control-error", message: error.message }),
    );
    return row.child;
  });
  syncBuiltinESMExports();
  const childPrelude = `
const attempts = [];
const deny = (name) => () => { attempts.push(name); throw new Error("fixed child forbids " + name); };
const net = (await import("node:net")).default;
const dgram = (await import("node:dgram")).default;
const dns = (await import("node:dns")).default;
const dnsPromises = (await import("node:dns/promises")).default;
const cp = (await import("node:child_process")).default;
net.Socket.prototype.connect = deny("socket.connect"); net.Server.prototype.listen = deny("socket.listen");
for (const name of ["bind", "send", "connect"]) dgram.Socket.prototype[name] = deny("dgram." + name);
for (const [label, api] of [["dns", dns], ["dns/promises", dnsPromises]]) for (const key of Object.keys(api)) if (/^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function") api[key] = deny(label + "." + key);
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) cp[name] = deny("child_process." + name);
cp.ChildProcess.prototype.spawn = deny("ChildProcess.spawn");
for (const module of ["node:http", "node:https"]) { const api = (await import(module)).default; api.request = deny(module + ".request"); api.get = deny(module + ".get"); }
(await import("node:tls")).default.connect = deny("tls.connect"); (await import("node:http2")).default.connect = deny("http2.connect");
(await import("node:worker_threads")).default.Worker = deny("Worker"); (await import("node:cluster")).default.fork = deny("cluster.fork");
globalThis.fetch = deny("fetch"); if (globalThis.WebSocket) globalThis.WebSocket = deny("WebSocket"); process.dlopen = deny("process.dlopen");
(await import("node:module")).syncBuiltinESMExports();
if (Object.keys(process.env).length !== 0) throw new Error("program environment is not empty");
`;
  const program = `${childPrelude}\
const value = await tools.read({ file_path: ${JSON.stringify(join(workspace, "evidence.txt"))} });
return { value, networkAndSpawnAttempts: attempts, environmentNames: Object.keys(process.env) };
`;
  const reviewPlan = `# Read one disposable fixture

## Scope
Read only the synthetic evidence.txt file in this test workspace after approval.
Do not change files, application configuration, or user sessions. Do not use a network.

## Execution
Finish this review turn after approval. On a subsequent explicit implementation turn,
use the official read tool to read evidence.txt and report its synthetic contents.

## Verification
Check the tool result, next model request, and persisted synthetic session events.
`;
  const reviewProgram = `${childPrelude}\
const value = await tools.exit_plan_mode({ plan: ${JSON.stringify(reviewPlan)} });
return { value, networkAndSpawnAttempts: attempts, environmentNames: Object.keys(process.env) };
`;
  return {
    metadataPaths: [NODE, "/usr/bin/sandbox-exec"],
    config: {
      executionMode: "per-call",
      timeoutMs: 3000,
      maxTimeoutMs: 3000,
      maxOutputBytes: 65536,
      maxMessageBytes: 1048576,
      maxPendingCalls: 1,
      maxOldGenerationSizeMb: 64,
      graceMs: 200,
      launch: { kind: "node-script", executable: NODE, bootstrapPath: bootstrap },
    },
    program,
    reviewPlan,
    reviewProgram,
    bind(ctx) {
      subprocessProvider = unwrap(ctx.subprocess);
      ptcProvider = unwrap(ctx.ptcRuntime);
    },
    async run(action) {
      assert.equal(launchOpen, false);
      assert.equal(disposed, false);
      const before = launches.length;
      launchOpen = true;
      try {
        await action();
        assert.equal(launches.length, before + 1);
      } finally {
        launchOpen = false;
      }
    },
    async verifyDisposed() {
      launchOpen = false;
      let timer;
      try {
        await Promise.race([
          Promise.all(launches.flatMap((row) => [row.close, row.controlClose])),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new Error("PTC child/control close not observed after official disposal")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (subprocessProvider) {
        assert.equal(subprocessProvider.live.size, 0);
        assert.equal(subprocessProvider.controlChannels.size, 0);
      } else assert.equal(launches.length, 0);
      if (ptcProvider) assert.equal(ptcProvider.live.size, 0);
      else assert.equal(launches.length, 0);
      verifyNative();
      for (const row of launches) {
        assert.equal(row.closed, true);
        assert.equal(row.controlClosed && row.control.destroyed, true);
      }
      disposed = true;
    },
    deregister() {
      hook.deregister();
    },
    evidence: () => ({
      launches: launches.map(({ child, control, close, controlClose, ...row }) => ({
        ...row,
        controlDestroyed: control.destroyed,
      })),
      processSignals: structuredClone(signals),
      copiedOfficialFiles: copied.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      nativeFileLock: {
        path: nativePath,
        bytes: native.bytes,
        sha256: native.sha256,
        actualLoads: nativeLoads,
        verifiedBeforeLoadAndAfterDispose: disposed,
      },
      programSha256: hash(program),
      availableReviewProgramSha256: hash(reviewProgram),
      reviewPlanSha256: hash(reviewPlan),
      originalReadOnlySeatbeltSha256: hash(SEATBELT),
      cleanup: {
        verified: disposed,
        subprocessLive: subprocessProvider?.live.size,
        controlChannels: subprocessProvider?.controlChannels.size,
        ptcLive: ptcProvider?.live.size,
      },
      boundaries: {
        actualOfficialProcess: true,
        fixedProgramOnly: true,
        kernelReadWhitelist: false,
        kernelNetworkWhitelist: false,
        escapedDescendantsCovered: false,
      },
    }),
  };
}
