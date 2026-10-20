# 原生工作区指令策略合同

目标宿主为 `0.2.1-rc.2`。此适配器处理官方已经接纳及本步骤新增的原生工作区指令；实际模型请求必须能从同一时点的官方 JSONL 完整重建。所选规则文件的预览和系统提示词组合仍是另外的入口，不能代替原生来源控制。

## 来源、策略与时点

- 仅处理 `role:user`、`source.kind:agent-instructions`、`source.form:instructions` 同时匹配的消息。人工复制的文字、其他插件、其他 form 与其他角色不按文字内容猜测删除。
- `strict` 在控制启用时抑制原生指令；`always` 保留。`fallback` 复用提示词的实际规则选择顺序：模型专用规则优先，其次活动规则；所选规则和保存正文都只有空白时保留原生指令，否则抑制。控制禁用时恢复保留行为。
- 策略在各会话的 `agent/pre-step` 读取。外层监听等待下游官方 producer 完成后，只从 `enter` 决策过滤新增的明确来源消息；`reject` 原对象原样返回。恢复保留策略的历史发生在 producer 判断基线是否可见之前。
- 既有历史的隐藏发生于官方 `agent/request`，在真实 `step/start` 之后、请求消息构建之前。使用对应步骤保存的策略，不因另一个会话同时准备请求改变本会话的选择。拒绝、取消和在途卸载不会产生迟到的隐藏操作。

## 可重建历史与恢复所有权

隐藏通过官方 `Session.append` 追加空内容的内建 `developer/message`，替换一个当前可见的原生事件。原始事件及正文保留在原始日志中；不包装 `Session.append`，不注册卸载后仍必需的自定义模型消息 projection，也不改发送副本。

替换消息的来源为 `dsh-unlimit/native-instructions`，带 `format:1`、`originalSeq` 与原始消息 JSON 的 SHA-256 `originalDigest`。`surfaceOp` 只替换对应的单节点，`sourceEventSeqs` 引用该原始事件。使用官方已有的空 developer 消息派生规则，因此不需要本插件参与日志重放。步骤归属必须是真正已打开的步骤；只通过内存 `Session.append` 不能证明 JSONL 合法。

隔离测试曾检出在 `pre-step` 追加带未来步骤号的替换事件这一缺陷：内存会话接纳成功，但物理 JSONL 回读报 `developer/message does not match an open turn and step`。实现已将隐藏推迟到真实步骤打开后的 `agent/request`。修复后验收逐一回读物理日志并重建请求，不能只用内存断言代替这项检查。

切回保留策略、关闭控制、卸载及代理生命周期清理时，以追加恢复事件的方式恢复原始 `user/message` 数据，并同时引用当前替换节点和原始事件。只恢复仍在 surface 上、元数据与摘要完整且属于本项目的节点。后续第三方替换或压缩取得所有权时，不追溯复活其隐藏内容。冲突会报告错误并保留待恢复状态，不猜测内容。代理的正常清理必须在官方持久句柄关闭之前完成恢复。

手动还原只向官方目录中当前已加载的 Session 追加事件，不向持久句柄已经关闭的旧对象追加。可信的新适配器即使从未 `apply()`，也可通过 `revert()` 恢复已加载分支合法继承的本项目 marker。清理失败而已卸载的会话保留待恢复状态，能力报告不可用并拒绝重新启用；需先重新加载同一会话 id，再重试还原。不主动打开未加载会话。

本策略不停止官方 producer 发现或读取文件，也不修改其全局预算、缓存或 Loader 配置。被隐藏的基线可能让 producer 重新发现文件；验收要求这种刷新和重复基线不产生额外模型循环、不跨会话污染。

## 官方隔离验收

