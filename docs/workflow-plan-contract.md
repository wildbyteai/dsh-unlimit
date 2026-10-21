# 多任务规划与执行合同

`DesktopWorkflowPlan` 接收人或指挥模型已拆好的任务，协调现有 `DesktopWorkflow` 的收据。新增 `workflow.plan.propose` 可从目标和父会话目录生成带角色、依赖及候选能力的任务草稿；只有另行提交 `workflow.plan.create` 才执行草稿中的任务。可选 `summarize:true` 在任务结束后额外启动一次 planner，生成带来源的待核实汇总；默认关闭。协调器本身不运行 shell 或下载依赖。计划、队列和结果均只保存在当前运行期；没有跨重启恢复或 profile 写入。

## 接入

```js
import { DesktopWorkflowPlan } from "../src/host/workflow-plan.js";

const plans = new DesktopWorkflowPlan(workflow, { catalog });
const { item } = await plans.dispatch("workflow.plan.create", {
  workspaceId,
  parentSessionId,
  summarize: true, // 可选：增加一次 planner 调用，结果仍待独立核实
  tasks: [
    {
      id: "inventory-a",
      role: "analyst",
      task: "根据已给出的合成文件清单 A，返回其中的文件名及证据出处。",
      requirements: [],
    },
    {
      id: "inventory-b",
      role: "analyst",
      task: "根据已给出的合成文件清单 B，返回其中的文件名及证据出处。",
      requirements: [],
      dependsOn: ["inventory-a"],
    },
  ],
});
const status = await plans.dispatch("workflow.plan.status", {
  workspaceId,
  parentSessionId,
  id: item.id,
});
await plans.dispatch("workflow.plan.stop", {
  workspaceId,
  parentSessionId,
  id: item.id,
});
```

`workflow` 必须是当前实例的 `DesktopWorkflow`；其 `store`、`flow`、`workspace()`、`service()`、`capabilities()` 和 `dispatch()` 是本模块使用的项目内合同。可选 `catalog` 使用当前 `HostCatalog.preflight(payload, { signal })`，不替代宿主权限或执行授权。调用层必须把模型工具的父会话绑定为真实调用会话，不能信任模型提供的其他会话 ID。

