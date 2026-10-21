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

连接检查使用独立的 `connectionChecks.prepare/run/status/stop` 接口，不向模型工具开放；只有预览后明确确认才检查目标。精确主机、保存的派生 IP 与本地国家库共同判定本次可选地址。WebShell 使用 HTTP HEAD，隧道使用明确的 `listenHost/listenPort`，不解析备注或命令。实际回执独立存储，不覆盖手工登记状态；撤销入场、范围变化与退出停止所属连接。范围、失败和结果字段见 [连接检查合同](connection-checks-contract.md)。

`networkScope.status/import/resolve/stop` 仅供本机同源 UI：状态读取和 CSV/gzip 导入不联网，域名解析需入场与明确确认。`region.sqlite` 保存独立国家索引，私有 metadata 保存解析快照；完整 API、版本校验、来源说明及未覆盖出口见 [范围合同](network-scope-contract.md)。

凭据的字段白名单、安全读回、秘密保留/替换/清空及旧字段处理见 [credentials-contract.md](credentials-contract.md)。`records.list/save` 只返回非秘密元数据和 `secretState`，同 ID 不能变换记录类型、项目或数据域绕过投影。数据库仍为本地明文存储。

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
  "permissionDefault": "",
  "repeatReminder": "host",
  "hooksDeny": false,
  "maxSubagents": 16,
  "maxDepth": 10,
  "readLimit": 1048576,
  "autoReapply": true,
  "retryOverride": false,
  "retryLimit": 0,
  "autoContinue": false,
  "continueLimit": 3,
  "continueText": "请承接刚才因输出长度限制而未完成的内容，继续完成剩余部分，避免重复已有输出。",
  "ownServers": []
}
```

## 宿主层接口

`status` 返回包版本、宿主版本、平台、启用状态、能力列表、当前设置、会话列表和离线更新模式。`control.apply` / `control.revert` 启用与撤销本插件拥有的运行时注册。`sessions.rewind` 使用官方 fork 路径保留原会话。`skills.*` 仅处理本插件明确选定的技能根目录。`toolkit.*` 管理用户指定的本地工具目录与固定版本探测进程。

撤销使本次启用期间尚未完成的提示词组装失效：返回宿主原始组装结果，不再读取规则或追加角色正文。随后重新启用也不会恢复旧任务的注入资格。已撤销的重试刷新监听不能在异步返回后重新挂载投影，也不会通过保留在外部包装中的旧引用读取已关闭存储。此边界不撤回已经发送的请求，也不删除既有对话记录。

旧审批、沙箱及子代理限额回调也绑定于创建它们的启用期。撤销或应用失败后，即使外部保留其引用，也只调用原宿主接口，不读本插件配置；再次启用不复活旧回调。其他插件后来接管的接口不被覆盖，所有权冲突仍如实返回。沙箱原接口在计算期间触发撤销时，返回原结果，不再追加全访问模式。

同一实例的应用、还原、设置保存及工作区规则选择/策略写入按接收顺序执行，避免异步挂载与另一操作的回滚交错。失败如实返回，后续已接收操作仍可执行；带 revision 的旧配置请求仍拒绝，不自动覆盖新值。生命周期清理同样等待已接收的控制操作；它只释放注册并保留重载意图，用户主动还原则同时持久关闭启用状态。只读状态和无关工作区操作不进入此队列。自动恢复的注入回调开始前检查父、子上下文的生命周期；已销毁时不再接纳恢复，先前已经接纳的异步控制操作仍按上述顺序完成与撤销。

回退新分支先通过官方取消与空队列读回，之后才归档原会话；子代理可按可核验的创建来源定位根会话切点，最新激活来源仍未支持。谱系、并发与部分失败字段见 [子代理回退合同](child-rewind-contract.md)。`report.build` 的已有字段报告、统计兼容与凭据隐藏合同见 [工作区报告](report-contract.md)。

`status.permissionDefaults` 读回官方可选默认预设、请求值和实际生效默认；`permissionDefault` 空值跟随宿主，非空值必须属于官方 `defaultOptions`。仅影响未来全新会话，已有、seeded 和显式选择由宿主保留；不会把 `autoApprove` 转换为官方 `never`。见 [权限默认合同](permission-defaults-contract.md)。

`repeatReminder` 为 `host/off`，默认沿用宿主。关闭仅调整官方建议提醒的排除范围，不更改工具拒绝、反馈或取消。应用、保存生效和撤销都等待官方 noSave 生命周期完成。缺服务且设置为 host 不阻止其他运行控制；显式 off 缺接口则拒绝。外部所有权冲突保留其配置。见 [重复提醒合同](repeat-reminder-contract.md)。

`readLimit` 是官方 read 工具的正文 UTF-8 字节预算，0 沿用宿主；不是实际 I/O 或整个工具结果的字节上限。通过可信的活动读取条目逐项 noSave 重挂载调整字节、行数与行长窗口，分别保存和恢复原配置；原本关闭 read 的条目不启用。状态读回真实 cap 与覆盖数量，新加载预设需要明确重新应用。当前安装入口摘要不匹配时显示不支持，不执行该入口。见 [读取窗口合同](read-limits-contract.md)。

运行中保存若已落盘但某个控制未更新，返回 `SETTINGS_APPLIED_PARTIAL` 与 `partial.savedRevision`，仍尝试其他独立控制。首次应用后的目录通知失败返回 `CONTROLS_APPLIED_PARTIAL / {enabled:true}`，不能冒充控制未启用；目录通知本身不承诺每个客户端已刷新。

提示词 replace 仅替换三个人设槽及当前 scope 的明确 complete 定义；工具、模式、SDK 和未知功能段保持原序与正文。complete 元数据使用固定版本只读适配，详见 [提示词功能段合同](prompt-sections-contract.md)。

`maintenance.info` 返回离线维护说明与卸载能力、阶段和禁用原因。`maintenance.uninstall` 仅接受 `{bundle:"dsh-unlimit",confirmed:true}`，不向模型工具开放。先停止连接检查、排空已接纳动作、持久禁用和撤销入场、停止所属任务并还原控制，再用官方管理器移除和读回。准备失败不移除，未知结果不自动重试；成功后只返回普通回执，不再读取已经释放的数据服务。资料保留、所有权、失败字段和真实未验边界见 [卸载合同](maintenance-contract.md)。

技能新导入或保存最多200个普通文件，正文256KiB、ZIP12MiB、展开总量50MiB；ZIP目录项与文件合计另有512条解析上限。既存技能保留最多512文件的读取能力，超200文件的编辑保存明确拒绝，不截断原文件；需要先由用户整理到当前导入规模。

## 发布边界

公开 GitHub 只包含独立源码、合成测试、文档和工作流。宿主程序、用户 profile、真实会话、数据库、密钥、工具库和本机诊断原始路径不提交。检查结果必须区分实现、合成测试、真实宿主接口、桌面端交互验收。

## 已实现的数据扩展

资产可保存多个名称、域名、端口、服务、指纹与来源。同一工作区内按地址和类型合并；服务按协议与端口合并，保留稳定标识。`assets.list` 接受 `scope / segment / status / priority / type / port / service / source / fingerprint / tags / view` 条件，返回 `items` 与匹配 `total`。`assets.timeline` 还返回按日的首次发现和观察次数。`assets.import` 接受 `{ workspaceId, items }`，返回逐项结果及 `added / merged / rejected`，存储故障回滚整批已接受记录。

计分记录使用 `pointId`，可关联 `assetId` 与 `serviceId`，或 `port / protocol`；按“计分点＋资产＋服务端点”去重，保留每条证据。`awarded: false` 仅留证。得分点可用 `stageId` 关联本项目阶段。`scoreTotal` 是计分点基准和，并非总分上限；`scoreEarned`、`scoreUniqueHits`、`scoreByStage` 分别表示累计分、唯一有效命中和阶段累计。

知识列表支持 `kind / tags / verified` 筛选，标签为全部匹配。验证标志需要对应当前正文的证据内容；修改正文或证据会撤回旧验证。`knowledge.use` 累计复用次数。

`flow.status / configure / assign / acquire / release` 管理已绑定会话的明确角色与本地执行槽，槽位默认3、允许1至10。这里的槽登记不会启动任务或替代宿主子代理限制；活动槽不持久化。角色正文按绑定会话注入，普通未分配会话不带演练角色稿。

`workspacePolicy` 控制所选规则，并在原生接口通过版本与摘要检查时处理宿主工作区指令：`strict` 排除，`always` 保留；`fallback` 在当前模型所选规则和保存正文都只有空白时保留。原生策略逐步骤读取，历史通过官方可恢复替换事件处理，新消息在接纳前筛选；不改请求副本，不停止宿主发现文件，不删除人工内容、其他来源或工具说明。未通过原生接口检查时仅处理所选规则，UI 明确显示这一限制。来源、物理日志重建、卸载恢复与未加载会话边界见 [原生规则合同](native-instructions-contract.md)。

规则选择顺序为：当前模型下明确激活的规则 → 列表中第一条匹配当前模型的规则 → 无模型限定的活动规则。模型限定采用非空 ID 完全匹配；当前模型缺失或不匹配时，该规则不作为全局兜底。原生工作区策略使用同一选择函数，避免无关模型规则误抑制其 fallback。`rules.reset` 只清除 activeId，不删除规则或停用自动模型匹配；停止全部注入仍需还原运行控制。

`prompt.preview` 接收可选 `{model, directory}`，只读取已保存配置、规则库和本次需要参与正文的所选工作区文件。模型 ID 完全匹配，省略或空串按无模型处理；需要读取选定文件时必须明确给出工作区绝对目录，仍遵循祖先链、文件大小和链接边界。`strict` 或已有有效正文的 `fallback` 不读取所选文件。预览不保存、不启用控制、不组装宿主请求，也不调用模型。

结果包含 `revision / model / directory / enabled / mode / source / rule / workspace / text`；`source` 为 `rule / saved / workspace / default`，`rule` 仅在规则正文被采用时包含 ID、名称和限定模型。`workspace` 返回策略、本次读取的 `selectedPaths` 和正文是否包含工作区内容。返回的 `text` 与运行时使用同一个正文选择函数；停用时仍可预览候选正文，`enabled` 为 false。此结果不包含宿主工具说明、会话角色段或未保存的表单草稿，不能当作已经发送的完整系统消息。旧进程缓存回退仍未引入。

`rules.workspace / rules.preview` 浏览明确目录的祖先链和完整正文；扫描不保存选择。`rules.select / rules.policy` 必须带 `revision`，冲突拒绝覆盖。路径、字节、UTF-8 和链接边界见 [工作区规则合同](workspace-rules-contract.md)。Hook 与第三方记忆专用策略尚无已验证目标接口，保存值不代表生效，详见 [接口调查](hooks-memory-contract.md)。

服务器清单只接受 IP、完整主机名或 `username@host`。空行忽略，主机名转小写和 IDNA，IPv6 使用规范化方括号格式，按完整项去重。密码、密钥、URL、端口、网段、通配符和多目标表达式拒绝，错误不回显输入。清单仍是本地库存，不提供 DNS/地区判定或出口授权。

`assets.path` 接受 `{workspaceId, from, to, direction?}`，返回 `{found, direction, nodes, edges}`；默认有向，`undirected` 按无向连接查询。返回保存关系中的一条最短路径，不执行网络路径探测；不同工作区的端点拒绝，无路径明确返回 `found:false`。

## 工作区材料

`WorkspaceFiles(root, store)` 仅在本插件的材料目录中管理文件。所有请求带 `workspaceId`，路径必须是工作区相对路径。文本不执行，HTML/SVG 不内嵌预览。模型工具沿用会话的项目绑定，不能指定其他项目读取材料。

| action        | 主要输入                                                | 返回                                                             |
| ------------- | ------------------------------------------------------- | ---------------------------------------------------------------- |
| files.list    | `{workspaceId}`                                         | `{items, limits}`，真实文件列表，不含内部备份                    |
| files.read    | `{workspaceId,path,encoding?}`                          | `{item}`，`utf8` 返回 `content`，默认返回 `contentBase64`        |
| files.write   | `{workspaceId,path,content}` 或 `contentBase64`         | `{item}`，覆盖时带 `backupId`                                    |
| files.import  | `{workspaceId,items:[{path,contentBase64,mediaType?}]}` | `{items}`，预检查后整批写入                                      |
| files.preview | `{workspaceId,path}`                                    | `{item}`，带图片字节、媒体类型和宽高                             |
| files.delete  | `{workspaceId,path}`                                    | `{item}`，带 `deleted:true` 和 `backupId`                        |
| files.restore | `{workspaceId,backupId}`                                | `{item}`，带 `restoredFrom`，若覆盖当前版本也返回新的 `backupId` |
| files.backups | `{workspaceId}`                                         | `{items}`，持久备份清单，可在重开页面后恢复                      |

每项包含相对路径、字节数、SHA-256 和检测到的媒体类型，可保存资产关联、来源和用途。单文件上限 10 MiB，UTF-8 文本读写上限 1 MiB，批量导入最多 128 文件、合计 20 MiB。覆盖/删除保留原字节和元信息。拒绝路径逃逸、符号链接、保留内部名称和大小写别名。

PNG/JPEG/WebP/GIF 的预览先检查格式结构与尺寸，最长边 16384 像素、总像素 4000 万以内。`imageValidation:"structure-only"` 明确表示没有完整解码像素；浏览器加载失败也必须显示失败，不能把结构检查当作成功渲染。

## 本地工具路径

通用运行入口为模型工具 `unlimit_process` 与内部 `processes.*`，其会话、审批、输出和停止约定见 [本地工具进程接口](environment-contract.md#本地工具进程接口)。UI 只读取和停止所选项目内本插件拥有的记录；HTTP 不接受伪造的模型执行上下文来启动进程。

`toolkit.save` 部分更新 `{root, searchDirs, toolPaths, templateDir}`；`toolPaths` 为工具 ID 到绝对可执行文件路径的映射，替换整张映射。查找优先级为逐工具路径、工具根、按顺序列出的额外目录，各目录只枚举根及一层子目录，不自动搜索环境 PATH。失效的逐工具路径不静默回退；此配置动作只校验和登记模板目录，正文由下述 `templates.*` 明确读取。

`toolkit.status` 返回完整配置、`tools` 和空 `runs`。每项分开返回 `path/source/identity/available/detail`；存在文件不一定确认了产品。`httpx` 在版本/帮助输出被识别为 ProjectDiscovery 产品前不可标可用，Python HTTPX 标为不匹配。身份随文件指纹变化撤回，不能当作代码签名或文件可信证明。

`toolkit.probe` 只运行固定参数：普通工具 `--version`，`httpx` 为 `-version`，必要时追加 `--help`。两次调用共享超时与 64 KiB 输出上限，临时 HOME/工作目录隔离真实工具配置。没有扫描、下载或通用命令入口。

## 请求重试

`retryOverride:false` 默认保留提供方策略；只有插件已启用且显式打开此开关，`retryLimit` 才覆盖每请求的重试次数（0–20，0 表示不重试）。这改变官方 `prepareCall` 返回的策略，不叠加新的请求循环，不修改提供方注册或持久 profile。

仍由官方 `llm-retry` 执行退避、Retry-After、取消与日志。仅允许 `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` 与提供方原允许列表的交集；原 `always` 策略也收窄到这些瞬态错误。认证、额度、无效参数、模型缺失、上下文溢出不由本项目扩大重试。手动/自动“继续下一轮”使用独立的继续服务。

能力依赖当前版本的 `llmRetry v1` 活动投影注册和可撤销的 `prepareCall` 接口。缺少官方执行器时明确不支持，不阻断其他已支持的运行控制；重新挂载可选服务后需重新应用。未来宿主升级必须复验该内部适配点。

## 截断后继续

`continuation.status / continuation.continue / continuation.stop` 均只接受明确的 `sessionId`。根会话最新结束事件明确为 `max-tokens`、代理空闲且无排队输入时，才允许手动或自动继续；原生用户停止、传输错误、限流等不会被转成新一轮继续。手动动作每个截断事件只允许一次，状态接口返回当前原因与自动链计数。

自动继续默认关闭，且仅在运行控制已启用时注册。`continueLimit` 为每次真实人工输入后的自动链上限，范围 0–20；`continueText` 必须非空且不超过 4 KiB。手动继续不重置自动次数；重新应用时从事件重建计数。新人工输入、关闭开关或撤销控制会阻止尚未提交的自动继续。

子代理自动继续仅接纳启用后观察到官方 `subagent/start(local:true)` 的准确运行实例，且其直接父代理仍驻留、官方子代理入口摘要通过。截断结束先记录候选，在 `agent/status:idle` 事件中通过官方 `dsh.subagent.deliverPrompt` 队列提交，保留插件来源并沿用同一运行实例。工作流原收据、并发槽和任务依赖保持到整个自动链结束；普通官方子代理继续受官方池管理，不因此领取项目槽位。已有但未观察到启动的子代理和外部进程不接入这条自动路径。

子代理按其自有历史重建计数，不计继承的父会话历史；实际进入子会话的人工输入或直接父代理消息开启新链，背景上下文、孙代理报告和结束通知不重置限额。停止、父代理取消、新输入、禁用与销毁会撤回尚未接纳的投递；已接纳的自动消息按消息身份删除，运行中只取消本模块所属的自动续轮。`childAutomaticAvailable` 表示当前实例已接入这条路径，不代表自动开关已开启或有剩余次数。

已结束子会话可显式手动冷恢复，但仅限官方可持续本地 `spawn` 描述、完整自有事件前缀及最新自有 `turn/end:max-tokens`。不计继承的父历史，不恢复驻留或未完整结束的子任务。直接父代理必须仍是检查时的准确驻留实例；父子任一归档、已有后续输入、同一截断已有继续请求、检查期间父子收到新输入或父代理取消，均拒绝尚未接纳的投递。缺少已核验官方入口时明确不支持。

手动冷恢复通过官方 `dsh.subagent.deliverPrompt` 创建新原生 `runId`，插件请求标识为 `source.continuationId`，与独立 `manualRun.id` 对应。继续用语、系统正文和角色取当前保存值，保留插件来源；原工作流收据及已完成 DAG 保持不变，不复用旧执行收据。原演练子任务按当前角色重新领取一个项目槽，持有到匹配新 `runId` 的官方 `subagent/end`，包括代理销毁阶段；满额拒绝恢复。普通官方子代理不因此领取项目槽。官方冷恢复结束会按原生行为通知父会话，可能触发父会话后续请求；手动继续不重置自动配额。

状态返回保留既有字段，并提供 `child`；`manualAvailable` 是手动按钮的依据，`unsupportedReason` 说明当前拒绝条件。可选 `manualRun` 返回独立 `id`、新 `runId`（启动前为 `null`）、`parentSessionId`、可选 `workspaceId/messageId`、`slotHeld`、可选 `stopReason/error`。状态为 `starting/running/completed/truncated/failed/stopped/released`；`truncated` 表示新执行再次达到长度上限，`released` 只表示插件控制权已释放。界面确认后回读详情，切页或改选会话后不提交旧确认或覆盖新详情。

根会话继续调用官方消息构造和 `followup`，子会话沿用上述官方投递入口。官方入口需要 `role:user`，但消息明确携带 `source.kind: "dsh-unlimit/continuation"`、模式和触发事件序号；不得标成人工发言。下一轮仍从官方提示词路径读取当前正文，原生重试不会被新增继续循环替代。

停止撤回尚未接纳的手动请求，并仅移除本模块拥有的自动或手动子会话消息；只有能证明当前运行由本模块输入独占、无其他待发输入且直接父实例未变时才取消运行。手动请求已接纳后到来的其他来源输入保留；普通停止不抢占它们，项目槽保持到匹配的原生结束事件。撤销控制时若其他输入阻止所属运行取消，则释放插件控制权及槽位，状态为 `released`，不宣称宿主任务已停止。保存配置后若停止未确认，API 返回 `SETTINGS_APPLIED_PARTIAL` 和 `partial.savedRevision`，明确配置已落盘。它不是“保存失败所以什么都没发生”。

手动冷恢复的五项官方模块隔离场景已通过：当前提示词/角色与独立停止、普通子会话及父通知、满槽拒绝、恢复期间父输入冲突、已接纳后其他输入保留并等待原生结束。传输使用合成响应，未安装真实插件、读取真实 profile 或发起真实模型调用；桌面嵌入路径仍待验收。

## 会话能力目录

`HostCatalog` 聚合官方 `SkillRegistry`、本项目技能库、官方 `ToolRuntime` 和已配置工具目录。显式 `sessionId` 必须对应实际代理；使用该会话的工作目录和注册表可见性，不静默回退到全局目录。模型工具强制使用调用会话，拒绝指定其他会话。

| action            | 输入                                                                  | 返回                                                                    |
| ----------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| catalog.list      | `{sessionId?}`                                                        | `{context, skills, tools, toolkit, sources}`                            |
| catalog.read      | `{sessionId?, origin:"host" 或 "project", id}`                        | `{context, item}`，正文读取与依赖状态分开                               |
| catalog.preflight | `{sessionId?, skills?:[{origin,id,requirements?}], requirements?:[]}` | `{status, skills, checks, sources, toolkit, executionAuthorized:false}` |

依赖只接受本次显式输入或项目命名空间 `metadata["dsh-unlimit"].requirements`。每项为 `{kind:"tool"|"toolkit"|"skill",name}` 或 `{kind:"directory",path}`，不是宿主通用元信息标准。未声明依赖为 `unknown`；缺失依赖为 `blocked`；`ready` 仅说明所声明条件通过。来源读取失败保留在 `sources`，不伪造空成功。

官方工具名称与 MCP 公开命名空间可观察，不意味着连接健康、权限充足或实际执行成功。本模块不主动联网、执行或下载；调用已注册 provider 的公开目录/读取接口时，该 provider 自己的 I/O 行为仍由宿主负责。

## 本地模板

`templates.list({query?,limit?})` 在明确配置的 `templateDir` 中按相对路径或正文搜索，返回 `items / inspected / skipped / truncated / limits`。每项包含 `path / bytes / sha256 / excerpt / verification:"unverified"`。`templates.read({path})` 返回完整 UTF-8 正文、摘要与相对路径，不执行文件。

支持 `.md / .txt / .yaml / .yml / .json / .toml`；每文件最多 1 MiB、枚举最多 10,000 项、深度最多 12 层，结果上限默认 100、允许 1–500。拒绝路径逃逸、链接、非 UTF-8 和二进制正文。未配置目录明确报 `NOT_CONFIGURED`。

页面可将已读取正文整理为新的知识条目，保留 `local-template:<相对路径>#sha256=<摘要>` 来源，初始为未验证；随后按知识库既有证据约定保存。文件被检索到不意味着模板有效。

