import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore, StoreError } from "../src/core/store.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-unlimit-store-"));
  const database = join(directory, "synthetic.sqlite");
  const store = new WorkspaceStore(database);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (action, payload) => store.dispatch(action, payload);
  const workspace = (name) =>
    call("workspaces.save", {
      name,
      scope: "Local synthetic fixtures only",
      authorization: "Unit test",
    }).item;
  const asset = (workspaceId, name = "Test asset") =>
    call("assets.save", {
      workspaceId,
      name,
      address: `https://example.invalid/${encodeURIComponent(name)}`,
      tags: ["synthetic"],
    }).item;
  return { store, database, call, workspace, asset };
}
function code(expected) {
  return (error) => error instanceof StoreError && error.code === expected;
}

test("settings defaults, validation, persistence and optimistic revision conflict", (t) => {
  const { call, database } = fixture(t);
  const initial = call("settings.get");
  assert.equal(initial.revision, 0);
  assert.equal(initial.value.enabled, false);
  assert.equal(initial.value.maxSubagents, 16);
  const other = new WorkspaceStore(database);
  try {
    const changed = call("settings.save", {
      revision: 0,
      value: { ...initial.value, prompt: "Synthetic prompt" },
    });
    assert.equal(changed.revision, 1);
    assert.equal(other.dispatch("settings.get").value.prompt, "Synthetic prompt");
    assert.throws(
      () => other.dispatch("settings.save", { revision: 0, value: initial.value }),
      code("CONFLICT"),
    );
    assert.throws(
      () => call("settings.save", { revision: 1, value: { enabled: "yes" } }),
      code("INVALID_INPUT"),
    );
    assert.equal(call("settings.get").revision, 1);
  } finally {
    other.close();
  }
});

test("rules CRUD, active state and SQL parameter binding", (t) => {
  const { call } = fixture(t);
  const name = "x'); DROP TABLE entries; --";
  const item = call("rules.save", { name, content: "Synthetic rule", model: "example-model" }).item;
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(call("rules.activate", { id: item.id }), { activeId: item.id });
  assert.equal(call("rules.list").items[0].name, name);
  call("rules.save", { id: item.id, name: "Changed", content: "" });
  assert.equal(call("rules.list").items.length, 1);
  assert.equal(call("rules.reset").activeId, null);
  call("rules.activate", { id: item.id });
  assert.equal(call("rules.delete", { id: item.id }).deleted, true);
  assert.deepEqual(call("rules.list"), { items: [], activeId: null });
  assert.throws(() => call("rules.activate", { id: item.id }), code("NOT_FOUND"));
});

test("settings support the shared prompt and workspace policy contract only", (t) => {
  const { call } = fixture(t);
  for (const workspacePolicy of ["fallback", "strict", "always"]) {
    const current = call("settings.get");
    const next = call("settings.save", {
      revision: current.revision,
      value: {
        ...current.value,
        promptMode: "append",
        workspacePolicy,
        ownServers: ["synthetic-server"],
      },
    });
    assert.equal(next.value.workspacePolicy, workspacePolicy);
  }
  const current = call("settings.get");
  assert.throws(
    () => call("settings.save", { revision: current.revision, value: { promptMode: "prepend" } }),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () =>
      call("settings.save", { revision: current.revision, value: { workspacePolicy: "replace" } }),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () => call("settings.save", { revision: current.revision, value: { ownServers: [{}] } }),
    code("INVALID_INPUT"),
  );
});

