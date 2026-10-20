import { SUPPORTED_HOST } from "./desktop.js";
import { fail, object } from "../core/validation.js";

const BUNDLE = "dsh-unlimit";
const applications = new Set(["applied", "restart-required", "failed", "overridden", "cancelled"]);

/**
 * Only the currently loaded, profile-owned bundle may be removed. The official
 * manager outlives this plugin; never touch its closed store after removeBundle.
 */
export class DesktopMaintenance {
  #pending = null;
  #result = null;
  #phase = "idle";

  constructor(ctx, host) {
    this.ctx = ctx;
    this.host = host;
  }

  get busy() {
    return this.#pending !== null || this.#result?.removed === true;
  }

  async inspect() {
    const unavailable = (detail) => ({ available: false, detail });
    if (
      this.host.kind !== "desktop" ||
      this.host.version !== SUPPORTED_HOST ||
      this.host.supported !== true
    )
      return unavailable("当前宿主尚未通过卸载接口适配检查");
    const manager =
      typeof this.ctx.get === "function" ? this.ctx.get("pluginManager") : this.ctx.pluginManager;
    if (
      typeof manager?.listBundles !== "function" ||
      typeof manager?.removeBundle !== "function" ||
      !manager.ownerContext
    )
      return unavailable("当前未提供官方插件管理器的查询与移除接口");
    const entryId = this.ctx.fiber?.entry?.id;
    if (typeof entryId !== "string" || !entryId)
      return unavailable("无法确认当前插件的官方加载条目");
    const bundles = await manager.listBundles();
    if (!Array.isArray(bundles)) throw new Error("官方插件目录返回了未知格式");
    const matches = bundles.filter((bundle) => bundle.name === BUNDLE);
    if (matches.length !== 1) return unavailable("未找到唯一的本插件安装记录");
    const bundle = matches[0];
    if (
      bundle.installed !== true ||
      bundle.availability !== "profile" ||
      bundle.removable !== true ||
      typeof bundle.source !== "string" ||
      !bundle.source ||
      bundle.readOnlyReason ||
      bundle.error
    )
      return unavailable("本插件不是当前 profile 中可独立移除的安装包");
    if (
      !bundle.rows?.some(
        (row) => row.entryId === entryId && row.rowId === BUNDLE && row.moduleName === BUNDLE,
      )
    )
      return unavailable("安装记录与当前加载实例不一致，未选择其他同名条目");
    return {
      available: true,
      manager,
      detail: "先还原运行控制并停止所属任务，再由官方管理器移除本插件",
    };
  }

  async info() {
    let current;
    try {
      current = this.#result?.removed
        ? { available: false, detail: "本插件安装包已移除" }
        : await this.inspect();
    } catch {
      current = { available: false, detail: "官方安装记录查询失败，卸载入口暂不可用" };
    }
    return {
      available: current.available && !this.busy,
      phase: this.#phase,
      detail: current.detail,
      bundle: BUNDLE,
      data: "preserved",
      automaticRestart: false,
      result: this.#result,
    };
  }

  async uninstall(payload, prepare) {
    object(payload);
    if (
      Object.keys(payload).some((key) => !["bundle", "confirmed"].includes(key)) ||
      payload.bundle !== BUNDLE ||
      payload.confirmed !== true
    )
      fail("INVALID_INPUT", "需明确确认卸载 dsh-unlimit 并保留本地资料");
    if (this.#pending) return this.#pending;
    if (this.#result?.removed) return this.#result;
    const operation = async () => {
      this.#result = null;
      this.#phase = "checking";
      const candidate = await this.inspect();
      if (!candidate.available) fail("UNSUPPORTED", candidate.detail);
      const manager = candidate.manager;
      this.#phase = "preparing";
      const prepared = await prepare();
      // Re-read ownership after awaited cleanup. Another manager action may
      // have changed the profile while tasks were stopping.
      const latest = await this.inspect();
      if (!latest.available || latest.manager.ownerContext !== manager.ownerContext)
        throw Object.assign(new Error("清理后安装状态已改变，未继续移除"), {
          code: "UNINSTALL_STATE_CHANGED",
          partial: { prepared, removed: false, managerCalled: false },
        });
      this.#phase = "removing";
      const unknown = (message) => {
        throw Object.assign(new Error(message), {
          code: "UNINSTALL_UNKNOWN",
          partial: { prepared, managerCalled: true },
        });
      };
      let result;
      try {
        result = await manager.removeBundle(BUNDLE);
      } catch {
        unknown("官方移除请求未返回完成结果；请在宿主插件管理器核对，未自动重试");
      }
      if (!result || typeof result.changed !== "boolean" || !applications.has(result.application))
        unknown("官方移除结果格式未知；请在宿主插件管理器核对");
      // From this point the plugin may already be disposed. Only the captured
      // root manager and plain values are safe to use.
      let remaining;
      try {
        remaining = await manager.listBundles();
        if (!Array.isArray(remaining)) throw new Error("Unknown bundle list");
      } catch {
        unknown("已收到官方移除结果，但未能确认安装记录；请在宿主插件管理器核对");
      }
      const installed = remaining.some((bundle) => bundle.name === BUNDLE && bundle.installed);
      const removed = !installed && ["applied", "restart-required"].includes(result.application);
      const receipt = {
        bundle: BUNDLE,
        removed,
        changed: result.changed,
        installationPresent: installed,
        application: result.application,
        restartRequired: result.application === "restart-required",
        prepared,
        data: "preserved",
        automaticRestart: false,
      };
      this.#result = receipt;
      this.#phase = removed ? result.application : "failed";
      if (!removed)
        throw Object.assign(
          new Error(
            result.application === "cancelled"
              ? "官方移除已取消；运行控制及演练确认已撤销，本地资料保留"
              : "官方移除未完成；运行控制及演练确认已撤销，请在宿主插件管理器核对",
          ),
          { code: "UNINSTALL_INCOMPLETE", partial: receipt },
        );
      return receipt;
    };
    this.#pending = operation();
    try {
      return await this.#pending;
    } catch (error) {
      if (this.#phase !== "failed") this.#phase = "failed";
      throw error;
    } finally {
      this.#pending = null;
    }
  }
}
