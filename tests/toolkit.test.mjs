import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/core/store.js";
import { Toolkit } from "../src/core/toolkit.js";

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-toolkit-")));
  const root = join(directory, "tools with spaces ; $ literal");
  mkdirSync(root);
  const database = join(directory, "synthetic.sqlite");
  const store = new WorkspaceStore(database);
  const toolkit = new Toolkit(store);
  // POSIX shebangs do not quote interpreter paths; the desktop Node path contains spaces.
  const interpreter = join(directory, "fixture-node");
  if (process.platform !== "win32") symlinkSync(process.execPath, interpreter);
  t.after(async () => {
    await toolkit.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = (action, payload, options) => toolkit.dispatch(action, payload, options);
  const tool = (id, body, parent = root) => {
    const path = join(parent, process.platform === "win32" ? `${id}.exe` : id);
    writeFileSync(
      path,
      `#!${process.platform === "win32" ? process.execPath : interpreter}\n${body}\n`,
      { mode: 0o700 },
    );
    return path;
  };
  return { directory, root, database, store, toolkit, call, tool };
}

const code = (expected) => (error) => error.code === expected;
const executableTests = {
  skip:
    process.platform === "win32"
      ? "Node shebang fixtures require POSIX; Windows needs separate native executable acceptance"
      : false,
};

test("tool root is explicit, absolute, canonical, persistent and must be a directory", (t) => {
  const { directory, root, database, call } = fixture(t);
  assert.equal(call("toolkit.status").root, "");
  assert.ok(call("toolkit.status").tools.every((tool) => !tool.available && tool.path === null));
  assert.throws(() => call("toolkit.save", { root: "relative" }), code("INVALID_INPUT"));
  assert.throws(
    () => call("toolkit.save", { root: join(directory, "absent") }),
    code("INVALID_INPUT"),
  );
  const file = join(directory, "not-directory");
  writeFileSync(file, "synthetic");
  assert.throws(() => call("toolkit.save", { root: file }), code("INVALID_INPUT"));
  const alias = join(directory, "alias");
  symlinkSync(root, alias, "dir");
  assert.equal(call("toolkit.save", { root: alias }).root, root);
  const otherStore = new WorkspaceStore(database);
  try {
    assert.equal(new Toolkit(otherStore).status().root, root);
  } finally {
    otherStore.close();
  }
  assert.throws(() => call("toolkit.save", { root, command: "ignored" }), code("INVALID_INPUT"));
  assert.equal(call("toolkit.status").root, root);
});

test(
  "inventory reads only selected root and one subdirectory level, never links or PATH",
  executableTests,
  (t) => {
    const { directory, root, call, tool } = fixture(t);
    const first = join(root, "one");
    const second = join(first, "two");
    mkdirSync(second, { recursive: true });
    const direct = tool("nmap", "");
    tool("nmap", "", first);
    const shallow = tool("nuclei", "", first);
    tool("fscan", "", second);
    const outside = join(directory, "outside");
    mkdirSync(outside);
    const externalTool = tool("chisel", "", outside);
    symlinkSync(externalTool, join(root, "chisel"));
    symlinkSync(outside, join(root, "external-directory"), "dir");
    const nonExecutable = tool("gogo", "");
    chmodSync(nonExecutable, 0o600);
    writeFileSync(join(root, "credentials.txt"), "Synthetic content must never be opened");
    const status = call("toolkit.save", { root });
    const found = (id) => status.tools.find((item) => item.id === id);
    assert.equal(found("nmap").path, direct);
    assert.equal(found("nuclei").path, shallow);
    for (const id of ["fscan", "chisel", "gogo"]) assert.equal(found(id).available, false);
    assert.deepEqual(status.runs, []);
  },
);

test("a saved directory replaced by a symlink cannot expand tool scope", (t) => {
  const { directory, root, call } = fixture(t);
  call("toolkit.save", { root });
  rmSync(root, { recursive: true });
  const other = join(directory, "other");
  mkdirSync(other);
  symlinkSync(other, root, "dir");
  assert.throws(() => call("toolkit.status"), code("INVALID_INPUT"));
});

test("adapt is a read-only offline missing-tool list, with no run actions", (t) => {
  const { root, store, call } = fixture(t);
  call("toolkit.save", { root });
  const before = store.meta("toolkit.root");
  const result = call("toolkit.adapt");
  assert.equal(result.offline, true);
  assert.ok(result.missing.some((tool) => tool.id === "nmap" && tool.advice.includes("离线")));
  assert.equal(store.meta("toolkit.root"), before);
  for (const action of [
    "toolkit.start",
    "toolkit.stop",
    "toolkit.output",
    "toolkit.download",
    "toolkit.unknown",
  ]) {
    assert.throws(() => call(action), code("UNSUPPORTED"));
  }
  assert.throws(() => call("toolkit.adapt", { install: true }), code("INVALID_INPUT"));
});

test(
  "probe executes real Node fixture with exactly --version and does not inherit credentials",
  executableTests,
  async (t) => {
    const { root, call, tool } = fixture(t);
    const name = "DSH_UNLIMIT_SYNTHETIC_SECRET";
    const previous = process.env[name];
    process.env[name] = "synthetic-secret";
    try {
      const path = tool(
        "nmap",
        `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), secret: process.env.${name} ?? null })); process.stderr.write('synthetic stderr');`,
      );
      call("toolkit.save", { root });
      const result = await call("toolkit.probe", { tool: "nmap" });
      assert.equal(result.path, path);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(result.stdout), { args: ["--version"], secret: null });
      assert.equal(result.stderr, "synthetic stderr");
      assert.deepEqual(call("toolkit.status").runs, []);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  },
);

test("tool IDs, paths and extra arguments cannot inject a command", executableTests, async (t) => {
  const { directory, root, call, tool } = fixture(t);
  const sentinel = join(directory, "must-not-exist");
  tool("nmap", `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`);
  call("toolkit.save", { root });
  for (const payload of [
    { tool: "nmap; touch ignored" },
    { tool: "../nmap" },
    { tool: join(root, "nmap") },
    { tool: "nmap", args: ["--version", "; touch ignored"] },
    { tool: "nmap", command: "arbitrary-command" },
    { tool: "nmap", env: {} },
    { tool: "nmap", timeoutMs: 1 },
    { tool: "nmap", timeoutMs: 10001 },
  ])
    await assert.rejects(call("toolkit.probe", payload), code("INVALID_INPUT"));
  await assert.rejects(call("toolkit.probe", { tool: "fscan" }), code("NOT_FOUND"));
  assert.equal(existsSync(sentinel), false);
});

test(
  "failed or unlaunchable tools reject rather than returning successful version results",
  executableTests,
  async (t) => {
    const { root, call, tool } = fixture(t);
    const path = tool("nmap", "process.exit(7);");
    call("toolkit.save", { root });
    await assert.rejects(call("toolkit.probe", { tool: "nmap" }), code("TOOL_FAILED"));
    writeFileSync(path, "#!/definitely/not/an/interpreter\nsynthetic\n", { mode: 0o700 });
    await assert.rejects(call("toolkit.probe", { tool: "nmap" }), code("TOOL_FAILED"));
  },
);

test("timeout kills the owned probe and its POSIX descendants", executableTests, async (t) => {
  const { directory, root, call, tool } = fixture(t);
  const pidFile = join(directory, "probe-pid");
  const childPidFile = join(directory, "descendant-pid");
  const descendant = join(directory, "descendant.cjs");
  writeFileSync(
    descendant,
    `require('node:fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
  );
  tool(
    "nmap",
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); require('node:child_process').spawn(process.execPath, [${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`,
  );
  call("toolkit.save", { root });
  await assert.rejects(call("toolkit.probe", { tool: "nmap", timeoutMs: 3000 }), code("TIMEOUT"));
  assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), code("ESRCH"));
  const childPid = Number(readFileSync(childPidFile, "utf8"));
  // Some kernels briefly expose a killed descendant until its parent reaps it.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      process.kill(childPid, 0);
    } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("probe descendant was not reaped after cancellation");
});

