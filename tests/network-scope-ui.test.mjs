import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  networkScopeFlow,
  networkScopePanel,
  networkScopePreview,
  validateCountryFile,
} from "../web/network-scope.js";

const status = {
  revision: 7,
  active: false,
  database: {
    available: true,
    revision: "db-before",
    release: "2026-09",
    source: "fixture.csv",
    records: 2,
    ipv4: 1,
    ipv6: 1,
    sha256: "synthetic-old-sha",
    attribution: {
      name: "DB-IP",
      url: "https://db-ip.com",
      license: "CC BY 4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    },
  },
  hosts: [
    {
      hostname: "fixture.invalid",
      type: "hostname",
      snapshot: { addresses: ["192.0.2.1"], resolvedAt: "2026-10-20T00:00:00Z" },
    },
    { hostname: "next.invalid", type: "hostname", snapshot: null },
    { hostname: "192.0.2.2", type: "ip", snapshot: null },
  ],
};
const response = {
  items: [
    {
      hostname: "fixture.invalid",
      state: "resolved",
      reason: "",
      addresses: ["192.0.2.3"],
      resolvedAt: "2026-10-21T00:00:00Z",
      persisted: true,
    },
  ],
  status: { ...status, revision: 8 },
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
};
const file = (name = "fixture.csv", content = "synthetic,only") => ({
  name,
  size: new TextEncoder().encode(content).length,
  async arrayBuffer() {
    return new TextEncoder().encode(content).buffer;
  },
});
function setup(options = {}) {
  const calls = [];
  const changes = [];
  const flow = networkScopeFlow({
    initialStatus: status,
    admissionAccepted: true,
    confirm: async () => true,
    changed: (view) => changes.push(view),
    ...options,
    api: async (action, payload) => {
      calls.push([action, payload]);
      return options.api
        ? options.api(action, payload)
        : action === "networkScope.resolve"
          ? response
          : status;
    },
  });
  return { flow, calls, changes };
}

test("creating or reading the panel cannot resolve; explicit refresh is status-only", async () => {
  const { flow, calls } = setup();
  const html = networkScopePanel(flow.view());
  networkScopePreview(["fixture.invalid"]);
  assert.deepEqual(calls, []);
  assert.match(html, /已保存的自有服务器/);
  await flow.refresh();
  assert.deepEqual(calls, [["networkScope.status", {}]]);
});

test("cancel or close confirmation sends zero DNS resolve calls", async () => {
  for (const answer of [false, undefined]) {
    const { flow, calls } = setup({ confirm: async () => answer });
    await flow.resolve(["fixture.invalid"]);
    assert.deepEqual(calls, []);
    assert.equal(flow.view().busy, false);
    assert.equal(flow.view().status, status);
  }
});

test("one confirmation resolves only saved canonical domains using captured revision", async () => {
  const accepted = deferred();
  const { flow, calls } = setup({
    confirm: (hosts) => {
      assert.deepEqual(hosts, ["fixture.invalid"]);
      return accepted.promise;
    },
  });
  const pending = flow.resolve(["fixture.invalid"]);
  await flow.resolve(["next.invalid"]);
  await flow.refresh();
  await flow.importFile(file(), "2026-10");
  assert.deepEqual(calls, []);
  assert.match(networkScopePanel(flow.view()), /尚未发起 DNS/);
  accepted.resolve(true);
  await pending;
  assert.deepEqual(calls, [
    [
      "networkScope.resolve",
      {
        hosts: ["fixture.invalid"],
        revision: 7,
        confirmed: true,
      },
    ],
  ]);
  assert.equal(flow.view().status, response.status);
  assert.equal(flow.view().result, response.items);
});

test("unconfirmed admission disables DNS but keeps local import available", async () => {
  const { flow, calls } = setup({ admissionAccepted: false });
  const html = networkScopePanel(flow.view());
  assert.match(html, /data-scope-batch disabled/);
  assert.match(html, /data-scope-host="0" disabled/);
  assert.doesNotMatch(html, /type="submit" class="primary" disabled/);
  await flow.resolve(["fixture.invalid"]);
  assert.deepEqual(calls, []);
  assert.match(flow.view().error, /先确认演练入口/);
  await flow.importFile(file(), "2026-10");
  assert.deepEqual(
    calls.map(([action]) => action),
    ["networkScope.import"],
  );
});

test("IP, missing, duplicate, alias, unsaved and oversized hostname batches do not resolve", async () => {
  const candidates = [
    [],
    ["192.0.2.2"],
    ["fixture.invalid", "fixture.invalid"],
    ["alias.fixture.invalid"],
    ["unsaved.invalid"],
    ["FIXTURE.invalid"],
    Array.from({ length: 33 }, (_, index) => `${index}.invalid`),
  ];
  for (const hosts of candidates) {
    const { flow, calls } = setup();
    await flow.resolve(hosts);
    assert.deepEqual(calls, []);
    assert.match(flow.view().error, /1 至 32 个不同的已保存域名/);
  }
});

test("a revision conflict never retries or silently replaces the displayed state", async () => {
  for (const action of ["resolve", "import"]) {
    const { flow, calls } = setup({
      api: () => {
        throw new Error("版本冲突 <current>");
      },
    });
    if (action === "resolve") await flow.resolve(["fixture.invalid"]);
    else await flow.importFile(file(), "2026-10");
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], `networkScope.${action}`);
    assert.equal(flow.view().status, status);
    const html = networkScopePanel(flow.view());
    assert.match(html, /未自动重试/);
    assert.match(html, /版本冲突 &lt;current&gt;/);
    assert.match(html, /synthetic-old-sha/);
    assert.match(html, /2026-09/);
  }
});

