import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filePermissionsFixture, projectRoot } from "./helpers/file-permissions-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const optionalHost = {
  skip:
    runtimeRoot && cache
      ? false
      : "Set both official runtime and package cache; no profile is loaded",
  timeout: 30000,
};

test(
  "official present, durable declarations and native-open handler over synthetic files",
  optionalHost,
  async (t) => {
    const f = await filePermissionsFixture(t, runtimeRoot, cache);
    const modules = {};
    for (const [key, name] of Object.entries({
      loop: "@deepseek-ai/dsh-agent-loop",
      present: "@deepseek-ai/dsh-tool-present",
      persistence: "@deepseek-ai/dsh-session-persistence-jsonl",
      query: "@deepseek-ai/dsh-session-query",
      deliverables: "@deepseek-ai/dsh-client-ui-deliverables",
    }))
      modules[key] = await f.loadOfficial(name);
    const routes = new Map(),
      opened = [],
      applicationQueries = [],
      scenarios = [];
    let desktopAvailable = true;
    await f.mount({
      name: "synthetic-deliverables-boundaries",
      inject: ["sessionProjections"],
      apply(ctx) {
        ctx.sessionProjections.register(modules.loop.turnBoundaryProjectionDefinition);
        // Capture the official Connection registration; no HTTP/authentication server is mounted.
        const connection = new f.api.cordis.Service(ctx, "connection");
        connection.fetch = {
          register(route) {
            assert.ok(!routes.has(route.path));
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
        };
        const controller = new f.api.cordis.Service(ctx, "sessionController");
        controller.workspaceDesktop = () => ({ available: desktopAvailable });
        controller.workspacePathApplications = async (input, signal) => {
          signal.throwIfAborted();
          applicationQueries.push(input);
          return { applications: [{ id: "synthetic.editor", name: "Synthetic editor" }] };
        };
        controller.openWorkspacePath = async (input, signal) => {
          signal.throwIfAborted();
          opened.push(input);
        };
        const changes = new f.api.cordis.Service(ctx, "workspaceChanges");
        changes.summary = changes.diff = () =>
          assert.fail("Change-history routes are outside this fixture");
      },
    });
    await f.mount(modules.persistence, {
      root: join(f.root, "session-logs"),
      compression: "none",
      listConcurrency: 1,
    });
    await f.mount(modules.query.SessionQueryEngine);
    await f.mount(modules.present, { maxFiles: 8 });
    const ui = await f.mount(modules.deliverables);
    const parent = await f.createAgent("delivery", "workspace-write");
    const other = await f.createAgent("other-delivery", "workspace-write");
    const handles = [];
    for (const agent of [parent, other]) {
      const handle = await f.ctx.sessionPersistence.create(agent.session.header);
      await handle.append(agent.session.snapshotEvents());
      handles.push(handle);
    }
    parent.session.append("turn/start", { turn: 1 });
    other.session.append("turn/start", { turn: 1 });
    const events = (agent = parent) =>
      agent.session.snapshotEvents().filter((event) => event.type === "deliverables/presented");
    const ok = (result) => assert.equal(result.isError, false, f.text(result));
    const present = (agent, files, signal) => f.execute(agent, "present", { files }, signal);
    const request = (query, method = "POST", signal) => {
      const route = routes.get("/api/present.open");
      assert.ok(route.methods.includes(method));
      return route.fetch(
        new Request(`http://127.0.0.1/api/present.open?${new URLSearchParams(query)}`, {
          method,
          signal,
        }),
      );
    };
    const scenario = async (id, action) => {
      await t.test(id, async () => {
        await action();
        scenarios.push({ id, result: "passed" });
      });
    };
    const path = join(f.workspace, "Synthetic report.txt");
    let declaration;
    const coordinates = (extra = {}) => ({
      sessionId: parent.session.id,
      seq: String(declaration.seq),
      index: "0",
      ...extra,
    });

    await scenario("DEL-PROMPT-AND-WRITE", async () => {
      const context = { agent: parent, scope: parent, signal: new AbortController().signal };
      const before = await f.ctx.systemPrompt.assemble(context);
      const guidance = before.sections.find(
        (section) => section.name === "ui:deliverable-file-references",
      );
      assert.ok(guidance?.text);
      Object.assign(f.settings, {
        enabled: true,
        fullAccess: false,
        autoApprove: false,
        prompt: "SYNTHETIC_OPERATOR_DELIVERY",
        promptMode: "replace",
        workspacePolicy: "strict",
        workspaceFiles: [],
      });
      f.adapter.apply();
      const after = await f.ctx.systemPrompt.assemble(context);
      assert.deepEqual(
        after.sections.find((section) => section.name === guidance.name),
        guidance,
      );
      assert.ok(
        after.sections.some((section) => section.text.includes("SYNTHETIC_OPERATOR_DELIVERY")),
      );
      assert.deepEqual(after.tools, before.tools);
      ok(
        await f.execute(parent, "write", {
          file_path: path,
          content: "SYNTHETIC_DELIVERABLE_V1\n",
        }),
      );
      assert.equal(readFileSync(path, "utf8"), "SYNTHETIC_DELIVERABLE_V1\n");
      ok(
        await present(parent, [
          { path: "Synthetic report.txt", description: "Synthetic text report" },
        ]),
      );
      assert.equal(events().length, 1);
      declaration = events()[0];
      assert.equal(declaration.data.turn, 1);
      assert.match(declaration.data.callId, /^synthetic-file-call-/);
      assert.deepEqual(declaration.data.files, [{ path, description: "Synthetic text report" }]);
      assert.ok(!JSON.stringify(declaration.data).includes("SYNTHETIC_DELIVERABLE_V1"));
    });

    await scenario("DEL-SESSION-OWNERSHIP", async () => {
      assert.equal(events(other).length, 0);
      const before = opened.length;
      assert.equal((await request(coordinates({ sessionId: other.session.id }))).status, 404);
      assert.equal(opened.length, before);
      ok(await present(other, [{ path }]));
      assert.equal(events().length, 1);
      assert.equal(events(other).length, 1);
      assert.notEqual(events(other)[0].data.callId, declaration.data.callId);
    });

    await scenario("DEL-OPEN-AND-PREVIEW-BACKEND", async () => {
      const list = await request(coordinates(), "GET");
      assert.equal(list.status, 200);
      assert.equal(list.headers.get("cache-control"), "no-store");
      assert.equal((await list.json()).applications[0].id, "synthetic.editor");
      assert.deepEqual(applicationQueries.at(-1), { path });
      const open = await request(
        coordinates({ application: "synthetic.editor", path: join(f.outside, "ignored.txt") }),
      );
      assert.equal(open.status, 204);
      assert.deepEqual(opened.at(-1), { path, application: "synthetic.editor" });
      assert.equal((await request(coordinates({ action: "reveal" }))).status, 204);
      assert.deepEqual(opened.at(-1), { path, action: "reveal" });
      const preview = await f.ctx.workspaceFiles.read(
        await f.previewScope(parent),
        path,
        {},
        new AbortController().signal,
      );
      // Official text pages join lines without a final terminator; byte reads preserve it.
      assert.equal(preview.text, "SYNTHETIC_DELIVERABLE_V1");
      assert.equal(preview.absolutePath, path);
      assert.equal(preview.eof, true);
      const bytes = await f.ctx.workspaceFiles.readBytes(
        await f.previewScope(parent),
        path,
        {},
        new AbortController().signal,
      );
      assert.deepEqual(Buffer.from(bytes.data), Buffer.from("SYNTHETIC_DELIVERABLE_V1\n"));
    });

    await scenario("DEL-INVALID-DECLARATIONS", async () => {
      const link = join(f.workspace, "final-link.txt");
      symlinkSync(path, link);
      for (const files of [
        [],
        Array.from({ length: 9 }, () => ({ path })),
        [{ path: " " }],
        [{ path: join(f.workspace, "missing.txt") }],
        [{ path: f.workspace }],
        [{ path: link }],
        [{ path }, { path: join(f.workspace, "missing-second.txt") }],
      ]) {
        const before = events().length;
        assert.equal((await present(parent, files)).isError, true);
        assert.equal(events().length, before, "failed calls cannot publish partial declarations");
      }
      const cancel = new AbortController();
      cancel.abort();
      assert.equal((await present(parent, [{ path }], cancel.signal)).isError, true);
      assert.equal(events().length, 1);
    });

    await scenario("DEL-OPEN-REFUSALS", async () => {
      const before = opened.length;
      for (const [extra, status] of [
        [{ action: "delete" }, 400],
        [{ index: "-1" }, 400],
        [{ seq: "1.5" }, 400],
        [{ index: "42" }, 404],
        [{ seq: "0" }, 404],
        [{ sessionId: "missing-synthetic-session" }, 404],
      ])
        assert.equal((await request(coordinates(extra))).status, status);
      desktopAvailable = false;
      assert.equal((await request(coordinates())).status, 409);
      desktopAvailable = true;
      const cancel = new AbortController();
      cancel.abort();
      await assert.rejects(request(coordinates(), "POST", cancel.signal), { name: "AbortError" });
      assert.equal(opened.length, before);
    });

    await scenario("DEL-ABSOLUTE-PATH-AND-CURRENT-CONTENT", async () => {
      const second = join(f.workspace, "second");
      mkdirSync(second);
      f.seed(join(second, "Synthetic report.txt"), "SYNTHETIC_UNRELATED_FILE");
      await f.ctx.workingDirectory.set(parent, second, new AbortController().signal);
      assert.equal(f.ctx.workingDirectory.get(parent.session), second);
      writeFileSync(path, "SYNTHETIC_DELIVERABLE_V2\n");
      assert.equal((await request(coordinates())).status, 204);
      assert.deepEqual(opened.at(-1), { path });
      const preview = await f.ctx.workspaceFiles.read(
        await f.previewScope(parent),
        path,
        {},
        new AbortController().signal,
      );
      assert.equal(preview.text, "SYNTHETIC_DELIVERABLE_V2");
      const bytes = await f.ctx.workspaceFiles.readBytes(
        await f.previewScope(parent),
        path,
        {},
        new AbortController().signal,
      );
      assert.deepEqual(Buffer.from(bytes.data), Buffer.from("SYNTHETIC_DELIVERABLE_V2\n"));
      assert.deepEqual(
        events()[0],
        declaration,
        "declaration is metadata, not a copied file snapshot",
      );
      rmSync(path);
      const before = opened.length;
      assert.equal((await request(coordinates())).status, 404);
      symlinkSync(join(second, "Synthetic report.txt"), path);
      assert.equal((await request(coordinates())).status, 404);
      assert.equal(opened.length, before);
    });

    await scenario("DEL-CLOSED-TURN-AND-DURABLE-READBACK", async () => {
      parent.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      assert.equal((await present(parent, [{ path }])).isError, true);
      assert.equal(events().length, 1);
      other.session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      await f.ctx.sessionPersistence.flush();
      for (const handle of handles) await handle.close();
      for (const agent of [parent, other]) {
        const reader = await f.ctx.sessionPersistence.open(agent.session.id, "read");
        try {
          const restored = (await reader.read(0)).events.filter(
            (event) => event.type === "deliverables/presented",
          );
          assert.deepEqual(restored, events(agent));
        } finally {
          await reader.close();
        }
      }
    });

    await scenario("DEL-REVERT-AND-ROUTE-LIFETIME", async () => {
      f.adapter.revert();
      const output = await f.ctx.systemPrompt.assemble({
        agent: parent,
        scope: parent,
        signal: new AbortController().signal,
      });
      assert.ok(
        output.sections.some((section) => section.name === "ui:deliverable-file-references"),
      );
      assert.ok(!output.sections.some((section) => section.name === "dsh-unlimit/operator"));
      const captured = routes.get("/api/present.open");
      await ui.dispose();
      await assert.rejects(
        captured.fetch(
          new Request(`http://127.0.0.1/api/present.open?${new URLSearchParams(coordinates())}`, {
            method: "POST",
          }),
        ),
        { name: "AbortError" },
      );
    });

    assert.equal(scenarios.length, 8);
    await f.dispose();
    if (process.env.DSH_UNLIMIT_DELIVERABLES_EVIDENCE === "1") {
      const evidence = f.evidence();
      evidence.sourceDigests = [
        "tests/deliverables-host.test.mjs",
        "tests/helpers/file-permissions-fixture.mjs",
        "tests/helpers/official-packages.mjs",
        "src/host/runtime.js",
        "src/core/prompts.js",
        "src/host/permission-defaults.js",
      ].map((path) => ({
        path,
        sha256: createHash("sha256")
          .update(readFileSync(join(projectRoot, path)))
          .digest("hex"),
      }));
      writeFileSync(
        join(projectRoot, "docs/evidence/deliverables-acceptance.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            behaviorId: "CORE-DELIVERABLE",
            status: "partial",
            node: process.version,
            platform: process.platform,
            ...evidence,
            cases: scenarios,
            boundaries: {
              authenticationTransportMocked: true,
              desktopOpenerCaptured: true,
              renderedPreviewVerified: false,
              agentLoopExecuted: false,
              realDesktopTouched: false,
              durableSessionsReadBack: 2,
            },
            limitations: [
              "Native application opening, desktop file cards and local preview process remain unverified.",
              "In-memory Connection registration captures official route handlers; it does not prove transport authentication.",
              "Files are live references; metadata readback is not a durable copy of file contents.",
            ],
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
);
