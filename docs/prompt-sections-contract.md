# 提示词功能段保留合同

本合同对应桌面适配的 `replace/append/disabled` 提示词组装路径。它区分替换的人设正文与继续生效的功能说明，并限定 `complete` 的处理方式。它不是第三方记忆内容删除策略，也不改变宿主审批、工具访问或模式的执行规则。

## 每步采用当前正文

启用期间，`replace` 与 `append` 每次提交当前完整 assembly，不把以前版本继续追加到有效系统消息中。`append` 保留的是当前宿主正文与功能说明，不是每次历史组装的副本。0.2.1-rc.2 的 DeepSeek 模型可以使用 `in-history` 更新模式，原生投影会追加改变后的整段正文；此前本项目只刷新文本，没有调整投影方式，导致同一轮第 2 步同时发送 A/B，重试和后续步骤继续累积 C/D。

现有 `agent.systemPrompt.project` 包装在本次启用仍有效时，浅复制投影选项并传入 `inHistory:false`，保持其余选项与调用者对象不变。官方投影生成替换事件，当前 Session 投影和协议原生 system 槽均只保留最新版本；原始 `system/message` 审计事件仍可回读。用户消息、工具调用和工具结果不通过请求副本删改。该策略沿用官方投影对系统节点的归一化规则，不承诺保留绕过 SystemPrompt 直接写入的任意独立系统消息。

同一 step 重试仍通过已核验的 renderer 重新组装当前正文；进入新 step 清除重试缓存。两者必须在同一个多工具步骤场景里验证，不能用“出现新正文”代替“旧正文已不在有效输入中”。

## 当前会话撤销

还原立即恢复本插件持有的投影方法描述符。对于已经由该包装产生、仍在有效 surface 中的系统节点，按其完整消息值（包含唯一 ID）识别所有权，并在该 Agent scope 注册一次恢复监听。下一次官方 `agent/pre-step` 真正允许进入时标记 `startsRequestSeries:true`，由宿主在合法 step 内恢复其最新正文；观察到原节点被官方系统提交替换后解除两项监听。拒绝或用户取消不会提前消耗恢复机会，也不会被转成允许。

恢复监听不读取本插件设置或存储，不发送消息、启动任务或制造轮次。撤销时空闲日志完全不变，原正文在下一次正常请求前恢复。不能在已经 `turn/end` 的日志后直接追加 `system/message`：官方持久读取器会将这种记录判定为损坏。代理 scope 销毁时释放监听，不在持久句柄关闭后补写。

驻留 Agent 沿用上述一次恢复监听；关闭后重新打开的会话和未经过 request 包装的继承分支，使用下述持久标记恢复。其他插件已接管投影方法时仍报告所有权冲突，不覆盖其方法。

## 关闭会话后恢复

本版本在即将由宿主提交的非空自有系统消息中保存 `source["dsh-unlimit"] = {version:1, owner:"managed-prompt"}`。保留原 `kind:"system-prompt"`、消息 ID、正文及其余字段；官方消息是冻结对象，因此只复制 commit/message/source 三层，不原地修改，也不为清空的替换节点加标记。该字段由官方 JSONL 保存并随 fork 继承，四种协议只发送正文，不发送此元数据。

插件挂载期间保留一个仅用于恢复的 `agent/pre-step` 监听，包括运行控制默认关闭的启动状态。它只检查当前 `deriveMessages()` 中非空系统消息的准确 owner 和版本，不扫描历史、不读取关闭状态下的设置数据库，也不按文本追认所有权。在官方允许进入且控制未生效时，经发行清单核验 Session 与 AgentLoop 入口后，设置 `startsRequestSeries:true`，由宿主在该步投影当前原生正文。拒绝保持拒绝；关闭插件 scope 同时释放监听并使等待中的旧回调失效。

此字段是 **0.2.1-rc.2 经验证可持久化的额外 JSON 元数据**，不是官方稳定的所有权 API。新版本必须重新核验，不能仅放宽版本号。旧版本生成的无标记历史、未知 owner/version 不自动处理；插件完全卸载且没有代码运行时也无法执行冷恢复。如果宿主正文恰好与现有正文相同，官方可能不生成替换事件，标记仍可保留，不能仅因进入恢复步骤就宣称标记已清除。真实应用重启/HMR和桌面嵌入仍未验收。

[prompt-recovery-host.test.mjs](../tests/prompt-recovery-host.test.mjs) 用真实官方 AgentHandle 销毁原 Agent 与 Session，再通过 `agents.resume()` 从物理 JSONL 读取、创建同 ID 的新实例；同时验证尚未发起过请求的官方 fork。四协议各执行 replace/append：首次正常请求不再含旧正文、当前宿主正文保留、原日志前缀逐项相同、持久标记不进入 wire，撤销/关闭/恢复/分支本身不发送请求。DeepSeek 的两条旧实现回归明确复现了正文残留，其余协议原本能替换正文，此次补充验证共同的所有权元数据合同。

