# 会话回退附件与任务投影合同

目标：DSH desktop `0.2.1-rc.2`。本合同描述插件已实现接口及隔离验证，不代表已安装或实际桌面验收。官方模块由安装包只读导入，发布包不包含官方实现；测试不读取 profile、不连接桌面、不发模型请求。

## 回退前置检查与授权批次

`sessions.prepare` / `sessions.rewind` 原有字段保持不变。若被移除的第一条人工 `user/message` 包含图片或文件，调用方必须先获取客户端 bridge 的 `probe.supports.attachments === true`，并传 `draftBridgeSupports: {attachments: true}`。原有 `draftBridgeReady: true` 仍为 rewind 必需。

创建新分支后先清理官方继承的待处理队列；来源映射到根会话时，附件与草稿取自该根会话实际被移除的人工消息。清理失败不会进入附件绑定或客户端恢复。详见 [子代理回退合同](child-rewind-contract.md)，四协议显式重发证据见 [回退协议合同](rewind-protocol-contract.md)。

仅接受原事件中 `source.kind === 'user'` 且 `surfaceOp === 'append'` 的内容。文本按原文本块顺序合并；图片和文件按原附件块顺序恢复。文本中的路径或 `@file` 引用保持文本，绝不据此打开本机文件。未知内容块、缺官方读取 API、超过当前官方图片准入限制，均在 fork/归档前拒绝。

含附件的结果增加：

```js
attachmentBatch: {
  token, expiresAt, // 随机 256-bit token，5 分钟过期，仅内存保存
  items: [{index, partIndex, type: 'image' | 'file', name, bytes, mediaType}]
}
```

prepare 创建的批次不可读；只有该次 rewind 完整成功、绑定到返回的 `newSessionId` 后才允许读取。prepare 单独产生的令牌按期清理。回退部分失败会撤销该次批次，错误不回显令牌或附件内容。宿主卸载必须调用 `DesktopSessions.close()`，中止读取并清理定时器及批次。

## 固定读取接口

所有请求继续使用同源 `POST /dsh-unlimit/api`，JSON `{action, payload}`，头 `Content-Type: application/json` 和 `X-DSH-Unlimit: 1`。令牌及字节只在 POST 正文或响应中传递，不放入 URL。

- `sessions.attachment({token, index, newSessionId})` 对应 `DesktopSessions.attachment(payload)`。返回 `{item:{index,type,name,bytes,mediaType,contentBase64}}`。
- `sessions.releaseAttachments({token})` 对应 `DesktopSessions.releaseAttachments(payload)`。返回 `{released:boolean}`，重复释放安全。

读取拒绝 `ref`、`path`、`sourceSession` 等额外输入。宿主使用批次保存的原始 ref，通过官方 `attachments.readImage(ref, signal)` / `readFileStream(ref, signal)` 读取，并再次检查原人工事件及该固定索引的 type/ref、目标会话、期限和取消状态。图片返回 ref 必须一致；字节必须与 ref.bytes 完全一致。文件逐块累计，超出原字节数立即拒绝；只按一个附件返回。官方本地 provider 本身还核对 SHA256、图片类型和尺寸。

官方文件接口没有通用文件大小准入上限。本 JSON 载体按 `min(node:buffer.constants.MAX_LENGTH, floor(MAX_STRING_LENGTH / 4) * 3)` 限定单项原始字节（Node 24 常量），未额外设置较小业务阈值。此实现仍会把单项内容聚合为 base64，内存消耗随该项大小增加；不是流式下载协议。图片沿用当前官方 imageLimits。

## 客户端两阶段恢复

bridge 仅接受精确 `event.origin === location.origin`、`event.source === 当前可见 iframe.contentWindow`，拒绝 opaque `null` origin。固定 operation 仍只有 `probe/restore/cancel`，不接受任意 action。关闭面板、iframe 重载、dispose、请求超时及调用方 `expiresAt` 都会阻止后续草稿写入。

`restore.payload` 为 `{newSessionId, draft, attachmentBatch?}`。probe 附件支持要求实际存在官方 `createDrafts`、`resolveDraftAttachments`、`releaseDraftAttachment`、`input.for`、上传状态订阅和 `fileUpload.upload`，以及浏览器 File/URL/fetch 能力。缺少这些时不能启动含附件回退。

恢复过程：

