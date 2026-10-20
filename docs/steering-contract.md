# 运行中插话与下一轮排队合同

对应 parity `SESSION-STEER`，适配目标 `0.2.1-rc.2`。本次仅增加官方模块隔离行为测试，不改宿主或插件业务代码，不安装、不启动桌面。

## 官方入口与保留语义

使用安装包实际导入的 `@deepseek-ai/dsh-agent-loop`、`Session`、`ToolRuntime`、`SystemPrompt`、JSONL persistence 等模块。每个直接导入入口先核对 `desktop-runtime.json` SHA256 清单，release 必须为 `0.2.1-rc.2`。本次每个场景核对 12 个入口；这不表示所有传递依赖已逐个摘要验证。

| 官方 Agent 方法         | 队列与行为                                                           |
| ----------------------- | -------------------------------------------------------------------- |
| `steer(message)`        | 写入 next-step 并请求唤醒；运行中的工具先完成，在当前轮下一步骤参与  |
| `followup(message)`     | 写入 next-turn 并请求唤醒；当前轮结束后，一条排队输入对应下一轮      |
| `inject(message)`       | 写入 next-step，但不唤醒；停止后的注入可以留在队列，不能自行启动轮次 |
| `cancel({kind:'user'})` | 默认清空 next-step / next-turn；中止当前活动并清除待重放的唤醒请求   |

本合同检查默认 cancel，不声称 `keepInbox:true` 具有清空语义。官方 `send` 对中止期间新到达的主动唤醒另有处理，测试不改写这些调度方法。插话和排队沿用官方入口，不通过改动模型历史或伪造新的人工来源替代。

## 插件启用下的验证

`tests/steering-host.test.mjs` 实际创建 `DesktopRuntime` 并执行 `apply()`，`prompt` 和 `promptRetry` 能力都须为 active。测试不是只对未启用插件的官方循环做冒烟检查。

假 LLM 首次返回一次 `synthetic_slow` 调用。该工具由官方 `defineTool` 注册、经 ToolRuntime 调度，只等待内存 gate，响应官方取消信号；不执行命令、网络或文件操作。后续假 LLM 请求返回原创合成文本。

三个场景分别核对：

1. **当前轮插话。** 慢工具期间依次注入插件测试来源消息、人工 steer 输入，确认工具尚未释放时无第二次请求。释放后恰好出现 `(turn 1, step 2)`；插件消息与人工消息保留顺序和原 source。提示词从 A 改到 B 后，新步骤真实请求使用 B；工具结果、工具 schemas 和 runtime-context 保留。总计一轮、两次请求，人工消息只有原输入和人工插话两条。
2. **下一轮排队。** 慢工具期间调用 followup，当前轮工具之后的第二步骤不包含排队文本；下一轮首次出现且只出现一次。完整执行序列为 `(1,1) → (1,2) → (2,1)`，没有多余轮次或入口转换。后两次请求使用修改后的插件提示词。
3. **停止与显式恢复。** 同时排入 steer、followup 和插件 inject 后取消，两个队列清空，慢工具 signal 中止；晚释放 gate 不增加请求。idle 下 inject 不唤醒，随后取消移除它。只有再次显式 followup 才进入第二轮，且被取消的输入从未进入后续模型消息。轮次结束状态分别为 aborted、completed。

插件测试来源为 `dsh-unlimit/steering-fixture`，仅用于检查官方队列保持调用方 source，不冒充生产插件生成的新业务入口。实际 `DesktopRuntime` 的系统提示词和官方 runtime-context 同时接受检查，不得变成人工 `source.kind:'user'`。

## 消息与持久化证据

每次假 LLM 调用记录完整 messages、tool schemas、模型配置、request/header、当前 turn/step 和日志 cursor。所有场景等待官方 `whenIdle` 后 flush 并读取临时 JSONL，要求读回事件与内存提交事件完全一致。

随后按每次请求 cursor 从 JSONL 取前缀，用实际官方 `Session.create(...).deriveMessages()` 重建并与该次完整模型 messages 深比较；同时比较 request/header。覆盖总计 7 次请求、3 个独立临时会话。只核对摘要或文本片段不能替代这些完整比对。

测试将网络 socket、监听、datagram、fetch 和 child_process 入口设为拒绝，并断言未尝试调用。临时数据只含合成输入、提示词和工具结果；测试不读取真实 profile、用户会话、附件或密钥，不连接运行中桌面。清理使用官方 fiber.dispose / ctx.fiber.dispose，删除本测试创建的临时根。

## 检查命令与结果

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
--test tests/steering-host.test.mjs
```

本次结果：**3 tests / 3 pass / 0 fail / 0 skip**。每场景 12 个官方入口摘要一致；JSONL 完整消息重建分别为 2、3、2 次请求。

未设置 `DSH_UNLIMIT_RUNTIME` 时明确跳过三个官方验收测试，不把跳过算作通过。仍未验证实际桌面 composer 按钮/快捷键、UI 提交到官方控制器的传输链路及渲染显示；这些需要另行实际桌面验收，隔离通过不能宣称用户设备已验证。