另由 [plugin.test.mjs](../tests/plugin.test.mjs) 通过实际 mount 与官方事件链验证默认关闭、无标记同文、拒绝、零数据库读取、零日志写入及卸载中等待回调失效；它使用合成 Session，不替代上面的磁盘冷恢复测试。[prompt-refresh.test.mjs](../tests/prompt-refresh.test.mjs) 验证冻结对象、空节点和未知标记边界。所有记录和传输为原创合成数据，没有安装、真实配置读写或模型联网。

## 完全卸载恢复的入口复核（2026-10-21）

当前仍未实现完全卸载后的旧会话恢复。此次核验 0.2.1-rc.2 的 `dsh-agent-loop`、`dsh-session`、`dsh-session-persistence`、`dsh-session-persistence-jsonl` 和 `dsh-api-session-controller` 发行入口：持久存储约定为追加、不重写既有事件；`runMaintenance()` 只切换 Agent 运行阶段，不开放 turn/step；控制器没有独立的离线系统提示修复操作。没有修改已关闭日志或制造人类输入来适应这些约束。

新增 `prompt-recovery-host.test.mjs` 的隔离反例：先完成一个真实官方 AgentLoop 步骤并卸载插件 scope，再在官方 `runMaintenance()` 中使用原生 `systemPrompt.project()` 产生替换、提交到一次性合成日志。内存追加可以成功，但物理 JSONL 读回的原因链明确报 `system/message does not match an open turn and step`。这个尝试只存在于测试中，损坏的合成日志随临时目录清理，产品没有引入该写法。原日志前缀不变，没有新 turn/step/人类消息或清理用模型请求。

既有完全卸载反例及四协议冷恢复场景同时保持：插件仍加载时可以在下一真实步骤恢复；完全卸载后 DeepSeek 旧正文仍可能进入下一请求，新会话没有该残留。要补齐，需要经验证的宿主历史维护入口，或另一条能在合法生命周期中完成并持久验证的恢复路径；当前不能把“方法返回”或“内存正文已变”记成完成。此结论限定当前版本和已核验接口，不断言其他方案永远不可实现。

## 工具步骤与重试的协议回归

[prompt-steps-host.test.mjs](../tests/prompt-steps-host.test.mjs) 通过真实 AgentLoop、ToolRuntime、官方重试执行器、四种官方协议适配器及 JSONL 读回验证。HTTP/SSE 回复、凭据、工具及全部会话均为合成数据；没有真实网络、模型、用户 profile 或安装操作。

- DeepSeek 默认、Chat Completions、Responses、Messages 分别测试 replace/append，共 8 个场景。一个 turn 内按 A→工具→B→503→C 重试→工具→D 执行；请求 step 为 1/2/2/3，各自只有当前系统正文一次，原始日志保留四版。
- 官方原生 system 字段、请求前 Session 投影与物理 JSONL 一致。append 保留宿主人设，replace 移除指定人设；两者保留未知注册功能段、schema、人工输入及两个实际工具结果。撤销后同一会话再发一轮采用宿主正文。
- 另 1 个官方场景验证空闲撤销不写日志、描述符恢复、先拒绝再取消仍不发送、随后正常请求恢复正文并释放监听。
- [prompt-refresh.test.mjs](../tests/prompt-refresh.test.mjs) 补充选项不被原地修改、未启用与旧回调沿用宿主原参数的回归。

这修复了此前“新正文出现即算生效”的证据不足；不表示真实服务端接受、模型回答效果、桌面 UI 或完整 1:1 已验收。

## 替换范围

启用 `replace` 时，仅移除官方有明确用途的三个人设槽：`harness:identity`、`deployment:persona-prefix`、`deployment:persona-suffix`，以及当前 scope 中明确标记 `complete:true` 的完整提示词定义所对应的输出段。之后加入本项目的 operator 正文。

其他段默认保留，包含未知插件段，不能用 `tool:` 前缀代替功能分类。官方的 `tools:ptc-only`、`tools:sdk`、`plan:policy` 都不匹配此前的 `tool:` 规则。保留段的文本、顺序和其他字段不改；原始 assembly 不被原地修改，`tools`、`contexts`、`variables` 保持原引用。

`append` 沿用原始段并追加 operator，不取额外的完整定义快照。禁用时返回官方组装结果，不添加正文，也不取额外快照。还原操作只移除本插件仍拥有的方法包装，恢复原描述符。

## complete 与 scope

0.2.1-rc.2 的官方 `SystemPrompt.assemble()` 会在内部合并定义、处理 complete 后，输出仅含 `name/text/interpolate?` 的段；输出不保留 `complete` 标记，也不提供标准 owner/source。仅检查渲染结果上的 `complete` 不足以识别完整提示词。

适配层在启用 replace 时、调用原 assemble 前，只读 `systemPrompt.layers.merge(context.scope, layer => layer.sections)`，获得当前有效的 complete 名称。官方 `ScopedLayers` 先取全局再按 scope 祖先到当前覆盖同名定义，返回新的 Map；定义对象仍属于注册者，不能修改或撤销它。

这属于 **0.2.1 的内部只读适配点**，不是通用稳定的描述符 API。后续版本须重新核对结构、覆盖顺序和 complete 语义，不能只放宽版本号。

