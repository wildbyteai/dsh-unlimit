#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopRuntime } from "../src/host/runtime.js";

const index = process.argv.indexOf("--runtime");
const supplied = index >= 0 ? process.argv[index + 1] : process.env.DSH_UNLIMIT_RUNTIME;
if (!supplied) {
  console.error(
    "Usage: node scripts/verify-protocols.mjs --runtime <local official desktop runtime>",
  );
  process.exitCode = 2;
} else {
  const root = resolve(supplied);
  const manifest = JSON.parse(readFileSync(join(root, "desktop-runtime.json"), "utf8"));
  const require = createRequire(join(root, "package.json"));
  const result = {
    hostVersion: manifest.release.version,
    environment: "isolated-official-agent-loop-and-adapters",
    integrityScope:
      "directly imported entry files, including lazy protocol SDKs; not an exhaustive transitive audit",
    realProfileRead: false,
    persistedHostChanges: false,
    networkRequests: 0,
    blockedNetworkAttempts: 0,
    modules: [],
    checks: [],
    protocols: [],
    limitations: [
      "Synthetic credentials, text-only sessions and fake SSE responses; no live model output quality or real provider acceptance is tested.",
      "Child sessions are created by the official in-process AgentLoop with parent ownership; external subprocess delegation is not tested.",
      "The DeepSeek default adapter class is mounted directly with synthetic identity/files callbacks to avoid the default wrapper writing an anonymous identity or consulting the home files index.",
    ],
  };
  const load = async (name) => {
    let filename;
    if (name.startsWith("@earendil-works/pi-ai/api/")) {
      // This package intentionally exports its API only under ESM's import
      // condition; createRequire.resolve uses the require condition instead.
      const packageFile = join(root, "node_modules/@earendil-works/pi-ai/package.json");
      const declaration = JSON.parse(readFileSync(packageFile, "utf8"));
      const target = declaration.exports["./api/*"].import;
      filename = resolve(dirname(packageFile), target.replace("*", name.split("/").at(-1)));
    } else filename = require.resolve(name);
    const row = manifest.files.find((item) => item.path === relative(root, filename));
    assert.ok(row, `No official inventory entry for ${name}`);
    const digest = createHash("sha256").update(readFileSync(filename)).digest("hex");
    assert.equal(
      digest,
      row.sha256,
      `${name} has changed; refusing to count it as clean official evidence`,
    );
    result.modules.push({ name, matchesManifest: true, entrySha256: digest });
    return import(pathToFileURL(filename).href);
  };
  const check = async (name, operation) => {
    try {
      await operation();
      result.checks.push({ name, passed: true });
    } catch (error) {
      result.checks.push({ name, passed: false, error: error.message });
    }
  };
  const captures = [];
  const requestExamples = [];
  let preservedRequestCount = 0;
  const observeOptions = (options) => {
    const agent = ctx?.agents.get(options.sessionId);
    assert.ok(agent, "The public stream request must identify a live official agent");
    assert.deepEqual(
      options.messages,
      agent.session.deriveMessages(),
      "Every sent message, including the current system prompt, must exactly match the durable session projection",
    );
    preservedRequestCount++;
    if (options.provider !== "deepseek-official") return;
    requestExamples.push({
      keys: Object.keys(options),
      sessionId: options.sessionId,
      messages: options.messages.map((message) => ({
        role: message.role,
        source: {
          kind: message.source.kind,
          ...(message.source.form ? { form: message.source.form } : {}),
        },
        content: message.content
          .filter((block) => block.type === "text")
          .map((block) =>
            message.source.kind === "system-prompt" || message.source.kind === "user"
              ? block.text
              : "[host or model content omitted]",
          ),
      })),
    });
  };
  let failurePlan;
  let responseId = 0;
  const messagesEvents = (model) => {
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
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Synthetic reply." },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      [
        "message_delta",
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
      ],
      ["message_stop", { type: "message_stop" }],
    ]
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join("");
  };
  const chatEvents = (model) => {
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
              delta: { role: "assistant", content: "Synthetic reply." },
              finish_reason: null,
            },
          ],
        },
        {
          ...common,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        },
      ]
        .map((data) => `data: ${JSON.stringify(data)}\n\n`)
        .join("") + "data: [DONE]\n\n"
    );
  };
  const responsesEvents = (model) => {
    const id = `synthetic-response-${++responseId}`;
    const item = {
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
  const savedFetch = globalThis.fetch;
  const savedConnect = Socket.prototype.connect;
  Socket.prototype.connect = function () {
    result.blockedNetworkAttempts++;
    throw new Error("NETWORK_DISABLED: protocol acceptance permits no sockets");
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(
      url.hostname,
      "protocols.invalid",
      "Unexpected request target: no external requests are permitted",
    );
    const raw = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    const body = JSON.parse(raw);
    captures.push({ path: url.pathname, body });
    if (failurePlan?.model === body.model) {
      const planned = failurePlan;
      failurePlan = undefined;
      planned.changePrompt();
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "api_error", message: "Synthetic transient failure" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    }
    const data = url.pathname.endsWith("/chat/completions")
      ? chatEvents(body.model)
      : url.pathname.endsWith("/responses")
        ? responsesEvents(body.model)
        : url.pathname.endsWith("/messages")
          ? messagesEvents(body.model)
          : null;
    assert.notEqual(
      data,
      null,
      "An unrecognized endpoint cannot receive a fake successful response",
    );
    return new Response(data, {
      status: 200,
      headers: { "content-type": "text/event-stream", "request-id": "synthetic-request" },
    });
  };
  let ctx, owner, piFiber, retryFiber, runtime;
  try {
    assert.equal(manifest.release.version, "0.2.1-rc.2");
    const [
      cordis,
      prompt,
      approval,
      sandbox,
      projections,
      sessions,
      agents,
      llm,
      tools,
      loop,
      cosmokit,
      deepseek,
      pi,
      retry,
    ] = await Promise.all([
      load("@deepseek-ai/cordis"),
      load("@deepseek-ai/dsh-system-prompt"),
      load("@deepseek-ai/dsh-user-approval"),
      load("@deepseek-ai/dsh-sandbox-policy"),
      load("@deepseek-ai/dsh-session-projection"),
      load("@deepseek-ai/dsh-session"),
      load("@deepseek-ai/dsh-agent"),
      load("@deepseek-ai/dsh-llm"),
      load("@deepseek-ai/dsh-tools"),
      load("@deepseek-ai/dsh-agent-loop"),
      load("@deepseek-ai/cosmokit"),
      load("@deepseek-ai/dsh-llm-deepseek"),
      load("@deepseek-ai/dsh-llm-pi-ai"),
      load("@deepseek-ai/dsh-llm-retry"),
    ]);
    // These lazy implementations generate the real wire JSON. Verify them too;
    // do not substitute a test-authored request serializer for a missing SDK.
    for (const name of [
      "@earendil-works/pi-ai/api/openai-completions.lazy",
      "@earendil-works/pi-ai/api/openai-responses.lazy",
      "@earendil-works/pi-ai/api/anthropic-messages.lazy",
      "@earendil-works/pi-ai/api/openai-completions",
      "@earendil-works/pi-ai/api/openai-responses",
      "@earendil-works/pi-ai/api/openai-responses-shared",
      "@earendil-works/pi-ai/api/anthropic-messages",
    ])
      await load(name);
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
    const store = {
      dispatch(action) {
        if (action === "settings.get") return { value: settings };
        if (action === "rules.list") return { items: [], activeId: null };
        throw new Error(`Unexpected synthetic store action: ${action}`);
      },
    };
    ctx = new cordis.Context();
    owner = ctx.plugin({
      name: "synthetic-protocol-services",
      apply(scope) {
        new prompt.SystemPrompt(scope, {
          includeHarnessIdentity: true,
          includeRuntimeContext: true,
          personaPrefix: "SYNTHETIC_HOST",
          personaSuffix: "",
        });
        new projections.SessionProjectionRegistry(scope);
        new sessions.SessionStore(scope);
        new agents.AgentRegistry(scope);
        new llm.LlmRuntime(scope);
        new tools.ToolRuntime(scope);
        new approval.ApprovalService(scope, { policy: "ask" });
        new sandbox.SandboxPolicyService(scope, {
          mode: "read-only",
          workspaceRoot: "/synthetic-protocol-workspace",
        });
        new loop.AgentLoop(scope, { agents: [], maxParallelToolCalls: cosmokit.createVolatile(1) });
        const credentials = new cordis.Service(scope, "credentials");
        credentials.resolve = async () => ({ value: "synthetic-not-a-real-key" });
        credentials.readRecord = async () => undefined;
        credentials.listRecords = async () => [];
        const environment = new cordis.Service(scope, "launchEnvironment");
        environment.get = () => undefined;
        const connection = deepseek.resolveAdapterOptions({
          baseURL: "https://protocols.invalid/default",
          thinking: "disabled",
          models: [{ id: "deepseek-flash", systemPromptUpdate: "in-history" }],
          retryPolicy: {
            mode: "normal",
            maxRetries: 1,
            backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
          },
        });
        const adapter = new deepseek.DeepSeekAdapter({
          options: () => connection,
          resolveUserId: () => "synthetic-user",
          resolveAuth: async () => ({ headers: { "x-api-key": "synthetic-not-a-real-key" } }),
          resolveFiles: () => ({
            ensureUploaded() {
              throw new Error("File upload is outside this text-only verification");
            },
          }),
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
    await owner.await();
    const profiles = {};
    const formats = [
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
    const supported = pi.supportedProtocols();
    for (const format of formats)
      if (supported.includes(format.api))
        profiles[format.id] = {
          api: format.api,
          baseURL: `https://protocols.invalid/${format.endpoint}`,
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
    piFiber = ctx.plugin(pi, { providers: profiles });
    await piFiber.await();
    // The public adapter auth boundary is synthetic. Even if a protocol tries
    // ambient discovery, it cannot read a profile or credential file here.
    for (const provider of Object.keys(profiles)) {
      const adapter = ctx.llm.registration(provider).adapter;
      adapter.config.auth.authContext = {
        env: async () => undefined,
        fileExists: async () => false,
      };
      adapter.config.auth.credentials = {
        read: async () => undefined,
        list: async () => [],
        modify() {
          throw new Error("Credential writes are outside verification");
        },
        delete() {
          throw new Error("Credential writes are outside verification");
        },
      };
    }
    const piAdapter = ctx.llm.registration(Object.keys(profiles)[0]).adapter;
    const streamWithSnapshot = piAdapter.streamWithSnapshot;
    piAdapter.streamWithSnapshot = function (options, ...args) {
      observeOptions(options);
      return streamWithSnapshot.call(this, options, ...args);
    };
    retryFiber = ctx.plugin(retry);
    await retryFiber.await();
    runtime = new DesktopRuntime(ctx, store, {
      supported: true,
      version: manifest.release.version,
      runtimeRoot: root,
    });
    runtime.apply();
    const currentNative = (body, marker) => {
      const places = [];
      if (JSON.stringify(body.system ?? "").includes(marker)) places.push("top-level system");
      if (JSON.stringify(body.instructions ?? "").includes(marker))
        places.push("top-level instructions");
      for (const field of ["messages", "input"])
        for (const message of Array.isArray(body[field]) ? body[field] : []) {
          if (
            ["system", "developer"].includes(message.role) &&
            JSON.stringify(message).includes(marker)
          )
            places.push(`${field} role:${message.role}`);
        }
      return places;
    };
    const follow = async (agent, text) => {
      agent.followup(
        llm.createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }),
      );
      await agent.whenIdle();
      const end = agent.session.snapshotEvents().findLast((event) => event.type === "turn/end");
      assert.equal(
        end?.data.reason?.kind,
        "completed",
        `Official loop did not complete: ${JSON.stringify(end?.data)}`,
      );
    };
    const targets = [
      { id: "deepseek-official", api: "deepseek native messages", model: "deepseek-flash" },
      ...formats,
    ];
    for (const target of targets) {
      if (target.id !== "deepseek-official" && !profiles[target.id]) {
        result.protocols.push({
          provider: target.id,
          api: target.api,
          status: "unverified",
          reason: "Protocol is not exposed by this installed official adapter",
        });
        continue;
      }
      const report = { provider: target.id, api: target.api, requests: [], status: "pending" };
      result.protocols.push(report);
      const observe = (stage, start, marker) => {
        const seen = captures.slice(start).filter((item) => item.body.model === target.model);
        const observations = seen.map((item) => ({
          endpoint: item.path,
          currentNativeLocations: currentNative(item.body, marker),
          currentInUserContent: (item.body.messages ?? item.body.input ?? []).some(
            (message) => message.role === "user" && JSON.stringify(message).includes(marker),
          ),
        }));
        report.requests.push({ stage, count: seen.length, observations });
        assert.ok(seen.length > 0, "No HTTP request from the official adapter was observed");
        assert.ok(
          observations.every((item) => item.currentNativeLocations.length > 0),
          `Current prompt missing from native system locations at ${stage}`,
        );
        assert.ok(
          observations.every((item) => !item.currentInUserContent),
          `Current system prompt was moved into user content at ${stage}`,
        );
      };
      try {
        const agent = await ctx.agentLoop.create(
          `${target.id}-parent`,
          { provider: target.id, model: target.model, maxTokens: 128 },
          { cwd: "/synthetic-protocol-workspace" },
        );
        let marker = `SYNTHETIC_${target.id}_FIRST`;
        settings.prompt = marker;
        let start = captures.length;
        await follow(agent, "Synthetic first turn.");
        observe("first turn", start, marker);
        marker = `SYNTHETIC_${target.id}_SECOND`;
        settings.prompt = marker;
        start = captures.length;
        await follow(agent, "Synthetic second turn after editing the operator prompt.");
        observe("second turn changed prompt", start, marker);
        marker = `SYNTHETIC_${target.id}_CHILD`;
        settings.prompt = marker;
        const childHandle = await ctx.agents.create({
          sessionId: `${target.id}-child`,
          parentAgent: agent,
          agentOptions: { provider: target.id, model: target.model, maxTokens: 128 },
          meta: {
            parentSession: agent.session.id,
            origin: "subagent",
            delegationDepth: 1,
            cwd: "/synthetic-protocol-workspace",
          },
        });
        start = captures.length;
        await follow(childHandle.agent, "Synthetic child turn.");
        observe("child first turn", start, marker);
        const beforeFailure = `SYNTHETIC_${target.id}_BEFORE_RETRY`;
        const afterFailure = `SYNTHETIC_${target.id}_CURRENT_RETRY`;
        settings.prompt = beforeFailure;
        failurePlan = {
          model: target.model,
          changePrompt: () => {
            settings.prompt = afterFailure;
          },
        };
        start = captures.length;
        await follow(agent, "Synthetic transient failure followed by an official retry.");
        const attempts = captures.slice(start).filter((item) => item.body.model === target.model);
        assert.equal(
          attempts.length,
          2,
          "Exactly one official retry must follow the injected transient failure",
        );
        const retryEvents = agent.session
          .snapshotEvents()
          .filter((event) => ["llm/retry", "llm/retry-started"].includes(event.type));
        report.retryEvents = retryEvents.map((event) => ({
          type: event.type,
          retry: event.data.retry,
          provider: event.data.provider,
        }));
        assert.equal(
          retryEvents.filter((event) => event.type === "llm/retry").length,
          1,
          "The retry must be scheduled by the official durable executor, not hidden SDK retries",
        );
        assert.equal(retryEvents.filter((event) => event.type === "llm/retry-started").length, 1);
        const committedPrompt = agent.session
          .snapshotEvents()
          .filter(
            (event) =>
              event.type === "system/message" &&
              event.data.message.source.kind === "system-prompt" &&
              event.data.message.role === "system" &&
              event.data.message.content.some(
                (block) => block.type === "text" && block.text.includes(afterFailure),
              ),
          );
        assert.ok(
          committedPrompt.length > 0,
          "The current retry prompt must be committed as an actual system/message event, not only changed in the outgoing request",
        );
        report.currentRetrySystemEventSeqs = committedPrompt.map((event) => event.seq);
        observe("retry after editing prompt during failure", start + 1, afterFailure);
        report.status = "verified";
      } catch (error) {
        report.status = "failed";
        report.reason = error.message;
      }
    }
    result.networkRequests = 0;
    await check(
      "all observed requests used the local fake transport without opening a socket",
      () => {
        assert.equal(result.blockedNetworkAttempts, 0);
        assert.ok(captures.length > 0);
      },
    );
  } catch (error) {
    result.checks.push({
      name: "official protocol fixture setup",
      passed: false,
      error: error.message,
    });
  } finally {
    failurePlan = undefined;
    await check("runtime and official fibers dispose cleanly", async () => {
      runtime?.revert();
      if (retryFiber) await retryFiber.dispose();
      if (piFiber) await piFiber.dispose();
      if (owner) await owner.dispose();
      if (ctx) await ctx.fiber.dispose();
    });
    globalThis.fetch = savedFetch;
    Socket.prototype.connect = savedConnect;
  }
  result.observedRequestCount = captures.length;
  result.requestsWithPreservedNonPromptMessages = preservedRequestCount;
  result.requestsMatchingDurableMessages = preservedRequestCount;
  result.defaultProviderRequestExamples = requestExamples.length
    ? [requestExamples[0], requestExamples.at(-1)]
    : [];
  result.passed =
    result.checks.every((check) => check.passed) &&
    result.protocols.length > 0 &&
    result.protocols.every((protocol) => protocol.status === "verified");
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
