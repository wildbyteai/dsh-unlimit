# 子代理创建来源回退

目标为桌面 `0.2.1-rc.2`，接口仍是 `sessions.prepare / sessions.rewind`。普通会话保持原来的整轮、一步及显式 `atSeq` 行为。选中子代理时，通过官方会话检查接口定位其创建来源；不读取会话存储文件，不改变旧日志，不用时间接近或父会话最新输入猜切点。

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

## 新分支的待处理输入

官方 fork 保留精确事件前缀，其中可能包含被撤回人工轮次的早先 `inbox/enqueue`。仅检查模型消息不够：继承队列如果未清理，用户下一次发送时旧输入可能再次入场。

现在创建或 fork 后，必须取得对应官方 Agent，调用公开 `cancel({kind:"user"})`，等待 `whenIdle()`，再核对不在运行且 nextTurn/nextStep 均为空。成功证据返回 `newSessionStop: {requested, settledIds, pendingIds}`。只有此阶段通过后，才继承工作区绑定、归档并停止原会话与子代理。清理失败返回 `REWIND_PARTIAL`、`failedAt: settle-new`、已创建的 `newSessionId` 和观察结果；此时不归档原会话，也不自动恢复或发送草稿。

这不会删除历史 journal 中的旧入队记录。官方取消会留下正常的出队事件，旧文本不得再成为新分支的人工消息或实际模型请求。原始审计记录与当前可发送内容是两个不同层面。

## 验证与剩余差距

`tests/sessions.test.mjs` 验证直接/嵌套创建来源、较晚人工轮次、turn/step 切点、身份与继承边界、后续输入歧义、祖先并发、清理失败和界面结果表达。官方 catalog 验证见 `tests/sessions-host.test.mjs`；四种官方协议的回退后编辑重发、JSONL、拒绝与取消证据见 [回退协议合同](rewind-protocol-contract.md)。

官方再次激活没有统一的持久父轮次关联。API 直接给子代理发消息、冷恢复以及中间祖先被插话等情形不能靠首次创建记录推出最新任务来源，这些路径仍是差距。没有修改原生 todo 状态，未实现外部任务复原；未执行真实安装、桌面输入框或导航验收。