官方 complete 已经压掉的功能段不重建：例如原 assemble 只输出一个完整提示词，replace 输出 operator；append 输出该完整提示词加 operator。不会从 registry 把未被原组装接纳的其他段重新拉回。agent scope 将一个全局 complete 同名覆盖成普通段时，它应作为普通功能段保留；子 scope 同名覆盖为 complete 时再按完整提示词替换。撤销子或父的确切注册后，沿官方 scope 链恢复其继承结果。

## 官方隔离验证

`tests/prompt-sections-host.test.mjs` 包含原有 5 项段落测试及新增 1 项规则选择测试，使用以下 0.2.1-rc.2 官方模块。每个直接导入入口在执行 import 前，都与指定运行时的 `desktop-runtime.json` SHA-256 清单核对；不匹配立即失败，不当作干净官方证据。

| 模块                                  | 使用的真实能力                                            |
| ------------------------------------- | --------------------------------------------------------- |
| `@deepseek-ai/cordis`                 | Context、Service、插件和 effect 生命周期                  |
| `@deepseek-ai/dsh-system-prompt`      | section/context/variable 注册、真实组装及 `renderPrompt`  |
| `@deepseek-ai/dsh-tools`              | ToolRuntime、defineTool、native/PTC 呈现、SDK/schema 生成 |
| `@deepseek-ai/dsh-plan-mode`          | PlanModeController 及其真实 `plan:policy` 提供方          |
| `@deepseek-ai/dsh-session`            | SessionStore、真实会话和事件追加                          |
| `@deepseek-ai/dsh-session-projection` | 计划状态随真实 `plan/mode` 事件更新                       |
| `@deepseek-ai/dsh-scope`              | 父子 scope 绑定、继承、同名覆盖及撤销                     |

场景与证明范围：

1. 默认 native 呈现原创合成证据工具；真实切到 PTC 后只呈现 `run_code`，官方生成 `tools:ptc-only` 和 `tools:sdk`。replace 后两段原样保留并进入真实 renderer；直接在真实 Session 追加 `plan/mode`，验证投影状态与 `plan:policy` 的出现/消失。还核对全部保留段顺序和 assembly 其他属性没有变化。
2. 父 scope 的 PTC 与子 scope 的 native 同时存在，撤销子选择后恢复继承 PTC，再撤销父选择后恢复 native。
3. 官方输出已丢 complete 标记，但包装仍根据原有效定义替换；不修改定义或重建被官方 complete 隐藏的功能。
4. 同名全局 complete、父普通段和子 complete 的覆盖，及各自准确 disposer 的撤销。
5. disabled/append 不增加 registry 读取，replace 才增加一次快照；还原后方法描述符、读取次数和原组装输出恢复。

### 合成部分与未验证边界

PTC 后端只是一个真实 Cordis Service，提供 `language:"typescript"`、`programFormat:"function-body"`，供官方 SDK/schema 生成器使用，没有执行方法；没有运行 `run_code` 或任何工具。审批与沙箱同样使用真实 Service 上的惰性合成接口，只为满足 `DesktopRuntime.apply()` 的接口需求，不能据此宣称真实审批/沙箱通过。

MCP、文件引用、交付、team 与未知段均为原创合成注册，用官方 SystemPrompt 接口和其真实 renderer 验证保留；不是连接 MCP、读取资源、真实文件交付或团队任务执行的证据。没有复制默认提示词正文。

会话及计划投影在隔离上下文内运行；目录为新建临时目录，不读真实 profile，不启动 AgentLoop/模型请求，不证明磁盘持久化或桌面 UI。Socket、datagram、fetch 和 child_process 均设禁止调用守卫，结束时核对无调用。清理使用官方 scope、插件和根 context 的生命周期。

没有导入摘要不匹配的 `dsh-agent-instructions`、`tool-fs` 等模块或任何备份。原生工作区基线是带来源的 `user/message` 历史载体，不属于这里的 section 修复；strict/fallback 对该载体的语义仍须独立验证。Hook/Mnemon 策略、真实模型协议和完整 1:1 桌面验收也不在这 5 项证据内。

## 复验

```sh
DSH_NODE='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'
export DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh'
"$DSH_NODE" --test tests/prompt-sections-host.test.mjs
```

新增规则选择回归在真实 SystemPrompt 与 renderer 中依次验证同模型 A 激活、编辑 A、切换 B、编辑 B，并核对其他模型使用保存正文、全局规则与模型优先级；每次只有预期正文出现，schema 保持，revert 恢复原始官方组装。规则库输入是合成对象；另由 `tests/runtime.test.mjs` 覆盖临时 SQLite 保存/激活到实际适配器组装的路径，以及跨模型的工作区 fallback。

当前实际使用 DSH bundled Node **v24.21.0**，6/6 通过、0 失败、0 跳过。未提供 `DSH_UNLIMIT_RUNTIME` 时，这些官方隔离项明确跳过，不能被当作已经通过。新增场景没有调用真实模型或安装插件。
