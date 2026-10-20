import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { mount } from "../src/host/plugin.js";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME for isolated tests using official modules; no user profile is loaded",
  timeout: 10000,
};
let official;
function loadOfficial() {
  official ??= (async () => {
    const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
    assert.equal(descriptor.release.version, "0.2.1-rc.2");
    const require = createRequire(join(runtimeRoot, "package.json"));
    const load = async (name) => {
      const filename = require.resolve(name);
      const row = descriptor.files.find((item) => item.path === relative(runtimeRoot, filename));
      assert.ok(row, `Official inventory must contain the ${name} entry`);
      assert.equal(
        createHash("sha256").update(readFileSync(filename)).digest("hex"),
        row.sha256,
        `${name} entry differs from the official inventory; cannot count it as clean official evidence`,
      );
      return import(pathToFileURL(filename).href);
    };
    const [cordis, prompt, approval, sandbox, projections, sessions, tools, skills] =
      await Promise.all([
        load("@deepseek-ai/cordis"),
        load("@deepseek-ai/dsh-system-prompt"),
        load("@deepseek-ai/dsh-user-approval"),
        load("@deepseek-ai/dsh-sandbox-policy"),
        load("@deepseek-ai/dsh-session-projection"),
        load("@deepseek-ai/dsh-session"),
        load("@deepseek-ai/dsh-tools"),
        load("@deepseek-ai/dsh-skill"),
      ]);
    return {
      ...cordis,
      ...prompt,
      ...approval,
      ...sandbox,
      ...projections,
      ...sessions,
      ...tools,
      ...skills,
    };
  })();
  return official;
}

