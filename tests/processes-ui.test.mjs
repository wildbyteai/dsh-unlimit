import test from "node:test";
import assert from "node:assert/strict";
import { processMonitor } from "../web/processes.js";

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const item = {
  id: "run-one",
  tool: "synthetic-tool",
  args: ["--fixture"],
  cwd: "/synthetic/project",
  mode: "background",
  status: "running",
  sessionId: "synthetic-session",
  createdAt: "2026-10-21T00:00:00Z",
  exitCode: null,
  exitSignal: null,
  error: null,
};
const stream = (text, lossy = false) => ({ text, nextOffset: text.length, lossy });
const output = (value = item, text = "synthetic stdout") => ({
  item: value,
  stdout: stream(text),
  stderr: stream("synthetic stderr", true),
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

// The fixture models only the browser button/listener contract used by this module.
class SyntheticHost {
  constructor(html) {
    this.id = html.match(/id="([^"]+)"/)[1];
    this.innerHTML = html;
  }
  set innerHTML(value) {
    this.html = value;
    this.buttons = [...value.matchAll(/<button\b([^>]*)>/g)].map(([, attributes]) => {
      const handlers = [];
      const button = {
        disabled: /\bdisabled\b/.test(attributes),
        dataset: {
          processAction: attributes.match(/data-process-action="([^"]+)"/)?.[1],
          processIndex: attributes.match(/data-process-index="([^"]+)"/)?.[1],
        },
        addEventListener(event, handler, options) {
          handlers.push({ handler, signal: options.signal });
        },
        async click() {
          if (button.disabled) return;
          for (const { handler, signal } of handlers) if (!signal.aborted) await handler();
        },
      };
      return button;
    });
  }
  get innerHTML() {
    return this.html;
  }
  querySelectorAll(selector) {
    assert.equal(selector, "[data-process-action]");
    return this.buttons;
  }
  button(action, index) {
    const found = this.buttons.find(
      (button) =>
        button.dataset.processAction === action &&
        (index === undefined || button.dataset.processIndex === String(index)),
    );
    assert.ok(found, `${action} ${index ?? ""} exists`);
    return found;
  }
  click(action, index) {
    return this.button(action, index).click();
  }
}
async function setup(options = {}) {
  const calls = [];
  const notices = [];
  const config = {
    workspaceId: "workspace-one",
    esc,
    panel: (title, body) => `<section><h2>${title}</h2>${body}</section>`,
    empty: (text) => `<p>${esc(text)}</p>`,
    run: async (_, work) => work(),
    toast: (text) => notices.push(text),
    ...options,
    api: async (action, payload) => {
      calls.push([action, payload]);
      if (options.api) return options.api(action, payload);
      return action === "processes.list"
        ? { items: [item] }
        : action === "processes.output"
          ? output()
          : { item: { ...item, status: "stopped", exitSignal: "SIGTERM" }, stopped: true };
    },
  };
  const monitor = await processMonitor(config);
  const host = new SyntheticHost(monitor.html);
  monitor.bind(host);
  return { config, monitor, host, calls, notices };
}

test("missing workspace prompts selection and never reads a global or API scope", async () => {
  const { host, calls } = await setup({ workspaceId: "" });
  assert.match(host.innerHTML, /创建或选择项目/);
  assert.deepEqual(calls, []);
  assert.equal(host.buttons.length, 0);
});

test("render lists metadata only; output is explicit, scoped and escaped", async () => {
  const hostile = '<img src=x onerror="bad">';
  const record = {
    ...item,
    id: hostile,
    tool: hostile,
    args: [hostile],
    cwd: hostile,
    mode: hostile,
    sessionId: hostile,
    createdAt: hostile,
    error: { code: "SYNTHETIC_<ERROR>", message: hostile },
  };
  const { host, calls, config } = await setup({
    api: (action) => (action === "processes.list" ? { items: [record] } : output(record, hostile)),
  });
  assert.match(host.innerHTML, /unlimit_process/);
  assert.match(host.innerHTML, /会话/);
  assert.match(host.innerHTML, /退出码/);
  assert.doesNotMatch(host.innerHTML, /<img|<script/);
  assert.match(host.innerHTML, /&lt;img/);
  assert.match(host.innerHTML, /SYNTHETIC_&lt;ERROR&gt;/);
  assert.doesNotMatch(host.innerHTML, /\[object Object\]/);
  assert.deepEqual(calls, [["processes.list", { workspaceId: "workspace-one" }]]);
  config.workspaceId = "workspace-two";
  await host.click("output", 0);
  assert.deepEqual(calls.at(-1), [
    "processes.output",
    { workspaceId: "workspace-one", id: hostile, stdoutOffset: 0, stderrOffset: 0 },
  ]);
  assert.match(host.innerHTML, /stdout/);
  assert.match(host.innerHTML, /synthetic stderr/);
  assert.match(host.innerHTML, /已截断或部分内容已丢失/);
  assert.match(host.innerHTML, /&lt;img/);
  assert.doesNotMatch(host.innerHTML, /<img/);
  assert.equal(calls.length, 2);
});

