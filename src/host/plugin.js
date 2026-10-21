import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceStore } from "../core/store.js";
import { SkillLibrary } from "../core/skills.js";
import { Toolkit } from "../core/toolkit.js";
import { Templates } from "../core/templates.js";
import { Flow } from "../core/flow.js";
import { WorkspaceFiles } from "../core/files.js";
import { Controller } from "../server/controller.js";
import { createHandler } from "../server/http.js";
import { desktopContext } from "./desktop.js";
import { DesktopRuntime } from "./runtime.js";
import { connectSkills } from "./skills.js";
import { installTools } from "./tools.js";
import { DesktopSessions } from "./sessions.js";
import { HostExtensions } from "./extensions.js";
import { RetryPolicy } from "./retry-policy.js";
import { HostCatalog } from "./catalog.js";
import { DesktopWorkflow } from "./workflow.js";
import { Continuation } from "./continuation.js";
import { DrillAdmission } from "../core/admission.js";
import { LocalEnvironment } from "../core/environment.js";
import { DesktopWorkflowPlan } from "./workflow-plan.js";
import { RepeatReminder } from "./repeat-reminder.js";
import { ReadLimits } from "./read-limits.js";
import { DesktopMaintenance } from "./maintenance.js";
import { ConnectionChecks } from "../core/connection-checks.js";
import { NetworkScope } from "../core/network-scope.js";
import { CountryDatabase } from "../core/country-database.js";
import { WebScope } from "./web-scope.js";
import { DesktopProcesses } from "./processes.js";

export const name = "dsh-unlimit";
export const inject = ["webServer", "connection"];