## 演练执行者

`DesktopWorkflow` 通过官方 `subagents.startActivation` 创建进程内子代理；先预留会话标识并绑定项目、分配角色、领取槽位，再启动第一轮。只分派明确提供的任务，沿用当前宿主工具和权限，不因项目登记或角色名称扩大授权。结果通过调用收据返回，不发送到其他聊天。

| action            | 输入                                                 | 返回                                             |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------ |
| workflow.dispatch | `{workspaceId,parentSessionId,role,task,usePreset?}` | `{item}`，含运行编号与实际子会话                 |
| workflow.status   | `{workspaceId,id?}`                                  | `{item}` 或 `{items}`                            |
| workflow.stop     | `{workspaceId,id}`                                   | `{item,stopped}`                                 |
| workflow.presets  | `{operation:"status"\|"register"\|"unregister"}`     | `{item,owned,runtimeOnly:true,persistent:false}` |

任务正文最多 32 KiB。父会话必须已绑定相同项目。模型工具把父会话限定为调用者：同项目内也不能读取或停止别的父会话所分派的执行者；页面按项目显示运行列表。

收据完成或停止后，确认 `dispose` 成功才释放本项目槽位。清理失败保留占用和绑定，暴露 `cleanupError`，允许再次停止尝试清理。启动/停止部分失败使用 `WORKFLOW_START_FAILED / WORKFLOW_STOP_FAILED` 和 `partial.item` 披露已发生的结果。受本模块管理的活动会话不能经通用 `flow.assign / flow.release / workspaces.bind` 绕过收据生命周期。