test("workspaces save and activate while all asset operations stay isolated", (t) => {
  const { call, workspace, asset } = fixture(t);
  const first = workspace("One");
  const second = workspace("Two");
  const a = asset(first.id, "Alpha");
  const b = asset(first.id, "Beta");
  const foreign = asset(second.id, "Other");
  call("workspaces.save", { id: first.id, name: "One revised" });
  assert.equal(call("workspaces.activate", { id: first.id }).activeId, first.id);
  assert.equal(call("workspaces.list").items.length, 2);
  assert.equal(call("assets.list", { workspaceId: first.id }).items.length, 2);
  assert.equal(call("assets.list", { workspaceId: first.id, query: "alpha" }).items[0].id, a.id);
  assert.throws(
    () =>
      call("assets.save", {
        workspaceId: second.id,
        id: a.id,
        name: "Overwrite",
        address: "example.invalid",
      }),
    code("NOT_FOUND"),
  );
  assert.throws(
    () =>
      call("assets.link", {
        workspaceId: first.id,
        from: a.id,
        to: foreign.id,
        relation: "connected",
      }),
    code("NOT_FOUND"),
  );
  const link = call("assets.link", {
    workspaceId: first.id,
    from: a.id,
    to: b.id,
    relation: "connected",
  }).item;
  assert.equal(link.workspaceId, first.id);
  const graph = call("assets.graph", { workspaceId: first.id });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(call("assets.graph", { workspaceId: second.id }).edges.length, 0);
  const assessment = call("assets.assess", {
    workspaceId: first.id,
    id: a.id,
    notes: "Synthetic assessment",
  }).item;
  assert.equal(assessment.assessment.execution, "local-record-only");
  assert.equal(
    call("assets.test", { workspaceId: first.id, id: a.id, result: "manual evidence" }).item.test
      .execution,
    "local-record-only",
  );
  assert.equal(call("assets.timeline", { workspaceId: first.id }).items.length, 5);
  assert.equal(call("assets.timeline", { workspaceId: second.id }).items.length, 1);
});

test("findings validate severity and asset ownership, support updates and search", (t) => {
  const { call, workspace, asset } = fixture(t);
  const first = workspace("One");
  const second = workspace("Two");
  const a = asset(first.id);
  const finding = call("findings.save", {
    workspaceId: first.id,
    title: "Synthetic finding",
    severity: "high",
    assetId: a.id,
    evidence: { observed: "fixture" },
  }).item;
  assert.equal(finding.status, "open");
  const changed = call("findings.save", {
    workspaceId: first.id,
    id: finding.id,
    title: "Synthetic finding resolved",
    severity: "low",
    status: "resolved",
    assetId: a.id,
  }).item;
  assert.equal(changed.id, finding.id);
  assert.equal(call("findings.list", { workspaceId: first.id, query: "resolved" }).items.length, 1);
  assert.equal(call("findings.list", { workspaceId: second.id }).items.length, 0);
  assert.throws(
    () =>
      call("findings.save", {
        workspaceId: second.id,
        title: "Cross scope",
        severity: "high",
        assetId: a.id,
      }),
    code("NOT_FOUND"),
  );
  assert.throws(
    () =>
      call("findings.save", { workspaceId: first.id, title: "Invalid", severity: "catastrophic" }),
    code("INVALID_INPUT"),
  );
});

test("session binding persists independently of the global active workspace across connections", (t) => {
  const { call, workspace, database } = fixture(t);
  const first = workspace("Session One");
  const second = workspace("Session Two");
  const other = new WorkspaceStore(database);
  try {
    call("workspaces.bind", { id: first.id, sessionId: "synthetic-session-one" });
    other.dispatch("workspaces.bind", { id: second.id, sessionId: "synthetic-session-two" });
    call("workspaces.activate", { id: second.id });
    assert.equal(
      call("workspaces.forSession", { sessionId: "synthetic-session-one" }).item.id,
      first.id,
    );
    assert.equal(
      other.dispatch("workspaces.forSession", { sessionId: "synthetic-session-two" }).item.id,
      second.id,
    );
    assert.equal(call("workspaces.forSession", { sessionId: "unbound-session" }).item, null);
    assert.throws(
      () => call("workspaces.bind", { id: "missing", sessionId: "synthetic-session-one" }),
      code("NOT_FOUND"),
    );
    assert.equal(
      other.dispatch("workspaces.forSession", { sessionId: "synthetic-session-one" }).item.id,
      first.id,
    );
    other.dispatch("workspaces.bind", { id: second.id, sessionId: "synthetic-session-one" });
    assert.equal(
      call("workspaces.forSession", { sessionId: "synthetic-session-one" }).item.id,
      second.id,
    );
  } finally {
    other.close();
  }
});

