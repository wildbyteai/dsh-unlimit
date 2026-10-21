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
  unwatchFile,
  watchFile,
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

test(
  "legacy roots and partial configuration updates preserve explicit directory precedence and templates",
  executableTests,
  async (t) => {
    const { directory, root, database, store, call, tool } = fixture(t);
    const first = join(directory, "extra first");
    const second = join(directory, "extra second");
    const templateDir = join(directory, "templates ; literal");
    for (const path of [first, second, templateDir]) mkdirSync(path);
    writeFileSync(join(templateDir, "not-executed.txt"), "synthetic template, never loaded");
    const rootTool = tool("nmap", "process.stdout.write('root');");
    const firstTool = tool("nmap", "process.stdout.write('first');", first);
    const secondTool = tool("nmap", "process.stdout.write('second');", second);
    const alias = tool(
      "chosen script with spaces ; literal",
      "process.stdout.write('explicit');",
      second,
    );
    // An existing toolkit.root is migrated on first new-format save, never discarded.
    store.setMeta("toolkit.root", root);
    assert.equal(call("toolkit.status").root, root);
    const status = call("toolkit.save", { searchDirs: [first, second, first], templateDir });
    assert.deepEqual(status.searchDirs, [first, second]);
    const nmap = () => call("toolkit.status").tools.find((item) => item.id === "nmap");
    assert.equal(nmap().path, rootTool);
    assert.equal(nmap().source, "root");
    call("toolkit.save", { root: "" });
    assert.equal(nmap().path, firstTool);
    assert.equal(nmap().source, "search");
    call("toolkit.save", { searchDirs: [second, first] });
    assert.equal(nmap().path, secondTool);
    call("toolkit.save", { root, toolPaths: { nmap: alias } });
    assert.equal(nmap().path, alias);
    assert.equal(nmap().source, "explicit");
    assert.equal((await call("toolkit.probe", { tool: "nmap" })).stdout, "explicit");
    const other = new WorkspaceStore(database);
    try {
      const persisted = new Toolkit(other).status();
      assert.equal(persisted.templateDir, templateDir);
      assert.deepEqual(persisted.searchDirs, [second, first]);
      assert.deepEqual(persisted.toolPaths, { nmap: alias });
    } finally {
      other.close();
    }
    // The original {root} request stays compatible and does not erase newer fields.
    assert.equal(call("toolkit.save", { root }).templateDir, templateDir);
    call("toolkit.save", { toolPaths: {} });
    assert.equal(nmap().path, rootTool);
  },
);

test(
  "pre-uninstall probe cancellation stops the owned process without closing the toolkit",
  executableTests,
  async (t) => {
    const { directory, root, call, tool, toolkit } = fixture(t);
    const pidFile = join(directory, "uninstall-probe-pid");
    const readyFile = join(directory, "uninstall-probe-ready");
    const path = tool(
      "nmap",
      `const fs = require('node:fs'); const pidFile = ${JSON.stringify(pidFile)}; fs.writeFileSync(pidFile + '.tmp', String(process.pid)); fs.renameSync(pidFile + '.tmp', pidFile); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); setInterval(() => {}, 1000);`,
    );
    call("toolkit.save", { root });
    let readyListener;
    const ready = new Promise((resolve, reject) => {
      readyListener = (current) => {
        if (current.nlink === 0) return;
        try {
          const value = readFileSync(pidFile, "utf8");
          assert.match(value, /^[1-9]\d*$/);
          const pid = Number(value);
          assert.ok(Number.isSafeInteger(pid));
          resolve(pid);
        } catch (error) {
          reject(error);
        }
      };
      watchFile(readyFile, { interval: 10 }, readyListener).on("error", reject);
    });
    const probe = call("toolkit.probe", { tool: "nmap" });
    try {
      const pid = await Promise.race([
        ready,
        probe.then(() => assert.fail("synthetic probe completed before readiness")),
      ]);
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        "synthetic process must be alive before cancellation",
      );
      const cancelled = assert.rejects(probe, code("CANCELLED"));
      assert.deepEqual(await toolkit.cancelProbes(), { stopped: true });
      await cancelled;
      assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), code("ESRCH"));
      assert.equal(toolkit.closed, false);
      const original = readFileSync(path, "utf8").split("\n")[0];
      writeFileSync(path, `${original}\nprocess.stdout.write('synthetic next probe');\n`);
      assert.equal((await call("toolkit.probe", { tool: "nmap" })).stdout, "synthetic next probe");
    } finally {
      unwatchFile(readyFile, readyListener);
      await toolkit.cancelProbes();
      await probe.catch(() => {});
    }
  },
);

