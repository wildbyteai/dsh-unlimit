import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fail, object } from "./validation.js";

export const ADMISSION_NOTICE = Object.freeze({
  version: 1,
  waitMs: 5000,
  title: "进入本地演练工作区",
  paragraphs: [
    "这里用于记录演练范围、资产与证据，也能按明确任务创建执行者。请先为每个项目写清目标、允许的操作和验收范围。",
    "进入工作区只记录本次安装的使用确认，不证明任何目标归你所有，也不授权访问真实系统、扩大权限、修改生产数据或下载工具。每次实际操作仍遵守宿主权限和该任务的授权。",
    "使用者负责核对证据来源。登记、检索、工具存在或任务计划都不等于实际执行成功；未验证内容应保留未验证状态。",
    "规则、技能和运行控制可独立使用。你可以稍后进入演练区，也可以在诊断页撤销本安装的确认；撤销将阻止新任务并尝试停止本项目管理的执行者。",
  ],
  checks: [
    { id: "scope", text: "我会逐个项目确认目标与操作范围。" },
    { id: "permissions", text: "我理解本次确认不授予目标访问或生产变更权限。" },
    { id: "evidence", text: "我会区分计划、登记、实际执行和可复核证据。" },
  ],
});
const KEY = "drill-admission-v1";
const TTL = 15 * 60 * 1000;

function fields(value, allowed) {
  object(value);
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    fail("INVALID_INPUT", "入场确认包含未知字段");
}

export class DrillAdmission {
  constructor(store, installationRoot, { clock = () => Date.now() } = {}) {
    this.store = store;
    this.clock = clock;
    this.rootKey = createHash("sha256").update(realpathSync(installationRoot)).digest("hex");
    this.challenges = new Map();
    const current = store.meta(KEY);
    if (!current || current.rootKey !== this.rootKey)
      store.setMeta(KEY, {
        rootKey: this.rootKey,
        installationId: randomUUID(),
        revision: 0,
        acceptedVersion: null,
        acceptedAt: null,
      });
  }
  state() {
    const value = this.store.meta(KEY);
    if (value?.rootKey !== this.rootKey)
      fail("INSTALLATION_CHANGED", "当前安装的确认状态已变化，请重新加载插件");
    return value;
  }
  status() {
    const value = this.state();
    return {
      installationId: value.installationId,
      revision: value.revision,
      accepted: value.acceptedVersion === ADMISSION_NOTICE.version,
      acceptedAt: value.acceptedAt,
      notice: ADMISSION_NOTICE,
      grantsTargetAuthorization: false,
      blocksOrdinaryChat: false,
    };
  }
  require() {
    if (!this.status().accepted)
      fail(
        "ADMISSION_REQUIRED",
        "请先在工作台完成演练区使用确认；普通聊天、规则和运行控制不受影响",
      );
  }
  begin(payload) {
    fields(payload, []);
    const now = this.clock();
    for (const [id, challenge] of this.challenges)
      if (challenge.expiresAt <= now) this.challenges.delete(id);
    if (this.challenges.size >= 32) fail("CONFLICT", "打开的确认页过多，请关闭旧页后再试");
    const id = randomUUID();
    const challenge = {
      revision: this.state().revision,
      readyAt: now + ADMISSION_NOTICE.waitMs,
      expiresAt: now + TTL,
      read: false,
    };
    this.challenges.set(id, challenge);
    return { challengeId: id, ...challenge, serverNow: now, notice: ADMISSION_NOTICE };
  }
  challenge(id) {
    if (typeof id !== "string" || !this.challenges.has(id))
      fail("CONFIRMATION_EXPIRED", "本次确认已失效，请重新打开确认页");
    const challenge = this.challenges.get(id);
    if (challenge.expiresAt <= this.clock()) {
      this.challenges.delete(id);
      fail("CONFIRMATION_EXPIRED", "本次确认已过期，请重新打开确认页");
    }
    if (challenge.revision !== this.state().revision)
      fail("CONFLICT", "入场状态已变化，请重新读取后确认");
    return challenge;
  }
  confirm(payload) {
    fields(payload, ["challengeId", "checks"]);
    const challenge = this.challenge(payload.challengeId);
    if (this.clock() < challenge.readyAt) fail("WAIT_REQUIRED", "倒计时尚未结束");
    if (!challenge.read) fail("READ_REQUIRED", "请阅读说明至末尾");
    fields(
      payload.checks,
      ADMISSION_NOTICE.checks.map((item) => item.id),
    );
    if (ADMISSION_NOTICE.checks.some(({ id }) => payload.checks[id] !== true))
      fail("ACKNOWLEDGEMENT_REQUIRED", "请逐项确认使用要求");
    const value = this.state();
    this.store.setMeta(KEY, {
      ...value,
      revision: value.revision + 1,
      acceptedVersion: ADMISSION_NOTICE.version,
      acceptedAt: new Date(this.clock()).toISOString(),
    });
    this.challenges.clear();
    return this.status();
  }
  revoke(payload) {
    fields(payload, ["revision"]);
    const value = this.state();
    if (payload.revision !== value.revision) fail("CONFLICT", "入场状态已变化，请刷新后重试");
    this.store.setMeta(KEY, {
      ...value,
      revision: value.revision + 1,
      acceptedVersion: null,
      acceptedAt: null,
    });
    this.challenges.clear();
    return this.status();
  }
  dispatch(action, payload = {}) {
    switch (action) {
      case "admission.status":
        fields(payload, []);
        return this.status();
      case "admission.begin":
        return this.begin(payload);
      case "admission.read":
        fields(payload, ["challengeId"]);
        this.challenge(payload.challengeId).read = true;
        return { readAcknowledged: true };
      case "admission.confirm":
        return this.confirm(payload);
      case "admission.revoke":
        return this.revoke(payload);
      default:
        fail("UNKNOWN_ACTION", "未知入场确认操作");
    }
  }
}