test("every record kind supports local CRUD and rejects unknown kinds and scopes", (t) => {
  const { call, workspace, asset } = fixture(t);
  const first = workspace("One");
  const second = workspace("Two");
  const a = asset(first.id);
  const point = call("records.save", {
    workspaceId: first.id,
    kind: "score-point",
    data: { points: 10 },
  }).item;
  for (const kind of [
    "credential",
    "access",
    "webshell",
    "tunnel",
    "screenshot",
    "http",
    "chain",
    "file",
    "score-hit",
    "stage",
    "session",
  ]) {
    const item = call("records.save", {
      workspaceId: first.id,
      kind,
      data: { assetId: a.id, label: kind, ...(kind === "score-hit" ? { pointId: point.id } : {}) },
    }).item;
    assert.equal(call("records.list", { workspaceId: first.id, kind }).items[0].id, item.id);
    assert.equal(call("records.list", { workspaceId: second.id, kind }).items.length, 0);
    assert.throws(
      () => call("records.delete", { workspaceId: second.id, kind, id: item.id }),
      code("NOT_FOUND"),
    );
    call("records.save", {
      workspaceId: first.id,
      id: item.id,
      kind,
      data: {
        assetId: a.id,
        changed: true,
        ...(kind === "score-hit" ? { pointId: point.id } : {}),
      },
    });
    assert.equal(
      call("records.delete", { workspaceId: first.id, kind, id: item.id }).deleted,
      true,
    );
  }
  assert.throws(
    () => call("records.save", { workspaceId: first.id, kind: "unknown", data: {} }),
    code("INVALID_INPUT"),
  );
  assert.throws(
    () => call("records.save", { workspaceId: second.id, kind: "access", data: { assetId: a.id } }),
    code("NOT_FOUND"),
  );
  assert.throws(
    () => call("records.save", { workspaceId: first.id, kind: "file", data: { broken: NaN } }),
    code("INVALID_INPUT"),
  );
});

test("knowledge save, use, search and delete with independent role overrides", (t) => {
  const { call, workspace } = fixture(t);
  const first = workspace("One");
  const second = workspace("Two");
  const note = call("knowledge.save", {
    title: "Synthetic note",
    content: "Evidence guidance",
    tags: ["fixture"],
    kind: "note",
  }).item;
  assert.equal(call("knowledge.list", { query: "guidance" }).items.length, 1);
  assert.equal(call("knowledge.use", { id: note.id }).item.useCount, 1);
  call("knowledge.save", { id: note.id, title: "Updated", content: "Changed" });
  assert.equal(call("knowledge.delete", { id: note.id }).deleted, true);
  const defaults = call("roles.list", { workspaceId: first.id }).items;
  assert.equal(defaults.length, 8);
  assert.ok(defaults.every((item) => item.content.length > 20));
  call("roles.save", {
    workspaceId: first.id,
    role: "analyst",
    content: "Custom synthetic instruction",
  });
  assert.equal(
    call("roles.list", { workspaceId: first.id }).items.find((item) => item.role === "analyst")
      .content,
    "Custom synthetic instruction",
  );
  assert.notEqual(
    call("roles.list", { workspaceId: second.id }).items.find((item) => item.role === "analyst")
      .content,
    "Custom synthetic instruction",
  );
  assert.equal(
    call("roles.reset", { workspaceId: first.id }).items.find((item) => item.role === "analyst")
      .content,
    defaults.find((item) => item.role === "analyst").content,
  );
});

