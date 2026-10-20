import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, "en"),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(path);
  }
}
for (const directory of ["src", "web", "scripts", "tests"]) collect(join(root, directory));
let failures = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    failures++;
    console.error(`语法检查失败：${relative(root, file)}`);
    console.error(result.error?.message || result.stderr || `退出码 ${result.status}`);
  }
}
console.log(
  `JavaScript 语法检查：${files.length - failures}/${files.length} 通过。未执行宿主代码或读取用户 profile。`,
);
if (failures) process.exitCode = 1;
