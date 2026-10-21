# 原生工具执行与计划切换合同

对应 `CORE-MODES`，目标为 DSH desktop `0.2.1-rc.2`、macOS arm64。真实官方 ToolRuntime、文件工具、本地文件后端、UserQuestionService 和 PlanModeController 的隔离回归已通过 **8 项（1 个父测试、7 个场景）**。本次手动驱动官方 pre-step 事件，没有执行完整 AgentLoop，也没有完成标准、极简、PTC、计划四模式的整体验收。

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

## 已执行场景

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

## 保留差距

- 本次逐项组合服务，未激活完整 standard/minimal/PTC 预设，也未读取真实用户的默认预设选择；不能把 native 工具执行等同于完整标准预设验收。
- ToolRuntime 的呈现值是 native/ptc；极简是另一份工具组合，其原生配置关闭文本 `read`，依赖持久 shell 读取文本。本次没有启动 shell 或 PTY。
- PTC 需要实际后端。此前隔离探针被平台 `sandbox-unavailable` 阻断；本回归未重试 PTC、未运行子进程，也未用描述性 runtime 或宿主 eval 代替执行。
- pre-step 使用官方 dispatcher 和投影手动驱动，没有验证完整 AgentLoop、模型调用、同一模型步骤批次、持久化恢复或桌面计划 UI。
- 合成人答没有执行真实 UI/Gateway 路由或 UI 所拥有的提问审计事件；本证据只声称已读回的 `plan/mode` Session 事件。
- 本回归没有增加网页抓取或浏览器路径覆盖；`CORE-WEBTOOLS` 的本地页面检索和完整四模式工具能力仍需独立验收。
