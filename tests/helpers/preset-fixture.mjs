import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DesktopRuntime } from "../../src/host/runtime.js";
import { officialReadRuntime } from "./official-packages.mjs";
import { createPtcProcessGuard } from "./ptc-process-guard.mjs";

export const presetProjectRoot = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const within = (base, path) => {
  const p = relative(base, path);
  return p === "" || (p !== ".." && !p.startsWith(".." + sep) && !isAbsolute(p));
};

/** A real complete declaration; only model responses and human answers are synthetic. */
export async function presetFixture(
  t,
  selectedRoot,
  cache,
  { permissionPresets = false, presetId = "standard", modelModalities, ptcExecution = false } = {},
) {
  assert.ok(["standard", "minimal", "ptc"].includes(presetId));
  assert.equal(ptcExecution, presetId === "ptc", "PTC is an explicit standalone execution probe");
  const marker = presetId.toUpperCase();
  const provider = `synthetic-${presetId}-offline`;
  const installedRoot = fs.realpathSync(selectedRoot);
  const inventoryBytes = fs.readFileSync(join(installedRoot, "desktop-runtime.json"));
  const inventory = new Map(JSON.parse(inventoryBytes).files.map((row) => [row.path, row.sha256]));
  const installed = [
    "dsh-tool-bash/lib/index.js",
    "dsh-tool-pwsh/lib/index.js",
    "dsh-tool-fs/lib/index.js",
    "dsh-agent-instructions/lib/index.js",
    "dsh-web-app/cordis.patch.yml",
  ].map((suffix) => {
    const path = `node_modules/@deepseek-ai/${suffix}`;
    return { path, sha256: digest(fs.readFileSync(join(installedRoot, path))) };
  });
  fs.mkdirSync(join(presetProjectRoot, "artifacts"), { recursive: true });
  const directory = fs.realpathSync(
    fs.mkdtempSync(join(presetProjectRoot, `artifacts/${presetId}-preset-`)),
  );
  const workspace = join(directory, "workspace");
  const homes = {
    DSH_HOME: join(directory, "dsh-home"),
    DSH_AGENTS_HOME: join(directory, "agents-home"),
    DSH_BUNDLED_SKILL_DIR: join(directory, "bundled-skills"),
  };
  const originalEnvironment = new Map(Object.keys(homes).map((key) => [key, process.env[key]]));
  const originalCwd = process.cwd();
  for (const path of [
    workspace,
    join(workspace, ".git"),
    join(workspace, ".dsh/skills"),
    join(workspace, ".agents/skills"),
    join(homes.DSH_HOME, "skills"),
    join(homes.DSH_AGENTS_HOME, "skills"),
    homes.DSH_BUNDLED_SKILL_DIR,
    join(directory, "home"),
  ])
    fs.mkdirSync(path, { recursive: true });
  const sourceFile = join(workspace, "evidence.txt");
  const content = `SYNTHETIC_COMPLETE_${marker}_PRESET_CONTENT`;
  fs.writeFileSync(sourceFile, content + "\n");
  fs.writeFileSync(join(workspace, "AGENTS.md"), `SYNTHETIC_${marker}_WORKSPACE_RULE\n`);
  for (const [key, value] of Object.entries(homes)) process.env[key] = value;
  process.chdir(workspace);
  t.mock.method(os, "homedir", () => join(directory, "home"));

  const forbidden = [];
  const sourceReads = [];
  const directoryFsyncFds = new Set();
  const deny = (name) => () => {
    forbidden.push(name);
    throw new Error(`${presetId} preset fixture forbids ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("dgram.bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("dgram.send"));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, key, deny(`child_process.${key}`));
  for (const [label, api] of [
    ["dns", dns],
    ["dns/promises", dnsPromises],
  ])
    for (const key of Object.keys(api))
      if (/^(lookup|resolve|reverse)/.test(key) && typeof api[key] === "function")
        t.mock.method(api, key, deny(`${label}.${key}`));
  syncBuiltinESMExports();

  let runtime, ctx, adapter, ptc;
  const handles = [],
    fibers = [],
    errors = [],
    requests = [],
    scripts = new Map(),
    permissionEntries = [],
    revisionBindings = [];
  let disposed = false;
  let officialLifecycleDisposed = false;
  let rootsRemovedUnderGuards = false;
  let cleaningRuntimeRoot = false;
  const cleanupErrors = [];
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const cleanup = async (name, action) => {
      try {
        await action();
      } catch (cause) {
        cleanupErrors.push(new Error(`Preset fixture cleanup failed: ${name}`, { cause }));
      }
    };
    try {
      await cleanup("adapter", () => adapter?.revert());
      for (const handle of handles)
        await cleanup("cancel", () => handle.agent.cancel({ kind: "user" }));
      await cleanup("idle", () => Promise.all(handles.map((handle) => handle.agent.whenIdle())));
      for (const handle of handles.reverse()) await cleanup("agent handle", () => handle.dispose());
      for (const fiber of fibers.reverse())
        if (fiber.uid !== null) await cleanup("fiber", () => fiber.dispose());
      await cleanup("context", () => ctx?.fiber.dispose());
      await cleanup("PTC processes", () => ptc?.verifyDisposed());
      officialLifecycleDisposed = cleanupErrors.length === 0;
      await cleanup("descriptors and installed entries", () => {
        assert.equal(directoryFsyncFds.size, 0, "All ancestor metadata handles must be closed");
        for (const row of installed)
          assert.equal(digest(fs.readFileSync(join(installedRoot, row.path))), row.sha256);
      });
    } finally {
      try {
        cleaningRuntimeRoot = true;
        await cleanup("runtime root", () => runtime?.dispose());
        await cleanup("synthetic root", () =>
          fs.rmSync(directory, { recursive: true, force: true }),
        );
        await cleanup("PTC import hook", () => ptc?.deregister());
        rootsRemovedUnderGuards =
          !fs.existsSync(directory) && !fs.existsSync(runtime?.root ?? directory);
        await cleanup("boundaries", () => {
          assert.deepEqual(forbidden, [], "No forbidden network, subprocess or filesystem access");
          assert.equal(rootsRemovedUnderGuards, true);
        });
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        process.chdir(originalCwd);
        for (const [key, value] of originalEnvironment)
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, "Preset fixture cleanup failed");
  };
  t.after(dispose);
  runtime = officialReadRuntime(installedRoot, cache, { presets: true });
  if (ptcExecution)
    ptc = createPtcProcessGuard(t, { installedRoot, runtime, workspace, forbidden });
  assert.ok(
    runtime.verifiedFiles instanceof Map,
    "Shared Loader must record every actual official import",
  );

  // The filesystem fence reads ancestor identities; attachment publication
  // fsyncs DSH_HOME ancestors. Permit exact metadata operations only.
  const ancestorMetadata = new Set();
  const platformMetadata = new Set();
  const metadataReads = [];
  if (permissionPresets || presetId === "minimal") {
    for (let ancestor = dirname(directory); ; ancestor = dirname(ancestor)) {
      ancestorMetadata.add(ancestor);
      if (dirname(ancestor) === ancestor) break;
    }
  }
  if (permissionPresets) {
    for (const path of ["/tmp", os.tmpdir()]) {
      platformMetadata.add(path);
      platformMetadata.add(fs.realpathSync(path));
    }
  }

  // Keep real filesystem implementations. The guard rejects access instead of synthesizing data.
  const checkPath = (path, writing, operation) => {
    const fd = typeof path === "number" ? path : path?.fd;
    if (typeof fd === "number") {
      if (!directoryFsyncFds.has(fd)) return;
      if (/^(?:fstat|fsync|close)(?:Sync)?$/.test(operation)) {
        metadataReads.push({
          operation: `directory-fd-${operation}`,
          scope: "synthetic-root-ancestor",
        });
        return;
      }
      forbidden.push(`filesystem.directory-fd.${operation}`);
      throw new Error(
        `Ancestor directory fd permits only fstat, fsync and close, not ${operation}`,
      );
    }
    const filename = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    if (
      !writing &&
      ptc?.metadataPaths.includes(filename) &&
      /^(?:stat|lstat|access|exists|realpath)(?:Sync)?(?:\.native)?$/.test(operation)
    ) {
      metadataReads.push({ operation, scope: "fixed-ptc-executable" });
      return;
    }
    if (writing && cleaningRuntimeRoot && operation === "rmSync" && filename === runtime.root)
      return;
    if (
      !writing &&
      (((operation === "open-directory-fsync" ||
        (permissionPresets && /^stat(?:Sync)?$/.test(operation))) &&
        ancestorMetadata.has(filename)) ||
        (/^(?:realpath(?:Sync)?(?:\.native)?|stat(?:Sync)?)$/.test(operation) &&
          platformMetadata.has(filename)))
    ) {
      metadataReads.push({
        operation,
        scope: platformMetadata.has(filename)
          ? "platform-temporary-root"
          : "synthetic-root-ancestor",
      });
      return;
    }
    if (
      within(directory, filename) ||
      (!writing && (within(installedRoot, filename) || within(runtime.root, filename)))
    )
      return;
    forbidden.push(`filesystem.${operation}`);
    throw new Error(
      `${presetId} preset fixture forbids filesystem.${operation} outside synthetic roots: ${filename}`,
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
  const guard = (api, key, writing, operation = key) => {
    const original = api[key];
    if (typeof original !== "function") return;
    t.mock.method(api, key, function (path, ...args) {
      const directoryFsync =
        presetId === "minimal" &&
        api === fsPromises &&
        key === "open" &&
        args[0] === fs.constants.O_RDONLY &&
        ancestorMetadata.has(resolve(path instanceof URL ? fileURLToPath(path) : String(path)));
      checkPath(
        path,
        writing === "open" ? writingFlags(args[0]) : writing,
        directoryFsync ? "open-directory-fsync" : operation,
      );
      if (/^(rename|copyFile)/.test(key)) checkPath(args[0], true, key);
      if (/^create(?:Read|Write)Stream$/.test(key) && args[0]?.fd !== undefined)
        checkPath(args[0].fd, writing, key);
      if (ptcExecution && path === sourceFile && /^readFile/.test(key))
        sourceReads.push({ operation: key, path: sourceFile });
      const result = Reflect.apply(original, this, [path, ...args]);
      if (!directoryFsync) return result;
      return result.then(async (handle) => {
        const fd = handle.fd;
        directoryFsyncFds.add(fd);
        // The real attachment store fsyncs each DSH_HOME ancestor. Its exact
        // read-only directory handles expose no content or mutation operations.
        for (const method of [
          "read",
          "readv",
          "readFile",
          "readLines",
          "readableWebStream",
          "createReadStream",
          "write",
          "writev",
          "writeFile",
          "appendFile",
          "truncate",
          "chmod",
          "chown",
          "utimes",
          "createWriteStream",
          "datasync",
        ])
          if (typeof handle[method] === "function")
            t.mock.method(handle, method, deny(`filesystem.directory-handle.${method}`));
        const stat = handle.stat;
        t.mock.method(handle, "stat", function (...args) {
          metadataReads.push({ operation: "directory-fstat", scope: "synthetic-root-ancestor" });
          return Reflect.apply(stat, this, args);
        });
        assert.ok((await handle.stat()).isDirectory());
        const sync = handle.sync;
        t.mock.method(handle, "sync", function (...args) {
          metadataReads.push({ operation: "directory-fsync", scope: "synthetic-root-ancestor" });
          return Reflect.apply(sync, this, args);
        });
        const close = handle.close;
        t.mock.method(handle, "close", async function (...args) {
          try {
            await Reflect.apply(close, this, args);
            metadataReads.push({ operation: "directory-close", scope: "synthetic-root-ancestor" });
          } finally {
            directoryFsyncFds.delete(fd);
          }
        });
        return handle;
      });
    });
  };
  for (const key of [
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
    for (const target of [key, `${key}Sync`]) guard(fs, target, false);
  for (const key of ["realpath", "realpathSync"]) guard(fs[key], "native", false, `${key}.native`);
  for (const key of [
    "writeFile",
    "appendFile",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
    "chmod",
  ])
    for (const target of [key, `${key}Sync`]) guard(fs, target, true);
  for (const key of ["open", "openSync"]) guard(fs, key, "open");
  for (const key of ["createReadStream", "watch", "watchFile"]) guard(fs, key, false);
  guard(fs, "createWriteStream", true);
  for (const key of [
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "realpath",
    "readlink",
    "opendir",
  ])
    guard(fsPromises, key, false);
  for (const key of [
    "writeFile",
    "appendFile",
    "mkdir",
    "rm",
    "rmdir",
    "unlink",
    "rename",
    "copyFile",
    "chmod",
  ])
    guard(fsPromises, key, true);
  guard(fsPromises, "open", "open");
  if (presetId === "minimal")
    for (const key of [
      "read",
      "readv",
      "write",
      "writev",
      "ftruncate",
      "fchmod",
      "fchown",
      "futimes",
      "fdatasync",
      "fsync",
      "fstat",
      "close",
    ])
      for (const target of [key, `${key}Sync`]) guard(fs, target, false);
  syncBuiltinESMExports();

  const modules = {
    cordis: "cordis",
    loader: "cordis-plugin-loader",
    include: "cordis-plugin-include",
    scope: "dsh-scope",
    prompt: "dsh-system-prompt",
    projections: "dsh-session-projection",
    sessions: "dsh-session",
    agents: "dsh-agent",
    llm: "dsh-llm",
    tools: "dsh-tools",
    loop: "dsh-agent-loop",
    typert: "dsh-typert-registry",
    sandboxPolicy: "dsh-sandbox-policy",
    approval: "dsh-user-approval",
    ...(permissionPresets ? { permission: "dsh-permission-presets" } : {}),
    fs: "dsh-fs-sandbox",
    observation: "dsh-fs-observation-policy",
    directory: "dsh-working-directory",
    persistence: "dsh-session-persistence-jsonl",
    storage: "dsh-storage",
    storageJson: "dsh-storage-json",
    domain: "dsh-storage-domain",
    commands: "dsh-commands",
    goals: "dsh-goal",
    skills: "dsh-skill",
    jobs: "dsh-jobs-local",
    tokenMeter: "dsh-token-meter",
    subagents: "dsh-subagent",
    spawn: "dsh-subagent-spawn-in-process",
    fork: "dsh-subagent-fork-in-process",
    ptc: "dsh-ptc-runtime-node",
    subprocess: "dsh-subprocess-local",
    sandbox: "dsh-sandbox-local",
    shell: "dsh-bash-sandbox",
    shellEnv: "dsh-shell-env",
    web: "dsh-web",
    questions: "dsh-user-questions",
    modelSelection: "dsh-tool-subagent/model-selection-settings",
    presets: "dsh-agent-preset-registry",
    schedule: "dsh-schedule",
    controller: "dsh-api-session-controller",
    workspace: "dsh-workspace",
    query: "dsh-session-query",
    attachments: "dsh-attachment-local",
    defaults: "dsh-agent-default-model",
    access: "dsh-api-remote-access",
    uploads: "dsh-client-file-upload",
    connection: "dsh-client-connection",
    credentials: "dsh-credentials-local",
  };
  const api = {};
  for (const [key, suffix] of Object.entries(modules))
    api[key] = await runtime.load(`@deepseek-ai/${suffix}`);
  const yaml = await runtime.load("js-yaml");
  ctx = new api.cordis.Context();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin.default ?? plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "Every required official Host service must be active");
    return fiber;
  };
  class OfflineAdapter extends api.llm.LlmAdapter {
    async resolveModel(provider, model, signal) {
      const info = await super.resolveModel(provider, model, signal);
      const inputModalities = modelModalities?.[model];
      return inputModalities === undefined
        ? info
        : { ...info, inputModalities: structuredClone(inputModalities) };
    }
    async *stream(request) {
      const agent = ctx.agents.get(request.sessionId);
      assert.ok(agent);
      assert.deepEqual(request.messages, agent.session.deriveMessages());
      const actions = scripts.get(agent.id);
      assert.ok(actions?.length, "Every model response is an explicit synthetic action");
      const action = actions.shift();
      requests.push({
        sessionId: agent.id,
        step: agent.phase.step,
        messages: structuredClone(request.messages),
        tools: structuredClone(request.tools),
        plan: structuredClone(
          presetId === "standard"
            ? ctx.agentPresets.serviceFor(agent, "planMode").get(agent)
            : ctx.agentPresets.serviceFor(agent, "planMode")?.get(agent),
        ),
      });
      const requestOrdinal = requests.length;
      // A held response pauses only this synthetic model transport. The real
      // AgentLoop, activation admission and teardown remain unchanged.
      if (action?.kind === "hold") await action.wait(request);
      if (action === "finish" || (action?.kind === "hold" && action.calls === undefined))
        yield { type: "text-delta", index: 0, text: `SYNTHETIC_${marker}_COMPLETE` };
      else
        for (const [index, call] of (action?.kind === "hold" ? action.calls : action).entries())
          yield {
            type: "tool-call-delta",
            index,
            id: `${agent.id}-${requestOrdinal}-${index}`,
            name: call.name,
            argumentsDelta: JSON.stringify(call.arguments),
          };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  await mount({
    name: `synthetic-${presetId}-foundation`,
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        personaPrefix: "",
        personaSuffix: "",
        includeHarnessIdentity: true,
        includeRuntimeContext: true,
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.agents.AgentRegistry(scope);
      new api.typert.TypertRegistry(scope);
      new api.llm.LlmRuntime(scope);
      scope.llm.registerAdapter([provider], new OfflineAdapter());
      scope.on("agent/error", ({ error }) => errors.push(error));
      if (permissionPresets) {
        // An in-memory configuration directory points to the actual official
        // permission fiber. It provides no profile read/write implementation.
        const editor = new api.cordis.Service(scope, "configEditor");
        editor.entries = () => permissionEntries;
        editor.configuration = deny("profile.configuration");
        editor.edit = deny("profile.edit");
      }
    },
  });
  await mount(api.tools);
  await mount(api.sandboxPolicy, { mode: "read-only", workspaceRoot: workspace });
  await mount(api.approval, { policy: "ask" });
  await mount(api.fs, { cwd: workspace });
  await mount(api.directory, { defaultDirectory: workspace });
  await mount(api.observation);
  await mount(api.persistence, {
    root: join(directory, "logs"),
    compression: "none",
    listConcurrency: 1,
  });
  await mount(api.storage);
  await mount(api.storageJson, { root: join(directory, "storage") });
  await mount(api.domain, { backend: "json", routes: {} });
  await mount(api.commands);
  await mount(api.goals);
  await mount(api.skills);
  await mount(api.jobs);
  await mount(api.tokenMeter);
  await mount(api.subprocess);
  await mount(api.sandbox);
  await mount(api.shell, { timeoutMs: 1000 });
  await mount(api.shellEnv, { dshHome: homes.DSH_HOME });
  if (permissionPresets) {
    const permissionFiber = await mount(api.permission, { defaultPreset: "workspace-write" });
    permissionEntries.push({
      options: { name: "@deepseek-ai/dsh-permission-presets" },
      fiber: permissionFiber,
    });
  }
  await mount(api.ptc, ptc?.config);
  ptc?.bind(ctx);
  await mount(api.subagents);
  await mount(api.spawn, { providerName: "spawn" });
  await mount(api.fork, { providerName: "fork" });
  await mount(api.web);
  await mount(api.questions);
  await mount(api.modelSelection);
  await mount(api.loop, { agents: [], maxParallelToolCalls: 1 });
  await mount(api.loader, { baseUrl: pathToFileURL(join(runtime.root, "package.json")).href });
  ctx.loader.builtins.group = api.loader.Group;
  await mount(api.presets, { default: presetId });
  await mount(api.defaults, { provider, model: "synthetic-model" });
  await mount(api.attachments, { dshHome: homes.DSH_HOME });
  await mount(api.access);
  await mount(api.credentials, {
    path: join(homes.DSH_HOME, "synthetic.credentials.yaml"),
    watch: false,
  });
  await mount(api.connection);
  await mount(api.uploads);
  await mount(api.workspace);
  await mount(api.query);
  await mount(api.controller, { nativeOpen: false, listWorkSliceMs: 16 });
  await mount(api.schedule);

  const patchPath = `node_modules/@deepseek-ai/dsh-web-app/presets/${presetId}.patch.yml`;
  const patchBytes = fs.readFileSync(join(runtime.root, patchPath));
  assert.equal(digest(patchBytes), inventory.get(patchPath));
  const patches = yaml.load(patchBytes.toString("utf8"), { schema: api.include.entryListSchema });
  const warnings = [];
  const rows = api.include.applyEntryPatches([], patches, (...args) => warnings.push(args));
  assert.deepEqual(warnings, []);
  assert.equal(rows.length, 1);
  const definition = structuredClone(rows[0].config);
  await ctx.loader.root.update(rows);
  await ctx.loader.await();
  assert.deepEqual(await ctx.agentPresets.resolve(presetId), { id: presetId });
  const composition = (await ctx.agentPresets.compositionInventory()).find(
    (row) => row.id === presetId,
  );
  assert.ok(composition);
  assert.equal(composition.broken, undefined);
  const declaredRows = [];
  const flatten = (plugins) => {
    for (const row of plugins)
      if (row.group) flatten(row.config);
      else declaredRows.push({ entryId: row.id, moduleName: row.name });
  };
  flatten(definition.plugins);
  const ordered = (rows) => rows.toSorted((a, b) => a.entryId.localeCompare(b.entryId));
  assert.deepEqual(
    ordered(composition.rows.map(({ entryId, moduleName }) => ({ entryId, moduleName }))),
    ordered(declaredRows),
    "Every shipped declaration row must occur in the actual retained revision",
  );
  for (const row of composition.rows)
    if (row.enabled) assert.equal(row.fiberState, 2, `${row.entryId} must be active`);
  for (const row of composition.rows) {
    const disabled =
      presetId !== "minimal"
        ? row.entryId === "tool-plugin-manager" ||
          row.entryId === "tool-plugin-market" ||
          (presetId === "ptc" && ["workflow-ptc", "tool-workflow"].includes(row.entryId)) ||
          row.entryId === (process.platform === "win32" ? "tool-bash" : "tool-pwsh")
        : ["terminal", "persistent"].some(
            (prefix) =>
              row.entryId === `${prefix}-${process.platform === "win32" ? "bash" : "pwsh"}`,
          );
    assert.equal(
      row.enabled,
      !disabled,
      `The original declaration controls ${row.entryId} enablement`,
    );
  }

  const settings = {
    enabled: true,
    prompt: `SYNTHETIC_${marker}_REPLACE_MARKER`,
    promptMode: "replace",
    workspacePolicy: "strict",
    workspaceFiles: [],
    fullAccess: false,
    autoApprove: false,
    permissionDefault: "",
    maxDepth: 1,
    maxSubagents: 8,
  };
  adapter = new DesktopRuntime(
    ctx,
    {
      dispatch(action) {
        if (action === "settings.get") return { value: settings };
        if (action === "rules.list") return { items: [], activeId: null };
        throw new Error(`Unexpected synthetic store action: ${action}`);
      },
    },
    runtime.host,
  );
  adapter.apply();
  const create = async (suffix, actions, { model = "synthetic-model" } = {}) => {
    const handle = await ctx.agents.create({
      sessionId: `synthetic-${presetId}-${suffix}`,
      meta: { cwd: workspace, agentPreset: presetId },
      agentOptions: {
        provider,
        model,
        maxTokens: 128,
      },
      setup: async (agentCtx) => {
        await ctx.agentPresets.mount(agentCtx, presetId);
      },
    });
    handles.push(handle);
    scripts.set(handle.agent.id, actions);
    assert.equal(ctx.agentPresets.composedPreset(handle.agent.ctx), presetId);
    const joined = ctx.agentPresets.inspectCompositions(handle.agent.ctx);
    assert.equal(joined.length, 1);
    assert.equal(joined[0].id, presetId);
    assert.deepEqual(joined[0].leakedServices, []);
    const revision = await ctx.agentPresets.acquireScope(presetId);
    try {
      assert.equal(
        api.scope.scopeParentOf(api.scope.scopeOf(handle.agent.ctx)),
        revision.key,
        "The Agent must join the exact retained official revision scope, by object identity",
      );
    } finally {
      await revision[Symbol.asyncDispose]();
    }
    assert.deepEqual(
      joined[0].modules.map((row) => row.moduleName).sort(),
      composition.rows
        .filter((row) => row.enabled)
        .map((row) => row.moduleName)
        .sort(),
    );
    revisionBindings.push({
      sessionId: handle.agent.id,
      presetId,
      exactRetainedScopeIdentity: true,
      modules: joined[0].modules.map(({ moduleName, useHostBase }) => ({
        moduleName,
        useHostBase,
      })),
      leakedServices: [],
    });
    return handle.agent;
  };
  const run = async (agent) => {
    agent.followup(
      api.llm.createUserMessage({
        source: { kind: "user" },
        content: [{ type: "text", text: "SYNTHETIC_EXPLICIT_DISPOSABLE_TASK" }],
      }),
    );
    await agent.whenIdle();
    assert.equal(agent.status, "idle");
    assert.deepEqual(scripts.get(agent.id), []);
    assert.equal(
      agent.session.snapshotEvents().findLast((event) => event.type === "turn/end")?.data.reason
        .kind,
      "completed",
    );
    await ctx.sessionPersistence.flush();
    const reader = await ctx.sessionPersistence.open(agent.id, "read");
    try {
      assert.deepEqual((await reader.read()).events, agent.session.snapshotEvents());
    } finally {
      await reader.close();
    }
  };
  const assemble = (agent) =>
    ctx.systemPrompt.assemble({ agent, scope: api.scope.scopeOf(agent.ctx) });
  const unadaptedAssembly = async (agent) => {
    const enabled = adapter.enabled;
    if (enabled) adapter.revert();
    try {
      return await assemble(agent);
    } finally {
      if (enabled) adapter.apply();
    }
  };
  return {
    ctx,
    runtime,
    api,
    adapter,
    settings,
    requests,
    errors,
    composition,
    definition,
    patchPath,
    patchSha256: digest(patchBytes),
    directory,
    workspace,
    sourceFile,
    content,
    create,
    script: (sessionId, actions) => scripts.set(sessionId, actions),
    run,
    assemble,
    unadaptedAssembly,
    dispose,
    ptc,
    evidence: () => ({
      inventorySha256: digest(inventoryBytes),
      patch: { path: patchPath, sha256: digest(patchBytes) },
      composition: {
        id: composition.id,
        isDefault: composition.isDefault,
        rows: composition.rows.map(({ entryId, moduleName, enabled, fiberState }) => ({
          entryId,
          moduleName,
          enabled,
          ...(fiberState === undefined ? {} : { fiberState }),
        })),
      },
      revisionBindings: structuredClone(revisionBindings),
      officialFiles: [...runtime.verifiedFiles].map(([path, sha256]) => ({ path, sha256 })),
      installedEntries: installed.map((row) => ({
        ...row,
        inventorySha256: inventory.get(row.path),
        executed: false,
        unchanged: true,
      })),
      isolation: {
        realProfileLoaded: false,
        realCredentialsRead: false,
        networkAttempts: forbidden.filter(
          (x) => !x.startsWith("child_process.") && !x.startsWith("filesystem."),
        ),
        filesystemAttempts: forbidden.filter((x) => x.startsWith("filesystem.")),
        subprocessAttempts: forbidden.filter((x) => x.startsWith("child_process.")),
        rootsRemoved: !fs.existsSync(directory) && !fs.existsSync(runtime.root),
        filesystemReadsReal: true,
        filesystemBoundaryGuards: true,
        guardsHeldThroughOfficialLifecycle: officialLifecycleDisposed,
        guardsHeldThroughTemporaryRootCleanup: rootsRemovedUnderGuards,
        cleanupErrors: cleanupErrors.map((error) => error.message),
        ...(permissionPresets || presetId === "minimal"
          ? {
              metadataOnlyReads: {
                purpose:
                  presetId === "minimal"
                    ? "Actual attachment durability directory fsync"
                    : "Official filesystem containment identity checks and canonical temporary roots",
                scope: permissionPresets
                  ? "Exact synthetic-root ancestors and platform temporary-root paths only"
                  : "Exact synthetic-root ancestors only; O_RDONLY directory handles deny content and mutation",
                operations: metadataReads.reduce((counts, row) => {
                  const key = `${row.scope}:${row.operation}`;
                  counts[key] = (counts[key] ?? 0) + 1;
                  return counts;
                }, {}),
                ancestorEnumerationContentReadsOrWritesAllowed: false,
                remainingDirectoryMetadataHandles: directoryFsyncFds.size,
              },
            }
          : {}),
        syntheticModelAdapter: true,
        ...(ptc
          ? {
              ptcBackend: ptc.evidence(),
              syntheticSourceReads: structuredClone(sourceReads),
              executableMetadataReads: structuredClone(metadataReads),
            }
          : {}),
      },
    }),
  };
}