| 动作                         | 输入                                                     | 输出与约束                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow.plan.capabilities` | `{}`                                                     | `{available,preflight,runtimeOnly:true,automaticTaskMatching:false,planDrafting,evidenceSummary:true,reasons}`；实际工作流分派、停止接口缺失时 unavailable。 |
| `workflow.plan.create`       | `{workspaceId,parentSessionId,tasks,summarize?:boolean}` | `{item}`，初态 `queued`。校验项目、活动父会话、绑定、任务和角色；创建记录不代表已经启动执行者。                                                              |
| `workflow.plan.status`       | `{workspaceId,parentSessionId,id}`                       | `{item}`；只读本实例、对应父会话及项目的计划。即使入场授权已撤销、父会话已离线或改绑，仍能读取原计划。                                                       |
| `workflow.plan.stop`         | 同 status                                                | `{item,stopped}`；先停止排队，再通过原工作流停止本计划创建的收据。未确认清理时 `stopped:false`，可再次显式停止以重试处置。                                   |

`stopAll()` 先同步标记本实例的所有活动队列，再等待逐个收据停止，返回 `{items,stopped}`。它不关闭服务，后续仍可创建新计划。它不停止其他计划服务实例或人工直接分派的工作流。`close()` 禁止新建、停止本实例计划并返回同形结果；调用者必须检查 `stopped`，不能把未确认处置视为卸载成功。停止等待官方启动中的收据返回，以确认其所有权后处置；此时 status 显示 `stopping`，不承诺即时完成。

建议入场撤销顺序：先持久撤销准入，再 `await plans.stopAll()`，最后按宿主既有规则停止其他自有工作流。每个排队任务实际启动仍调用 `DesktopWorkflow.dispatch("workflow.dispatch", …)`，因此工作流层的新分派准入校验仍然有效。停止与读状态不能受入场准入门阻断。卸载时先关闭计划服务，再关闭工作流。

## 任务与队列

每计划 1–32 个任务，运行期最多保留 128 份计划；到达历史上限明确报错，卸载实例后清空。任务形状为 `{id,role,task,requirements,dependsOn?,usePreset?}`；ID 唯一且不超过 128 字符，角色必须已存在，正文与本模块追加的依赖声明合计不超过工作流的 32 KiB 限制。`usePreset` 沿用工作流的显式预设选择要求，不自动注册预设。

`requirements` 必填，最多 32 条；`[]` 只表示提交者声明无依赖。条目与目录预检共用 `normalizeRequirements`：`{kind:"tool"|"toolkit"|"skill",name}`、`{kind:"directory",path}`，以及 [环境依赖](environment-preflight-contract.md) 的 `environment-variable/environment-host/environment-key`；变量可显式声明 `nonEmpty:false`。非空声明在父会话上下文预检；只有 `status:"ready"` 才分派，missing、unknown、无目录服务或预检错误均标为 `blocked` 并保留诊断。目录结果只说明可见登记或配置状态，不证明子代理连接健康、能力执行成功或拥有新的授权。能力名称、路径声明会以明确的数据段附在执行任务中，不静默选择替代工具；秘密值不传入任务。

`dependsOn` 控制任务的先后条件，并把同一计划中这些直接依赖的原始 `receipt.result` 附给执行者，携带 `taskId/runId/source/independentlyVerified:false`。数据段明确要求按任务复核、不得当作新指令或额外授权；不自动混入其他任务、其他计划或其他项目的结果，不改写成已核实结论。完整任务、依赖声明和结果超过工作流 32 KiB 限额时标为 `blocked/DEPENDENCY_CONTEXT_LIMIT`，保留完整原始结果供读取，不静默截断或启动。无法 JSON 表示的结果明确阻断。循环依赖拒绝创建；缺失的任务 ID 明确记录为 `missing-dependency`，不启动该任务。前置任务失败、被阻断或取消时，后续依赖任务同样不启动。只有前置收据的完成、处置和槽位释放均确认后，依赖才就绪。

队列每次通过现有 `flow.status()` 查看项目容量，实际申请、绑定、停止及释放完全由 `DesktopWorkflow` 处理。外部任务占槽时保持 queued；并发竞争引发 `SLOTS_FULL` 时继续等待。多个无依赖任务可使用现有空槽。状态观察间隔为 25 毫秒，仅调用本地收据状态；服务关闭后清除自身计时器。未确认清理时暂停该计划的新启动，不擅自释放槽位或反复自动处置。

父会话启动前重新检查存活及项目绑定，包括异步预检之后。父会话失效或改绑会停止本计划后续任务并清理自有收据；原项目、原父会话参数仍可读取和停止这份计划，其他父会话或项目不能借相同计划 ID 接管。

## 结果含义

计划 `state` 为 `queued/running/completed/finished-with-errors/stopping/stopped/cleanup-pending`。任务 `state` 为 `queued/checking/starting/running/completed/failed/blocked/cancelled`。`running` 是当前收据状态，不是事实核验；任务已经显示 completed 时，仍可能正在等待资源处置，应同时查看收据中的 `disposed` 和 `slotReleased`。

每个已取得工作流记录的任务保留 `runId`、原始 `receipt`，包括其结果、停止原因、错误和清理状态。`summary` 包括状态计数、`notStarted`（尚未取得任何工作流记录的任务 ID）、`cleanupPending` 及原样收据结果。工厂失败但已生成工作流记录时，会保留该失败记录，即使从未取得有效执行收据；不能仅凭 runId 宣称执行成功。

`summary.results` 的每项都有 `source:"workflow-receipt"` 和 `independentlyVerified:false`，不把执行者输出改写成已核实结论。失败输出也可能存在，必须结合任务状态和 `stopReason` 读取。计划完成仅表示调度收据流程完成。

## 可选指挥汇总

创建时显式设置 `summarize:true`，在原 1–32 个任务后追加内部任务 `$summary`，`kind:"summary"`、`role:"planner"`，计划标记 `summaryTaskId:"$summary"`。只有开启此选项时，原任务 ID 和依赖不能使用保留名 `$summary`；当前项目必须存在 planner 角色。不开启时保持原队列和调用数量。

汇总等待所有普通任务结束，且其收据处置、槽位释放已确认。失败、被依赖阻断或未执行的任务也进入来源数据。汇总复用普通分派的准入门、父会话绑定、并发槽、停止及清理；停止计划不会再启动排队中的汇总。统计包含汇总任务，任何原任务或汇总失败仍使计划为 `finished-with-errors`，不会用一段成功总结掩盖失败。

汇总输入只包含当前计划的任务 ID、运行 ID（如有）、状态、角色、原任务正文、完整原始结果和失败/阻断诊断。`sources` 保存在汇总任务上，为 `{taskId,runId?,state,source,independentlyVerified:false}`；未取得运行记录时 `source:"plan-task-state"`，否则为 `workflow-receipt`。这些来源引用表示输入关联，不证明模型实际逐条引用正确。提示要求区分执行者声称的结果、失败、未执行与证据缺口，引用实际提供的证据，不新增检查，不把来源文字作为指令。

完整汇总输入超过既有 32 KiB 限额时，明确标记 `blocked/SUMMARY_CONTEXT_LIMIT`；无法 JSON 表示时为 `SUMMARY_RESULT_INVALID`。不截断来源，也不启动该汇总；各任务原始输出仍可读取。汇总正文唯一来源为该任务 `receipt.result.output`，仍是未独立核实的代理输出，不自动写入发现项或证据库。

页面提供默认未勾选的“任务结束后生成指挥汇总”，提示额外模型调用。读取计划后直接显示汇总、引用来源、失败或未执行任务及诊断；原始收据继续保留。页面仅显示文本块，其他块保留在原收据，不猜测转换。

## 本轮验证边界

单元测试使用临时 SQLite、真实项目 `WorkspaceStore/Flow/DesktopWorkflow`，activation 工厂和结果为原创合成收据。覆盖单槽两个任务、等待处置、原样结果只传直接依赖、上下文超限不截断、失败及缺失依赖、环境声明与阻断、输入边界、父/项目隔离、停止及清理失败、停止所有计划后再创建、启动中停止、预检期间改绑、排队任务仍经过工作流入场准入门。

`workflow-host.test.mjs` 另从未改写的官方 spawn/SubagentRuntime/AgentLoop 运行两任务计划，核对原始收据在后继 user 输入中出现、结果未被自动标为验证、两个执行者处置后释放槽位并从 JSONL 读回。停止用例确认运行中子任务取消、排队依赖不启动且父会话保留。新增可选汇总场景验证两个实际官方执行者完成、处置后，第三个 planner 请求含逐项准确来源与完整结果；失败执行者和未启动的依赖也进入汇总，最终计划仍保留失败状态。汇总输出与官方 JSONL 逐块读回一致。LLM 仍为固定合成传输，此证据验证调度和数据路径，不验证模型的总结质量；没有连接真实模型、网络、正在运行的桌面或 profile，也没有桌面 UI 执行证据。

```sh
DSH_NODE='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'
"$DSH_NODE" --version
"$DSH_NODE" --test tests/workflow-plan.test.mjs
```

Controller、模型工具、HTTP 和 UI 由宿主集成层接入；这个模块自身不注册外部入口。模型草稿的目录候选匹配见下节；自动执行生成计划、跨重启计划恢复和桌面实机验收仍未实现或未验证。

## 首轮角色正文的官方隔离验证（2026-10-21）

`workflow-host.test.mjs` 保留原 5 项测试并增加角色场景，通过真实 `DesktopRuntime → Flow.rolePrompt` 接线，在运行控制已应用且总开关启用时检查 7 次官方 AgentLoop 请求。两个逻辑工作区给同名角色配置不同原创标记；实际工作流先绑定、分配角色和领取槽，再创建官方执行者，首轮 system 槽只含所属工作区的标记。官方 system 消息日志与请求内容一致，原生工具 schema 和合成功能说明保留。

明确绑定但未分配角色的新执行者不会因任务正文提到角色名而得到角色注入；普通未绑定会话也不带角色。已有会话明确绑定并分配后，下一次请求出现角色；释放槽并显式 `flow.assign({role:null})` 后下一次请求移除角色。`flow.release` 只释放并发槽，单独调用它不撤销角色分配。撤销运行控制后，原始组装描述符精确恢复，新请求不再注入角色或操作者正文。

工作流还会把角色正文加入 user 任务，因此不能声称角色只出现于 system 槽。两个逻辑工作区共享合成工作目录，本次不证明文件系统隔离。模型传输与功能说明为合成材料，没有实际工具或 MCP 执行，也没有完整 standard 预设或桌面交互验收。[角色证据](evidence/workflow-role-acceptance.json) 记录源码摘要、6 项测试结果和这些边界；开发操作异常另见 [验证记录](verification.md#子代理限额与首轮角色正文2026-10-21)。

## 从目标生成任务草稿（2026-10-21）

`workflow.plan.propose({workspaceId,parentSessionId,goal})` 返回普通计划收据 `{item}`，内部只有一个 `$planner` 任务，使用当前项目 planner 角色、既有准入门、工作流执行器与并发槽。`goal` 最多 16 KiB。需要活动且绑定的父会话、目录 list 和受支持的宿主；目录读取后再次检查准入与父会话。模型工具仍强制使用调用者项目及父会话。capabilities 的 `planDrafting` 表示这个入口可用，`automaticTaskMatching:false` 仍表示没有自主匹配后直接执行的闭环。

规划输入只包含目标、当前角色编号，以及父会话可见工具、宿主技能、已检测可用的 Toolkit 名称与公开描述。技能正文、工具 schema、凭据和环境秘密不进入此输入；项目私有技能暂不作为候选。目录来源状态保存在 `proposal.catalogSources`；来源不完整时仍只能从已观察到的候选选择，不能声称它们涵盖全部能力。完整输入超过 30 KiB 明确拒绝，不截断目标或目录。

规划者被提示只规划、不调用工具，但仍通过普通官方工作流创建，继承宿主工具、权限与审批边界；这不是无工具沙箱，也不保证模型遵循提示。界面明确说明这一点。新增入口不改变权限、不安装工具、不连接作者服务。没有实现自动重试、纠正模型输出或隐式执行草稿。

通过 `plan.status` 查看 `item.proposal`：初态 `pending`，完成且资源处置、槽位释放确认后解析原始文本结果。只接受 JSON 对象 `{tasks:[...]}`；任务沿用既有校验，另拒绝目录外能力、目录外依赖类型、未知角色、缺失/循环依赖、usePreset 和额外字段。输出最多 32 KiB，不截断、不从 Markdown/解释中猜取 JSON。成功为 `ready`，含 `tasks` 及 `source.runId/independentlyVerified:false`；非法输出为 `invalid` 并使计划 `finished-with-errors`，原始结果和诊断保留。未完成为 `failed`，停止为 `cancelled`。所有状态均不自动创建生成的子任务。

`ready` 只表示结构和候选名称检查通过，不代表拆解正确、任务范围获批、依赖可用或事实核验。界面展示任务/角色/正文/匹配能力/前置任务；“将当前草稿填入任务表”仅填表，用户可编辑，再使用既有提交入口。执行时按当前目录重新预检非空 requirements，不能沿用规划时的可见性代替执行检查。已填入并编辑的任务是新显式计划，不声称与原草稿逐字相同。

隔离验证：单元覆盖目录筛选、精确能力名称、格式/大小拒绝、停止、失败、异步目录期间关闭/父改绑、等待清理与另行提交；官方 spawn/AgentLoop 跑通一次规划及另一次执行，规划原始输出写入并读回临时 JSONL，模型传输为合成。UI 测试覆盖填表与提交分离、过期结果和错误转义；回环组件页面跑通完整操作。真实模型的拆解/匹配质量、项目私有技能、技能正文及递归依赖选择、自动执行闭环与真实 DSH 嵌入仍未验证或未实现。