执行入口为 `tests/native-instructions-host.test.mjs`，夹具为 `tests/helpers/native-instructions-fixture.mjs`。必须显式设置 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES`，前者选择官方运行时，后者选择公开归档目录；任一变量缺失时明确跳过，不把跳过算作通过。变量已设置但目录、归档缺失或摘要不符时失败，不静默查找其他来源。复验命令：

```sh
DSH_UNLIMIT_RUNTIME=/absolute/path/to/official-runtime \
DSH_UNLIMIT_OFFICIAL_PACKAGES=/absolute/path/to/public-archives \
node --test tests/native-instructions-host.test.mjs
```

2026-10-21 的隔离运行证据在 [native-instructions-acceptance.json](evidence/native-instructions-acceptance.json)。

producer 仅来自本地缓存的公开归档 `dsh-agent-instructions-0.2.1-rc.2.tgz`。归档 SRI 为 `sha512-a1VQsocz34VvkwYMNc/zolMXrLXWIClhZ62kb3pi8hYd/8MSgjuE09YcoqX6ZmU8i4tmaroC9W1PdUEIksSgiQ==`，入口 SHA-256 为 `4011f6e4c08228601bd4348ac78e322913142264f6e491ffdf9dcfda97393988`，并与桌面发行库存核对。夹具不读取或执行被修改的已安装 producer 入口。公开归档和官方实现不随安装包分发。

在任何官方 import 前，夹具建立临时 `HOME`、`DSH_HOME`、`DSH_AGENTS_HOME`。Cordis、Session、AgentLoop、工作目录和 JSONL 使用库存摘要匹配的真实官方模块；临时文件系统和无网络 LLM 流为原创合成替身。加载钩子核验每个执行的官方文件，文件守卫只允许临时合成数据与只读官方运行时，网络、fetch、socket、监听和子进程入口均拒绝调用。

本次通过的场景包括：

| 场景                                       | 验证结果                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实 producer 首轮基线及成功 read 工具刷新 | 项目和两个全局合成 AGENTS 进入官方日志与请求；首轮只有一次模型调用，工具轮只有工具请求和完成请求                                            |
| strict 处理旧历史、新基线和工具刷新        | 旧日志前缀逐项保留；请求无准确匹配的原生来源；其他来源和 form 保留；producer 重发现不增加模型循环                                           |
| always、空白 fallback 与禁用恢复           | 原始 data 完整恢复；模型专用、活动规则及保存正文使用同一有效正文判断                                                                        |
| 两会话同时使用不同模型规则                 | 同一共享 producer 下，一会话抑制、另一会话保留；反转有效规则后结果各自变化                                                                  |
| 下游拒绝与取消                             | 拒绝保持原对象，官方轮次为 blocked 且无模型请求；取消传至官方模型循环并记录 aborted                                                         |
| 请求准备中卸载                             | 已恢复历史保持可见，等待中的回调不再写入隐藏事件                                                                                            |
| 真实 AgentHandle.dispose                   | 本项目节点在持久句柄关闭前恢复；关闭后物理 JSONL 回读及官方 Session 重建通过                                                                |
| 后续第三方替换与卸载                       | 后续所有者节点保留，原始隐藏内容不被复活；正常卸载后 producer 可继续工作                                                                    |
| 公开 DesktopRuntime 接入                   | `DesktopRuntime.apply()` 注册原生策略并显示真实提示词组合效果；`revert()` 恢复历史，后续请求保留原生指令                                    |
| 未观察分支与新适配器还原                   | 官方 `buildForkSeed` 和 `AgentRegistry.create` 创建带继承 marker 的已加载分支；未进入 pre-step，未 apply 的新适配器仍可还原并回读物理 JSONL |
| 完整请求与物理日志一致                     | 6 个临时会话，28 份请求的完整 messages 和 request header 均等于其 JSONL 前缀的官方派生结果                                                  |

## 验收边界

这些结果证明干净官方运行时中的合成隔离路径，不代表真实桌面已安装、重载或真实会话已接管。真实入口与库存不匹配时能力应拒绝启用，不因存在另一份干净归档而执行受修改入口。

本次不主动打开未加载的历史或崩溃遗留会话；异常终止期间保留在其日志中的替换记录仍是恢复边界。已有内建替换可独立重放，不能由此声称已经验证崩溃后自动恢复。真实 UI 操作、真实用户工作区与跨版本兼容也未在此隔离验收中执行。
