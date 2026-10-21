import nodeTest from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { DataUpdates, DATA_RECORD_KINDS } from "../web/data-updates.js";

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run);
const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
// Execute production page/render functions without booting the desktop bridge.
// Function boundaries are top-level declarations, independent of their formatting.
function productionFunction(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.notEqual(start, -1, `Missing production function ${name}`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/^(?:async )?function \w+\(/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const project = (id) => ({ id, name: `Synthetic ${id}` });
function snapshot(workspaceId = "A", version = 0) {
  return {
    workspaceId,
    global: { workspaces: version, knowledge: version },
    workspace: {
      assets: version,
      findings: version,
      links: version,
      events: version,
      roles: version,
      files: version,
      records: Object.fromEntries(DATA_RECORD_KINDS.map((kind) => [kind, version])),
    },
  };
}

function setup({ page = "reports", respond, admitted = true, bindError = false } = {}) {
  const nodes = new Map();
  const document = {
    querySelector: (selector) => nodes.get(selector) ?? null,
    querySelectorAll: () => [],
  };
  function element(id) {
    let html = "";
    let onclick;
    return {
      id,
      disabled: false,
      textContent: "",
      get onclick() {
        return onclick;
      },
      set onclick(value) {
        if (bindError && id === "download-report") throw new Error("synthetic bind failure");
        onclick = value;
      },
      get innerHTML() {
        return html;
      },
      set innerHTML(value) {
        html = value;
        if (id !== "content") return;
        for (const key of [...nodes.keys()])
          if (!["#content", "#workspace-select"].includes(key)) nodes.delete(key);
        for (const match of value.matchAll(/\bid="([^"]+)"/g))
          nodes.set(`#${match[1]}`, element(match[1]));
      },
    };
  }
  nodes.set("#content", element("content"));
  nodes.set("#workspace-select", element("workspace-select"));
  const state = {
    page,
    workspaceId: "A",
    workspaces: [project("A")],
    admission: { accepted: admitted },
    recordKind: "credential",
    request: 0,
    fileBackups: new Map(),
    fileFeedback: new Map(),
  };
  const updates = new DataUpdates();
  const receipts = [];
  const downloads = [];
  const calls = [];
  const markRead = updates.markRead.bind(updates);
  updates.markRead = (context, receipt) => {
    // A receipt is only valid after the DOM has been committed and bound.
    assert.ok(nodes.get("#data-read-status"));
    const bound = nodes.get(context.page === "reports" ? "#download-report" : "#refresh-files");
    if (["reports", "files"].includes(context.page))
      assert.equal(typeof bound?.onclick, "function");
    receipts.push({ context: { ...context }, receipt });
    return markRead(context, receipt);
  };
  let activeId = "A";
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const api = async (method, payload = {}) => {
    calls.push({ method, payload: { ...payload } });
    const overridden = respond?.(method, payload, { activeId, state });
    if (overridden !== undefined) return overridden;
    if (method === "admission.status") return { accepted: admitted };
    if (method === "workspaces.list") return { activeId, items: [project("A"), project("B")] };
    if (method === "workspaces.changes") return snapshot(payload.workspaceId ?? null, 1);
    if (method === "report.build") return { markdown: `report-${payload.workspaceId}` };
    if (["files.list", "files.backups"].includes(method)) return { items: [] };
    throw new Error(`Unexpected API read: ${method}`);
  };
  const context = vm.createContext({
    state,
    api,
    document,
    dataUpdates: updates,
    dataPages: new Set([
      "overview",
      "workspaces",
      "assets",
      "findings",
      "evidence",
      "files",
      "graph",
      "progress",
      "knowledge",
      "roles",
      "reports",
    ]),
    overviewPage() {},
    controlPage() {},
    skillsPage() {},
    graphPage() {},
    progressPage() {},
    rolesPage() {},
    sessionsPage() {},
    environmentPage() {},
    diagnosticsPage() {},
    schemas: {},
    mountedDrafts: [],
    disposePage: undefined,
    $: (selector) => document.querySelector(selector),
    $$: (selector) => document.querySelectorAll(selector),
    esc,
    captureMountedDrafts() {},
    updateDraftNotice() {},
    skeleton: () => '<div class="loading">loading</div>',
    heading: (actions = "") => `<h1>${state.page}</h1>${actions}`,
    capabilityButton: (_id, label, attrs) => `<button ${attrs}>${label}</button>`,
    can: () => true,
    table: (items) => `<table>${esc(JSON.stringify(items))}</table>`,
    empty: (title, body) => `<div>${esc(title)} ${esc(body)}</div>`,
    panel: (title, body) => `<section><h2>${esc(title)}</h2>${body}</section>`,
    admissionPage: async () => ({ html: '<div id="admission-prompt">admission</div>', bind() {} }),
    download: (...args) => downloads.push(args),
    toast() {},
  });
  vm.runInContext(
    [
      "refreshProjects",
      "updateDataBadges",
      "dataContext",
      "render",
      "workspacePayload",
      "filesPage",
      "reportsPage",
    ]
      .map(productionFunction)
      .join("\n"),
    context,
    { filename: "production-data-refresh.js" },
  );
  return {
    state,
    calls,
    updates,
    receipts,
    downloads,
    nodes,
    render: () => context.render(),
    node: (id) => nodes.get(`#${id}`),
    switchTo(id) {
      activeId = id;
      state.workspaceId = id;
    },
  };
}

function seedUnread(ui, page = ui.state.page, workspaceId = "A") {
  ui.updates.observe(snapshot(workspaceId, 0));
  ui.updates.observe(snapshot(workspaceId, 1));
  assert.equal(ui.updates.hasUnread({ workspaceId, page }), true);
}

test("late project-list response cannot replace the new project's state or read receipt", async () => {
  const pendingList = deferred();
  const started = deferred();
  const ui = setup({
    respond(method, _payload, { activeId }) {
      if (method === "workspaces.list" && activeId === "A") {
        started.resolve();
        return pendingList.promise;
      }
    },
  });
  seedUnread(ui);
  const old = ui.render();
  await started.promise;
  ui.switchTo("B");
  await ui.render();
  const html = ui.node("content").innerHTML;
  assert.ok(ui.node("download-report"), html);
  pendingList.resolve({ activeId: "A", items: [project("A")] });
  await old;
  assert.equal(ui.state.workspaceId, "B");
  assert.deepEqual(
    Array.from(ui.state.workspaces, (item) => item.id),
    ["A", "B"],
  );
  assert.equal(ui.node("content").innerHTML, html);
  assert.deepEqual(
    ui.receipts.map(({ context }) => context.workspaceId),
    ["B"],
  );
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
  assert.equal(
    ui.calls.some(
      ({ method, payload }) => method === "report.build" && payload.workspaceId === "A",
    ),
    false,
  );
});

test("an abandoned partial files read cannot mutate its old cache, DOM or receipt", async () => {
  const pendingList = deferred();
  const started = deferred();
  const ui = setup({
    page: "files",
    respond(method, payload) {
      if (method === "files.list" && payload.workspaceId === "A") {
        started.resolve();
        return pendingList.promise;
      }
      if (method === "files.backups" && payload.workspaceId === "A")
        return { items: [{ backupId: "old-backup", path: "old.md" }] };
    },
  });
  seedUnread(ui);
  const old = ui.render();
  await started.promise;
  ui.switchTo("B");
  await ui.render();
  const html = ui.node("content").innerHTML;
  pendingList.resolve({ items: [{ path: "old.md", bytes: 5 }] });
  await old;
  assert.equal(ui.node("content").innerHTML, html);
  assert.equal(ui.state.workspaceId, "B");
  assert.equal(ui.state.fileBackups.has("A"), false);
  assert.equal(ui.state.fileBackups.has("B"), true);
  assert.deepEqual(
    ui.receipts.map(({ context }) => context.workspaceId),
    ["B"],
  );
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "files" }), true);
});

