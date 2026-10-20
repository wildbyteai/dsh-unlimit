import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const entry = fileURLToPath(new URL("../src/client-entry.js", import.meta.url));
const output = fileURLToPath(new URL("../dist/client.js", import.meta.url));
function check(path) {
  const result = spawnSync(process.execPath, ["--check", path], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("客户端语法检查未通过，停止构建");
}
check(entry);
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
copyFileSync(entry, output);
check(output);
console.log("客户端构建完成：dist/client.js（独立 ES module，无第三方打包依赖）。");
