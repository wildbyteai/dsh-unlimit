import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filePermissionsFixture, projectRoot } from "./helpers/file-permissions-fixture.mjs";

const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
const cache = process.env.DSH_UNLIMIT_OFFICIAL_PACKAGES;
const optionalHost = {
  skip:
    runtimeRoot && cache
      ? false
      : "Set DSH_UNLIMIT_RUNTIME and DSH_UNLIMIT_OFFICIAL_PACKAGES for real official file permissions; no profile is loaded",
  timeout: 30000,
};

test(
  "official file tools, effective mutation policy and preview reads over synthetic files",
  optionalHost,
  async (t) => {
    const f = await filePermissionsFixture(t, runtimeRoot, cache);
    const plain = await f.createAgent("default"),
      readOnly = await f.createAgent("read-only", "read-only"),
      workspaceWrite = await f.createAgent("workspace-write", "workspace-write");
    const scenarios = [];
    const invoke = (agent, name, path, args = {}, signal) =>
      f.execute(agent, name, { file_path: path, ...args }, signal);
    const ok = (result) => assert.equal(result.isError, false, f.text(result));
    const error = (result, code, message) => {
      assert.equal(result.isError, true, f.text(result));
      if (code) assert.equal(result.error?.info?.code, code, f.text(result));
      if (message) assert.match(f.text(result), message);
    };
    const scenario = async (id, description, action) => {
      await t.test(description, async () => {
        await action();
        scenarios.push({ id, result: "passed", description });
      });
    };
    const inner = f.seed(join(f.workspace, "observed.txt"), "INNER_HEAD\nINNER_TAIL"),
      outer = f.seed(join(f.outside, "observed.txt"), "OUTER_HEAD\nOUTER_TAIL");

    await scenario(
      "FILES-READ-ONLY",
      "read-only reads both synthetic directories but rejects actual create, overwrite and edit",
      async () => {
        assert.equal(f.ctx.sandboxPolicy.resolve({ session: plain.session }).mode, "read-only");
        for (const [path, marker] of [
          [inner, "INNER_TAIL"],
          [outer, "OUTER_TAIL"],
        ]) {
          const result = await invoke(plain, "read", path);
          ok(result);
          assert.ok(f.text(result).includes(marker));
          const before = readFileSync(path, "utf8");
          error(
            await invoke(plain, "write", path, { content: "REJECTED_OVERWRITE" }),
            "FS_SANDBOX_DENIED",
            /file access denied under read-only mode/,
          );
          error(
            await invoke(plain, "edit", path, { old_string: marker, new_string: "REJECTED_EDIT" }),
            "FS_SANDBOX_DENIED",
          );
          assert.equal(readFileSync(path, "utf8"), before);
          const fresh = join(path + ".new");
          error(
            await invoke(plain, "write", fresh, { content: "REJECTED_CREATE" }),
            "FS_SANDBOX_DENIED",
          );
          assert.equal(existsSync(fresh), false);
        }
      },
    );

    await scenario(
      "FILES-WORKSPACE-WRITE",
      "workspace-write creates and edits real files, rejects sibling/traversal/symlink mutations and permits platform temp",
      async () => {
        const inside = join(f.workspace, "created.txt"),
          outside = join(f.outside, "created.txt"),
          temporary = join(f.temporary, "created.txt");
        ok(await invoke(workspaceWrite, "write", inside, { content: "CREATE_ME" }));
        assert.equal(readFileSync(inside, "utf8"), "CREATE_ME");
        ok(
          await invoke(workspaceWrite, "edit", inside, {
            old_string: "CREATE_ME",
            new_string: "EDITED",
          }),
        );
        assert.equal(readFileSync(inside, "utf8"), "EDITED");
        error(
          await invoke(workspaceWrite, "write", outside, { content: "DENIED" }),
          "FS_SANDBOX_DENIED",
          /workspace-write mode/,
        );
        error(
          await invoke(workspaceWrite, "write", "../outside/traversal.txt", { content: "DENIED" }),
          "FS_SANDBOX_DENIED",
        );
        const link = join(f.workspace, "linked-outside");
        symlinkSync(f.outside, link, "dir");
        error(
          await invoke(workspaceWrite, "write", join(link, "link-created.txt"), {
            content: "DENIED",
          }),
          "FS_SANDBOX_DENIED",
        );
        for (const path of [
          outside,
          join(f.outside, "traversal.txt"),
          join(f.outside, "link-created.txt"),
        ])
          assert.equal(existsSync(path), false);
        ok(await invoke(workspaceWrite, "read", outer));
        error(
          await invoke(workspaceWrite, "edit", outer, {
            old_string: "OUTER_TAIL",
            new_string: "DENIED",
          }),
          "FS_SANDBOX_DENIED",
        );
        assert.equal(readFileSync(outer, "utf8"), "OUTER_HEAD\nOUTER_TAIL");
        ok(await invoke(workspaceWrite, "write", temporary, { content: "PLATFORM_TEMP_ALLOWED" }));
        assert.equal(readFileSync(temporary, "utf8"), "PLATFORM_TEMP_ALLOWED");
      },
    );

    await scenario(
      "FILES-FULL-ACCESS",
      "plugin fullAccess reaches the real provider while explicit per-session restrictions retain priority",
      async () => {
        f.settings.enabled = true;
        f.adapter.apply();
        assert.equal(
          f.ctx.sandboxPolicy.resolve({ session: plain.session }).mode,
          "danger-full-access",
        );
        const path = join(f.outside, "full-access.txt");
        ok(await invoke(plain, "write", path, { content: "FULL_ACCESS_CREATED" }));
        ok(await invoke(plain, "edit", path, { old_string: "CREATED", new_string: "EDITED" }));
        assert.equal(readFileSync(path, "utf8"), "FULL_ACCESS_EDITED");
        for (const [agent, mode] of [
          [readOnly, "read-only"],
          [workspaceWrite, "workspace-write"],
        ]) {
          assert.equal(f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode, mode);
          const deniedPath = join(f.outside, `${mode}.txt`);
          error(
            await invoke(agent, "write", deniedPath, { content: "DENIED" }),
            "FS_SANDBOX_DENIED",
          );
          assert.equal(existsSync(deniedPath), false);
        }
        f.api.sandbox.setSandboxMode(plain.session, "read-only");
        assert.equal(f.ctx.sandboxPolicy.resolve({ session: plain.session }).mode, "read-only");
        error(
          await invoke(plain, "edit", path, { old_string: "EDITED", new_string: "DENIED" }),
          "FS_SANDBOX_DENIED",
        );
        assert.equal(readFileSync(path, "utf8"), "FULL_ACCESS_EDITED");
        f.adapter.revert();
        f.settings.enabled = false;
      },
    );

    await scenario(
      "FILES-DISABLE-REVERT",
      "disabling and reverting the plugin restore effective read-only writes without modifying the official policy method",
      async () => {
        const agent = await f.createAgent("revert"),
          policy = f.ctx.sandboxPolicy[f.api.cordis.symbols.original],
          original = policy.resolve;
        f.settings.enabled = true;
        f.adapter.apply();
        assert.equal(
          f.ctx.sandboxPolicy.resolve({ session: agent.session }).mode,
          "danger-full-access",
        );
        f.settings.enabled = false;
        const disabled = join(f.outside, "disabled.txt");
        error(await invoke(agent, "write", disabled, { content: "DENIED" }), "FS_SANDBOX_DENIED");
        assert.equal(existsSync(disabled), false);
        f.adapter.revert();
        assert.equal(policy.resolve, original);
        const reverted = join(f.workspace, "reverted.txt");
        error(await invoke(agent, "write", reverted, { content: "DENIED" }), "FS_SANDBOX_DENIED");
        assert.equal(existsSync(reverted), false);
      },
    );

    await scenario(
      "FILES-OBSERVATION-ERRORS",
      "official observation guards reject unread and stale mutation, then accept a reread retry",
      async () => {
        const path = f.seed(join(f.workspace, "guarded.txt"), "GUARD_ORIGINAL");
        error(
          await invoke(workspaceWrite, "edit", path, {
            old_string: "ORIGINAL",
            new_string: "DENIED",
          }),
          "FS_NOT_OBSERVED",
        );
        error(
          await invoke(workspaceWrite, "write", path, { content: "DENIED" }),
          "FS_NOT_OBSERVED",
        );
        assert.equal(readFileSync(path, "utf8"), "GUARD_ORIGINAL");
        ok(await invoke(workspaceWrite, "read", path));
        f.seed(path, "GUARD_EXTERNALLY_CHANGED_LONGER");
        error(
          await invoke(workspaceWrite, "edit", path, {
            old_string: "CHANGED",
            new_string: "DENIED",
          }),
          "FS_STALE_VERSION",
        );
        assert.equal(readFileSync(path, "utf8"), "GUARD_EXTERNALLY_CHANGED_LONGER");
        ok(await invoke(workspaceWrite, "read", path));
        ok(
          await invoke(workspaceWrite, "edit", path, {
            old_string: "CHANGED",
            new_string: "REREAD_EDITED",
          }),
        );
        assert.equal(readFileSync(path, "utf8"), "GUARD_EXTERNALLY_REREAD_EDITED_LONGER");
        error(
          await invoke(workspaceWrite, "read", join(f.workspace, "missing.txt")),
          "FS_NOT_FOUND",
        );
        error(await invoke(workspaceWrite, "read", f.workspace), undefined, /not a regular file/);
      },
    );

    await scenario(
      "FILES-DENIAL-CANCEL",
      "official pre-denial and cancellation prevent actual filesystem publication",
      async () => {
        const path = join(f.workspace, "pre-denied.txt");
        const detach = f.ctx.on("tools/pre-execute", () => ({
          kind: "deny",
          reason: "Synthetic explicit user refusal",
        }));
        try {
          error(
            await invoke(workspaceWrite, "write", path, { content: "DENIED" }),
            undefined,
            /Synthetic explicit user refusal/,
          );
        } finally {
          detach();
        }
        assert.equal(existsSync(path), false);
        const cancelled = join(f.workspace, "cancelled.txt"),
          control = new AbortController();
        control.abort(new Error("Synthetic cancellation"));
        error(
          await invoke(workspaceWrite, "write", cancelled, { content: "DENIED" }, control.signal),
        );
        assert.equal(existsSync(cancelled), false);
      },
    );

    await scenario(
      "FILES-PREVIEW",
      "official preview host service reads exact synthetic text/bytes and rejects invalid targets and outside directory listing",
      async () => {
        const scope = await f.previewScope(readOnly);
        for (const [path, expected] of [
          [inner, "INNER_HEAD\nINNER_TAIL"],
          [outer, "OUTER_HEAD\nOUTER_TAIL"],
        ]) {
          const page = await f.ctx.workspaceFiles.read(
            scope,
            path,
            {},
            new AbortController().signal,
          );
          assert.equal(page.text, expected);
          assert.equal(page.absolutePath, path);
          assert.equal(page.eof, true);
          assert.equal(page.lines, 2);
        }
        const bytes = Buffer.from([0, 1, 2, 255]),
          binary = f.seed(join(f.outside, "synthetic.bin"), bytes);
        const binaryResult = await f.ctx.workspaceFiles.readBytes(
          scope,
          binary,
          {},
          new AbortController().signal,
        );
        assert.deepEqual(Buffer.from(binaryResult.data), bytes);
        await assert.rejects(
          f.ctx.workspaceFiles.read(scope, binary, {}, new AbortController().signal),
          { code: "workspace-file/not-text" },
        );
        await assert.rejects(
          f.ctx.workspaceFiles.read(scope, f.workspace, {}, new AbortController().signal),
          { code: "workspace-file/not-regular-file" },
        );
        await assert.rejects(
          f.ctx.workspaceFiles.read(
            scope,
            join(f.workspace, "missing-preview.txt"),
            {},
            new AbortController().signal,
          ),
          { code: "workspace-file/not-found" },
        );
        const link = join(f.workspace, "preview-link.txt");
        symlinkSync(inner, link);
        await assert.rejects(
          f.ctx.workspaceFiles.read(scope, link, {}, new AbortController().signal),
          { code: "workspace-file/not-regular-file" },
        );
        const listed = await f.ctx.workspaceFiles.list(scope, ".", new AbortController().signal);
        assert.ok(listed.entries.some((entry) => entry.name === "observed.txt"));
        await assert.rejects(
          f.ctx.workspaceFiles.list(scope, f.outside, new AbortController().signal),
          { code: "workspace-file/outside-workspace" },
        );
        assert.equal(
          await f.ctx.typert.lookups.get("workspaceFileScope").resolve("synthetic-unknown-session"),
          undefined,
        );
      },
    );

    await scenario(
      "FILES-TERMINAL-REFUSAL",
      "official terminal tools expose missing-backend errors and never report a created terminal",
      async () => {
        for (const name of [
          "terminal_open",
          "terminal_send",
          "terminal_read",
          "terminal_signal",
          "terminal_close",
          "terminal_list",
        ])
          assert.ok(f.ctx.tools.get(name, undefined), name);
        const result = await f.execute(workspaceWrite, "terminal_open", {
          type: "shell",
          cwd: f.workspace,
        });
        error(result, undefined, /no PTY backend registered/);
        await assert.rejects(
          f.ctx.terminals.spawn(workspaceWrite, { type: "shell", cwd: f.workspace }),
          { code: "NO_BACKEND" },
        );
        assert.deepEqual(f.ctx.terminals.list(workspaceWrite), []);
        const listed = await f.execute(workspaceWrite, "terminal_list", {});
        ok(listed);
        assert.deepEqual(listed.value, []);
        assert.deepEqual(f.ctx.terminals.list(workspaceWrite), []);
      },
    );

    assert.equal(scenarios.length, 8, "every claimed scenario must have completed all assertions");
    await f.dispose();
    const evidence = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      behaviorId: "CORE-FILES",
      status: "partial-official-isolation",
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      testResult: {
        tests: scenarios.length + 1,
        passed: scenarios.length + 1,
        failed: 0,
        skipped: 0,
      },
      ...f.evidence(),
      scenarios,
      limitations: [
        "No desktop installation, reload, profile, real Session history or rendered preview was exercised.",
        "Preview coverage invokes the real Host service after its official live Session-header lookup; Gateway transport and authorization were not exercised.",
        "Filesystem sandboxing is the official trusted-code mutation fence, not a kernel sandbox; read authority remains unconfined by these modes.",
        "Terminal coverage proves a real missing-backend error only; no PTY, shell command, terminal process permission or cross-family process confinement was executed.",
        "Known modified tool-fs, tool-bash and tool-pwsh installed entries were hashed only, never imported or restored.",
        "read_image, filesystem search tools, present, watches, elevation retries and platform-specific process sandboxing remain outside this acceptance slice.",
      ],
    };
    if (process.env.DSH_UNLIMIT_FILE_PERMISSIONS_EVIDENCE === "1")
      writeFileSync(
        join(projectRoot, "docs/evidence/file-permissions-acceptance.json"),
        JSON.stringify(evidence, null, 2) + "\n",
      );
  },
);