test("scoring links cannot cross workspaces; reports deduplicate earned score and redact credentials", (t) => {
  const { call, workspace, asset } = fixture(t);
  const first = workspace("One");
  const second = workspace("Two");
  const a = asset(first.id);
  const point = call("records.save", {
    workspaceId: first.id,
    kind: "score-point",
    data: { points: 15, title: "Evidence collected", assetId: a.id },
  }).item;
  for (let n = 0; n < 2; n++)
    call("records.save", { workspaceId: first.id, kind: "score-hit", data: { pointId: point.id } });
  assert.throws(
    () => call("records.delete", { workspaceId: first.id, kind: "score-point", id: point.id }),
    code("IN_USE"),
  );
  assert.throws(
    () =>
      call("records.save", {
        workspaceId: second.id,
        kind: "score-hit",
        data: { pointId: point.id },
      }),
    code("NOT_FOUND"),
  );
  assert.throws(
    () => call("records.save", { workspaceId: first.id, kind: "score-hit", data: {} }),
    code("INVALID_INPUT"),
  );
  call("records.save", {
    workspaceId: first.id,
    kind: "credential",
    data: {
      username: "synthetic-user",
      password: "SYNTHETIC_SECRET",
      notes: "SYNTHETIC_PRIVATE_NOTE",
    },
  });
  call("records.save", {
    workspaceId: first.id,
    kind: "http",
    data: {
      headers: { Authorization: "Bearer SYNTHETIC_BEARER" },
      url: "https://user:SYNTHETIC_URL_SECRET@example.invalid",
      apiKey: "SYNTHETIC_API_KEY",
    },
  });
  call("findings.save", {
    workspaceId: first.id,
    title: "Example",
    assetId: a.id,
    severity: "high",
    evidence: { token: "SYNTHETIC_EVIDENCE_SECRET" },
  });
  const report = call("report.build", { workspaceId: first.id });
  assert.equal(report.stats.scoreEarned, 15);
  assert.equal(report.stats.scoreTotal, 15);
  assert.equal(report.stats.scoreHits, 2);
  assert.equal(report.stats.severities.high, 1);
  assert.match(report.markdown, /REDACTED/);
  for (const secret of [
    "SYNTHETIC_SECRET",
    "SYNTHETIC_PRIVATE_NOTE",
    "SYNTHETIC_BEARER",
    "SYNTHETIC_URL_SECRET",
    "SYNTHETIC_API_KEY",
    "SYNTHETIC_EVIDENCE_SECRET",
  ])
    assert.ok(!report.markdown.includes(secret), secret);
  assert.equal(call("report.build", { workspaceId: second.id }).stats.assets, 0);
});

test("unknown actions, malformed payloads and absent workspaces fail explicitly", (t) => {
  const { call } = fixture(t);
  assert.throws(() => call("remote.execute"), code("UNKNOWN_ACTION"));
  assert.throws(() => call("assets.list", {}), code("INVALID_INPUT"));
  assert.throws(() => call("assets.list", { workspaceId: "missing" }), code("NOT_FOUND"));
  assert.throws(() => call("settings.get", null), code("INVALID_INPUT"));
});

test("six original work roles retain compatibility keys and reset one override without deleting another", (t) => {
  const { call, workspace } = fixture(t);
  const first = workspace("Roles");
  const payload = { workspaceId: first.id };
  const defaults = call("roles.list", payload).items;
  for (const key of [
    "planner",
    "recon",
    "scanner",
    "validator",
    "internal",
    "reporter",
    "analyst",
    "reviewer",
  ])
    assert.ok(defaults.some((item) => item.role === key && item.content.length > 20));
  call("roles.save", {
    ...payload,
    role: "recon",
    content: "Synthetic custom reconnaissance role",
  });
  call("roles.save", {
    ...payload,
    role: "validator",
    content: "Synthetic custom validation role",
  });
  const single = call("roles.reset", { ...payload, role: "recon" }).items;
  assert.equal(
    single.find((item) => item.role === "recon").content,
    defaults.find((item) => item.role === "recon").content,
  );
  assert.equal(
    single.find((item) => item.role === "validator").content,
    "Synthetic custom validation role",
  );
  assert.equal(
    call("roles.reset", payload).items.find((item) => item.role === "validator").content,
    defaults.find((item) => item.role === "validator").content,
  );
});

