import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnvironment } from "../src/core/environment.js";
import { createEnvironmentNotice } from "../src/client-entry.js";

function fixture(t, { available = false, request } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "unlimit-notice-")));
  const environment = new LocalEnvironment(root);
  const nodes = [],
    calls = [];
  let opens = 0;
  const document = {
    body: {
      append(node) {
        nodes.push(node);
      },
    },
    createElement(tag) {
      return {
        tag,
        style: {},
        children: [],
        events: {},
        removed: false,
        setAttribute() {},
        append(...children) {
          this.children.push(...children);
        },
        addEventListener(name, handler) {
          this.events[name] = handler;
        },
        remove() {
          this.removed = true;
        },
      };
    },
  };
  const api = async (action, payload, signal) => {
    calls.push({ action, payload });
    signal.throwIfAborted();
    if (request) return request(action, payload, signal, environment);
    return action === "toolkit.status"
      ? { tools: [{ id: "synthetic", available }] }
      : environment.dispatch(action, payload);
  };
  const notice = createEnvironmentNotice({ document, api, openEnvironment: () => opens++ });
  const panel = () => nodes.findLast((node) => !node.removed);
  t.after(() => {
    notice.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    notice,
    environment,
    calls,
    panel,
    opens: () => opens,
    click(label) {
      const button = panel()?.children.find((node) => node.textContent === label);
      assert.ok(button, label);
      return button.events.click();
    },
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("first-use skip persists to this installation without chat or tool execution", async (t) => {
  const f = fixture(t);
  await f.notice.ready;
  assert.match(f.panel().children[1].textContent, /普通聊天和提示词功能照常使用/);
  f.click("暂不配置，继续使用");
  f.click("暂不配置，继续使用");
  await f.flush();
  assert.equal(f.panel(), undefined);
  assert.equal(f.environment.dispatch("environment.status", {}).onboarding.state, "skipped");
  assert.deepEqual(
    f.calls.map((call) => call.action),
    ["environment.status", "toolkit.status", "environment.onboarding"],
  );
  assert.equal(f.opens(), 0);
});

test("configured tools suppress the notice without changing onboarding", async (t) => {
  const f = fixture(t, { available: true });
  await f.notice.ready;
  assert.equal(f.panel(), undefined);
  assert.equal(f.environment.dispatch("environment.status", {}).onboarding.state, "pending");
});

for (const state of ["configured", "skipped"])
  test(`saved ${state} state suppresses the notice without inspecting tools`, async (t) => {
    const f = fixture(t, { request: async () => ({ revision: 2, onboarding: { state } }) });
    await f.notice.ready;
    assert.equal(f.panel(), undefined);
    assert.deepEqual(
      f.calls.map((call) => call.action),
      ["environment.status"],
    );
  });

test("configuration opens the environment page and dismissal never changes saved state", async (t) => {
  const f = fixture(t);
  await f.notice.ready;
  f.click("配置环境");
  assert.equal(f.opens(), 1);
  assert.equal(f.panel(), undefined);
  assert.equal(f.environment.dispatch("environment.status", {}).onboarding.state, "pending");
  const other = fixture(t);
  await other.notice.ready;
  other.click("本次收起");
  assert.equal(other.panel(), undefined);
  assert.equal(other.environment.dispatch("environment.status", {}).onboarding.state, "pending");
});

test("concurrent configuration is preserved and skip is never silently retried", async (t) => {
  const f = fixture(t);
  await f.notice.ready;
  f.environment.dispatch("environment.variables.save", {
    revision: 0,
    name: "SYNTHETIC",
    value: "local",
    secret: false,
  });
  f.click("暂不配置，继续使用");
  await f.flush();
  assert.match(f.panel().children[1].textContent, /其他窗口改变/);
  assert.equal(f.environment.dispatch("environment.status", {}).onboarding.state, "configured");
  f.click("重新读取");
  await f.flush();
  assert.equal(f.panel(), undefined);
  assert.equal(f.calls.filter((call) => call.action === "environment.onboarding").length, 1);
});

test("read failure is distinct from missing tools and disposal prevents late UI", async (t) => {
  const failed = fixture(t, {
    request: async () => {
      throw new Error("private data must not be shown");
    },
  });
  await failed.notice.ready;
  assert.match(failed.panel().children[1].textContent, /不能判断工具是否已配置/);
  assert.doesNotMatch(failed.panel().children[1].textContent, /private data/);
  assert.equal(
    failed.panel().children.some((node) => node.textContent === "暂不配置，继续使用"),
    false,
  );
  const pending = Promise.withResolvers();
  const late = fixture(t, { request: async () => pending.promise });
  late.notice.dispose();
  pending.resolve({ revision: 0, onboarding: { state: "pending" } });
  await late.notice.ready;
  assert.equal(late.panel(), undefined);
  assert.equal(late.calls.length, 1);
});