test("file suffix, size and release are checked before reading file content or calling API", async () => {
  const invalid = [
    [null, "2026-10"],
    [file("file.json"), "2026-10"],
    [file("file.csv.gz.exe"), "2026-10"],
    [file(), "2026-13"],
    [file(), "2026-1"],
    [file(), ""],
    [file(), "2026-00"],
    [{ ...file(), size: 0 }, "2026-10"],
    [{ ...file(), size: 48 * 1024 * 1024 + 1 }, "2026-10"],
    [{ ...file("test.csv.gz"), size: 16 * 1024 * 1024 + 1 }, "2026-10"],
  ];
  let reads = 0;
  for (const [selected, release] of invalid) {
    const { flow, calls } = setup();
    await flow.importFile(
      selected && {
        ...selected,
        arrayBuffer: () => {
          reads++;
        },
      },
      release,
    );
    assert.deepEqual(calls, []);
    assert.match(flow.view().error, /导入失败/);
    assert.equal(flow.view().status, status);
  }
  assert.equal(reads, 0);
  assert.equal(
    validateCountryFile({ ...file(), size: 48 * 1024 * 1024 }, "2026-10"),
    48 * 1024 * 1024,
  );
  assert.equal(
    validateCountryFile({ ...file("test.CSV.GZ"), size: 16 * 1024 * 1024 }, "2026-10"),
    16 * 1024 * 1024,
  );
});

test("selected local file is encoded once with the database revision and declared month", async () => {
  const updated = {
    ...status,
    database: { ...status.database, revision: "db-after", release: "2026-10" },
  };
  let reads = 0;
  const selected = {
    ...file("fixture.csv.gz", "synthetic gzip bytes"),
    async arrayBuffer() {
      reads++;
      return new TextEncoder().encode("synthetic gzip bytes").buffer;
    },
  };
  const { flow, calls } = setup({ api: () => updated });
  assert.equal(reads, 0);
  assert.deepEqual(calls, []);
  await flow.importFile(selected, "2026-10");
  assert.equal(reads, 1);
  assert.deepEqual(calls, [
    [
      "networkScope.import",
      {
        filename: "fixture.csv.gz",
        release: "2026-10",
        revision: "db-before",
        contentBase64: btoa("synthetic gzip bytes"),
      },
    ],
  ]);
  assert.equal(flow.view().status, updated);
});

test("file read or actual content failure preserves existing database and does not import", async () => {
  const { flow, calls } = setup();
  await flow.importFile(
    {
      ...file(),
      async arrayBuffer() {
        throw new Error("无法读取所选文件");
      },
    },
    "2026-10",
  );
  assert.deepEqual(calls, []);
  assert.match(networkScopePanel(flow.view()), /无法读取所选文件.*既有数据库状态保留/);
  assert.equal(flow.view().status.database.sha256, "synthetic-old-sha");
  await flow.importFile(
    {
      ...file(),
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    },
    "2026-10",
  );
  assert.deepEqual(calls, []);
  assert.match(flow.view().error, /内容为空/);
});

test("failed DNS receipt displays this attempt while retaining the saved snapshot", async () => {
  const failed = {
    items: [
      { hostname: "fixture.invalid", state: "failed", reason: "dns-error", persisted: false },
    ],
    status,
  };
  const { flow } = setup({ api: () => failed });
  await flow.resolve(["fixture.invalid"]);
  const html = networkScopePanel(flow.view());
  for (const text of [
    "本次域名解析失败",
    "原快照保留",
    "192.0.2.1",
    "2026-10-20T00:00:00Z",
    "本次未保存",
  ])
    assert.ok(html.includes(text), text);
});