1. 使用官方 `sessions.using(newSessionId, {source:'controllerOperation', signal}, ...)` 保留精确 binding。
2. 发现目标已有文字或附件时保持原内容，不读取附件字节。
3. 按批次顺序逐个读取，核对元信息、canonical base64 和字节数，以 `new File(...)` 调用官方 `conversation.createDrafts(newSessionId, [file])`。文件由官方 FileUpload 重新上传到新 Agent，会产生新的 receipt；不接受或复用原 Agent receipt。
4. 等待新文件上传状态明确 ready；图片为本地浏览器草稿，不提前发送。上传失败、取消和超时不能声称 ready。
5. 再次检查 binding/期限，以 `requestDraftInitialization(binding, {prompt:draft,clearPreviousDraft:false})` 请求文字初始化；若用户在上传期间开始编辑，官方返回 preserved，保留该输入。
6. 使用该 binding 的 `input.for(binding.ctx).actions.addAttachments(newIds)` 加入有序附件。只在文字、全部附件及必要上传均成功后，聚合 `draftStatus` 才为 restored。
7. 最后调用官方 `uiWorkspace.openSession(newSessionId)`；它同步请求导航，没有渲染完成确认。绝不调用 submit 或 session.prompt。

失败时仅 `releaseDraftAttachment` 本操作创建且尚未加入输入的 ids（会取消其官方上传）。不清理用户已有附件，不回滚已写入文字，也不撤销已交给输入模型的完整草稿。批次在恢复结束时无论成功或失败都请求释放；如页面已断开则由宿主 TTL/close 清理。工作台因此不提供同一附件批次的重试按钮，而是保留新会话编号与各阶段状态，提示检查输入；原会话及原附件仍保留。纯文本恢复保留原有同分支重试行为。

响应保留 `draftStatus`，另有：

| 字段             | 状态                                                                      |
| ---------------- | ------------------------------------------------------------------------- |
| textStatus       | failed / restored / preserved / blocked / cancelled                       |
| attachmentStatus | not-required / pending / reading / staged / restored / failed / cancelled |
| uploadStatus     | not-required / not-requested / uploading / ready / failed / cancelled     |
| openStatus       | not-requested / failed / requested                                        |

只有附件加入失败而文字已恢复时，`textStatus: restored`、`draftStatus: partial`。导航失败可保留完整 `draftStatus: restored`，但 `ok:false`、`openStatus:failed`。导航始终 `navigationConfirmed:false`。原会话在宿主 rewind 成功阶段已经归档；客户端失败不能描述成“原会话未归档”。

## 原生 todo 语义

官方 `tool-todo` 注册的 `todos` 投影：初始 null，`todo/write` 为全量替换，`turn/start` 重置 null，其余事件保持。官方 fork 复制所选边界的事件前缀并追加原生 seed 事件，因此 turn 回退显示上一轮保留的列表；step 回退先取得保留步骤的列表。

`src/host/rewind-todos.js` 只恢复一种可核验的任务关系：任务在保留前缀投影中为 `in_progress`，在切点之后、下一次 `turn/start` 之前的后缀 todo 快照中始终存在，且最后状态为 `completed`，才在新分支改为 `pending`。匹配使用精确 `content`；重命名、删除后重建都不作关联。保留列表的其他任务、顺序与内容不变，仅在被切除后缀新增的任务不带回。无待恢复任务时沿用原生投影，不调用写入工具。官方清单只有 `content/status`，不推断跨轮或外部任务身份。

有实际恢复项时，宿主先完成新分支的取消与队列清理，再通过官方 `tools.execute({name:'todo_write', arguments:{todos}, agent:新分支Agent, callId, signal})` 写入完整列表，保留工具可见性、执行前策略、审批和执行后策略。插件不改原会话事件，不伪造模型消息或 `tool/call`、`tool/result`。写入后调用官方 `sessions.flush`，再用 `sessionPersistence.open/read` 完整读取日志；官方格式检查通过、持久事件与当前内存事件完全一致、`todos` 投影及新增 `todo/write` 均符合计划，才报告 `verified:true`，然后继续原会话归档。仅写入和 flush 成功不能证明会话可重新打开；读取失败则保留新分支、报告未确认，不归档原会话。

回执仅在有实际恢复项时包含 `todoReset:{requested:true, plannedCount, verified, resetCount}`。`resetCount` 仅在读回确认时为计划数量，否则为 0。源 Agent 已加载且当前模式不允许直接调用 `todo_write` 时，在创建分支前返回 `TODO_RESET_UNSUPPORTED`，不改变源会话。源 Agent 未加载或新分支能力与源会话不同的情况下，仍在新分支写入前再检查；此时可能已创建分支，以 `REWIND_PARTIAL` 和 `failedAt:'reset-todos'` 披露，原会话不归档。执行后策略也可能在写入已经落盘后拒绝，此时可同时出现 `verified:true` 和整体回退未完成，必须分别展示。等待工具策略期间若新分支接纳其他输入，或 adapter 关闭，该次恢复信号会取消；后续读回仍报告实际已发生的结果。

