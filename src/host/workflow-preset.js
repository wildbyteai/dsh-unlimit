// Original preset contribution. The official registry owns its scoped lifetime.
export const name = "dsh-unlimit-workflow-evidence-guidance";
export const inject = ["systemPrompt"];
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: "dsh-unlimit/workflow-evidence",
    order: 400,
    interpolate: false,
    text: "处理明确交给你的这一项任务，保留宿主权限和用户授权边界。在已授权范围内选用公开的技能和工具；遇到限制应准确说明。记录事实及其证据出处，区分观察、推断和未验证内容。返回完成内容、验证结果与仍缺少的材料，不把任务分派描述成完整攻击链已经执行。",
  });
}
