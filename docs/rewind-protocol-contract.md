# 回退后编辑与显式重发的官方协议隔离验收

目标宿主为 **0.2.1-rc.2**。入口是 `tests/rewind-protocols-host.test.mjs`，fixture 在 `tests/helpers/rewind-protocol-fixture.mjs`。没有显式提供 `DSH_UNLIMIT_RUNTIME` 时，测试明确跳过，不自动发现当前用户资料。

```sh
DSH_UNLIMIT_RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  --test tests/rewind-protocols-host.test.mjs
```

每个协议使用独立临时目录与原创合成内容，装载实际官方 `SessionController`、fork seed、`Session`、`AgentLoop`、workspace registry、JSON storage 及 JSONL persistence。官方模块入口先与发行清单 `desktop-runtime.json` 的 SHA-256 核对；核对范围包含会话 fork 入口与生成实际请求 JSON 的三个 pi-ai lazy SDK。入口完整性核对不是传递依赖的全量审计。

| 协议                     | 实际执行边界                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| DeepSeek native messages | 官方 `DeepSeekAdapter.generate` 与官方请求序列化；身份、认证和文件回调采用合成替身，避免默认包装器写匿名身份或访问用户文件索引 |
| OpenAI Chat Completions  | 官方 pi-ai adapter、`openai-completions` lazy SDK 与 SSE parser                                                                |
| OpenAI Responses         | 官方 pi-ai adapter、`openai-responses` lazy SDK 与 SSE parser                                                                  |
| Anthropic Messages       | 官方 pi-ai adapter、`anthropic-messages` lazy SDK 与 SSE parser                                                                |

2026-10-20 使用上述 Node 24.21.0 与官方运行时，四协议测试 **4 通过、0 失败、0 跳过**；每个协议完成 5 次合成 fetch（首轮、第二轮、编辑后重发、永久错误、用户取消），共 20 次，请求时 Session projection 的完整相等断言均通过。每个 fixture 的 28 个官方模块入口均匹配清单。

四协议均执行以下同一合同：

1. 通过官方 `followup()` 实际运行两个人工输入轮次，并完成两次合成 fetch。不是直接追加 `turn/start` 等事件模拟已完成对话。
2. `DesktopSessions.prepare()` 与 `rewind()` 回退第二轮。新会话必须是官方 fork 的精确前缀，保留 parent identity、`session/end-seed` 与插件工作区绑定；原会话归档且历史不变。JSONL 与 workspace JSON 均实际读取确认。
3. 回退后保持 idle。原草稿只作为 `pending-client` 返回；新会话 inbox 不得残留被撤回输入，prepare/rewind 不得触发 fetch。
4. 模拟用户编辑恢复的多行草稿，然后明确调用新分支 `followup()`。实际官方序列化请求必须包含第一轮输入、编辑后的完整多行输入，以及本次当前系统提示词；不得包含被撤回的原始多行输入或内部 journal marker。当前系统提示词必须出现在原生 system/developer/instructions 位置，不得混入 user。
5. 每次调用官方 adapter 时，断言完整 `options.messages` 与当时 `agent.session.deriveMessages()` 深度相等；当前系统提示词在请求发生时已经作为正式 `system/message` 记入事件。新分支发送后再次读取官方 JSONL，原历史仍保持原样。
6. 在新分支注入一次 HTTP 400 永久错误和一次用户取消。官方 `turn/end` 必须分别记录 `error` 与 `aborted`，不得宣称 completed，也不得增加成功 assistant message；持久化后再次读取确认。

官方 fork 的精确前缀可能保留第二轮 `inbox` 入队记录，即使该轮的 `user/message` 已被撤回。新分支必须先通过官方 `cancel()` 写出队记录并确认 idle 与空 inbox，才允许返回草稿。测试要求撤回内容不进入新分支的 `user/message`、派生模型消息或 HTTP 请求；不通过删改原始 journal 隐藏历史。

测试装载后限制文件 API：只允许读取显式 runtime 和临时 fixture，写入限临时 fixture；真实 profile 路径会被拒绝。测试全局拦截 fetch，只接受 `rewind-protocols.invalid` 的内存 SSE 回包；socket connect/listen、datagram、child_process 和文件上传均禁止，任何尝试使测试失败。凭据、环境、附件、文件接口采用明确合成替身，不读取真实 profile，不安装或修改当前桌面，不发送真实消息。

这项证据验证官方会话、协议序列化与持久化之间的连接。传输与模型输出是合成的；它不证明真实供应商接受请求、真实模型质量、工具执行、附件路径或桌面输入框桥接已通过。输入框内的实际草稿恢复与点击发送仍需独立的桌面验收。当前合同集中于 turn 回退；同一轮多个 step 的协议重发未列为已验证。