PTC 不能以空闲分支中的 `run_code` 替代上述调用：实际隔离探针虽然写入成功，但官方 reader 报 `tool/ptc-dispatch-start is outside an open turn`。0.2.1-rc.2 的公开 `tools.execute` 不创建 turn，`runMaintenance` 仅切换阶段，官方 fork 已闭合回合；当前未找到可用的独立工具回合入口。本实现没有保留该尝试，没有伪造用户输入或日志，也没有将恢复延期到下一次用户发送并声称立即完成。完整 PTC 预设的提前拒绝证据见 [ptc-rewind-acceptance.json](evidence/ptc-rewind-acceptance.json)。

2026-10-21 再次核验官方工具和控制器接口：`todo_write` 只有工具注册和投影，没有独立维护写入服务。`resolveExecution(name, agent, true)` 的第三参数表示真实 PTC 子调用，不能把它当作空闲维护授权；伪造 parent 或临时把工具改呈现为 native 都会改变现有执行边界，未采用。`SessionController` 的 create/fork/prompt/cancel/queue 接口没有独立工具回合。完整 PTC 探针复跑仍为提前拒绝，原待办、事件及物理 JSONL 不变，没有创建或归档会话、工具执行、模型请求和后端进程。本项继续列缺口；继续实现需要合法维护写入/工具回合入口，不需要安装到用户正在使用的 profile 来重复确认。

下一轮仍由原生 `turn/start` 清空 todo 投影，不注册重应用机制。以上是当前限定的会话任务恢复能力，不代表完整 SESSION-VIEW、真实桌面切换或任意外部任务系统已经验收。新增合成场景见 `tests/rewind-todos.test.mjs`；官方隔离场景见 `tests/sessions-host.test.mjs` 的限定恢复、持久读回、前后策略拒绝、PTC 限制、新输入及关闭取消场景；界面回执见 `tests/rewind-todo-ui.test.mjs`。具体执行结果以对应修订的验证记录为准。

## 可复验测试与边界

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
--test tests/sessions.test.mjs tests/sessions-host.test.mjs \
       tests/client-bridge.test.mjs tests/client-bridge-host.test.mjs
```

官方测试仅使用临时 SQLite/JSONL、合成 Session 和 1×1 PNG/文本附件。实际导入条目在导入前与 `desktop-runtime.json` 的 SHA256 清单逐项匹配，release 必须为 `0.2.1-rc.2`。客户端从原始 frontend/vendor 捕获公开 staticModules 边界，停止应用组装，然后在无 document 的独立 VM 导入未改写的官方 Session/Conversation/Workspace/FileUpload 模块。上传使用官方公开 custom transport 测试钩子接收合成 bytes，不建立网络连接；没有加载真实 profile。

测试验证：成功 fork 后原附件存储读取；批次未绑定/越权索引或目标/原事件变化拒绝；release、deadline、close 和部分回退失败的清理；真实客户端附件顺序、新 receipt、上传失败/取消、已有输入及上传期间编辑保护；原生 todo prefix 和 turn reset。仍未验证实际 Electron renderer 的 scheme origin、Worker 上传和真实导航渲染；HTTP/VM 隔离通过不能外推为实际桌面已验收。

本次关键条目的导入摘要（相对官方运行时根）：

| 路径                                                               | SHA256                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js  | a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386 |
| node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js | 82f2301c18f0e51340c1eedf8ecdfb939e873b3770a80632e438b86e82887d0e |
| node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js | 48d308ca86c9350986982e113bb775696719a958415f436ce7b977de1eace0b6 |
| node_modules/@deepseek-ai/dsh-client-file-upload/lib/client.js     | 4c09378ab7cb3dbe58253bd1fad8c4a00ebf5a93b462d96623edb7bd4e566305 |
| node_modules/@deepseek-ai/dsh-attachment-local/lib/index.js        | cd39685581b4573a453c6126f8ce73da0bf1257c378827ebb431d6d4064f7662 |
| node_modules/@deepseek-ai/dsh-session/lib/index.js                 | 2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf |
| node_modules/@deepseek-ai/dsh-tool-todo/lib/index.js               | 6baad8bf8e53647319b408cbab0c8c13c0693f65d20b779484c4436f47a6a11b |
