# 子代理来源回退

目标为桌面 `0.2.1-rc.2`，接口仍是 `sessions.prepare / sessions.rewind`。普通会话保持原来的整轮、一步及显式 `atSeq` 行为。选中子代理时，默认通过官方会话检查接口定位其创建来源；可显式选择有记录的最近接纳输入。读回不直接读取会话存储文件，不改变旧事件，不用时间接近、正文相似或父会话最新输入猜切点。

## 来源定位

每层同时核对：

- 子会话 header 的 `origin: subagent`、`parentSession` 和 `createdAt`。
- 子会话自有事件中唯一的 `subagent/descriptor`，版本为 3，模式与父记录一致。
- 父会话自有事件中唯一的 `subagent/catalog`，版本为 0，`childId`、`childCreatedAt` 与所选子会话完全一致。继承事件前缀中的同名记录不能作为父自身创建事实。
- catalog 位于一个尚未结束的父 turn/step 内。脱离执行轮次创建的子代理没有可证明的对应人工切点，操作拒绝。

直接子代理已有多轮，仍可按其首次创建来源定位；这不表示支持最近一次激活的来源。嵌套代理还要求中间祖先的 catalog 位于该祖先第一个自有 turn，且在此前只接纳过最初的一条 `source.kind:user` 输入。规则与运行时上下文消息不作为任务输入；后续人工、转发、调度或未知来源输入使因果关系不再明确，操作拒绝。重复 catalog、身份不匹配、descriptor 不一致、循环、归档祖先及缺少完整事件均拒绝，不创建新分支。

到达普通根会话后，catalog 所在轮次内必须存在实际人工输入；调度或自动继续轮次不能借用更早轮次的人工输入。整轮回退移除这个人工轮次及其后所有事件；一步回退到创建所在步骤之前的已完成步骤，必要时退到人工轮次开始。根会话后来的其他轮次也位于切点之后，会被移除。被移除的第一条人工输入作为草稿；不把子代理任务或内部通知冒充人工草稿。子代理请求不能携带显式 `atSeq`，以免把子会话序号当成根会话序号；精确序号操作须明确选中根会话。

结果的 `sessionId` 为实际回退根会话，另返回：

```js
mapping: {
  requestedSessionId,
  targetSessionId,
  basis: "creation",
  links: [{
    childSessionId, parentSessionId, catalogSeq,
    childCreatedAt, turnStartSeq, stepStartSeq
  }]
}
```

绑定继承、附件授权、归档、取消均使用实际根会话。每次操作锁住选中会话及已解析的祖先，同一谱系的并发操作返回 `CONFLICT`，避免创建多个竞争分支；失败和完成都会释放锁。独立 fork 不因 `parentSession` 字段被当作 subagent 继续上溯。

## 最近接纳输入与新关联记录

`sessions.prepare / sessions.rewind` 新增 `childOrigin: "creation" | "latest"`，省略时仍为 `creation`；普通根会话不使用该选项。`latest` 指所选子代理历史上最近接纳的实质输入，含仍在排队及后来被取消的接纳记录，不等同于“当前激活”。同一个 ID 的 inbox 接纳和模型消费是两种表示，合并为一条输入；重复接纳、重复消费或来源冲突拒绝。

桌面 `0.2.1-rc.2` 的标准 `send_message` 运行时返回 `value.messageId`，但持久 `tool/result` 只保留展示内容，不能据旧日志反推这条关联。插件挂载后，通过官方 `tools/result` 观察成功投递，仅在运行控制已启用且总开关开启时记录；关闭后停止新记录，既有审计记录保留。记录发生在模型工具调用路径，不增加自动发送。

记录前核对实际活动父/子代理对象、直接父子关系、稳定创建时间、唯一父 `tool/call` 及其 turn/step，以及子日志中的准确消息 ID 和 `agent-message / relay / senderSessionId` 来源。然后使用官方 `appendPluginRecord` 写入父日志的 `plugin:dsh-unlimit/child-input`，格式如下：

```js
const record = {
  version: 1,
  parentSessionId,
  parentCreatedAt,
  childSessionId,
  childCreatedAt,
  messageId,
  callId,
  callSeq,
  turnStartSeq,
  stepStartSeq,
};
```

这是插件新增的 `ignorable` 元数据，不是宿主原有历史关联，不进入模型消息，不包含消息正文或凭据。重复工具通知不重复写入；写入失败交由官方观察器报告，读回缺记录时拒绝。卸载/服务退出撤销监听；重连重新验证官方模块入口摘要。

读回除创建身份链外，还要求父自身唯一的上述记录与实际 `send_message` 调用参数、调用 ID、turn/step 一致；对应 `tool/result` 必须成功，且 `message.toolCallId`、`message.source.callId`、`sourceEventSeqs` 精确连回调用。继承前缀、版本未知、未完成结果、失败结果或记录冲突均不能定位。根切点改为该父调用所在的轮次或步骤，保留既有归档、取消、附件和草稿规则。

嵌套链在每层下游调用之前，选择该祖先已消费的最近实质输入；下游调用以后才收到的消息、尚未消费的排队消息不能替代该因果输入。记录的 relay 可逐层上溯；唯一初始人工型子任务仍可依创建来源上溯，允许没有新增实质输入的自动继续轮次；默认 `creation` 的首个自有 turn 限制保持原样。任何直接人工插话、调度、其他未记录来源均拒绝，不退回较早创建轮次。