test("stop requires the dedicated in-page confirmation; cancel sends no stop", async () => {
  const { host, calls } = await setup();
  await host.click("stop", 0);
  assert.match(host.innerHTML, /确认停止此进程/);
  assert.equal(calls.length, 1);
  await host.click("cancel-stop");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(host.innerHTML, /aria-label="确认停止进程"/);
  await host.click("stop", 0);
  await host.click("confirm-stop");
  assert.deepEqual(calls.at(-1), [
    "processes.stop",
    { workspaceId: "workspace-one", id: "run-one" },
  ]);
  assert.match(host.innerHTML, /已停止/);
  assert.match(host.innerHTML, /SIGTERM/);
  assert.equal(host.button("stop", 0).disabled, true);
});

test("backend process errors display escaped object message and code", async () => {
  const failed = {
    ...item,
    status: "failed",
    error: {
      code: "PROCESS_SPAWN_<FAILED>",
      message: '无法启动合成工具：<img src=x onerror="bad">',
    },
  };
  const { host } = await setup({ api: () => ({ items: [failed] }) });
  assert.match(host.innerHTML, /无法启动合成工具：&lt;img/);
  assert.match(host.innerHTML, /PROCESS_SPAWN_&lt;FAILED&gt;/);
  assert.doesNotMatch(host.innerHTML, /<img|\[object Object\]/);
  assert.equal(host.button("stop", 0).disabled, true);
});

test("all backend process states are labelled and only active or cleanup-pending rows can stop", async () => {
  const states = [
    ["preparing", "准备中", true],
    ["running", "运行中", true],
    ["settling", "正在收尾", true],
    ["stopping", "停止中", true],
    ["cleanup-pending", "清理尚未确认", true],
    ["exited", "已退出", false],
    ["failed", "失败", false],
    ["denied", "启动被拒绝", false],
    ["stopped", "已停止", false],
    ["timed-out", "已超时", false],
  ];
  const { host, calls } = await setup({
    api: () => ({ items: states.map(([status]) => ({ ...item, id: status, status })) }),
  });
  states.forEach(([, label, stoppable], index) => {
    assert.ok(host.innerHTML.includes(label));
    assert.equal(host.button("stop", index).disabled, !stoppable);
    assert.equal(host.button("output", index).disabled, false);
  });
  assert.equal(calls.length, 1);
});

test("stop waits for its receipt, suppresses duplicate clicks and never reports false as success", async () => {
  const finished = deferred();
  const { host, calls, notices } = await setup({
    api: (action) => (action === "processes.list" ? { items: [item] } : finished.promise),
  });
  await host.click("stop", 0);
  const old = host.button("confirm-stop");
  const pending = old.click();
  await old.click();
  await host.click("confirm-stop");
  assert.match(host.innerHTML, /等待停止结果/);
  assert.equal(calls.length, 2);
  finished.resolve({ item: { ...item, status: "cleanup-pending" }, stopped: false });
  await pending;
  assert.match(host.innerHTML, /清理尚未确认/);
  assert.match(host.innerHTML, /未宣称停止完成/);
  assert.doesNotMatch(notices.join(""), /停止请求已完成/);
});

test("false stop without cleanup-pending is explicit and does not imply stopped", async () => {
  const { host, notices } = await setup({
    api: (action) => (action === "processes.list" ? { items: [item] } : { item, stopped: false }),
  });
  await host.click("stop", 0);
  await host.click("confirm-stop");
  assert.match(host.innerHTML, /stopped: false/);
  assert.doesNotMatch(notices.join(""), /停止请求已完成/);
});