test("asset deduplication normalizes address and type, preserves notes/tags and never crosses workspace", (t) => {
  const { call, workspace } = fixture(t);
  const first = workspace("Assets One");
  const second = workspace("Assets Two");
  const initial = call("assets.save", {
    workspaceId: first.id,
    name: "Original",
    address: " HTTPS://Example.Invalid:443/a#local ",
    type: "WEB",
    tags: ["one"],
    notes: "Original evidence",
  });
  const merged = call("assets.save", {
    workspaceId: first.id,
    name: "Additional source",
    address: "https://example.invalid/a",
    type: "web",
    tags: ["one", "two"],
    notes: "New evidence",
  });
  assert.equal(initial.merged, false);
  assert.equal(merged.merged, true);
  assert.equal(initial.item.id, merged.item.id);
  assert.deepEqual(merged.item.tags, ["one", "two"]);
  assert.equal(merged.item.notes, "Original evidence\nNew evidence");
  const preserved = call("assets.save", {
    workspaceId: first.id,
    name: "Name update only",
    address: "https://example.invalid/a",
    type: "web",
  }).item;
  assert.deepEqual(preserved.tags, ["one", "two"]);
  assert.equal(preserved.notes, merged.item.notes);
  assert.equal(
    call("assets.save", {
      workspaceId: second.id,
      name: "Other workspace",
      address: "https://example.invalid/a",
      type: "web",
    }).merged,
    false,
  );
  const other = call("assets.save", {
    workspaceId: first.id,
    name: "Other",
    address: "host.example.invalid:443",
  }).item;
  assert.throws(
    () =>
      call("assets.save", {
        workspaceId: first.id,
        id: other.id,
        name: "Conflicting update",
        address: "https://example.invalid/a",
        type: "web",
      }),
    code("CONFLICT"),
  );
  for (const address of [
    "javascript:alert(1)",
    "file:///synthetic/file",
    "ftp://example.invalid",
    "https://",
  ])
    assert.throws(
      () => call("assets.save", { workspaceId: first.id, name: "Invalid", address }),
      code("INVALID_INPUT"),
    );
  for (const address of [
    "192.0.2.1",
    "2001:db8::1",
    "[2001:db8::1]:443",
    "example.invalid",
    "example.invalid:8080/path",
  ])
    assert.ok(
      call("assets.save", { workspaceId: first.id, name: "Synthetic target", address }).item.id,
    );
});

test("asset batch import reports exact outcomes and rolls back every accepted row on a storage failure", (t) => {
  const { store, call, workspace } = fixture(t);
  const first = workspace("Import");
  const result = call("assets.import", {
    workspaceId: first.id,
    items: [
      { name: "First", address: "https://example.invalid/a", tags: ["first"] },
      { name: "Duplicate", address: "https://EXAMPLE.invalid:443/a", tags: ["second"] },
      { name: "Missing address" },
      {
        name: "Wrong workspace",
        address: "https://example.invalid/b",
        workspaceId: "not-this-workspace",
      },
    ],
  });
  assert.deepEqual([result.added, result.merged, result.rejected], [1, 1, 2]);
  assert.deepEqual(
    result.results.map((item) => [item.index, item.status]),
    [
      [0, "added"],
      [1, "merged"],
      [2, "rejected"],
      [3, "rejected"],
    ],
  );
  assert.deepEqual(call("assets.list", { workspaceId: first.id }).items[0].tags, [
    "first",
    "second",
  ]);
  const beforeAssets = call("assets.list", { workspaceId: first.id }).items;
  const beforeTimeline = call("assets.timeline", { workspaceId: first.id }).items;
  const event = store.event;
  let writes = 0;
  store.event = function (...args) {
    if (++writes === 2) throw new Error("Synthetic storage failure");
    return event.apply(this, args);
  };
  try {
    assert.throws(
      () =>
        call("assets.import", {
          workspaceId: first.id,
          items: [
            { name: "New One", address: "https://example.invalid/new-one" },
            { name: "New Two", address: "https://example.invalid/new-two" },
          ],
        }),
      /Synthetic storage failure/,
    );
  } finally {
    store.event = event;
  }
  assert.deepEqual(call("assets.list", { workspaceId: first.id }).items, beforeAssets);
  assert.deepEqual(call("assets.timeline", { workspaceId: first.id }).items, beforeTimeline);
});