原创预设 `dsh-unlimit/local-evidence-worker` 只在本插件进程内注册，可精确撤销，不覆盖同 ID 的其他所有者；没有持久预设迁移。运行收据和槽位为进程内状态，真实会话由宿主持久化。本模块不包含自主任务拆解器，也不管理其他来源创建的全部官方子代理。

## 数据更新与页面刷新

`workspaces.changes({workspaceId?})` 返回当前项目标识、全局 `workspaces/knowledge` 版本，以及该项目 `assets/findings/links/events/roles/files` 和各 `records` 分类的版本。省略项目时读取活动项目；没有活动项目返回 null 与项目零版本，仍返回全局版本。明确传空值或不存在的项目会拒绝。接口不返回记录正文，通过既有本地 HTTP 来源和演练入场门控制。

SQLite 的插入、修改、删除触发器与数据事务一起更新版本；旧库只新增表和触发器，不重写或补算已有记录。文件成功写入、批量导入、删除或恢复后递增文件版本，完整回滚不递增；部分残留会递增。文件已改变而版本写入失败时返回 `RECOVERY_REQUIRED`，披露 `filesChanged/changeTrackingFailed` 和保留版本，不能显示为成功。

页面导航及右上角“刷新数据”重新读取项目列表、当前页和版本，模型工具与页面共享同一存储。提醒按项目、页面和证据/评分分类分别保存于本面板内存；知识库与项目列表使用全局范围。首次观察建立基线，提醒表示相关数据版本变化，不是新增记录数或逐条已读。刷新前保留既有草稿，保存进行中不能刷新。