test("list failure stays local and manual retry only lists", async () => {
  let fail = true;
  const { host, calls } = await setup({
    api: () => {
      if (fail) throw new Error("synthetic <list failure>");
      return { items: [] };
    },
  });
  assert.match(host.innerHTML, /读取进程列表失败.*&lt;list failure&gt;/);
  assert.doesNotMatch(host.innerHTML, /本项目尚无/);
  fail = false;
  await host.click("refresh");
  assert.match(host.innerHTML, /本项目尚无/);
  assert.deepEqual(
    calls.map(([action]) => action),
    ["processes.list", "processes.list"],
  );
});

test("output and stop failures disclose errors, clear old output and never retry", async () => {
  let failed = false;
  const { host, calls } = await setup({
    api: (action) => {
      if (action === "processes.list") return { items: [item] };
      if (failed) throw new Error("synthetic <failure>");
      return output();
    },
  });
  await host.click("output", 0);
  assert.match(host.innerHTML, /synthetic stdout/);
  failed = true;
  await host.click("output", 0);
  assert.match(host.innerHTML, /读取进程输出失败.*&lt;failure&gt;/);
  assert.doesNotMatch(host.innerHTML, /synthetic stdout/);
  await host.click("stop", 0);
  await host.click("confirm-stop");
  assert.match(host.innerHTML, /停止进程失败.*&lt;failure&gt;/);
  assert.match(host.innerHTML, /未自动重试/);
  assert.equal(calls.filter(([action]) => action === "processes.stop").length, 1);
});

test("switching runs immediately hides old output and suppresses out-of-order responses", async () => {
  const next = { ...item, id: "run-two" };
  const first = deferred();
  const second = deferred();
  const { host } = await setup({
    api: (action, payload) =>
      action === "processes.list"
        ? { items: [item, next] }
        : payload.id === item.id
          ? first.promise
          : second.promise,
  });
  const readFirst = host.click("output", 0);
  const readSecond = host.click("output", 1);
  second.resolve(output(next, "second marker"));
  await readSecond;
  first.resolve(output(item, "first stale marker"));
  await readFirst;
  assert.match(host.innerHTML, /second marker/);
  assert.doesNotMatch(host.innerHTML, /first stale marker/);
  const again = host.click("output", 0);
  assert.doesNotMatch(host.innerHTML, /second marker/);
  await again;
});

test("a stop receipt cannot be overwritten by older output metadata", async () => {
  const finish = deferred();
  const { host } = await setup({
    api: (action) =>
      action === "processes.list"
        ? { items: [item] }
        : action === "processes.output"
          ? finish.promise
          : { item: { ...item, status: "stopped" }, stopped: true },
  });
  const read = host.click("output", 0);
  await host.click("stop", 0);
  await host.click("confirm-stop");
  finish.resolve(output());
  await read;
  assert.match(host.innerHTML, /已停止/);
  assert.equal(host.button("stop", 0).disabled, true);
});

test("dispose clears old output, invalidates late reads and detaches old controls", async () => {
  for (const action of ["output", "refresh", "stop"]) {
    const finish = deferred();
    let requests = 0;
    const { host, monitor, calls, notices } = await setup({
      api: (name) => (++requests === 1 ? { items: [item] } : finish.promise),
    });
    let pending;
    if (action === "stop") {
      await host.click("stop", 0);
      pending = host.click("confirm-stop");
    } else pending = host.click(action, action === "output" ? 0 : undefined);
    const oldButton = host.button("refresh");
    monitor.dispose();
    finish.resolve(
      action === "output"
        ? output()
        : action === "stop"
          ? { item: { ...item, status: "stopped" }, stopped: true }
          : { items: [item] },
    );
    await pending;
    await oldButton.click();
    assert.equal(host.innerHTML, "");
    assert.equal(calls.length, 2);
    assert.deepEqual(notices, []);
  }
});

test("malformed output and mismatched stop receipts are errors rather than successful-looking results", async () => {
  const { host } = await setup({
    api: (action) =>
      action === "processes.list"
        ? { items: [item] }
        : action === "processes.output"
          ? { item, stdout: stream("text"), stderr: {} }
          : { item: { ...item, id: "another-run" }, stopped: true },
  });
  await host.click("output", 0);
  assert.match(host.innerHTML, /输出响应无效/);
  await host.click("stop", 0);
  await host.click("confirm-stop");
  assert.match(host.innerHTML, /响应与所选记录不匹配/);
  assert.doesNotMatch(host.innerHTML, /停止请求已完成/);
});