// An explicit host argument is used only by isolated tests. The actual loader passes no such value.
export function mount(ctx, host) {
  mkdirSync(host.dataRoot, { recursive: true, mode: 0o700 });
  const databasePath = join(host.dataRoot, "workspace.sqlite");
  const store = new WorkspaceStore(databasePath);
  chmodSync(databasePath, 0o600);
  const skills = new SkillLibrary(join(host.dataRoot, "skills"));
  const toolkit = new Toolkit(store);
  const flow = new Flow(store);
  const files = new WorkspaceFiles(join(host.dataRoot, "materials"), store);
  const runtime = new DesktopRuntime(ctx, store, host);
  runtime.rolePrompt = (sessionId) => flow.rolePrompt(sessionId);
  const extensions = new HostExtensions(ctx, store);
  const retry = new RetryPolicy(ctx, store);
  const repeat = new RepeatReminder(ctx, store, host);
  const readLimits = new ReadLimits(ctx, store, host);
  const admission = new DrillAdmission(store, host.dataRoot);
  const processes = new DesktopProcesses(ctx, store, host, { toolkit, admission });
  const countryDatabase = new CountryDatabase(realpathSync(host.dataRoot));
  const networkScope = new NetworkScope(store, { database: countryDatabase, admission });
  const webScope = new WebScope(ctx, store, host, { scope: networkScope });
  const connectionChecks = new ConnectionChecks(store, { admission, scope: networkScope });
  const workflow = new DesktopWorkflow(ctx, store, flow, { admission });
  const environment = new LocalEnvironment(realpathSync(host.dataRoot));
  const catalog = new HostCatalog(ctx, { library: skills, toolkit, environment });
  const plans = new DesktopWorkflowPlan(workflow, { catalog });
  const continuation = new Continuation(ctx, store, host, { flow, workflow, admission });
  const sessions = new DesktopSessions(ctx, store, {
    host,
    enabled: () => runtime.enabled && runtime.settings().enabled,
  });
  let skillConnection;
  const controller = new Controller({
    store,
    skills,
    toolkit,
    templates: new Templates(toolkit),
    catalog,
    runtime,
    sessions,
    extensions,
    flow,
    files,
    retry,
    repeat,
    readLimits,
    workflow,
    continuation,
    admission,
    processes,
    connectionChecks,
    networkScope,
    webScope,
    plans,
    environment,
    host,
    maintenance: new DesktopMaintenance(ctx, host),
    onSkillsChanged: () => skillConnection?.changed(),
  });
  ctx.effect(() => async () => {
    const errors = [];
    for (const cleanup of [
      () => processes.close(),
      () => webScope.revert(),
      () => connectionChecks.close(),
      () => networkScope.close(),
      () => countryDatabase.close(),
      () => controller.revertControls(),
      async () => {
        const result = await plans.close();
        if (!result.stopped) throw new Error("多任务计划仍有未确认清理的执行者");
      },
      () => workflow.close(),
      () => sessions.close(),
      () => toolkit.close(),
      () => flow.close(),
      () => store.close(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "插件已尝试释放全部资源，部分还原步骤失败");
  });
  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: "/dsh-unlimit",
      handler: createHandler(controller, () => ctx.webServer.getOrigin(), {
        rejectRequest: (request) => ctx.connection.requestRejection(request),
      }),
    }),
  );
  ctx.on("agent/created", ({ agent }) => {
    if (!agent.session.header.parentSession) return;
    const parent = store.dispatch("workspaces.forSession", {
      sessionId: agent.session.header.parentSession,
    }).item;
    const own = store.dispatch("workspaces.forSession", { sessionId: agent.session.id }).item;
    if (parent && !own)
      store.dispatch("workspaces.bind", { id: parent.id, sessionId: agent.session.id });
  });
  const releaseSlot = (sessionId) => {
    if (workflow.controlsSession(sessionId) || continuation.controlsSession(sessionId)) return;
    const workspace = store.dispatch("workspaces.forSession", { sessionId }).item;
    if (workspace) flow.dispatch("flow.release", { workspaceId: workspace.id, sessionId });
  };
  ctx.on("agent/disposed", ({ agent }) => releaseSlot(agent.session.id));
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/end") releaseSlot(session.id);
  });
  ctx.inject(["skills"], (scope) => {
    skillConnection = connectSkills(scope, skills);
    scope.effect(() => () => {
      skillConnection = undefined;
    });
  });
  ctx.inject(["tools", "agents"], async (scope) => {
    await sessions.origins.connect();
    scope.effect(() => () => sessions.origins.close());
  });
  ctx.inject(["tools"], async (scope) => {
    const dispose = await installTools(scope, controller, host);
    scope.effect(() => dispose);
  });
  ctx.inject(["commands"], (scope) => {
    scope.commands.register({
      name: "unlimit",
      definitionId: "dsh-unlimit/command",
      description: "桌面运行控制：status / apply / revert",
      input: { hint: "status | apply | revert" },
      async handler({ rawInput }) {
        const command = rawInput.trim() || "status";
        const action = { status: "status", apply: "control.apply", revert: "control.revert" }[
          command
        ];
        if (!action) return { kind: "error", text: "用法：/unlimit status | apply | revert" };
        try {
          const value = await controller.dispatch(action);
          return {
            kind: "success",
            text: JSON.stringify(
              { version: value.version, enabled: value.enabled, capabilities: value.capabilities },
              null,
              2,
            ),
          };
        } catch (error) {
          return { kind: "error", text: error.message };
        }
      },
    });
  });
  ctx.inject(["systemPrompt", "approval", "sandboxPolicy"], async (scope) => {
    if (ctx.fiber.uid === null || scope.fiber.uid === null) return;
    runtime.ctx = scope;
    repeat.ctx = scope;
    readLimits.ctx = scope;
    webScope.ctx = scope;
    scope.effect(() => () => controller.revertControls());
    const settings = store.dispatch("settings.get").value;
    if (settings.enabled && settings.autoReapply && host.supported) {
      await controller.dispatch("control.apply");
    }
  });
  return controller;
}

export function apply(ctx) {
  mount(ctx, desktopContext());
}