只有成功完成当前页面渲染，才确认读取开始时的版本；读取过程中又发生的变化仍提示更新。错误、部分读取失败、过时项目响应均不确认已读，旧响应也不能写回新页面或报告下载正文。暂无记录与读取失败分别显示空态和错误。此版本不后台轮询、不自动重绘；切页或点击刷新才检查变化。关闭或浏览器重载面板会重建已读基线。工作流执行状态等进程内数据不纳入数据库更新计数，仍通过各页既有按钮读取。

## 页面编辑状态

未保存表单按工作区、页面和对象保留在面板内存。关闭弹窗或切换页面后可恢复同一对象的草稿；保存、主动放弃和删除只清理对应草稿。浏览器刷新或卸载会丢失内存草稿并提示，不写入浏览器持久存储。这不是官方聊天输入框的草稿桥或崩溃恢复。

环境秘密表单与入口确认表单不进入上述内存草稿。凭据编辑只保留非秘密字段，密码和显式清空选项不保留。秘密输入在保存成功、失败或关闭后清空；配置和凭据读回只显示保存状态。

## 当前安装的演练入口

`admission.status/begin/read/confirm/revoke` 只提供给经宿主认证的工作台 HTTP，不注册为模型工具 action。普通规则、技能、环境设置和聊天不受演练门影响；工作区数据与新工作流分派在 Controller 检查，排队任务实际启动时也在 DesktopWorkflow 再检查。

