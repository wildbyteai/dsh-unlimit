import test from "node:test";
import assert from "node:assert/strict";
import {
  uninstallConfirmation,
  uninstallSection,
  uninstallFlow,
  renderReceipt,
} from "../web/maintenance.js";

const prepared = {
  controlsDisabled: true,
  admissionRevoked: true,
  steps: [
    { id: "controls", status: "completed" },
    { id: "probes", status: "completed" },
  ],
  data: "preserved",
};
const removed = {
  bundle: "dsh-unlimit",
  removed: true,
  changed: true,
  application: "applied",
  restartRequired: false,
  prepared,
  data: "preserved",
  automaticRestart: false,
};

test("unavailable uninstall is disabled and explains the actual reason with escaped text", () => {
  const unavailable = uninstallSection({ available: false, detail: '<script>"host"</script>' });
  assert.match(unavailable, /id="uninstall-plugin" disabled/);
  assert.match(unavailable, /&lt;script&gt;&quot;host&quot;&lt;\/script&gt;/);
  assert.doesNotMatch(unavailable, /<script>/);
  assert.match(uninstallSection(), /当前接口未提供卸载能力/);
  assert.doesNotMatch(uninstallSection({ available: true }), / disabled/);
  for (const fact of [
    "运行控制",
    "演练确认",
    "任务和探测",
    "官方插件管理器",
    "数据库",
    "不会自动重启",
  ])
    assert.ok(uninstallConfirmation.includes(fact), fact);
});

test("cancelled confirmation sends no request and permits a later explicit attempt", async () => {
  const calls = [];
  let accepted = false;
  const flow = uninstallFlow({
    confirm: async () => accepted,
    api: async (...args) => {
      calls.push(args);
      return removed;
    },
    pending: () => calls.push("pending"),
    outcome: (value) => calls.push(value),
  });
  await flow();
  assert.deepEqual(calls, []);
  accepted = true;
  await flow();
  assert.deepEqual(calls[1], ["maintenance.uninstall", { bundle: "dsh-unlimit", confirmed: true }]);
  assert.equal(calls[2].receipt, removed);
});

test("double clicks and repeated calls after removal never issue a second mutation or status read", async () => {
  let finish;
  const response = new Promise((resolve) => (finish = resolve));
  const calls = [];
  const outcomes = [];
  const flow = uninstallFlow({
    confirm: async () => true,
    api: async (action) => {
      calls.push(action);
      return response;
    },
    pending() {},
    outcome: (value) => outcomes.push(value),
  });
  const first = flow();
  await Promise.resolve();
  await flow();
  finish(removed);
  await first;
  await flow();
  assert.deepEqual(calls, ["maintenance.uninstall"]);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].receipt, removed);
});

test("unknown transport result remains an error with no automatic or manual resubmission", async () => {
  const failure = new Error("synthetic connection lost");
  let requests = 0;
  let outcome;
  const flow = uninstallFlow({
    confirm: async () => true,
    api: async () => {
      requests++;
      throw failure;
    },
    pending() {},
    outcome: (value) => (outcome = value),
  });
  await flow();
  await flow();
  assert.equal(requests, 1);
  assert.equal(outcome.error, failure);
  const html = renderReceipt(outcome);
  assert.match(html, /卸载未确认完成/);
  assert.match(html, /宿主插件管理器核对安装与运行状态/);
  assert.match(html, /未自动重试/);
  assert.doesNotMatch(html, /<button|本插件已卸载/);
});

test("an incomplete official receipt keeps actual partial facts and never treats changed as success", async () => {
  const receipt = {
    ...removed,
    removed: false,
    application: "failed",
    installationPresent: false,
  };
  const error = Object.assign(new Error('<img src=x onerror="alert(1)">'), {
    code: "UNINSTALL_INCOMPLETE",
    partial: receipt,
  });
  let outcome;
  const flow = uninstallFlow({
    confirm: async () => true,
    api: async () => {
      throw error;
    },
    pending() {},
    outcome: (value) => (outcome = value),
  });
  await flow();
  assert.equal(outcome.receipt, receipt);
  const html = renderReceipt(outcome);
  assert.match(html, /安装记录仍存在<\/span><span>否/);
  assert.match(html, /官方管理器发生变更<\/span><span>是/);
  assert.match(html, /还原运行控制<\/span><span>已完成/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|本插件已卸载/);
});

test("preparation failure shows failed cleanup and that the official manager was not called", () => {
  const html = renderReceipt({
    error: { code: "UNINSTALL_PREPARATION_FAILED", message: "清理未完成" },
    receipt: {
      removed: false,
      managerCalled: false,
      prepared: { ...prepared, steps: [{ id: "probes", status: "failed" }] },
    },
  });
  assert.match(html, /已调用官方移除<\/span><span>否/);
  assert.match(html, /停止所属探测<\/span><span>失败/);
  assert.match(html, /本地资料<\/span><span>保留/);
  assert.doesNotMatch(html, /本插件已卸载/);
});

test("a malformed successful transport response cannot be rendered as completed removal", async () => {
  let outcome;
  const flow = uninstallFlow({
    confirm: async () => true,
    api: async () => ({ changed: true, application: "applied" }),
    pending() {},
    outcome: (value) => (outcome = value),
  });
  await flow();
  assert.equal(outcome.error.code, "UNINSTALL_UNKNOWN");
  assert.doesNotMatch(renderReceipt(outcome), /本插件已卸载/);
});

test("successful restart-required receipt stays read-only and instructs the user to restart later", () => {
  const html = renderReceipt({
    receipt: { ...removed, application: "restart-required", restartRequired: true },
  });
  assert.match(html, /本插件已卸载/);
  assert.match(html, /稍后自行重启宿主/);
  assert.match(html, /不会自动重启宿主/);
  assert.doesNotMatch(html, /<button/);
});