test("output limit terminates excessive version output", executableTests, async (t) => {
  const { root, call, tool } = fixture(t);
  tool("nmap", "process.stdout.write('x'.repeat(100000)); setInterval(() => {}, 1000);");
  call("toolkit.save", { root });
  await assert.rejects(call("toolkit.probe", { tool: "nmap" }), code("OUTPUT_LIMIT"));
});

test(
  "abort signal and toolkit close cancel probes and release pending processes",
  executableTests,
  async (t) => {
    const { root, call, tool, toolkit } = fixture(t);
    tool("nmap", "setInterval(() => {}, 1000);");
    call("toolkit.save", { root });
    const controller = new AbortController();
    const probe = call("toolkit.probe", { tool: "nmap" }, { signal: controller.signal });
    const assertion = assert.rejects(probe, code("CANCELLED"));
    controller.abort();
    await assertion;
    assert.equal(toolkit.pending.size, 0);
    await assert.rejects(
      call("toolkit.probe", { tool: "nmap" }, { signal: controller.signal }),
      code("CANCELLED"),
    );
    const second = call("toolkit.probe", { tool: "nmap" });
    const secondAssertion = assert.rejects(second, code("CANCELLED"));
    await toolkit.close();
    await secondAssertion;
    assert.equal(toolkit.pending.size, 0);
    await assert.rejects(call("toolkit.probe", { tool: "nmap" }), code("UNSUPPORTED"));
  },
);