test(
  "configuration rejects invalid directories, unknown overrides and nonexecutable aliases without partial writes",
  executableTests,
  (t) => {
    const { directory, root, store, call, tool } = fixture(t);
    const valid = tool("nmap", "");
    const nonExecutable = tool("not executable", "");
    chmodSync(nonExecutable, 0o600);
    call("toolkit.save", { root });
    const before = store.meta("toolkit.config");
    for (const payload of [
      { searchDirs: ["relative"] },
      { searchDirs: [join(directory, "missing")] },
      { searchDirs: root },
      { templateDir: valid },
      { templateDir: join(directory, "missing") },
      { toolPaths: { unknown: valid } },
      { toolPaths: { nmap: "relative" } },
      { toolPaths: { nmap: root } },
      { toolPaths: { nmap: nonExecutable } },
      { toolPaths: { nmap: [valid, "--unsafe"] } },
    ])
      assert.throws(() => call("toolkit.save", payload), code("INVALID_INPUT"));
    assert.deepEqual(store.meta("toolkit.config"), before);
  },
);

test(
  "broken explicit overrides never fall back and replaced search directories cannot expand scope",
  executableTests,
  (t) => {
    const { directory, root, call, tool } = fixture(t);
    tool("nmap", "");
    const extra = join(directory, "extra");
    const outside = join(directory, "outside config");
    mkdirSync(extra);
    mkdirSync(outside);
    const alias = tool("named alias", "", outside);
    call("toolkit.save", { root, searchDirs: [extra], toolPaths: { nmap: alias } });
    rmSync(alias);
    const missing = call("toolkit.status").tools.find((item) => item.id === "nmap");
    assert.equal(missing.path, null);
    assert.equal(missing.source, "explicit");
    assert.equal(missing.available, false);
    assert.match(missing.detail, /未采用其他候选/);
    call("toolkit.save", { toolPaths: {} });
    rmSync(extra, { recursive: true });
    symlinkSync(outside, extra, "dir");
    assert.throws(() => call("toolkit.status"), code("INVALID_INPUT"));
  },
);

const pdHelp = "httpx HTTP toolkit using retryablehttp\n-status-code -tech-detect\n";
const pythonHelp =
  "HTTPX\nA next generation HTTP client.\nUsage: httpx <URL> [OPTIONS]\n--method METHOD\n";

test(
  "httpx requires product identity, supplements ambiguous versions with fixed help and invalidates changed files",
  executableTests,
  async (t) => {
    const { root, call, tool } = fixture(t);
    const path = tool(
      "httpx",
      `const args = process.argv.slice(2); if (JSON.stringify(args) === '["-version"]') process.stdout.write('httpx v1 synthetic\\n'); else if (JSON.stringify(args) === '["--help"]') process.stdout.write(${JSON.stringify(pdHelp)}); else process.exit(9);`,
    );
    call("toolkit.save", { root });
    let item = call("toolkit.status").tools.find((item) => item.id === "httpx");
    assert.equal(item.path, path);
    assert.equal(item.available, false);
    assert.equal(item.identity, "unverified");
    const result = await call("toolkit.probe", { tool: "httpx" });
    assert.equal(result.identity, "verified");
    assert.equal(result.available, true);
    assert.deepEqual(
      result.attempts.map((item) => item.args),
      [["-version"], ["--help"]],
    );
    assert.equal(call("toolkit.status").tools.find((item) => item.id === "httpx").available, true);
    tool("httpx", "process.stdout.write('httpx 99 unknown');");
    item = call("toolkit.status").tools.find((item) => item.id === "httpx");
    assert.equal(item.path, path);
    assert.equal(item.available, false);
    assert.equal(item.identity, "unverified");
    assert.equal((await call("toolkit.probe", { tool: "httpx" })).identity, "unknown");
    assert.equal(call("toolkit.status").tools.find((item) => item.id === "httpx").available, false);
  },
);

