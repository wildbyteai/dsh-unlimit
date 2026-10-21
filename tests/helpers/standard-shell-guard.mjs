// Explicit synthetic standard-preset shell probe, never a production backend.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const originalSpawn = childProcess.spawn;
const originalChildSpawn = childProcess.ChildProcess.prototype.spawn;
const originalChildKill = childProcess.ChildProcess.prototype.kill;
const originalKill = process.kill;
const originalDlopen = process.dlopen;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const raw = (value) => value?.[Symbol.for("cordis.original")] ?? value;

export function createStandardShellGuard(t, { installedRoot, workspace, directory, forbidden }) {
  assert.equal(installedRoot, INSTALLED);
  assert.equal(process.execPath, NODE);
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  const environment = {
    PATH: "/usr/bin:/bin",
    DSH_UNLIMIT_RUNTIME: INSTALLED,
    HOME: join(directory, "home"),
    TMPDIR: join(directory, "tmp"),
    HISTFILE: "/dev/null",
    HISTSIZE: "0",
    HISTFILESIZE: "0",
    DSH_HOME: join(directory, "dsh-home"),
    DSH_AGENTS_HOME: join(directory, "agents-home"),
    DSH_BUNDLED_SKILL_DIR: join(directory, "bundled-skills"),
  };
  assert.deepEqual({ ...process.env }, environment);
  const nativePath = "node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node";
  const nativeFile = join(installedRoot, nativePath);
  const nativeHash = "e25056346e033991ed14a01f0804851f2b7a33b2c8c0b2d8de58eb3159bbb390";
  const verifyNative = () => assert.equal(hash(fs.readFileSync(nativeFile)), nativeHash);
  verifyNative();
  let nativeLoads = 0,
    nativeSpawnOpen = false,
    disposed = false,
    subprocess,
    ctx;
  const launches = [],
    expected = [],
    signals = [];
  const deny = (name) => {
    forbidden.push(`child_process.${name}`);
    throw new Error(`Fixed standard shell probe forbids ${name}`);
  };
  t.mock.method(process, "dlopen", function (module, filename, ...args) {
    if (filename !== nativeFile) return deny("dlopen");
    verifyNative();
    nativeLoads++;
    return Reflect.apply(originalDlopen, this, [module, filename, ...args]);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "spawn", function (...args) {
    if (!nativeSpawnOpen) return deny("ChildProcess.spawn");
    return Reflect.apply(originalChildSpawn, this, args);
  });
  t.mock.method(childProcess, "spawn", (command, args, options) => {
    const planned = expected.shift();
    if (!planned || disposed) return deny("spawn.unplanned");
    const { agent, mode, source } = planned;
    assert.equal(raw(ctx.agents).currentInitiator(), agent);
    assert.equal(options.cwd, workspace);
    assert.equal(options.detached, true);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.windowsHide, false);
    assert.deepEqual(Object.keys(options).sort(), [
      "cwd",
      "detached",
      "env",
      "stdio",
      "windowsHide",
    ]);
    assert.deepEqual(options.env, {
      PATH: environment.PATH,
      HOME: environment.HOME,
      TMPDIR: environment.TMPDIR,
      HISTFILE: "/dev/null",
      HISTSIZE: "0",
      HISTFILESIZE: "0",
      NO_COLOR: "1",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      DSH_HOME: environment.DSH_HOME,
      DSH_SHELL: "1",
      DSH_SESSION_ID: agent.id,
    });
    let profile;
    if (mode === "danger-full-access") {
      assert.equal(command, "bash");
      assert.deepEqual(args, ["-c", source]);
    } else {
      assert.equal(command, "sandbox-exec");
      assert.deepEqual([args[0], ...args.slice(2)], ["-p", "--", "bash", "-c", source]);
      profile = args[1];
      assert.ok(
        profile.startsWith(
          '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))',
        ),
      );
      if (mode === "read-only") assert.ok(!profile.includes("subpath"));
      else {
        assert.equal(mode, "workspace-write");
        assert.ok(profile.includes(`(subpath ${JSON.stringify(workspace)})`));
        assert.ok(!profile.includes(`(subpath ${JSON.stringify(directory)})`));
      }
    }
    const row = { mode, sessionId: agent.id, command, args, profile, closed: false };
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
        row.code = code;
        row.signal = signal;
        resolve();
      }),
    );
    return row.child;
  });
  const owned = (pid, signal) => {
    const row = launches.find((entry) => [entry.child.pid, -entry.child.pid].includes(pid));
    if (!row || ![0, "SIGTERM", "SIGKILL"].includes(signal) || (row.closed && signal !== 0))
      return deny("kill.unowned");
    signals.push({ sessionId: row.sessionId, signal, group: pid < 0 });
  };
  t.mock.method(process, "kill", (pid, signal = "SIGTERM") => {
    owned(pid, signal);
    return Reflect.apply(originalKill, process, [pid, signal]);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "kill", function (signal = "SIGTERM") {
    owned(this.pid, signal);
    return Reflect.apply(originalChildKill, this, [signal]);
  });
  syncBuiltinESMExports();
  return {
    metadataPaths: ["/usr/bin/bash", "/bin/bash", "/usr/bin/sandbox-exec", "/bin/sandbox-exec"],
    bind(context) {
      ctx = context;
      subprocess = raw(ctx.subprocess);
    },
    async run(agent, mode, sources, action) {
      assert.equal(expected.length, 0);
      const modes = Array.isArray(mode) ? mode : sources.map(() => mode);
      assert.equal(modes.length, sources.length);
      const before = launches.length;
      for (const [index, source] of sources.entries())
        expected.push({ agent, mode: modes[index], source });
      await action();
      assert.equal(
        expected.length,
        0,
        JSON.stringify(
          agent.session
            .snapshotEvents()
            .filter((event) => event.type === "tool/result")
            .map((event) => event.data),
        ),
      );
      assert.equal(launches.length, before + sources.length);
      const current = launches.slice(before);
      await Promise.all(current.map((row) => row.close));
      return current.map(({ code, signal, mode, closed }) => ({ code, signal, mode, closed }));
    },
    async verifyDisposed() {
      let timer;
      try {
        await Promise.race([
          Promise.all(launches.map((row) => row.close)),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Shell child close not observed")), 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      assert.equal(expected.length, 0);
      assert.equal(subprocess?.live.size, 0);
      assert.equal(subprocess?.controlChannels.size, 0);
      verifyNative();
      disposed = true;
    },
    evidence: () => ({
      launches: launches.map(({ child, close, ...row }) => row),
      signals,
      nativeLock: { path: nativePath, sha256: nativeHash, loads: nativeLoads },
      cleanup: {
        verified: disposed,
        subprocessLive: subprocess?.live.size,
        controlChannels: subprocess?.controlChannels.size,
      },
      boundaries: {
        fixedSyntheticShellCommands: true,
        actualOfficialSandbox: true,
        kernelNetworkWhitelist: false,
        ptyExecuted: false,
      },
    }),
  };
}
