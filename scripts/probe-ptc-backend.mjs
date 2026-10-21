// One fixed, synthetic official PTC backend probe. Never runs the desktop application.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import http2 from "node:http2";
import childProcess from "node:child_process";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { officialReadRuntime } from "../tests/helpers/official-packages.mjs";

const NODE =
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node";
const INSTALLED = "/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh";
const INVENTORY_SHA = "3b264f1d9d4d3dc01e37aa382b2575a9dda6e34480af04982921b7d7720f0ef0";
const FIXTURE_SHA = "50ae2fb6580a69e817f3d10adff7ea86a90f46b1cbdea72b797bcfe07230033a";
const ARCHIVE_SHA = "6b3f1d6136fb49b908eb85c563b7aa13f052c982bcc71f591a75003b9b78aaaa";
const BOOTSTRAP_SHA = "e25ce53b26bb3e96e62cb7433f74612395f3865b4627a695d3d4fd42c4706790";
const SEATBELT =
  '(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null"))';
const project = fileURLToPath(new URL("../", import.meta.url));
const self = fileURLToPath(import.meta.url);
const fixture = join(project, "tests/helpers/official-packages.mjs");
const archive = join(project, "artifacts/official-packages/dsh-tool-fs-0.2.1-rc.2.tgz");
const inventoryPath = join(INSTALLED, "desktop-runtime.json");
const receipt = join(
  project,
  `artifacts/ptc-backend-v24-probe-receipt-${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}.json`,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (base, path) => {
  const suffix = relative(base, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix))
  );
};
// Hashing must not re-enter patched public fs functions through readFileSync.
const rawOpen = fs.openSync,
  rawRead = fs.readSync,
  rawFstat = fs.fstatSync,
  rawClose = fs.closeSync;
let verificationDescriptors = 0;
const raw = {
  realpath: fs.realpathSync,
  lstat: fs.lstatSync,
  read(filename) {
    const fd = rawOpen(filename, "r");
    verificationDescriptors++;
    try {
      const size = rawFstat(fd).size;
      assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 64 * 1024 * 1024);
      const bytes = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const count = rawRead(fd, bytes, offset, size - offset, offset);
        assert.ok(count > 0, "complete verification read");
        offset += count;
      }
      assert.equal(rawFstat(fd).size, size, "verification source size remains stable");
      return bytes;
    } finally {
      rawClose(fd);
      verificationDescriptors--;
    }
  },
};
const evidence = {
  format: 1,
  startedAt: new Date().toISOString(),
  node: process.version,
  developmentBasis: "c27d2520a6cb18b91e99d5c88d143d1de182eefd",
  scope:
    "one official ToolRuntime run_code -> NodePtcRuntime -> LocalSubprocessRuntime -> official read-only Seatbelt -> one official tools.read",
  syntheticInputsOnly: true,
  realProfileLoaded: false,
  installedOrReloaded: false,
  fullPresetOrAgentLoopAcceptance: false,
  launches: [],
  forbidden: [],
  installedInspectionOnly: [],
  officialEntries: [],
  verifiedLoadedFiles: [],
  filesystemReads: [],
  processSignals: [],
  cleanupErrors: [],
  boundaries: {
    kernel:
      "Unmodified official Seatbelt denies file writes except /dev/null; allow default leaves file reads and network unrestricted by the kernel profile.",
    javascript:
      "Parent Node public filesystem/network/process APIs are fenced; the fixed synthetic child disables network and process launch APIs before its one tools.read. These are JavaScript guards, not a kernel read/network whitelist.",
    processOwnership:
      "Official macOS ordinary subprocess uses a detached process group; escaped descendants are not guaranteed by that provider. This fixed child is forbidden from launching descendants.",
  },
};
const restores = [],
  fibers = [],
  scopes = [];
const loadedContent = new Map(),
  descriptorPaths = new Map();
let root, runtime, ctx, inventory, copiedFiles, inventoryHook;
let subprocessProvider,
  ptcProvider,
  presentationStop,
  launchOpen = false;
let child,
  childClosed,
  control,
  controlClosed = false,
  launchCount = 0;
let preparing = false,
  inspecting = false,
  receiptOpen = false,
  phase = "preflight";