test("partial persistence failure shows unsaved observations and the explicit error", async () => {
  const partial = { ...response, items: [{ ...response.items[0], persisted: false }], status };
  const failure = Object.assign(new Error("本次快照未保存"), {
    code: "NETWORK_SCOPE_PARTIAL",
    partial,
  });
  const { flow, calls } = setup({
    api: () => {
      throw failure;
    },
  });
  await flow.resolve(["fixture.invalid"]);
  assert.equal(calls.length, 1);
  assert.equal(flow.view().status, status);
  assert.equal(flow.view().result, partial.items);
  const html = networkScopePanel(flow.view());
  assert.match(html, /本次快照未保存/);
  assert.match(html, /本次未保存/);
  assert.match(html, /192.0.2.3/);
  assert.match(html, /192.0.2.1/);
});

test("scope, database, receipt, error and confirmation values are HTML escaped", () => {
  const hostile = '<img src=x onerror="bad">';
  const html = networkScopePanel({
    status: {
      ...status,
      revision: hostile,
      database: {
        ...status.database,
        release: hostile,
        source: hostile,
        sha256: hostile,
        attribution: { name: hostile, url: hostile, license: hostile, licenseUrl: hostile },
      },
      hosts: [
        {
          hostname: hostile,
          type: "hostname",
          snapshot: { addresses: [hostile], resolvedAt: hostile },
        },
      ],
    },
    result: [
      {
        hostname: hostile,
        state: "failed",
        reason: hostile,
        resolvedAt: hostile,
        persisted: false,
      },
    ],
    error: hostile,
  });
  assert.doesNotMatch(html, /<img|onerror="bad"/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(networkScopePreview([hostile]), /<img/);
  assert.match(networkScopePreview([hostile]), /&lt;img/);
});

test("navigation during confirmation prevents DNS; navigation during resolve suppresses late UI writes", async () => {
  let current = true;
  const confirmation = setup({
    isCurrent: () => current,
    confirm: async () => {
      current = false;
      return true;
    },
  });
  await confirmation.flow.resolve(["fixture.invalid"]);
  assert.deepEqual(confirmation.calls, []);
  const finish = deferred();
  const { flow, changes } = setup({ api: () => finish.promise });
  const pending = flow.resolve(["fixture.invalid"]);
  await Promise.resolve();
  flow.dispose();
  const count = changes.length;
  finish.resolve(response);
  await pending;
  assert.equal(changes.length, count);
  assert.equal(flow.view().status, status);
  assert.equal(flow.view().result, null);
});

test("navigation during file reading prevents import and late status/import responses cannot redraw", async () => {
  const bytes = deferred();
  const { flow, calls, changes } = setup();
  const pending = flow.importFile({ ...file(), arrayBuffer: () => bytes.promise }, "2026-10");
  flow.dispose();
  const count = changes.length;
  bytes.resolve(new TextEncoder().encode("synthetic").buffer);
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(changes.length, count);
  for (const action of ["refresh", "import"]) {
    const finish = deferred();
    const next = setup({ api: () => finish.promise });
    const task =
      action === "refresh" ? next.flow.refresh() : next.flow.importFile(file(), "2026-10");
    await Promise.resolve();
    next.flow.dispose();
    const before = next.changes.length;
    finish.resolve(response.status);
    await task;
    assert.equal(next.changes.length, before);
    assert.equal(next.flow.view().status, status);
  }
});

test("stop waits for acknowledgement, suppresses duplicates and older resolve status cannot overwrite its readback", async () => {
  const resolved = deferred();
  const stopped = deferred();
  const afterStop = { ...status, revision: 99, active: false };
  const { flow, calls } = setup({
    api: (action) =>
      action.endsWith("resolve")
        ? resolved.promise
        : action.endsWith("stop")
          ? stopped.promise
          : afterStop,
  });
  const pending = flow.resolve(["fixture.invalid"]);
  await Promise.resolve();
  const stop = flow.stop();
  await flow.stop();
  assert.equal(flow.view().stopping, true);
  assert.deepEqual(
    calls.map(([action]) => action),
    ["networkScope.resolve", "networkScope.stop"],
  );
  stopped.resolve({ stopped: true });
  await stop;
  assert.equal(flow.view().status, afterStop);
  resolved.resolve(response);
  await pending;
  assert.equal(flow.view().status, afterStop);
  assert.equal(flow.view().result, response.items);
  assert.deepEqual(
    calls.map(([action]) => action),
    ["networkScope.resolve", "networkScope.stop", "networkScope.status"],
  );
});

test("control-page module is outside settings form and file selection has no automatic import listener", async () => {
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const control = source.slice(
    source.indexOf("async function controlPage()"),
    source.indexOf("async function encodeSkillFile"),
  );
  assert.match(control, /<\/form>`\s*\+\s*`<div id="network-scope">/);
  assert.match(control, /\[data-scope-import\].*onsubmit/);
  assert.doesNotMatch(control, /scope-country-file.*onchange|scope\.importFile.*onchange/);
  assert.match(control, /state\.request === serial/);
  assert.match(control, /scope\.dispose\(\)/);
});