test(
  "Python HTTPX, mixed identities and generic versions are not security-tool availability",
  executableTests,
  async (t) => {
    const { directory, root, call, tool } = fixture(t);
    const extra = join(directory, "second httpx");
    mkdirSync(extra);
    tool("httpx", "process.stdout.write('httpx ProjectDiscovery.io synthetic version');", extra);
    tool(
      "httpx",
      `if (process.argv[2] === '-version') process.exit(2); process.stdout.write(${JSON.stringify(pythonHelp)});`,
    );
    call("toolkit.save", { root, searchDirs: [extra] });
    let result = await call("toolkit.probe", { tool: "httpx" });
    assert.equal(result.identity, "mismatch");
    assert.equal(result.available, false);
    assert.equal(call("toolkit.status").tools.find((item) => item.id === "httpx").source, "root");
    tool("httpx", `process.stdout.write(${JSON.stringify(pythonHelp + pdHelp)});`);
    result = await call("toolkit.probe", { tool: "httpx" });
    assert.equal(result.identity, "unknown");
    assert.equal(result.available, false);
    call("toolkit.save", { root: "" });
    result = await call("toolkit.probe", { tool: "httpx" });
    assert.equal(result.identity, "verified");
    assert.equal(result.attempts.length, 1);
    assert.equal(result.source, "search");
  },
);

test(
  "fixed identity attempts share timeout and total output limits",
  executableTests,
  async (t) => {
    const { root, call, tool, toolkit } = fixture(t);
    tool(
      "httpx",
      "setTimeout(() => process.stdout.write('httpx unknown'), process.argv[2] === '-version' ? 350 : 550);",
    );
    call("toolkit.save", { root });
    await assert.rejects(call("toolkit.probe", { tool: "httpx", timeoutMs: 750 }), code("TIMEOUT"));
    assert.equal(toolkit.pending.size, 0);
    assert.equal(
      call("toolkit.status").tools.find((item) => item.id === "httpx").identity,
      "unverified",
    );
    tool("httpx", "process.stdout.write('x'.repeat(40000));");
    await assert.rejects(call("toolkit.probe", { tool: "httpx" }), code("OUTPUT_LIMIT"));
    assert.equal(toolkit.pending.size, 0);
  },
);

test(
  "revoking configured paths cancels an owned probe and removes its disposable home",
  executableTests,
  async (t) => {
    const { directory, root, call, tool, toolkit } = fixture(t);
    const observed = join(directory, "environment.json");
    tool(
      "httpx",
      `require('node:fs').writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ pid: process.pid, home: process.env.HOME, cwd: process.cwd(), xdg: process.env.XDG_CONFIG_HOME })); setInterval(() => {}, 1000);`,
    );
    call("toolkit.save", { root });
    const checking = call("toolkit.probe", { tool: "httpx" });
    const rejected = assert.rejects(checking, code("CANCELLED"));
    for (let attempt = 0; !existsSync(observed) && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const environment = JSON.parse(readFileSync(observed, "utf8"));
    assert.equal(realpathSync(environment.home), realpathSync(environment.cwd));
    assert.equal(environment.xdg, environment.home);
    assert.notEqual(environment.home, root);
    const cleared = call("toolkit.save", {
      root: "",
      searchDirs: [],
      toolPaths: {},
      templateDir: "",
    });
    await rejected;
    assert.equal(toolkit.pending.size, 0);
    assert.equal(existsSync(environment.home), false);
    assert.throws(() => process.kill(environment.pid, 0), code("ESRCH"));
    assert.ok(cleared.tools.every((item) => item.path === null && !item.available));
  },
);
