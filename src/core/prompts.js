import { readWorkspaceRule } from "./workspace-rules.js";
export { workspaceInstructions } from "./workspace-rules.js";

export const DEFAULT_PROMPT = `你是使用者自行配置的桌面工作助理。
围绕使用者明确提出的目标开展工作，直接使用当前可用工具完成任务。
准确报告观察到的结果；没有执行的步骤、失败和未知状态必须明确说明。
使用使用者选择的语言。复杂任务保留必要的步骤、证据与交付物。
工具参数、工作目录和执行能力以当前运行环境实际提供的接口为准。`;

const PERSONA_SECTIONS = new Set([
  "harness:identity",
  "deployment:persona-prefix",
  "deployment:persona-suffix",
]);

export function selectedRule(library, model) {
  return (
    library.items.find((item) => item.model && item.model === model) ??
    library.items.find((item) => item.id === library.activeId)
  );
}

export function usesWorkspaceInstructions(settings, rule) {
  return (
    settings.workspacePolicy === "always" ||
    (settings.workspacePolicy === "fallback" && !rule?.content?.trim() && !settings.prompt.trim())
  );
}

export function selectedInstructions(directory, selected) {
  if (!directory || selected.length === 0) return "";
  const text = selected
    .map((path) => readWorkspaceRule({ directory, path }).content.trim())
    .filter(Boolean)
    .join("\n\n");
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error("工作区规则组合超过 512 KiB");
  return text;
}

export function composePrompt(
  assembly,
  settings,
  { rule, workspaceText = "", completeSectionNames = new Set() } = {},
) {
  if (!settings.enabled) return assembly;
  const selectedWorkspace = settings.workspacePolicy === "strict" ? "" : workspaceText.trim();
  const chosen = (
    rule?.content?.trim() ||
    settings.prompt.trim() ||
    selectedWorkspace ||
    DEFAULT_PROMPT
  ).trim();
  const useWorkspace = usesWorkspaceInstructions(settings, rule);
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
      : (assembly.sections ?? []).filter(
          (section) =>
            !PERSONA_SECTIONS.has(section.name) &&
            !completeSectionNames.has(section.name) &&
            section.complete !== true,
        );
  return {
    ...assembly,
    sections: settings.promptMode === "append" ? [...retained, operator] : [operator, ...retained],
  };
}