test("late report reads are abandoned and export retains only the successfully bound report", async () => {
  const pending = deferred();
  const started = deferred();
  const ui = setup({
    respond(method, payload) {
      if (method === "report.build" && payload.workspaceId === "A") {
        started.resolve();
        return pending.promise;
      }
    },
  });
  seedUnread(ui);
  const old = ui.render();
  await started.promise;
  ui.switchTo("B");
  await ui.render();
  const exportReport = ui.node("download-report");
  assert.equal(exportReport.disabled, false);
  pending.resolve({ markdown: "old-report-A" });
  await old;
  assert.match(ui.node("content").innerHTML, /report-B/);
  assert.doesNotMatch(ui.node("content").innerHTML, /old-report-A/);
  assert.equal(ui.node("download-report"), exportReport);
  ui.switchTo("A");
  exportReport.onclick();
  assert.deepEqual(ui.downloads, [["Synthetic B.md", "report-B"]]);
  assert.deepEqual(
    ui.receipts.map(({ context }) => context.workspaceId),
    ["B"],
  );
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
});

test("API failure displays a retry surface without acknowledging the unread page", async () => {
  const ui = setup({
    respond(method) {
      if (method === "report.build") return Promise.reject(new Error("synthetic read failed"));
    },
  });
  seedUnread(ui);
  await ui.render();
  assert.match(ui.node("content").innerHTML, /role="alert"/);
  assert.equal(typeof ui.node("retry").onclick, "function");
  assert.equal(ui.node("download-report"), undefined);
  assert.equal(ui.receipts.length, 0);
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
  assert.equal(ui.calls.filter(({ method }) => method === "report.build").length, 1);
  assert.equal(ui.calls.filter(({ method }) => method === "workspaces.changes").length, 1);
});

