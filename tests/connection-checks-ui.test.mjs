import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionCheckFlow,
  connectionCheckNotice,
  connectionCheckPanel,
  connectionPreview,
  connectionResults,
  connectionResultText,
} from "../web/connection-checks.js";

const status = { workspaceId: "synthetic", active: false, completed: 0, total: 0, items: [] };
const ready = {
  recordId: "one",
  kind: "webshell",
  name: "测试记录",
  target: "https://fixture.invalid/?q=one",
  checkType: "http",
  state: "ready",
  reason: "",
  lastCheck: null,
  stale: false,
};
const prepared = {
  workspaceId: "synthetic",
  recordIds: ["one"],
  snapshot: "synthetic-snapshot",
  items: [ready],
};
const result = {
  workspaceId: "synthetic",
  cancelled: false,
  items: [
    {
      ...ready,
      state: "reachable",
      reason: "http-response",
      checkedAt: "2026-10-21T00:00:00.000Z",
      latencyMs: 12,
      persisted: true,
      transport: { type: "http", address: "192.0.2.1", family: "IPv4", httpStatus: 403 },
    },
  ],
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
function setup(options = {}) {
  const calls = [];
  const changes = [];
  const flow = connectionCheckFlow({
    workspaceId: "synthetic",
    initialStatus: status,
    confirm: async () => true,
    changed: (view) => changes.push(view),
    ...options,
    api: async (action, payload) => {
      calls.push([action, payload]);
      if (options.api) return options.api(action, payload);
      return action.endsWith("prepare") ? prepared : action.endsWith("run") ? result : status;
    },
  });
  return { flow, calls, changes };
}

test("cancel or closing confirmation prepares read-only but sends no run or stop", async () => {
  for (const answer of [false, undefined]) {
    const { flow, calls } = setup({
      confirm: async (preview) => {
        assert.equal(preview, prepared);
        return answer;
      },
    });
    await flow.start(["one"]);
    assert.deepEqual(calls, [
      ["connectionChecks.prepare", { workspaceId: "synthetic", recordIds: ["one"] }],
    ]);
    assert.equal(flow.view().busy, false);
  }
});

test("one confirmation issues one run with the captured scope, IDs and snapshot then refreshes status", async () => {
  let confirmations = 0;
  const { flow, calls } = setup({
    confirm: async () => {
      confirmations++;
      return true;
    },
  });
  await flow.start(["one"]);
  assert.equal(confirmations, 1);
  assert.deepEqual(calls, [
    ["connectionChecks.prepare", { workspaceId: "synthetic", recordIds: ["one"] }],
    [
      "connectionChecks.run",
      {
        workspaceId: "synthetic",
        recordIds: ["one"],
        snapshot: prepared.snapshot,
        confirmed: true,
      },
    ],
    ["connectionChecks.status", { workspaceId: "synthetic" }],
  ]);
  assert.equal(flow.view().result, result);
});

test("double clicks during preview, confirmation or run never duplicate the attempt", async () => {
  const accept = deferred();
  const finish = deferred();
  const { flow, calls } = setup({
    confirm: () => accept.promise,
    api: (action) =>
      action.endsWith("prepare") ? prepared : action.endsWith("run") ? finish.promise : status,
  });
  const first = flow.start(["one"]);
  await flow.start(["one"]);
  await Promise.resolve();
  await flow.start(["one"]);
  accept.resolve(true);
  await Promise.resolve();
  await flow.start(["one"]);
  finish.resolve(result);
  await first;
  assert.equal(calls.filter(([action]) => action.endsWith("prepare")).length, 1);
  assert.equal(calls.filter(([action]) => action.endsWith("run")).length, 1);
});

test("zero, duplicate and oversized batches are rejected without silently truncating or making calls", async () => {
  for (const ids of [[], ["one", "one"], Array.from({ length: 33 }, (_, index) => String(index))]) {
    const { flow, calls } = setup();
    await flow.start(ids);
    assert.deepEqual(calls, []);
    assert.match(flow.view().error, /1 至 32 条不同记录.*分批/);
  }
});

test("denied and unsupported rows remain visible and cannot run even if a confirmation callback accepts", async () => {
  const blocked = {
    ...prepared,
    items: [
      { ...ready, state: "denied", reason: "scope-unverified" },
      { ...ready, recordId: "two", state: "unsupported", reason: "future-reason" },
    ],
  };
  const { flow, calls } = setup({ api: () => blocked, confirm: async () => true });
  await flow.start(["one"]);
  assert.equal(calls.length, 1);
  const html = connectionPreview(blocked);
  assert.match(html, /没有可执行项目/);
  assert.match(html, /精确自有服务器清单验证/);
  assert.match(html, /future-reason/);
});

test("partial failure preserves observed unsaved facts, escapes fields, refreshes status and never retries", async () => {
  const partial = {
    ...result,
    items: [
      {
        ...result.items[0],
        name: '<img src=x onerror="bad">',
        target: "https://fixture.invalid/?x=<script>",
        persisted: false,
        discardReason: "record-changed",
        reason: "new-reason",
      },
    ],
  };
  const failure = Object.assign(new Error("<script>failure</script>"), {
    code: "CONNECTION_CHECK_PARTIAL",
    partial,
  });
  const { flow, calls } = setup({
    api: (action) => {
      if (action.endsWith("prepare")) return prepared;
      if (action.endsWith("run")) throw failure;
      return status;
    },
  });
  await flow.start(["one"]);
  assert.equal(flow.view().result, partial);
  const html = connectionCheckPanel(flow.view());
  for (const text of [
    "已观察，未保存",
    "记录已变化",
    "new-reason",
    "&lt;img",
    "&lt;script&gt;failure",
    "未自动重试",
    "HTTP 403",
  ])
    assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /<script|<img/);
  assert.equal(calls.filter(([action]) => action.endsWith("run")).length, 1);
  assert.equal(calls.at(-1)[0], "connectionChecks.status");
});