`begin` 返回 15 分钟有效的 `challengeId`、服务端 `readyAt`、说明和三个勾选项。`read` 接收 `{challengeId}` 记录已读确认，页面只在滚动至说明末尾后开放按钮。`confirm` 使用 `{challengeId,checks:{scope:true,permissions:true,evidence:true}}`，服务端必须已过 5 秒、收到已读确认且逐项为 true。已读与勾选是用户操作声明，不是人类实际阅读的技术证明，也不是目标授权或法律协议。成功、撤销或过期使旧 challenge 失效。

确认按数据安装根和说明版本保存于本地 meta；替换插件包不清空同一数据安装，复制数据库到另一根会重新要求确认。`revoke` 使用最新 `{revision}`，先持久撤销，再停止本实例计划和所属执行者；`ADMISSION_REVOKED_PARTIAL` 明确 `partial.accepted:false`。状态/停止接口仍开放，诊断页在已撤销时也能再次请求清理。工作台卸载入口先撤销当前安装确认；直接从官方插件管理器卸载会绕过准备入口，该路径联动仍未覆盖。

## 本地环境与多任务计划

环境配置的 action、脱敏、修订与文件权限约定见 [environment-contract.md](environment-contract.md)。实际变量解析仅为内部方法，不开放给 HTTP、模型工具、报告或提示词。模型不会通过工具替用户保存秘密或确认演练入场。