async function eventually(check, message) {
  const deadline = Date.now() + 2000;
  do {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(message);
}

async function fixture(t, { optional = true, admitted = true } = {}) {
  const api = await loadOfficial();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-plugin-")));
  const host = {
    kind: "desktop",
    supported: true,
    version: "0.2.1-rc.2",
    platform: process.platform,
    runtimeRoot,
    dataRoot: join(directory, "data"),
  };
  const ctx = new api.Context();
  const routes = new Set();
  const agents = new Map();
  const origin = "http://127.0.0.1:42139";
  const token = "Bearer synthetic-local-session";
  let controller;
  const owner = ctx.plugin({
    name: "synthetic-desktop-services",
    apply(scope) {
      const web = new api.Service(scope, "webServer");
      web.getOrigin = () => origin;
      web.register = (route) =>
        scope.effect(() => {
          routes.add(route);
          return () => routes.delete(route);
        });
      const connection = new api.Service(scope, "connection");
      connection.requestRejection = (request) =>
        request.headers.authorization === token ? undefined : 401;
      if (!optional) return;
      new api.SystemPrompt(scope, {
        includeHarnessIdentity: true,
        includeRuntimeContext: true,
        personaPrefix: "SYNTHETIC_HOST",
        personaSuffix: "",
      });
      new api.SessionProjectionRegistry(scope);
      new api.ApprovalService(scope, { policy: "ask" });
      new api.SandboxPolicyService(scope, { mode: "read-only", workspaceRoot: directory });
      new api.ToolRuntime(scope);
      new api.SkillRegistry(scope);
      const agentRegistry = new api.Service(scope, "agents");
      agentRegistry.get = (id) => agents.get(id);
      agentRegistry.list = () => [...agents.values()];
      const sessionController = new api.Service(scope, "sessionController");
      sessionController.list = () => ({
        items: [...agents.values()].map((agent) => ({
          sessionId: agent.session.id,
          running: false,
        })),
      });
      const workspaceRegistry = new api.Service(scope, "workspaceRegistry");
      workspaceRegistry.archivedSessionIds = [];
    },
  });
  await owner.await();
  const originalPrompt = optional
    ? Object.getOwnPropertyDescriptor(ctx.systemPrompt, "assemble")
    : null;
  const originalApproval = optional
    ? Object.getOwnPropertyDescriptor(ctx.approval, "decide")
    : null;
  const plugin = ctx.plugin({
    name: "synthetic-dsh-unlimit",
    inject: ["webServer", "connection"],
    apply(scope) {
      controller = mount(scope, host);
    },
  });
  const dispose = async () => {
    if (plugin.uid !== null) await plugin.dispose();
  };
  t.after(async () => {
    try {
      await dispose();
    } finally {
      await owner.dispose();
      await ctx.fiber.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await plugin.await();
  assert.ok(controller, "required services must activate mount");
  if (admitted) {
    const clock = controller.admission.clock;
    controller.admission.clock = () => 0;
    const { challengeId } = controller.admission.dispatch("admission.begin");
    controller.admission.dispatch("admission.read", { challengeId });
    controller.admission.clock = () => 5000;
    controller.admission.dispatch("admission.confirm", {
      challengeId,
      checks: { scope: true, permissions: true, evidence: true },
    });
    controller.admission.clock = clock;
  }
  if (optional)
    await eventually(
      () => ctx.tools.get("unlimit_workspace") !== undefined,
      "real ToolRuntime never received plugin tools",
    );
  const agent = (id, parent) => {
    const session = api.Session.create(id, undefined, {
      version: api.SESSION_FORMAT_VERSION,
      id,
      createdAt: 0,
      isSeeded: false,
      cwd: directory,
      ...(parent ? { parentSession: parent.session.id, origin: "subagent" } : {}),
    });
    const value = { id, session, ctx, options: { model: "synthetic-model" } };
    agents.set(id, value);
    return value;
  };
  const request = async ({
    action = "status",
    payload = {},
    method = "POST",
    url = "/dsh-unlimit/api",
    headers = {},
    remote = "127.0.0.1",
    raw,
  } = {}) => {
    const route = [...routes].find((item) => url.startsWith(item.path));
    assert.ok(route, "mount must register its HTTP route");
    const request = {
      method,
      url,
      socket: { remoteAddress: remote },
      headers: {
        host: new URL(origin).host,
        authorization: token,
        origin,
        "content-type": "application/json",
        "x-dsh-unlimit": "1",
        ...headers,
      },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(raw ?? JSON.stringify({ action, payload }));
      },
    };
    let status, responseHeaders, body;
    await route.handler(request, {
      writeHead(code, values) {
        status = code;
        responseHeaders = values;
      },
      end(value) {
        body = Buffer.isBuffer(value) ? value.toString("utf8") : value;
      },
    });
    return {
      status,
      headers: responseHeaders,
      body,
      json: responseHeaders["Content-Type"].startsWith("application/json")
        ? JSON.parse(body)
        : null,
    };
  };
  let callId = 0;
  const execute = (agent, action, payload = {}) =>
    ctx.tools.execute({
      name: "unlimit_workspace",
      callId: `synthetic-call-${++callId}`,
      arguments: { action, payload },
      agent,
      signal: new AbortController().signal,
    });
  return {
    api,
    ctx,
    host,
    directory,
    owner,
    plugin,
    controller,
    routes,
    agents,
    agent,
    request,
    execute,
    dispose,
    originalPrompt,
    originalApproval,
  };
}

test(
  "catalog scope and local templates share real model-tool and HTTP entry points",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const agent = f.agent("synthetic-catalog-agent");
    const other = f.agent("synthetic-other-catalog-agent");
    const directory = join(f.directory, "templates");
    mkdirSync(directory);
    writeFileSync(join(directory, "sample.yaml"), "id: synthetic-local\ninfo: example only\n");
    await f.request({ action: "toolkit.save", payload: { templateDir: directory } });
    const read = await f.execute(agent, "templates.read", { path: "sample.yaml" });
    assert.equal(read.isError, false, JSON.stringify(read));
    const listing = await f.request({ action: "templates.list", payload: { query: "example" } });
    assert.equal(listing.json.data.items[0].sha256, read.value.item.sha256);
    const catalog = await f.execute(agent, "catalog.list", {});
    assert.equal(catalog.isError, false, JSON.stringify(catalog));
    assert.equal(catalog.value.context.sessionId, agent.session.id);
    assert.ok(catalog.value.tools.some((tool) => tool.name === "unlimit_workspace"));
    assert.equal(
      (await f.execute(agent, "catalog.list", { sessionId: other.session.id })).isError,
      true,
    );
    const preflight = await f.request({
      action: "catalog.preflight",
      payload: {
        sessionId: agent.session.id,
        requirements: [{ kind: "tool", name: "unlimit_workspace" }],
      },
      headers: { origin: undefined },
    });
    assert.equal(preflight.json.data.status, "ready");
    assert.equal(preflight.json.data.executionAuthorized, false);
    const drafts = await f.request({ method: "GET", url: "/dsh-unlimit/ui/drafts.js" });
    assert.equal(drafts.status, 200);
    assert.match(drafts.body, /export class MemoryDrafts/);
  },
);

test(
  "official model tools and HTTP share workspace material files and reversible backups",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const agent = f.agent("synthetic-material-agent");
    const workspace = f.controller.store.dispatch("workspaces.save", {
      name: "Synthetic material workspace",
    }).item;
    const foreign = f.controller.store.dispatch("workspaces.save", {
      name: "Other synthetic material workspace",
    }).item;
    await f.execute(agent, "workspaces.bind", { id: workspace.id });
    const write = await f.execute(agent, "files.write", {
      path: "evidence/response.http",
      content: "HTTP/1.1 200 OK\n\nSynthetic offline response.",
    });
    assert.equal(write.isError, false, JSON.stringify(write));
    const read = await f.request({
      action: "files.read",
      payload: { workspaceId: workspace.id, path: "evidence/response.http", encoding: "utf8" },
    });
    assert.equal(read.json.data.item.sha256, write.value.item.sha256);
    assert.equal(read.json.data.item.content, "HTTP/1.1 200 OK\n\nSynthetic offline response.");
    assert.equal((await f.execute(agent, "files.list", { workspaceId: foreign.id })).isError, true);
    const removed = await f.execute(agent, "files.delete", { path: "evidence/response.http" });
    assert.equal(removed.isError, false);
    const restored = await f.request({
      action: "files.restore",
      payload: { workspaceId: workspace.id, backupId: removed.value.item.backupId },
    });
    assert.equal(restored.json.data.item.sha256, write.value.item.sha256);
    assert.deepEqual(
      (await f.request({ action: "files.list", payload: { workspaceId: foreign.id } })).json.data
        .items,
      [],
    );
  },
);

test(
  "workflow model-tool calls stay with the current parent even when another parent shares the workspace",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const parent = f.agent("synthetic-workflow-parent");
    const other = f.agent("synthetic-workflow-other");
    const workspace = f.controller.store.dispatch("workspaces.save", {
      name: "Shared synthetic workflow workspace",
    }).item;
    for (const agent of [parent, other]) {
      const binding = await f.execute(agent, "workspaces.bind", { id: workspace.id });
      assert.equal(binding.isError, false);
    }
    const rows = [
      { id: "own-run", workspaceId: workspace.id, parentSessionId: parent.session.id },
      { id: "other-run", workspaceId: workspace.id, parentSessionId: other.session.id },
    ];
    const mutations = [];
    // Only the executor is synthetic here; ToolRuntime/schema and HTTP/controller are real.
    f.controller.workflow.dispatch = async (action, payload) => {
      assert.equal(payload.workspaceId, workspace.id);
      if (action === "workflow.status")
        return payload.id ? { item: rows.find((item) => item.id === payload.id) } : { items: rows };
      mutations.push({ action, payload });
      return { item: { ...payload, id: payload.id ?? "new-run" } };
    };
    const visible = await f.execute(parent, "workflow.status");
    assert.equal(visible.isError, false);
    assert.deepEqual(
      visible.value.items.map((item) => item.id),
      ["own-run"],
    );
    for (const action of ["workflow.status", "workflow.stop"]) {
      assert.equal((await f.execute(parent, action, { id: "other-run" })).isError, true);
    }
    assert.equal(
      (
        await f.execute(parent, "workflow.dispatch", {
          parentSessionId: other.session.id,
          role: "analyst",
          task: "Summarize only synthetic evidence.",
        })
      ).isError,
      true,
    );
    assert.equal((await f.execute(parent, "workflow.stop")).isError, true);
    assert.deepEqual(mutations, []);
    const started = await f.execute(parent, "workflow.dispatch", {
      role: "analyst",
      task: "Summarize only synthetic evidence.",
    });
    assert.equal(started.isError, false);
    assert.equal(started.value.item.parentSessionId, parent.session.id);
    assert.equal((await f.execute(parent, "workflow.stop", { id: "own-run" })).isError, false);
    assert.deepEqual(
      mutations.map((entry) => entry.action),
      ["workflow.dispatch", "workflow.stop"],
    );
    const fromUI = await f.request({
      action: "workflow.status",
      payload: { workspaceId: workspace.id },
    });
    assert.equal(fromUI.status, 200);
    assert.equal(
      fromUI.json.data.items.length,
      2,
      "the authorized workspace UI keeps both parents",
    );
  },
);