let guardsActive = false,
  officialDisposed = false;
const controller = new AbortController();

function errorValue(error, seen = new WeakSet()) {
  if (error === null || typeof error !== "object")
    return typeof error === "bigint" ? String(error) : error;
  if (seen.has(error)) return "[circular error reference]";
  seen.add(error);
  if (Array.isArray(error)) return error.map((value) => errorValue(value, seen));
  const keys =
    error instanceof Error
      ? [...new Set(["name", "message", "stack", ...Object.getOwnPropertyNames(error)])]
      : Object.keys(error);
  return Object.fromEntries(keys.map((key) => [key, errorValue(error[key], seen)]));
}
function patch(object, key, replacement) {
  const previous = object[key];
  object[key] = replacement;
  restores.push(() => {
    object[key] = previous;
  });
  return previous;
}
function forbidden(name) {
  evidence.forbidden.push({ phase, operation: name });
  throw new Error(`PTC v24 fixed probe forbids ${name}`);
}
const deny = (name) => () => forbidden(name);
const textOf = (result) =>
  result.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n") ?? "";
const unwrap = (value) => {
  while (value?.[Symbol.for("cordis.original")]) value = value[Symbol.for("cordis.original")];
  return value;
};

try {
  assert.equal(process.execPath, NODE, "only the pinned bundled Node executable");
  assert.equal(process.version, "v24.21.0");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  assert.deepEqual(process.execArgv, ["--expose-internals"]);
  assert.deepEqual(process.argv.slice(2), [], "no user-supplied program or options");
  evidence.initialParentEnvironmentNames = Object.keys(process.env).sort();
  // macOS may inject this locale hint after env -i. Discard it before any
  // official module is imported; do not inherit or publish its user-specific value.
  delete process.env.__CF_USER_TEXT_ENCODING;
  assert.deepEqual(Object.keys(process.env).sort(), ["DSH_UNLIMIT_RUNTIME", "PATH"]);
  assert.equal(process.env.PATH, "/usr/bin:/bin");
  assert.equal(process.env.DSH_UNLIMIT_RUNTIME, INSTALLED);
  assert.equal(raw.realpath(INSTALLED), INSTALLED);
  const inventoryBytes = raw.read(inventoryPath);
  assert.equal(hash(inventoryBytes), INVENTORY_SHA);
  const manifest = JSON.parse(inventoryBytes);
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  inventory = new Map(manifest.files.map((row) => [row.path, row.sha256]));
  assert.equal(hash(raw.read(fixture)), FIXTURE_SHA);
  assert.equal(hash(raw.read(archive)), ARCHIVE_SHA);
  evidence.scriptSha256 = hash(raw.read(self));
  evidence.fixtureSha256 = FIXTURE_SHA;
  evidence.archive = {
    sha256: ARCHIVE_SHA,
    integrity:
      "sha512-hd3LmMFiOa4TTFL9+oabTe26CjzGUbflCMm8TcXm9jHN1tIhB8el1cyzaQ2x4A15G/jIlAsGZyuwuf5/FFJIOQ==",
    verifiedBy: "officialReadRuntime pinned archive validator",
  };
  evidence.inventorySha256 = INVENTORY_SHA;
  evidence.parentEnvironmentNames = Object.keys(process.env).sort();
  const inspections = [
    "dsh-tool-fs/lib/index.js",
    "dsh-tool-bash/lib/index.js",
    "dsh-tool-pwsh/lib/index.js",
    "dsh-agent-instructions/lib/index.js",
    "dsh-web-app/cordis.patch.yml",
  ];
  for (const suffix of inspections) {
    const path = `node_modules/@deepseek-ai/${suffix}`;
    const sha256 = hash(raw.read(join(INSTALLED, path)));
    evidence.installedInspectionOnly.push({
      path,
      sha256,
      inventorySha256: inventory.get(path),
      executed: false,
    });
  }
  fs.mkdirSync(join(project, "artifacts"), { recursive: true });
  root = fs.realpathSync(fs.mkdtempSync(join(project, "artifacts/ptc-backend-v24-probe-work-")));
  const workspace = join(root, "workspace"),
    target = join(workspace, "synthetic.txt");
  const marker = "SYNTHETIC_OFFICIAL_PTC_V24_SINGLE_READ\n";
  for (const suffix of ["workspace", "tmp", "home", "dsh-home", "agents-home", "bundled-skills"])
    fs.mkdirSync(join(root, suffix));
  fs.writeFileSync(target, marker);
  Object.assign(process.env, {
    TMPDIR: join(root, "tmp"),
    DSH_HOME: join(root, "dsh-home"),
    DSH_AGENTS_HOME: join(root, "agents-home"),
    DSH_BUNDLED_SKILL_DIR: join(root, "bundled-skills"),
  });
  process.chdir(workspace);
  evidence.syntheticInput = {
    relativePath: "workspace/synthetic.txt",
    bytes: Buffer.byteLength(marker),
    sha256: hash(marker),
  };

  // No official code has been imported yet. Metadata is explicit; file content is
  // limited to verified loader files, fixed fixture/archive inputs, or this root.
  const metadata = new Set([NODE, "/usr/bin/sandbox-exec", inventoryPath]);
  for (const filename of [
    root,
    INSTALLED,
    NODE,
    "/usr/bin/sandbox-exec",
    ...manifest.files.map((row) => join(INSTALLED, row.path)),
  ])
    for (let path = filename; ; path = dirname(path)) {
      metadata.add(path);
      if (dirname(path) === path) break;
    }
  copiedFiles = new Map(
    manifest.files
      .filter((row) =>
        [
          "@deepseek-ai/cordis/",
          "@deepseek-ai/cordis-plugin-loader/",
          "@deepseek-ai/dsh-hmr/",
          "@deepseek-ai/dsh-ptc-runtime-node/",
        ].some((pkg) => row.path.startsWith("node_modules/" + pkg)),
      )
      .map((row) => [join(INSTALLED, row.path), row.sha256]),
  );
  const inspectPaths = new Set(
    evidence.installedInspectionOnly.map((row) => join(INSTALLED, row.path)),
  );
  function pathOf(value) {
    if (typeof value === "number") {
      const known = descriptorPaths.get(value);
      if (!known) return forbidden("filesystem.unknown-fd");
      return known;
    }
    assert.ok(
      typeof value === "string" || Buffer.isBuffer(value) || value instanceof URL,
      "ordinary filesystem path",
    );
    return resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  }
  function checkPath(value, writing, operation) {
    const filename = pathOf(value);
    if (
      receiptOpen &&
      filename === receipt &&
      ["writeFileSync", "openSync", "writeSync", "closeSync"].includes(operation)
    )
      return filename;
    if (within(root, filename)) {
      // Reject a symlink escape by canonicalizing the nearest existing ancestor.
      let existing = filename;
      for (;;) {
        try {
          raw.lstat(existing);
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          existing = dirname(existing);
        }
      }
      if (existing !== dirname(root) && !within(root, raw.realpath(existing)))
        return forbidden(`filesystem.${operation}.symlink-escape`);
      return filename;
    }
    if (writing) return forbidden(`filesystem.${operation}.outside-synthetic-root`);
    if (
      /^(?:stat|lstat|access|exists|realpath)(?:Sync)?(?:\.native)?$/.test(operation) &&
      metadata.has(filename)
    )
      return filename;
    if (loadedContent.has(filename)) {
      assert.equal(
        hash(raw.read(filename)),
        loadedContent.get(filename),
        "verified official content remains unchanged",
      );
      return filename;
    }
    if (
      (preparing && [archive, inventoryPath].includes(filename)) ||
      (inspecting && inspectPaths.has(filename))
    )
      return filename;
    if (preparing && copiedFiles.has(filename)) {
      assert.equal(
        hash(raw.read(filename)),
        copiedFiles.get(filename),
        "official runtime copy matches inventory",
      );
      return filename;
    }
    return forbidden(`filesystem.${operation}.unapproved-content`);
  }
  const writingFlags = (flags) =>
    typeof flags === "number"
      ? (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)) !==
        0
      : /[wa+]/.test(String(flags));
  function guard(api, key, writing, operation = key) {
    const original = api[key];
    if (typeof original !== "function") return;
    const replacement = function (path, ...args) {
      const filename = checkPath(
        path,
        writing === "open" ? writingFlags(args[0]) : writing,
        operation,
      );
      if (
        key.startsWith("rename") ||
        key.startsWith("copyFile") ||
        key === "cp" ||
        key === "cpSync"
      )
        checkPath(args[0], true, key);
      if (filename === target && /^(?:readFile|open|createReadStream)/.test(key))
        evidence.filesystemReads.push({ phase, operation: key, scope: "fixed-synthetic-file" });
      if (key === "open" && api === fs) {
        const callback = args.pop();
        return Reflect.apply(original, this, [
          path,
          ...args,
          (error, fd) => {
            if (!error) descriptorPaths.set(fd, filename);
            callback(error, fd);
          },
        ]);
      }
      if (key === "close" && api === fs) {
        const callback = args.pop();
        return Reflect.apply(original, this, [
          path,
          ...args,
          (error) => {
            if (!error) descriptorPaths.delete(path);
            callback(error);
          },
        ]);
      }
      const result = Reflect.apply(original, this, [path, ...args]);
      if (key === "openSync") descriptorPaths.set(result, filename);
      if (key === "closeSync") descriptorPaths.delete(path);
      if (key === "open" && api === fsPromises)
        return result.then((handle) => {
          const fd = handle.fd;
          descriptorPaths.set(fd, filename);
          const close = handle.close;
          handle.close = async function (...closeArgs) {
            await Reflect.apply(close, this, closeArgs);
            descriptorPaths.delete(fd);
          };
          return handle;
        });
      return result;
    };
    for (const key of Reflect.ownKeys(original))
      if (!["name", "length", "prototype", "arguments", "caller"].includes(key))
        Object.defineProperty(replacement, key, Object.getOwnPropertyDescriptor(original, key));
    patch(api, key, replacement);
  }
  for (const name of [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "exists",
    "realpath",
    "readlink",
    "opendir",
    "statfs",
  ])
    for (const key of [name, name + "Sync"]) guard(fs, key, false);
  for (const key of ["realpath", "realpathSync"]) guard(fs[key], "native", false, key + ".native");
  for (const name of [
    "writeFile",
    "appendFile",
    "mkdir",
    "mkdtemp",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
    "cp",
    "truncate",
    "chmod",
    "chown",
    "lchown",
    "utimes",
    "lutimes",
  ])
    for (const key of [name, name + "Sync"]) guard(fs, key, true);
  for (const key of ["open", "openSync"]) guard(fs, key, "open");
  guard(fs, "createReadStream", false);
  guard(fs, "createWriteStream", true);
  for (const key of [
    "watch",
    "watchFile",
    "glob",
    "globSync",
    "link",
    "linkSync",
    "symlink",
    "symlinkSync",
  ])
    if (typeof fs[key] === "function") patch(fs, key, deny("filesystem." + key));
  for (const key of [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "realpath",
    "readlink",
    "opendir",
    "statfs",
  ])
    guard(fsPromises, key, false);
  for (const key of [
    "writeFile",
    "appendFile",
    "mkdir",
    "mkdtemp",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
    "cp",
    "truncate",
    "chmod",
    "chown",
    "lchown",
    "utimes",
    "lutimes",
  ])
    guard(fsPromises, key, true);
  guard(fsPromises, "open", "open");
  for (const key of ["watch", "glob", "link", "symlink"])
    if (typeof fsPromises[key] === "function")
      patch(fsPromises, key, deny("filesystem/promises." + key));
  // No public descriptor operation may address an untracked inherited descriptor.
  for (const name of [
    "read",
    "readv",
    "write",
    "writev",
    "fstat",
    "fsync",
    "fdatasync",
    "ftruncate",
    "fchmod",
    "fchown",
    "futimes",
    "close",
  ])
    for (const key of [name, name + "Sync"])
      guard(fs, key, /^(write|ftruncate|fchmod|fchown|futimes)/.test(name));

  patch(os, "homedir", () => join(root, "home"));
  for (const [api, key, label] of [
    [net.Socket.prototype, "connect", "socket.connect"],
    [net.Server.prototype, "listen", "socket.listen"],
    [dgram.Socket.prototype, "bind", "dgram.bind"],
    [dgram.Socket.prototype, "send", "dgram.send"],
    [dgram.Socket.prototype, "connect", "dgram.connect"],
    [tls, "connect", "tls.connect"],
    [http2, "connect", "http2.connect"],
    [http, "request", "http.request"],
    [http, "get", "http.get"],
    [https, "request", "https.request"],
    [https, "get", "https.get"],
    [globalThis, "fetch", "fetch"],
  ])
    patch(api, key, deny(label));
  for (const [label, api] of [
    ["dns", dns],
    ["dns/promises", dnsPromises],
  ])
    for (const key of Object.keys(api))
      if (/^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function")
        patch(api, key, deny(label + "." + key));
  if (globalThis.WebSocket) patch(globalThis, "WebSocket", deny("WebSocket"));
  for (const key of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    patch(childProcess, key, deny("child_process." + key));
  patch(process, "dlopen", deny("process.dlopen"));
  const originalKill = patch(process, "kill", (pid, signal = "SIGTERM") => {
    if (
      !child?.pid ||
      ![child.pid, -child.pid].includes(pid) ||
      ![0, "SIGTERM", "SIGKILL"].includes(signal)
    )
      return forbidden("process.kill.unowned-or-unapproved-signal");
    evidence.processSignals.push({
      target: pid < 0 ? "owned-process-group" : "owned-child",
      signal,
    });
    return originalKill(pid, signal);
  });
  let nativeSpawnOpen = false;
  const childSpawn = patch(childProcess.ChildProcess.prototype, "spawn", function (...args) {
    if (!nativeSpawnOpen) return forbidden("ChildProcess.spawn");
    return Reflect.apply(childSpawn, this, args);
  });
  const childKill = patch(
    childProcess.ChildProcess.prototype,
    "kill",
    function (signal = "SIGTERM") {
      if (this !== child || !["SIGTERM", "SIGKILL"].includes(signal))
        return forbidden("ChildProcess.kill.unowned");
      return Reflect.apply(childKill, this, [signal]);
    },
  );
  const spawn = patch(childProcess, "spawn", (command, args, options) => {
    if (!launchOpen || launchCount !== 0) return forbidden("child_process.spawn.extra");
    assert.equal(command, "sandbox-exec");
    assert.equal(raw.realpath("/usr/bin/sandbox-exec"), "/usr/bin/sandbox-exec");
    const expected = [
      "-p",
      SEATBELT,
      "--",
      NODE,
      "--max-old-space-size=64",
      join(runtime.root, "node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js"),
      "1048576",
    ];
    assert.deepEqual(args, expected, "fixed complete official sandbox argv");
    assert.equal(hash(fs.readFileSync(expected[5])), BOOTSTRAP_SHA);
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
    const effectiveEnvironment = Object.fromEntries(
      Object.entries(options.env).filter(([, value]) => value !== undefined),
    );
    assert.deepEqual(effectiveEnvironment, {
      PATH: "/usr/bin:/bin",
      DSH_SUBPROCESS_CONTROL: "pipe",
    });
    launchCount++;
    const row = {
      executable: "/usr/bin/sandbox-exec",
      command,
      argv: expected,
      cwd: workspace,
      stdio: options.stdio,
      environment: effectiveEnvironment,
      profile: {
        completeText: SEATBELT,
        sha256: hash(SEATBELT),
        filePolicy: "read-only",
        kernelReadWhitelist: false,
        kernelNetworkWhitelist: false,
      },
      bootstrapSha256: BOOTSTRAP_SHA,
      events: [],
      stdout: "",
      stderr: "",
    };
    evidence.launches.push(row);
    nativeSpawnOpen = true;
    try {
      child = spawn(command, args, options);
    } finally {
      nativeSpawnOpen = false;
    }
    childClosed = new Promise((resolveClose) =>
      child.once("close", (code, signal) => {
        row.events.push({ type: "close", code, signal });
        resolveClose();
      }),
    );
    child.once("spawn", () => row.events.push({ type: "spawn" }));
    child.once("exit", (code, signal) => row.events.push({ type: "exit", code, signal }));
    child.once("error", (error) => row.events.push({ type: "error", error: errorValue(error) }));
    child.stdout?.on("data", (bytes) => {
      row.stdout += bytes.toString("utf8");
    });
    child.stderr?.on("data", (bytes) => {
      row.stderr += bytes.toString("utf8");
    });
    control = child.stdio[7];
    assert.ok(control, "the real child must expose inherited fd 7");
    control.once("close", () => {
      controlClosed = true;
      row.events.push({ type: "control-close" });
    });
    control.once("error", (error) =>
      row.events.push({ type: "control-error", error: errorValue(error) }),
    );
    return child;
  });
  syncBuiltinESMExports();
  guardsActive = true;
  preparing = true;
  runtime = officialReadRuntime(INSTALLED, join(project, "artifacts/official-packages"));
  assert.ok(within(root, runtime.root), "clean runtime remains within the synthetic root");
  // Official pinned tool-fs archive is supplied by the shared helper. The PTC
  // package is copied byte-for-byte from its pinned inventory, without patches.
  for (const [filename, sha256] of copiedFiles)
    if (filename.startsWith(join(INSTALLED, "node_modules/@deepseek-ai/dsh-ptc-runtime-node/"))) {
      const bytes = fs.readFileSync(filename);
      assert.equal(hash(bytes), sha256);
      const destination = join(runtime.root, relative(INSTALLED, filename));
      fs.mkdirSync(dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
    }
  preparing = false;
  inventoryHook = registerHooks({
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const filename = fileURLToPath(url);
        const base = within(runtime.root, filename) ? runtime.root : INSTALLED;
        assert.ok(within(base, filename));
        assert.ok(!inspectPaths.has(filename), "inspection-only installed entries cannot execute");
        const path = relative(base, filename),
          expected = inventory.get(path);
        assert.ok(expected, `official import must exist in the pinned inventory: ${path}`);
        assert.equal(hash(raw.read(filename)), expected, `every actual official import: ${path}`);
        loadedContent.set(filename, expected);
      }
      return next(url, context);
    },
  });
  const names = {
    cordis: "cordis",
    prompt: "dsh-system-prompt",
    tools: "dsh-tools",
    scope: "dsh-scope",
    sessions: "dsh-session",
    projections: "dsh-session-projection",
    agents: "dsh-agent",
    sandboxPolicy: "dsh-sandbox-policy",
    fs: "dsh-fs-sandbox",
    observation: "dsh-fs-observation-policy",
    directory: "dsh-working-directory",
    approval: "dsh-user-approval",
    fileTools: "dsh-tool-fs",
    localSandbox: "dsh-sandbox-local",
    localSubprocess: "dsh-subprocess-local",
    nodePtc: "dsh-ptc-runtime-node",
  };
  const api = {},
    requireHost = createRequire(join(INSTALLED, "package.json"));
  phase = "official-load";
  for (const [key, short] of Object.entries(names)) {
    const name = "@deepseek-ai/" + short;
    api[key] =
      key === "nodePtc"
        ? await import(pathToFileURL(join(runtime.root, "node_modules", name, "lib/index.js")).href)
        : await runtime.load(name);
    const filename =
      key === "nodePtc" || ["cordis", "fileTools"].includes(key)
        ? join(runtime.root, "node_modules", name, "lib/index.js")
        : requireHost.resolve(name);
    assert.ok(loadedContent.has(filename), `direct official entry was verified: ${name}`);
    evidence.officialEntries.push({
      name,
      path: relative(within(runtime.root, filename) ? runtime.root : INSTALLED, filename),
      sha256: loadedContent.get(filename),
      source: within(runtime.root, filename)
        ? "temporary-clean-runtime"
        : "inventory-verified-installed-dependency",
    });
  }
  const bootstrap = join(
    runtime.root,
    "node_modules/@deepseek-ai/dsh-ptc-runtime-node/lib/process.js",
  );
  assert.equal(hash(fs.readFileSync(bootstrap)), BOOTSTRAP_SHA);
  evidence.bootstrap = {
    path: relative(runtime.root, bootstrap),
    sha256: BOOTSTRAP_SHA,
    source: "temporary-inventory-verified-official-copy",
    staticImports: ["node:net", "node:buffer", "node:util"],
  };
  ctx = new api.cordis.Context();
  async function mount(plugin, config) {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "official service active");
    return fiber;
  }
  const events = [];
  const foundation = await mount({
    name: "fixed-synthetic-ptc-v24-foundation",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.agents.AgentRegistry(scope);
      new api.tools.ToolRuntime(scope);
      new api.sandboxPolicy.SandboxPolicyService(scope, {
        mode: "read-only",
        workspaceRoot: workspace,
      });
      new api.approval.ApprovalService(scope, { policy: "never" });
      scope.on("session/event", (_session, event) => {
        if (event.type.startsWith("tool/ptc-dispatch"))
          events.push({ type: event.type, data: structuredClone(event.data) });
      });
    },
  });
  await mount(api.fs.SandboxedFileSystem, { cwd: workspace });
  await mount(api.directory.WorkingDirectoryService, { defaultDirectory: workspace });
  await mount(api.observation);
  await mount(api.fileTools, { read: true, readImage: false, write: false, edit: false });
  await mount(api.localSandbox.LocalSandboxProvider, {});
  await mount(api.localSubprocess.LocalSubprocessRuntime);
  await mount(api.nodePtc.NodePtcRuntime, {
    executionMode: "per-call",
    timeoutMs: 3000,
    maxTimeoutMs: 3000,
    maxOutputBytes: 65536,
    maxMessageBytes: 1048576,
    maxPendingCalls: 1,
    maxOldGenerationSizeMb: 64,
    graceMs: 200,
    launch: { kind: "node-script", executable: NODE, bootstrapPath: bootstrap },
  });
  subprocessProvider = unwrap(ctx.subprocess);
  ptcProvider = unwrap(ctx.ptcRuntime);
  const agent = {
    id: "synthetic-ptc-v24-root",
    session: ctx.sessions.create("synthetic-ptc-v24-root", { meta: { cwd: workspace } }),
    options: {},
    inject: () => {},
  };
  const scope = api.scope.createScope(foundation.ctx, agent);
  scopes.push(scope);
  agent.ctx = scope.ctx;
  await ctx.agents.register(agent);
  presentationStop = agent.ctx.tools.presentAs("ptc");
  const assembly = await ctx.systemPrompt.assemble({
    agent,
    scope: agent,
    signal: controller.signal,
  });
  assert.deepEqual(
    assembly.tools.map(({ name }) => name),
    ["run_code"],
  );
  const program = `
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
const value = await tools.read({ file_path: ${JSON.stringify(target)} });
return { value, networkAndSpawnAttempts: attempts, environmentNames: Object.keys(process.env) };
`;
  evidence.fixedProgramSha256 = hash(program);
  phase = "single-ptc-read";
  launchOpen = true;
  const result = await ctx.tools.execute({
    name: "run_code",
    arguments: {
      code: program,
      description: "Read the single disposable synthetic file through the official PTC binding.",
      timeoutMs: 3000,
    },
    agent,
    signal: controller.signal,
    callId: "synthetic-ptc-v24-single-run",
  });
  launchOpen = false;
  evidence.toolResult = {
    isError: result.isError,
    content: result.content,
    value: result.value,
    error: result.error ? errorValue(result.error) : undefined,
  };
  evidence.ptcDispatchEvents = events;
  assert.equal(launchCount, 1, "exactly one real official Seatbelt spawn");
  if (result.isError) {
    evidence.status = textOf(result).includes("sandbox-unavailable")
      ? "refused-sandbox-unavailable"
      : "official-tool-failed";
    process.exitCode = 2;
  } else {
    assert.match(
      JSON.stringify(result.value.result.value),
      /SYNTHETIC_OFFICIAL_PTC_V24_SINGLE_READ/,
    );
    assert.deepEqual(result.value.result.networkAndSpawnAttempts, []);
    assert.deepEqual(result.value.result.environmentNames, []);
    assert.deepEqual(
      events.map((event) => event.type),
      ["tool/ptc-dispatch-start", "tool/ptc-dispatch"],
    );
    assert.equal(events[0].data.name, "read");
    assert.ok(
      evidence.filesystemReads.some((row) => row.phase === "single-ptc-read"),
      "the fixed file reached the real filesystem API and its marker was returned",
    );
    evidence.status = "passed";
  }
} catch (error) {
  evidence.status = "failed";
  evidence.failure = errorValue(error);
  process.exitCode = 1;
} finally {
  phase = "cleanup";
  launchOpen = false;
  const cleanup = async (name, action) => {
    try {
      await action();
    } catch (error) {
      evidence.cleanupErrors.push({ name, error: errorValue(error) });
      process.exitCode = 1;
    }
  };
  await cleanup("presentation", async () => presentationStop?.());
  for (const scope of scopes.reverse()) await cleanup("scope", () => scope.dispose());
  for (const fiber of fibers.reverse())
    if (fiber.uid !== null) await cleanup("fiber", () => fiber.dispose());
  await cleanup("context", async () => {
    await ctx?.fiber.dispose();
    officialDisposed = true;
  });
  await cleanup("child-close", async () => {
    if (childClosed) {
      let timeout;
      try {
        await Promise.race([
          childClosed,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("owned child close was not observed after official disposal")),
              2000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
  });
  if (runtime)
    evidence.verifiedLoadedFiles = [...runtime.verifiedFiles]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  await cleanup("loaded-inventory-readback", async () => {
    for (const [path, sha256] of runtime?.verifiedFiles ?? [])
      assert.equal(sha256, inventory.get(path), path);
  });
  inspecting = true;
  await cleanup("installed-entry-readback", async () => {
    for (const row of evidence.installedInspectionOnly)
      assert.equal(
        hash(fs.readFileSync(join(INSTALLED, row.path))),
        row.sha256,
        "installed inspection-only entry is unchanged",
      );
  });
  inspecting = false;
  await cleanup("clean-runtime", async () => runtime?.dispose());
  await cleanup("inventory-hook", async () => inventoryHook?.deregister());
  process.chdir(project);
  await cleanup("synthetic-root", async () => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });
  evidence.cleanup = {
    officialLifecycleDisposed: ctx ? officialDisposed : null,
    syntheticRootRemoved: root ? !fs.existsSync(root) : true,
    cleanRuntimeRemoved: runtime ? !fs.existsSync(runtime.root) : true,
    subprocessLive: subprocessProvider?.live.size ?? null,
    subprocessControlChannels: subprocessProvider?.controlChannels.size ?? null,
    ptcLive: ptcProvider?.live.size ?? null,
    childCloseObserved: child
      ? evidence.launches[0].events.some((row) => row.type === "close")
      : null,
    childExitCode: child?.exitCode ?? null,
    childSignalCode: child?.signalCode ?? null,
    controlPipeClosed: control ? controlClosed && control.destroyed : null,
    guardsActiveThroughLifecycleAndRootRemoval: guardsActive,
    liveTrackedDescriptors: descriptorPaths.size,
    liveVerificationDescriptors: verificationDescriptors,
  };
  if (
    child &&
    (!evidence.cleanup.childCloseObserved ||
      !evidence.cleanup.controlPipeClosed ||
      evidence.cleanup.subprocessLive !== 0 ||
      evidence.cleanup.subprocessControlChannels !== 0 ||
      evidence.cleanup.ptcLive !== 0)
  ) {
    evidence.cleanupErrors.push({
      name: "cleanup-postconditions",
      message: "official process/control/runtime cleanup was not fully verified",
    });
    process.exitCode = 1;
  }
  if (
    !evidence.cleanup.syntheticRootRemoved ||
    !evidence.cleanup.cleanRuntimeRemoved ||
    descriptorPaths.size ||
    verificationDescriptors ||
    evidence.forbidden.length ||
    evidence.cleanupErrors.length
  ) {
    evidence.status = "failed";
    process.exitCode = 1;
  }
  evidence.finishedAt = new Date().toISOString();
  receiptOpen = true;
  try {
    fs.writeFileSync(receipt, JSON.stringify(evidence, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    receiptOpen = false;
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  }
}
console.log(
  JSON.stringify(
    {
      status: evidence.status,
      receipt,
      launches: evidence.launches.length,
      cleanup: evidence.cleanup,
      failure: evidence.failure?.message,
    },
    null,
    2,
  ),
);
