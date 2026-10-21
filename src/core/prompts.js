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
  const active = library.items.find((item) => item.id === library.activeId);
  if (active?.model && active.model === model) return active;
  return (
    library.items.find((item) => item.model && item.model === model) ??
    (active?.model ? undefined : active)
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

export function selectPromptText(settings, { rule, workspaceText = "" } = {}) {
  const selectedWorkspace = settings.workspacePolicy === "strict" ? "" : workspaceText.trim();
  const candidates = [
    ["rule", rule?.content?.trim()],
    ["saved", settings.prompt.trim()],
    ["workspace", selectedWorkspace],
    ["default", DEFAULT_PROMPT],
  ];
  const [source, chosen] = candidates.find(([, text]) => text);
  const useWorkspace = usesWorkspaceInstructions(settings, rule);
  const parts = [chosen];
  if (useWorkspace && selectedWorkspace && selectedWorkspace !== chosen)
    parts.push(selectedWorkspace);
  return {
    source,
    text: parts.join("\n\n"),
    workspaceIncluded: Boolean(useWorkspace && selectedWorkspace),
  };
}

export function composePrompt(
  assembly,
  settings,
  { rule, workspaceText = "", completeSectionNames = new Set() } = {},
) {
  if (!settings.enabled) return assembly;
  const operator = {
    name: "dsh-unlimit/operator",
    order: 0,
    interpolate: false,
    text: selectPromptText(settings, { rule, workspaceText }).text,
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