结果 `mapping.requestedOrigin` 回显选择。只使用创建链时 `basis: "creation"`；包含输入关联链时为 `basis: "recorded-input"`。每条 link 亦返回自己的 basis，输入链携带 `messageId / callId / callSeq / recordSeq / turnStartSeq / stepStartSeq`。UI 保留“创建来源”默认值，新增“最近接纳输入 · 需有来源记录”；分支创建后锁定两个选择器，结果说明采用的依据及根会话切点。

## PTC 内直接发送的来源

完整 PTC 模式通过 `run_code` 的 SDK 直接调用 `send_message` 时，外层 `tool/call` 只记录程序调用；每次子调用另有 `tool/ptc-dispatch-start` 和 `tool/ptc-dispatch`。本插件在子工具的同步 `tools/result` 观察器中取得成功结果的 `value.messageId`，以子调用 ID 和实际子会话 relay 输入关联。此时 settled 日志尚未追加，不能提前要求它存在，也不能从显示文案或程序返回值猜消息 ID。

沿用父子身份、开关和来源验证，新增版本 2 记录：基础字段相同，`callId/callSeq` 指子调用 ID 和 dispatch-start 序号，另有 `rootCallId/rootCallSeq` 指唯一外层 `run_code` 调用。只接纳直接 SDK 子调用：真实执行含父 token，start 的 `parentCallId` 和 `rootCallId` 均等于外层调用 ID，start 的名称为 `send_message`、参数目标为准确子会话。外层调用、start 和观察时点必须属于同一开放 turn/step。不解析调用 ID 的字符串形式或 Symbol 名称，不支持缺少证据的更深执行父链。

读取版本 2 记录时，另核验唯一后续 settled：子调用、根调用、直接父调用、工具名及完整参数与 start 一致，`isError:false` 且无 error，仍在同一 turn/step。随后必须存在对应外层完成的 `tool/result`，其消息来源、turn/step 和 `sourceEventSeqs` 连回外层调用。子 send 已最终成功但外层程序后来失败，仍可定位已发生的投递；子 send 自身被取消或执行后策略拒绝，没有可靠成功结果时不能补造来源。缺少 settled 或外层完成结果时拒绝定位。

同一程序向同一子代理发送多次相同文本，各自记录不同 `callId/messageId`；一个子调用不得归属多个消息。settled 日志可以交错，以 ID 关联而不靠相邻位置。最近接纳输入仍由子日志的准确消息 ID 选择。输入链结果在原字段上增加 `rootCallId/rootCallSeq/dispatchSeq`，切点依旧是父会话相应整轮或步骤，不声称只撤回程序中的某一行。原版本 1 记录和创建来源默认行为保持兼容。

## 新分支的待处理输入

官方 fork 保留精确事件前缀，其中可能包含被撤回人工轮次的早先 `inbox/enqueue`。仅检查模型消息不够：继承队列如果未清理，用户下一次发送时旧输入可能再次入场。

现在创建或 fork 后，必须取得对应官方 Agent，调用公开 `cancel({kind:"user"})`，等待 `whenIdle()`，再核对不在运行且 nextTurn/nextStep 均为空。成功证据返回 `newSessionStop: {requested, settledIds, pendingIds}`。只有此阶段通过后，才继承工作区绑定、归档并停止原会话与子代理。清理失败返回 `REWIND_PARTIAL`、`failedAt: settle-new`、已创建的 `newSessionId` 和观察结果；此时不归档原会话，也不自动恢复或发送草稿。

这不会删除历史 journal 中的旧入队记录。官方取消会留下正常的出队事件，旧文本不得再成为新分支的人工消息或实际模型请求。原始审计记录与当前可发送内容是两个不同层面。

## 验证与剩余差距

PTC 的同步录制、已投递后外层失败、同文多次发送及 settled 交错、缺失/重复/错误身份与结果拒绝见 `tests/child-origins.test.mjs`。完整官方 PTC 预设验收为 [probe-ptc-child-rewind.mjs](../scripts/probe-ptc-child-rewind.mjs)：真实 AgentLoop、子代理 API、PTC 后端与会话持久化，模型传输为合成。两次 run_code、三次实际 send_message，分别验证同目标同文两次投递，以及投递成功后程序抛错；latest 精确定位后执行实际 fork、归档与取消，十次官方 reader/物理 JSONL 读回一致。两个后端进程及临时根已清理。[结构化证据](evidence/ptc-child-rewind-acceptance.json)绑定源码摘要；不代表真实桌面、模型联网或任意 PTC 嵌套链已验收。

`tests/sessions.test.mjs` 验证直接/嵌套创建来源、较晚人工轮次、turn/step 切点、身份与继承边界、后续输入歧义、祖先并发、清理失败和界面结果表达。官方 catalog 验证见 `tests/sessions-host.test.mjs`；四种官方协议的回退后编辑重发、JSONL、拒绝与取消证据见 [回退协议合同](rewind-protocol-contract.md)。

官方再次激活没有统一的持久父轮次关联。新增记录覆盖记录器有效期间的成功标准 `send_message`，以及具有完整根调用和 dispatch 记录的 PTC 直接 SDK 发送。未记录的旧历史、API 直接投递、更深 PTC 执行父链及来源不明的人工/调度插话仍不能推断。冷恢复需要本次成功投递留下新记录，不能由“已恢复”本身反推出父轮次。PTC 子输入映射不代表 PTC 待办恢复已支持，待办限制仍见 [会话任务合同](session-attachments-contract.md#原生-todo-语义)；外部任务复原仍缺；未执行真实安装、桌面输入框或导航验收。