环境依赖预检见 [environment-preflight-contract.md](environment-preflight-contract.md)：检查明确声明的变量、主机登记及密钥登记 ID，仅读取状态快照和文件元信息，不返回秘密、路径或无关配置。技能、目录和计划共用声明规范。配置项通过不证明连接有效；目录来源不可用仍使整体结果为 unknown。

多任务队列合同见 [workflow-plan-contract.md](workflow-plan-contract.md)。HTTP 与模型工具使用同一 coordinator；模型调用强制使用调用者的项目和父会话。未知宿主版本不能创建计划，仍可查看/停止已有计划。撤销和卸载按计划协调器 → 单个工作流顺序清理，`stopped:false` 不当作成功。

## 官方输入框草稿桥

客户端只接收同源且来自本面板 iframe 的请求。`restore` 的 payload 为 `{newSessionId,draft,attachmentBatch?}`；通过官方 `sessions.using` 保留绑定，再调用 `requestDraftInitialization`，不发送消息。已有草稿/附件返回 `preserved`，被阻止时返回 `blocked`；均不覆盖目标内容。

附件批次只引用该次回退移除的第一条人工消息，完成后绑定新会话。固定的 `sessions.attachment/releaseAttachments` 仅供工作台 HTTP 使用，不开放为模型 action；读取未知版本拒绝，清理仍可执行。图片重建为本地草稿，文件通过官方上传到新 Agent，不能复用原收据。完整合同、载体限制和原生 todo 语义见 [session-attachments-contract.md](session-attachments-contract.md)。

返回的 `draftStatus`、`textStatus`、`attachmentStatus`、`uploadStatus` 与 `openStatus` 分开：整体 `restored` 代表文字与必要附件已恢复；`partial` 明示已恢复文字但附件未完成。`requested` 仅代表同步 `openSession` 已返回，不声称可见页面完成切换。打开失败但已恢复时，页面保留该事实，不重试写入草稿。附件批次释放后不提供同批次重试按钮。

请求可带顶层绝对 `expiresAt`。父桥按最早截止时刻取消，并在写入前重新核对截止时间；页面超时发送 `cancel`。关闭、重新加载和卸载也取消，关闭后到达的旧消息不能开始恢复。此为官方模块隔离验证的合同，真实桌面可见导航、编辑重发和附件恢复仍未验。
