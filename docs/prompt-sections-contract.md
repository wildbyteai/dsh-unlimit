# 提示词功能段保留合同

本合同对应桌面适配的 `replace/append/disabled` 提示词组装路径。它区分替换的人设正文与继续生效的功能说明，并限定 `complete` 的处理方式。它不是第三方记忆内容删除策略，也不改变宿主审批、工具访问或模式的执行规则。

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
