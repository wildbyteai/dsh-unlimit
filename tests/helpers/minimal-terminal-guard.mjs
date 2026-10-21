// Fixed, opt-in native PTY allowance for the complete minimal-preset probe.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const SEATBELT =
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))';
const LOCKS = [
  [
    "node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
    "06906d34d3c2f5f868b1ce513183e33b90c9f6de4c0bf4dc31b0931d9c605a40",
  ],
  [
    "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
    "dca3af8fcb6056b843b09f29c703f78293725026282269f57135ac6bb902db3b",
  ],
  [
    "node_modules/@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node",
    "e25056346e033991ed14a01f0804851f2b7a33b2c8c0b2d8de58eb3159bbb390",
  ],
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Capture these at module initialization, before the fixture installs deny-all mocks.
const originalDlopen = process.dlopen;
const originalKill = process.kill;
const originalChildKill = childProcess.ChildProcess.prototype.kill;
const originalExecFileSync = childProcess.execFileSync;
const originalReadFileSync = fs.readFileSync;
const originalRealpathSync = fs.realpathSync;
const originalExistsSync = fs.existsSync;
const originalFstatSync = fs.fstatSync;
const unwrap = (value) => {
  while (value?.[Symbol.for("cordis.original")]) value = value[Symbol.for("cordis.original")];
  return value;
};

export function createMinimalTerminalGuard(
  t,
  { installedRoot, runtime, workspace, directory, forbidden },
) {
  assert.equal(installedRoot, INSTALLED);
  assert.ok(runtime.verifiedFiles instanceof Map);
  assert.equal(process.execPath, NODE);
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.equal(originalExistsSync(NODE + "-spawn-helper"), false);
  const parentEnvironment = {
    PATH: "/usr/bin:/bin",
    HOME: join(directory, "home"),
    TMPDIR: join(directory, "tmp"),
    HISTFILE: "/dev/null",
    HISTSIZE: "0",
    HISTFILESIZE: "0",
    DSH_UNLIMIT_RUNTIME: installedRoot,
    DSH_HOME: join(directory, "dsh-home"),
    DSH_AGENTS_HOME: join(directory, "agents-home"),
    DSH_BUNDLED_SKILL_DIR: join(directory, "bundled-skills"),
  };
  assert.deepEqual({ ...process.env }, parentEnvironment);
  const manifest = JSON.parse(
    originalReadFileSync(join(installedRoot, "desktop-runtime.json"), "utf8"),
  );
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const files = LOCKS.map(([path, sha256]) => {
    const row = manifest.files.find((entry) => entry.path === path);
    assert.equal(row?.sha256, sha256);
    return { path, bytes: row.bytes, sha256, filename: join(installedRoot, path), loads: 0 };
  });
  const verifyFile = (row) => {
    assert.equal(originalRealpathSync(row.filename), row.filename);
    const bytes = originalReadFileSync(row.filename);
    assert.equal(bytes.length, row.bytes);
    assert.equal(hash(bytes), row.sha256);
  };
  files.forEach(verifyFile);
  const [ptyFile, helperFile, systemFile] = files;
  const launches = [],
    inspections = [],
    signals = [];
  const known = new Map();
  const registries = new Map();
  let subprocess, agents, boundContext;
  let running = false,
    disposed = false;
  const deny = (name) => {
    forbidden.push(`child_process.${name}`);
    throw new Error(`Fixed minimal PTY probe forbids ${name}`);
  };
  const ownedTree = (stdout) => {
    // Only task-owned rows leave this function. Never retain the system table.
    const rows = stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), parentPid: Number(match[2]), started: match[3] }]
        : [];
    });
    const owned = [];
    for (const launch of launches) {
      const root = rows.find((row) => row.pid === launch.pid);
      if (!root || (launch.started !== undefined && root.started !== launch.started)) continue;
      launch.started ??= root.started;
      const visit = (row) => {
        if (owned.some((entry) => entry.pid === row.pid)) return;
        owned.push(row);
        known.set(row.pid, { ...row, launch: launch.ordinal });
        for (const child of rows) if (child.parentPid === row.pid) visit(child);
      };
      visit(root);
    }
    return owned;
  };
  t.mock.method(childProcess.ChildProcess.prototype, "spawn", () => deny("ChildProcess.spawn"));
  t.mock.method(childProcess, "execFileSync", function (file, args, options) {
    assert.equal(file, "/bin/ps");
    assert.deepEqual(options, { encoding: "utf8" });
    const table =
      Array.isArray(args) &&
      args.length === 2 &&
      args[0] === "-axo" &&
      args[1] === "pid=,ppid=,lstart=";
    const foreground =
      Array.isArray(args) &&
      args.length === 4 &&
      args[0] === "-o" &&
      args[1] === "tpgid=" &&
      args[2] === "-p" &&
      launches.some((row) => String(row.pid) === args[3]);
    if (!table && !foreground) return deny("execFileSync.unowned");
    const observation = {
      executable: file,
      argv: [...args],
      options: { ...options },
      success: false,
    };
    inspections.push(observation);
    // Return the exact genuine result to the official inspector, including all rows.
    const result = Reflect.apply(originalExecFileSync, this, [file, args, options]);
    observation.success = true;
    if (table) observation.ownedTree = ownedTree(result);
    else {
      const value = Number(result.trim());
      observation.ownedForegroundPgid =
        Number.isSafeInteger(value) && known.has(value) ? value : null;
    }
    return result;
  });
  const authorizeSignal = (pid, signal) => {
    const identity = known.get(Math.abs(pid));
    const launch = launches.find((row) => row.pid === Math.abs(pid));
    if (!identity && !launch) return deny("kill.unowned");
    if (![0, "SIGTERM", "SIGKILL", "SIGHUP", "SIGINT"].includes(signal)) return deny("kill.signal");
    if (signal !== 0 && launch?.exited) return deny("kill.exited-root");
    signals.push({
      launch: identity?.launch ?? launch.ordinal,
      pid: Math.abs(pid),
      target: pid < 0 ? "owned-process-group" : "owned-process",
      signal,
    });
  };
  t.mock.method(process, "kill", function (pid, signal = "SIGTERM") {
    authorizeSignal(pid, signal);
    return Reflect.apply(originalKill, this, [pid, signal]);
  });
  t.mock.method(childProcess.ChildProcess.prototype, "kill", function (signal = "SIGTERM") {
    authorizeSignal(this.pid, signal);
    return Reflect.apply(originalChildKill, this, [signal]);
  });
  t.mock.method(process, "dlopen", function (module, filename, ...args) {
    const row = [ptyFile, systemFile].find((entry) => entry.filename === filename);
    if (!row) return deny("dlopen.unapproved");
    verifyFile(row);
    const result = Reflect.apply(originalDlopen, this, [module, filename, ...args]);
    row.loads++;
    if (row === ptyFile) {
      const originalFork = module.exports.fork;
      assert.equal(typeof originalFork, "function");
      t.mock.method(module.exports, "open", () => deny("pty.open"));
      t.mock.method(module.exports, "fork", function (...parameters) {
        if (!running || disposed || launches.length >= 2) return deny("pty.fork.extra");
        assert.equal(parameters.length, 11);
        const [file, argv, env, cwd, cols, rows, uid, gid, encoding, helper, onexit] = parameters;
        assert.equal(file, "sandbox-exec");
        assert.deepEqual(argv, ["-p", SEATBELT, "--", "/bin/bash", "--noprofile", "--norc", "-i"]);
        assert.equal(cwd, workspace);
        assert.equal(cols, 160);
        assert.equal(rows, 40);
        assert.equal(uid, -1);
        assert.equal(gid, -1);
        assert.equal(encoding, true);
        assert.equal(helper, helperFile.filename);
        verifyFile(helperFile);
        assert.equal(typeof onexit, "function");
        assert.ok(Array.isArray(env));
        const environment = Object.fromEntries(
          env.map((entry) => {
            const separator = entry.indexOf("=");
            assert.ok(separator > 0);
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
        assert.equal(Object.keys(environment).length, env.length, "No duplicate environment keys");
        const ownerId = environment.DSH_SESSION_ID;
        const sessionId = environment.DSH_PTY_SESSION_ID;
        const owner = agents?.get(ownerId);
        assert.ok(owner, "Native PTY belongs to an actual isolated agent");
        // The registry belongs to the owner's retained preset revision. There is
        // deliberately no global terminals service before the preset is mounted.
        const registry = unwrap(boundContext.agentPresets.serviceFor(owner, "terminals"));
        assert.ok(registry?.sessions instanceof Map, "Real preset-scoped terminal registry");
        assert.ok(registry.pendingSpawns instanceof Map);
        assert.equal(typeof registry.list, "function");
        assert.ok(registry.pendingSpawns.get(owner)?.size > 0);
        assert.ok(Number.isSafeInteger(registry.nextId) && registry.nextId > 0);
        assert.equal(sessionId, `pty-${registry.nextId}`);
        let retained = registries.get(registry);
        if (!retained) {
          retained = { ordinal: registries.size + 1, owners: new Map() };
          registries.set(registry, retained);
        }
        retained.owners.set(ownerId, owner);
        assert.ok(
          !launches.some(
            (entry) => entry.registryOrdinal === retained.ordinal && entry.sessionId === sessionId,
          ),
        );
        assert.deepEqual(environment, {
          PATH: parentEnvironment.PATH,
          HOME: parentEnvironment.HOME,
          TMPDIR: parentEnvironment.TMPDIR,
          HISTFILE: "/dev/null",
          HISTSIZE: "0",
          HISTFILESIZE: "0",
          TERM: "dumb",
          PAGER: "cat",
          GIT_PAGER: "cat",
          DSH_SHELL: "1",
          DSH_SESSION_ID: ownerId,
          DSH_PTY_SESSION_ID: sessionId,
          PS1: "dsh> ",
          PROMPT_COMMAND: `printf "\\033]133;D;%s\\007" "$?"; PS1='dsh> '`,
          BASH_SILENCE_DEPRECATION_WARNING: "1",
          PWD: workspace,
        });
        const launch = {
          ordinal: launches.length + 1,
          registryOrdinal: retained.ordinal,
          file,
          argv: [...argv],
          env: environment,
          cwd,
          cols,
          rows,
          uid,
          gid,
          encoding,
          helper,
          helperSha256: helperFile.sha256,
          ownerId,
          sessionId,
          exited: false,
          fdClosed: false,
        };
        // Observe the native exit and forward its original arguments and return value.
        parameters[10] = function (...exitArguments) {
          launch.exited = true;
          launch.exitArguments = [...exitArguments];
          return Reflect.apply(onexit, this, exitArguments);
        };
        const terminal = Reflect.apply(originalFork, this, parameters);
        assert.ok(Number.isSafeInteger(terminal.pid) && terminal.pid > 0);
        assert.ok(Number.isSafeInteger(terminal.fd) && terminal.fd >= 0);
        launch.pid = terminal.pid;
        launch.fd = terminal.fd;
        originalFstatSync(terminal.fd);
        launches.push(launch);
        return terminal;
      });
    }
    return result;
  });
  syncBuiltinESMExports();
  return {
    metadataPaths: [NODE + "-spawn-helper", "/bin/bash", "/usr/bin/sandbox-exec", "/bin/ps"],
    bind(ctx) {
      boundContext = ctx;
      subprocess = unwrap(ctx.subprocess);
      agents = unwrap(ctx.agents);
      assert.ok(subprocess.live instanceof Set);
      assert.ok(subprocess.terminals instanceof Set);
      assert.ok(subprocess.controlChannels instanceof Set);
    },
    async run(action) {
      assert.equal(running, false);
      assert.equal(disposed, false);
      const before = launches.length;
      running = true;
      try {
        const result = await action();
        assert.equal(launches.length, before + 1, "One native PTY for each AgentLoop scenario");
        return result;
      } finally {
        running = false;
      }
    },
    async verifyDisposed() {
      running = false;
      for (const launch of launches) {
        assert.equal(launch.exited, true, "Native PTY onexit observed");
        assert.throws(
          () => originalFstatSync(launch.fd),
          { code: "EBADF" },
          "Owned PTY fd really closed",
        );
        launch.fdClosed = true;
      }
      for (const [registry, retained] of registries) {
        for (const owner of retained.owners.values()) assert.deepEqual(registry.list(owner), []);
        assert.equal(registry.sessions.size, 0);
      }
      if (launches.length > 0) assert.ok(registries.size > 0);
      if (subprocess) {
        assert.equal(subprocess.live.size, 0);
        assert.equal(subprocess.terminals.size, 0);
        assert.equal(subprocess.controlChannels.size, 0);
      } else assert.equal(launches.length, 0);
      files.forEach(verifyFile);
      disposed = true;
    },
    evidence: () => ({
      launches: structuredClone(launches),
      processInspections: structuredClone(inspections),
      processSignals: structuredClone(signals),
      nativeFileLocks: files.map(({ filename, ...row }) => ({
        ...row,
        verifiedAfterDispose: disposed,
      })),
      originalReadOnlySeatbeltSha256: hash(SEATBELT),
      cleanup: {
        verified: disposed,
        subprocessLive: subprocess?.live.size,
        subprocessTerminals: subprocess?.terminals.size,
        controlChannels: subprocess?.controlChannels.size,
        terminalSessions: [...registries.keys()].reduce(
          (total, registry) => total + registry.sessions.size,
          0,
        ),
        terminalRegistries: [...registries].map(([registry, retained]) => ({
          ordinal: retained.ordinal,
          sessions: registry.sessions.size,
          owners: [...retained.owners].map(([ownerId, owner]) => ({
            ownerId,
            sessions: registry.list(owner).length,
          })),
        })),
      },
      boundaries: {
        actualOfficialNativePty: true,
        officialInitializationIncludesStty: true,
        kernelReadWhitelist: false,
        kernelNetworkWhitelist: false,
        escapedDescendantsCovered: false,
        childShellProcessInterception: false,
      },
    }),
  };
}
