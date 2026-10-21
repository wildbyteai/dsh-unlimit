# 原生工具执行与计划切换合同

对应 `CORE-MODES`，目标为 DSH desktop `0.2.1-rc.2`、macOS arm64。组件级回归通过 **8 项（1 个父测试、7 个场景）**；后续新增官方 AgentLoop 驱动回归通过 **7 项（1 个父测试、6 个场景）**，覆盖原生读文件、计划审阅、同批工具与下一步切换、取消及 JSONL 读回。再新增完整 standard 预设回归 **4 项（1 个父测试、3 个场景）**，经真实 Loader/Registry 绑定预设并执行读取和计划审阅。三层证据分别保存，没有完成标准、极简、PTC、计划四模式的整体验收。

## 官方接口与实际边界

| 接口                                                                     | 合同与本次使用                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ToolRuntime.execute({name, arguments, agent, callId, signal})`          | 实际执行官方 `read` 与 `exit_plan_mode`，保留原生工具调度、结果与取消；不是直接调用工具内部函数                                            |
| `PlanModeController.set(agent, active)`                                  | 无打开 turn 时立即追加 `plan/mode`；打开 turn 内先排队。`get(agent)` 区分日志中的 `active` 与尚未提交的 `pending`                          |
| `exit_plan_mode({plan})`                                                 | 需要活动计划状态和以一级标题开始的非空计划；通过 `ctx.userQuestions.ask()` 请求明确审阅，不能把普通操作审批或 autoApprove 当作计划同意     |
| `UserQuestionService.ask({questions, agent, signal})`                    | 验证确切 live Agent 与运行时 root 身份，再走按 Agent 作用域路由的 `user-questions/request` waterfall；没有 answerer 则 `NO_PROVIDER`       |
| `user-questions/request`                                                 | 本回归仅在此处注入原创合成人答；请求的 Agent/Session、`plan-review` intent 与 callId 均实际核对，没有替换 UserQuestionService 或计划执行器 |
| `agentEvents(ctx, agent).waterfall("agent/pre-step", payload, terminal)` | 使用官方作用域派发器手动驱动；terminal 给出官方 `enter` 或 `reject` 决策。仅验证 Controller 对此边界的处理，不替代 AgentLoop 驱动验收      |
| `turnBoundaryProjectionDefinition`                                       | 从库存匹配的 AgentLoop 模块导入官方投影，通过合成 `turn/start` 事件建立打开 turn；不实例化 AgentLoop、不调用模型                           |

计划是独立的 Session 协作状态，不是文件权限模式。工具成功获批退出后返回 `{approved:true}`，此时状态仍为 `{active:true,pending:false}`；同一批中的后续工具保持原计划状态。下一次 pre-step 被拒绝或其 signal 已取消时不提交，首次非取消的 `enter` 才追加 `plan/mode:{active:false}`，重复事件不重复提交。

提议中的下一次提示词组装会读取 pending 状态，因此在日志尚未提交退出时，新的组装已可以没有计划指导段。这与已组装的当前步骤继续处于计划状态不冲突。测试分别核对了提示词组装、Controller 状态和 Session 事件，未把其中一种当作另一种的证据。

普通 `ApprovalService` 的 `never` 策略没有阻止明确的计划审阅；本插件的 autoApprove 也没有补出缺失的计划 answerer。两套授权用途独立，测试没有把合成人答解释为真实用户同意。

## 已执行组件场景

[modes-execution-host.test.mjs](../tests/modes-execution-host.test.mjs) 复用 [file-permissions-fixture.mjs](../tests/helpers/file-permissions-fixture.mjs) 的真实官方文件执行链。测试只加载额外的官方计划、提问模块和 turn 投影，未添加替代模式或替代工具。

| 场景 ID                          | 实际断言                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODES-NATIVE-AND-PLAN-READ`     | native 呈现存在 `read`、不存在 `run_code`；普通和计划状态下实际读取同一合成文件并核对内容，计划日志保持开启                                                       |
| `MODES-PLAN-REQUIRES-ANSWERER`   | 官方提问服务存在但没有 answerer，退出工具返回 `NO_PROVIDER`；计划不退出，不追加普通 `approval/asked`                                                              |
| `MODES-PLAN-REJECT-AND-FEEDBACK` | 选择继续计划，或在同意选项上附加自定义反馈，均拒绝退出且保留原计划状态                                                                                            |
| `MODES-PLAN-DISMISS-CANCEL`      | 合成人答抛官方 `ASK_CANCELLED`，工具返回 `{approved:false}` 并设置 `concludesTurn:true`；计划保留。没有运行 AgentLoop 收尾，不能声称 turn 已自动关闭              |
| `MODES-PLAN-INFLIGHT-ABORT`      | 等待审阅期间取消真实 ToolRuntime 调用，signal 到达合成 answerer，结果失败且计划保持开启                                                                           |
| `MODES-PLAN-APPROVE-BOUNDARY`    | 明确同意只创建 pending 退出；当前状态仍能实际读取文件；拒绝/取消的 pre-step 不写退出事件，第一次 `enter` 写一次，重复事件不重复写；退出后仍可实际读取             |
| `MODES-PROMPT-REPLACE-COMPAT`    | 启用 DesktopRuntime 的 replace 与 autoApprove 后，工具 schema 和计划段保持，实际读取成功；无 answerer 仍拒绝；明确同意后按相同边界退出，revert 后工具 schema 恢复 |

