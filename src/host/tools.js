import { resolveOfficialPackage } from "./official-package.js";

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
  "assets.path",
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
  "templates.list",
  "templates.read",
  "catalog.list",
  "catalog.read",
  "catalog.preflight",
  "roles.list",
  "roles.save",
  "roles.reset",
  "report.build",
  "flow.status",
  "flow.configure",
  "flow.assign",
  "flow.acquire",
  "flow.release",
  "workflow.dispatch",
  "workflow.status",
  "workflow.stop",
  "workflow.plan.create",
  "workflow.plan.propose",
  "workflow.plan.run",
  "workflow.plan.status",
  "workflow.plan.stop",
  "files.list",
  "files.read",
  "files.write",
  "files.delete",
  "files.import",
  "files.preview",
  "files.restore",
  "files.backups",
];
const WORKSPACE_ACTION = /^(assets|findings|records|roles|report|flow|files|workflow)\./;

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
  const resolved = await resolveOfficialPackage(host.runtimeRoot, "@deepseek-ai/dsh-tools");
  if (!resolved.url) throw new Error(`官方工具接口不可用：${resolved.reason}`);
  const { defineTool } = await import(resolved.url);
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
            "读写本会话绑定的本地演练工作区，需由使用者在工作台完成演练入口确认。先 workspaces.list，再按用户选择 workspaces.bind。台账登记不执行扫描或登录；workflow.dispatch、workflow.plan.create、workflow.plan.propose 和 workflow.plan.run 会真正创建执行者，只分派用户明确授权的任务。catalog 可先检查当前会话可见能力。失败不代表操作成功。",
          parameters: {
            action: { type: "string", required: true, enum: DATA_ACTIONS },
            payload: {
              type: "json",
              required: true,
              description:
                "action 对应的数据对象；记录保存使用 kind 与 data，工作区作用域自动取本会话绑定。workflow.dispatch 使用 role、task；workflow.status/stop 使用运行 id。workflow.plan.create 使用 tasks:[{id,role,task,requirements:[],dependsOn?:[],skills?:[{origin,id}]}]，可选 summarize:true 会额外启动一次 planner 汇总全部已结束任务，默认关闭；汇总是待核实草稿，不自动登记为事实。workflow.plan.propose 使用 goal，启动规划者生成基于当前目录的任务草稿；plan.status 返回 proposal，只有 ready 草稿可检查后另用 plan.create 提交，生成不自动执行草稿中的任务。workflow.plan.run 使用 goal 和可选 summarize:true，显式请求规划后自动执行生成任务；只有用户已授权目标范围内的自动执行时才选此入口，仍保留逐任务准入与宿主审批。规划者仍继承宿主工具与权限。plan.status/stop 使用计划 id，父会话均强制为调用者。skills 选择的完整正文和文件内依赖声明在执行前一起读取检查，未知依赖或超限阻断；不允许在任务中覆盖技能依赖。依赖结果保持未验证，超限明确阻断。templates.read 使用相对 path。",
            },
          },
          output,
          async execute({ action, payload }, execution) {
            if (!DATA_ACTIONS.includes(action)) throw new Error("此 action 不开放给模型工具");
            if (!payload || typeof payload !== "object" || Array.isArray(payload))
              throw new Error("payload 必须是对象");
            const agent = execution.agent;
            if (!agent?.session) throw new Error("调用缺少会话上下文");
            const data = { ...payload };
            if (action.startsWith("catalog.")) {
              if (data.sessionId && data.sessionId !== agent.session.id)
                throw new Error("只能检查当前会话可见的技能与工具目录");
              data.sessionId = agent.session.id;
            }
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
            if (action === "workflow.dispatch") {
              if (data.parentSessionId && data.parentSessionId !== agent.session.id)
                throw new Error("只能从当前会话分派执行者");
              data.parentSessionId = agent.session.id;
            }
            if (action.startsWith("workflow.plan.")) {
              if (data.parentSessionId && data.parentSessionId !== agent.session.id)
                throw new Error("只能操作当前父会话提交的计划");
              data.parentSessionId = agent.session.id;
            }
            if (["workflow.stop", "workflow.status"].includes(action)) {
              const result = await controller.dispatch("workflow.status", data);
              if (data.id) {
                if (result.item.parentSessionId !== agent.session.id)
                  throw new Error("只能查看或停止当前会话分派的执行者");
                if (action === "workflow.status") return result;
              } else if (action === "workflow.status") {
                return {
                  items: result.items.filter((item) => item.parentSessionId === agent.session.id),
                };
              } else {
                throw new Error("停止执行者必须指定运行编号");
              }
            }
            return controller.dispatch(action, data);
          },
        }),
      ),
    );
    disposers.push(
      ctx.tools.register(
        defineTool({
          name: "unlimit_process",
          description:
            "在本会话绑定的项目中启动已配置本地工具，读取输出或停止自己启动的进程。只执行用户授权的操作，沿用宿主沙箱与审批；不使用 shell。开始后后台运行，可在工具与环境页查看和停止。",
          parameters: {
            action: { type: "string", required: true, enum: ["start", "list", "output", "stop"] },
            payload: {
              type: "json",
              required: true,
              description:
                "start: {tool:已配置工具标识,args:字符串数组,cwd?:绝对目录,timeoutMs?:50到86400000,sandbox_permissions?:权限模式,justification?:审批理由}；list: {}；output: {id,stdoutOffset?,stderrOffset?}；stop: {id}。项目与会话取真实调用上下文。输出可能截断，停止未确认时返回 cleanup-pending。",
            },
          },
          output,
          execute({ action, payload }, execution) {
            if (!["start", "list", "output", "stop"].includes(action))
              throw new Error("未知本地进程操作");
            if (!payload || typeof payload !== "object" || Array.isArray(payload))
              throw new Error("payload 必须是对象");
            if (!execution?.agent?.session) throw new Error("调用缺少会话上下文");
            return controller.dispatch(`processes.${action}`, payload, {
              agent: execution.agent,
              signal: execution.signal,
              callId: execution.callId,
              toolName: "unlimit_process",
            });
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
