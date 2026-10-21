import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import net from "node:net";
import dgram from "node:dgram";
import childProcess from "node:child_process";
import { DesktopSessions } from "../../src/host/sessions.js";
import { DesktopRuntime } from "../../src/host/runtime.js";
import { WorkspaceStore } from "../../src/core/store.js";

export const targets = [
  { id: "deepseek-official", api: "deepseek native messages", model: "deepseek-flash" },
  {
    id: "synthetic-chat",
    api: "openai-completions",
    endpoint: "chat",
    model: "synthetic-chat-model",
  },
  {
    id: "synthetic-responses",
    api: "openai-responses",
    endpoint: "responses",
    model: "synthetic-responses-model",
  },
  {
    id: "synthetic-messages",
    api: "anthropic-messages",
    endpoint: "messages",
    model: "synthetic-messages-model",
  },
];

export async function rewindProtocolFixture(
  t,
  runtimeRoot,
  target,
  { retry = false, unloadableRuntime = false } = {},
) {
  const forbiddenCalls = [];
  const deny = (name) =>
    function () {
      forbiddenCalls.push(name);
      throw new Error(`Isolated rewind protocol test forbids ${name}`);
    };
  t.mock.method(net.Socket.prototype, "connect", deny("socket connect"));
  t.mock.method(net.Server.prototype, "listen", deny("socket listen"));
  t.mock.method(dgram.Socket.prototype, "bind", deny("datagram bind"));
  t.mock.method(dgram.Socket.prototype, "send", deny("datagram send"));
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, deny(`child_process.${name}`));
  syncBuiltinESMExports();
  let cleanup = async () => {};
  t.after(async () => {
    try {
      await cleanup();
      assert.deepEqual(
        forbiddenCalls,
        [],
        "No socket, child process or out-of-fixture filesystem access may even be attempted",
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
  const root = realpathSync(runtimeRoot);
  const manifest = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
  assert.equal(manifest.release.version, "0.2.1-rc.2");
  const require = createRequire(join(root, "package.json"));
  const modules = [];
  const load = async (name) => {
    let filename;
    if (name.startsWith("@earendil-works/pi-ai/api/")) {
      const packageFile = join(root, "node_modules/@earendil-works/pi-ai/package.json");
      const declaration = JSON.parse(readFileSync(packageFile, "utf8"));
      filename = resolve(
        dirname(packageFile),
        declaration.exports["./api/*"].import.replace("*", name.split("/").at(-1)),
      );
    } else filename = require.resolve(name);
    const row = manifest.files.find((item) => item.path === relative(root, filename));
    assert.ok(row, `Official release inventory must include ${name}`);
    const digest = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(digest, row.sha256, `Refusing modified official entry: ${name}`);
    modules.push({ name, entrySha256: digest, matchesManifest: true });
    return import(pathToFileURL(filename).href);
  };
  const names = {
    cordis: "@deepseek-ai/cordis",
    storage: "@deepseek-ai/dsh-storage",
    jsonStorage: "@deepseek-ai/dsh-storage-json",
    domain: "@deepseek-ai/dsh-storage-domain",
    persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
    sessions: "@deepseek-ai/dsh-session",
    fork: "@deepseek-ai/dsh-session/fork",
    projections: "@deepseek-ai/dsh-session-projection",
    query: "@deepseek-ai/dsh-session-query",
    workspaces: "@deepseek-ai/dsh-workspace",
    agents: "@deepseek-ai/dsh-agent",
    loop: "@deepseek-ai/dsh-agent-loop",
    prompt: "@deepseek-ai/dsh-system-prompt",
    tools: "@deepseek-ai/dsh-tools",
    typert: "@deepseek-ai/dsh-typert-registry",
    controller: "@deepseek-ai/dsh-api-session-controller",
    llm: "@deepseek-ai/dsh-llm",
    approval: "@deepseek-ai/dsh-user-approval",
    sandbox: "@deepseek-ai/dsh-sandbox-policy",
    deepseek: "@deepseek-ai/dsh-llm-deepseek",
    pi: "@deepseek-ai/dsh-llm-pi-ai",
  };
  const api = Object.fromEntries(
    await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])),
  );
  if (retry) api.retry = await load("@deepseek-ai/dsh-llm-retry");
  for (const name of [
    "openai-completions.lazy",
    "openai-responses.lazy",
    "anthropic-messages.lazy",
    "openai-completions",
    "openai-responses",
    "openai-responses-shared",
    "anthropic-messages",
  ])
    await load(`@earendil-works/pi-ai/api/${name}`);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-rewind-protocol-")));
  const ctx = new api.cordis.Context();
  const fibers = [];
  const store = new WorkspaceStore(join(directory, "plugin-synthetic.sqlite"));
  const workspaceId = store.dispatch("workspaces.save", {
    name: "Synthetic rewind protocol workspace",
  }).item.id;
  const settings = {
    enabled: true,
    prompt: "",
    promptMode: "replace",
    workspacePolicy: "fallback",
    workspaceFiles: [],
    autoApprove: false,
    fullAccess: false,
    maxSubagents: 3,
    maxDepth: 3,
  };
  const runtimeStore = {
    dispatch(action, payload) {
      if (action === "settings.get") return { value: settings };
      if (action === "rules.list") return { items: [], activeId: null };
      return store.dispatch(action, payload);
    },
  };
  let runtime;
  let desktop;
  cleanup = async () => {
    try {
      desktop?.close();
      runtime?.revert();
      for (const fiber of fibers.reverse()) if (fiber.uid !== null) await fiber.dispose();
      await ctx.fiber.dispose();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
  // After importing official modules, constrain their filesystem entry points.
  // Runtime source may be read; every write and persistence path must stay in
  // this disposable fixture. Home/profile access is therefore denied too.
  const within = (base, path) => {
    const child = relative(base, path);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  };
  const checkPath = (path, writing, operation) => {
    if (typeof path === "number") return; // Already-open descriptors owned by the fixture.
    const filename = resolve(path instanceof URL ? fileURLToPath(path) : String(path));
    if (within(directory, filename) || (!writing && within(root, filename))) return;
    forbiddenCalls.push(`filesystem.${operation}`);
    throw new Error(
      `Isolated rewind protocol test forbids filesystem.${operation} outside its fixture/runtime`,
    );
  };
  const writeFlags = (flags) =>
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
      checkPath(path, writing === "open" ? writeFlags(args[0]) : writing, name);
      if (name === "rename" || name === "renameSync") checkPath(args[0], true, name);
      return Reflect.apply(original, this, [path, ...args]);
    });
  };
  for (const base of ["readFile", "readdir", "stat", "lstat", "access", "exists", "realpath"])
    for (const name of [base, `${base}Sync`]) guard(fs, name, false);
  for (const base of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "rename"])
    for (const name of [base, `${base}Sync`]) guard(fs, name, true);
  for (const name of ["open", "openSync"]) guard(fs, name, "open");
  for (const name of ["readFile", "readdir", "stat", "lstat", "access", "realpath"])
    guard(fsPromises, name, false);
  for (const name of ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "unlink", "rename"])
    guard(fsPromises, name, true);
  guard(fsPromises, "open", "open");
  syncBuiltinESMExports();
  const mount = async (plugin, config) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
    assert.equal(fiber.state, 2, "Every required official service must mount successfully");
    return fiber;
  };
  const captures = [];
  const snapshots = [];
  let transportPlan;
  const observeOptions = (options) => {
    const agent = ctx.agents.get(options.sessionId);
    assert.ok(agent, "Adapter request must belong to a live official agent");
    const projected = agent.session.deriveMessages();
    assert.deepEqual(
      options.messages,
      projected,
      "The adapter must send exactly the request-time durable Session projection",
    );
    snapshots.push({
      sessionId: options.sessionId,
      turn: agent.phase.turn,
      step: agent.phase.step,
      messages: structuredClone(options.messages),
      events: structuredClone(agent.session.snapshotEvents()),
    });
  };
  let responseId = 0;
  const messagesEvents = (model, tool) => {
    const id = `synthetic-msg-${++responseId}`;
    return [
      [
        "message_start",
        {
          type: "message_start",
          message: {
            id,
            type: "message",
            role: "assistant",
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
      ],
      [
        "content_block_start",
        {
          type: "content_block_start",
          index: 0,
          content_block: tool
            ? { type: "tool_use", id: tool.id, name: tool.name, input: {} }
            : { type: "text", text: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: tool
            ? { type: "input_json_delta", partial_json: JSON.stringify(tool.arguments) }
            : { type: "text_delta", text: "Synthetic reply." },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
  };
  const chatEvents = (model, tool) => {
    const common = {
      id: `synthetic-chat-${++responseId}`,
      object: "chat.completion.chunk",
      created: 0,
      model,
    };
    return (
      [
        {
          ...common,
          choices: [
            {
              index: 0,
              delta: tool
                ? {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: tool.id,
                        type: "function",
                        function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
                      },
                    ],
                  }
                : { role: "assistant", content: "Synthetic reply." },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        },
      ]
        .map((data) => `data: ${JSON.stringify(data)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  };
  const responsesEvents = (model, tool) => {
    const id = `synthetic-response-${++responseId}`;
    const item = tool
      ? {
          id: `${id}-function`,
          type: "function_call",
          call_id: tool.id,
          name: tool.name,
          arguments: JSON.stringify(tool.arguments),
          status: "completed",
        }
      : {
          id: `${id}-message`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Synthetic reply.", annotations: [] }],
        };
    const response = {
      id,
      object: "response",
      created_at: 0,
      model,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: 1,
        output_tokens: 3,
        total_tokens: 4,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    if (tool)
      return [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...item, status: "in_progress", arguments: "" },
        },
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response },
      ]
        .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
        .join("");
    return [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "Synthetic reply.",
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: "Synthetic reply.",
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response },
    ]
      .map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
  };
  t.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.hostname, "rewind-protocols.invalid", "Real provider requests are forbidden");
    const raw = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    const body = JSON.parse(raw);
    captures.push({ path: url.pathname, body });
    if (transportPlan?.kind === "transient") {
      const plan = transportPlan;
      transportPlan = undefined;
      await plan.callback?.();
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Synthetic transient failure" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    if (transportPlan?.kind === "error") {
      transportPlan = undefined;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "Synthetic permanent rejection" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    if (transportPlan?.kind === "cancel") {
      const plan = transportPlan;
      transportPlan = undefined;
      const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
      assert.ok(signal, "Cancellation must reach the real adapter fetch signal");
      return new Promise((_, reject) => {
        const rejectAbort = () =>
          reject(new DOMException("Synthetic transport cancelled", "AbortError"));
        signal.addEventListener("abort", rejectAbort, { once: true });
        plan.cancel();
        if (signal.aborted) rejectAbort();
      });
    }
    const tool = transportPlan?.kind === "tool" ? transportPlan.tool : undefined;
    if (tool) transportPlan = undefined;
    const data = url.pathname.endsWith("/chat/completions")
      ? chatEvents(body.model, tool)
      : url.pathname.endsWith("/responses")
        ? responsesEvents(body.model, tool)
        : url.pathname.endsWith("/messages")
          ? messagesEvents(body.model, tool)
          : null;
    assert.notEqual(data, null, "Unknown official wire endpoints must fail");
    return new Response(data, {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "synthetic-rewind-request" },
    });
  });
  await mount({
    name: "isolated-official-rewind-protocol-foundation",
    apply(scope) {
      new api.storage.Storage(scope);
      new api.typert.TypertRegistry(scope);
      new api.sessions.SessionStore(scope);
      new api.projections.SessionProjectionRegistry(scope);
      new api.agents.AgentRegistry(scope);
      new api.prompt.SystemPrompt(scope, {
        includeHarnessIdentity: false,
        includeRuntimeContext: false,
        personaPrefix: "",
        personaSuffix: "",
      });
      new api.tools.ToolRuntime(scope);
      new api.llm.LlmRuntime(scope);
      new api.approval.ApprovalService(scope, { policy: "ask" });
      new api.sandbox.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: directory });
      const defaults = new api.cordis.Service(scope, "agentDefaultModel");
      defaults.currentSelection = () => ({ provider: target.id, model: target.model });
      const credentials = new api.cordis.Service(scope, "credentials");
      credentials.resolve = async () => ({ value: "synthetic-not-a-real-key" });
      credentials.readRecord = async () => undefined;
      credentials.listRecords = async () => [];
      const environment = new api.cordis.Service(scope, "launchEnvironment");
      environment.get = () => undefined;
      const fs = new api.cordis.Service(scope, "fs");
      fs.resolve = deny("host filesystem resolver");
      const attachments = new api.cordis.Service(scope, "attachments");
      attachments.imageLimits = {
        maxImageBytes: 1024,
        maxImagesPerMessage: 1,
        maxMessageImageBytes: 1024,
        maxImagePixels: 1024,
        maxImageDimension: 32,
        mediaTypes: ["image/png"],
      };
      const uploads = new api.cordis.Service(scope, "fileUploads");
      uploads.registerAgentResolver = () => () => {};
      const access = new api.cordis.Service(scope, "remoteAccess");
      access.allows = (resource) =>
        resource.kind === "session" && ctx.sessions.get(resource.id) !== undefined;
      const connection = api.deepseek.resolveAdapterOptions({
        baseURL: "https://rewind-protocols.invalid/default",
        thinking: "disabled",
        models: [{ id: "deepseek-flash", systemPromptUpdate: "in-history" }],
        retryPolicy: {
          mode: "normal",
          maxRetries: 1,
          backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
        },
      });
      const adapter = new api.deepseek.DeepSeekAdapter({
        options: () => connection,
        resolveUserId: () => "synthetic-user",
        resolveAuth: async () => ({ headers: { "x-api-key": "synthetic-not-a-real-key" } }),
        resolveFiles: () => ({ ensureUploaded: deny("file upload") }),
        prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
      });
      const generate = adapter.generate;
      adapter.generate = function (options, ...args) {
        observeOptions(options);
        return generate.call(this, options, ...args);
      };
      scope.llm.registerAdapter(["deepseek-official"], adapter);
    },
  });
  const providers = {};
  for (const format of targets.slice(1)) {
    assert.ok(
      api.pi.supportedProtocols().includes(format.api),
      `Official adapter must expose ${format.api}`,
    );
    providers[format.id] = {
      api: format.api,
      baseURL: `https://rewind-protocols.invalid/${format.endpoint}`,
      apiKeyEnv: "SYNTHETIC_PROTOCOL_KEY",
      models: [
        {
          id: format.model,
          input: ["text"],
          reasoningEfforts: false,
          contextWindow: 10000,
          maxTokens: 128,
        },
      ],
      transport: "sse",
      streamIdleTimeoutMs: 2000,
      retryPolicy: {
        mode: "normal",
        maxRetries: 1,
        backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      },
    };
  }
  await mount(api.pi, { providers });
  for (const provider of Object.keys(providers)) {
    const adapter = ctx.llm.registration(provider).adapter;
    adapter.config.auth.authContext = { env: async () => undefined, fileExists: async () => false };
    adapter.config.auth.credentials = {
      read: async () => undefined,
      list: async () => [],
      modify: deny("credential modification"),
      delete: deny("credential deletion"),
    };
  }
  const piAdapter = ctx.llm.registration(targets[1].id).adapter;
  const stream = piAdapter.streamWithSnapshot;
  piAdapter.streamWithSnapshot = function (options, ...args) {
    observeOptions(options);
    return stream.call(this, options, ...args);
  };
  await mount(api.jsonStorage, { root: join(directory, "domains") });
  await mount(api.domain, { backend: "json", routes: {} });
  await mount(api.persistence, {
    root: join(directory, "session-logs"),
    compression: "none",
    listConcurrency: 1,
  });
  await mount(api.workspaces.WorkspaceRegistry);
  await mount(api.query.SessionQueryEngine);
  if (retry) await mount(api.retry);
  await mount(api.loop.AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  await mount(api.controller.SessionController, { nativeOpen: false, listWorkSliceMs: 16 });
  const startRuntime = (scope) => {
    runtime = new DesktopRuntime(scope, runtimeStore, {
      supported: true,
      version: manifest.release.version,
      runtimeRoot: root,
    });
    runtime.apply();
  };
  let runtimeFiber;
  if (unloadableRuntime) {
    runtimeFiber = await mount((scope) => {
      startRuntime(scope);
      scope.effect(() => () => runtime.revert());
    });
  } else startRuntime(ctx);
  desktop = new DesktopSessions(ctx, store);
  const create = async () => {
    const created = await ctx.sessionController.create({ cwd: join(directory, "project") });
    store.dispatch("workspaces.bind", { id: workspaceId, sessionId: created.sessionId });
    return ctx.agents.get(created.sessionId);
  };
  const follow = async (agent, text) => {
    agent.followup(
      api.llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }),
    );
    await agent.whenIdle();
    return agent.session.snapshotEvents().findLast((event) => event.type === "turn/end").data
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
        "JSONL readback must match the live official Session",
      );
      return log;
    } finally {
      await reader.close();
    }
  };
  return {
    api,
    ctx,
    desktop,
    directory,
    store,
    workspaceId,
    settings,
    runtime,
    unloadRuntime: async () => {
      assert.ok(runtimeFiber, "Enable unloadableRuntime to isolate the plugin lifetime");
      await runtimeFiber.dispose();
      assert.equal(runtimeFiber.uid, null);
      assert.equal(runtime.enabled, false);
    },
    create,
    follow,
    durable,
    captures,
    snapshots,
    modules,
    failNext: () => {
      transportPlan = { kind: "error" };
    },
    failTransientNext: (callback) => {
      transportPlan = { kind: "transient", callback };
    },
    replyWithTool: (tool) => {
      transportPlan = { kind: "tool", tool: structuredClone(tool) };
    },
    cancelNext: (agent) => {
      transportPlan = { kind: "cancel", cancel: () => agent.cancel({ kind: "user" }) };
    },
  };
}
