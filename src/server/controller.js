import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readWorkspaceRule, workspaceInstructions } from "../core/workspace-rules.js";
import { fail, object, string } from "../core/validation.js";
import {
  selectedInstructions,
  selectedRule,
  selectPromptText,
  usesWorkspaceInstructions,
} from "../core/prompts.js";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const unavailable = (message) => {
  throw Object.assign(new Error(message), { code: "UNSUPPORTED" });
};
const controlActions = new Set([
  "control.apply",
  "control.revert",
  "settings.save",
  "rules.select",
  "rules.policy",
]);

export class Controller {
  #pending = new Set();
  #controlTail = Promise.resolve();

  constructor({
    store,
    runtime,
    skills,
    sessions,
    toolkit,
    host,
    extensions,
    flow,
    files,
    retry,
    repeat,
    readLimits,
    templates,
    catalog,
    workflow,
    continuation,
    admission,
    processes,
    plans,
    environment,
    maintenance,
    connectionChecks,
    networkScope,
    webScope,
    onSkillsChanged,
  }) {
    Object.assign(this, {
      store,
      runtime,
      skills,
      sessions,
      toolkit,
      host,
      extensions,
      flow,
      files,
      retry,
      repeat,
      readLimits,
      templates,
      catalog,
      workflow,
      continuation,
      admission,
      processes,
      plans,
      environment,
      maintenance,
      connectionChecks,
      networkScope,
      webScope,
      onSkillsChanged,
    });
  }
  #sequenceControl(operation) {
    const pending = this.#controlTail.then(operation);
    // Keep the queue usable after a failure; the caller still receives rejection.
    this.#controlTail = pending.catch(() => {});
    return pending;
  }
  revertControls() {
    return this.#sequenceControl(() => this.#revertControls());
  }
  async #revertControls() {
    const errors = [];
    for (const service of [
      this.webScope,
      this.continuation,
      this.repeat,
      this.readLimits,
      this.extensions,
      this.retry,
      this.runtime,
    ]) {
      try {
        await service?.revert();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "部分运行控制未能还原，请检查诊断状态");
  }
  async updateReadLimits(method) {
    const capability = this.readLimits?.capabilities().find((item) => item.id === "readLimit");
    if (capability && (capability.state !== "unsupported" || capability.owned))
      await this.readLimits[method]();
  }
  async status() {
    const sessionCapabilities = this.sessions?.capabilities?.() ?? {
      list: Boolean(this.sessions?.list),
      rewind: Boolean(this.sessions?.rewind),
    };
    const runtimeCapabilities = this.runtime.capabilities();
    const workflowCapabilities = this.workflow?.capabilities() ?? {};
    const processCapabilities = this.processes?.capabilities() ?? {};
    const maintenance = await this.maintenance?.info();
    const canApply =
      this.host.supported &&
      runtimeCapabilities
        .filter((item) => ["prompt", "approval", "sandbox"].includes(item.id))
        .every((item) => item.state !== "unsupported");
    const actions = [
      ["control.apply", canApply],
      ["control.revert", true],
      ["sessions.rewind", this.host.supported && sessionCapabilities.rewind],
      ["sessions.list", sessionCapabilities.list],
      ["autoReapply", this.host.supported],
      ...["list", "read", "save", "delete", "import"].map((operation) => [
        `skills.${operation}`,
        Boolean(this.skills),
      ]),
      ...["status", "save", "adapt", "probe"].map((operation) => [
        `toolkit.${operation}`,
        Boolean(this.toolkit),
      ]),
      ...["list", "read", "write", "delete", "import", "preview", "restore", "backups"].map(
        (operation) => [`files.${operation}`, Boolean(this.files)],
      ),
      ...["list", "read"].map((operation) => [`templates.${operation}`, Boolean(this.templates)]),
      ...["list", "read", "preflight"].map((operation) => [
        `catalog.${operation}`,
        Boolean(this.catalog),
      ]),
      ["workflow.dispatch", this.host.supported && workflowCapabilities.dispatch],
      ["workflow.stop", this.host.supported && workflowCapabilities.stop],
      ["workflow.status", Boolean(this.workflow)],
      ["workflow.presets", this.host.supported && workflowCapabilities.presets],
      ["workflow.plan.create", this.host.supported && this.plans?.capabilities().available],
      ["workflow.plan.propose", this.host.supported && this.plans?.capabilities().planDrafting],
      [
        "workflow.plan.run",
        this.host.supported && this.plans?.capabilities().automaticTaskMatching,
      ],
      ["workflow.plan.status", Boolean(this.plans)],
      ["workflow.plan.stop", Boolean(this.plans)],
      ["environment.status", Boolean(this.environment)],
      ...["start", "list", "output", "stop"].map((operation) => [
        `processes.${operation}`,
        Boolean(processCapabilities[operation]),
      ]),
      ["continuation.status", this.host.supported && Boolean(this.continuation)],
      ["continuation.stop", this.host.supported && Boolean(this.continuation)],
      ["maintenance.install", false],
      ["maintenance.uninstall", maintenance?.available === true],
      ...["prepare", "run", "status", "stop"].map((operation) => [
        `connectionChecks.${operation}`,
        Boolean(this.connectionChecks),
      ]),
      ...["status", "resolve", "import", "stop"].map((operation) => [
        `networkScope.${operation}`,
        Boolean(this.networkScope),
      ]),
    ];
    return {
      version: manifest.version,
      host: {
        kind: this.host.kind ?? "desktop",
        version: this.host.version,
        platform: this.host.platform,
        supported: this.host.supported,
      },
      enabled: this.runtime.enabled,
      capabilities: [
        ...runtimeCapabilities,
        ...(this.repeat?.capabilities() ?? []),
        ...(this.readLimits?.capabilities() ?? []),
        ...(this.webScope?.capabilities() ?? []),
        ...(this.continuation?.capabilities() ?? []),
        ...(this.retry?.capabilities() ?? []).map((item) =>
          this.host.supported
            ? item
            : { ...item, state: "unsupported", detail: "此宿主版本尚未通过重试策略适配验证" },
        ),
        ...(this.extensions?.capabilities() ?? []),
        ...actions.map(([id, available]) => ({
          id,
          label: id,
          state: available ? "available" : "unsupported",
          detail: available ? "" : "尚无可验证的当前宿主适配",
        })),
      ],
      settings: this.store.dispatch("settings.get", {}),
      permissionDefaults: this.runtime.permissionDefaults?.status(),
      admission: this.admission?.status(),
      sessions: sessionCapabilities.list ? await this.sessions.list() : [],
      sessionCapabilities,
      workflowCapabilities,
      processCapabilities,
      updates: { mode: "offline" },
    };
  }
  async dispatch(action, payload = {}, execution) {
    if (action === "maintenance.uninstall") {
      if (!this.maintenance) return unavailable("当前未提供可验证的官方卸载接口");
      return this.maintenance.uninstall(payload, () => this.prepareUninstall());
    }
    if (action === "maintenance.info") {
      return {
        mode: "offline",
        version: manifest.version,
        instructions:
          "运行 npm run pack:local 生成本地包。当前宿主接口没有逐次离线执行选项，工作台不执行安装或升级；请在宿主插件管理器核对安装方式。本插件不自动访问发布服务器。",
        uninstall: this.maintenance
          ? await this.maintenance.info()
          : {
              available: false,
              phase: "unsupported",
              detail: "当前未提供可验证的官方卸载接口",
              data: "preserved",
              automaticRestart: false,
            },
      };
    }
    if (this.maintenance?.busy)
      throw Object.assign(new Error("正在卸载或已经移除本插件，请在宿主插件管理器查看状态"), {
        code: "MAINTENANCE_BUSY",
      });
    const pending = controlActions.has(action)
      ? this.#sequenceControl(() => this.route(action, payload, execution))
      : this.route(action, payload, execution);
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }

  async prepareUninstall() {
    const prepared = {
      controlsDisabled: false,
      admissionRevoked: false,
      steps: [],
      data: "preserved",
    };
    const step = async (id, operation) => {
      try {
        await operation();
        prepared.steps.push({ id, status: "completed" });
      } catch {
        prepared.steps.push({ id, status: "failed" });
      }
    };
    if (this.connectionChecks) await step("checks", () => this.connectionChecks.stopAll());
    if (this.networkScope) await step("scope", () => this.networkScope.stopAll());
    if (this.webScope) await step("http", () => this.webScope.stopAll());
    if (this.processes)
      await step("processes", async () => {
        const result = await this.processes.stopAll();
        if (!result.stopped) throw new Error("Owned processes remain active");
      });
    if (typeof this.continuation?.stopAll === "function")
      await step("continuation", () => this.continuation.stopAll({ revoke: true }));
    // Cancel owned connections before draining accepted actions. No new action
    // enters while maintenance is active; awaited apply/save still finish.
    await Promise.allSettled([...this.#pending]);
    await step("settings", () => {
      const current = this.store.dispatch("settings.get", {});
      const saved = current.value.enabled
        ? this.store.dispatch("settings.save", {
            revision: current.revision,
            value: { ...current.value, enabled: false },
          })
        : current;
      prepared.settingsRevision = saved.revision;
    });
    await step("admission", () => {
      if (this.admission) {
        const result = this.admission.dispatch("admission.revoke", {
          revision: this.admission.status().revision,
        });
        prepared.admissionRevision = result.revision;
      }
      prepared.admissionRevoked = true;
    });
    for (const id of ["plans", "workflow"])
      await step(id, async () => {
        const result = await this[id]?.stopAll();
        if (result?.stopped === false) throw new Error("Owned tasks remain active");
      });
    await step("presets", () => this.workflow?.presets({ operation: "unregister" }));
    await step("controls", async () => {
      await this.revertControls();
      prepared.controlsDisabled =
        prepared.steps.find((item) => item.id === "settings").status === "completed";
    });
    await step("probes", async () => {
      const result = await this.toolkit?.cancelProbes();
      if (result?.stopped === false) throw new Error("Owned probes remain active");
    });
    if (prepared.steps.some((item) => item.status === "failed"))
      throw Object.assign(
        new Error("卸载准备未完成，未调用官方移除；已完成的还原与撤销保留，请核对失败步骤后重试"),
        {
          code: "UNINSTALL_PREPARATION_FAILED",
          partial: { prepared, removed: false, managerCalled: false },
        },
      );
    return prepared;
  }

  async route(action, payload = {}, execution) {
    const cleanupOrStatus =
      [
        "workflow.status",
        "workflow.stop",
        "workflow.capabilities",
        "workflow.plan.capabilities",
        "workflow.plan.status",
        "workflow.plan.stop",
        "flow.status",
        "flow.release",
        "connectionChecks.stop",
      ].includes(action) ||
      (action === "workflow.presets" &&
        ["status", "unregister"].includes(payload.operation ?? "status"));
    if (
      /^(workspaces|assets|findings|records|roles|report|flow|files|workflow|knowledge|connectionChecks)\./.test(
        action,
      ) &&
      !cleanupOrStatus
    )
      this.admission?.require();
    if (
      ["flow.assign", "flow.release", "workspaces.bind"].includes(action) &&
      (this.workflow?.controlsSession(payload.sessionId) ||
        this.continuation?.controlsSession?.(payload.sessionId))
    )
      throw Object.assign(
        new Error("该会话由演练执行者管理，请先通过执行者停止操作确认结束，再修改角色、绑定或槽位"),
        { code: "CONFLICT" },
      );
    switch (action) {
      case "admission.revoke": {
        if (!this.admission) return unavailable("演练入场确认服务未加载");
        const result = this.admission.dispatch(action, payload);
        const errors = [];
        try {
          await this.continuation?.stopAll?.({ projectsOnly: true, revoke: true });
        } catch (error) {
          errors.push(error);
        }
        for (const service of [
          this.connectionChecks,
          this.networkScope,
          this.processes,
          this.plans,
          this.workflow,
        ])
          try {
            const stopped = await service?.stopAll();
            if (stopped?.stopped === false) errors.push(new Error("执行计划仍有未确认清理的收据"));
          } catch (error) {
            errors.push(error);
          }
        if (errors.length)
          throw Object.assign(
            new Error(
              "本安装的演练确认已撤销，但部分执行者尚未确认停止；可在诊断页再次执行撤销以重试清理。",
            ),
            {
              code: "ADMISSION_REVOKED_PARTIAL",
              partial: { accepted: false, revision: result.revision },
            },
          );
        return result;
      }
      case "status":
        return this.status();
      case "prompt.preview": {
        object(payload);
        const model = string(payload.model, "model", { optional: true, empty: true }) || undefined;
        const directory =
          string(payload.directory, "directory", { optional: true, empty: true }) || undefined;
        if (directory && !isAbsolute(directory))
          fail("INVALID_DIRECTORY", "请提供工作区的绝对目录");
        const saved = this.store.dispatch("settings.get", {});
        const rule = selectedRule(this.store.dispatch("rules.list", {}), model);
        const readWorkspace =
          usesWorkspaceInstructions(saved.value, rule) && saved.value.workspaceFiles.length > 0;
        if (readWorkspace && !directory)
          fail("INVALID_DIRECTORY", "所选工作区规则参与正文，需要明确填写工作区目录");
        const workspaceText = readWorkspace
          ? selectedInstructions(directory, saved.value.workspaceFiles)
          : "";
        const selected = selectPromptText(saved.value, { rule, workspaceText });
        return {
          revision: saved.revision,
          model: model ?? null,
          directory: directory ?? null,
          enabled: this.runtime.enabled && saved.value.enabled,
          mode: saved.value.promptMode,
          source: selected.source,
          rule:
            selected.source === "rule"
              ? { id: rule.id, name: rule.name, model: rule.model || null }
              : null,
          workspace: {
            policy: saved.value.workspacePolicy,
            selectedPaths: readWorkspace ? [...saved.value.workspaceFiles] : [],
            included: selected.workspaceIncluded,
          },
          text: selected.text,
        };
      }
      case "control.apply": {
        const current = this.store.dispatch("settings.get", {});
        this.runtime.apply();
        try {
          if (this.retry?.capabilities().some((item) => item.state !== "unsupported"))
            this.retry.apply();
          if (this.continuation?.capabilities().some((item) => item.state !== "unsupported"))
            await this.continuation.apply();
          this.extensions?.apply();
          await this.repeat?.apply();
          await this.updateReadLimits("apply");
          if (
            this.webScope?.capabilities().some((item) => item.state !== "unsupported" || item.owned)
          )
            await this.webScope.apply();
          this.store.dispatch("settings.save", {
            revision: current.revision,
            value: { ...current.value, enabled: true },
          });
        } catch (error) {
          try {
            await this.#revertControls();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "运行控制应用失败，部分撤销未完成");
          }
          throw error;
        }
        try {
          this.runtime.permissionDefaults?.changed();
        } catch (error) {
          throw Object.assign(
            new Error(`运行控制已启用，但权限目录变更通知未确认：${error.message}`),
            { code: "CONTROLS_APPLIED_PARTIAL", partial: { enabled: true } },
          );
        }
        return this.status();
      }
      case "control.revert": {
        const current = this.store.dispatch("settings.get", {});
        this.store.dispatch("settings.save", {
          revision: current.revision,
          value: { ...current.value, enabled: false },
        });
        await this.#revertControls();
        return this.status();
      }
      case "settings.save": {
        const current = this.store.dispatch("settings.get", {});
        if (
          payload.value?.enabled !== undefined &&
          payload.value.enabled !== current.value.enabled
        ) {
          throw new Error("启用状态请通过应用或还原操作更改");
        }
        if (
          payload.value?.permissionDefault !== undefined &&
          payload.value.permissionDefault !== current.value.permissionDefault
        ) {
          if (!this.runtime.permissionDefaults && payload.value.permissionDefault !== "")
            return unavailable("当前宿主没有已验证的新会话权限预设接口");
          this.runtime.permissionDefaults?.validate(payload.value.permissionDefault);
        }
        const result = this.store.dispatch(action, payload);
        const errors = [];
        for (const change of [
          ...(JSON.stringify(current.value.ownServers) !== JSON.stringify(result.value.ownServers)
            ? [
                () => this.networkScope?.changed(),
                () => this.connectionChecks?.stopAll(),
                () => this.webScope?.stopAll(),
              ]
            : []),
          () => this.continuation?.changed(),
          ...(this.runtime.enabled
            ? [
                () => this.runtime.permissionDefaults?.changed(),
                () => this.repeat?.changed(),
                () => this.updateReadLimits("changed"),
              ]
            : []),
        ]) {
          try {
            await change();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw Object.assign(
            new Error(
              `配置已保存，但部分运行控制未更新：${errors.map((error) => error.message).join("；")}。请刷新诊断状态。`,
            ),
            {
              code: "SETTINGS_APPLIED_PARTIAL",
              partial: { savedRevision: result.revision },
            },
          );
        }
        return result;
      }
      case "rules.workspace":
        return { items: workspaceInstructions(payload.directory) };
      case "rules.preview":
        return { item: readWorkspaceRule(payload) };
      case "rules.select":
      case "rules.policy": {
        const current = this.store.dispatch("settings.get", {});
        const change =
          action === "rules.select"
            ? { workspaceFiles: payload.paths }
            : { workspacePolicy: payload.policy };
        return this.store.dispatch("settings.save", {
          revision: payload.revision,
          value: { ...current.value, ...change },
        });
      }
      case "sessions.list":
        if (!sessionCapabilitiesFor(this.sessions))
          return unavailable("当前宿主没有已验证的会话列表接口");
        return { items: await this.sessions.list() };
      case "sessions.prepare":
        if (!this.host.supported) return unavailable("此宿主版本尚未通过会话回退适配验证");
        if (!this.sessions?.prepare) return unavailable("当前宿主没有已验证的会话回退适配");
        return this.sessions.prepare(payload);
      case "sessions.rewind":
        if (!this.host.supported) return unavailable("此宿主版本尚未通过会话回退适配验证");
        if (!this.sessions?.rewind) return unavailable("当前宿主没有已验证的会话回退适配");
        return this.sessions.rewind(payload);
      case "sessions.attachment":
        if (!this.host.supported) return unavailable("此宿主版本尚未通过会话附件恢复适配验证");
        if (!this.sessions?.attachment) return unavailable("当前宿主没有已验证的附件恢复接口");
        return this.sessions.attachment(payload);
      case "sessions.releaseAttachments":
        if (!this.sessions?.releaseAttachments) return unavailable("附件恢复接口未加载");
        return this.sessions.releaseAttachments(payload);
      case "diagnostics.run":
        return {
          ...(await this.status()),
          checks: this.runtime.capabilities().map((item) => ({
            name: item.label,
            ok: item.state !== "unsupported",
            detail: item.detail,
          })),
        };
      case "maintenance.install":
        return unavailable("当前宿主安装接口没有逐次离线执行选项，本版不提供离线安装或升级");
      default:
        if (action.startsWith("networkScope.")) {
          if (!this.networkScope) return unavailable("范围管理服务未加载");
          const changesScope = ["networkScope.resolve", "networkScope.import"].includes(action);
          const before = changesScope ? this.networkScope.status().revision : null;
          try {
            return await this.networkScope.dispatch(action, payload);
          } finally {
            if (changesScope && this.networkScope.status().revision !== before)
              await Promise.all([this.connectionChecks?.stopAll(), this.webScope?.stopAll()]);
          }
        }
        if (action.startsWith("connectionChecks.")) {
          if (!this.connectionChecks) return unavailable("连接检查服务未加载");
          return this.connectionChecks.dispatch(action, payload);
        }
        if (action.startsWith("admission.")) {
          if (!this.admission) return unavailable("演练入场确认服务未加载");
          return this.admission.dispatch(action, payload);
        }
        if (action.startsWith("environment.")) {
          if (!this.environment) return unavailable("本地环境配置服务未加载");
          return this.environment.dispatch(action, payload);
        }
        if (action.startsWith("processes.")) {
          if (!this.processes) return unavailable("本地进程服务未加载");
          return this.processes.dispatch(action, payload, execution);
        }
        if (action.startsWith("workflow.plan.")) {
          if (!this.plans) return unavailable("多任务计划服务未加载");
          if (action === "workflow.plan.capabilities" && !this.host.supported)
            return {
              ...this.plans.capabilities(),
              available: false,
              planDrafting: false,
              automaticTaskMatching: false,
              reasons: ["此宿主版本尚未通过多任务调度适配验证"],
            };
          if (
            ["workflow.plan.create", "workflow.plan.propose", "workflow.plan.run"].includes(
              action,
            ) &&
            !this.host.supported
          )
            return unavailable("此宿主版本尚未通过多任务调度适配验证");
          return this.plans.dispatch(action, payload);
        }
        if (action.startsWith("continuation.")) {
          if (!this.host.supported || !this.continuation)
            return unavailable("此宿主版本尚无可验证的继续服务");
          const method = {
            "continuation.status": "status",
            "continuation.continue": "continue",
            "continuation.stop": "stop",
          }[action];
          if (!method) return unavailable("未知继续操作");
          return this.continuation[method](payload);
        }
        if (action.startsWith("workflow.")) {
          if (!this.workflow) return unavailable("演练执行者服务未加载");
          if (
            !this.host.supported &&
            !["workflow.status", "workflow.capabilities"].includes(action) &&
            !(
              action === "workflow.presets" &&
              (!payload.operation || payload.operation === "status")
            )
          )
            return unavailable("此宿主版本尚未通过执行者调度适配验证");
          return this.workflow.dispatch(action, payload);
        }
        if (action.startsWith("catalog.")) {
          if (!this.catalog) return unavailable("宿主技能与工具目录服务未加载");
          return this.catalog.dispatch(action, payload);
        }
        if (action.startsWith("templates.")) {
          if (!this.templates) return unavailable("本地模板目录服务未加载");
          return this.templates.dispatch(action, payload);
        }
        if (action.startsWith("files.")) {
          if (!this.files) return unavailable("工作区材料服务未加载");
          return this.files.dispatch(action, payload);
        }
        if (action.startsWith("flow.")) {
          if (!this.flow) return unavailable("本地演练流程服务未加载");
          return this.flow.dispatch(action, payload);
        }
        if (action.startsWith("skills.")) {
          if (!this.skills) return unavailable("技能库未配置");
          const result = this.skills.dispatch(action, payload);
          if (["skills.save", "skills.delete", "skills.import"].includes(action))
            this.onSkillsChanged?.();
          return result;
        }
        if (action.startsWith("toolkit.")) {
          if (!this.toolkit) return unavailable("工具环境未配置");
          return this.toolkit.dispatch(action, payload);
        }
        return this.store.dispatch(action, payload);
    }
  }
}

function sessionCapabilitiesFor(sessions) {
  return typeof sessions?.list === "function" && (sessions.capabilities?.().list ?? true);
}
