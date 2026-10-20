import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire, registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";

const PRODUCER = "@deepseek-ai/dsh-agent-instructions";
export const nativeInstructionsRelease = {
  version: "0.2.1-rc.2",
  sri: "sha512-a1VQsocz34VvkwYMNc/zolMXrLXWIClhZ62kb3pi8hYd/8MSgjuE09YcoqX6ZmU8i4tmaroC9W1PdUEIksSgiQ==",
  entrySha256: "4011f6e4c08228601bd4348ac78e322913142264f6e491ffdf9dcfda97393988",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (base, path) => {
  const child = relative(base, path);
  return child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child));
};

// This is a test-only public-tar reader, not a copy of a producer implementation.
function unpackProducer(bytes) {
  assert.equal(
    "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    nativeInstructionsRelease.sri,
    "The producer must be the pinned public archive",
  );
  const tar = gunzipSync(bytes, { maxOutputLength: 4 * 1024 * 1024 });
  const files = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100);
    assert.equal(text(345, 500), "", "Only short ordinary tar paths are accepted");
    assert.match(name, /^package\/(?!\/)[^\\]+$/);
    assert.ok(!name.split("/").some((part) => part === "." || part === ".." || part === ""));
    assert.ok([0, 48].includes(header[156]), "No archive links or special files are accepted");
    const size = parseInt(text(124, 136).trim(), 8);
    assert.ok(Number.isSafeInteger(size) && size >= 0 && size <= 2 * 1024 * 1024);
    assert.equal(
      [...header].reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0),
      parseInt(text(148, 156).trim(), 8),
    );
    assert.ok(offset + 512 + size <= tar.length);
    assert.ok(!files.has(name) && files.size < 128);
    files.set(name, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(digest(files.get("package/lib/index.js")), nativeInstructionsRelease.entrySha256);
  const pkg = JSON.parse(files.get("package/package.json"));
  assert.equal(pkg.name, PRODUCER);
  assert.equal(pkg.version, nativeInstructionsRelease.version);
  return files;
}

