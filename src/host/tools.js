import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DATA_ACTIONS = [
  "workspaces.list",
  "workspaces.save",
  "workspaces.bind",
  "workspaces.forSession",
  "assets.list",
  "assets.save",
  "assets.import",
  "assets.link",
  "assets.assess",
  "assets.test",
  "assets.graph",
  "assets.timeline",
  "findings.list",
  "findings.save",
  "records.list",
  "records.save",
  "records.delete",
  "knowledge.list",
  "knowledge.save",
  "knowledge.delete",
  "knowledge.use",
  "roles.list",
  "roles.save",
  "roles.reset",
  "report.build",
  "flow.status",
  "flow.configure",
  "flow.assign",
  "flow.acquire",
  "flow.release",
];
const WORKSPACE_ACTION = /^(assets|findings|records|roles|report|flow)\./;

export function boundWorkspace(store, agent, agents) {
  let current = agent;
  const visited = new Set();
  while (current && !visited.has(current.session.id)) {
    visited.add(current.session.id);
    const binding = store.dispatch("workspaces.forSession", { sessionId: current.session.id }).item;
    if (binding) return binding;
    const parent = current.session.header.parentSession;
    current = parent ? agents?.get(parent) : undefined;
  }
  return null;
}

export async function installTools(ctx, controller, host) {
  const require = createRequire(join(host.runtimeRoot, "package.json"));
  const { defineTool } = await import(
    pathToFileURL(require.resolve("@deepseek-ai/dsh-tools")).href
  );
  const disposers = [];
  const output = {
    schema: { type: "json" },
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
  try {
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "unlimit_workspace",
          description:
            "读写本会话绑定的本地演练工作区。先 workspaces.list，再按用户选择 workspaces.bind。payload 为对象。登记事实不会执行扫描、远程登录或命令。失败会抛出错误，不代表操作成功。",
          parameters: {
            action: { type: "string", required: true, enum: DATA_ACTIONS },
            payload: {
              type: "json",
              required: true,
              description:
                "action 对应的数据对象；记录保存使用 kind 与 data，工作区作用域自动取本会话绑定。",
            },
          },
          output,
          async execute({ action, payload }, execution) {
            if (!payload || typeof payload !== "object" || Array.isArray(payload))
              throw new Error("payload 必须是对象");
            const agent = execution.agent;
            if (!agent?.session) throw new Error("调用缺少会话上下文");
            const data = { ...payload };
            if (["flow.acquire", "flow.release"].includes(action)) {
              if (data.sessionId && data.sessionId !== agent.session.id)
                throw new Error("只能领取或释放当前会话的执行槽");
              data.sessionId = agent.session.id;
            }
            if (["workspaces.bind", "workspaces.forSession"].includes(action)) {
              if (data.sessionId && data.sessionId !== agent.session.id)
                throw new Error("不能替其他会话更改绑定");
              data.sessionId = agent.session.id;
            }
            if (WORKSPACE_ACTION.test(action)) {
              const workspace = boundWorkspace(controller.store, agent, ctx.get("agents"));
              if (!workspace) throw new Error("本会话尚未绑定演练工作区");
              if (data.workspaceId && data.workspaceId !== workspace.id)
                throw new Error("请求工作区与本会话绑定不一致");
              data.workspaceId = workspace.id;
            }
            return controller.dispatch(action, data);
          },
        }),
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "unlimit_status",
          description: "读取本地桌面适配状态、有效配置与未支持能力；不更改权限。",
          parameters: {},
          output,
          execute: () => controller.dispatch("status"),
        }),
      ),
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose();
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
