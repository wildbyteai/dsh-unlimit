// 有限的来源记录与命名检查，不判断代码、提示词或素材的作者和权利归属。
// 实际交付文件清单由 scripts/pack.mjs 检查；本脚本不执行宿主或访问网络。
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const RECORDS = ["NOTICE.md", "docs/provenance.md", "docs/parity.md"];
const SOURCE_DIRS = ["src", "web", "dist"];
// 这里只识别仓库不接纳的备份/素材工程文件名；扩展名不能证明文件来自外部。
const REVIEW_SUFFIX = /\.(?:png\.orig|jpe?g\.orig|gif\.orig|webp\.orig|psd|ai|sketch)$/i;

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
    return entry.isDirectory() ? collect(path) : entry.isFile() ? [path] : [];
  });
}

export function inspectProvenance(projectRoot) {
  const problems = [];
  for (const record of RECORDS) {
    try {
      if (!readFileSync(join(projectRoot, record), "utf8").trim()) {
        problems.push(`${record} 来源记录为空`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      problems.push(`${record} 来源记录缺失`);
    }
  }
  try {
    const metadata = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
    if (metadata.name !== "dsh-unlimit") problems.push("package.json 包名应为 dsh-unlimit");
    if (
      !metadata.bin ||
      Object.keys(metadata.bin).length !== 1 ||
      metadata.bin["dsh-unlimit"] !== "./src/cli.js"
    ) {
      problems.push("package.json 命令入口应为 dsh-unlimit → ./src/cli.js");
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    problems.push("package.json 缺失或不是有效 JSON");
  }
  const files = SOURCE_DIRS.flatMap((directory) => collect(join(projectRoot, directory)));
  for (const file of files) {
    if (REVIEW_SUFFIX.test(file)) {
      problems.push(
        `${relative(projectRoot, file)} 是需移出源码目录的备份/素材工程文件（不判断来源）`,
      );
    }
  }
  return { problems, checkedRecords: RECORDS.length, checkedFiles: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = inspectProvenance(root);
  if (result.problems.length) {
    console.error("来源记录与命名检查失败：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `来源记录与命名检查：${result.checkedRecords} 份记录非空，包名/命令入口符合约定，` +
        `${result.checkedFiles} 个源码/构建文件未命中受限文件后缀。`,
    );
    console.log("未验证正文或素材来源、开发历史及权利归属；交付清单另由 npm run pack:local 检查。");
  }
}
