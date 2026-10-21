import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
function productionFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `Missing production function ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function \w+\(/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const panel = (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`;
const context = vm.createContext({ esc, panel });
vm.runInContext(
  ["continuationDetails", "continuationView"].map(productionFunction).join("\n"),
  context,
);
const status = (overrides = {}) => ({
  child: false,
  eligibleReason: "max-tokens",
  automaticCount: 2,
  limit: 3,
  autoEnabled: true,
  manualAvailable: true,
  ...overrides,
});
const manualRun = (overrides = {}) => ({
  id: "manual-1",
  runId: null,
  status: "starting",
  parentSessionId: "parent-1",
  workspaceId: "workspace-1",
  slotHeld: true,
  ...overrides,
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(respond = () => status()) {
  const nodes = new Map();
  let html = "";
  const element = {
    isConnected: true,
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      nodes.clear();
      for (const match of value.matchAll(/id="([^"]+)"([^>]*)/g))
        nodes.set(`#${match[1]}`, {
          disabled: /\bdisabled\b/.test(match[2]),
          isConnected: true,
        });
    },
    querySelector: (selector) => nodes.get(selector),
  };
  const calls = [];
  const confirmations = [];
  let current = true;
  const view = context.continuationView({
    element,
    api: async (action, payload) => {
      calls.push({ action, payload: { ...payload } });
      return respond(action, payload);
    },
    run: (_button, callback) => callback(),
    confirmAction: (...args) => confirmations.push(args),
    isCurrent: () => current,
  });
  return {
    view,
    calls,
    element,
    confirmations,
    node: (id) => nodes.get(`#${id}`),
    click: (id) => nodes.get(`#${id}`).onclick({ target: nodes.get(`#${id}`) }),
    leave: () => (current = false),
  };
}

test("root continuation retains automatic settings and availability comes only from backend", () => {
  const root = context.continuationDetails(
    status({ manualAvailable: false, pending: true, stopped: true }),
    "root-1",
  );
  assert.match(root, /根会话可手动或自动继续/);
  assert.match(root, /2 \/ 3/);
  assert.match(root, /自动继续已开启 · 等待提交 · 本次链已停止/);
  assert.match(root, /id="manual-continue" disabled/);
  assert.match(root, /停止本插件续跑/);
  assert.match(root, /仅控制本插件所属的自动继续或子会话手动续跑输入/);
  const child = context.continuationDetails(status({ child: true }), "child-1");
  assert.match(child, /手动继续子会话（新执行）/);
  assert.doesNotMatch(child, /id="manual-continue" disabled/);
  assert.match(child, /原任务记录保持不变/);
});

test("manual execution status, identifiers, errors and unsupported reasons are readable and escaped", () => {
  const unsafe = '<img src=x onerror="x">&';
  const html = context.continuationDetails(
    status({
      child: true,
      manualAvailable: false,
      eligibleReason: unsafe,
      unsupportedReason: unsafe,
      lastError: { message: unsafe },
      manualRun: manualRun({
        id: unsafe,
        parentSessionId: unsafe,
        workspaceId: unsafe,
        messageId: unsafe,
        error: unsafe,
      }),
    }),
    unsafe,
  );
  assert.match(html, /正在启动/);
  assert.match(html, /尚未分配/);
  assert.match(html, /占用中/);
  assert.match(html, /&lt;img src=x onerror=&quot;x&quot;&gt;&amp;/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /id="manual-continue" disabled/);
  for (const [value, label] of Object.entries({
    running: "运行中",
    completed: "已完成",
    truncated: "输出再次截断",
    failed: "失败",
    stopped: "已停止",
    released: "控制权已释放",
  })) {
    const rendered = context.continuationDetails(
      status({
        child: true,
        manualRun: manualRun({
          status: value,
          runId: "native-run",
          slotHeld: false,
          stopReason: "max-tokens",
        }),
      }),
      "child-1",
    );
    assert.match(rendered, new RegExp(`执行状态</span><span>${label}`));
    assert.match(rendered, /native-run/);
    assert.match(rendered, /结束原因<\/span><span>输出达到长度上限/);
    assert.match(rendered, /<details><summary>查看执行记录<\/summary>/);
    assert.match(rendered, /原始结束原因<\/span><span>max-tokens/);
    assert.ok(rendered.indexOf("并发名额") < rendered.indexOf("<details>"));
    assert.ok(rendered.indexOf("宿主运行标识") > rendered.indexOf("<details>"));
    assert.match(rendered, /并发名额<\/span><span>未占用/);
    if (value === "released") assert.match(rendered, /当前输入已由宿主接管/);
  }
  for (const [reason, label] of Object.entries({
    "max-tokens": "输出达到长度上限",
    aborted: "已取消",
    completed: "正常结束",
  })) {
    const rendered = context.continuationDetails(
      status({ child: true, manualRun: manualRun({ stopReason: reason }) }),
      "child-1",
    );
    const [visible, collapsed] = rendered.split("<details>");
    assert.match(visible, new RegExp(`结束原因</span><span>${label}`));
    assert.ok(collapsed.includes(`原始结束原因</span><span>${reason}`));
    assert.ok(collapsed.includes("manual-1"));
    assert.ok(collapsed.includes("parent-1"));
    assert.ok(collapsed.includes("workspace-1"));
  }
});

test("manual confirmation sends exact session payload and reads the resulting detail without full-page reset", async () => {
  let started = false;
  const ui = setup((action) => {
    if (action === "continuation.continue") {
      started = true;
      return { submitted: true };
    }
    return status({
      child: true,
      manualAvailable: !started,
      ...(started ? { manualRun: manualRun({ status: "running", runId: "new-run" }) } : {}),
    });
  });
  await ui.view.show("child-1");
  ui.click("manual-continue");
  assert.deepEqual(ui.calls, [
    { action: "continuation.status", payload: { sessionId: "child-1" } },
  ]);
  const [title, message, confirm, options] = ui.confirmations[0];
  assert.equal(title, "继续截断内容");
  for (const fact of ["当前保存", "角色", "新执行", "不复用原工作流任务回执", "父会话", "费用"])
    assert.ok(message.includes(fact), fact);
  assert.equal(options.keepPage, true);
  await confirm();
  assert.deepEqual(ui.calls, [
    { action: "continuation.status", payload: { sessionId: "child-1" } },
    { action: "continuation.continue", payload: { sessionId: "child-1" } },
    { action: "continuation.status", payload: { sessionId: "child-1" } },
  ]);
  assert.match(ui.element.innerHTML, /new-run/);
  assert.equal(ui.node("manual-continue").disabled, true);
});

test("root confirmation stays unchanged and unavailable manual action never submits", async () => {
  const ui = setup();
  await ui.view.show("root-1");
  ui.click("manual-continue");
  assert.match(ui.confirmations[0][1], /将采用当前继续用语和系统提示词提交新一轮/);
  assert.doesNotMatch(ui.confirmations[0][1], /角色|工作流/);
  const blocked = setup(() =>
    status({ child: true, manualAvailable: false, unsupportedReason: "等待当前执行结束" }),
  );
  await blocked.view.show("busy-child");
  blocked.click("manual-continue");
  assert.equal(blocked.confirmations.length, 0);
  assert.equal(blocked.calls.length, 1);
  assert.match(blocked.element.innerHTML, /等待当前执行结束/);
});

test("stop and refresh target the displayed session and stop reads back state", async () => {
  let stopped = false;
  const ui = setup((action) => {
    if (action === "continuation.stop") stopped = true;
    return status({ stopped });
  });
  await ui.view.show("root-1");
  await ui.click("stop-continuation");
  await ui.click("reload-continuation");
  assert.deepEqual(
    ui.calls.map(({ action }) => action),
    ["continuation.status", "continuation.stop", "continuation.status", "continuation.status"],
  );
  assert.ok(ui.calls.every(({ payload }) => JSON.stringify(payload) === '{"sessionId":"root-1"}'));
  assert.match(ui.element.innerHTML, /本次链已停止/);
});

test("late status reads and failures never replace a newer session selection", async () => {
  for (const failure of [false, true]) {
    const pending = deferred();
    const ui = setup((_action, { sessionId }) =>
      sessionId === "old" ? pending.promise : status(),
    );
    const old = ui.view.show("old");
    await ui.view.show("new");
    const html = ui.element.innerHTML;
    if (failure) pending.reject(new Error("old read failed"));
    else pending.resolve(status({ unsupportedReason: "old result" }));
    assert.equal(await old, false);
    assert.equal(ui.element.innerHTML, html);
    assert.match(html, /当前会话<\/span><span>new/);
  }
});

test("late mutations do not read or overwrite newer selection, and old confirmation cannot submit", async () => {
  for (const action of ["continuation.continue", "continuation.stop"]) {
    const pending = deferred();
    const ui = setup((method) => (method === action ? pending.promise : status()));
    await ui.view.show("old");
    let mutation;
    if (action === "continuation.continue") {
      ui.click("manual-continue");
      mutation = ui.confirmations[0][2]();
    } else mutation = ui.click("stop-continuation");
    await ui.view.show("new");
    const html = ui.element.innerHTML;
    pending.resolve({ stopped: true });
    await mutation;
    assert.equal(ui.element.innerHTML, html);
    assert.equal(ui.calls.filter(({ action }) => action === "continuation.status").length, 2);
  }
  const ui = setup();
  await ui.view.show("old");
  ui.click("manual-continue");
  await ui.view.show("new");
  await assert.rejects(ui.confirmations[0][2](), /会话或页面已切换/);
  assert.equal(
    ui.calls.some(({ action }) => action === "continuation.continue"),
    false,
  );
});

test("page changes, disposal and detached roots prevent late writes and new requests", async () => {
  for (const abandon of [
    (ui) => ui.leave(),
    (ui) => ui.view.dispose(),
    (ui) => {
      ui.element.isConnected = false;
    },
  ]) {
    const pending = deferred();
    const ui = setup(() => pending.promise);
    const reading = ui.view.show("old");
    abandon(ui);
    const html = ui.element.innerHTML;
    pending.resolve(status());
    assert.equal(await reading, false);
    await ui.view.show("other");
    assert.equal(ui.element.innerHTML, html);
    assert.equal(ui.calls.length, 1);
  }
});

test("sessions page uses page generation and disposal guards", async () => {
  let boundOptions;
  const state = { page: "sessions", request: 4, status: { sessions: [] }, workspaces: [] };
  const pageContext = vm.createContext({
    state,
    api() {},
    refreshStatus: async () => {},
    probeBridge: async () => {},
    heading: () => "",
    rewindSummary: () => "",
    panel,
    empty: () => "",
    render() {},
    $: () => ({}),
    $$: () => [],
    run() {},
    confirmAction() {},
    continuationView(options) {
      boundOptions = options;
      return {
        dispose() {
          boundOptions.disposed = true;
        },
      };
    },
  });
  vm.runInContext(productionFunction("sessionsPage"), pageContext);
  const page = await pageContext.sessionsPage();
  page.bind();
  assert.equal(boundOptions.isCurrent(), true);
  state.request++;
  assert.equal(boundOptions.isCurrent(), false);
  state.request--;
  state.page = "overview";
  assert.equal(boundOptions.isCurrent(), false);
  page.dispose();
  assert.equal(boundOptions.disposed, true);
  assert.doesNotMatch(source, /子代理暂不支持手动恢复|已结束的子任务尚不支持手动恢复/);
});

test("confirmation keeps continuation detail after readback while other actions retain normal page refresh", async () => {
  const nodes = new Map();
  let refreshes = 0;
  let closes = 0;
  let notices = 0;
  const dialog = {
    set innerHTML(value) {
      for (const node of nodes.values()) node.isConnected = false;
      nodes.clear();
      for (const match of value.matchAll(/id="([^"]+)"/g))
        nodes.set(`#${match[1]}`, { isConnected: true });
    },
    close: () => closes++,
    showModal() {},
  };
  const confirmContext = vm.createContext({
    esc,
    canLeaveEditor: () => true,
    $: (selector) => (selector === "#editor" ? dialog : nodes.get(selector)),
    run: (_button, callback) => callback(),
    render: async () => refreshes++,
    toast: () => notices++,
  });
  vm.runInContext(productionFunction("confirmAction"), confirmContext);
  const confirm = async (callback, options) => {
    confirmContext.confirmAction("继续", "合成确认", callback, options);
    const button = nodes.get("#accept-confirm");
    return button.onclick({ target: button });
  };
  let readback = false;
  await confirm(
    async () => {
      readback = true;
    },
    { keepPage: true },
  );
  assert.equal(readback, true);
  assert.deepEqual([refreshes, closes, notices], [0, 1, 1]);
  await confirm(async () => {});
  assert.deepEqual([refreshes, closes, notices], [1, 2, 2]);
  await confirm(async () => false, { keepPage: true });
  assert.deepEqual([refreshes, closes, notices], [1, 2, 2]);
  await confirm(
    async () => {
      confirmContext.confirmAction("新的确认", "合成数据", async () => {});
    },
    { keepPage: true },
  );
  assert.deepEqual([refreshes, closes, notices], [1, 2, 2]);
});
