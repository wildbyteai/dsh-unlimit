import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createDraftBridge } from "../src/client-entry.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated official client tests; no profile or running desktop is opened",
  timeout: 10000,
};

/** Load intact official client factories and their real static modules, not copied implementations. */
async function officialClient() {
  const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  assert.equal(descriptor.release.version, "0.2.1-rc.2");
  const evidence = [];
  const verified = (filename) => {
    const path = relative(runtimeRoot, filename);
    const entry = descriptor.files.find((item) => item.path === path);
    assert.ok(entry, `${path} must be in the official inventory`);
    const bytes = readFileSync(filename);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, entry.sha256, `${path} differs from the official inventory`);
    evidence.push({ path, sha256 });
    return bytes.toString("utf8");
  };
  const storage = new Map();
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const networkCalls = [];
  const noNetwork = () => {
    networkCalls.push("forbidden");
    throw new Error("Network is forbidden in isolated client tests");
  };
  const globals = {
    AbortController,
    AbortSignal,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    performance,
    crypto: webcrypto,
    localStorage,
    fetch: noNetwork,
    WebSocket: class {
      constructor() {
        noNetwork();
      }
    },
  };
  const element = () => ({
    dataset: {},
    style: { setProperty() {} },
    relList: { supports: () => true },
    append(...children) {
      for (const child of children) child.parentElement = this;
    },
    replaceChildren() {},
    setAttribute() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll: () => [],
  });
  const root = element();
  const document = {
    compatMode: "CSS1Compat",
    createElement: element,
    getElementById: () => root,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: element(),
    body: element(),
    head: element(),
  };
  let staticModules;
  const bootErrors = [];
  const captureError = "SYNTHETIC_STATIC_MODULE_BOUNDARY";
  const frontend = vm.createContext({
    ...globals,
    document,
    navigator: { userAgent: "Synthetic headless test" },
    console: { ...console, error: (error) => bootErrors.push(error.message) },
    addEventListener() {},
    removeEventListener() {},
    __ModuleLoader__: {
      create(options) {
        staticModules = options.staticModules;
        throw new Error(captureError);
      },
    },
  });
  frontend.window = frontend;
  const indexEntries = descriptor.files.filter((item) =>
    /dsh-web-frontend\/dist\/assets\/index-[^/]+\.js$/.test(item.path),
  );
  assert.equal(indexEntries.length, 1, "The validated frontend must have one index entry");
  const indexPath = join(runtimeRoot, indexEntries[0].path);
  let indexSource = verified(indexPath);
  const importRow = /import\{([^}]+)\}from"(\.\/vendor-[^"]+)";/.exec(indexSource);
  assert.ok(importRow, "Expected the official frontend's static vendor import");
  let vendorSource = verified(join(dirname(indexPath), importRow[2]));
  let exportCount = 0;
  // Only lower ESM edges for vm.Script. No official classes, methods or private exports are rewritten.
  vendorSource = vendorSource.replace(/export\{([^}]+)\};/, (_, names) => {
    exportCount++;
    return `globalThis.vendor={${names
      .split(",")
      .map((name) => {
        const [local, alias] = name.trim().split(/\s+as\s+/);
        return `${alias}:${local}`;
      })
      .join(",")}};`;
  });
  assert.equal(exportCount, 1);
  vm.runInContext(`(()=>{${vendorSource}\n})()`, frontend, {
    filename: "verified-official-vendor.js",
  });
  indexSource = indexSource
    .replace(
      importRow[0],
      `const {${importRow[1]
        .split(",")
        .map((name) => name.trim().replace(/\s+as\s+/, ":"))
        .join(",")}}=vendor;`,
    )
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(indexPath).href));
  vm.runInContext(`(()=>{${indexSource}\n})()`, frontend, {
    filename: "verified-official-frontend.js",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    staticModules?.["@deepseek-ai/cordis"],
    "Capture the public ModuleLoader.create staticModules seam before any application composition",
  );
  assert.deepEqual(
    bootErrors,
    [captureError],
    "Boot stops before loading a manifest, profile or transport",
  );
  const require = createRequire(join(runtimeRoot, "package.json"));
  const factories = new Map();
  const loaded = new Map(Object.entries(staticModules));
  // No document in this realm: the official bundled Lexical editor runs headlessly.
  const clientRealm = vm.createContext({
    ...globals,
    console,
    window: {
      __ModuleLoader__: {
        load(row) {
          factories.set(row.id, row.factory);
        },
      },
    },
  });
  const load = (name) => {
    if (loaded.has(name)) return loaded.get(name);
    let filename;
    if (name === "@deepseek-ai/dsh-api-gateway/client") {
      const manifestPath = require.resolve("@deepseek-ai/dsh-api-gateway/package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      filename = join(dirname(manifestPath), manifest.exports["./client"].browser);
    } else filename = require.resolve(name.endsWith("/client") ? name : `${name}/client`);
    vm.runInContext(verified(filename), clientRealm, { filename: relative(runtimeRoot, filename) });
    const id = name.replace(/\/client$/, "");
    assert.ok(factories.has(id), `Official factory ${id} must register itself`);
    const value = factories.get(id)(load);
    loaded.set(name, value);
    loaded.set(id, value);
    return value;
  };
  return {
    sessionsApi: load("@deepseek-ai/dsh-api-session-controller"),
    conversationApi: load("@deepseek-ai/dsh-client-ui-conversation"),
    workspaceApi: load("@deepseek-ai/dsh-client-ui-workspace"),
    gateway: load("@deepseek-ai/dsh-api-gateway/client"),
    staticModules,
    networkCalls,
    evidence,
    storage,
  };
}

async function fixture(t) {
  const official = await officialClient();
  const { Context, Service } = official.staticModules["@deepseek-ai/cordis"];
  const { createSnapshotStore } = official.staticModules["@deepseek-ai/dsh-client-store"];
  const ctx = new Context();
  const handlers = new Map(),
    gates = new Map();
  const promptCalls = [],
    panels = [];
  let navigationFailure = false,
    connection;
  const stop = () => () => {};
  const provide = (inner, name, value) => Object.assign(new Service(inner, name), value);
  const remote = {
    $on(name, listener) {
      handlers.set(name, listener);
      return () => handlers.delete(name);
    },
    $stream: (options) => new official.gateway.RemoteStream(connection, options),
    session: {
      async *follow({ address }, signal) {
        const gate = gates.get(address.sessionId);
        if (gate)
          await Promise.race([
            gate.promise,
            new Promise((resolve) =>
              signal.aborted
                ? resolve()
                : signal.addEventListener("abort", resolve, { once: true }),
            ),
          ]);
        if (signal.aborted) return;
        yield {
          type: "snapshot",
          records: [],
          cursor: -1,
          hasMore: false,
          assistantStream: { revision: 0 },
          projections: { asOfSeq: -1, values: {} },
        };
        await new Promise((resolve) =>
          signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      prompt(value) {
        promptCalls.push(value);
        assert.fail("No prompt is submitted in client bridge tests");
      },
    },
    commands: {},
    subagents: {},
    directoryPicker: {},
  };
  const fibers = [];
  const foundation = ctx.plugin({
    name: "synthetic-client-foundation",
    apply(inner) {
      connection = provide(inner, "connection", { generation: createSnapshotStore(undefined) });
      provide(inner, "remote", remote);
      for (const name of ["session", "commands", "subagents", "directoryPicker"])
        inner.reflect.provide(`remote.${name}`, remote[name]);
      provide(inner, "fileUpload", {});
      provide(inner, "typert", { contexts: { registerClient: stop } });
      // These are inert presentation/peripheral services. Session objects, projections,
      // input shells, lexical draft editor, references and workspace navigation are official.
      provide(inner, "slots", {
        register: stop,
        registerFactory: stop,
        inject: stop,
        subscribe: stop,
        provideRoot: stop,
        entries: () => [],
      });
      provide(inner, "locale", { register: stop, bind: () => (key) => key, subscribe: stop });
      provide(inner, "uiSession", { provide: stop });
      provide(inner, "configForms", {
        get: () => undefined,
        developerTools: { enabled: createSnapshotStore(false) },
      });
      provide(inner, "layout", {
        selectPanel(value) {
          panels.push(value);
          if (navigationFailure) throw new Error("Synthetic layout failure");
        },
        beginNavigation: () => new AbortController().signal,
      });
      provide(inner, "shortcuts", {
        register: stop,
        registerFixed: stop,
        describeBinding: () => ({ keys: [] }),
      });
      provide(inner, "remoteAccess", {});
      provide(inner, "workspaces", {
        list: createSnapshotStore({ phase: "pending", items: [], archivedSessionIds: [] }),
      });
    },
  });
  fibers.push(foundation);
  t.after(async () => {
    try {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await ctx.fiber.dispose();
    } finally {
      official.storage.clear();
    }
    assert.equal(official.networkCalls.length, 0);
    assert.equal(promptCalls.length, 0);
  });
  await foundation.await();
  for (const [name, api, config] of [
    ["sessions", official.sessionsApi],
    ["workspace", official.workspaceApi],
    ["conversation", official.conversationApi, { maxConcurrentFileUploads: 2 }],
  ]) {
    const fiber = ctx.plugin({
      name: `synthetic-official-${name}`,
      inject: api.inject,
      apply: (inner) => api.apply(inner, config),
    });
    fibers.push(fiber);
    await fiber.await();
  }
  const sessions = ctx.get("sessions"),
    conversation = ctx.get("conversation"),
    workspace = ctx.get("uiWorkspace");
  assert.ok(sessions && conversation && workspace);
  const announce = (id) =>
    handlers.get("api-session/added")({
      sessionId: id,
      updatedAt: 0,
      createdAt: 0,
      running: false,
      blank: true,
    });
  const replies = [];
  const frame = { contentWindow: { postMessage: (value) => replies.push(value) } };
  const bridge = createDraftBridge(ctx, { origin: "http://127.0.0.1:4177", getFrame: () => frame });
  t.after(() => bridge.dispose());
  const event = (id, draft = "Synthetic restored text") => ({
    origin: "http://127.0.0.1:4177",
    source: frame.contentWindow,
    data: {
      type: "dsh-unlimit:draft-bridge-request",
      id: `restore-${id}`,
      operation: "restore",
      payload: { newSessionId: id, draft },
    },
  });
  return {
    official,
    ctx,
    sessions,
    conversation,
    workspace,
    bridge,
    event,
    replies,
    announce,
    gates,
    panels,
    failNavigation() {
      navigationFailure = true;
    },
  };
}

test(
  "verified official client restores through real binding/input projection and mainView retains it after using releases",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    assert.equal(
      f.official.evidence.length,
      6,
      "Frontend/vendor, Session Controller, gateway browser, Conversation and Workspace client entries are hashed",
    );
    f.announce("synthetic-restored");
    await f.bridge.handleMessage(f.event("synthetic-restored"));
    assert.equal(f.replies[0].ok, true);
    assert.equal(f.replies[0].draftStatus, "restored");
    assert.equal(f.replies[0].openStatus, "requested");
    assert.equal(f.replies[0].navigationConfirmed, false);
    const binding = f.sessions.binding("synthetic-restored");
    assert.ok(binding, "Official navigation retains the exact Session binding");
    assert.equal(
      f.conversation.input.for(binding.ctx).state.getSnapshot().draft,
      "Synthetic restored text",
    );
    const retained = f.sessions.retainInfo("synthetic-restored").getSnapshot();
    assert.equal(retained.referenceCount, 1);
    assert.equal(retained.retainedBy.mainView, 1);
    assert.equal(retained.retainedBy.controllerOperation, undefined);
    assert.deepEqual(f.panels, [null]);
  },
);

test(
  "official existing draft and attachment-only input are preserved without opening or overwriting",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    for (const [id, text, attachments] of [
      ["synthetic-existing", "Keep existing text", []],
      ["synthetic-attachments", "", ["synthetic-attachment-id"]],
    ]) {
      f.announce(id);
      const reference = f.sessions.retain(id, { source: "syntheticTest" });
      t.after(() => reference.release());
      const binding = await reference.ready;
      const input = f.conversation.input.for(binding.ctx);
      input.actions.setDraft(text);
      input.actions.addAttachments(attachments);
      await f.bridge.handleMessage(f.event(id));
      const result = f.replies.at(-1);
      assert.equal(result.ok, false);
      assert.equal(result.draftStatus, "preserved");
      assert.equal(result.openStatus, "not-requested");
      assert.equal(input.state.getSnapshot().draft, text);
      assert.deepEqual([...input.state.getSnapshot().attachmentIds], attachments);
    }
    assert.equal(f.panels.length, 0);
  },
);

test(
  "official reference cancellation prevents late draft creation and releases the pending retained scope",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const id = "synthetic-cancelled";
    f.announce(id);
    const gate = Promise.withResolvers();
    f.gates.set(id, gate);
    const operation = f.bridge.handleMessage(f.event(id));
    await new Promise((resolve) => setImmediate(resolve));
    f.bridge.cancelAll("Synthetic panel closed");
    await operation;
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.replies[0].draftStatus, "cancelled");
    assert.equal(f.sessions.retainInfo(id).getSnapshot().referenceCount, 0);
    assert.equal(f.panels.length, 0);
    f.gates.delete(id);
    const reference = f.sessions.retain(id, { source: "syntheticTest" });
    t.after(() => reference.release());
    const binding = await reference.ready;
    assert.equal(f.conversation.input.for(binding.ctx).state.getSnapshot().draft, "");
  },
);

test(
  "official navigation partial failure reports restored text separately from the failed open request",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const id = "synthetic-open-failure";
    f.announce(id);
    f.failNavigation();
    await f.bridge.handleMessage(f.event(id));
    assert.equal(f.replies[0].ok, false);
    assert.equal(f.replies[0].draftStatus, "restored");
    assert.equal(f.replies[0].openStatus, "failed");
    const binding = f.sessions.binding(id);
    assert.equal(
      f.conversation.input.for(binding.ctx).state.getSnapshot().draft,
      "Synthetic restored text",
    );
  },
);