test(
  "plan tools derive workspace and parent from the executing session before reaching the coordinator",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const parent = f.agent("synthetic-plan-parent");
    const workspace = f.controller.store.dispatch("workspaces.save", {
      name: "Synthetic plan",
    }).item;
    await f.execute(parent, "workspaces.bind", { id: workspace.id });
    const calls = [];
    f.controller.plans.dispatch = async (action, payload) => {
      calls.push({ action, payload });
      return { item: { id: "synthetic-plan", ...payload } };
    };
    for (const action of ["workflow.plan.create", "workflow.plan.status", "workflow.plan.stop"]) {
      const result = await f.execute(parent, action, { id: "synthetic-plan" });
      assert.equal(result.isError, false);
      assert.equal(result.value.item.workspaceId, workspace.id);
      assert.equal(result.value.item.parentSessionId, parent.session.id);
      assert.equal(
        (await f.execute(parent, action, { parentSessionId: "foreign-parent" })).isError,
        true,
      );
      assert.equal(
        (await f.execute(parent, action, { workspaceId: "foreign-workspace" })).isError,
        true,
      );
    }
    assert.equal(calls.length, 3);
  },
);

test(
  "credential HTTP and official model-tool responses never expose stored content, while edits retain or explicitly clear it",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const agent = f.agent("synthetic-credential-agent");
    const workspaceId = f.controller.store.dispatch("workspaces.save", {
      name: "Synthetic credential records",
    }).item.id;
    f.controller.store.dispatch("workspaces.bind", { id: workspaceId, sessionId: agent.id });
    const payload = { workspaceId, kind: "credential" };
    const secret = "fixture-only-not-a-real-password-472";
    const saved = await f.request({
      action: "records.save",
      payload: { ...payload, data: { name: "Synthetic account", username: "example", secret } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.includes(secret), false);
    const id = saved.json.data.item.id;
    assert.equal(saved.json.data.item.secretState.hasSecret, true);
    const modelRead = await f.execute(agent, "records.list", { kind: "credential" });
    assert.equal(modelRead.isError, false);
    assert.equal(JSON.stringify(modelRead).includes(secret), false);
    assert.equal(modelRead.value.items[0].data.secret, undefined);
    const renamed = await f.execute(agent, "records.save", {
      kind: "credential",
      id,
      data: { name: "Renamed without a secret value" },
    });
    assert.equal(renamed.isError, false, JSON.stringify(renamed));
    assert.equal(renamed.value.item.secretState.hasSecret, true);
    assert.equal(JSON.stringify(renamed).includes(secret), false);
    const rejected = await f.request({
      action: "records.save",
      payload: { ...payload, id, data: { password: secret } },
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.includes(secret), false);
    const typeChange = await f.execute(agent, "records.save", {
      id,
      kind: "http",
      data: {},
    });
    assert.equal(typeChange.isError, true);
    const cleared = await f.request({
      action: "records.save",
      payload: { ...payload, id, data: { secret: "" } },
    });
    assert.equal(cleared.json.data.item.secretState.hasSecret, false);
    assert.equal(cleared.json.data.item.data.name, "Renamed without a secret value");
    const report = await f.execute(agent, "report.build", {});
    assert.equal(report.isError, false);
    assert.equal(JSON.stringify(report).includes(secret), false);
  },
);

test(
  "HTTP and official model-tool preflight use this installation's environment status without resolving secrets",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const agent = f.agent("synthetic-environment-agent");
    const secret = "fixture-environment-secret-not-real";
    t.mock.method(f.controller.environment, "resolve", () => assert.fail("No secret resolution"));
    t.mock.method(f.controller.environment, "exportEnvironment", () =>
      assert.fail("No environment export"),
    );
    const saved = await f.request({
      action: "environment.variables.save",
      payload: { revision: 0, name: "SYNTHETIC_PREFLIGHT", secret: true, value: secret },
    });
    assert.equal(saved.status, 200);
    const requirements = [{ kind: "environment-variable", name: "SYNTHETIC_PREFLIGHT" }];
    const modelCheck = await f.execute(agent, "catalog.preflight", { requirements });
    assert.equal(modelCheck.isError, false, JSON.stringify(modelCheck));
    assert.equal(modelCheck.value.status, "ready");
    assert.equal(modelCheck.value.environment.revision, saved.json.data.revision);
    assert.equal(modelCheck.value.checks[0].state, "ready");
    assert.equal(JSON.stringify(modelCheck).includes(secret), false);
    assert.equal(modelCheck.value.executionAuthorized, false);
    const cleared = await f.request({
      action: "environment.variables.save",
      payload: {
        revision: saved.json.data.revision,
        name: "SYNTHETIC_PREFLIGHT",
        secret: true,
        value: "",
      },
    });
    assert.equal(cleared.status, 200);
    const blocked = await f.request({ action: "catalog.preflight", payload: { requirements } });
    assert.equal(blocked.json.data.status, "blocked");
    assert.equal(blocked.json.data.checks[0].state, "missing");
    assert.equal(blocked.body.includes(secret), false);
    assert.equal(process.env.SYNTHETIC_PREFLIGHT, undefined);
  },
);

test(
  "unconfirmed entry protects both HTTP and real model tools; environment secrets never become model actions",
  hostOnly,
  async (t) => {
    const f = await fixture(t, { admitted: false });
    const parent = f.agent("synthetic-unconfirmed-parent");
    const before = await f.request({ action: "workspaces.list" });
    assert.equal(before.json.error.code, "ADMISSION_REQUIRED");
    assert.equal((await f.execute(parent, "workspaces.save", { name: "Blocked" })).isError, true);
    const schema = f.ctx.tools.schemas().find((item) => item.name === "unlimit_workspace");
    const text = JSON.stringify(schema);
    assert.ok(!text.includes("admission.confirm"));
    assert.ok(!text.includes("environment.variables"));
    for (const action of [
      "admission.confirm",
      "environment.resolve",
      "environment.variables.save",
      "sessions.attachment",
      "sessions.releaseAttachments",
    ])
      assert.equal((await f.execute(parent, action, {})).isError, true);
    let result = await f.request({
      action: "environment.variables.save",
      payload: {
        revision: 0,
        name: "SYNTHETIC_KEY",
        secret: true,
        value: "synthetic-secret-do-not-echo",
      },
    });
    assert.equal(result.status, 200);
    assert.ok(!result.body.includes("synthetic-secret-do-not-echo"));
    const environment = await f.request({ action: "environment.status" });
    assert.equal(environment.json.data.variables[0].configured, true);
    assert.ok(!environment.body.includes("synthetic-secret-do-not-echo"));
    assert.ok(!(await f.request()).body.includes("synthetic-secret-do-not-echo"));
    assert.ok(
      !JSON.stringify(f.controller.store.dispatch("settings.get")).includes("SYNTHETIC_KEY"),
    );
    assert.equal(
      (await f.request({ action: "environment.resolve", payload: { name: "SYNTHETIC_KEY" } }))
        .status,
      400,
    );
    for (const file of [
      "admission.js",
      "environment-settings.js",
      "workflow-plans.js",
      "workspace-rules.js",
      "rewind.js",
    ]) {
      const resource = await f.request({ method: "GET", url: `/dsh-unlimit/ui/${file}` });
      assert.equal(resource.status, 200);
      assert.match(resource.headers["Content-Type"], /javascript/);
    }
    f.controller.admission.clock = () => 0;
    const challenge = await f.request({ action: "admission.begin" });
    const challengeId = challenge.json.data.challengeId;
    await f.request({ action: "admission.read", payload: { challengeId } });
    f.controller.admission.clock = () => 5000;
    result = await f.request({
      action: "admission.confirm",
      payload: {
        challengeId,
        checks: { scope: true, permissions: true, evidence: true },
      },
    });
    assert.equal(result.json.data.accepted, true);
    assert.equal(
      (await f.execute(parent, "workspaces.save", { name: "Accepted synthetic" })).isError,
      false,
    );
    const revoked = await f.request({
      action: "admission.revoke",
      payload: { revision: result.json.data.revision },
    });
    assert.equal(revoked.json.data.accepted, false);
    assert.equal(
      (await f.request({ action: "workspaces.list" })).json.error.code,
      "ADMISSION_REQUIRED",
    );
    assert.equal((await f.request({ action: "settings.get" })).status, 200);
    assert.equal((await f.request({ action: "environment.status" })).json.data.variables.length, 1);
  },
);

test(
  "full mount uses official services, protects HTTP routes, and restores all runtime registrations on dispose",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    assert.equal(f.routes.size, 1);
    assert.equal(statSync(join(f.host.dataRoot, "workspace.sqlite")).mode & 0o777, 0o600);
    assert.equal((await f.request({ headers: { authorization: "" } })).status, 401);
    assert.equal((await f.request({ headers: { origin: "http://foreign.invalid" } })).status, 403);
    assert.equal((await f.request({ headers: { host: "foreign.invalid" } })).status, 403);
    assert.equal((await f.request({ remote: "192.0.2.1" })).status, 403);
    assert.equal((await f.request({ headers: { "x-dsh-unlimit": "" } })).status, 403);
    assert.equal((await f.request({ method: "GET" })).status, 405);
    assert.equal((await f.request({ raw: "{invalid" })).json.error.code, "INVALID_INPUT");
    const ui = await f.request({ method: "GET", url: "/dsh-unlimit/ui/" });
    assert.equal(ui.status, 200);
    assert.match(ui.body, /DSH Unlimit/);
    assert.match(ui.headers["Content-Security-Policy"], /default-src 'self'/);
    const status = await f.request();
    assert.equal(status.status, 200);
    assert.equal(status.json.data.host.version, "0.2.1-rc.2");
    assert.equal(
      status.json.data.capabilities.find((item) => item.id === "repeatReminder").state,
      "unsupported",
    );
    const enabled = await f.request({ action: "control.apply" });
    assert.equal(enabled.status, 200, enabled.body);
    assert.equal(enabled.json.data.enabled, true);
    await f.dispose();
    assert.equal(f.plugin.uid, null);
    assert.equal(f.routes.size, 0);
    assert.equal(f.ctx.tools.get("unlimit_workspace"), undefined);
    assert.equal(f.ctx.tools.get("unlimit_status"), undefined);
    assert.deepEqual(await f.ctx.skills.list(), []);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(f.ctx.systemPrompt, "assemble"),
      f.originalPrompt,
    );
    assert.deepEqual(Object.getOwnPropertyDescriptor(f.ctx.approval, "decide"), f.originalApproval);
    assert.throws(() => f.controller.store.dispatch("settings.get"), /closed|open|database/i);
  },
);

