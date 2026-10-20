import { readFileSync } from "node:fs";
import { workspaceInstructions } from "../core/prompts.js";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const unavailable = (message) => {
  throw Object.assign(new Error(message), { code: "UNSUPPORTED" });
};

export class Controller {
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
    templates,
    catalog,
    workflow,
    continuation,
    admission,
    plans,
    environment,
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
      templates,
      catalog,
      workflow,
      continuation,
      admission,
      plans,
      environment,
      onSkillsChanged,
    });
  }
  async revertControls() {
    const errors = [];
    for (const service of [this.continuation, this.extensions, this.retry, this.runtime]) {
      try {
        await service?.revert();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "部分运行控制未能还原，请检查诊断状态");
  }
  async status() {
    const sessionCapabilities = this.sessions?.capabilities?.() ?? {
      list: Boolean(this.sessions?.list),
      rewind: Boolean(this.sessions?.rewind),
    };
    const runtimeCapabilities = this.runtime.capabilities();
    const workflowCapabilities = this.workflow?.capabilities() ?? {};
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
      ["workflow.plan.status", Boolean(this.plans)],
      ["workflow.plan.stop", Boolean(this.plans)],
      ["environment.status", Boolean(this.environment)],
      ["continuation.status", this.host.supported && Boolean(this.continuation)],
      ["continuation.stop", this.host.supported && Boolean(this.continuation)],
      ["maintenance.install", false],
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
      admission: this.admission?.status(),
      sessions: sessionCapabilities.list ? await this.sessions.list() : [],
      sessionCapabilities,
      workflowCapabilities,
      updates: { mode: "offline" },
    };
  }
  async dispatch(action, payload = {}) {
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
      ].includes(action) ||
      (action === "workflow.presets" &&
        ["status", "unregister"].includes(payload.operation ?? "status"));
    if (
      /^(workspaces|assets|findings|records|roles|report|flow|files|workflow|knowledge)\./.test(
        action,
      ) &&
      !cleanupOrStatus
    )
      this.admission?.require();
    if (
      ["flow.assign", "flow.release", "workspaces.bind"].includes(action) &&
      this.workflow?.controlsSession(payload.sessionId)
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
        for (const service of [this.plans, this.workflow])
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
      case "control.apply": {
        const current = this.store.dispatch("settings.get", {});
        this.runtime.apply();
        try {
          if (this.retry?.capabilities().some((item) => item.state !== "unsupported"))
            this.retry.apply();
          if (this.continuation?.capabilities().some((item) => item.state !== "unsupported"))
            await this.continuation.apply();
          this.extensions?.apply();
          this.store.dispatch("settings.save", {
            revision: current.revision,
            value: { ...current.value, enabled: true },
          });
        } catch (error) {
          try {
            await this.revertControls();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "运行控制应用失败，部分撤销未完成");
          }
          throw error;
        }
        return this.status();
      }
      case "control.revert": {
        const current = this.store.dispatch("settings.get", {});
        this.store.dispatch("settings.save", {
          revision: current.revision,
          value: { ...current.value, enabled: false },
        });
        await this.revertControls();
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
        const result = this.store.dispatch(action, payload);
        try {
          await this.continuation?.changed();
        } catch (error) {
          throw Object.assign(
            new Error(`配置已保存，但自动继续停止未确认：${error.message}。请刷新后检查当前会话。`),
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
      case "rules.select":
      case "rules.policy": {
        const current = this.store.dispatch("settings.get", {});
        const change =
          action === "rules.select"
            ? { workspaceFiles: payload.paths }
            : { workspacePolicy: payload.policy };
        return this.store.dispatch("settings.save", {
          revision: current.revision,
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
      case "maintenance.info":
        return {
          mode: "offline",
          version: manifest.version,
          instructions:
            "在源码目录运行 npm run build 和 npm run pack:local。通过桌面端插件管理器安装生成的本地包；本插件不自动访问发布服务器。",
        };
      case "maintenance.install":
        return unavailable("此版尚未验证桌面端的本地包安装接口，请使用宿主插件管理器");
      default:
        if (action.startsWith("admission.")) {
          if (!this.admission) return unavailable("演练入场确认服务未加载");
          return this.admission.dispatch(action, payload);
        }
        if (action.startsWith("environment.")) {
          if (!this.environment) return unavailable("本地环境配置服务未加载");
          return this.environment.dispatch(action, payload);
        }
        if (action.startsWith("workflow.plan.")) {
          if (!this.plans) return unavailable("多任务计划服务未加载");
          if (action === "workflow.plan.capabilities" && !this.host.supported)
            return {
              ...this.plans.capabilities(),
              available: false,
              reasons: ["此宿主版本尚未通过多任务调度适配验证"],
            };
          if (action === "workflow.plan.create" && !this.host.supported)
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