test("stale saved status stays explicitly expired and separate from manual registration", () => {
  assert.equal(
    connectionResultText({ lastCheck: result.items[0], stale: true }),
    "已过期 · 连接有响应 · 收到 HTTP 响应 · 2026-10-21T00:00:00.000Z",
  );
  assert.equal(
    connectionResultText({ lastCheck: { state: "future-state", reason: "future-reason" } }),
    "future-state · future-reason",
  );
  assert.equal(connectionResultText(), "尚未检查");
  assert.match(connectionCheckPanel({ status }), /只读记录.*已过期结果/);
});

test("an invalidated snapshot returns an error with no automatic retry and reads current status", async () => {
  const { flow, calls } = setup({
    api: (action) => {
      if (action.endsWith("prepare")) return prepared;
      if (action.endsWith("run")) throw new Error("检查预览已失效");
      return { ...status, items: [{ recordId: "one", lastCheck: result.items[0], stale: true }] };
    },
  });
  await flow.start(["one"]);
  assert.match(flow.view().error, /预览已失效.*未自动重试/);
  assert.equal(flow.view().status.items[0].stale, true);
  assert.equal(calls.filter(([action]) => action.endsWith("run")).length, 1);
});

test("page or workspace changes before confirmation prevent run", async () => {
  let current = true;
  const { flow, calls } = setup({
    isCurrent: () => current,
    confirm: async () => {
      current = false;
      return true;
    },
  });
  await flow.start(["one"]);
  assert.equal(calls.length, 1);
});

test("leaving during prepare does not open a dialog or publish results to another view", async () => {
  const preview = deferred();
  let confirms = 0;
  const { flow, calls, changes } = setup({
    api: () => preview.promise,
    confirm: async () => {
      confirms++;
      return true;
    },
  });
  const pending = flow.start(["one"]);
  flow.dispose();
  const count = changes.length;
  preview.resolve(prepared);
  await pending;
  assert.equal(confirms, 0);
  assert.equal(calls.length, 1);
  assert.equal(changes.length, count);
});

test("leaving during run keeps captured workspace requests and suppresses late UI changes", async () => {
  const finish = deferred();
  const { flow, calls, changes } = setup({
    api: (action) =>
      action.endsWith("prepare") ? prepared : action.endsWith("run") ? finish.promise : status,
  });
  const pending = flow.start(["one"]);
  await Promise.resolve();
  await Promise.resolve();
  flow.dispose();
  const count = changes.length;
  finish.resolve(result);
  await pending;
  assert.equal(changes.length, count);
  assert.ok(calls.every(([, payload]) => payload.workspaceId === "synthetic"));
  assert.equal(flow.view().result, null);
});

test("stop is explicit, waits for acknowledgment, prevents double stop and refreshes state", async () => {
  const stopped = deferred();
  const { flow, calls } = setup({
    initialStatus: { ...status, active: true, completed: 1, total: 2 },
    api: (action) => (action.endsWith("stop") ? stopped.promise : status),
  });
  assert.match(connectionCheckPanel(flow.view()), /1 \/ 2/);
  const first = flow.stop();
  await flow.stop();
  assert.equal(flow.view().stopping, true);
  assert.equal(calls.length, 1);
  stopped.resolve({ stopped: true });
  await first;
  assert.deepEqual(
    calls.map(([action]) => action),
    ["connectionChecks.stop", "connectionChecks.status"],
  );
  assert.equal(flow.view().stopping, false);
  assert.equal(flow.view().status.active, false);
  await flow.stop();
  assert.equal(calls.length, 2);
});

