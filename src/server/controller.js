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
      onSkillsChanged,
    });
  }
  async status() {
    const sessionCapabilities = this.sessions?.capabilities?.() ?? {
      list: Boolean(this.sessions?.list),
      rewind: Boolean(this.sessions?.rewind),
    };
    const runtimeCapabilities = this.runtime.capabilities();
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
        ...(this.extensions?.capabilities() ?? []),
        ...actions.map(([id, available]) => ({
          id,
          label: id,
          state: available ? "available" : "unsupported",
          detail: available ? "" : "尚无可验证的当前宿主适配",
        })),
      ],
      settings: this.store.dispatch("settings.get", {}),
      sessions: sessionCapabilities.list ? await this.sessions.list() : [],
      sessionCapabilities,
      updates: { mode: "offline" },
    };
  }
  async dispatch(action, payload = {}) {
    switch (action) {
      case "status":
        return this.status();
      case "control.apply": {
        const current = this.store.dispatch("settings.get", {});
        this.runtime.apply();
        try {
          this.extensions?.apply();
          this.store.dispatch("settings.save", {
            revision: current.revision,
            value: { ...current.value, enabled: true },
          });
        } catch (error) {
          try {
            this.extensions?.revert();
          } finally {
            this.runtime.revert();
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
        try {
          this.extensions?.revert();
        } finally {
          this.runtime.revert();
        }
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
        return this.store.dispatch(action, payload);
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