test("knowledge filters kind, tags and evidence-backed verification while preserving usage metadata", (t) => {
  const { call } = fixture(t);
  const input = {
    title: "Synthetic validated procedure",
    content: "A local evidence procedure",
    kind: "procedure",
    tags: ["synthetic", "reviewed"],
  };
  for (const evidence of [undefined, "", {}, { source: "reference-only" }])
    assert.throws(
      () =>
        call("knowledge.save", {
          ...input,
          verified: true,
          ...(evidence === undefined ? {} : { evidence }),
        }),
      code("INVALID_INPUT"),
    );
  const item = call("knowledge.save", {
    ...input,
    verified: true,
    evidence: { source: "synthetic fixture", content: "Observed passing local fixture result." },
    metadata: { fixture: true },
  }).item;
  call("knowledge.save", {
    title: "Unverified note",
    content: "An assumption",
    kind: "note",
    tags: ["synthetic"],
  });
  assert.equal(
    call("knowledge.list", { kind: "procedure", tags: ["synthetic", "reviewed"], verified: true })
      .items[0].id,
    item.id,
  );
  assert.equal(call("knowledge.list", { verified: false }).items.length, 1);
  assert.equal(call("knowledge.list", { tags: ["missing"] }).items.length, 0);
  const used = call("knowledge.use", { id: item.id }).item;
  assert.equal(used.useCount, 1);
  assert.deepEqual(used.metadata, { fixture: true });
  assert.throws(
    () =>
      call("knowledge.save", { ...input, id: item.id, content: "Changed claim", verified: true }),
    code("INVALID_INPUT"),
  );
  const changed = call("knowledge.save", { ...input, id: item.id, content: "Changed claim" }).item;
  assert.equal(changed.verified, false);
  assert.equal(changed.verifiedAt, null);
  assert.equal(changed.useCount, 1);
});

test("rule content enforces its UTF-8 256 KiB limit without replacing existing data", (t) => {
  const { call } = fixture(t);
  const item = call("rules.save", { name: "Boundary", content: "a".repeat(256 * 1024) }).item;
  assert.throws(
    () => call("rules.save", { id: item.id, name: "Too large", content: "界".repeat(87382) }),
    code("LIMIT_EXCEEDED"),
  );
  assert.equal(call("rules.list").items[0].content.length, 256 * 1024);
});

