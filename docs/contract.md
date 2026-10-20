# 第一版交付合同

目标：桌面端能力逐项对齐，独立编写实现，重新设计 UI；不接入其他插件作者的服务或发行渠道。当前验收设备为 macOS arm64，安装的宿主版本为 0.2.1-rc.2。Windows 桌面行为保留在对照清单中，未经实机验证不能标为通过。

功能一致指用户可完成同一类操作、获得同类结果，不要求继承旧目录结构、内部操作名称、缺陷、加密提示词或品牌素材。宿主已修复的问题需要行为验证，不通过重新制造问题来复刻补丁数量。

实现分为：

- `src/core/`：提示词、规则、技能和本地数据；不依赖宿主。
- `src/host/`：桌面识别、宿主服务适配、生命周期、会话与工具。
- `src/server/`：同源 API 和静态资源传输。
- `web/`：独立设计的桌面工作台。
- `scripts/`：检查、构建、隔离预览、离线打包。
- `tests/`：合成数据测试；真实宿主接口检查与普通测试分别记录。

API 使用 `POST /dsh-unlimit/api`，请求为 `{ "action": "...", "payload": {} }`。成功为 `{ "ok": true, "data": ... }`；失败为 `{ "ok": false, "error": { "code": "...", "message": "..." } }`。没有对应能力时必须明确拒绝，不能返回空成功。

## 数据层接口

`WorkspaceStore(databasePath)` 仅打开调用方指定的本地数据库。`dispatch(action, payload)` 同步返回 JSON 数据；`close()` 关闭数据库。标识由数据层生成 UUID；所有演练数据都以 `workspaceId` 隔离。

| action                                                             | 输入                                                                                              | 返回                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| settings.get                                                       | 无                                                                                                | `{ revision, value }`                                 |
| settings.save                                                      | `{ revision, value }`                                                                             | `{ revision, value }`，冲突拒绝                       |
| rules.list                                                         | 无                                                                                                | `{ items, activeId }`                                 |
| rules.save                                                         | `{ id?, name, content, model? }`                                                                  | `{ item }`                                            |
| rules.delete / rules.activate                                      | `{ id }`                                                                                          | `{ deleted }` / `{ activeId }`                        |
| rules.reset                                                        | 无                                                                                                | `{ activeId: null }`                                  |
| workspaces.list                                                    | 无                                                                                                | `{ items, activeId }`                                 |
| workspaces.save                                                    | `{ id?, name, scope?, authorization? }`                                                           | `{ item }`                                            |
| workspaces.activate                                                | `{ id }`                                                                                          | `{ activeId }`                                        |
| assets.list                                                        | `{ workspaceId, query? }`                                                                         | `{ items }`                                           |
| assets.save                                                        | `{ workspaceId, id?, name, address, type?, tags?, notes? }`                                       | `{ item }`                                            |
| assets.link                                                        | `{ workspaceId, from, to, relation }`                                                             | `{ item }`                                            |
| assets.assess / assets.test                                        | `{ workspaceId, id, ... }`                                                                        | `{ item }`                                            |
| assets.graph / assets.timeline                                     | `{ workspaceId }`                                                                                 | `{ nodes, edges }` / `{ items }`                      |
| findings.list / findings.save                                      | `{ workspaceId, query? }` / `{ workspaceId, id?, title, assetId?, severity, status?, evidence? }` | `{ items }` / `{ item }`                              |
| records.list / records.save / records.delete                       | `{ workspaceId, kind, id?, data? }`                                                               | `{ items }` / `{ item }` / `{ deleted }`              |
| knowledge.list / knowledge.save / knowledge.delete / knowledge.use | `{ query?, id?, title?, content?, tags?, kind? }`                                                 | `{ items }` / `{ item }` / `{ deleted }` / `{ item }` |
| roles.list / roles.save / roles.reset                              | `{ workspaceId, role?, content? }`                                                                | `{ items }`                                           |
| report.build                                                       | `{ workspaceId }`                                                                                 | `{ markdown, stats }`                                 |

记录类型：`credential`、`access`、`webshell`、`tunnel`、`screenshot`、`http`、`chain`、`file`、`score-point`、`score-hit`、`stage`、`session`。这些是本地证据记录，写入记录不执行远程操作。

设置默认值：

```json
{
  "enabled": false,
  "prompt": "",
  "promptMode": "replace",
  "workspacePolicy": "fallback",
  "workspaceFiles": [],
  "fullAccess": true,
  "autoApprove": true,
  "hooksDeny": false,
  "maxSubagents": 16,
  "maxDepth": 10,
  "readLimit": 1048576,
  "autoReapply": true,
  "retryLimit": 0,
  "ownServers": []
}
```

## 宿主层接口

`status` 返回包版本、宿主版本、平台、启用状态、能力列表、当前设置、会话列表和离线更新模式。`control.apply` / `control.revert` 启用与撤销本插件拥有的运行时注册。`sessions.rewind` 使用官方 fork 路径保留原会话。`skills.*` 仅处理本插件明确选定的技能根目录。`toolkit.*` 管理用户指定的本地工具目录与受控进程。

## 发布边界

公开 GitHub 只包含独立源码、合成测试、文档和工作流。宿主程序、用户 profile、真实会话、数据库、密钥、工具库和本机诊断原始路径不提交。检查结果必须区分实现、合成测试、真实宿主接口、桌面端交互验收。

## 已实现的数据扩展

资产可保存多个名称、域名、端口、服务、指纹与来源。同一工作区内按地址和类型合并；服务按协议与端口合并，保留稳定标识。`assets.list` 接受 `scope / segment / status / priority / type / port / service / source / fingerprint / tags / view` 条件，返回 `items` 与匹配 `total`。`assets.timeline` 还返回按日的首次发现和观察次数。`assets.import` 接受 `{ workspaceId, items }`，返回逐项结果及 `added / merged / rejected`，存储故障回滚整批已接受记录。

计分记录使用 `pointId`，可关联 `assetId` 与 `serviceId`，或 `port / protocol`；按“计分点＋资产＋服务端点”去重，保留每条证据。`awarded: false` 仅留证。得分点可用 `stageId` 关联本项目阶段。`scoreTotal` 是计分点基准和，并非总分上限；`scoreEarned`、`scoreUniqueHits`、`scoreByStage` 分别表示累计分、唯一有效命中和阶段累计。

知识列表支持 `kind / tags / verified` 筛选，标签为全部匹配。验证标志需要对应当前正文的证据内容；修改正文或证据会撤回旧验证。`knowledge.use` 累计复用次数。

`flow.status / configure / assign / acquire / release` 管理已绑定会话的明确角色与本地执行槽，槽位默认3、允许1至10。这里的槽登记不会启动任务或替代宿主子代理限制；活动槽不持久化。角色正文按绑定会话注入，普通未分配会话不带演练角色稿。

`workspacePolicy` 仅控制本插件主动选择的规则：`strict` 忽略所选规则，`fallback` 在规则库和自写正文为空时使用所选规则，`always` 合并所选规则。原生宿主运行上下文仍保留；不能把这个设置解释为移除所有宿主工作区基线。
