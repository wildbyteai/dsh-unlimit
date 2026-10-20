import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkspaceStore } from "../../src/core/store.js";
import { DrillAdmission } from "../../src/core/admission.js";
import { DesktopMaintenance } from "../../src/host/maintenance.js";
import { createHandler } from "../../src/server/http.js";

export const runtimeRoot = process.env.DSH_UNLIMIT_RUNTIME;
export const hostOnly = {
  skip: runtimeRoot
    ? false
    : "Set DSH_UNLIMIT_RUNTIME; only temporary synthetic profiles are opened",
  timeout: 15000,
};
let official;
const verified = [];

async function loadOfficial() {
  official ??= (async () => {
    const descriptor = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
    assert.equal(descriptor.release.version, "0.2.1-rc.2");
    const require = createRequire(join(runtimeRoot, "package.json"));
    const load = async (name) => {
      const filename = require.resolve(name);
      const path = relative(runtimeRoot, filename);
      const entry = descriptor.files.find((item) => item.path === path);
      assert.ok(entry, `${name} must occur in the official inventory`);
      const sha256 = createHash("sha256").update(readFileSync(filename)).digest("hex");
      assert.equal(sha256, entry.sha256, `${name} differs from the official inventory`);
      verified.push({ path, sha256 });
      return import(pathToFileURL(filename).href);
    };
    const [cordis, manager, web] = await Promise.all([
      load("@deepseek-ai/cordis"),
      load("@deepseek-ai/dsh-plugin-manager"),
      load("@deepseek-ai/dsh-host-webserver"),
    ]);
    return { ...cordis, ...manager, ...web };
  })();
  return official;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export async function fixture(
  t,
  { hmr = true, packageExitCode = 0, retainDependency = false } = {},
) {
  const api = await loadOfficial();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dsh-unlimit-maintenance-")));
  const profileRoot = join(directory, "synthetic-profile");
  const installationRoot = join(directory, "synthetic-installation");
  const dataRoot = join(profileRoot, "data", "dsh-unlimit");
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(installationRoot);
  const installAnchor = join(installationRoot, "package.json");
  writeJson(installAnchor, { name: "synthetic-installation", version: "0.0.0", dependencies: {} });
  const manifestPath = join(profileRoot, "package.json");
  writeJson(manifestPath, {
    name: "dsh-profile-desktop",
    version: "0.0.0",
    dependencies: {
      "dsh-unlimit": "file:./synthetic-own",
      "synthetic-unrelated": "file:./synthetic-other",
    },
    dsh: { profile: { bundles: ["dsh-unlimit", "synthetic-unrelated"] } },
    syntheticUnrelatedField: "retained",
  });
  for (const name of ["dsh-unlimit", "synthetic-unrelated"]) {
    const path = join(profileRoot, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeJson(join(path, "package.json"), {
      name,
      version: "0.0.0",
      main: "index.js",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    });
    // Resolution needs a package entry, but no synthetic bundle code is imported.
    writeFileSync(
      join(path, "index.js"),
      "throw new Error('Fixture bundle code must never execute');\n",
    );
    writeFileSync(
      join(path, "cordis.patch.yml"),
      `- insert:\n    - id: ${name}\n      name: ${name}\n`,
    );
  }
  const sentinels = [
    join(profileRoot, "skills", "user-owned", "SKILL.md"),
    join(dataRoot, "skills", "imported", "SKILL.md"),
    join(dataRoot, "materials", "original.txt"),
    join(profileRoot, "unrelated.txt"),
  ];
  for (const [index, path] of sentinels.entries()) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `SYNTHETIC-PRESERVE-${index}\n`);
  }
  const originalSentinels = sentinels.map((path) => [path, readFileSync(path)]);
  const store = new WorkspaceStore(join(dataRoot, "workspace.sqlite"));
  store.setMeta("synthetic-persistent-record", { value: "SYNTHETIC-RETAINED" });
  const admission = new DrillAdmission(store, dataRoot, { clock: () => 0 });
  const { challengeId } = admission.begin({});
  admission.dispatch("admission.read", { challengeId });
  admission.clock = () => 5000;
  admission.confirm({ challengeId, checks: { scope: true, permissions: true, evidence: true } });
  let closed = false;
  let closedStoreReads = 0;
  const originalMeta = store.meta.bind(store);
  store.meta = (...args) => {
    if (closed) {
      closedStoreReads++;
      throw new Error("The disposed plugin must not read its closed store");
    }
    return originalMeta(...args);
  };
  const closeStore = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  const ctx = new api.Context();
  const ownEntry = {
    id: "include:dsh-unlimit",
    options: { id: "dsh-unlimit", name: "dsh-unlimit" },
    parent: { tree: { ctx: { baseUrl: pathToFileURL(manifestPath).href } } },
  };
  const otherEntry = {
    id: "include:synthetic-unrelated",
    options: { id: "synthetic-unrelated", name: "synthetic-unrelated" },
    parent: ownEntry.parent,
    fiber: { uid: "synthetic-unrelated-fiber", state: 2 },
  };
  let entries = [ownEntry, otherEntry];
  let plugin;
  let maintenance;
  let manager;
  let prepareCalls = 0;
  let processAttempts = 0;
  const packageCalls = [];
  const events = [];
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    t.mock.method(childProcess, name, () => {
      processAttempts++;
      throw new Error("Subprocesses are forbidden in the isolated maintenance fixture");
    });
  syncBuiltinESMExports();
  const backend = {
    runExclusive: (operation) => operation(),
    async reconcileProfile() {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!manifest.dsh.profile.bundles.includes("dsh-unlimit")) {
        if (plugin?.uid !== null) await plugin.dispose();
        entries = entries.filter((entry) => entry !== ownEntry);
      }
      return { warnings: [], pending: [] };
    },
  };
  const owner = ctx.plugin({
    name: "synthetic-maintenance-manager",
    apply(scope) {
      scope.provide("loader", { entries: () => entries });
      scope.provide("profileContext", {
        dir: profileRoot,
        installAnchor,
        startedBundles: ["dsh-unlimit", "synthetic-unrelated"],
      });
      if (hmr) scope.provide("hmr", backend);
      manager = new api.PluginManager(scope, {
        fallbackRegistries: [],
        outputBytes: 1024,
        lockWaitMs: 0,
        inspectTimeoutMs: 1000,
        githubConnectionTimeoutMs: 1000,
        idleTimeoutMs: 1000,
        pnpmCommand: "must-not-execute",
      });
      // Only the subprocess boundary is replaced. The official manager still
      // reads and changes the isolated manifest, checks live rows and forms results.
      manager.runPnpm = async (args) => {
        packageCalls.push(args);
        assert.deepEqual(args, ["remove", "dsh-unlimit"]);
        if (packageExitCode === 0 && !retainDependency) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          delete manifest.dependencies["dsh-unlimit"];
          writeJson(manifestPath, manifest);
        }
        return {
          exitCode: packageExitCode,
          output: "SYNTHETIC-PACKAGE-RESULT",
          truncated: false,
          logPath: "synthetic-only.log",
        };
      };
      scope.on("plugin-manager/changed", (event) => events.push(event));
    },
  });
  const web = ctx.plugin(api.WebServer, { host: "127.0.0.1", port: 0, compression: "none" });
  t.after(async () => {
    try {
      if (plugin?.uid !== null) await plugin?.dispose();
      await web.dispose();
      await owner.dispose();
      await ctx.fiber.dispose();
    } finally {
      closeStore();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await owner.await();
  await web.await();
  const host = {
    kind: "desktop",
    supported: true,
    version: "0.2.1-rc.2",
    runtimeRoot,
    profileRoot,
    dataRoot,
  };
  const prepare = async () => {
    prepareCalls++;
    admission.revoke({ revision: admission.status().revision });
    return { admissionAccepted: admission.status().accepted, syntheticOwnedTasksStopped: true };
  };
  plugin = ctx.plugin({
    name: "synthetic-dsh-unlimit-maintenance",
    inject: ["webServer"],
    apply(scope) {
      scope.fiber.entry = ownEntry;
      ownEntry.fiber = scope.fiber;
      maintenance = new DesktopMaintenance(scope, host);
      scope.effect(() => closeStore);
      scope.effect(() =>
        scope.webServer.register({
          kind: "prefix",
          path: "/dsh-unlimit",
          handler: createHandler(
            {
              dispatch(action, payload) {
                assert.equal(action, "maintenance.uninstall");
                return maintenance.uninstall(payload, prepare);
              },
            },
            () => scope.webServer.getOrigin(),
          ),
        }),
      );
    },
  });
  await plugin.await();
  const post = () =>
    new Promise((resolve, reject) => {
      const url = new URL("/dsh-unlimit/api", ctx.webServer.getOrigin());
      const req = request(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-dsh-unlimit": "1", origin: url.origin },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null });
          });
        },
      );
      req.on("error", reject);
      req.end(
        JSON.stringify({
          action: "maintenance.uninstall",
          payload: { bundle: "dsh-unlimit", confirmed: true },
        }),
      );
    });
  return {
    api,
    ctx,
    manager,
    maintenance,
    plugin,
    post,
    prepare,
    ownEntry,
    otherEntry,
    packageCalls,
    events,
    host,
    installAnchor,
    manifestPath,
    dataRoot,
    originalSentinels,
    get closed() {
      return closed;
    },
    get closedStoreReads() {
      return closedStoreReads;
    },
    get prepareCalls() {
      return prepareCalls;
    },
    get processAttempts() {
      return processAttempts;
    },
    evidence: verified,
  };
}