test(
  "official tool schema and execution persist model facts into the same UI store with isolated session bindings",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    const schema = f.ctx.tools.schemas().find((item) => item.name === "unlimit_workspace");
    assert.equal(schema.parameters.type, "object");
    assert.ok(schema.parameters.required.includes("action"));
    assert.ok(schema.parameters.required.includes("payload"));
    assert.ok(schema.parameters.properties.action.enum.includes("assets.save"));
    assert.equal(schema.parameters.properties.action.enum.includes("control.apply"), false);
    const a = f.agent("synthetic-agent-a");
    const b = f.agent("synthetic-agent-b");
    const child = f.agent("synthetic-child-a", a);
    const workspaceA = (
      await f.request({
        action: "workspaces.save",
        payload: { name: "Synthetic A", scope: "Local only", authorization: "Test fixture" },
      })
    ).json.data.item;
    const workspaceBResult = await f.execute(b, "workspaces.save", {
      name: "Synthetic B",
      scope: "Local only",
      authorization: "Test fixture",
    });
    assert.equal(workspaceBResult.isError, false, JSON.stringify(workspaceBResult));
    const workspaceB = workspaceBResult.value.item;
    assert.equal((await f.execute(a, "workspaces.bind", { id: workspaceA.id })).isError, false);
    assert.equal((await f.execute(b, "workspaces.bind", { id: workspaceB.id })).isError, false);
    await f.request({ action: "workspaces.activate", payload: { id: workspaceB.id } });
    const savedA = await f.execute(a, "assets.save", {
      name: "Synthetic asset A",
      address: "https://a.example.invalid",
    });
    const savedB = await f.execute(b, "assets.save", {
      name: "Synthetic asset B",
      address: "https://b.example.invalid",
    });
    const savedChild = await f.execute(child, "assets.save", {
      name: "Synthetic child asset",
      address: "https://child.example.invalid",
    });
    for (const result of [savedA, savedB, savedChild])
      assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(savedA.value.item.workspaceId, workspaceA.id);
    assert.equal(savedB.value.item.workspaceId, workspaceB.id);
    assert.equal(savedChild.value.item.workspaceId, workspaceA.id);
    const uiA = await f.request({ action: "assets.list", payload: { workspaceId: workspaceA.id } });
    const uiB = await f.request({ action: "assets.list", payload: { workspaceId: workspaceB.id } });
    assert.deepEqual(
      uiA.json.data.items.map((item) => item.id).sort(),
      [savedA.value.item.id, savedChild.value.item.id].sort(),
    );
    assert.deepEqual(
      uiB.json.data.items.map((item) => item.id),
      [savedB.value.item.id],
    );
    assert.equal(
      (
        await f.execute(a, "assets.save", {
          workspaceId: workspaceB.id,
          name: "Wrong",
          address: "https://wrong.example.invalid",
        })
      ).isError,
      true,
    );
    assert.equal(
      (await f.execute(a, "workspaces.bind", { id: workspaceB.id, sessionId: b.session.id }))
        .isError,
      true,
    );
    const denied = await f.execute(a, "control.apply", {});
    assert.equal(denied.isError, true);
    assert.equal(
      f.controller.store.dispatch("assets.list", { workspaceId: workspaceA.id }).items.length,
      2,
    );
    assert.equal(
      f.controller.store.dispatch("assets.list", { workspaceId: workspaceB.id }).items.length,
      1,
    );
  },
);

