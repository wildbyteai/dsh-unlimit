import test from "node:test";
import assert from "node:assert/strict";
import {
  openPromptPreview,
  promptPreviewNotice,
  renderPromptPreview,
} from "../web/prompt-preview.js";

const saved = {
  revision: 8,
  model: null,
  directory: null,
  enabled: false,
  mode: "replace",
  source: "saved",
  rule: null,
  workspace: { policy: "fallback", selectedPaths: [], included: false },
  text: "合成测试正文\n保留完整换行。",
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

// Only the dialog surface used by this module; no browser, profile or live API.
function setup(api = async () => saved) {
  const nodes = new Map();
  const listeners = new Map();
  const dialog = {
    style: {},
    open: false,
    removed: false,
    innerHTML: "",
    setAttribute() {},
    querySelector(selector) {
      if (!nodes.has(selector))
        nodes.set(selector, {
          value: "",
          textContent: "",
          innerHTML: "",
          disabled: false,
          focus() {},
        });
      return nodes.get(selector);
    },
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      listeners.get("close")?.();
    },
    remove() {
      this.removed = true;
    },
  };
  const calls = [];
  let appended;
  const dispose = openPromptPreview({
    document: {
      createElement: (name) => {
        assert.equal(name, "dialog");
        return dialog;
      },
      body: { append: (node) => (appended = node) },
    },
    api: async (...args) => {
      calls.push(args);
      return api(...args);
    },
  });
  assert.equal(appended, dialog);
  const node = (name) => dialog.querySelector(`[data-prompt-${name}]`);
  const input = (name, value) => {
    node(name).value = value;
    node(name).oninput();
  };
  return { calls, dialog, dispose, node, input, read: () => node("read").onclick() };
}

test("opening is read-only and does not request until the explicit read button", async () => {
  const ui = setup();
  assert.deepEqual(ui.calls, []);
  assert.equal(ui.dialog.open, true);
  assert.doesNotMatch(ui.dialog.innerHTML, /<form|\bname=/);
  await ui.read();
  assert.deepEqual(ui.calls, [["prompt.preview", {}]]);
  assert.match(ui.node("result").innerHTML, /已保存提示词/);
  for (const text of [
    "当前表单未保存的修改不计入",
    "不保存配置",
    "不启用运行控制",
    "不调用模型",
    "不含宿主工具说明和角色段",
    "不代表已捕获真实模型请求",
  ])
    assert.ok(promptPreviewNotice.includes(text), text);
});

test("only optional preview inputs enter the captured request, with blank inputs omitted", async () => {
  const ui = setup();
  ui.input("model", " synthetic/model ");
  ui.input("directory", " /synthetic/workspace ");
  await ui.read();
  assert.deepEqual(ui.calls, [
    ["prompt.preview", { model: " synthetic/model ", directory: " /synthetic/workspace " }],
  ]);
  ui.input("model", "   ");
  ui.input("directory", "  ");
  await ui.read();
  assert.deepEqual(ui.calls.at(-1), ["prompt.preview", {}]);
});

test("rendered metadata explains source, saved revision, mode, runtime state and selected paths", () => {
  const html = renderPromptPreview({
    ...saved,
    source: "rule",
    rule: { id: "synthetic-rule", name: "合成模型规则", model: "synthetic/model" },
    model: "synthetic/model",
    directory: "/synthetic/workspace",
    enabled: true,
    mode: "append",
    workspace: { policy: "always", selectedPaths: ["AGENTS.md"], included: true },
  });
  for (const text of [
    "规则库正文",
    "合成模型规则",
    "synthetic/model",
    "revision 8",
    "追加",
    "已启用",
    "保留并合并工作区规则",
    "本次读取的工作区文件",
    "AGENTS.md",
    saved.text,
  ])
    assert.ok(html.includes(text), text);
  const defaultHtml = renderPromptPreview(saved);
  for (const text of [
    "无模型",
    "未提供",
    "替换",
    "未启用",
    "未采用规则库正文",
    "未参与",
    "本次未读取工作区文件",
  ])
    assert.ok(defaultHtml.includes(text), text);
  assert.match(renderPromptPreview({ ...saved, source: "workspace" }), /工作区规则/);
  assert.match(
    renderPromptPreview({ ...saved, source: "default", text: "" }),
    /默认提示词.*正文为空/s,
  );
  assert.match(
    renderPromptPreview({
      ...saved,
      source: "rule",
      rule: { id: "all", name: "通用", model: null },
    }),
    /通用（不限定模型）/,
  );
});

