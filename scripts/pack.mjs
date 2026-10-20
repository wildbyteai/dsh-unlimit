import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const build = spawnSync(process.execPath, [join(root, "scripts/build.mjs")], {
  cwd: root,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) throw new Error("构建失败，未生成安装包");
const cache = mkdtempSync(join(tmpdir(), "dsh-unlimit-pack-cache-"));
try {
  mkdirSync(join(root, "artifacts"), { recursive: true });
  const env = { ...process.env, npm_config_cache: cache, npm_config_update_notifier: "false" };
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  function pack(args) {
    const result = spawnSync(npm, ["pack", "--ignore-scripts", "--offline", "--json", ...args], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(result.stderr.trim() || `npm pack 失败，退出码 ${result.status}`);
    const items = JSON.parse(result.stdout);
    if (items.length !== 1) throw new Error("npm pack 未返回唯一安装包");
    return items[0];
  }
  const planned = pack(["--dry-run"]);
  const allowed =
    /^(?:src\/|web\/|dist\/|docs\/|package\.json$|cordis\.patch\.yml$|README\.md$|NOTICE\.md$|LICENSE(?:\.md)?$)/;
  for (const item of planned.files) {
    if (
      !allowed.test(item.path) ||
      /(?:^|\/)(?:node_modules|profile|profiles|data|\.git|\.env)(?:\/|$)|\.(?:sqlite(?:3)?|db|tgz|log)(?:$|[-.])/i.test(
        item.path,
      )
    ) {
      throw new Error(`安装包包含非发布内容：${item.path}`);
    }
  }
  const packed = pack(["--pack-destination", "artifacts"]);
  const path = join(root, "artifacts", packed.filename);
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  console.log(`本地安装包：${relative(root, path)}`);
  console.log(`SHA-256：${hash}`);
  console.log(`发布文件：${packed.files.length} 项；未包含本地数据库、用户 profile 或工具目录。`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