test(
  "official skill provider exposes imported files and invalidates its real catalog on edits and deletion",
  hostOnly,
  async (t) => {
    const f = await fixture(t);
    assert.deepEqual(await f.ctx.skills.list(), []);
    const markdown =
      "---\nname: synthetic-check\ndescription: Original synthetic skill\n---\n\nReturn the synthetic marker.";
    const imported = await f.request({
      action: "skills.import",
      payload: {
        files: [
          {
            path: "synthetic-check/SKILL.md",
            contentBase64: Buffer.from(markdown).toString("base64"),
          },
          {
            path: "synthetic-check/references/local.txt",
            contentBase64: Buffer.from("Original synthetic reference.").toString("base64"),
          },
        ],
      },
    });
    assert.equal(imported.status, 200, imported.body);
    const list = await f.ctx.skills.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "synthetic-check");
    assert.equal(list[0].provider, "dsh-unlimit");
    const loaded = await f.ctx.skills.get("synthetic-check");
    assert.equal(loaded.content, "Return the synthetic marker.");
    assert.equal(
      readFileSync(join(loaded.resourceBase.path, "references/local.txt"), "utf8"),
      "Original synthetic reference.",
    );
    const updated = await f.request({
      action: "skills.save",
      payload: {
        id: "synthetic-check",
        description: "Updated synthetic skill",
        content: "Updated synthetic body.",
      },
    });
    assert.equal(updated.status, 200, updated.body);
    assert.equal((await f.ctx.skills.list())[0].description, "Updated synthetic skill");
    assert.equal((await f.ctx.skills.get("synthetic-check")).content, "Updated synthetic body.");
    assert.equal(
      (await f.request({ action: "skills.delete", payload: { id: "synthetic-check" } })).status,
      200,
    );
    assert.deepEqual(await f.ctx.skills.list(), []);
    assert.equal(await f.ctx.skills.get("synthetic-check"), undefined);
  },
);

test(
  "mount stays usable when optional core/session/skill/tool services are absent",
  hostOnly,
  async (t) => {
    const f = await fixture(t, { optional: false });
    assert.equal(f.routes.size, 1);
    assert.equal((await f.request({ action: "settings.get" })).status, 200);
    const status = await f.request();
    assert.equal(status.status, 200, status.body);
    assert.equal(status.json.data.enabled, false);
    assert.equal(
      status.json.data.capabilities.find((item) => item.id === "prompt").state,
      "unsupported",
    );
    const applied = await f.request({ action: "control.apply" });
    assert.notEqual(applied.status, 200);
    assert.equal(f.controller.runtime.enabled, false);
    await f.dispose();
    assert.equal(f.routes.size, 0);
  },
);
