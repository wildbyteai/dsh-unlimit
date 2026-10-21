import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { DesktopRuntime } from "../../src/host/runtime.js";
import { officialReadRuntime } from "./official-packages.mjs";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const under = (root, path) => {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(".." + sep));
};

/** Real official tools, filesystem providers, policy, Sessions and preview service; no profile. */
export async function filePermissionsFixture(t, runtimeRoot, cache) {
  const forbidden = [];
  const deny = (name) => () => {
    forbidden.push(name);
    throw new Error(`File permissions fixture forbids ${name}`);
  };
  t.mock.method(net.Socket.prototype, "connect", deny("socket.connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket.listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("dgram.bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("dgram.send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  t.mock.method(globalThis, "fetch", deny("fetch"));
  syncBuiltinESMExports();

  let runtime, root, temporary, ctx, adapter;
  const fibers = [],
    scopes = [];
  const installedRoot = realpathSync(runtimeRoot);
  const manifest = JSON.parse(readFileSync(join(installedRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const inventory = new Map(manifest.files.map((row) => [row.path, row.sha256]));
  const requireHost = createRequire(join(installedRoot, "package.json"));
  const entryEvidence = [];
  const installedSnapshots = new Map();
  // Hash the known modified entry without importing or reading another plugin's backup.
  for (const short of ["dsh-tool-fs", "dsh-tool-bash", "dsh-tool-pwsh"]) {
    const name = `@deepseek-ai/${short}`;
    const filename = requireHost.resolve(name);
    const path = relative(installedRoot, filename);
    const actual = sha256(readFileSync(filename));
    installedSnapshots.set(filename, actual);
    entryEvidence.push({
      name,
      role: "installed-entry-inspection-only",
      path,
      sha256: actual,
      inventorySha256: inventory.get(path),
      matchesInventory: actual === inventory.get(path),
      executed: false,
    });
  }
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      adapter?.revert();
      for (const scope of scopes.reverse()) await scope.dispose();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx?.fiber.dispose();
    } finally {
      try {
        runtime?.dispose();
        if (root) rmSync(root, { recursive: true, force: true });
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        for (const [filename, digest] of installedSnapshots)
          assert.equal(sha256(readFileSync(filename)), digest, "installed entry remains unchanged");
        assert.deepEqual(forbidden, [], "no network, subprocess or profile call was attempted");
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    }
  };
  t.after(dispose);

  runtime = officialReadRuntime(installedRoot, cache);
  const names = {
    cordis: "@deepseek-ai/cordis",
    prompt: "@deepseek-ai/dsh-system-prompt",
    tools: "@deepseek-ai/dsh-tools",
    scope: "@deepseek-ai/dsh-scope",
    sessions: "@deepseek-ai/dsh-session",
    projections: "@deepseek-ai/dsh-session-projection",
    typert: "@deepseek-ai/dsh-typert-registry",
    agents: "@deepseek-ai/dsh-agent",
    sandbox: "@deepseek-ai/dsh-sandbox-policy",
    sandboxSeam: "@deepseek-ai/dsh-sandbox",
    fsContract: "@deepseek-ai/dsh-fs",
    fsLocal: "@deepseek-ai/dsh-fs-local",
    fs: "@deepseek-ai/dsh-fs-sandbox",
    observation: "@deepseek-ai/dsh-fs-observation-policy",
    directory: "@deepseek-ai/dsh-working-directory",
    approval: "@deepseek-ai/dsh-user-approval",
    fileTools: "@deepseek-ai/dsh-tool-fs",
    preview: "@deepseek-ai/dsh-api-workspace-files",
    terminals: "@deepseek-ai/dsh-terminal",
    terminalTools: "@deepseek-ai/dsh-tool-terminal",
  };
  const loaded = new Map();
  const loadOfficial = async (name) => {
    if (loaded.has(name)) return loaded.get(name);
    const loadedPath = requireHost.resolve(name);
    const archived = under(runtime.root, loadedPath);
    const path = relative(archived ? runtime.root : installedRoot, loadedPath);
    const digest = sha256(readFileSync(loadedPath));
    assert.equal(digest, inventory.get(path), `${name} official entry hash`);
    const result = await runtime.load(name);
    entryEvidence.push({
      name,
      role: "executed-official-entry",
      path,
      sha256: digest,
      inventorySha256: inventory.get(path),
      matchesInventory: true,
      source: archived ? "temporary-clean-runtime" : "inventory-verified-installed-dependency",
      executed: true,
    });
    loaded.set(name, result);
    return result;
  };
  const api = Object.fromEntries(
    await Promise.all(
      Object.entries(names).map(async ([key, name]) => [key, await loadOfficial(name)]),
    ),
  );
  // A /tmp sibling would be writable under workspace-write by design. Keep the
  // disposable outside-workspace case under the ignored project artifacts root.
  mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
  root = realpathSync(mkdtempSync(join(projectRoot, "artifacts/file-permissions-")));
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-files-temp-")));
  const workspace = join(root, "workspace"),
    outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  assert.ok(
    !under(realpathSync(tmpdir()), outside),
    "negative case must not be a writable temp root",
  );
  assert.ok(!under(realpathSync("/tmp"), outside), "negative case must not be under /tmp");
  ctx = new api.cordis.Context();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "required official service must be active");
    return fiber;
  };
  await mount({
    name: "synthetic-file-permissions-foundation",
    apply(scope) {
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new api.projections.SessionProjectionRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.typert.TypertRegistry(scope);
      new api.agents.AgentRegistry(scope);
      new api.tools.ToolRuntime(scope);
      new api.sandbox.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: workspace });
      new api.approval.ApprovalService(scope, { policy: "never" });
      const editor = new api.cordis.Service(scope, "configEditor");
      editor.entries = () => [];
      editor.configuration = deny("profile.configuration");
      editor.edit = deny("profile.edit");
      new api.cordis.Service(scope, "settings").write = deny("profile.settings.write");
    },
  });
  await mount(api.fs.SandboxedFileSystem, { cwd: workspace });
  await mount(api.directory.WorkingDirectoryService, { defaultDirectory: workspace });
  await mount(api.observation);
  await mount(api.fileTools, { read: true, write: true, edit: true, readImage: false });
  await mount(api.preview.WorkspaceFiles, {
    maxBytes: 1024,
    maxFileBytes: 1024,
    maxLines: 64,
    maxEntries: 64,
  });
  await mount(api.terminals.TerminalSessionService);
  await mount(api.terminalTools, { enableRunInBackground: false, maxResultBytes: 1024 });

  const settings = {
    enabled: false,
    fullAccess: true,
    autoApprove: false,
    permissionDefault: "",
  };
  adapter = new DesktopRuntime(
    ctx,
    {
      dispatch(action) {
        if (action === "settings.get") return { value: settings };
        if (action === "rules.list") return { items: [], activeId: null };
        assert.fail(`Unexpected fixture store action: ${action}`);
      },
    },
    runtime.host,
  );
  let counter = 0;
  const createAgent = async (suffix, mode) => {
    const id = `synthetic-file-permissions-${suffix}`;
    const session = ctx.sessions.create(id, { meta: { cwd: workspace } });
    if (mode) api.sandbox.setSandboxMode(session, mode);
    const agent = { id, session, options: {} };
    const scope = api.scope.createScope(ctx, agent);
    scopes.push(scope);
    agent.ctx = scope.ctx;
    await ctx.agents.register(agent);
    return agent;
  };
  const execute = (agent, name, args, signal = new AbortController().signal) =>
    ctx.tools.execute({
      name,
      arguments: args,
      agent,
      callId: `synthetic-file-call-${++counter}`,
      signal,
    });
  const text = (result) =>
    result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  const seed = (path, body) => {
    assert.ok(
      under(root, path) || under(temporary, path),
      "only synthetic fixture paths may be seeded",
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    return path;
  };
  const previewScope = async (agent) => {
    const lookup = ctx.typert.lookups.get("workspaceFileScope");
    assert.ok(lookup, "official Session-header lookup must be registered");
    const result = await lookup.resolve(agent.session.id);
    assert.deepEqual(result, { sessionId: agent.session.id, workspaceRoot: workspace });
    return result;
  };
  return {
    ctx,
    adapter,
    settings,
    api,
    loadOfficial,
    mount,
    root,
    workspace,
    outside,
    temporary,
    createAgent,
    execute,
    text,
    seed,
    previewScope,
    dispose,
    evidence() {
      const archive = readFileSync(join(cache, "dsh-tool-fs-0.2.1-rc.2.tgz"));
      return {
        hostVersion: manifest.release.version,
        inventorySha256: sha256(readFileSync(join(installedRoot, "desktop-runtime.json"))),
        sourceDigests: [
          "tests/file-permissions-host.test.mjs",
          "tests/helpers/file-permissions-fixture.mjs",
          "tests/helpers/official-packages.mjs",
          "src/host/runtime.js",
          "src/host/permission-defaults.js",
        ].map((path) => ({ path, sha256: sha256(readFileSync(join(projectRoot, path))) })),
        archive: {
          name: "dsh-tool-fs-0.2.1-rc.2.tgz",
          sha256: sha256(archive),
          integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
          checkedBy: "tests/helpers/official-packages.mjs",
        },
        entries: entryEvidence.sort((a, b) =>
          `${a.role}/${a.name}`.localeCompare(`${b.role}/${b.name}`),
        ),
        isolation: {
          syntheticInputsOnly: true,
          temporaryWorkspaceOutsidePlatformTempRoots: true,
          installedModifiedEntriesExecuted: false,
          installedEntriesUnchanged: [...installedSnapshots].every(
            ([filename, digest]) => sha256(readFileSync(filename)) === digest,
          ),
          temporaryRootsRemoved:
            !existsSync(root) && !existsSync(temporary) && !existsSync(runtime.root),
          profileLoaded: false,
          desktopInstalledOrReloaded: false,
          networkAttempts: forbidden.filter((name) => !name.startsWith("child_process.")),
          subprocessAttempts: forbidden.filter((name) => name.startsWith("child_process.")),
          filesystemProviderMocked: false,
          permissionResolverMocked: false,
          calls: counter,
        },
      };
    },
  };
}