摘要、直接加载入口摘要、归档校验、合成人答捕获和清理结果见 [modes-execution-acceptance.json](evidence/modes-execution-acceptance.json)。运行环境为宿主依赖中的 Node `v24.21.0`。源码摘要对应生成证据时的工作树，不能把后续代码变更自动视为已经验证。

## 可信门、清理与复验

安装的 tool-fs 入口摘要不符，只作哈希检查，不执行或恢复它。共享夹具使用固定 npm SRI 与库存入口 SHA256 校验过的公开归档建立临时干净运行时；所有额外模块也经 `loadOfficial()` 库存验证并纳入证据。测试没有复制官方实现或默认提示词到产品源码。

合成工作区位于忽略的 artifacts 临时根，文件后端和读操作未 mock。TCP connect/listen、UDP、fetch、DNS 与 child_process 入口均禁止；运行完成后先 revert 本插件、等待官方 scope/fiber 清理、删除临时根并核对安装入口未变化，才允许生成证据。没有读取真实 profile、真实会话或凭据，没有安装或重载 DSH。

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
DSH_UNLIMIT_OFFICIAL_PACKAGES="$PWD/artifacts/official-packages" \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
  --expose-internals --test tests/modes-execution-host.test.mjs
```

两个运行环境门任一缺失时明确跳过；显式设置后缺文件或摘要不符则失败。只有增加 `DSH_UNLIMIT_MODES_EXECUTION_EVIDENCE=1` 才更新上述固定 JSON，普通测试不改写 docs。

## 官方 AgentLoop 执行补充（2026-10-21）

[modes-loop-host.test.mjs](../tests/modes-loop-host.test.mjs) 复用同一干净官方文件夹具，另外挂载真实 LlmRuntime、AgentLoop、UserQuestionService、PlanModeController 与 JSONL 持久化服务。通过 `agent.followup()` 入队，再等待 `whenIdle()`；测试不调用 ToolRuntime.execute、不手工追加 turn/step，也不手工派发 pre-step。模型出口是显式脚本驱动的原创合成 LlmAdapter，审阅入口是合成人答；没有真实模型、提供方传输或桌面 UI。

| 场景           | 实际结果                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生读文件     | 官方循环调度 read，实际读取临时文件；第二步收到工具结果并结束，替换提示词进入请求。                                                                                    |
| 批准后切换     | 四步依次为 read、同批 exit_plan_mode + read、read、结束。请求时计划状态为 true/true/false/false；同批第二个工具仍见 active=true、pending=false，下一步才写入退出事件。 |
| 拒绝计划       | 工具结果携带拒绝错误；后续步骤和持久日志仍保持计划状态，没有写退出事件。                                                                                               |
| 关闭审阅       | 官方 concludeTurn 在真实循环内结束当前轮次，只产生一次模型请求；计划保持开启。                                                                                         |
| 在途取消       | agent.cancel 的取消信号到达审阅提供方；轮次实际以 aborted 结束，无后续模型请求或计划退出。                                                                             |
| 无审阅方与撤销 | autoApprove 不补造计划批准，无提供方时返回 NO_PROVIDER；revert 后另建会话实际读文件成功，自定义提示词消失，官方工具 schema 保持一致。                                  |

共 7 个临时会话、14 次合成模型请求、10 次循环调度工具调用（5 次 read、5 次 exit_plan_mode）。每个会话均从官方 JSONL reader 重读，与内存 Session 事件逐项一致；这证明持久写入与读回，不证明冷启动恢复。全部请求工具 schema 一致，计划切换后的请求保留自定义提示词并移除计划指导段。组件测试中的“手工事件”边界仍属于其原证据，不改写为循环执行。

证据保存在 [modes-loop-acceptance.json](evidence/modes-loop-acceptance.json)，只有 `DSH_UNLIMIT_MODES_LOOP_EVIDENCE=1` 才更新。复验使用上面的两个运行环境变量，将测试路径换为 `tests/modes-loop-host.test.mjs`。执行后撤销插件适配、释放官方服务、清理临时工作区与运行时；已安装的修改入口只做摘要读回，未执行或恢复。

## 完整 standard 预设隔离执行（2026-10-21）

[presets-host.test.mjs](../tests/presets-host.test.mjs) 通过 [preset-fixture.mjs](../tests/helpers/preset-fixture.mjs)，以官方 YAML schema 和 patch 应用器解析未经删减的 `standard.patch.yml`，再交给真实 Loader 与 AgentPresetRegistry。没有将逐项工具挂载改称完整预设：实际保留的 revision 包含原声明的 **29 个条目**，**26 个启用条目全部 active**；macOS 的 pwsh 及两个管理工具按官方声明禁用。每个 Agent 的上级 scope 与 Registry 提供的当前 revision lease key 按对象身份比较，已绑定模块与启用条目逐项对应，无泄漏服务。

Host 依赖也使用官方服务，包括调度、存储、会话控制器、子代理、技能、连接与本地凭据提供方；只把模型响应及计划人答作为明确的合成边界。连接服务不监听网络，凭据文件新建于临时根，shell、PTC 和子进程服务仅加载，未执行后端。测试以临时 `DSH_HOME`、`DSH_AGENTS_HOME`、`DSH_BUNDLED_SKILL_DIR` 和受限文件访问隔离真实资料，不改 `HOME` 或应用配置。

| 场景           | 实际结果                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| 完整预设读取   | 真实 AgentLoop 调用官方 read，读取合成文件并结束；自定义正文替换官方 persona，原始 30 种工具 schema 保留。       |
| 预设内计划审批 | 计划服务留在预设的隔离 scope；replace 前后完整官方计划段相同，明确合成人答批准后下一步退出，后续请求移除计划段。 |
| 撤销适配       | 新会话读文件成功，自定义标记消失，官方 persona 恢复，工具 schema 与启用替换时逐项相同。                          |

三个会话共 **8 次合成模型请求、6 次循环调度工具调用（read 5 次、exit_plan_mode 1 次）**；30 种 schema 在全部请求中一致。每个会话从官方 JSONL reader 重读，与内存事件逐项一致。公开证据只记录官方正文的摘要、条目和模块元数据，不附正文、凭据或临时路径。

执行证据见 [presets-acceptance.json](evidence/presets-acceptance.json)，记录 535 个实际加载文件的发行摘要、原始预设摘要、源码摘要、三类越界尝试为空及临时根清理结果。复验沿用上面的两个环境变量，测试路径换为 `tests/presets-host.test.mjs`；增加 `DSH_UNLIMIT_PRESETS_EVIDENCE=1` 才生成证据。所需五个固定公开归档及校验边界见[维护流程](maintenance.md)。

## 保留差距

- 完整 standard 声明、读取与计划切换已有隔离证据；其余已注册工具没有在本回归执行。minimal/PTC 完整预设和真实用户默认预设选择仍未验，不能把工具注册视为工具执行验收。
- ToolRuntime 的呈现值是 native/ptc；极简是另一份工具组合，其原生配置关闭文本 `read`，依赖持久 shell 读取文本。本次没有启动 shell 或 PTY。
- PTC 需要实际后端。此前隔离探针被平台 `sandbox-unavailable` 阻断；本回归未重试 PTC、未运行子进程，也未用描述性 runtime 或宿主 eval 代替执行。
- 新增循环证据验证了官方 AgentLoop、同批执行、真实步边界与 JSONL 读回；真实模型选择行为、冷启动恢复、极简/PTC 完整预设及桌面计划 UI 仍未验证。
- 合成人答没有执行真实 UI/Gateway 路由或 UI 所拥有的提问审计事件；本证据只声称已读回的 `plan/mode` Session 事件。
- 本回归没有增加网页抓取或浏览器路径覆盖；`CORE-WEBTOOLS` 的本地页面检索和完整四模式工具能力仍需独立验收。