test("all external text is escaped, including unknown metadata values and full prompt body", () => {
  const hostile = '<img src=x onerror="bad">&\'\n<script>bad</script>';
  const html = renderPromptPreview({
    ...saved,
    model: hostile,
    directory: hostile,
    revision: hostile,
    source: hostile,
    rule: { id: hostile, name: hostile, model: hostile },
    workspace: { policy: hostile, selectedPaths: [hostile], included: true },
    text: hostile,
  });
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;&amp;&#39;/);
  assert.match(html, /\n&lt;script&gt;bad&lt;\/script&gt;/);
});

test("double clicks during a request never issue duplicate preview calls", async () => {
  const response = deferred();
  const ui = setup(() => response.promise);
  const pending = ui.read();
  assert.equal(ui.node("read").disabled, true);
  await ui.read();
  assert.equal(ui.calls.length, 1);
  response.resolve(saved);
  await pending;
  assert.equal(ui.node("read").disabled, false);
});

test("input changes clear previous content and errors before the next explicit read", async () => {
  const ui = setup();
  await ui.read();
  assert.ok(ui.node("result").innerHTML);
  ui.node("error").textContent = "先前错误";
  ui.input("directory", "/synthetic/other");
  assert.equal(ui.node("result").innerHTML, "");
  assert.equal(ui.node("error").textContent, "");
  assert.match(ui.node("status").textContent, /条件已变化.*重新读取/);
  assert.equal(ui.calls.length, 1);
});

test("late success or error cannot overwrite new input conditions", async () => {
  for (const fails of [false, true]) {
    const response = deferred();
    const ui = setup(() => response.promise);
    const pending = ui.read();
    ui.input("model", "synthetic/changed");
    await ui.read();
    assert.equal(ui.calls.length, 1);
    if (fails) response.reject(new Error("旧条件错误"));
    else response.resolve(saved);
    await pending;
    assert.equal(ui.node("result").innerHTML, "");
    assert.equal(ui.node("error").textContent, "");
    assert.match(ui.node("status").textContent, /条件已变化/);
    assert.equal(ui.node("read").disabled, false);
  }
});

test("failures clear old body, display the specific backend reason as safe text and never retry", async () => {
  let fail = false;
  const ui = setup(() => {
    if (fail) throw new Error("<script>工作目录必填</script>");
    return saved;
  });
  await ui.read();
  fail = true;
  await ui.read();
  assert.equal(ui.calls.length, 2);
  assert.equal(ui.node("result").innerHTML, "");
  assert.equal(ui.node("error").textContent, "<script>工作目录必填</script>");
  assert.match(ui.node("status").textContent, /读取未完成/);
});

test("close button, Escape, native close and page disposal suppress late responses", async () => {
  for (const close of [
    (ui) => ui.node("close").onclick(),
    (ui) => ui.dialog.oncancel({ preventDefault() {} }),
    (ui) => ui.dialog.close(),
    (ui) => ui.dispose(),
  ]) {
    const response = deferred();
    const ui = setup(() => response.promise);
    const pending = ui.read();
    close(ui);
    assert.equal(ui.dialog.open, false);
    assert.equal(ui.dialog.removed, true);
    response.resolve(saved);
    await pending;
    assert.equal(ui.node("result").innerHTML, "");
    ui.dispose();
    await ui.read();
    assert.equal(ui.calls.length, 1);
  }
});
