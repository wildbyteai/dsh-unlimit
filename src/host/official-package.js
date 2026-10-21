import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { SUPPORTED_HOST } from "./desktop.js";

/**
 * 官方包的解析与校验。
 *
 * 按当前运行时的发行清单比对入口 SHA-256，再返回可加载的位置。
 * 每次解析都重新读取清单和入口；不把之前的成功或失败作为本次校验结果。
 * 这里只校验入口，不证明其传递依赖完整，也不替代对发行清单来源的信任。
 *
 * 不做版本猜测，不降级到 require.resolve 的裸结果。清单不一致即视为未适配，
 * 调用方据此显示不支持，而不是加载一个来源不明的模块。
 */

function digest(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function inventory(runtimeRoot) {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "desktop-runtime.json"), "utf8"));
  if (manifest.release?.version !== SUPPORTED_HOST) {
    return { reason: "运行时发行版本与适配版本不一致" };
  }
  const files = Array.isArray(manifest.files) ? manifest.files : null;
  if (!files) return { reason: "发行清单缺少文件条目" };
  return { files };
}

/**
 * 校验并解析一个官方包。
 *
 * 返回 { url } 表示可加载；返回 { reason } 表示不适配，reason 为用户可读原因。
 * 调用方必须区分这两种结果——不得把失败当作可跳过。
 */
export function resolveOfficialPackage(runtimeRoot, name) {
  if (!isAbsolute(runtimeRoot ?? "")) {
    return { reason: "未提供可信运行时根" };
  }
  if (typeof name !== "string" || !/^@deepseek-ai\/[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { reason: "只支持官方包入口解析" };
  }

  try {
    const root = realpathSync(runtimeRoot);
    const manifest = inventory(root);
    if (manifest.reason) return manifest;
    const path = realpathSync(createRequire(join(root, "package.json")).resolve(name));
    const localPath = relative(root, path);
    if (isAbsolute(localPath) || localPath === ".." || localPath.startsWith(`..${sep}`)) {
      return { reason: `${name} 的入口位于指定运行时之外` };
    }
    const entry = manifest.files.find((item) => item.path === localPath.split(sep).join("/"));
    if (!entry || digest(readFileSync(path)) !== entry.sha256) {
      return { reason: `${name} 与发行清单摘要不一致` };
    }
    return { url: pathToFileURL(path).href, path };
  } catch (error) {
    return { reason: `${name} 不可用：${error.message}` };
  }
}
