import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_PROMPT = `你是使用者自行配置的桌面工作助理。
围绕使用者明确提出的目标开展工作，直接使用当前可用工具完成任务。
准确报告观察到的结果；没有执行的步骤、失败和未知状态必须明确说明。
使用使用者选择的语言。复杂任务保留必要的步骤、证据与交付物。
工具参数、工作目录和执行能力以当前运行环境实际提供的接口为准。`;

const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MAX_INSTRUCTION_BYTES = 256 * 1024;

export function workspaceInstructions(directory) {
  let current = realpathSync(directory);
  if (!statSync(current).isDirectory()) throw new Error("工作区必须是目录");
  const files = [];
  for (;;) {
    for (const name of INSTRUCTION_NAMES) {
      const path = join(current, name);
      try {
        const stat = statSync(path);
        if (stat.isFile() && stat.size <= MAX_INSTRUCTION_BYTES) {
          files.push({ path: realpathSync(path), name, bytes: stat.size });
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files.reverse();
}

export function selectedInstructions(directory, selected) {
  if (!directory || selected.length === 0) return "";
  const available = new Map(workspaceInstructions(directory).map((file) => [file.path, file]));
  const text = selected
    .map((path) => {
      const canonical = realpathSync(resolve(path));
      if (!available.has(canonical)) throw new Error("选中的规则不属于此工作区的祖先规则链");
      return readFileSync(canonical, "utf8").trim();
    })
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error("工作区规则组合超过 512 KiB");
  return text;
}

export function composePrompt(assembly, settings, { rule, workspaceText = "" } = {}) {
  if (!settings.enabled) return assembly;
  const selectedWorkspace = settings.workspacePolicy === "strict" ? "" : workspaceText.trim();
  const chosen = (
    rule?.content?.trim() ||
    settings.prompt.trim() ||
    selectedWorkspace ||
    DEFAULT_PROMPT
  ).trim();
  const useWorkspace =
    settings.workspacePolicy === "always" ||
    (settings.workspacePolicy === "fallback" && !rule?.content && !settings.prompt);
  const parts = [chosen];
  if (useWorkspace && selectedWorkspace && selectedWorkspace !== chosen)
    parts.push(selectedWorkspace);
  const operator = {
    name: "dsh-unlimit/operator",
    order: 0,
    interpolate: false,
    text: parts.join("\n\n"),
  };
  const retained =
    settings.promptMode === "append"
      ? (assembly.sections ?? [])
      : (assembly.sections ?? []).filter((section) => section.name.startsWith("tool:"));
  return {
    ...assembly,
    sections: settings.promptMode === "append" ? [...retained, operator] : [operator, ...retained],
  };
}