test("a write between snapshots remains unread until a later complete refresh", async () => {
  let changes = 0;
  const ui = setup({
    respond(method, payload) {
      if (method === "workspaces.changes")
        return snapshot(payload.workspaceId, ++changes === 1 ? 1 : 2);
    },
  });
  seedUnread(ui);
  await ui.render();
  assert.equal(ui.receipts[0].receipt.workspace.assets, 1);
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
  assert.match(ui.node("data-read-status").innerHTML, /读取期间又有更新/);
  await ui.render();
  assert.equal(ui.receipts[1].receipt.workspace.assets, 2);
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), false);
  assert.equal(ui.receipts.length, 2);
  assert.equal(changes, 4);
});

test("without admission, tracked pages render the admission prompt and perform no protected reads", async () => {
  for (const page of [
    "files",
    "reports",
    "assets",
    "evidence",
    "progress",
    "roles",
    "graph",
    "knowledge",
    "workspaces",
  ]) {
    const ui = setup({ page, admitted: false });
    await ui.render();
    assert.deepEqual(
      ui.calls.map(({ method }) => method),
      ["admission.status"],
      page,
    );
    assert.equal(ui.state.workspaceId, "", page);
    assert.ok(ui.node("admission-prompt"), page);
    assert.equal(ui.receipts.length, 0, page);
  }
});

test("partial files responses bind usable controls but preserve unread status for either failed read", async () => {
  for (const failed of ["files.list", "files.backups"]) {
    const ui = setup({
      page: "files",
      respond(method) {
        if (method === failed) return Promise.reject(new Error(`synthetic ${failed} failure`));
      },
    });
    seedUnread(ui);
    await ui.render();
    assert.match(ui.node("content").innerHTML, /role="alert"/);
    assert.equal(typeof ui.node("refresh-files").onclick, "function");
    assert.match(ui.node("data-read-status").innerHTML, /部分读取失败/);
    assert.equal(ui.receipts.length, 0, failed);
    assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "files" }), true, failed);
    assert.equal(ui.calls.filter(({ method }) => method === "workspaces.changes").length, 2);
  }
});

test("a snapshot from another project is rejected before the page's protected read", async () => {
  const ui = setup({
    respond(method) {
      if (method === "workspaces.changes") return snapshot("B", 2);
    },
  });
  seedUnread(ui);
  await ui.render();
  assert.ok(ui.node("retry"));
  assert.equal(
    ui.calls.some(({ method }) => method === "report.build"),
    false,
  );
  assert.equal(ui.receipts.length, 0);
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
});

test("a DOM binding failure leaves the successfully fetched page unread", async () => {
  const ui = setup({ bindError: true });
  seedUnread(ui);
  await ui.render();
  assert.ok(ui.node("retry"));
  assert.equal(ui.node("download-report"), undefined);
  assert.equal(ui.calls.filter(({ method }) => method === "report.build").length, 1);
  assert.equal(ui.calls.filter(({ method }) => method === "workspaces.changes").length, 2);
  assert.equal(ui.receipts.length, 0);
  assert.equal(ui.updates.hasUnread({ workspaceId: "A", page: "reports" }), true);
});
