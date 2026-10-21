// 有限的静态分层检查。只检查下述字面量模块引用，不执行项目或宿主代码。
// 不据此推断算法来源、运行时摘要校验的完整性或交付包内容。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function collect(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collect(path);
    return entry.isFile() && /\.m?js$/.test(entry.name) ? [path] : [];
  });
}

// 覆盖静态 import/export-from、side-effect import、字面量 import()/require()。
// 这是声明形式检查，不解析任意 JavaScript 表达式或运行时拼接的模块名。
export function literalReferences(text) {
  const references = [];
  const patterns = [
    { kind: "static", re: /(?:^|\n)\s*(?:import|export)\s+[^"'`;]*?\s+from\s*["']([^"']+)["']/g },
    { kind: "static", re: /(?:^|\n)\s*import\s*["']([^"']+)["']/g },
    { kind: "dynamic", re: /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g },
  ];
  for (const { kind, re } of patterns) {
    for (const match of text.matchAll(re)) references.push({ kind, specifier: match[1] });
  }
  return references;
}

export function inspectSelfAudit(projectRoot) {
  const problems = [];
  const coreRoot = resolve(projectRoot, "src/core");
  const files = collect(join(projectRoot, "src"));
  for (const file of files) {
    const name = relative(projectRoot, file);
    const inCore = file.startsWith(`${coreRoot}${sep}`);
    const text = readFileSync(file, "utf8");
    for (const { kind, specifier } of literalReferences(text)) {
      if (inCore) {
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          const target = resolve(dirname(file), specifier);
          const inside = relative(coreRoot, target);
          if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
            problems.push(`${name} 从 core 跨层引用 ${specifier}`);
          }
        } else if (!specifier.startsWith("node:")) {
          problems.push(`${name} 从 core 引用非 Node 内建模块 ${specifier}`);
        }
      }
      if (kind === "static" && specifier.startsWith("@deepseek-ai/")) {
        problems.push(`${name} 静态导入官方包 ${specifier}；应使用宿主运行时解析或服务注入`);
      }
    }
  }
  for (const entry of ["src/cli.js", "src/host/plugin.js", "src/host/desktop.js"]) {
    try {
      if (!statSync(join(projectRoot, entry)).isFile()) problems.push(`${entry} 不是普通文件`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      problems.push(`${entry} 入口文件缺失`);
    }
  }
  const desktop = join(projectRoot, "src/host/desktop.js");
  if (
    files.includes(desktop) &&
    !/export\s+const\s+SUPPORTED_HOST\s*=/.test(readFileSync(desktop, "utf8"))
  ) {
    problems.push("src/host/desktop.js 缺少 SUPPORTED_HOST 声明");
  }
  return { problems, checkedModules: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = inspectSelfAudit(root);
  if (result.problems.length) {
    console.error("静态分层检查失败：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `静态分层检查：${result.checkedModules} 个模块的已识别字面量引用、入口文件与版本常量声明通过。`,
    );
    console.log(
      "未验证动态拼接引用、运行时完整性、来源或交付清单；摘要校验须由适配器行为测试验证。",
    );
  }
}