test("repeated collection merges asset and service evidence while preserving first discovery across days", (t) => {
  const { call, workspace } = fixture(t);
  const workspaceId = workspace("Observed assets").id;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-01-01T10:00:00Z") });
  const first = call("assets.save", {
    workspaceId,
    name: "Initial name",
    address: "192.0.2.10",
    ports: [22],
    domains: ["FIRST.EXAMPLE.INVALID"],
    source: "inventory",
    services: [{ port: 443, name: "https", fingerprints: ["TLS fixture"], sources: ["inventory"] }],
  }).item;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  const second = call("assets.save", {
    workspaceId,
    name: "Additional name",
    address: "192.0.2.10",
    ports: [80],
    domains: ["second.example.invalid"],
    source: "manual-review",
    services: [
      {
        port: 443,
        name: "https",
        product: "Synthetic server",
        fingerprints: ["nginx fixture"],
        sources: ["manual-review"],
      },
      { port: 80, name: "http" },
    ],
  }).item;
  const another = call("assets.save", {
    workspaceId,
    name: "Second host",
    address: "10.0.0.4",
  }).item;
  assert.equal(first.id, second.id);
  assert.equal(second.firstSeenAt, "2026-01-01T10:00:00.000Z");
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.lastSeenAt, "2026-01-02T10:00:00.000Z");
  assert.deepEqual(second.names, ["Initial name", "Additional name"]);
  assert.deepEqual(second.domains, ["first.example.invalid", "second.example.invalid"]);
  assert.deepEqual(new Set(second.ports), new Set([22, 80, 443]));
  assert.deepEqual(second.sources, ["inventory", "manual-review"]);
  assert.deepEqual(second.fingerprints, ["TLS fixture", "nginx fixture"]);
  assert.equal(second.services.find((service) => service.port === 443).id, first.services[0].id);
  assert.equal(second.services.find((service) => service.port === 443).product, "Synthetic server");
  const timeline = call("assets.timeline", { workspaceId });
  assert.deepEqual(
    timeline.daily.map((day) => [day.date, day.discovered, day.observations]),
    [
      ["2026-01-01", 1, 1],
      ["2026-01-02", 1, 2],
    ],
  );
  assert.ok(timeline.daily[1].assetIds.includes(second.id));
  assert.ok(timeline.daily[1].assetIds.includes(another.id));
  assert.ok(timeline.items.every((item) => [first.id, another.id].includes(item.assetId)));
  assert.equal(call("report.build", { workspaceId }).stats.assets, 2);
  assert.equal(call("report.build", { workspaceId }).stats.services, 2);
});

test("combined asset filters agree with counts across internal, external, domain and web views", (t) => {
  const { call, workspace } = fixture(t);
  const workspaceId = workspace("Filtered assets").id;
  const external = call("assets.save", {
    workspaceId,
    name: "Public fixture",
    address: "192.0.2.10",
    domains: ["public.example.invalid"],
    segment: "dmz",
    status: "verified",
    priority: "high",
    tags: ["web"],
    source: "fixture inventory",
    services: [{ port: 443, name: "https", fingerprints: ["nginx fixture"] }],
  }).item;
  call("assets.save", {
    workspaceId,
    name: "Private fixture",
    address: "10.0.0.4",
    segment: "corp",
    status: "unverified",
    priority: "high",
    services: [{ port: 443, name: "https" }],
  });
  call("assets.save", {
    workspaceId,
    name: "Domain fixture",
    address: "example.invalid",
    type: "domain",
    services: [{ port: 80, name: "http" }],
  });
  const selected = call("assets.list", {
    workspaceId,
    query: "fixture",
    scope: "external",
    segment: "dmz",
    status: "verified",
    priority: "high",
    port: 443,
    service: "https",
    fingerprint: "NGINX",
    source: "inventory",
    tags: ["web"],
  });
  assert.deepEqual(
    selected.items.map((item) => item.id),
    [external.id],
  );
  assert.equal(selected.total, 1);
  for (const [view, count] of [
    ["internal", 1],
    ["external", 1],
    ["domains", 2],
    ["web", 3],
  ]) {
    const result = call("assets.list", { workspaceId, view });
    assert.equal(result.total, count, view);
    assert.equal(result.items.length, count, view);
  }
  assert.equal(call("assets.list", { workspaceId, priority: "high", port: 443 }).total, 2);
  assert.equal(call("assets.list", { workspaceId, scope: "external", segment: "corp" }).total, 0);
  assert.throws(
    () =>
      call("assets.save", {
        workspaceId,
        name: "Bad service",
        address: "192.0.2.20",
        services: [{ port: 70000 }],
      }),
    code("INVALID_INPUT"),
  );
  assert.equal(call("assets.list", { workspaceId }).total, 3);
});