/** Official Cordis, producer, Session, AgentLoop and JSONL; only the I/O world is synthetic. */
export async function nativeInstructionsFixture(t, runtimeRoot, officialPackages) {
  const root = fs.realpathSync(runtimeRoot);
  const manifest = JSON.parse(fs.readFileSync(join(root, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, nativeInstructionsRelease.version);
  const inventory = new Map(manifest.files.map((row) => [row.path, row]));
  assert.equal(
    inventory.get(`node_modules/${PRODUCER}/lib/index.js`)?.sha256,
    nativeInstructionsRelease.entrySha256,
    "Public producer and desktop inventory must agree",
  );
  const producerFiles = unpackProducer(
    fs.readFileSync(join(officialPackages, "dsh-agent-instructions-0.2.1-rc.2.tgz")),
  );
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "dsh-native-instructions-")));
  const cleanRoot = join(directory, "official");
  const homes = {
    HOME: join(directory, "home"),
    DSH_HOME: join(directory, "dsh-home"),
    DSH_AGENTS_HOME: join(directory, "agents-home"),
  };
  const previousEnvironment = new Map(Object.keys(homes).map((key) => [key, process.env[key]]));
  const put = (filename, bytes) => {
    fs.mkdirSync(dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
  };
  const copies = [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-agent-loop",
    PRODUCER,
  ];
  const modules = new Map();
  for (const [path, bytes] of producerFiles)
    put(join(cleanRoot, "node_modules", PRODUCER, path.slice(8)), bytes);
  for (const name of copies.slice(0, -1)) {
    const members = manifest.files.filter((row) => row.path.startsWith(`node_modules/${name}/`));
    assert.ok(members.length > 0, `Inventory must cover ${name}`);
    for (const row of members) {
      const bytes = fs.readFileSync(join(root, row.path));
      assert.equal(digest(bytes), row.sha256, `Refusing modified official file: ${row.path}`);
      put(join(cleanRoot, row.path), bytes);
    }
  }
  const packageBytes = fs.readFileSync(join(root, "package.json"));
  assert.equal(digest(packageBytes), inventory.get("package.json")?.sha256);
  put(join(cleanRoot, "package.json"), packageBytes);
  put(join(cleanRoot, "desktop-runtime.json"), JSON.stringify(manifest));
  for (const home of Object.values(homes)) fs.mkdirSync(home, { recursive: true });
  const project = join(directory, "project");
  fs.mkdirSync(join(project, ".git"), { recursive: true });
  put(join(project, "AGENTS.md"), "SYNTHETIC_PROJECT_RULE_V1\n");
  put(join(homes.DSH_HOME, "AGENTS.md"), "SYNTHETIC_HARNESS_GLOBAL_RULE\n");
  put(join(homes.DSH_AGENTS_HOME, "AGENTS.md"), "SYNTHETIC_SHARED_GLOBAL_RULE\n");
  // Home isolation is established before even importing an official module.
  for (const [key, value] of Object.entries(homes)) process.env[key] = value;

  const forbiddenCalls = [];
  const deny = (name) => () => {
    forbiddenCalls.push(name);
    throw new Error(`Native instruction fixture forbids ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("datagram bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("datagram send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  const checkPath = (path, writing, operation) => {
    if (typeof path === "number") return;
    const filename = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    if (within(directory, filename) || (!writing && within(root, filename))) return;
    forbiddenCalls.push(`filesystem.${operation}`);
    throw new Error(
      `Native instruction fixture forbids filesystem.${operation} outside temporary data and verified runtime`,
    );
  };
  const writingFlags = (flags) =>
    typeof flags === "number"
      ? (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)) !==
        0
      : typeof flags === "string" && /[wa+]/.test(flags);
  const guard = (object, name, writing) => {
    const original = object[name];
    if (typeof original !== "function") return;
    t.mock.method(object, name, function (path, ...args) {
      checkPath(path, writing === "open" ? writingFlags(args[0]) : writing, name);
      if (["rename", "renameSync", "copyFile", "copyFileSync"].includes(name))
        checkPath(args[0], true, name);
      return Reflect.apply(original, this, [path, ...args]);
    });
  };
  for (const base of [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "exists",
    "realpath",
    "readlink",
    "opendir",
  ])
    for (const name of [base, `${base}Sync`]) guard(fs, name, false);
  for (const base of [
    "writeFile",
    "appendFile",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
  ])
    for (const name of [base, `${base}Sync`]) guard(fs, name, true);
  for (const name of ["open", "openSync"]) guard(fs, name, "open");
  for (const name of ["createReadStream", "watch", "watchFile"]) guard(fs, name, false);
  guard(fs, "createWriteStream", true);
  for (const name of [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "realpath",
    "readlink",
    "opendir",
  ])
    guard(fsPromises, name, false);
  for (const name of [
    "writeFile",
    "appendFile",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
  ])
    guard(fsPromises, name, true);
  guard(fsPromises, "open", "open");
  syncBuiltinESMExports();

  const requireHost = createRequire(join(root, "package.json"));
  const runtimeURL = pathToFileURL(join(root, "package.json")).href;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === PRODUCER)
        return {
          url: pathToFileURL(join(cleanRoot, "node_modules", PRODUCER, "lib/index.js")).href,
          shortCircuit: true,
        };
      let result;
      try {
        result = next(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))
          throw error;
        result = next(specifier, { ...context, parentURL: runtimeURL });
      }
      if (result.url.startsWith("file:")) {
        const path = fileURLToPath(result.url);
        for (const name of copies) {
          const original = join(root, "node_modules", name);
          if (within(original, path))
            return {
              ...result,
              url: pathToFileURL(join(cleanRoot, "node_modules", name, relative(original, path)))
                .href,
            };
        }
      }
      return result;
    },
    load(url, context, next) {
      if (url.startsWith("file:")) {
        const path = fileURLToPath(url);
        if (within(root, path) || within(cleanRoot, path)) {
          const rel = relative(within(cleanRoot, path) ? cleanRoot : root, path);
          const actual = digest(fs.readFileSync(path));
          assert.equal(
            actual,
            inventory.get(rel)?.sha256,
            `Every executed official module must match inventory: ${rel}`,
          );
          modules.set(rel, { path: rel, sha256: actual, inventoryMatch: true });
        }
      }
      return next(url, context);
    },
  });
  let ctx;
  const fibers = [];
  const agents = [];
  const handles = new Map();
  let beforeCleanup = () => {};
  t.after(async () => {
    try {
      beforeCleanup();
      for (const agent of agents) agent.cancel({ kind: "user" });
      await Promise.all(agents.map((agent) => agent.whenIdle()));
      for (const handle of handles.values()) await handle.dispose();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx?.fiber.dispose();
      assert.deepEqual(
        forbiddenCalls,
        [],
        "No profile, network, subprocess or out-of-fixture filesystem attempt is permitted",
      );
    } finally {
      hooks.deregister();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const load = async (name) => import(pathToFileURL(requireHost.resolve(name)).href);
  const names = {
    cordis: "@deepseek-ai/cordis",
    prompt: "@deepseek-ai/dsh-system-prompt",
    projections: "@deepseek-ai/dsh-session-projection",
    sessions: "@deepseek-ai/dsh-session",
    fork: "@deepseek-ai/dsh-session/fork",
    agents: "@deepseek-ai/dsh-agent",
    llm: "@deepseek-ai/dsh-llm",
    tools: "@deepseek-ai/dsh-tools",
    loop: "@deepseek-ai/dsh-agent-loop",
    cosmokit: "@deepseek-ai/cosmokit",
    approval: "@deepseek-ai/dsh-user-approval",
    sandbox: "@deepseek-ai/dsh-sandbox-policy",
    persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
    directories: "@deepseek-ai/dsh-working-directory",
  };
  const api = Object.fromEntries(
    await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
  );
  // Do not resolve or import the installed producer entry, even as an intermediate URL.
  api.instructions = await import(PRODUCER);
  ctx = new api.cordis.Context();
  const errors = [],
    requests = [],
    fileReads = [];
  const plans = new Map(),
    readEffects = new Map();
  class SyntheticAdapter extends api.llm.LlmAdapter {
    async *stream(options) {
      const agent = ctx.agents.get(options.sessionId);
      assert.ok(agent);
      assert.deepEqual(options.messages, agent.session.deriveMessages());
      requests.push({
        sessionId: agent.id,
        turn: agent.phase.turn,
        step: agent.phase.step,
        cursor: agent.session.seq - 1,
        messages: structuredClone(options.messages),
        tools: structuredClone(options.tools),
        header: structuredClone(agent.session.requestHeader()),
      });
      const plan = plans.get(agent.id)?.shift();
      if (plan?.kind === "read") {
        yield {
          type: "tool-call-delta",
          index: 0,
          id: `synthetic-read-${requests.length}`,
          name: "read",
          argumentsDelta: JSON.stringify({ file_path: plan.path }),
        };
      } else if (plan?.kind === "cancel") {
        plan.started.resolve();
        await new Promise((resume) => {
          if (options.signal.aborted) resume();
          else options.signal.addEventListener("abort", resume, { once: true });
        });
        options.signal.throwIfAborted();
      } else yield { type: "text-delta", index: 0, text: "SYNTHETIC_OFFLINE_COMPLETION" };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "Every required official service must be active");
    return fiber;
  };
  await mount({
    name: "synthetic-native-instructions-foundation",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "SYNTHETIC_SYSTEM_PROMPT",
        personaSuffix: "",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.agents.AgentRegistry(scope);
      new api.llm.LlmRuntime(scope);
      new api.tools.ToolRuntime(scope);
      new api.approval.ApprovalService(scope, { policy: "ask" });
      new api.sandbox.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: directory });
      new api.loop.AgentLoop(scope, {
        agents: [],
        maxParallelToolCalls: api.cosmokit.createVolatile(1),
      });
      scope.llm.registerAdapter(["synthetic-offline"], new SyntheticAdapter());
      const fileSystem = new api.cordis.Service(scope, "fs");
      fileSystem.resolve = async (path, options = {}) => {
        options.signal?.throwIfAborted();
        const target = resolve(options.cwd ?? project, path);
        assert.ok(
          within(directory, target),
          "Synthetic provider must never resolve a real profile or project",
        );
        return target;
      };
      fileSystem.stat = async (target, signal) => {
        signal?.throwIfAborted();
        assert.ok(within(directory, target));
        try {
          const info = await fsPromises.stat(target);
          return {
            type: info.isDirectory() ? "directory" : "file",
            size: info.size,
            version: `${info.mtimeMs}:${info.size}`,
          };
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
          throw error;
        }
      };
      fileSystem.processPath = (target) => target;
      fileSystem.streamText = async function* (target, signal) {
        signal?.throwIfAborted();
        assert.ok(within(directory, target));
        fileReads.push(relative(directory, target));
        const text = await fsPromises.readFile(target, "utf8");
        signal?.throwIfAborted();
        yield text;
      };
      scope.tools.register(
        api.tools.defineTool({
          name: "read",
          description: "Read only one disposable synthetic fixture file.",
          parameters: { file_path: { type: "string" } },
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          async execute(args, exec) {
            const target = await fileSystem.resolve(args.file_path, { signal: exec.signal });
            assert.ok(within(project, target));
            const effect = readEffects.get(exec.agent.id);
            readEffects.delete(exec.agent.id);
            await effect?.();
            return fsPromises.readFile(target, "utf8");
          },
        }),
      );
      scope.on("agent/error", ({ error }) => errors.push(error));
    },
  });
  await mount(api.persistence, {
    root: join(directory, "logs"),
    compression: "none",
    listConcurrency: 1,
  });
  await mount(api.directories.WorkingDirectoryService, { defaultDirectory: project });
  await mount(api.instructions, { maxBytes: 12000 });

  const remember = (handle) => {
    const { agent } = handle;
    handles.set(agent.id, handle);
    agents.push(agent);
    return agent;
  };
  const create = async (
    label = `synthetic-native-${agents.length + 1}`,
    model = "synthetic-model",
  ) => {
    const handle = await ctx.agents.create({
      sessionId: label,
      agentOptions: { provider: "synthetic-offline", model, maxTokens: 128 },
      meta: { cwd: project },
    });
    return remember(handle);
  };
  const fork = async (source, label) => {
    const events = source.session.snapshotEvents();
    const boundary = events.at(-1).seq;
    return remember(
      await ctx.agents.create({
        sessionId: label,
        seed: api.fork.buildForkSeed(events, boundary),
        inheritedEventCount: boundary + 1,
        meta: { cwd: source.session.header.cwd, parentSession: source.id, isSeeded: true },
        agentOptions: { provider: "synthetic-offline", model: "synthetic-model", maxTokens: 128 },
      }),
    );
  };
  const message = (text, source = { kind: "user" }) =>
    api.llm.createUserMessage({ source, content: [{ type: "text", text }] });
  const follow = async (agent, text) => {
    agent.followup(message(text));
    await agent.whenIdle();
    return agent.session.snapshotEvents().findLast((event) => event.type === "turn/end")?.data
      .reason;
  };
  const durable = async (agent) => {
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(agent.id, "read");
    try {
      const log = await reader.read();
      assert.deepEqual(
        log.events,
        agent.session.snapshotEvents(),
        "Physical temporary JSONL must equal every committed event",
      );
      return log;
    } finally {
      await reader.close();
    }
  };
  const verify = async () => {
    for (const agent of agents) {
      const log = await durable(agent);
      for (const request of requests.filter((item) => item.sessionId === agent.id)) {
        const prefix = api.sessions.Session.create(
          agent.id,
          log.events.slice(0, request.cursor + 1),
          agent.session.header,
        );
        assert.deepEqual(
          prefix.deriveMessages(),
          request.messages,
          "Every complete request must reconstruct from the identical official JSONL prefix",
        );
        assert.deepEqual(prefix.requestHeader(), request.header);
      }
    }
    assert.deepEqual(errors, []);
    return {
      version: manifest.release.version,
      officialModules: [...modules.values()],
      sessions: agents.length,
      requests: requests.length,
      forbiddenCalls: [...forbiddenCalls],
    };
  };
  const enqueue = (agent, plan) => {
    const queue = plans.get(agent.id) ?? [];
    queue.push(plan);
    plans.set(agent.id, queue);
  };
  return {
    api,
    ctx,
    project,
    directory,
    homes,
    requests,
    fileReads,
    errors,
    forbiddenCalls,
    host: {
      kind: "desktop",
      version: manifest.release.version,
      supported: true,
      runtimeRoot: cleanRoot,
    },
    create,
    fork,
    message,
    follow,
    durable,
    verify,
    mount,
    dispose: (agent) => handles.get(agent.id).dispose(),
    writeProjectRule: (text) => put(join(project, "AGENTS.md"), text),
    readNext(agent, effect) {
      readEffects.set(agent.id, effect);
      enqueue(agent, { kind: "read", path: join(project, "AGENTS.md") });
    },
    blockNext(agent) {
      const started = Promise.withResolvers();
      enqueue(agent, { kind: "cancel", started });
      return started.promise;
    },
    onCleanup(callback) {
      beforeCleanup = callback;
    },
  };
}
