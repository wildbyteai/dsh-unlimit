import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));

test("真实离线 npm pack 只交付运行文件、用户文档和声明，且文档相对链接完整", (t) => {
  const cache = mkdtempSync(join(tmpdir(), "dsh-unlimit-pack-test-"));
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  const build = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
  });
  assert.ifError(build.error);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const packed = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json"],
    {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" },
      encoding: "utf8",
      timeout: 30000,
    },
  );
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packages = JSON.parse(packed.stdout);
  assert.equal(packages.length, 1);
  const paths = new Set(packages[0].files.map((item) => item.path));
  const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const path of [
    "package.json",
    "README.md",
    "NOTICE.md",
    "cordis.patch.yml",
    ...Object.values(metadata.exports),
    ...Object.values(metadata.bin),
    metadata.main,
  ]) {
    assert.ok(paths.has(path.replace(/^\.\//, "")), `必要入口未入包：${path}`);
  }
  function checkRuntimeFiles(directory) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) checkRuntimeFiles(path);
      else if (entry.isFile()) assert.ok(paths.has(path), `运行资源未入包：${path}`);
    }
  }
  for (const directory of ["src", "web", "dist"]) checkRuntimeFiles(directory);
  assert.deepEqual([...paths].filter((path) => path.startsWith("docs/")).sort(), [
    "docs/ui-preview.jpg",
    "docs/user-guide.md",
  ]);
  const allowed =
    /^(?:src\/|web\/|dist\/|docs\/(?:user-guide\.md|ui-preview\.jpg)$|package\.json$|cordis\.patch\.yml$|README\.md$|NOTICE\.md$|LICENSE(?:\.md)?$)/;
  for (const path of paths) {
    assert.match(path, allowed, `非交付文件入包：${path}`);
    assert.doesNotMatch(
      path,
      /(?:^|\/)(?:node_modules|profile|profiles|data|\.git|\.env)(?:\/|$)|\.(?:sqlite(?:3)?|db|tgz|log)(?:$|[-.])/i,
      `本地资料入包：${path}`,
    );
    if (!path.endsWith(".md")) continue;
    const text = readFileSync(join(root, path), "utf8");
    for (const match of text.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
      const target = match[1] || match[2];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
      const link = decodeURIComponent(target.split(/[?#]/, 1)[0]);
      if (!link) continue;
      const destination = posix.normalize(posix.join(posix.dirname(path), link));
      assert.ok(paths.has(destination), `交付文档断链：${path} → ${target}`);
    }
  }
});