test("HTTP and TCP limitations and query parameter behavior are explicit", () => {
  for (const text of [
    "查询参数会原样发送",
    "不附加凭据、Cookie 或请求正文",
    "任意状态码仅证明有响应",
    "不代表 WebShell 可用",
    "不证明终端或整条隧道可用",
    "此范围判定尚未覆盖通用工具出口",
  ])
    assert.ok(connectionCheckNotice.includes(text), text);
  assert.match(connectionResults({ ...result, cancelled: true }), /检查已取消.*已观察的结果/);
});

test("manual refresh reads only status and unlocks a completed batch on re-entry", async () => {
  const next = { ...status, completed: 2, total: 2 };
  const { flow, calls } = setup({
    initialStatus: { ...status, active: true, completed: 1, total: 2 },
    api: () => next,
  });
  assert.match(connectionCheckPanel(flow.view()), /data-connection-batch disabled/);
  assert.match(connectionCheckPanel(flow.view()), /刷新检查状态/);
  await flow.refresh();
  assert.deepEqual(calls, [["connectionChecks.status", { workspaceId: "synthetic" }]]);
  assert.equal(flow.view().status, next);
  assert.doesNotMatch(connectionCheckPanel(flow.view()), /data-connection-batch disabled/);
});

test("manual refresh suppresses double clicks and late updates after navigation", async () => {
  const response = deferred();
  const { flow, calls, changes } = setup({ api: () => response.promise });
  const first = flow.refresh();
  await flow.refresh();
  assert.equal(flow.view().refreshing, true);
  assert.equal(calls.length, 1);
  flow.dispose();
  const count = changes.length;
  response.resolve({ ...status, active: true });
  await first;
  assert.equal(changes.length, count);
  assert.equal(flow.view().status, status);
});

test("cancel reason does not attribute scope or cleanup cancellation to the user", () => {
  const html = connectionResults({
    ...result,
    items: [{ ...result.items[0], state: "cancelled", reason: "cancelled" }],
  });
  assert.match(html, /检查已取消/);
  assert.doesNotMatch(html, /用户已取消/);
  assert.doesNotMatch(connectionCheckNotice, /ownServers|listener/);
});

test("country and exception decisions distinguish the evaluated address from a connected target", () => {
  const scope = {
    allowed: true,
    reason: "resolved-exception",
    country: "US",
    address: "192.0.2.10",
    matchedHost: "fixture.invalid",
  };
  const observed = { ...result, items: [{ ...result.items[0], scope }] };
  const html = connectionResults(observed);
  for (const text of [
    "范围允许",
    "派生 IP 例外允许",
    "国家 US",
    "判定地址 192.0.2.10",
    "匹配主机 fixture.invalid",
  ])
    assert.ok(html.includes(text), text);
  assert.match(
    connectionResultText({ lastCheck: observed.items[0] }),
    /范围允许.*判定地址 192.0.2.10/,
  );
  const hostile = connectionResults({
    ...result,
    items: [
      {
        ...result.items[0],
        scope: { ...scope, country: "<script>", address: '<img src="x">', matchedHost: "<svg>" },
      },
    ],
  });
  assert.doesNotMatch(hostile, /<script|<img|<svg/);
  assert.match(hostile, /&lt;script&gt;/);
  for (const [reason, text] of [
    ["exact-host", "精确自有主机例外允许"],
    ["country-allowed", "本地国家数据库允许"],
    ["region-pending", "确认后需解析实际地址并判定国家"],
    ["country-denied", "CN / HK / MO"],
    ["special-address", "特殊或私网地址"],
    ["country-unknown", "国家未知"],
    ["database-unavailable", "本地国家数据库不可用"],
  ]) {
    const preview = connectionPreview({ ...prepared, items: [{ ...ready, reason }] });
    assert.ok(preview.includes(text), reason);
  }
  const preview = connectionPreview({ ...prepared, items: [{ ...ready, scope }] });
  assert.match(preview, /国家 US.*判定地址 192.0.2.10/);
  assert.match(
    connectionResults({ items: [{ scope: { ...scope, country: null } }] }),
    /未查询（精确例外）/,
  );
});