test("scores count distinct point, asset and service coverage while keeping all evidence and stage totals", (t) => {
  const { call, workspace } = fixture(t);
  const workspaceId = workspace("Service scoring").id;
  const assetOne = call("assets.save", {
    workspaceId,
    name: "Host one",
    address: "192.0.2.10",
    services: [
      { port: 443, name: "https" },
      { port: 8443, name: "https" },
    ],
  }).item;
  const assetTwo = call("assets.save", {
    workspaceId,
    name: "Host two",
    address: "192.0.2.11",
    services: [{ port: 443, name: "https" }],
  }).item;
  const stageId = call("records.save", {
    workspaceId,
    kind: "stage",
    data: { title: "Synthetic validation stage" },
  }).item.id;
  const pointOne = call("records.save", {
    workspaceId,
    kind: "score-point",
    data: { points: 10, stageId },
  }).item.id;
  const pointTwo = call("records.save", {
    workspaceId,
    kind: "score-point",
    data: { points: 5, stageId },
  }).item.id;
  const record = (data) => call("records.save", { workspaceId, kind: "score-hit", data }).item;
  record({
    pointId: pointOne,
    assetId: assetOne.id,
    serviceId: assetOne.services[0].id,
    evidence: "First local fixture",
  });
  record({
    pointId: pointOne,
    assetId: assetOne.id,
    port: 443,
    protocol: "tcp",
    evidence: "Second evidence of the same coverage",
  });
  record({ pointId: pointOne, assetId: assetOne.id, port: 8443, evidence: "A different service" });
  record({
    pointId: pointOne,
    assetId: assetTwo.id,
    serviceId: assetTwo.services[0].id,
    evidence: "A different asset",
  });
  record({ pointId: pointTwo, assetId: assetOne.id, port: 443, evidence: "A different point" });
  record({
    pointId: pointTwo,
    assetId: assetTwo.id,
    port: 443,
    evidence: "Evidence only",
    awarded: false,
  });
  const report = call("report.build", { workspaceId });
  assert.equal(report.stats.scoreHits, 6);
  assert.equal(report.stats.scoreUniqueHits, 4);
  assert.equal(report.stats.scoreEarned, 35);
  assert.equal(report.stats.scoreTotal, 15);
  assert.deepEqual(report.stats.scoreByStage, [{ stage: stageId, earned: 35, uniqueHits: 4 }]);
  assert.equal(call("records.list", { workspaceId, kind: "score-hit" }).items.length, 6);
  assert.throws(
    () => call("records.delete", { workspaceId, kind: "stage", id: stageId }),
    code("IN_USE"),
  );
});

test("scored service identities must belong to the selected asset and workspace", (t) => {
  const { call, workspace } = fixture(t);
  const workspaceId = workspace("Score owner").id;
  const foreignWorkspace = workspace("Foreign score owner").id;
  const first = call("assets.save", {
    workspaceId,
    name: "First",
    address: "192.0.2.1",
    services: [{ port: 443 }],
  }).item;
  const other = call("assets.save", {
    workspaceId: foreignWorkspace,
    name: "Foreign",
    address: "192.0.2.2",
    services: [{ port: 443 }],
  }).item;
  const pointId = call("records.save", { workspaceId, kind: "score-point", data: { points: 1 } })
    .item.id;
  const record = (data) =>
    call("records.save", { workspaceId, kind: "score-hit", data: { pointId, ...data } });
  assert.throws(
    () => record({ assetId: first.id, serviceId: other.services[0].id }),
    code("NOT_FOUND"),
  );
  assert.throws(() => record({ assetId: other.id, port: 443 }), code("NOT_FOUND"));
  assert.throws(() => record({ serviceId: first.services[0].id }), code("INVALID_INPUT"));
  assert.throws(
    () => record({ assetId: first.id, serviceId: first.services[0].id, port: 80 }),
    code("INVALID_INPUT"),
  );
  assert.equal(call("records.list", { workspaceId, kind: "score-hit" }).items.length, 0);
});
