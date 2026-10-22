# 验证记录与复验边界

当前是独立实现的本地源码验证记录，目标宿主为 macOS arm64 的 `0.2.1-rc.2`，不是完整桌面 1:1 验收报告。行为目标、逐项差距见 [parity.md](parity.md)；源码合同见 [contract.md](contract.md)。本轮补齐工作位于初始基线 `100f9b7` 之后，源码修订以包含本文的提交为准。后续代码变化应重新运行受影响检查，不能沿用旧计数。

## 证据层级

| 层级             | 本文含义                                                                                               | 不能据此声称                           |
| ---------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 源码实现         | 当前源码有入口、校验和实际处理路径                                                                     | 已运行、已接入官方桌面                 |
| 合成验证         | 临时目录、原创数据及受控假服务下验证功能/失败路径                                                      | 真实宿主接口或真实设备通过             |
| 官方模块隔离验证 | 从库存匹配的安装文件或固定完整性归档加载官方模块，独立 Cordis 上下文、临时数据、假传输，无用户 profile | 已安装本插件、实际桌面 UI/模型联网通过 |
| 预览交互         | 回环 HTTP 上的独立工作台，1280×820 / 1280×720 浏览器实看和操作读回                                     | 官方桌面嵌入、真实会话/草稿桥通过      |
| 桌面实机验收     | 实际安装后，以授权范围内的桌面操作记录结果                                                             | 本轮尚无此级证据                       |

未实际安装插件、未发真实模型联网请求；隔离测试使用临时 profile，连接检查测试只连接任务自建回环端点，未执行网络扫描、登录或外部远程连接。此前“子代理限额与首轮角色正文”批次有一次误启动应用主程序的异常，内部 profile 访问未能核实，详见该节记录；不能将 fixture 的隔离边界扩展为整轮操作保证。Windows 未实机验证。所有未验的层级保持未验；`available` 仅表示当前接口条件可用，`active` 才表示本插件拥有的运行时适配已注册，两者均不能代替用户操作验收。

## 合成验证入口

| 证据编号     | 文件                                                | 已覆盖的具体断言                                                                                                                                                                                                         | 仍未覆盖                                                                                            |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| V-STORE      | [store.test.mjs](../tests/store.test.mjs)           | 设置修订冲突；规则 CRUD/UTF-8 限额；工作区与会话绑定；资产/服务归一合并、来源与首次发现；组合筛选；事务导入结果与失败回滚；发现/各类记录；角色隔离/重置；知识全文/过滤/证据验证/复用；按点、资产和服务去重计分及报告脱敏 | 真实采集、连接及桌面交互；材料文件由 V-FILES 单独验证                                               |
| V-RUNTIME    | [runtime.test.mjs](../tests/runtime.test.mjs)       | 关闭时原样返回；完整提示词替换保留工具/上下文；逐步读取新值与模型规则优先；strict 策略；审批审计与取消；明确会话限制/用户审批优先；默认沙箱、子代理动态值；重复注册、回滚、精确撤销与版本拒绝                            | 各模式实机执行；文件/终端/浏览器权限端到端；全局 Hook；读取窗口另见 V-READ-LIMITS、重试另见 V-RETRY |
| V-SKILLS     | [skills.test.mjs](../tests/skills.test.mjs)         | 自写技能 CRUD、覆盖备份/删除；文件夹与多技能 ZIP；引用/二进制附属文件；调用标志；CRC/长度/路径/链接/资源限制；中途失败恢复；文件夹/ZIP的200/201普通文件与ZIP的512/513目录项边界；既存201文件可读且超限保存原样保留       | 桌面斜杠调用和真实技能执行；会话目录另见 V-CATALOG                                                  |
| V-SESSIONS   | [sessions.test.mjs](../tests/sessions.test.mjs)     | 合成事件切点、prepare、人工文本/附件选择、fork/空会话、继承与归档；附件能力/原事件绑定/索引/期限/读取取消/部分失败；父子停止和并发拒绝                                                                                   | 原生 todo 与真实附件见 V-SESSION-HOST；创建来源映射另见子代理合同；再次激活与外部任务恢复仍缺       |
| V-FLOW       | [flow.test.mjs](../tests/flow.test.mjs)             | 默认 3 槽/1–10 配额、显式角色分配、会话绑定与跨区拒绝、槽幂等/满额拒绝、降低配额限制、动态角色正文、撤销/重绑/关闭释放                                                                                                   | 自主任务拆解、所有官方代理强制领取本地槽；明确任务的官方执行另见 V-WORKFLOW                         |
| V-TOOLKIT    | [toolkit.test.mjs](../tests/toolkit.test.mjs)       | 逐工具路径→工具根→有序目录优先级；原子配置与空值清除；拒绝失效精确路径静默回退和 PATH 扩张；httpx 版本/帮助产品识别及指纹变化失效；固定参数、总超时/64KiB/取消/临时 HOME 清理                                            | 真正工具扫描、联网安装、任意命令运行；Windows 原生探测及进程树实机验证                              |
| V-EXTENSIONS | [extensions.test.mjs](../tests/extensions.test.mjs) | 日志动态引用不可变而外层字段可替换时的关闭/禁用/精确还原；接口缺失、冲突和失败回滚；对无接口能力明确报告 unsupported                                                                                                     | 关闭所有遥测或已在途上传；Hook/记忆/全局字节读取；重试策略另见 V-RETRY                              |

前一阶段 **V-CONNECTION**：[连接服务测试](../tests/connection-checks.test.mjs) 13项、[传输测试](../tests/connection-transport.test.mjs) 13项、[页面交互测试](../tests/connection-checks-ui.test.mjs) 初始16项，以及1项真实官方挂载测试。系统DNS返回固定地址后仅连接一次；HEAD/Host/查询路径、正常TLS证书与原主机名校验、无代理/跳转、拒绝/超时/取消、实际socket/request关闭后读回；精确范围、零网络读取、陈旧确认拒绝、记录修改竞态、可信回执与写库失败均有断言。真实ToolRuntime拒绝模型检查入口，HTTP保留已观察未保存的partial。该阶段仅用临时合成库、自建回环服务和临时证书，不含真实DNS域名、IPv6传输、地区库或通用宿主出口证据。来源合同见 [connection-checks-contract.md](connection-checks-contract.md)，历史汇总见 [connection-checks-acceptance.json](evidence/connection-checks-acceptance.json)；当前地区扩展见下方 V-SCOPE。

新增 **V-SCOPE**：[国家数据库测试](../tests/country-database.test.mjs)16项、[范围服务测试](../tests/network-scope.test.mjs)14项、[范围UI测试](../tests/network-scope-ui.test.mjs)16项、连接UI新增1项和官方挂载新增1项。覆盖CSV/gzip/UTF-8/范围/国家校验、索引查询、原始摘要、版本冲突、替换失败保留旧库、IPv6/映射/特殊地址、明确解析与派生IP、CN/HK/MO/其他/未知、混合DNS选定允许IP、别名不继承、取消/撤销/卸载清理、陈旧确认与历史回执、HTTP部分失败及模型入口拒绝。最终措辞改为“判定地址”，精确例外显示“未查询国家”，对应33项UI测试重跑通过。

V-SCOPE 浏览器预览为1280×720，临时合成CSV和SQLite、假DNS/假传输。选择文件不自动导入，取消确认零解析；一次有效导入、一次无效导入保留旧库；明确刷新保存快照，在途停止不保存；一个5项检查批次阻止未登记CN与共享IP别名，只为混合地址的US项、精确主机及派生字面IP调用假传输。共6次假DNS、3次假传输，真实目标DNS/网络为0。刷新页面读回，修改清单清空快照并使5条旧回执过期。重载后的控制台警告/错误0；任务页面、服务及临时数据已清理。[范围面板](network-scope-preview.jpg)、[结果页](network-scope-results-preview.jpg)、[合同](network-scope-contract.md)和[结构化证据](evidence/network-scope-acceptance.json)可复核。未导入供应商真实月度数据，未验证地理准确性、实际桌面、其他工具或通用出口。

新增的本地路径与失败边界：

| 证据编号    | 文件                                                    | 已覆盖的具体断言                                                                                                                                                        | 边界                                                    |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| V-FILES     | [files.test.mjs](../tests/files.test.mjs)               | 真实材料目录的文本/二进制读写、批量导入、摘要与关联元信息、覆盖/删除备份持久恢复；跨区/路径/链接/大小写别名拒绝；批量失败回滚与恢复不完整的明确结果；位图容器和尺寸限制 | 图片检查是结构检查，实际解码另见预览；不是远程文件操作  |
| V-SERVERS   | [servers.test.mjs](../tests/servers.test.mjs)           | IP/IPv6/IDNA/用户名主机规范化及去重；密码、密钥、URL、端口、网段、通配符拒绝且错误不回显输入                                                                            | 不提供 DNS/地区判定或网络出口授权                       |
| V-TEMPLATES | [templates.test.mjs](../tests/templates.test.mjs)       | 按正文/相对路径搜索、完整 UTF-8 读取与 SHA-256、未验证标记；目录替换/链接/路径逃逸/二进制/文件和结果上限                                                                | 不执行模板，不自动验证其内容                            |
| V-DRAFTS    | [ui-drafts.test.mjs](../tests/ui-drafts.test.mjs)       | 按工作区/页面/对象隔离，字段差异恢复，保存/放弃/删除精确清理；刷新丢失提示                                                                                              | 仅内存，不是官方 composer 桥或崩溃恢复                  |
| V-CATALOG   | [catalog.test.mjs](../tests/catalog.test.mjs)           | 来源分离、完整正文、显式依赖声明、未知/缺失/就绪区别、真实会话要求、目录失败保留；未声明依赖不猜测                                                                      | 不能把已登记 schema 当连接/执行成功，另见官方目录用例   |
| V-RETRY     | [retry-policy.test.mjs](../tests/retry-policy.test.mjs) | 只有显式开关接管，冻结返回兼容、策略收窄、缺官方执行器拒绝、精确撤销和原所有者保留                                                                                      | 合成适配合同，实际官方循环另见下表                      |
| V-CONTINUE  | [continuation.test.mjs](../tests/continuation.test.mjs) | 根会话 max-tokens 条件、动态正文/用语、默认关闭/有界计数、原生取消、新人工输入竞争、只停止自己所属的自动运行、失败回滚                                                  | 子代理手动继续仍不支持；新增自动路径见 V-CHILD-CONTINUE |
| V-WORKFLOW  | [workflow.test.mjs](../tests/workflow.test.mjs)         | 首轮前绑定/角色/槽位，独立项目/所有者，预设冲突保留，完成/停止/卸载；清理失败保留槽位并返回 partial，显式停止可再次清理                                                 | 合成收据；官方 spawn 与预设另见下表                     |

本轮新增入口、环境与计划验证：

| 证据编号      | 文件                                                      | 已覆盖                                                                                                                            | 边界                                                                                                      |
| ------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| V-ADMISSION   | [admission.test.mjs](../tests/admission.test.mjs)         | 服务端倒计时、已读确认、勾选项、过期/重放、持久与根隔离、撤销先落盘、清理部分失败及显式重试；模型/HTTP入口另见V-PLUGIN            | 已读是操作声明，不证明实际阅读；工作台卸载另见V-MAINTENANCE；直接官方UI卸载未覆盖                         |
| V-ENVIRONMENT | [environment.test.mjs](../tests/environment.test.mjs)     | 15项临时数据检查：秘密脱敏/保留/清空、修订冲突、原子失败、路径/链接/权限拒绝、私钥元信息与权限未知、明确名单内部解析、跳过/根隔离 | 未加密；不自动注入环境或执行连接；Windows ACL未验                                                         |
| V-PLAN        | [workflow-plan.test.mjs](../tests/workflow-plan.test.mjs) | 16项合成收据检查：单槽排队、目录及环境依赖、原始结果只传直接依赖、上下文超限阻断、失败及清理保槽、父/项目隔离、停止/撤销/启动竞态 | 真实Store/Flow/DesktopWorkflow，activation结果为合成；官方计划执行另见 V-WORKFLOW，无自动拆解或跨重启恢复 |
| V-CLIENT      | [client-bridge.test.mjs](../tests/client-bridge.test.mjs) | 13项桥验证：同源/指定iframe、文字/图片/文件草稿、字节与元信息、已有输入保护、部分失败、取消/关闭/过期、晚写拒绝、批次释放         | DOM为最小合成模型；官方客户端路径另见下节                                                                 |

2026-10-21，在 `d1fc29e` 后包含本文的工作树，主代理使用 bundled Node **24.21.0** 并提供 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES`，完整运行 `node --expose-internals --test tests/*.test.mjs`，退出码0，结果为 **580通过、0失败、0跳过**。JavaScript 语法检查 **127/127通过**。此次包括 HTTP 与连接检查的 IPv6/NAT64 判定、并发/逐跳发现、旧回执失效及页面回执的最终回归。这些是合成、官方模块隔离和入口集成测试，不是580项桌面验收。构建与离线打包独立核对，包不安装到当前桌面。117项行为的目标及最低验收场景保持不变，局部新增证据不将整项范围执行标为完成。

前一阶段 **V-WEB-SCOPE**：[请求组合测试](../tests/scoped-http.test.mjs)16项、[版本与摘要门](../tests/web-scope.test.mjs)2项、[官方工具链测试](../tests/web-scope-host.test.mjs)23项，以及Controller新增3项，共44项新增结果。官方 ToolRuntime/web_fetch/AgentRegistry/WebRuntime/HTTP provider 与临时真实 SQLite 范围库验证主/子会话、并发精确身份、CN/HK/MO/未知拒绝、精确与保存派生IP、别名拒绝、原生 private/mixed-DNS 拒绝、guard/pre-policy/取消、范围变化和还原冲突。真实官方代理安装后，目标DNS、dispatch和外部socket均为零；卸载路由恢复原dispatcher。独立回环fixture验证单一固定地址、原Host、同源逐跳判定、跨源拒绝和响应取消后关闭。生产适配门拒绝fixture resolver；不把回环测试当作放宽公有地址限制的依据。没有真实AgentLoop运行、真实profile、桌面安装、外部目标或生产TLS验收；通用出口仍缺，IPv6 新增证据见下段。[合同](web-scope-contract.md) / [该阶段526项完整回归证据](evidence/web-scope-acceptance.json)。

新增 **V-NAT64**：[独立算法](../tests/nat64.test.mjs)14项、[原生解析观察](../tests/native-http-resolution.test.mjs)5项、[官方 HTTP 工具链](../tests/web-nat64-host.test.mjs)15项、[本地连接检查](../tests/connection-nat64.test.mjs)15项、范围服务新增4项与回执UI新增1项，共54项新增结果。覆盖六种标准前缀、歧义/非零u/未知发现、mapped IPv4、译址国家与表面国家相反、literal预判、原目标例外、发现总时限、取消/版本变化、回执持久化和升级前旧回执过期。官方路径精确断言33次假 lookup（16目标、17发现）与7个允许 Mock HTTP 跳，没有额外发现查询；真实连接器的固定 lookup 保留原 IPv6 与 Host/SNI，在创建 socket 前合成停止。每跳与主/子并发快照独立；原生私网与译址私网拒绝保持。[合同](nat64-contract.md) / [结构化证据](evidence/nat64-acceptance.json)。

V-NAT64 页面使用真实组件与现有CSS，在1280×900的回环合成预览中切换准备/结果；15项视觉和读回检查通过：新增DNS说明、连接候选/译址目标区分、不明与拒绝状态、转义及无横向溢出。模块/CSS均200，页面错误和console error为0，已有浏览器扩展的warning单独记录；服务和标签页已关闭。[结果页](nat64-results-preview.jpg)。这仅验证组件渲染与合成切换，没有调用后端检查 API，不能替代桌面嵌入或真实 DNS64 网络验收。

新增凭据与环境预检：

| 证据编号        | 入口                                                                                                                                              | 已覆盖                                                                                                                                      | 边界                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| V-CREDENTIAL    | [credentials.test.mjs](../tests/credentials.test.mjs)、[plugin.test.mjs](../tests/plugin.test.mjs)                                                | 安全投影、缺省保留/替换/显式清空、旧字段保留与显式清理、同ID类型/项目防转换、资产/服务引用；官方ToolRuntime与HTTP写后读回均无秘密，报告脱敏 | 元数据字段本身可读，不猜测文本中秘密；SQLite未加密；不执行登录或连接                         |
| V-ENV-PREFLIGHT | [catalog.test.mjs](../tests/catalog.test.mjs)、[environment.test.mjs](../tests/environment.test.mjs)、[plugin.test.mjs](../tests/plugin.test.mjs) | 变量非空/允许空、主机精确登记、密钥ID元信息、失效/权限未知、一次快照和配置revision；配置值/路径/未请求项不出结果；模型与HTTP一致            | 不读取密钥字节，不调用变量解析/导出，不改进程环境，不执行工具/网络；目录来源未知仍影响总状态 |

[controller.test.mjs](../tests/controller.test.mjs) 验证未知版本的回退、工作流/继续变更拒绝；活动执行者不能经普通角色/绑定/释放接口提前释放槽位。[plugin.test.mjs](../tests/plugin.test.mjs) 新增同项目不同父会话的模型工具隔离：只列自己的收据、拒绝读取/停止他人收据、拒绝替他人委派，合法调用补全当前父会话；该用例的执行者为假服务，不重复计算成实际 spawn 证据。

宿主相关测试未提供运行时变量时会明确跳过；公开 GitHub CI 不携带官方程序，跳过的项目不能算成官方模块通过。

工作区规则新增证据 **V-WORKSPACE-RULES**：`tests/workspace-rules.test.mjs`、`tests/rules-controller.test.mjs` 和 runtime 的 fallback 回归覆盖精确UTF-8、目录别名/链接范围、单文件及组合阈值、明确选择/清空和修订冲突。合成扫描不读真实用户规则。实际浏览器交互见 [工作区规则合同](workspace-rules-contract.md)。

新增 **V-MAINTENANCE**：[maintenance.test.mjs](../tests/maintenance.test.mjs) 的10项验证限定自身安装、缺可选服务、管理器所有权变化、重复请求合并、已接纳异步应用排空、准备失败仍清理独立步骤且不移除、显式重试、未知结果保留清理事实、安装记录读回和HTTP部分回执。[maintenance-ui.test.mjs](../tests/maintenance-ui.test.mjs) 的8项覆盖取消、双击、失败/未知与重启提示，终态不再请求插件接口；[toolkit.test.mjs](../tests/toolkit.test.mjs) 另运行真实原创Node探测进程，取消后PID消失且工具环境仍可用于下一次明确探测。均为临时合成边界，正式管理器另见下文。

## 官方模块隔离证据

| 证据编号   | 入口                                                                                                                   | 实际接口及观察                                                                                                                                                                                                                                                                                                                                                     | 边界                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| V-HOST     | [verify-host.mjs](../scripts/verify-host.mjs)                                                                          | 官方 Cordis、SystemPrompt、ApprovalService、SandboxPolicyService、Session/投影和 SubagentRuntime；真实 `createVolatile` 冻结引用，外层配置替换后深度/数量动态生效、原所有者更新保留，禁用/撤销恢复；提示词和审批审计保留                                                                                                                                           | 只核验实际导入入口的清单摘要，非整棵依赖/整个已安装应用完整性结论；不启动桌面或实际子进程代理                                     |
| V-PLUGIN   | [plugin.test.mjs](../tests/plugin.test.mjs)                                                                            | 真实 ToolRuntime/defineTool schema 与执行、SkillRegistry/provider、系统提示词/审批/沙箱及 SessionStore；mount→运行→dispose；模型工具写入同一存储后 HTTP/UI 数据接口读回；材料写入/备份恢复、模板读/搜索、目录当前会话强制绑定与跨会话拒绝；同会话及子代理绑定隔离；技能导入后可列/正文/引用可读、编辑删除目录失效；缺可选服务仍启动；释放路由/工具/provider/数据库 | webServer、connection 是受控 Service，认证与同源拒绝契约可测，未使用真实桌面认证；会话控制/工作区注册为假服务；未验实际浏览器嵌入 |
| V-LOG      | [extensions.test.mjs](../tests/extensions.test.mjs) 的官方模块用例                                                     | 真实官方日志插件持有的 config 引用通过临时替换动态读为 false，原引用保持不变，撤销精确恢复；不写 profile                                                                                                                                                                                                                                                           | 仅指定会话日志插件 `enabled`，不扩张成全应用隐私保证                                                                              |
| V-PROTOCOL | [verify-protocols.mjs](../scripts/verify-protocols.mjs)、[protocol-acceptance.json](evidence/protocol-acceptance.json) | 官方 AgentLoop→LlmRuntime→实际适配器/SDK 序列化→本地假 SSE fetch；四协议首轮、第二轮修改、官方创建的子会话首轮、503 后官方重试改正文；20 次传输捕获均与持久会话完整 messages 相等，重试新正文存在真实 `system/message` 事件；当前文本不进入人工 user 槽                                                                                                            | 合成密钥/文本和假 SSE；没有真实模型输出质量或服务端接纳证据；子会话为进程内官方所有权，未验外部代理进程                           |

新增官方模块隔离证据（包含在上述全量运行中）：

| 证据编号       | 入口                                                              | 实际接口及观察                                                                                                                                                                                             | 边界                                                                       |
| -------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| V-SESSION-HOST | [sessions-host.test.mjs](../tests/sessions-host.test.mjs)         | 官方SessionController/SessionQuery/WorkspaceRegistry/AgentLoop/LocalAttachmentStore/tool-todo：前缀分支、空分支、绑定/归档/排队停止、JSONL读回；1×1 PNG和文本附件读取；todo在turn/step边界的前缀与turn重置 | 临时合成会话；不恢复外部任务或强制改写较早待办；真实桌面输入未验           |
| V-RETRY        | [retry-host.test.mjs](../tests/retry-host.test.mjs)               | 官方 AgentLoop/LlmRuntime/llm-retry：0次重试只请求1次，2次重试最多请求3次；永久错误不扩张、Retry-After、用户取消、关闭/撤销；13个临时会话的完整 JSONL 事件读回                                             | 假 LLM 传输，无真实提供方；不将重试当新一轮继续                            |
| V-CONTINUE     | [continuation-host.test.mjs](../tests/continuation-host.test.mjs) | 官方 AgentLoop/followup 与消息构造；当前提示词与继续用语、真实人工计数1、插件来源、默认关闭、有界自动链、停止/关闭/新人工输入竞争、子代理拒绝；11个临时 JSONL 会话完整读回                                 | 原生入口要求 role:user，但 source 明确属于插件；无桌面 UI 或真实提供方验收 |
| V-WORKFLOW     | [workflow-host.test.mjs](../tests/workflow-host.test.mjs)         | 官方SubagentRuntime/spawn/AgentLoop/WorkingDirectory/预设与JSONL；创建/取消/释放；单槽两任务计划、原始收据传给后继、未验证标记保持、取消运行任务且排队依赖不启动、父会话保留                               | 明确任务与合成LLM流；不含自主拆解、外部代理进程、真实执行UI或持久预设迁移  |
| V-CATALOG      | [catalog-host.test.mjs](../tests/catalog-host.test.mjs)           | 官方 SkillRegistry/ToolRuntime 的会话层、受限可见性、覆盖顺序和正文；官方 MCP 桥注册 schema 可观察，依赖声明保持显式                                                                                       | 没有连接 MCP 服务或调用其工具；已登记不意味着连接健康                      |

新增 **V-MAINTENANCE-HOST**：[maintenance-host.test.mjs](../tests/maintenance-host.test.mjs) 共6项经过真实官方PluginManager、Cordis和WebServer，验证自身依赖/选择的移除语义、self-dispose后当前HTTP回执仍返回及后续404、关闭后store读取0次、有效SQLite重开后确认撤销与其他记录保留，用户技能/插件技能/材料/无关文件字节不变。stop-profile、包管理器失败、退出0但未移除依赖、安装自带拒绝和合成cancelled均不冒充完成。只核对直接入口库存摘要；runPnpm与HMR/Loader后端是假边界，没有实际包文件删除、真实HMR、用户profile或桌面重启，详见 [卸载合同](maintenance-contract.md)。

新增 **V-READ-LIMITS**：[read-limits.test.mjs](../tests/read-limits.test.mjs)、[read-limits-host.test.mjs](../tests/read-limits-host.test.mjs) 与 [合同](read-limits-contract.md) 共15项，使用固定npm SRI及库存校验的官方read、Cordis/Loader/HMR，临时文件通过合成FS服务读回。验证头尾、B=1/中文/非BMP/长行/流读、阈值、实际异步重挂/拒绝/异常/取消/回滚/恢复竞争、raw配置不持久化；工具路径拒绝、pre deny及post block保持。不是实际桌面文件权限或所有工具结果的验收。Root Controller另验证等待生效再enabled、失败全控制清理、缺能力不阻断、applying时仍排入更新、所有权冲突披露已保存revision。

本轮核心运行差距的新增证据：

| 证据编号              | 入口                                                                                                                                                                                            | 实际接口及观察                                                                                                                                                        | 剩余边界                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| V-PROMPT-SECTIONS     | [prompt-sections-host.test.mjs](../tests/prompt-sections-host.test.mjs)、[合同](prompt-sections-contract.md)                                                                                    | 5项官方组装测试：真实native/PTC、SDK renderer、plan状态；scope complete覆盖与撤销、disabled/append；功能段、tools/contexts/variables引用保持                          | PTC后端仅合成描述服务，未执行工具；MCP/交付等段为合成注册；原生workspace历史基线不在该修复内   |
| V-PERMISSION          | [permission-defaults-host.test.mjs](../tests/permission-defaults-host.test.mjs)、[合同](permission-defaults-contract.md)                                                                        | 8项合成+2项官方：17会话的新默认canonical事件、existing/seeded保留、官方set有效、never真实拒绝、volatile更新/重挂载/所有权与通知                                       | 活动目录为内存合成目录，JSONL经公开persistence句柄主动写后读回；未验证实际文件权限或桌面选择器 |
| V-REPEAT              | [repeat-reminder-host.test.mjs](../tests/repeat-reminder-host.test.mjs)、[合同](repeat-reminder-contract.md)                                                                                    | 6项合成+5项官方Loader/Cordis/ToolRuntime/HMR：三次临时文件调用、提醒关闭/恢复、拒绝/反馈保持；noSave不写配置，async/veto/失败/取消/冲突                               | 只控制建议；重挂载重置计数，在途旧监听器可能完成一条提醒；不等于桌面三入口验收                 |
| V-STEERING            | [steering-host.test.mjs](../tests/steering-host.test.mjs)、[合同](steering-contract.md)                                                                                                         | 3项官方AgentLoop：steer在下一步、followup在下一轮、cancel清队列与inject不唤醒；插件提示词启用，7次完整messages与物理JSONL重建一致                                     | 慢工具只等待内存gate，LLM合成；未验真实composer按钮、快捷键、UI传输                            |
| V-NATIVE-INSTRUCTIONS | [native-instructions.test.mjs](../tests/native-instructions.test.mjs)、[native-instructions-host.test.mjs](../tests/native-instructions-host.test.mjs)、[合同](native-instructions-contract.md) | 合成层8项及官方隔离11项：准确来源、旧/新基线与刷新、三策略、模型优先/并发、拒绝/取消、在途撤销、正常关闭、已加载fork遗留恢复；6会话28次完整请求与物理JSONL重建一致    | producer仍发现文件；未加载/异常遗留历史不自动打开，fallback语义差异与真实桌面仍未闭合          |
| V-FILE-PERMISSIONS    | [file-permissions-host.test.mjs](../tests/file-permissions-host.test.mjs)、[合同](file-permissions-contract.md)                                                                                 | 9项官方隔离、35次文件工具调用：read-only/workspace-write/full-access、显式限制优先、禁用/撤销、路径/软链接、观察与旧版本拒绝、预览后端、原生拒绝/取消、终端无后端失败 | 不含PTY/shell/内核沙箱、read_image/present/watch、扩大权限重试或桌面Gateway认证与渲染          |

根集成新增4项Controller检查：非法默认选择在落盘前拒绝、重复配置异步完成后才enabled、失败回滚、保存部分成功披露revision并继续独立更新、目录通知失败保留已启用事实。全量运行曾发现真实Cordis缺少hmr时的属性读取错误，已改为只读ctx.get；V-PLUGIN完整mount保留缺可选服务仍能应用和卸载的回归断言。

当前本机 `dsh-tool-fs`、`dsh-tool-bash`、`dsh-tool-pwsh` 与 `dsh-agent-instructions` 的入口摘要不匹配发行清单，没有执行这些安装入口，也未读取或恢复其他工具留下的备份。公开npm的tool-fs及agent-instructions确切版本归档通过完整性和库存校验，仅在临时运行时执行。原生工作区基线来自带来源的历史消息；当前适配器按准确来源处理步骤接纳与已有surface，并用物理JSONL证明请求一致，见 [原生规则证据](evidence/native-instructions-acceptance.json)。这不会修复实际安装，剩余边界见 [差距记录](native-instructions-gap.md)。Hook与第三方记忆的发行包及消费端调查尚未找到目标专用策略接口；通用事件或MCP段名不替代来源合同，见 [调查依据](hooks-memory-contract.md)。

初始基线的独立专项记录仍只支持其限定断言：主代理执行 `verify-host.mjs` 为 **14/14通过**，只读doctor确认 `0.2.1-rc.2 / darwin / arm64`。协议 artifact 的 `passed` 为 true、`networkRequests` 为 0、`blockedNetworkAttempts` 为 0，21 个直接导入入口（含延迟协议 SDK）摘要匹配清单。此结果不能推论未加载的模块干净，也不代表整个本机安装未被修改；不匹配模块不能用作官方原始证据。

官方客户端隔离共7项测试见 [client-bridge-host.test.mjs](../tests/client-bridge-host.test.mjs)：核对实际加载入口的官方清单摘要，在独立VM加载真实客户端 Session Controller、Conversation/InputHub/Lexical、FileUpload 与 Workspace 导航。使用内存存储、合成投影及公开 custom transport 上传测试钩子，禁止网络；验证文字、图片和文件的顺序、文件新收据、已有草稿保护、上传失败/取消、上传期间用户编辑保护、绑定与同步导航请求。没有启动应用、安装插件、真实可见切换或发送消息，导航仍为 `requested/navigationConfirmed:false`。入口摘要与附件合同见 [session-attachments-contract.md](session-attachments-contract.md)。

桌面 scheme 另做了已安装程序的静态核对：`dsh-app` 注册为标准、安全协议，`dsh-app://app` 的非保留路径会转发到官方 Host，包含本项目的 UI/API 相对路径；官方 iframe 通道也使用精确的 scheme `targetOrigin`。这些主进程/preload 文件不在本项目的模块摘要清单中，只作为当前安装的静态观察。尚未运行 renderer 读取实际 `location.origin` 和 `MessageEvent.origin`，因此 HTTP 预览不能证明桌面消息桥通过，也没有放宽为 `"null"` 或 `"*"`。

V-PLUGIN 另验证新模块的真实 ToolRuntime schema/执行与受控HTTP入口：未确认时工作区操作拒绝，模型不能调用确认或环境秘密action；秘密实际值不出现在公开读回、通用settings或status。计划工具强制调用者父会话与项目，不能用自填参数接管其他父会话。该计划入口测试使用合成coordinator；队列算法证据仍归V-PLAN。 新增凭据和环境预检使用真实模块实例：通过模型/HTTP往返确认秘密不回显、清空状态可读，环境预检不调用秘密解析或导出。附件读取/释放动作不在模型action白名单中。

四协议原生槽观察：

| 路径                    | 捕获到的系统位置                                            | 注意事项                                                                                |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 默认 DeepSeek 适配器    | 首轮顶层 `system`，后续更新为 `messages` 中的 `role:system` | 直接挂载官方适配器类并注入合成身份/文件回调，避开默认包装器的匿名身份落盘和本机文件索引 |
| PiAI Chat Completions   | `messages[].role:system`                                    | 使用合成 provider 配置，官方 SDK 负责序列化                                             |
| PiAI Responses          | `input[].role:system`                                       | 同上，无自行重写的协议转换                                                              |
| PiAI Anthropic Messages | 顶层 `system`                                               | 同上                                                                                    |

`in-history` 模式保留旧系统提示词作为历史审计；当前最新系统事件包含新正文，不要求抹除历史正文。重试刷新发生在官方 `agent/request` 与系统投影路径，仍由官方写入事件；检查完整 `options.messages` 与 `session.deriveMessages()` 相等，避免只改传输副本而日志仍是旧值。尚未把“回退后重发”和“手动/自动继续”纳入这份协议通过结论。

## 预览交互记录

主代理在1280×820本地预览中完成下列真实浏览器操作。保存类结果以服务端响应或重新读取确认，下载检查读取实际文件；全部输入均为合成数据，各次预览使用独立临时库，不将不同时点的资产数相加。

| 对照行为                           | 已操作与读回结果                                                                                          | 仍需区分的边界                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| RULE-LIBRARY、SKILL-LIST           | 创建规则、创建技能，保存后读取一致                                                                        | 未覆盖全部编辑/删除边界、官方技能实际调用                                 |
| SKILL-FOLDER                       | 通过目录选择器上传包含 `SKILL.md` 和 `references/local.txt` 的文件夹，导入结果为1个技能、2个文件、220字节 | 不是桌面嵌入或真实技能执行；ZIP选择器仍另验                               |
| DATA-LINK                          | 3节点、2边资产图实际渲染                                                                                  | 新增预览：有向 A→B→C 为2边，反向无路径，无向反查2边；跨区边界另见合成测试 |
| FLOW-SLOTS                         | 上限从3改为2，保存后读取为2                                                                               | 不是实际代理调度/并发强制证据                                             |
| DATA-KNOWLEDGE、DATA-KNOWLEDGE-USE | 创建含正文证据、标为verified的记录并读回；修改正文后已验证标记撤回，服务端读回为未验证                    | 新增模板交互见下表；未穷举全部 UI 组合                                    |
| DATA-REPORT                        | 点击导出下载实际Markdown文件，读回报告标题、3资产统计和本地证据说明                                       | 该报告在后续导入前生成；不代表旧版全部字段报告或任意数据集都已验          |
| DATA-IMPORT、DATA-ASSET            | 3行资产JSON导入结果为新增1/合并1/拒绝1，列表共4条；合并资产读回 `tcp/443`、`https` 及稳定服务ID           | 只验证当前资产JSON格式，不是任意采集包格式                                |
| DATA-SEARCH                        | 导入后的外网与host组合筛选返回2条，符合合成样本                                                           | 不替代其他筛选组合的独立合成测试                                          |

本轮新增预览：

| 对照行为                 | 已操作与读回结果                                                                                                        | 边界                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| DATA-FILES               | 文本 A（70字节）覆盖为 B（63字节），重开页面后恢复 A，SHA-256 相同且 B 留有新备份；34字节 GIF 上传后浏览器实际解码为1×1 | 合成材料，不代表所有图片格式均完成像素解码验收   |
| DESK-ENTRY / V-DRAFTS    | 控制页跨页恢复编辑，保存后清除；资产 A 弹窗关闭后恢复、资产 B 不串稿、主动丢弃清除                                      | 面板内存，不是宿主 composer                      |
| TOOL-CONFIG / TOOL-PROBE | 四类路径保存读回，合成 httpx 可执行文件固定版本探测显示产品标识                                                         | 不是实际扫描工具可信性/执行验收                  |
| V-CATALOG                | 新建原创合成技能，项目来源筛选、完整正文读取；未声明依赖显示 unknown。环境明确声明 nmap 后显示缺失/blocked              | 预览无官方目录，明确显示来源不可用；没有执行工具 |
| V-TEMPLATES              | 正文标记命中160字节 YAML，全文与 SHA-256 读回；整理成知识条目保留来源摘要且读回未验证                                   | 不执行模板；修复并复验新条目不再误报撤回历史验证 |
| V-WORKFLOW / V-CONTINUE  | 预览缺官方服务与绑定父会话时，分派/预设按钮禁用；自动继续默认关闭、上限3、相关设置禁用且说明不生效                      | 只验证缺服务页面，实际执行 UI 未验               |
| SESSIONS                 | 无真实宿主会话时显示空状态，明确无 composer 桥且回退禁用                                                                | 不替代官方桌面回退验收                           |

本轮入口与环境页面补测（1280×820，全部为临时合成数据）：

| 对照行为                 | 操作与读回                                                                                                                                         | 边界                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| AUTH-ONBOARD/PERSIST     | 5秒初始禁用、滚动到底才开放已读、缺一个勾选不可进入、全部完成进入原项目；刷新保留确认；诊断撤销后再次要求确认，普通设置仍可进入                    | 无真实安装/卸载；清理失败的重试由合成服务测试覆盖        |
| ENV-ONBOARD/SECRETS      | 明确跳过、保存合成秘密后password清空、留空保留、显式清空及重新设置；普通变量读回、主机列表保存、跨页重读秘密不回填；双页面旧修订拒绝覆盖并清空输入 | 没有真实凭据、进程消费或连接；配置未加密                 |
| ENV-SECRETS              | 登记自建39字节普通文件，只读回权限600与元信息；结束后确认该文件仍存在，再清理测试文件                                                              | 文件不是密钥，不证明密钥有效                             |
| FLOW-DISPATCH / V-DRAFTS | 明确计划示例JSON可校验，非法JSON有错误；跨页保留同一编辑，显式放弃后清除；缺官方执行服务时提交按钮禁用                                             | 预览没有实际计划执行；状态/结果/停止由模块与入口测试覆盖 |

本轮另以独立临时库完成以下1280×820浏览器操作（不是官方客户端）：

| 目标行                       | 实际操作和读回                                                                                                                           | 边界                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| DATA-CREDENTIAL              | 保存原创合成秘密；重新编辑密码为空；未保存名称可恢复，密码和清空勾选不恢复；空输入保存保留原秘密状态，明确勾选后清空，替换后仅显示已保存 | 无真实账号或登录；资产关联为合成记录；截图不含秘密                                                            |
| FLOW-PREFLIGHT / ENV-SECRETS | 声明合成变量与主机，缺失时blocked；保存配置后相应行ready；登记47字节自建普通文件，密钥ID元信息ready；清空变量后再次blocked               | 普通文件不是私钥；未读文件内容；官方技能/工具注册表缺失，因此全部环境项ready时整体仍为unknown；不伪装为可执行 |

截图见 [credentials-preview.jpg](credentials-preview.jpg) 和 [preflight-preview.jpg](preflight-preview.jpg)。浏览器console warning/error为空；结束后关闭临时页、重置视口、停止预览并确认端口无监听，临时库自动清理，自建元信息样本确认内容未变化后删除。所有上传、模型和会话行为仍仅有上述官方模块隔离证据。

新截图见 [admission-preview.jpg](admission-preview.jpg) 与 [environment-preview.jpg](environment-preview.jpg)。预览结束已关闭两个临时页、重置尺寸、停止服务并核对无端口监听；临时库和元信息样本已核对为本次合成数据后清理。

本轮浏览器控制台未观察到 warning/error。新目录截图见 [catalog-preview.jpg](catalog-preview.jpg)，材料恢复截图见 [materials-preview.jpg](materials-preview.jpg)。初始基线合成预览截图见 [ui-preview.jpg](ui-preview.jpg)。截图证明该视口的最终渲染；上述保存、筛选和下载结论来自实际操作与读回，不能仅由截图推断。

官方桌面嵌入、真实安装与卸载、重启/升级、真实会话草稿桥、多模式工具权限、真实模型联网全部仍待单独授权和验收。未保存内存状态已有限定证据；全部表单失败路径、真实桌面技能调用、外部代理并发仍未因此提升为通过。

本轮工作区规则预览在1280×720完成：父子候选与超限禁选、全文与摘要、取消不保存、确认保存及清空、旧修订冲突保留弹窗，具体修订读回见 [工作区规则合同](workspace-rules-contract.md)。最终控制页也实际检查了read正文预算禁用、0沿用宿主及不生效说明。两次临时页console warning/error均为空；页面和临时服务已关闭，合成文件及临时库已清理。

原生规则策略另做1280×720回环预览：三种策略名称可见，缺官方接口时明确提示只处理本插件所选规则；选择strict后保存revision 0→1，重新加载页面读回strict和revision 1。应用按钮仍禁用，console warning/error为空。截图 [native-rules-preview.jpg](native-rules-preview.jpg) 只含合成数据；尚未验证真实桌面的原生能力可用分支。临时标签及服务已关闭，端口无监听；本次合成库和空目录经核对后清理。

卸载新增1280×720合成回环预览：技能页显示最多200普通文件；打开卸载确认后取消，服务端移除调用0次且未收到卸载API。再次明确确认后，合成管理器调用1次，Controller清理全部返回完成，设置enabled与入场accepted均为false，原合成项目仍在。管理器关闭临时库和撤下路由后，页面显示只读回执、导航禁用，未再请求status或数据，后续请求计数0。console warning/error为空；截图 [uninstall-preview.jpg](uninstall-preview.jpg)。该预览的管理器是合成服务，与上述真实官方管理器测试分别记证。临时页、服务和数据库已清理；真实桌面未操作。

连接检查新增1280×720合成回环预览：取消单项预览与未登记目标预览均未发连接；3次明确确认共5次底层连接，系统DNS调用0次。实际观察HTTP 403响应、已关闭端口拒绝、6秒超时、主动停止取消、TCP监听连接和缺失监听端不支持；3条HTTP请求均为HEAD，含一次原样查询参数和两次slow样本，TCP未产生HTTP请求。编辑合成记录后旧结果标过期，刷新及页面重新加载仍读回持久状态且不新增连接。console warning/error为空；截图 [connection-checks-preview.jpg](connection-checks-preview.jpg) 和上述JSON汇总仅含合成数据。临时页面、进程和SQLite已清理；真实DSH仍未安装，地区与通用出口缺口保留。

## 本地复验命令

在项目根目录执行，Node 至少 `24.13.0`；可将 `NODE_BIN` 设为已提供的 Node 24 路径。命令使用当前机器已安装官方运行时，不下载、不安装插件，不选择用户 profile。

```sh
NODE_BIN="${NODE_BIN:-node}"
"$NODE_BIN" --version
"$NODE_BIN" scripts/check.mjs
"$NODE_BIN" --test tests/*.test.mjs
"$NODE_BIN" scripts/build.mjs
```

官方模块检查须显式提供运行时，默认 macOS 安装路径可按实际安装改写；摘要不匹配即拒绝作为干净官方证据。路径不应指向旧插件或 profile。

```sh
export DSH_UNLIMIT_RUNTIME="${DSH_UNLIMIT_RUNTIME:-/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh}"
"$NODE_BIN" --test tests/*.test.mjs
"$NODE_BIN" scripts/verify-host.mjs --runtime "$DSH_UNLIMIT_RUNTIME"
"$NODE_BIN" scripts/verify-protocols.mjs --runtime "$DSH_UNLIMIT_RUNTIME"
```

读取窗口、文件权限及原生规则官方测试还需要固定公开归档；测试本身不会联网下载，取得与各合同一致的tool-fs和agent-instructions归档后可运行：

```sh
export DSH_UNLIMIT_OFFICIAL_PACKAGES="/path/to/ignored/official-packages"
"$NODE_BIN" --expose-internals --test tests/*.test.mjs
```

两个环境门任一缺失时相关官方测试跳过；显式配置后缺归档或摘要不匹配则失败。该隔离夹具用Node解析钩子加载临时副本，`--expose-internals` 仅用于测试进程，不修改桌面启动配置。

需要更新协议证据时，先保留本地运行结果，再去掉请求正文示例，生成公开的合成摘要：

```sh
mkdir -p artifacts
"$NODE_BIN" scripts/verify-protocols.mjs --runtime "$DSH_UNLIMIT_RUNTIME" > artifacts/protocol-acceptance.json
mkdir -p docs/evidence
"$NODE_BIN" --input-type=module <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const evidence = JSON.parse(readFileSync("artifacts/protocol-acceptance.json", "utf8"));
if (evidence.passed !== true) throw new Error("协议验证未通过，不能更新通过证据");
delete evidence.defaultProviderRequestExamples;
writeFileSync("docs/evidence/protocol-acceptance.json", JSON.stringify(evidence, null, 2) + "\n");
JS
```

独立 UI 预览使用临时合成库，只监听回环地址；结束时 Ctrl-C 释放本次进程和临时数据。预览不是实际宿主。

```sh
"$NODE_BIN" scripts/preview.mjs --port 4177
```

浏览 `http://127.0.0.1:4177/dsh-unlimit/ui/`，使用 1280×820 视口复验上述步骤。离线打包可执行 `"$NODE_BIN" scripts/pack.mjs`，会构建并调用本机 npm 离线生成包；包生成不等于已安装、可启动或桌面验收。后续完整结果应同时记录工作树修订、环境、命令退出码、失败/跳过和新增交互证据。

## 来源与包内容边界

`30b3c61` 批次只读比较当时 `src/web/scripts/tests` 中69个实现/样式文件与参照仓库61个非空源码/素材摘要，未发现整文件字节相同项；该计数不是新增文件的复验结果。这个检查不覆盖片段复制或变形相似，不能据此作法律上的权利结论。开发接触既有实现的事实仍按 [NOTICE.md](../NOTICE.md) 披露；旧项目的版权和许可证未被删除或改写。

新包只包含本项目源码、界面和文档，运行时不分发官方程序、Node.js、其他插件或真实profile。打包和导入验证不执行 mount；本轮未安装到桌面。

本轮运行控制预览为1280×720，使用项目临时SQLite：缺官方服务时新会话默认和重复提醒下拉框禁用、原因可见，应用按钮禁用。提示词保存revision 0→1，随后重新载入逐字读回（含字面花括号）；保存后刷新状态。截图 [control-defaults-preview.jpg](control-defaults-preview.jpg) 仅含合成数据。临时服务、浏览器标签和数据已清理；不等于真实桌面可用目录选择或启用验收。

## 本轮回退与报告补齐

**V-REWIND-PROTOCOL**：[rewind-protocols-host.test.mjs](../tests/rewind-protocols-host.test.mjs) 在真实官方 SessionController、AgentLoop、JSONL 与四个协议适配器下，从两轮实际合成执行回退第二轮，再显式编辑重发。20 次假 SSE fetch 均与请求时 Session 派生内容一致；较早输入与当前系统正文保留，撤回输入和内部标记不进入请求，HTTP400 为 error、用户取消为 aborted。28 个官方入口和 lazy SDK 摘要匹配；假凭据/传输，不代表提供方接纳或真实桌面操作。摘要见 [协议证据](evidence/rewind-protocol-acceptance.json) 与 [合同](rewind-protocol-contract.md)。

此测试发现官方 fork 的精确前缀可继承被撤回轮次的入队事件。实现现在先用公开 cancel/whenIdle 清理新分支队列再归档原会话；保留审计事件，不让撤回文本重新入场。失败返回 settle-new 部分结果与新分支编号。

**V-SESSION-HOST** 本轮增加4项真实 startActivation/catalog 用例：主会话第二轮创建后又有第三轮仍正确定位第二轮、首轮空分支、重复 catalog 写前拒绝、调度轮次不能借用前轮人工输入。该文件9项通过；子代理停在可取消的 pre-step，未调用模型。合成层另验嵌套来源、被插话后拒绝、祖先并发锁、队列清理失败与结果转义；后续激活的普遍来源映射仍缺，见 [子代理合同](child-rewind-contract.md)。

**V-REPORT**：[report.test.mjs](../tests/report.test.mjs) 的3项用例覆盖空库、完整现有字段与12类记录、17条证据记录、计分去重/阶段归属、关联与来源、凭据整条隐藏及嵌套脱敏、跨区拒绝。query_only 下报告前后所有 entries/metadata 逐行一致，重复构建结果一致。保留 stats 原字段并增加记录分类/评估/测试/关系/事件计数；未执行引用文件或网络。详见 [报告合同](report-contract.md)。

1280×720 回环预览核对报告完整正文，合成3资产、2关系、1发现、15分读回一致，页面无控制台错误；导出点击出现下载提示，本轮未取得对应下载文件，因此不把提示当作文件验收。截图见 [报告预览](report-preview.jpg)。同尺寸独立组件预览使用实际 web/rewind.js 与 styles.css，核对创建来源与切点、队列清空、草稿未发送、导航未确认及部分失败提示，见 [回退结果预览](rewind-result-preview.jpg)；这不是实际宿主回退窗口的交互验收。两个回环进程均已停止，合成临时库按本轮工作区ID核验后清理。

## 交接修复与后续执行证据（2026-10-21）

交接时以 `0bc13d2` 为已验代码基线。18 个未提交文件先完整备份并核对摘要；随后恢复真实来源说明和 117 项验收前五列，移除后来加入的宿主文件修补、卸载删除规则库、自动重启和 Web 适配要求。[来源记录](provenance.md) 保留早期接触既有实现的事实，不以重命名或脚本通过声称严格净室开发。

**V-HANDOFF-REPAIR**：统一官方包入口校验保留，但修复了 continuation 的未定义变量、清单错误原因丢失和过期结果缓存。入口必须位于指定运行时内，版本和 SHA256 每次解析重新核对；校验仅覆盖入口，不是全依赖或发行来源证明。合成 fixture 提供真实摘要清单，没有关闭正式校验。新增失败后修复重试、加载中取消、清单/版本/摘要变化及路径越界回归。来源检查不再禁止版权/许可/署名文本；分层检查只报告已识别字面量模块引用，发布文件检查由实际打包清单承担。固定 [验收基线测试](../tests/parity-baseline.test.mjs) 防止改弱要求。

修复阶段使用宿主附带 Node `v24.21.0` 运行全套隔离回归，**604 项通过、0 失败、0 跳过**。这是后续新增文件交付和模式执行测试之前的阶段结果，不能当作这些新增测试的结果。检查器负例包括复合文件后缀、core 跨层引用、许可声明允许及验收基线被改弱时失败。

**V-ESCALATION**：新增 [官方单次权限扩大测试](../tests/escalation-host.test.mjs) 10 项通过。read-only 写入先拒绝，经真实官方审批 allowed-once 后，原工作区写入成功并读回；下一次普通调用仍受限，额外目录字段不能扩根，系统临时目录原生可写性单独披露。拒绝、取消、不可用、迟到同意及显式 never 均保留。详见 [合同](escalation-contract.md) 与 [证据](evidence/escalation-acceptance.json)。任意新增目录授权仍不支持。

**V-DELIVERABLES**：[官方文件交付测试](../tests/deliverables-host.test.mjs) 9 项通过。真实 write/present、调用方声明、两份临时 JSONL 重新读回、官方打开处理器、文本页与原始字节读取均执行。Connection 注册和最终桌面打开为捕获边界，不能算真实认证传输或应用启动。工作目录变化不重定向既有绝对路径；缺失/符号链接/无效坐标/取消不打开。详见 [合同](deliverables-contract.md) 与 [证据](evidence/deliverables-acceptance.json)。

**V-MODES-EXECUTION**：[模式执行测试](../tests/modes-execution-host.test.mjs) 8 项通过。真实 native/plan 文件读取、官方 UserQuestionService 和 PlanModeController 执行，合成人答覆盖同意、拒绝、反馈、取消、无提供方；只有手动驱动的 accepted pre-step 提交计划退出。本插件 replace 和 autoApprove 不绕过计划审核。没有实例化 AgentLoop 或启动完整预设，不能代表全部四模式通过。PTC 调查中的系统沙箱拒绝仍保留为缺口。详见 [合同](modes-execution-contract.md) 与 [证据](evidence/modes-execution-acceptance.json)。

新增证据使用原创临时文件、合成会话和独立 JSONL 根；不安装或重载插件，不改真实 DSH 配置。普通测试不会覆盖固定证据文件，仅显式证据环境开关允许更新；历史证据摘要仍对应其原有修订，不能自动外推到本次 helper 变更。

最终整合回归使用同一官方 Node `v24.21.0`，**621 项通过、0 失败、0 跳过**；语法 136/136、格式、来源记录与有限分层检查、构建和本地打包均通过。三个新增证据文件的源码摘要与本批文件逐项匹配，117 项前五列与 `0bc13d2` 一致。本批没有 UI 源码变更，未重复旧页面预览；官方交付界面仍须在获准安装后另验。公共 CI 未配置本机官方运行时，应明确跳过官方模块测试，不能将其成功等同于本机 621 项结果。

## 交付呈现与来源核查（2026-10-21）

**V-DELIVERY-CONTENTS**：项目首页改为介绍自身操作，完整功能明细和当前限制移入 [用户指南](user-guide.md)。公开仓库保留来源历史、117 项验收、规格和执行证据；安装包仅保留用户指南、合成界面截图及 README/NOTICE，开发记录由公开仓库链接访问。没有删除原参照项目的版权和许可，没有把来源检查改成品牌词禁令。

[实际发布清单回归](../tests/package-contents.test.mjs) 在 Node `v24.21.0` 下执行现有 build 和离线 `npm pack --dry-run --ignore-scripts`：运行入口与全部运行资源齐全，docs 精确限定两项，资料目录不入包，所有随包 Markdown 的相对文件链接均有对应文件。真实本地打包生成 66 个普通文件、解压总计 894,726 字节；逐字节对应工作区，解压后 3 个服务入口导入通过，未调用 mount。这个结果不等于插件安装或桌面运行通过。

来源比较绑定上一提交 `9bbeaa0`；范围、短表达候选和方法局限见 [来源核查记录](provenance.md#2026-10-21-本地来源核查)。未发现整文件或所设较长片段一致不能证明无版权义务；本批没有仅为降低相似性指标而改写算法。当前许可状态仍为 `UNLICENSED`。

**V-WEBTOOLS**：新增 [网页工具官方隔离测试](../tests/webtools-host.test.mjs) 10 项通过。真实 ToolRuntime → web_fetch → WebRuntime → HTTP provider 在假 DNS 和 Undici MockAgent 传输下完成主会话文本、子会话 HTML 与计划模式抓取，保留 URL、状态与不可信网页数据标记；正文不进入系统段，没有触发 canary 工具或额外请求。该结论只覆盖工具返回和服务副作用，没有运行收到网页后的 AgentLoop 或真实模型。

提供方不可用、单子代理限制、PTC 直接调用和工具注册释放均返回真实失败；完整预设未挂载，minimal/PTC 的预设声明只作清单校验后的只读检查。另启动任务专用真实回环网页，官方未修改 resolver 的调用返回 `WEB_BLOCKED_URL`，服务收到 0 请求且已关闭；这不是成功回环抓取。证据记录 267 个实际加载运行时文件校验和 19 条直接入口/预设摘要。详见 [合同](webtools-contract.md) 与 [执行证据](evidence/webtools-acceptance.json)。

本批最终整合在官方 Node `v24.21.0`、显式指定的 `0.2.1-rc.2` 运行时及已核验官方归档下运行 `node --expose-internals --test tests/*.test.mjs`，**632 项通过、0 失败、0 跳过**。语法 138/138、格式、有限来源/分层检查、117 项验收基线和本地打包均通过。网页工具证据的两项源码摘要与最终文件匹配。没有 UI 源码变更，未重复页面预览；没有安装、重载或改真实 DSH 配置。公共 CI 没有上述本地运行时，官方模块测试仍按环境门跳过。

## IP 解析模块重写与消费者复验（2026-10-21）

**V-IP-BYTES**：把来源核查中的两处 IPv6 局部解析替换为本项目新编写的 [字节解析模块](../src/core/ip-bytes.js)。模块编写子任务只使用输入输出合同、项目指导/元数据、RFC 4291 §2.2 和 Node 官方 API 文档；主任务再接入国家数据库与 NAT64，保留 IPv4-mapped 折叠、显示规范化、特殊地址拒绝和译址布局。编写资料和边界见 [设计记录](ip-bytes-design.md)，不将局部重写外推为整个项目的法律独立证明。

新增 6 项单测使用原始字节构造的向量，覆盖 36 个 IPv6 零压缩区间、21 个嵌入 IPv4 尾部压缩区间、逐字节取值、拒绝语法和返回 Buffer 隔离。另用 Python 标准库 `ipaddress` 生成 3,165 个确定性表示，以其网络序字节为独立预期，逐项比对全部一致；仅本地文件，无 DNS 或网络访问。国家数据库、NAT64 与范围规则的专项共 54 项通过。

首次无监听权限的消费者回归有一项回环服务 `EPERM`，按正式工具审批执行完整回归。第一次完整回归为 637 通过、1 失败：原有卸载探测测试未在约 1 秒内看到合成子进程就绪文件，期间另有检查/构建并发运行。该用例单独执行通过；没有改动它的断言或等待时限。停止并发构建后，以原命令重新执行全套，结果为 **638 通过、0 失败、0 跳过**。第一次失败仍记录为测试调度时限的未解决不稳定性，不把复跑成功写成测试已修复。

最终使用官方 Node `v24.21.0`、显式 `0.2.1-rc.2` 运行时及已核验归档；语法 140/140、格式、来源/分层、117 项验收基线、构建与离线打包均通过。新包含 67 个普通文件。历史 NAT64/网络证据保留其旧源码摘要；本批执行结果和当前源码摘要另存 [IP 解析验收](evidence/ip-bytes-acceptance.json)，没有直接刷新旧证据冒充复验。没有安装、重载或修改真实 DSH 配置，也没有真实网络目标、模型或数据库数据参与。

## 素材核查与文件格式修正（2026-10-21）

**V-MATERIAL-PROVENANCE**：实际逐张查看 17 张项目截图和 11 张参照位图，并核对 `src/`、`web/` 的静态资源表达。未观察到原作者品牌、宣传素材或已查看位图的裁剪改色复用；参照 SVG 未查看，历史截图生成会话未重演，视觉差异不构成法律独立证明。详细范围、摘要和首次提交见 [素材证据](evidence/material-provenance.json) 及 [来源记录](provenance.md#图片界面资源与随附文本核查2026-10-21)。

13 张误用 `.png` 后缀的 JPEG 已更名为 `.jpg`，同步文档、发布白名单与既有发布回归中的路径。17 张截图与 `a0e9e6d` 的文件字节全部一致，没有修改页面、图片像素或运行逻辑。包内容/文档链接、117 项验收基线、来源检查的专项共 **9 项通过、0 失败、0 跳过**，使用官方 Node `v24.21.0`。本批未重跑上节 638 项全套，不把历史计数当作本批执行结果；也未重复 UI 预览或进行真实 DSH 安装与配置变更。

语法 140/140、格式、有限来源与分层检查、构建及离线打包通过。实际包包含 67 个普通文件、解压总计 894,566 字节，SHA-256 为 `4a32c500762ecc6f8b36bd42562be7af2e3211ea2c506b82fb88f3df93760c7b`。逐文件字节与工作区一致，文档只含用户指南与 `ui-preview.jpg`；临时解压后四个入口导入成功，未调用 mount，解压目录已清理。

## 官方模式执行循环补充（2026-10-21）

**V-MODES-LOOP**：新增 [modes-loop-host.test.mjs](../tests/modes-loop-host.test.mjs) **7 项通过**，由真实官方 AgentLoop 调度官方 read 和 exit_plan_mode。7 个临时会话、14 次合成 LlmAdapter 请求、10 次工具调用（5 次真实临时文件读取、5 次计划退出工具）；每个会话通过官方 JSONL reader 重读并与内存事件逐项比较。测试没有直接执行工具或手工发送 pre-step。

批准路径读回四步的计划状态为 true/true/false/false，明确确认同批第二个工具仍处于计划状态、下一步才提交退出；提示词替换持续存在且计划指导段随真实边界退出。另验证拒绝保持计划、关闭审阅实际结束当前轮次、取消信号到达审阅方并以 aborted 收尾、缺审阅方返回 NO_PROVIDER，以及撤销插件后自定义提示词消失而官方工具 schema 与读取仍正常。详见 [执行合同](modes-execution-contract.md#官方-agentloop-执行补充2026-10-21) 与 [结构化证据](evidence/modes-loop-acceptance.json)。

本批只增加验收测试和证据，未修改产品运行逻辑或 UI。完整回归使用官方 Node `v24.21.0`、显式 `0.2.1-rc.2` 运行时及固定官方归档，结果为 **645 项通过、0 失败、0 跳过**。模型响应和人类审阅均为明确的合成输入，不是实际模型决策或桌面交互；JSONL 读回不是冷启动恢复。完整 standard/minimal/PTC 预设、极简终端与 PTC 后端仍未通过验收；没有以本批结果覆盖这些缺口。

同时只读核对完整预设的加载来源：三份 `dsh-web-app/presets/{standard,minimal,ptc}.patch.yml` 摘要匹配发行清单，但安装的 `dsh-web-app/cordis.patch.yml` 本体不匹配。后者只读结构后即从官方可信结论中排除，没有执行或修改；其他已知修改入口也未执行。后续完整预设需使用可核验的隔离副本与真实 Loader/Registry，而不能把当前逐项挂载服务改称完整预设。

语法 141/141、格式、有限来源与分层检查、117 项验收前五列、构建及离线打包均通过。新增执行证据的五项源码摘要与最终文件一致。安装包仍为上节的 67 项和相同 SHA-256，逐文件字节核对通过；没有把新增开发测试放进运行包，没有重复页面预览、真实安装或配置变更。

## 子代理最近输入来源记录与回退（2026-10-21）

新增 `ChildOrigins` 观察器及 `childOrigin:latest` 读回路径，默认创建来源保持原样。记录器仅在总开关与运行控制均启用时，使用官方 `appendPluginRecord` 保存父调用/子会话/消息 ID 的关联元数据；不含正文、不进入模型消息。旧日志没有记录时不猜测来源。合同、数据形状和未支持路径见 [子代理来源回退](child-rewind-contract.md)。

- `tests/child-origins.test.mjs` **40 项通过**：启停、重连、去重、错误身份/来源/边界、发行摘要失败及写入失败。此文件使用原创合成模块外壳，不作为官方模块证据。
- `tests/sessions.test.mjs` **30 项通过**，保留原 23 项，新增最近接纳输入的 pending/consumed 对照、拒绝不完整链、嵌套消费时点、初始任务跨自动轮次、精确一步切点及界面转义。明确检验缺失 turn/step 不能以 undefined 相等蒙混通过；默认创建链的原严格嵌套断言仍存在。
- `tests/sessions-host.test.mjs` **11 项通过**，保留原 9 项并新增官方标准 `send_message` 两条路径。驻留子代理：真实 ToolRuntime 投递、子 inbox 的准确 ID、新父元数据、物理 JSONL、prepare 根切点、实际 fork/archive/cancel 与新分支 JSONL 连通；冷恢复：同一稳定 child 身份、没有第二 catalog、最近输入 prepare 定位。父 turn/assistant/tool-call/result 外壳由 fixture 手动构造，使用官方消息构造器及严格 JSONL 校验；没有真实模型调用，不冒充 AgentLoop 完整调度或桌面验收。
- 本机官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时及已校验官方归档的完整回归：**694 项通过、0 失败、0 跳过**。包含真实 Cordis mount 集成，不读取真实会话、不发送网络模型请求。结构化记录见 [证据](evidence/child-input-origin-acceptance.json)。

页面预览使用 1280×720 本地回环页面、独立临时库及明确标注的模拟父 iframe/草稿桥。实际操作“会话管理 → 回退 / 分支”，确认默认创建来源，改为最近接纳输入并提交；服务端读回 `childOrigin:latest`，结果显示输入关联依据、根会话切点和草稿未自动发送，两个选择器锁定。使用产品真实 app.js/rewind.js/CSS；回退和草稿桥响应为合成桩，不能证明实际 DSH 输入框、导航或安装成功。截图及请求读回保存在本地 `artifacts/child-input-ui-preview.jpg`、`artifacts/child-input-ui-request.json`。

未改真实 DSH 配置，没有安装、重载或操作真实会话；117 项验收前五列保持原基线。未记录旧历史、直接 API、PTC 内部调用来源、外部任务状态恢复和桌面实际交互仍有差距。本批不改来源事实、原仓库、第三方声明或许可证状态。

本批发布检查：语法 **144/144**，格式、有限来源与分层检查、构建及离线打包通过。实际 tgz 共 **69 个普通文件、909950 字节解包内容**，逐文件与工作区一致；隔离解包后导入 plugin、sessions、child-origins、child-rewind 入口成功，未 mount。包 SHA-256：`594267249fc74d3732df29211d440a61bf18623716eaf0edd8026099f68fc397`。运行包仅带用户指南和既有概览截图等允许项，不含官方模块、开发测试、profile 或数据库；临时解包目录已清理。

## 完整 standard 预设执行补齐（2026-10-21）

在 `399f674` 后包含本文的工作树新增 [完整预设测试](../tests/presets-host.test.mjs)，以未删减的官方 `standard.patch.yml` 经真实 Loader/Registry 加载，并将 Agent 精确绑定当前保留的 revision scope。29 个声明条目逐项核对，其中 26 个 active，macOS 的 pwsh 和两个管理工具按原声明禁用；实际 30 种工具 schema 精确匹配预期，并在全部模型请求及撤销适配后保持一致。

专项 **4 项通过**：完整预设读取、预设内计划审批及撤销恢复三个场景，加一个父测试。真实 AgentLoop 执行 read 5 次、exit_plan_mode 1 次；8 次模型响应和一次计划人答是明确合成输入。3 个会话经官方 JSONL reader 读回，与内存事件逐项一致。官方 persona 替换/恢复、完整计划段保留及批准后下一步移除均比较实际投影与请求；不公开官方正文。详见[合同](modes-execution-contract.md#完整-standard-预设隔离执行2026-10-21)和[执行证据](evidence/presets-acceptance.json)。

为排除本机已修改入口，测试从固定公开 npm 归档建立临时运行时；校验 SRI、发行库存与每个实际加载文件摘要，未覆盖应用目录。所需 Host 服务使用官方实现，存储、连接凭据和工作区均在新建临时根；模型和人答之外没有替代所需服务。网络、子进程及文件越界守卫均无触发，临时根已清理，5 个已安装入口摘要前后不变。证据的 8 项项目源码摘要与当前文件一致，535 个实际加载官方文件摘要已记录。

主线随后以官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时和固定归档执行 `node --expose-internals --test tests/*.test.mjs`，结果 **698 项通过、0 失败、0 跳过**。117 项验收前五列保持原基线。本批只增加测试、依赖校验和准确文档，未改产品运行逻辑、UI、真实 DSH 配置或安装状态。

本证据只缩小完整 standard 预设的加载、读取与计划切换缺口。其余已声明工具未执行，极简终端、PTC 后端、真实模型和桌面交互仍未验；未将预设加载或公共 CI 成功当作这些路径完成。公共 CI 没有本机运行时与归档，应按环境门跳过官方测试。

本批发布检查：语法 **146/146**，格式、有限来源/分层检查、构建与离线打包均通过。安装包仍为 **69 个普通文件、909950 字节解包内容**，SHA-256 保持 `594267249fc74d3732df29211d440a61bf18623716eaf0edd8026099f68fc397`；逐文件与工作区字节一致，临时解包后四个宿主入口导入成功，未 mount。新增测试、官方归档和证据不进入运行包。没有 UI 改动，未重复预览，也没有真实安装或配置变更。

## 子代理限额与首轮角色正文（2026-10-21）

本批在 `6fdee8b` 后的工作树补充两组执行证据，保留既有测试、来源说明、第三方归属与 117 项验收前五列，只更新对应状态。产品变化是限额页面的计数说明，以及与既有校验一致的深度输入上限 64。

- `subagent-limits-host.test.mjs` 共 **5 项通过**：完整 standard 预设下实际执行 18 个子／孙代理，12 次超数量或深度请求由官方拒绝；验证热改、释放后复用、驻留树共享池、两个根独立计数、本地演练槽分离和撤销恢复官方默认值。拒绝无假启动、完成 JSONL 与全生命周期清理均有断言，见 [合同](subagent-execution-contract.md) 和 [证据](evidence/subagent-limits-acceptance.json)。
- `workflow-host.test.mjs` 共 **6 项通过**，保留原 5 项。新增角色场景经 7 次合成传输核对真实 AgentLoop 首轮 system 槽、两个逻辑工作区、未分配与普通会话、显式撤销、运行控制还原及原生 schema 保留，见 [角色合同](workflow-plan-contract.md#首轮角色正文的官方隔离验证2026-10-21) 和 [证据](evidence/workflow-role-acceptance.json)。模型响应是合成输入，不包含真实工具或 MCP 调用。
- 复核发现工作流 fixture 原先先恢复 mock、再清理服务，零调用断言未覆盖清理期。本批改为单一清理入口，先处置工作流、运行控制、角色资源、官方服务和临时目录，再检查外部调用计数并恢复 mock。修复后完整回归重新通过。
- 极简模式只完成执行前提的静态核实：固定官方 npm 归档的 24 个库存文件和 3 个本机原生文件摘要匹配。没有运行持久终端或原生模块；不得把标准读取路径当成极简执行证明，见 [合同](modes-execution-contract.md#极简模式执行前提的只读核实2026-10-21) 和 [静态记录](evidence/minimal-contract-discovery.json)。

最终以官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时及已校验归档执行 `node --expose-internals --test tests/*.test.mjs`：**704 项通过、0 失败、0 跳过**。共享预设 fixture 更新后重新生成完整 standard 证据；所列项目源码摘要已与最终文件核对。官方模块执行结论仍仅覆盖各测试声明的场景，不能扩展为整项 1:1 或真实桌面通过。

页面使用任务自建的回环服务、临时 SQLite 和合成记录，在 **1280×720** 实看“破甲控制 → 执行限额”。标签、代理树与本地槽说明、深度 0/1 说明可见且未溢出；DOM 的深度 `max=64`，不支持的控件保持禁用。页面日志未见 error/warn；预览服务及页签已关闭。截图保存在本地忽略目录 `artifacts/subagent-limits-ui-preview.jpg`，不构成桌面嵌入验收。

**开发操作异常：** 子任务在定位 Node 时误执行 DSH 应用主程序的 `--version`，约 0.17 秒后以退出码 134 结束、输出为空。此调用没有文件访问跟踪，因此无法确认内部是否读取或写入真实 profile，也不能用无输出或无持续会话句柄证明没有影响。随后的只读进程快照中，5 个同名相关进程均早于本批启动，未见本批新留下的同名进程；不能排除已退出或异名的子进程。没有据此停止应用、清理配置或恢复 profile。后续固定使用明确的 Node 可执行文件，并已在 AGENTS.md 写明。本批未安装插件；隔离 fixture 的无真实 profile 边界不能作为这次异常调用的保证。

本批发布检查：语法 **147/147**，格式、有限来源与分层检查、构建及离线打包通过。实际安装包 **69 个普通文件、910860 字节解包内容**，与工作区逐文件字节一致；隔离解包后四个宿主入口导入成功，未 mount，临时解包目录已清理。SHA-256：`4bb5afe7a694a37349234229b22b799be94473e18d7007db9360b4568df1ba52`。测试、官方归档和开发证据没有进入运行包。

## 预设读取预算修复与子代理权限继承（2026-10-21）

本批从 `b4aa8c2` 继续。实际探针确认完整 standard 的 tool-fs 不在全局 Loader entries，原 ReadLimits 因此报不支持；修复通过 Cordis 公开 registry 枚举真实 fiber.entry，与 Loader 目录按对象身份去重，再走既有发行摘要、模块身份、唯一目标与可撤销更新检查。没有修改官方源码、读取私有 preset generation 或构造假 Entry。

新增 5 项目录单元测试，旧断言保留：预设独立目录、同对象去重、多真实对象歧义、stale/身份不符及 inactive owned 恢复。完整 standard 集成共 5 项，实际应用并撤销 1024 字节预算，原声明不变；同一 AgentLoop 跨 3 轮、7 次合成请求和 4 次 read，逐条核对完整工具消息、调用 ID 配对、工具目录与 JSONL。实际注册第二个预设后，两个读取条目并存会明确拒绝修改。多目标统一预算仍未实现，不能把这一修复表述为全部模式全局生效。见 [读取合同](read-limits-contract.md#完整-standard-与多轮工具结果2026-10-21) 与 [证据](evidence/tool-results-acceptance.json)。

权限专项共 5 项，实际创建 5 个子／孙代理，执行 37 次 read/write/edit，逐项读回磁盘和 7 份物理 JSONL。完整访问未来默认、父与子官方 set 切回限制、创建时继承、显式 read-only、父级拒绝扩权及子级 never 拒绝均通过。父后续切换不追溯已有子权限，未来子代取得新的限制；没有把这种快照语义改成自动撤权。见 [权限合同](permission-defaults-contract.md#子代理继承与真实文件操作2026-10-21) 与 [证据](evidence/subagent-permissions-acceptance.json)。

共享夹具增加可选的真实权限服务与仅内存的配置条目目录，并允许官方路径身份检查所需的确切祖先／平台临时根 metadata 读取；范围不包括这些目录的枚举、正文或写入。模型 tool-call ID 改为固定请求序号，避免同一 Agent 跨 turn 的 step 重置产生重复 ID。测试原有默认调用方式保持不变。所有数据均为合成临时材料，没有安装、重载或执行真实 DSH 配置变更；本批没有页面代码变化。

最终以官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时及固定归档执行 `node --expose-internals --test tests/*.test.mjs`：**719 项通过、0 失败、0 跳过**。本次同时重新生成 standard 预设、子代理限额、子代理权限与多轮工具结果四份证据，绑定最终夹具和测试源码摘要。117 项验收前五列保持原基线，来源说明与第三方归属不变。

发布检查：语法 **149/149**，格式、有限来源与分层检查、构建及离线打包通过。实际安装包 **69 个普通文件、912015 字节解包内容**，逐文件与工作区字节一致；隔离解包后四个宿主入口导入成功，未 mount，临时目录已清理。SHA-256：`b4015b44423bb21af877c023cf9304a5ff80bb0c566af29f7d92f8e3b017debc`。测试、官方归档和开发证据未进入运行包。该结果不代表真实安装、桌面交互、压力压缩、进程沙箱或全部 1:1 功能通过。

## 多预设读取预算与完整极简图片路径（2026-10-21）

本批从 `641dda1` 继续，将读取预算从单一条目改为按真实 Entry 分别持有原配置和恢复责任。支持当前活动的全局、预设及保留 revision，原本关闭 read 的条目不启用。新增条目需要明确重新应用，退出或冲突条目保持诊断；不能因部分成功显示全部生效。中途失败、取消、外部等值配置对象替换、一项恢复拒绝和目录变化均有针对性回归。见 [读取合同](read-limits-contract.md#多个预设与保留-revision2026-10-21)。

完整 standard 的多目标专项 **6 项通过**，实际 23 次合成模型请求、11 个 turn、12 次 AgentLoop read，没有直接 ToolRuntime read。原单会话的 7 请求、3 轮、4 次读取及历史断言继续保留；新增 4 个作用域均逐轮核对完整 JSONL、工具目录和消息配对。read schema 的默认行数随预算变化，其他 29 个工具 schema 不变；撤销后各作用域恢复原 read schema。见 [工具结果证据](evidence/tool-results-acceptance.json)。

完整 minimal 保留官方 9 个声明、7 个活动条目及 `bash/read_image` 工具目录，未引入计划服务。实际 AgentLoop 执行两次图片读取成功与一次仅文本路由拒绝，官方附件服务把原创合成 PNG 归一化并持久化，3 份 JSONL 和后续模型图片引用均读回。Sharp 两个原生文件在任何官方模块导入前通过发行摘要校验，并在清理后重新核对；JS load hook 的校验列表与原生核验分开记录。见 [模式合同](modes-execution-contract.md#完整-minimal-图片路径执行2026-10-21) 及 [证据](evidence/minimal-acceptance.json)。

共享夹具保持 standard 默认入口，按明确选择挂载 minimal；两者使用原声明，不用伪服务补齐缺少的 planMode。minimal 附件持久化仅放行确切祖先目录的 O_RDONLY 句柄及 stat/fsync/close，所有 9 个句柄均关闭。官方生命周期和临时根清理期间保持网络、子进程和文件边界守卫。没有执行 bash、PTY、PTC 或真实配置变更，图片路径不替代四模式同一文本任务的原验收。

页面以任务自建回环服务、临时 SQLite 和明确合成能力状态验证：统一预算、部分覆盖、沿用宿主及外部冲突四种显示正确，冲突时输入仍禁用；部分覆盖会提示重新应用。桌面 DOM 视口 **1265×720**，无横向溢出，页面日志无 error/warn。部分覆盖截图中的保存预算为 1024 字节，与显示状态一致；截图保存在本地忽略目录 `artifacts/read-budget-partial-preview.jpg`。服务和页签已关闭。这只验证界面呈现，不是 DSH 嵌入或真实运行控制验收。

首轮完整回归 **730 项通过、1 项失败、0 跳过**：既有卸载探测用例约 1 秒的固定等待未看到合成子进程 PID。此问题此前已出现；本次改为子进程原子发布 PID 后写入 ready 标记，启动前监听该确切标记，由原有 probe 生命周期限定等待，保留活 PID、取消错误、进程退出、工具服务继续可用及下一次探测的全部断言。未增加产品的 5000 ms 默认超时。最初的 `fs.watch` 实现在本机返回 `EMFILE`，改用确切文件的 `watchFile` 后，该文件 **18/18 通过**。另复现并修复已持有的读取条目丢失 fiber 时能力查询抛异常的问题；新回归确认明确冲突、保留恢复责任且不改外部配置，读取单测 **21/21 通过**。

最终以官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时及固定归档执行 `node --expose-internals --test tests/*.test.mjs`：**732 项通过、0 失败、0 跳过**。本次重新生成 standard、子代理限额、子代理权限、多轮工具结果及 minimal 五份证据，40 项项目源码摘要全部匹配最终文件。117 项验收前五列逐行匹配 `0bc13d2` 的固定基线；开发来源、NOTICE 与 `UNLICENSED` 不变。本批没有安装、重载或修改真实 DSH 配置。

发布检查：语法 **150/150**，格式、有限来源与分层检查、构建及离线打包通过。实际安装包 **69 个普通文件、920491 字节解包内容**，逐文件字节与工作区一致；隔离解包后四个宿主入口导入成功，未 mount，临时目录已清理。SHA-256：`ed4c27934c8fd10620b7a351611cebc2ddba9ec17e48841b93ac81f705aba07d`。测试、官方归档和开发证据未进入运行包。完整桌面 1:1、极简文本任务、PTC 与压力压缩仍未通过验收；当前安装中已知入口摘要不匹配的状态也未被隔离副本改变。

## 官方 PTC 进程后端执行补充（2026-10-21）

本批从 `c27d252` 继续，新增可复验的 [PTC 组件探针](../scripts/probe-ptc-backend.mjs)。正式 `require_escalated` 调用官方 Node **v24.21.0** 后，未经修改的官方 NodePtcRuntime、LocalSubprocessRuntime 与 read-only Seatbelt 实际完成一次临时文本读取；一条真实进程启动、两条配对的 PTC 分派事件、实际文件内容与返回 marker 均核对通过。310 个实际加载官方文件摘要匹配库存。此前旧 Node 26 的失败记录保留，但不再将其外推为当前环境阻碍。详见 [执行合同](modes-execution-contract.md#官方-node-ptc-后端单次执行2026-10-21) 和 [脱敏证据](evidence/ptc-backend-acceptance.json)。

首次预检因 macOS 注入 locale 键而失败，官方加载及子进程启动均为 0；最终版本在官方加载前仅删除该键。成功调用后，官方 SIGTERM 清理、child close、控制管道 close、三个运行集合清零、跟踪文件描述符清零和两处临时根删除均有读回。守卫直到清理与回执写入结束才撤回，没有禁止操作或清理错误。原始回执单独保留在本地忽略目录；公开记录替换了所有嵌套本机临时路径，并标明外层执行信息由主任务记录，不伪装成探针自身或内核隔离证明。

另只读核对极简终端的 13 个发行文件与 native/backend 摘要，明确真实文本路径、环境继承、native PTY 与官方进程元数据检查；见 [静态合同](evidence/minimal-terminal-contract.json)。这部分没有导入模块或运行终端。PTC 组件探针未加载完整 PTC 预设或 AgentLoop，未验证该模式下插件 replace/revert、持久 JSONL 或桌面交互；极简文本与完整四模式 1:1 仍未完成。官方只读 profile 没有内核读取/网络白名单，本批没有为通过验收更改它或使用替代后端。

最终完整隔离回归 **732 项通过、0 失败、0 跳过**，语法 **151/151**；格式、有限来源与分层检查、构建和离线打包通过。117 项原验收前五列仍匹配 `0bc13d2`，NOTICE、来源记录与 `UNLICENSED` 不变。产品源码和 UI 未变，安装包仍为 **69 个文件**、SHA-256 `ed4c27934c8fd10620b7a351611cebc2ddba9ec17e48841b93ac81f705aba07d`，与上批逐文件验证的包字节一致。本批没有安装、重载或修改真实 DSH 配置。

## 完整 PTC 预设读取与撤销（2026-10-21）

本批从 `d455551` 继续。新增 [完整 PTC 探针](../scripts/probe-ptc-preset.mjs) 与严格限定的测试进程守卫，原始预设、产品源码和 UI 不变。官方 Loader/Registry 挂载完整 30 个叶条目、25 个活动项，Agent 绑定真实 retained revision；未启用原本禁用的五项。533 个实际导入文件通过发行库存核对，官方 PTC 包仅按库存字节复制到临时运行时。见 [执行合同](modes-execution-contract.md#完整-ptc-预设与真实-agentloop2026-10-21) 与 [证据](evidence/ptc-preset-acceptance.json)。

专项 **3 项通过、0 失败、0 跳过**，包括父测试和 replace/revert 两个场景。两个会话经真实 AgentLoop 发出 2 次 run_code，在官方 Node v24.21.0、原始只读 Seatbelt 和固定测试资源配置下完成 2 次实际 tools.read；4 次模型响应明确为合成输入。persona 替换及恢复、PTC 指导/SDK 段、schema、调用关联、后续请求工具消息、官方 reader 和两份物理 JSONL 均核对。没有直接 ToolRuntime 调用，不把工具注册或假后端输出当成执行证据。

前期诊断发现测试守卫误拦截 JSONL 所需的官方文件锁原生模块；前两次测试进程因清理提前中断而没有退出，已定向停止对应的任务 Node 进程，合成工作目录均已删除。这两次未获得完整服务处置证明，不计为通过。随后修复夹具清理，使每一步都会执行、错误在最后汇总并使测试失败；只允许发行摘要匹配的 `system.node`，实际加载一次并在前后核验。还纠正了固定可执行文件 metadata 许可、JSONL 工具参数为字符串的断言，以及官方在 child close 后对本次 PGID 的 signal-0 存在检查。中间一次两个功能场景均通过但清理边界失败，也未生成通过记录。没有通过关闭沙箱或接受伪返回消除失败。

最终执行 exit 0：两次 child close、控制管道关闭、官方三个运行集合清零、临时根删除、已安装入口摘要不变；禁止操作与清理错误为空。父进程只额外允许 Node/sandbox-exec 的确切 metadata 检查和已核验文件锁 native 加载，子程序环境为空、网络/再启动尝试为空。官方 Seatbelt 仍不提供内核读取/网络白名单，本证据也不保证追踪逃离进程组的后代。未运行真实模型、桌面安装、PTC 计划切换、其他工具或极简 PTY。

共享夹具修改后重新生成 standard、minimal、子代理限额、子代理权限和工具结果五份证据；连同新增 PTC 记录，**49 项所列源码摘要**均匹配最终文件。首轮完整回归因执行环境拒绝回环监听而有 20 项失败（`listen EPERM`）；经正式 `require_escalated` 入口运行同一命令后，**732 项通过、0 失败、0 跳过**。完整 PTC 探针独立执行，不放入普通 npm test；公共 CI 不具有本机发行包和正式子进程执行环境，不能替代该本地专项。

发布检查：语法 **153/153**，格式、有限来源与分层检查、构建及离线打包通过。117 项原验收前五列保留；NOTICE、来源记录、UNLICENSED 和原参照仓库不变。安装包仍为 69 项，SHA-256 `ed4c27934c8fd10620b7a351611cebc2ddba9ec17e48841b93ac81f705aba07d`，与上批逐文件验证的包字节一致；新增探针、测试和官方模块不进入安装包。本批没有安装、重载或修改真实 DSH 配置。完整 1:1、极简文本路径、真实模型与桌面验收仍有差距。

## 完整极简预设的持久终端文本验收（2026-10-21）

本批从 `977e019` 继续，补齐此前缺少的真实 minimal 文本读取路径。新增 [终端探针](../scripts/probe-minimal-terminal.mjs) 与固定 native PTY 测试守卫，通过官方 Loader/Registry、完整原始预设与 AgentLoop，执行两个合成会话。9 个叶条目、7 个活动项和原生 bash/read_image schema 保持原样，468 个实际导入官方文件校验通过。详见 [合同](modes-execution-contract.md#完整-minimal-持久终端文本路径2026-10-21) 和 [脱敏执行证据](evidence/minimal-terminal-acceptance.json)。

专项最终 **3 项通过、0 失败、0 跳过，进程 exit 0**。5 次模型响应明确为合成输入，实际执行 3 次 AgentLoop bash、2 个官方 native PTY：replace 后读到临时文件并在同一 shell 保持变量；revert 后新会话变量未设置、PID 不同，官方 persona 恢复。完整工具结果、退出码标记、下一轮请求、官方 JSONL reader 与物理文件均读回；没有直接调用 ToolRuntime 或替换终端后端。

首次执行因测试漏算官方输出末尾的退出码标记而失败。第二次功能场景均通过，但测试取消监听器在会话处置后仍访问其 projection，测试进程因此 exit 1；它生成的早期记录已移至本地忽略目录，不计入通过证据。两次终端、运行集合与临时根均已清理。最终修复移除监听器，并只在整个进程 exit 0 时发布通过记录；未放宽功能断言、修改官方代码或调整沙箱策略。

PTY 使用官方只读 Seatbelt、临时 HOME/TMPDIR、禁用历史的固定环境；初始化仍包括官方 stty，进程检查仍使用真实 ps 结果，公开证据只保留任务所属行。pty.node、spawn-helper、system.node 在使用前及处置后均核验，两个 native 模块各实际 dlopen 一次。官方清理依次使用 SIGTERM 与宽限后的 SIGKILL，两个 native onexit 和 FD 的 EBADF 均核对；每个 owner 的 preset-scoped registry 为空，三个 subprocess 集合归零。没有将这些结果表述为所有 shell 子进程拦截、内核读取/网络白名单或任意后代追踪。

共享夹具变更后，完整 PTC 专项再次 **3 项通过，exit 0**，整套隔离回归 **732 项通过、0 失败、0 跳过**。重新生成受影响的 standard、minimal、子代理限额、子代理权限、工具结果和 PTC 六份证据；连同新增终端记录，7 份文件所列 **58 项源码摘要**全部匹配。117 项验收前五列逐值保持固定基线，仅更新 CORE-MODES 状态。NOTICE、开发来源说明、UNLICENSED 和参照仓库不变。

发布检查：语法 **155/155**，格式、有限来源与分层检查、构建及离线打包通过。当前安装包 **69 个普通文件、920491 字节解包内容**，逐文件内容与工作区字节一致；SHA-256 为 `8196fb148c5e17607234898b09a45107b4283e16c92c1385d8628d23f446a545`。本次压缩包摘要与上批不同，因此只声称已核对的文件内容一致，不声称压缩包字节相同。测试、探针与官方模块均不入安装包。产品/UI 源码没有变化，本批未重复页面预览，没有安装、重载或修改真实 DSH 配置；压力压缩、其余工具、真实模型及桌面 1:1 仍有差距。

## 读取结果在官方压力裁剪与摘要后的保留（2026-10-21）

本批从 `292ad7a` 继续，新增 [压力专项](../tests/compaction-host.test.mjs)，未修改共享夹具、官方策略或产品代码。完整 standard 预设的两个会话使用独立合成适配器，经正式元数据接口声明 100000 token 上下文；压力由真实官方 meter 根据实际日志估算，没有注入用量、手动调用 compact 或伪造结果。535 个实际导入官方文件通过发行库存核对，见 [合同](read-limits-contract.md#官方压力裁剪与摘要2026-10-21) 和 [执行证据](evidence/compaction-acceptance.json)。

专项 **4 项通过、0 失败、0 跳过，exit 0**：35 次对话请求、3 次摘要请求、32 次 AgentLoop read，直接 ToolRuntime 调用为 0。大文件原始结果完整保留，官方裁剪后模型收到 5159 字符的头尾结果；30 次小文件读取未触发单结果裁剪，但累计压力产生三次摘要，最后请求仅保留 11 份工具结果。原始 32 份工具结果均在物理 JSONL 中，不能据此声称模型仍能看到所有原文。撤销预算和提示词适配不改变既有事件、surface 或派生消息，随后官方 persona/schema 恢复且继续读取成功；其他 29 个工具 schema 始终不变。

开发调试先修正了测试 setup 回调错误返回预设挂载结果，以及把官方原始 `surfaceOp:"append"` 误判为无 surfaceOp 的筛选条件。失败轮没有生成通过记录，没有修改宿主来适配断言。最终验收在进程 exit 0 时发布证据；真实 reader、物理 JSONL、原输入字节、生命周期清理和守卫均核对。网络、子进程、越界文件尝试及清理错误为空；临时根已删除。六项证据源码摘要匹配当前文件，摘要语义质量和服务端 overflow 恢复明确未验。

完整隔离回归 **736 项通过、0 失败、0 跳过**；语法 **156/156**、格式、有限来源与分层检查、构建及离线打包通过。117 项原验收前五列不变，仅更新 CORE-RESULT 状态。安装包仍为 69 项，SHA-256 `8196fb148c5e17607234898b09a45107b4283e16c92c1385d8628d23f446a545`，与上批逐文件核对的安装包字节相同。本批没有 UI 源码变化、安装、重载或真实 DSH 配置修改。PTC 计划切换仅完成只读接口核对，尚无执行证据；真实模型、桌面交互和完整 1:1 仍待补齐。

## 完整 PTC 计划审阅到后续实施（2026-10-21）

本批从 `c49d982` 继续，新增 [PTC 计划专项](../scripts/probe-ptc-plan.mjs)，并仅为测试守卫增加一个固定原创计划程序；产品源码、官方预设、读取程序、沙箱策略及两次进程启动上限不变。通过完整原始 PTC 预设和官方 AgentLoop，在同一合成会话的两个明确用户 turn 中验证计划审阅与后续读取。见 [执行合同](modes-execution-contract.md#完整-ptc-计划审阅与后续明确实施2026-10-21) 与 [执行证据](evidence/ptc-plan-acceptance.json)。

专项首次执行 **3 项通过、exit 0**：4 次合成模型请求、1 次合成人答、2 次真实 run_code/Node/Seatbelt 启动，内层分别调用 exit_plan_mode 与 read。审阅问题关联内层 subCallId；返回批准时状态仍为 active=true、pending=false，真实下一步才提交 plan/mode=false。第一轮无文件读取；第二轮显式实施前 revert，随后实际读取原创临时内容并恢复官方 persona。模型可见 run_code schema、29 个 SDK schema、PTC 指导、工具消息、42 个持久事件与 43 行物理 JSONL 均核对。533 个实际导入官方文件摘要匹配库存。

两个 child 和控制管道均关闭，官方 subprocess/PTC/controlChannels 集合为 0；临时根删除，越界尝试和清理错误为空。测试进程 exit 0 后才发布证据。共享守卫变更后，既有完整 PTC 读取/撤销专项重新 **3 项通过、exit 0**，两份证据共 18 项源码摘要均匹配最终文件。合成回答不代表真实用户批准；真实 UI/Gateway 审阅、模型决策、PTC 拒绝/取消后端路径和完整桌面 1:1 仍未验。

首轮完整回归为 **735 通过、1 失败**：既有 toolkit 取消测试只等待约 1 秒便读取子进程环境文件，实际文件尚未就绪。测试改为原子发布环境文件、等待文件就绪或真实 probe 结束；保留默认 5 秒超时、撤销路径后的 CANCELLED、进程终止和临时 HOME 删除断言，未修改产品逻辑。该文件专项 **18 项通过**，随后完整隔离回归 **736 项通过、0 失败、0 跳过**。

语法 **157/157**、格式、有限来源与分层检查、构建及离线打包通过。117 项原验收前五列保持基线，仅更新 CORE-MODES 状态；NOTICE、开发来源、UNLICENSED 和参照仓库不变。安装包为 **69 个文件、920491 字节解包内容**，逐文件与当前工作区一致；当前 SHA-256 `ed4c27934c8fd10620b7a351611cebc2ddba9ec17e48841b93ac81f705aba07d`，与上一批压缩包摘要不同，不声称压缩包字节不变。测试及官方模块不入包。没有 UI 源码变化，本批未重复页面预览，没有安装、重载或修改真实 DSH 配置。

## 同模型规则切换与跨模型隔离修复（2026-10-21）

从 `1673c2e` 继续，实际修改 `src/core/prompts.js` 的规则选择。修复前，同模型 A/B 规则即使激活 B，组装仍选先创建的 A；限定模型 M 的活动规则也会错误兜底到模型 N，并抑制 N 的工作区 fallback。两项回归在修复前均实际失败，分别读到 `RULE_A_EDITED` 和 `ONLY_MODEL_M`，与应有结果相反。

修复后，同模型中明确激活者优先，否则保留原有首条匹配规则；只有无模型限定的活动规则可全局兜底。临时 SQLite 的保存/激活/编辑到适配器组装、模型缺失/不匹配、工作区 fallback 以及还原保留规则库均通过。官方 SystemPrompt/renderer 也验证 A→编辑 A→B→编辑 B、跨模型隔离、全局规则优先级、工具 schema 保留和撤销精确恢复，详见 [规则选择验收](prompt-sections-contract.md#复验)。没有变更规则存储格式或自动模型匹配行为；清除 activeId 不等于停用自动匹配，用户指南现已明确说明。

针对性本地回归 **46 项通过**，官方提示词专项 **6 项通过**，完整隔离回归 **739 项通过、0 失败、0 跳过**。语法 **157/157**、格式、有限来源与分层检查、构建和离线打包通过。117 项原验收前五列不变，仅更新 RULE-ACTIVE 状态；来源与许可记录保留。新安装包 69 项，SHA-256 `ce4f739be1b1cd01d56f8949ac59d0b1dfece07436c0c8ef6c90eeb0dc8e380f`。未改页面代码或重复页面预览，没有安装、修改真实 DSH 配置或调用真实模型；本修复不构成真实对话“破甲”效果的验收。

## 还原后停止旧异步提示词任务（2026-10-21）

从 `5259c0f` 继续，修复两个实际撤销缺陷：提示词组装已取得启用配置但仍在等待宿主时，点击还原后仍会追加规则和角色正文；重试请求仍在等待下游时，撤销监听后仍会挂回系统消息投影。重新启用会让旧请求干扰新注册，外部包装保留的旧投影还可能访问已关闭存储。

新增五条合成回归在修改产品前全部失败。`runtime.test.mjs` 使用独立配置快照和人工放行的 Promise，核对撤销、撤销后重新启用时旧任务必须返回原组装对象，规则读取和角色调用均为零；新启用的任务仍注入新正文。`prompt-refresh.test.mjs` 验证等待中的旧请求不重新挂载、不覆盖新注册，以及保留外部包装时不读已关闭存储。修复为每次启用赋予独立有效期，并在撤销及异步返回处核对，没有改动提示词优先级或权限策略。

专项 **23 项通过**，官方提示词专项 **6 项通过**；完整隔离回归 **744 项通过、0 失败、0 跳过**。语法 **158/158**，格式、有限来源与分层检查、构建及离线打包通过。安装包为 **69 项**，SHA-256 `f80ef71c523ade7b7aaee28a3d8d4e463a3daff50adddbf8227504d1d939be4b`。117 项验收前五列不变，来源与许可记录保留。此前执行证据中的源码摘要属于各自历史批次，本批没有重新执行全部独立进程探针。

本次不撤回已发送请求、不删除历史对话；没有 UI 改动、安装、真实 DSH 配置修改或真实模型调用。通过的是上述本地行为和现有隔离回归，不是完整桌面 1:1 验收。

## 并发应用与还原的执行顺序修复（2026-10-21）

从 `428e01d` 继续，修复 Controller 的控制操作交错问题。修改前新增三条确定性回归全部失败：两次应用同时执行会出现旧 revision 冲突，失败方回滚使保存状态仍为启用、实际运行控制却已撤销；应用期间还原会重复清理；前一应用失败的回滚也会撤销后一成功应用。失败日志保存在本地忽略目录 `artifacts/control-order-before.log`。

修复将同一实例的应用、还原及共享设置写入按接收顺序执行，错误仍返回原调用者，后续操作不被前一失败阻断。公共生命周期清理加入同一顺序，队列内失败回滚直接清理，避免等待自身。新增两条回归确认生命周期清理等待挂载结束且保留重载意图，以及旧 revision 的规则策略写入仍拒绝、不撤销已成功应用的控制。原有卸载等待、部分失败及清理断言保留。

Controller 与卸载专项 **27 项通过**；完整隔离回归 **749 项通过、0 失败、0 跳过**。语法 **158/158**、格式、有限来源与分层检查、构建及离线打包通过。安装包为 **69 项**，SHA-256 `09d18fc0eb8294c76a2e76c5c772f221d4b3ee2f2299016290763edccbc2b147`。117 项验收前五列保持原基线，仅更新 DESK-IDEMPOTENT 状态。没有新增依赖、UI 改动、真实安装或真实配置写入；本次是合成并发行为及现有隔离回归，不代表实际桌面 1:1 通过。

## 提示词来源与已保存正文预览（2026-10-21）

从 `ad2917e` 继续，新增“破甲控制 → 预览已保存正文”。按指定模型与明确工作目录，显示规则库、保存提示词、所选工作区文件或默认文本的来源、保存版本及完整候选正文。预览与实际注入共用正文选择函数，优先级未改变；停用时明确标为候选正文，不保存配置、不应用控制、不组装宿主请求、不调用模型。未保存表单、工具说明及会话角色段不在预览内，旧进程缓存回退仍不支持。另把 `autoReapply` 的错误文案改为“重载后恢复运行控制”，行为未改。

新增 API 与界面专项 **16 项通过**，覆盖与运行时正文一致、同模型活动规则、跨模型隔离、工作区三种策略、文件边界、无状态写入、条件变化清空、迟到响应和转义。实际回环预览使用临时合成数据库：未保存编辑不计入；保存后读回正确版本和正文；匹配模型采用专用规则、其他模型回到保存正文；错误目录清空旧结果并显示错误。最初桌面视口 **1265×712**，最终截图视口 **787×837**，正文可滚动读取；页面 error/warn 日志为空。截图仅在本地 `artifacts/prompt-source-preview.jpg`，预览页签和临时服务已关闭。这不是 DSH 嵌入或真实请求验收。

官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时及固定归档的完整隔离回归 **765 项通过、0 失败、0 跳过**；语法 **161/161**。有限来源、分层、构建及离线打包通过，安装包 **70 项**，SHA-256 `77d751728d56083c6cbc25a88292014fc71ee4996334eeacfaf6acf6bec2c06f`。原 117 项验收前五列保留，仅更新 PROMPT-SOURCE 状态，并纠正缺口汇总中已滞后的 HTTP 范围执行说明。来源、许可和第三方声明保留；没有安装或修改真实 DSH 配置。当前仍未达到完整桌面 1:1。

## 子代理截断后自动继续（2026-10-21）

从 `28fcf74` 继续，新增启用控制后创建的受管本地子代理自动续轮。默认关闭，沿用 0–20 次上限和当前继续用语；只处理 `max-tokens`，不处理用户停止、网络或限流错误。工作流保留同一运行收据和名额，整个自动链结束后才释放并启动依赖任务；普通官方子代理只通知父代理一次。已结束子代理的手动恢复、外部代理进程和真实桌面操作仍未实现或验收。

V-CHILD-CONTINUE：[官方子代理专项](../tests/continuation-child-host.test.mjs) 的三个场景使用实际 AgentLoop、SubagentRuntime、spawn、工作流和 JSONL reader，模型输出全部为合成流。分别验证单槽任务截断后续跑及后继等待、普通子代理两次上限及一次最终通知、自动轮运行中停止及最终释放；核对运行标识、消息来源、触发事件与持久化读回。共享夹具从既有 workflow 测试提取，保留原六条场景及网络/进程禁止守卫，不接触真实 profile。

最初直接在 `turn/end` 中调用官方异步队列，消息已接纳却错过空闲唤醒，官方专项失败。改为记录截断候选，在同步 `agent/status:idle` 通知中提交，才实际触发下一轮并保留原运行。另经合成复现发现子代理取消接口被后来所有者替换时，冲突会阻断父原生取消；新增回归先失败，修复后父取消总会执行、其他子代理的所属待续仍被清理、冲突仍明确返回，外部接口保留。没有修改官方代码或放宽原期望结果。

[继续模块单元测试](../tests/continuation.test.mjs) **40 项通过**，覆盖启动身份、父子实例、继承历史排除、父输入重置与背景消息不重置、投递接纳/取消、禁用/撤销及所有权冲突。官方 Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时与固定归档的完整隔离回归最终 **800 项通过、0 失败、0 跳过**，日志为本地忽略的 `artifacts/child-continuation-full.log`。这些计数不是 117 项桌面验收的完成数。

实际回环页面预览为 **1265×712**，自动继续默认关闭、上限 3，明确显示根/子代理范围和手动恢复限制；缺宿主时控制禁用，error/warn 日志为空。截图在本地 `artifacts/child-continuation-preview.jpg`。预览页签、服务及其合成目录已关闭清理；未宣称通过真实执行 UI。

语法 **163/163**、格式、有限来源与分层、构建和离线打包通过。包内 **70 个文件**，SHA-256 `53feff68ef2e9e276c96d35bf8deff65c87fad17e9ca9acfd2ddeab79728011d`。原 117 项验收前五列与 `0bc13d2` 逐值一致，只更新 RETRY-CONTINUE/RETRY-STOP 状态和相关缺口描述；来源、NOTICE、UNLICENSED 及第三方声明保留。没有安装、重载、修改真实 DSH 配置或调用真实模型，完整桌面 1:1 仍未完成。

## 数据更新提示与项目切换隔离（2026-10-21）

从 `042239d` 继续，新增右上角“刷新数据”、页面读取状态、导航更新标记和证据/评分分类提示。切页或刷新时同步项目列表与当前数据；初次观察建立基线，读取期间新增变化仍保留提醒。不同项目、页面及记录分类分别确认，知识库与项目列表使用全局范围。提醒不表示新增条数，没有后台轮询，浏览器重载后重建已读基线。

V-DATA-REFRESH：SQLite 版本触发器与记录同事务，覆盖新增、修改、删除、跨连接和旧库增量升级；文件成功及部分残留记版本，完整回滚不记，文件改变但计数保存失败明确披露。新增 [数据版本测试](../tests/data-changes.test.mjs) 9 项、[页面回执测试](../tests/ui-data-updates.test.mjs) 13 项、[渲染测试](../tests/data-refresh-ui.test.mjs) 9 项。后者执行生产 render/项目读取/文件页/报告页与真实回执模块，验证迟到项目响应、缓存隔离、报告导出、API/绑定失败、部分读取和读中更新。修复等待中的旧项目响应可更新状态的问题；报告正文改为绑定本次结果，避免旧响应覆盖新项目导出。

既有 [官方模型工具专项](../tests/plugin.test.mjs) 增补父/子模型工具写入与同库 HTTP 版本读回、项目隔离及新 UI 模块可加载断言。专项组合 **35 项通过**；最终指定官方 Node **v24.21.0**、**0.2.1-rc.2** 运行时和固定归档的完整隔离回归 **831 项通过、0 失败、0 跳过**，日志位于本地忽略目录 `artifacts/data-refresh-full.log`。语法 **167/167**，有限来源和分层检查通过。测试数不是桌面功能完成数。

实际回环预览使用临时 SQLite：首次读取后从本地 API 新增合成资产与 HTTP 证据，点击统一刷新可见新增内容及相关页更新提示；切到空项目显示零记录且无另一项目提示，切回后原未读仍保留；阅读凭据分类不清除 HTTP 未读，打开 HTTP 后才清除。成功路径 error/warn 日志为空。随后停止本轮预览服务再刷新，显示请求失败和“重新读取”，不伪装为空库或成功。截图为本地 `artifacts/data-refresh-preview.jpg` 与 `artifacts/data-refresh-error.jpg`，最终预览视口 **1280×720**；页签和服务已关闭，临时目录已清理。

原 117 项验收前五列保持基线，只更新 DATA-REFRESH 状态；来源、NOTICE、UNLICENSED 和第三方声明保留。没有安装、重载、真实配置写入或真实模型调用。通过的是隔离工具链及本地浏览器页面，真实桌面嵌入与完整 1:1 仍未完成。

格式、构建与离线打包通过。包内 **71 个文件、954095 字节解包内容**，逐文件与工作区字节一致；SHA-256 为 `81414f3c9ed414e6e7f17c7bd22846a5948faf41da1690b6de4187e31d0b399c`。再次逐值比较确认 117 行前五列与 `0bc13d2` 一致，NOTICE、开发来源和包许可字段均未变。

## 撤销旧权限回调与销毁时自动恢复修复（2026-10-21）

从 `e99e5e5` 继续，修复两项核心生命周期问题。旧审批、沙箱和子代理限额回调没有检查创建它们的启用期；保存的 enabled 在生命周期释放后仍为 true 时，外部保留引用可继续自动批准、扩大模式或使用旧限额，关闭存储后还会读已关闭数据库。现在这些回调和提示词一样绑定启用期，撤销或应用失败后只调用原宿主接口；重新启用不复活旧回调。其他所有者的接口和冲突报告保留，沙箱原函数计算期间撤销也不再覆盖其结果。

[runtime 专项](../tests/runtime.test.mjs) 新增五条回归在修改前均失败（20 通过、5 失败；本地 `artifacts/revoked-controls-before.log`），修复后 25 项全部通过。覆盖正常撤销、后来所有者保留旧包装、重新启用、原函数内撤销和部分应用失败；核对原拒绝/只读/限额、配置不再读取及新启用仍正常。

另在官方 Cordis 中复现父上下文已销毁、排队的依赖注入回调仍自动应用一次的问题。回调开始前现在检查父/子 fiber 的 uid，已销毁则不接纳恢复。先前已接纳的异步操作仍完成并在关闭存储前撤销，不改持久重载意图。[plugin 专项](../tests/plugin.test.mjs) 新增三条场景，官方模块隔离共 **16 项通过**；验证销毁后零应用、每次加载恢复一次、配置保留、异步清理与路由释放。集成检查纠正测试中错误的 promptText 字段为实际 prompt，并追加重载后官方系统组装包含保存正文的断言。

指定官方 Node **v24.21.0**、**0.2.1-rc.2** 运行时及固定归档的最终完整隔离回归 **839 项通过、0 失败、0 跳过**，日志 `artifacts/revoked-controls-final.log`；语法 **167/167**，有限来源与分层检查通过。没有 UI 改动，本批不重复页面预览。没有安装、修改真实 DSH 配置或调用真实模型；真实重启/HMR与完整桌面 1:1 仍未验。

同时完成通用工具启动接口的只读核对：官方 subprocess 可与沙箱组合，但独立页面没有合法会话审批轮次，当前未实现通用 start/output/stop，继续保留 ENV-PROCESS 差距。接口边界记录在 [环境合同](environment-contract.md#通用进程路径的接口核对2026-10-21)，不把只读调查记为功能完成。

格式、构建与离线包检查通过。71 个包内文件、954409 字节解包内容逐项与工作区一致，SHA-256 `d4404ed506dc51745641611c2f0abd68f66f9b46a3c3302e00a26b05246c8c30`。117 项验收前五列与 `0bc13d2` 一致，仅更新撤销/自动恢复的状态；NOTICE、开发来源和许可字段未改。

## 本地工具启动、输出与停止（2026-10-21）

从 `74962ee` 继续，补齐通用本地工具运行路径：`unlimit_process` 在真实宿主工具调用上下文中按会话绑定启动已配置工具；“工具与环境”首屏可按项目读取列表、查看输出并停止。参数数组不拼 shell；当前会话权限、单次审批和沙箱进入调用路径。HTTP 不能构造可信 execution 来启动。演练确认撤销、卸载准备与插件释放会取消准备并终止本插件的句柄；不使用全局进程清理，不注入环境配置秘密。接口和限制见 [环境合同](environment-contract.md#本地工具进程接口)。

V-PROCESS：新增后端合成测试 **17 项**、页面交互测试 **13 项**，覆盖权限/审批、参数/路径变化、会话身份与绑定变化、输出偏移/截断、停止/超时、迟到准备取消、清理待确认、页面错误与过期响应。官方 ToolRuntime 验证执行上下文传递与 HTTP 隔离；Controller 验证撤销和卸载先取消再等待；插件验证先清理进程再关闭数据库。集成时发现 Cordis 缺少可选服务会因属性访问使整个状态页失败，修复后保留无服务可用性。另修复环境页切换项目后未更新项目状态的问题。

[官方本地进程验收](../tests/processes-host.test.mjs) **7 项通过**，使用实际 subprocess 服务、官方内存会话/策略/注册表和原创临时 Node 程序：精确 argv、stdout/stderr、非零退出、停止、超时、stopAll 和 close。六个临时子进程均已结束；同服务中的无关进程在插件 stop、stopAll、close 后继续输出，只在测试最终清理时终止。夹具校验 **180 个官方依赖文件**摘要与大小，没有加载已改动的工具入口或备份，没有真实模型、网络或用户 profile 访问。策略是合成 full-access，调用上下文和入场确认也是合成；这不证明人工审批、受限内核沙箱、逃离管理范围的后代或桌面嵌入通过。

实际回环浏览器预览 **1265×712** 使用临时 SQLite 与明确的合成进程回执适配器，不启动真实工具。页面核对参数和状态、读取 stdout/stderr、将尖括号显示为文本、显示截断、明确停止后更新状态并禁用重复停止；error/warn 日志为空。截图位于本地忽略目录 `artifacts/process-monitor-preview.jpg`；页签、预览服务和临时数据已关闭清理。浏览器交互和官方真实进程测试分别提供证据，没有把两者拼称真实桌面端到端验收。

指定官方 Node **v24.21.0**、**0.2.1-rc.2** 运行时及固定归档的最终完整隔离回归 **881 项通过、0 失败、0 跳过**，日志 `artifacts/processes-final.log`。原 117 项验收前五列保持，ENV-PROCESS 只更新实际状态；来源、NOTICE、UNLICENSED 和第三方声明保留。没有安装、重载、真实 DSH 配置写入或模型调用。通用工具网络出口、真实审批/内核沙箱和完整桌面 1:1 仍有缺口。

语法 **173/173**、格式、有限来源与分层检查、构建及离线打包通过。包内 **73 个文件**逐项与工作区字节一致；SHA-256 `75313566068633dceb395af5bc7d780901d2c0341d295645c5480e4958e21c5c`。打包后另跑原验收基线专项，两项通过，未改变前五列或弱化预期。

## 日志控制在撤销后停止生效（2026-10-21）

从 `d46e4e3` 修复日志控制的残留引用：撤销、发现宿主已替换引用或应用失败后，该次注册立即失效。宿主若仍持有旧引用，将使用原始动态值，不再读取本插件数据库；再次启用也不会使旧引用重新生效。保留其他所有者的修改与原有冲突报告。

新增三个先失败后通过的回归，并补充宿主重挂载断言。指定官方 Node **v24.21.0**、**0.2.1-rc.2** 运行时及固定归档的完整隔离回归 **884 项通过、0 失败、0 跳过**，日志为本地忽略的 `artifacts/log-revoke-full.log`；语法 **173/173**、格式、有限来源与分层检查通过。首次受限沙箱运行因回环监听被拒而失败，获准运行同一测试命令后得到上述结果。117 项原验收基线不变。

这项修复完善“撤销插件”的既有行为，不增加新的破甲能力，也不表示完整桌面 1:1 通过。本批没有 UI 改动、安装、真实 DSH 配置写入或真实模型调用；来源说明、NOTICE 和许可字段保持不变。

## 已结束子任务手动继续（2026-10-21）

从 `8a7eaaf` 继续，实现“会话管理 → 继续状态 → 手动继续子会话”。只恢复自有历史最新 `max-tokens` 的官方本地持续子任务，读取当前提示词和角色；新原生运行标识与独立续跑记录可见。演练子任务重新领取槽位，原工作流收据和已完成依赖图保持不变。停止与撤销保留其他来源输入，控制权释放不冒充宿主已停止。详细行为见 [截断后继续](contract.md#截断后继续)。

[官方手动继续专项](../tests/continuation-manual-host.test.mjs) 五项使用实际 AgentLoop、SubagentRuntime、SessionController、JSONL 与工作流，传输为合成流：确认新运行采用修改后的系统正文和角色，重复点击仅接纳一次，停止后新槽释放且旧收据不变；普通子任务冷恢复按官方行为通知父会话；满槽不启动；恢复期间父输入抢先到达时不接纳过期请求；后续外来子输入不被停止按钮取消，槽位保留到原生结束。真实模型费用、桌面嵌入与真实审批仍未验收。

[手动继续合成专项](../tests/child-continuation.test.mjs) 50 项覆盖自有历史、归档、父身份、接纳竞态、原生失败及槽位归属；[界面专项](../tests/continuation-ui.test.mjs) 10 项覆盖回读、确认、状态转义及切页/改选后的旧响应保护。Controller 验证新续跑的角色/绑定/槽不可由通用操作提前释放，卸载先撤回待恢复操作再等待请求，入场撤销只清理项目续跑。既有自动继续夹具纠正为官方的裸消息 ID 返回值，并增加成功时无隐藏错误的断言；缺能力仍须明确拒绝，未降低原预期。

指定官方 Node **v24.21.0**、**0.2.1-rc.2** 运行时及固定归档的最终完整隔离回归 **951 项通过、0 失败、0 跳过**，日志 `artifacts/manual-child-final.log`；语法 **177/177**、有限来源与分层检查通过。117 项验收前五列保持原基线，仅更新实际状态和过时缺口说明；来源记录、NOTICE、UNLICENSED 和第三方归属未改。

1280×720 回环浏览器预览实际点击继续、确认、停止、刷新并展开执行记录，页面优先展示中文状态和名额，内部标识折叠。使用真实页面代码与明确标注的合成 API 回执，临时 SQLite；没有实际子任务或模型请求。控制台无 warn/error，截图为本地忽略的 `artifacts/manual-child-preview.jpg`。页面预览与官方模块测试是两组隔离证据，不合并声称真实桌面端到端通过；没有安装、重载或修改真实 DSH 配置。

格式、构建与离线打包通过。安装包 **74 个文件、1,016,723 字节解包内容**与当前工作区逐文件字节一致，SHA-256 为 `99a50932753b723595f30aa2763c7098c60160322f12dd58099bdf9605e40467`。打包后原验收基线两项再次通过；临时预览页、进程与合成数据库均已关闭清理。

## 一步回退后的待办恢复（2026-10-21）

本批基于 `03aff1a6eb7e16ef8d6067dfb1213914cdaa4b6a` 工作树，新增 `src/host/rewind-todos.js` 并接入既有 `DesktopSessions.rewind`，没有读取参照插件或修改真实 DSH profile。原 117 项验收前五列未变，`SESSION-VIEW` 仅更新已验证子路径。

行为是：切点保留列表中的进行中任务，若在被切除的同一轮内连续存在且最终完成，则在新分支恢复 pending。较早 completed、原本 pending、列表顺序和正文保留；后缀新增、跨 turn、重命名、删除后重建的同文任务不混入。官方工具执行后通过持久 flush、投影及新增事件共同确认，之后才归档原会话。具体合同与边界见 [会话附件与任务合同](session-attachments-contract.md#原生-todo-语义)。

- 3 项原创合成测试验证选择算法、无须改动路径、歧义与非法快照拒绝。
- 6 项新增官方隔离场景验证实际 todo_write、仅目标任务 pending、原会话不变、JSONL 读回及派生消息中无内部标记；覆盖执行前拒绝、执行后拒绝但已经写入、PTC 直接工具限制、新分支输入竞争、adapter 关闭取消。没有通过直接写事件替代被测工具。下一轮 turn/start 仍按官方行为清空，未实现跨轮重应用。
- 6 项界面测试覆盖确认数量、未确认、写入后仍为整体 partial、转义和没有新增字段时的旧显示。1280×720 回环组件预览实际渲染真实 `rewindSummary` 与现有样式，三种合成回执可见，控制台 warning/error 为零。截图保存在忽略目录 `artifacts/rewind-todos-preview.jpg`。这仅是回执组件视觉检查，未接 Electron 会话切换或真实模型。

本机使用 bundled Node `24.21.0`、显式 `DSH_UNLIMIT_RUNTIME` 和已校验的 `artifacts/official-packages`，执行：

```sh
node --expose-internals --test tests/*.test.mjs
node scripts/check.mjs
node scripts/provenance-check.mjs
node scripts/self-audit.mjs
node scripts/pack.mjs
node --test tests/parity-baseline.test.mjs tests/package-contents.test.mjs
```

完整隔离回归 966 通过、0 失败、0 跳过，日志为 `artifacts/rewind-todos-full.log`；语法检查 180/180，既有有限来源与分层检查通过。文档更新后重新验证 117 项基线与实际 npm 包内容/文档链接，3 项通过。安装包共 75 个发布文件，SHA256 为 `d7d772e4ae4a1f2b0292a26148d7c15869122ba699e8a50476e964a5b2165c76`。这些结果不代表完整 SESSION-VIEW 或真实桌面 1:1 已验收。

同期只读核对官方本地包安装接口，确认无法由当前逐次调用保证离线，工作台安装仍禁用且说明实际原因；详见 [维护合同](maintenance-contract.md#本地包升级接口核查2026-10-21)。没有以包构建测试替代升级测试，没有安装、重载、真实配置变更或模型联网。

## 同轮提示词旧版残留与撤销恢复（2026-10-21）

从 `693f0d5a176d7fff401cbc226809879b38c28382` 继续，核心场景首次复现 DeepSeek 默认协议第 2 步同时发送 A/B，重试再叠加 C、下一步再叠加 D；其余三协议没有这个残留。失败断言比较实际原生 system 字段，诊断同时确认 Session 投影也是累积版本，排除单纯序列化重复和仅重试缓存问题。修复使用官方投影的替换方式提交最新完整正文，不删除原始日志。

进一步复现当前会话撤销后，原生 in-history 会把最后一次插件正文继续带入下一次请求。已通过下一次允许进入的官方预步骤声明新请求系列恢复宿主正文；撤销时不写空闲日志、不启动任务。直接在 turn/end 后追加恢复系统消息的隔离实验被官方 JSONL reader 判定为非法，因此该尝试没有保留在实现中。

[官方多步专项](../tests/prompt-steps-host.test.mjs) 9 项：四协议分别执行 replace/append 的 8 项 A/B/C/D 工具与重试链，加一项撤销后先拒绝、再取消、随后正常发送及恢复监听释放。原始系统事件四版仍在；有效投影、原生请求字段和 JSONL 读回一致，人工输入、功能段、schema 和两个工具结果保留。另有 4 项 prompt-refresh 单元回归，其中 1 项新增，验证不修改调用者选项和失效回调不读设置。

测试使用实际官方 AgentLoop、ToolRuntime、重试执行器和四协议适配器；模块入口先核对发行清单。HTTP/SSE、凭据及工具返回为原创合成数据，没有真实网络、模型或 profile。恢复覆盖本次已跟踪的驻留 Agent，未跟踪继承分支、卸载后冷恢复和跨实例路径仍有缺口；不把这批结果扩张为完整桌面 1:1。117 项验收前五列、来源说明、NOTICE 和许可状态保持。

最终 bundled Node **v24.21.0**、显式官方运行时与固定归档的完整隔离回归 **976 通过、0 失败、0 跳过**，日志 `artifacts/prompt-current-full.log`；语法 **181/181**、格式、有限来源与分层检查通过。打包后基线与发布文件/文档链接专项 **3 项通过**。安装包 **75 个文件**逐项与工作树字节一致，SHA-256 为 `e41512b7abf20d8aa4cb5572c995bb79ca8fae68667c533991301faa058ca549`。没有页面代码变化，本批未重复浏览器预览；没有安装、重载、真实配置写入或模型调用。

## 关闭会话与继承分支的提示词恢复（2026-10-21）

从 `230212340e5469cb18369dea7720e545fb61ca0e` 继续，补齐撤销后先关闭会话、稍后恢复，以及尚未被 request 包装接管的继承分支路径。新自有系统消息保存版本化 source 标记；插件在已加载但运行控制关闭时，识别当前有效消息中的准确标记，在下一次允许进入的步骤交由宿主恢复当前正文。关闭状态不读设置数据库、不启动请求、不写空闲日志；插件 scope 释放同时使待返回回调失效。标记不改变原生 source.kind，不修改冻结消息，也不进入模型协议载荷。具体合同见 [关闭会话后恢复](prompt-sections-contract.md#关闭会话后恢复)。

[官方恢复专项](../tests/prompt-recovery-host.test.mjs) 四协议各测 replace/append，共 8 项：通过真实 AgentHandle 销毁 Agent 与 Session 后从物理 JSONL resume，同时创建未发送过请求的官方 fork。修复前 DeepSeek 两项明确捕获首次请求仍包含旧自写正文；其余六项原生正文替换已正常，但新增持久所有权断言失败。修复后全部通过，核对新实例、日志前缀、原始正文保留、当前投影与协议内容，以及无额外请求。没有以纯 Session 回放替代实际 Agent 冷恢复。

新增实际插件挂载测试验证默认关闭、同文无标记不动、拒绝原样、零数据库读取/日志写入，以及卸载期间等待回调失效；两项单元回归覆盖冻结 commit/message/source、原生 ID/字段与空替换节点保留，以及旧无标记/外来/未知版本消息不被追认。完整回归首次发现标准模式隔离运行时缺少新恢复校验所需的两个包：错误为 `dsh-session: Cannot find module`，请求尚未发出。只在测试夹具增加按发行清单逐文件校验后复制的 `dsh-session` 与 `dsh-agent-loop`，没有放宽生产路径或摘要校验，原压缩历史验收断言未改。

最终 bundled Node **v24.21.0**、指定 **0.2.1-rc.2** 运行时和固定官方归档的完整隔离回归 **987 通过、0 失败、0 跳过**，本地日志 `artifacts/prompt-recovery-final.log`；语法 **182/182**，有限来源与分层检查通过。离线构建和打包完成，**75 个文件、1,029,355 字节解包内容**逐项与工作树一致；SHA-256 `334de78c3888e0a96d0b2071ce4d28e4950c5c9f6fbc4aca45b00099c2d41d81`。

原 117 项验收前五列、来源说明、NOTICE、UNLICENSED 与第三方归属保留，仅更新 DESK-REVERT 的实际状态。旧版无标记历史、插件完全卸载后的冷恢复、真实应用重启/HMR及桌面嵌入仍不宣称通过；所有模型传输和会话为合成数据。本批没有 UI 改动、真实安装、重载、profile 读写或真实模型调用。

## 待办回退的提前拒绝与日志完整性（2026-10-21）

从 `e5c09759a04fce642aad04988b33e83b40cc9f94` 继续，本批没有补成 PTC 待办恢复。此前尝试通过完整 PTC 预设的 `run_code` 调用嵌套 `todo_write`，实际后端写入成功，但官方 reader 在重新读取分支时拒绝：`tool/ptc-dispatch-start is outside an open turn`。该尝试已撤回；本地失败记录为 `artifacts/ptc-rewind-backend.log`，实验脚本副本为 `artifacts/ptc-rewind-attempt.mjs`，均不发布。公开接口核对及限制见 [会话合同](session-attachments-contract.md#原生-todo-语义)。不能把前一版测试通过或工具返回成功写成 PTC 功能已完成。

实际交付两项修复：已加载源 Agent 不支持直接恢复时，在创建分支前明确返回 `TODO_RESET_UNSUPPORTED`；支持的普通模式写入后，必须由官方 reader 完整读取合法日志，并核对持久事件、内存事件和任务投影，才允许报告恢复完成、归档原会话。冷源或分支能力不同仍可在创建后失败，此时保留准确的部分结果。

[会话专项](../tests/sessions-host.test.mjs)与选择算法共 **21 项通过**，新增故障注入证明“flush 成功、内存待办正确、保存日志非法”不会被认作成功，不归档源会话。源 PTC 拒绝也确认零 create/fork/tool execution、原事件和待办不变。写入后策略拒绝但日志合法的已有场景仍报告 `verified:true` 与整体 partial，两者没有混淆。

另外显式执行 [完整 PTC 预设回归](../scripts/probe-ptc-rewind.mjs)，**1 项通过**，结果为 `unsupported-as-expected`。官方预设、schema 和 reader 实际加载，`run_code` 可见且嵌套 SDK 包含待办工具；调用本项目 rewind 后，在建分支前拒绝，零新会话、归档、工具调用、模型请求和后端子进程。原会话物理 JSONL 字节及完整官方读回前后相同，隔离目录清理通过。[结构化记录](evidence/ptc-rewind-acceptance.json)明确标记未执行实际 PTC 后端，不复用此前实验的成功断言。夹具只增加经发行清单校验的 tool-todo 与 tools 包，未放宽摘要门或宿主策略。

最终 bundled Node **v24.21.0**、指定 **0.2.1-rc.2** 运行时与固定归档的完整隔离回归 **988 通过、0 失败、0 跳过**，日志 `artifacts/rewind-validity-full.log`。语法 **183/183**、有限来源与分层检查通过；117 项原验收前五列未变。进度首页增加面向使用场景的简表，来源说明、NOTICE、UNLICENSED 和第三方归属保持。本批没有 UI 代码变化，未重复页面验收；没有安装、重载、读写真实 DSH profile 或模型联网。完整 1:1 和真实桌面验收仍未完成。

格式、离线构建及打包通过；包内 **75 个文件、1,030,157 字节解包内容**逐文件与工作树一致，SHA-256 为 `92ee376e7e87343117d425c47ea07f7e6c0a6a54c68eb6f9dc37f435e5cd8b01`。打包后原验收基线和实际发布文件/链接检查 **3 项通过**，新增显式 PTC 证据的 8 个源码摘要与当前文件一致。

## PTC 子代理追加输入的来源回退（2026-10-21）

从 `9584e3f64cec035c2ae3651768e4d7bcfcea8b00` 继续，补齐此前完全拒绝的 PTC 直接 SDK `send_message` 路径。成功投递的子工具观察器同步保存消息 ID、dispatch-start 和外层 run_code 身份，新增版本 2 记录；读回再核对成功 settled 及完整外层结果。同一程序多次向同一子代理发相同文本不会混淆。子发送已成功、程序随后报错时仍保留实际投递因果；子工具失败、缺少结果或来源不明仍拒绝猜测。普通版本 1、默认创建来源和原切点语义保留。具体约定见 [子代理来源合同](child-rewind-contract.md#ptc-内直接发送的来源)。

完整隔离回归 **1025 通过、0 失败、0 跳过**，使用 bundled Node **v24.21.0**、显式官方 **0.2.1-rc.2** 运行时与固定归档，日志 `artifacts/ptc-child-full.log`。本批新增 37 项含子场景，覆盖版本 2 正常/未settle、outer失败、同文多次和settled交错，错误根/工具/参数/身份、继承和重复记录、缺少或错误完成结果等；不能把这些数量视作桌面验收项。语法 **184/184**、有限来源与分层检查通过。

另显式运行 [完整 PTC 子代理探针](../scripts/probe-ptc-child-rewind.mjs)，**3 项通过**（两个场景及父测试）。实际通过官方 AgentLoop 开启父回合，在首轮以官方 API 创建持续子代理，停在合成模型传输；第二轮的真实 PTC 程序顺序发送两次同文消息，另一场景发送一次后主动抛错。两次官方后端进程、三次实际 send_message、8 次合成模型请求、10 次官方 reader 与物理 JSONL 读回。按最近消息准确映射后，实际创建分支、归档源会话、取消旧子任务和新分支继承队列，恢复草稿保持未发送；程序失败场景仍准确确认已经发生的子投递。没有伪造被测 call/result/dispatch/catalog，没有直接绕过工具调用策略。

首次探针因测试错误地假设 relay 正文没有官方发送者包装而失败；核对已校验的官方 `createAgentMessage` 后，改为精确断言其发送者块加正文两块，不放宽为模糊包含。另将场景 ID 改为固定独立编号，避免失败后重复创建同名测试会话。最终日志为 `artifacts/ptc-child-backend-final.log`，[结构化证据](evidence/ptc-child-rewind-acceptance.json)仅在所有测试与清理成功后生成，12 项源码摘要与当前文件一致；两个后端、控制通道和临时目录均已清理，禁止的网络/文件/子进程尝试为零。

模型和工作区绑定查询是明确的合成边界；没有真实安装、重载、profile 读写或模型联网。本批无 UI 代码变化，沿用现有“最近接纳输入”入口和结果展示；未重复预览，不宣称桌面端到端通过。更深 PTC 执行父链、未记录旧历史与直接 API 输入仍有差距；PTC 待办立即恢复仍不支持。117 项验收前五列、真实来源说明、NOTICE、UNLICENSED 和第三方归属保持。

格式、构建和离线打包通过，**75 个发布文件、1,033,213 字节解包内容**与工作树逐项一致，包 SHA-256 为 `6d9e5d591215d4205e6a3daaf882dcd6471215cd7658cfd51c8049f8fb4daa10`。打包后的 117 项基线及发布清单/文档链接检查 **3 项通过**。

## 明确任务的可选汇总（2026-10-21）

从 `8fd8ef9f58f54687cfbb26d3f510d0f37e34671f` 继续，`workflow.plan.create` 新增默认关闭的 `summarize`。开启后追加一个 planner 汇总任务，等待当前计划所有源任务结束且资源释放；完整来源、失败和依赖阻断交给汇总任务，来源始终标记未独立核实。汇总复用原有准入、绑定、槽位、停止和清理。超过 32 KiB 明确阻断且不截断源结果，不能用成功汇总掩盖原任务失败。详见 [计划合同](workflow-plan-contract.md#可选指挥汇总)。

`tests/workflow-plan.test.mjs` **22 项通过**，包括完整来源、等待处置、失败/未执行、上下文超限、非 JSON 结果、保留 ID 以及停止汇总。`tests/workflow-host.test.mjs` 的 **8 项官方隔离测试**含新增两条：实际两个官方 spawn 执行者结束后，第三个 planner 请求收到准确 runId 和完整结果；官方 max-tokens 失败及被阻断的后继也传入汇总，只有失败源与 planner 两次请求。逐字段比对输入来源，逐块比对输出、收据和官方 JSONL reader 读回；未改写官方执行流程。模型响应为固定合成文本，**验证的是调度与数据传递，不证明真实模型的总结质量或证据判断准确性**。

页面增加默认未勾选的汇总开关与额外调用提示，直接展示汇总正文、来源和失败/未执行原因，保留完整原始回执。1280×720 回环组件预览实际执行勾选、提交、刷新和停止，确认 `summarize:true` 只随勾选提交，合成文本中的 HTML 原样显示、不执行，样式与模块加载正常，浏览器无 warning/error。预览发现正常 `completed` 被误列为错误，已修复并重新渲染；最终 UI **8 项通过**。截图在忽略目录 `artifacts/summary-preview.png`，仅为真实组件加合成 API 的界面证据，不代表 Electron 嵌入验收。

bundled Node **v24.21.0**、显式 **0.2.1-rc.2** 运行时与固定官方归档执行完整隔离回归 **1041 通过、0 失败、0 跳过**，日志 `artifacts/summary-full.log`；正常完成提示修复后重跑 UI 与包/基线检查 **11 项通过**，日志 `artifacts/summary-final-check.log`。语法 **185/185**，有限来源和分层检查通过。117 项前五列及来源、NOTICE、UNLICENSED、第三方归属保持，FLOW-DISPATCH 只更新已验证状态，仍未宣称完整通过。

离线构建打包成功，**75 个文件、1,042,060 字节解包内容**逐项与工作树字节一致，SHA-256 `f2e74109045aa9e6f7091def5c2de731d4fe30488ff106fd391338af6e3dbde4`。本批没有安装、重载、真实 profile/config/session 修改或真实模型请求；自动任务拆解、工具匹配、PTC 待办恢复及真实桌面验收等缺口仍保留。

## 本地预览进程的实际响应与停止（2026-10-21）

从 `11ad070ecba27ee836e7fa66c534112830487aa9` 继续，本批不改变生产实现或页面，而是补齐 CORE-DELIVERABLE 中尚未执行的回环预览进程路径。新增 [显式探针](../scripts/probe-preview-process.mjs) 通过实际 `installTools → 官方 ToolRuntime → DesktopProcesses → 官方 LocalSubprocessRuntime` 启动固定原创 Node 服务，取得 HTTP 200 与完整合成 HTML，再经同一插件工具停止；实际 `spawn → exit(0) → close(0)`、关闭日志和同端口 `ECONNREFUSED` 均核对通过。只有一个子进程、两次指定回环连接，均确认结束，临时根已删除。

探针 **1 项通过**，包含四组场景断言；182 个官方加载文件通过发行清单校验，五项本项目源码摘要与当前字节相同。[结构化证据](evidence/preview-process-acceptance.json)在所有断言和清理通过后生成。Agent 是注册到真实官方目录的合成对象，调用、绑定、入场确认及 full-access 模式也是合成边界；工具标识映射到 bundled Node 只用于固定程序。没有 AgentLoop、真实模型、人工审批、内核沙箱或桌面渲染证据，不把一次真实 HTTP 响应当作完整桌面预览验收。详见 [交付合同](deliverables-contract.md#受控回环预览进程)。

同时修复进程验收的环境门：未提供宿主路径时仍明确跳过；在目标平台上显式提供无效路径改为失败。实际执行两种情况，前者 exit 0 / skipped 1，后者 exit 1 / failed 1 / skipped 0，日志分别为 `artifacts/process-gate-absent.log` 和 `artifacts/process-gate-invalid.log`。不再用跳过掩盖明确配置错误，原七项真实进程回归继续通过。

bundled Node **v24.21.0**、指定 **0.2.1-rc.2** 运行时和固定归档的完整隔离回归 **1041 通过、0 失败、0 跳过**，日志 `artifacts/preview-process-full.log`；语法 **186/186**，有限来源与分层检查通过。117 项原验收前五列未变，仅更新交付路径的实际状态；来源说明、NOTICE、UNLICENSED 和第三方归属保持。没有读取旧插件、安装、重载或修改真实 DSH 配置。

构建、离线打包和包/基线检查 **3 项通过**；本批没有发布文件变化，安装包仍为 **75 个文件、1,042,060 字节**，SHA-256 `f2e74109045aa9e6f7091def5c2de731d4fe30488ff106fd391338af6e3dbde4`，包内字节逐项与工作树一致。

## 目标生成任务草稿（2026-10-21）

本轮基于 `9db7f53b93f3964b6ad87bc19fe8607ec0ac70ef` 的工作区修改，新增 `workflow.plan.propose`、目录候选与结果解析、模型工具/Controller 路由和页面生成/填表入口。对应 `FLOW-DISPATCH`，117 行前五列不变；来源说明、NOTICE 与许可状态保留。本节随功能提交，不能自动代表以后版本。

实际路径：目标和父会话目录 → 普通官方 planner 执行 → 原始结果与临时 JSONL → 校验后的草稿 → 用户检查/编辑 → 既有显式计划执行。生成不会自动启动草稿中的任务。规划者只有提示要求不调用工具，仍继承宿主工具与权限，不是无工具沙箱。目录只提供候选名字与描述，校验不证明模型选择正确或具备执行授权；项目私有技能暂不进入候选。

验证与结果：

- 使用固定 bundled Node `v24.21.0`、官方 `0.2.1-rc.2` 运行时及本地已校验包缓存，完整 `--expose-internals --test tests/*.test.mjs`：**1060 通过、0 失败、0 跳过**。日志为本地忽略目录 `artifacts/plan-draft-full-authorized.log`。首次普通沙箱运行因本机回环 listen 的 EPERM 导致 20 项既有用例失败，不能算通过；获得项目隔离测试所需执行权限后重新运行同一测试集通过，没有改弱断言。
- 新增规划用例覆盖目录外能力、未知角色、循环/缺失依赖、额外字段/预设选择、非 JSON/非文本/超限输出、停止、失败、关闭/父改绑、等待处置后才产出草稿、另行提交和 UI 过期响应/文本转义。官方 spawn/AgentLoop 用例实际执行规划和后续明确任务，验证收据处置、槽位释放、原始结果持久读回；LLM 传输与任务材料为合成，没有真实模型调用。
- 回环组件预览使用真实 `workflowPlans` 页面、`DesktopWorkflowPlan/Workflow/Flow/WorkspaceStore`，替代的仅是激活结果与目录。浏览器实际完成输入目标、生成、读取、填表、提交及结果读取；两个合成任务均显示完成、处置和槽位释放。实际预览视口为 **1280×720**，不是历史记录中的 1280×820，也不是 DSH 嵌入验收。页面无 console error；截图 `artifacts/plan-draft-preview.png`。合成服务、浏览器页和临时数据已清理。
- 语法检查 **187/187**、来源记录有限检查、54 模块分层检查、117 项验收基线检查通过。来源检查不证明法律独立性。
- 构建与离线打包成功，包含 **76 文件**，每个文件从 tar 中读回与工作区字节比对一致，包含新的 `src/host/workflow-draft.js`；tgz 为 **322968 字节**，SHA-256 `bcbcf0966599dcceec0103b45728f48515cd7db4fe0ca95d8b935b43af2970ae`。包内容仍仅为发布允许列表，不含 profile、临时数据库或测试宿主代码。

完整回归命令：

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
DSH_UNLIMIT_OFFICIAL_PACKAGES="$PWD/artifacts/official-packages" \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
--expose-internals --test tests/*.test.mjs
```

本轮没有安装/重载插件，没有修改真实 DSH 配置、profile 或会话。真实模型拆解/匹配质量、项目技能、自动执行闭环、技能递归依赖和真实桌面仍是差距；不能把本次提交称为完整 1:1。

## 项目技能正文进入任务执行（2026-10-21）

基于 `98359563d59e06abcedb06253aedab55c7ec246b` 的工作区新增精确技能引用和执行正文接入。任务的 `skills:[{origin,id}]` 与名字式 requirements 分开：规划者能选择项目技能候选，执行前从技能文件读取依赖声明与完整正文；二者来自同一次读取。任务不能覆盖声明，正文只进入选中它的执行者。项目 SKILL.md 可使用 `dsh-unlimit-requirements` JSON 数组；未声明仍 unknown，空数组才表示显式无依赖。

本轮证据：

- 固定 bundled Node v24.21.0、官方 0.2.1-rc.2 运行时和已校验包缓存，完整 `--expose-internals --test tests/*.test.mjs`：**1071 通过、0 失败、0 跳过**。日志 `artifacts/skill-task-full.log`；执行权限仅用于测试所需的回环服务和临时子进程，不是安装授权。
- 新用例核对原始项目正文进入真实官方 AgentLoop 请求及临时 JSONL、准确 origin/id、同名宿主正文不误入、其他任务不包含正文，以及处置后槽位释放。模型响应、工作目录与材料均为合成；没有真实模型请求。
- 目录/调度用例验证同次读取的声明与正文、下一次读取看到变更、排队时依赖变化重新阻断、缺依赖声明、未知/缺失工具、禁用模型调用、正文超限、不完整正文交付、伪造来源和任务覆盖声明的拒绝。原始正文保留，没有截断后派发或猜测依赖。
- UI 合成测试验证项目技能引用展示、填表和提交不丢失引用、文本转义；新增断言首次因测试输入未加入技能引用而失败，补齐合成输入后通过，未删除断言。浏览器 1280×720 回环组件预览实际完成“目标 → 带 project/evidence-review 的草稿 → 填表 → 提交 → 两任务完成/释放槽位”；真实页面/协调器/目录/临时技能库，激活与响应合成。无 console error，截图 `artifacts/skill-task-preview.png`；预览进程退出 0，临时数据已清理。
- 语法 187/187、有限来源记录和 54 模块分层检查通过。117 行前五列保持不变，来源说明、NOTICE 和许可状态未删除。
- 构建、离线打包成功。包内 **76 文件**逐个与工作区字节读回一致，tgz **324687 字节**，SHA-256 `4920fddda396fc959211ada46e081b8de08720e4607d2e6c9727c609a66a06d8`。未包含测试数据或宿主模块。

此功能只交付 SKILL.md 正文，不自动加载附属资源、不运行脚本、不递归展开技能依赖、不改变执行者工作目录。真实模型的选择和执行质量、真实桌面、自动执行生成计划及其余 1:1 差距仍未完成。本轮未安装插件、未更改真实 DSH 配置/profile/会话。

## 显式自动规划执行与核心差距排序（2026-10-21）

基于 `e3f687071ec06c27a08ccd66b5fa2bbd51b9142d` 的工作区改动。新增 `workflow.plan.run` 和“规划并执行目标”入口：规划结果经严格结构及候选校验后，直接进入同一计划队列；保持原 propose 只生成草稿的语义。完整原目标进入各任务，逐任务准入、父会话绑定、依赖预检、停止及处置保持。汇总只引用实际生成任务，不把规划输出当执行来源。

- 定向回归 **120 通过、0 失败、0 跳过**：`workflow-plan`、`workflow-host`、`workflow-plans-ui`、`plugin`、`controller`。包括等待规划者释放槽位、非法输出及保留 ID 拒绝、规划/预检期间停止、准入撤销、原目标加入后超限、能力撤销不切换入口。
- 官方隔离场景用真实 spawn/SubagentRuntime/AgentLoop 执行规划、项目技能任务、依赖任务和汇总四次请求；合成模型传输。逐次检查目标、技能正文隔离、原样依赖结果、汇总来源、四份临时 JSONL、处置及槽位释放。
- 全量 `--expose-internals --test tests/*.test.mjs` **1085 通过、0 失败、0 跳过**，`DSH_UNLIMIT_RUNTIME` 指向已安装 0.2.1-rc.2，干净官方归档来自 `artifacts/official-packages`；使用宿主附带 Node。完整测试因既有回环监听需要通过工具审批运行，未修改测试期望或宿主权限。
- 浏览器 **1280×720** 回环组件预览实际点击“规划并执行目标”，同一编号下规划者、两个任务、汇总均完成并释放槽位；自动计划不能再填表重复提交。页面、协调器、目录和临时技能库是真实项目模块，activation 和模型输出为合成；无 console error。截图 `artifacts/automatic-goal-preview.png`。任务自有预览进程经身份确认后 SIGTERM，退出 0 并清理临时数据。
- 语法 **187/187**、有限来源记录与 **54 模块**分层检查通过；117 项原验收前五列不变。新增核心差距优先顺序，明确 FLOW-DISPATCH 属配套功能，未以它替代核心运行控制验收。
- 构建和离线打包成功；包内 **76 文件**逐项与当前工作区字节一致。tgz **326089 字节**，SHA-256 `d74bdddf67266b56a64140b3052b068dd7c8a0986a271aca677f00c590bf46de`。文档更新后另跑基线与交付检查 **3 通过、0 失败、0 跳过**。

此批证明自动调度和数据传递，不证明真实模型规划、技能选择和执行质量。核心 Hook/记忆策略、终端/内核沙箱链路、技能附属资源和真实桌面等原差距保留；全量回归不等于完整 1:1。未调用真实模型、未安装插件、未更改真实 DSH 配置/profile/会话。NOTICE、开发来源和 UNLICENSED 状态保持。

## 完整 standard/PTC 网页调用（2026-10-21）

基于 `c14f088b6ee9eaaa46deecf39b39f81de05a0672`。这批补齐 `CORE-WEBTOOLS` 的完整模式执行证据，没有发现或修改产品源码缺陷；产品安装包与上一批字节相同。原先组件调用证据继续保留，不将新路径扩大成全部工具或真实桌面通过。

- standard 完整官方预设、Loader/Registry、AgentLoop：replace、计划模式、revert 三次实际 `web_fetch`，八次合成模型请求包含另一次原生回环拒绝。正文、来源、不可信说明进入下一轮，schema 保留，官方 JSONL reader 全量读回。`tests/webtools-preset-host.test.mjs` **5 通过、0 失败、0 跳过**。
- PTC 显式探针：**3 通过、0 失败、0 跳过**，replace/revert 各一个真实官方 Node/Seatbelt 子进程，四次合成模型请求、两次 run_code 和两次内层 web_fetch；原生 SDK 和工具 schema 保留。调用 ID 因果对应、完整 canonical 正文及 URL、下一轮消息、物理 JSONL 与官方 reader 都已核对。643 个实际官方导入文件摘要验证，来源摘要和清理证据见 [ptc-web-acceptance.json](evidence/ptc-web-acceptance.json)。
- `--expose-internals --test tests/*.test.mjs` **1090 通过、0 失败、0 跳过**。之后补强拒绝场景，要求运行控制启用时也保留 `WEB_BLOCKED_URL`；定向测试连同 117 项基线复验 **7 通过、0 失败、0 跳过**。PTC 进程探针独立执行，不包含在 1090 中。
- 语法 **190/190**、有限来源检查和 **54 模块**分层检查通过。构建与离线包成功：**76 文件**，SHA-256 `d74bdddf67266b56a64140b3052b068dd7c8a0986a271aca677f00c590bf46de`，与上一批一致。没有新增发布文件、运行依赖或网络服务。

复验命令、合成边界和调用路径见 [网页合同](webtools-contract.md#完整-standard-与-ptc-执行2026-10-21)。网页/DNS/模型响应均为合成，不证明真实模型能抵抗页面提示注入；原生 resolver 保留，没有真实网络。PTC 子进程和控制管道均关闭，live 集合为零，临时根清理且所有禁止访问记录为空。未安装插件、未更改真实 DSH 配置/profile/会话，未修改来源说明和原验收前五列。

## standard 文件与 shell 的实际权限一致性（2026-10-21）

基于 `50607362d76d284eaced4bdcd482d4b9caf896f9`，新增显式探针与默认关闭的测试夹具选项，没有修改产品代码、官方预设或原验收期望。

- `scripts/probe-standard-shell.mjs` **6 通过、0 失败、0 跳过**：完整官方 standard 预设下，四个会话、五轮执行，25 次合成模型请求，20 次真实 write/bash 调用、10 个实际 Bash 子进程。覆盖只读、工作区内外、全访问默认、同一会话显式切回只读、撤销后的默认恢复。所有允许项逐字读回，所有拒绝项确认目标不存在；原生进程退出码为 3 个 0、7 个 1。
- Bash 的非零退出仍是 `isError:false` 的已完成工具回执，不能按包装字段算成功。实际检查退出码、沙箱拒绝说明和磁盘结果；文件工具另检查 `FS_SANDBOX_DENIED`。最初探针因缺官方必填 description 未启动 shell，补参数后又发现上述回执语义误判；修正新增测试的错误假设后通过，没有改产品错误处理或删除原断言。
- 535 个实际官方导入文件经库存摘要检查；官方 JSONL reader 和物理日志核对调用、结果及权限切换。10 个实际进程 close，subprocess/controlChannels 为 0，临时根删除，禁止访问记录和清理错误均为空。证据及所测源码摘要见 [standard-shell-acceptance.json](evidence/standard-shell-acceptance.json)，已另行核对摘要与当前文件一致。
- 修改共用夹具后，全量官方隔离回归 **1090 通过、0 失败、0 跳过**；上述实际 shell 探针独立运行，不包含在 1090 中。语法 **192/192**、有限来源检查、**54 模块**分层检查通过。构建及离线打包成功，76 个发布文件；包 SHA-256 `d74bdddf67266b56a64140b3052b068dd7c8a0986a271aca677f00c590bf46de`，与上一批一致。

复验命令和覆盖表见 [文件权限合同](file-permissions-contract.md#完整-standard-文件与-shell-权限对照2026-10-21)。这批证明固定文件写入在官方文件后端与标准 shell/Seatbelt 下的效果一致，不证明持久 PTY 权限切换、所有内核边界、shell 升权重试或真实审批 UI。未安装或重载插件、未改真实 DSH 配置/profile/会话，真实来源说明及 117 项原验收保留。

## 卸载回执中的历史提示词范围（2026-10-21）

基于 `4037ceff43c9f689e25fc26ffde494b1db19a49f`，修正工作台卸载确认和回执的说明缺口，没有实现或宣称完全卸载后的历史提示词恢复。准备链返回 `promptHistory:{status:"not-restored",scanned:false}`；成功和失败回执均保留，缺字段时不推断恢复成功。

- `tests/prompt-recovery-host.test.mjs` **9 通过**：新增真实 Cordis 插件作用域释放后，DeepSeek 旧会话冷恢复仍携带自写提示词的复现；新会话不含该残留。三个合成模型请求，完整 JSONL 前缀保留，关闭、释放和恢复均不自动发消息。首次新增断言误将官方 resume 自动追加的 `session/end-seed` 视为日志改写；核对 Session 构造器后改为精确检查原前缀与唯一原生标记，没有修改宿主行为或既定验收目标。
- Controller、维护和 UI 定向 **40 通过**；完整 `--expose-internals --test tests/*.test.mjs` **1092 通过、0 失败、0 跳过**。首轮环境 PATH 缺 `/opt/homebrew/bin`，仅 npm 打包测试 ENOENT；补齐工具路径后同一套全量测试通过，没有放宽断言。
- **1280×720** 回环预览使用真实工作台页面、Controller 准备链和临时 SQLite，卸载管理器为合成。实际检查诊断说明、打开确认、取消、再次确认、只读回执和历史提示词字段；无 console error。截图 `artifacts/uninstall-history-preview.png`。预览进程退出 0，临时数据已由退出处理器清理，预览页已关闭。
- 格式、192 项语法、有限来源与 54 模块分层检查通过。117 项原验收前五列保持。构建与离线打包通过：76 文件、326534 字节，SHA-256 `df8e71346b9925f04239ba84db82d3fdf2f8f1b3986e7ff87f7527b785df98af`。

本批不包含真实桌面安装、卸载、HMR 或用户会话验收；没有读写真实 profile，没有调用真实模型。NOTICE、来源说明和 UNLICENSED 保留。旧会话提示词自动清理仍为明确缺口，不能把本次披露修复记为 1:1 完成。

## 项目技能附属文本进入执行（2026-10-21）

基于 `d1c2b0c4be49022694b6a55a00219a6d34da94b4`，新增明确任务的 `skills[].resources` 路径选择。使用既有技能库的一次快照读取，向所选任务提供准确资源正文、字节数和 SHA-256；不自动执行脚本，不复制原项目代码或文本，不改变 cwd/权限/审批。具体输入与限制见 [任务合同](workflow-plan-contract.md#项目技能的显式附属文本2026-10-21)。

- 目录、计划、官方工作流和界面定向 **103 通过、0 失败、0 跳过**。覆盖同次快照、BOM/CRLF/空白保留、仅所选资源传递、普通预检不含正文、缺失/非 UTF-8/NUL/文件超限/整体任务超限、非法路径和宿主资源拒绝、自动规划不能猜资源路径、表单提交及阻断前零执行者。
- 官方执行者用真实 spawn/AgentLoop，选定 `references/count.md` 的完整 JSON 进入请求，并在临时 JSONL 中读回。SKILL.md、依赖和引用资源对应同一技能；未选资源及兄弟任务中无该内容。模型响应仍为合成，不证明模型理解或执行质量。首次新增请求断言因对象键排列与预期字符串顺序不同失败；保留结构深比较，并用已核对的完整上下文序列检查实际请求后通过，没有删减正文断言。
- **1280×720** 回环页面实际填写带资源的任务 JSON、检查、提交、读取完成收据，并展开核对路径、正文、88 字节和摘要。使用真实计划页面/协调器/技能库、临时 SQLite，执行器与结果为合成；console error 为零。截图 `artifacts/skill-resources-preview.png`。本轮预览进程退出 0、临时根由关闭处理器清理、预览页已关闭。
- 全量官方隔离回归 **1099 通过、0 失败、0 跳过**；193 项语法、55 模块分层、有限来源及格式检查通过。117 项原验收前五列保留。构建与离线包通过：77 文件、328189 字节，SHA-256 `866c36dd19643d51b6ec63538a851242a746443949e5b06b8287c2d1fb4b8c73`。

仅完成项目技能的显式附属文本传递。自动资源选择、宿主技能资源、二进制素材、真实模型与桌面嵌入仍有差距；PTC 空闲分支待办恢复仍不支持。没有安装或重载插件，没有修改真实 DSH 配置/profile/会话，没有真实模型请求。NOTICE、来源记录、UNLICENSED 与第三方归属保持。

## 按目录自动选择技能附属文本（2026-10-21）

基于 `62f837e039401ab24e96891100475c463b815c7f`，将项目技能附属文件的路径和字节数接入规划候选。生成的 `resources` 必须属于规划时同一 `origin/id` 的目录，执行前继续使用上一批的当前快照读取与依赖检查；不引入网络、脚本执行、权限变更或作者服务。

- 技能、目录、计划、官方工作流及 UI 定向 **122 通过、0 失败、0 跳过**。规划输入只含路径/字节数，额外正文和 base64 属性不进入输入；跨技能路径返回 `UNKNOWN_RESOURCE`，规划后删除资源阻断生成任务，超过 30 KiB 的完整候选目录不截断、不开规划者。
- 官方完整自动流程包含规划者、带资源的执行任务、依赖任务和汇总，共 4 次合成模型请求。只有所选执行任务收到 SKILL.md 与 `AUTO_RESOURCE_BODY`，其余请求没有资源正文；未选资源全部不进入请求。四个官方 JSONL 均读回，资源正文只出现在对应任务日志；处置确认、槽位清零。官方 spawn/AgentLoop 为真实模块，规划内容和回答为固定合成输出，不证明实际模型选择质量。
- **1280×720** 回环页面实际输入目标，点击“规划并执行目标”，读回规划与两个任务完成，生成表格显示 `project/evidence-review [references/count.md]`。页面、协调器和临时技能库为真实项目模块，执行者为合成，无 console error；截图 `artifacts/resource-planning-preview.png`。预览页关闭，服务器退出 0 并执行临时根清理。
- 全量隔离回归 **1102 通过、0 失败、0 跳过**，193 项语法及 55 模块分层检查通过。格式检查发现新增测试需再次格式化，修正后复查；没有修改业务逻辑或断言。117 项原验收前五列保持。构建、离线打包通过：77 文件、328599 字节，SHA-256 `86b45657e4346f60ba8c09e8078aeb61e852e5fe247c6b2458ad428866602fcb`。

此批补齐项目技能的目录约束选择与传递，不证明模型选择符合目标，不支持宿主技能资源和二进制素材。真实桌面、PTC 待办立即恢复和完整 1:1 仍有差距。未安装、重载或修改真实 DSH 配置/profile/会话，来源说明、NOTICE 和许可状态保留。

## Bash 单次审批后的实际进程重试（2026-10-21）

基于 `cff1d197541e9b139ec42e5ae09598321231408b`，扩展既有 standard shell 探针，只改测试夹具与验收文档，没有修改产品代码或来源声明。新增六个场景的行为和剩余差距见 [扩大权限合同](escalation-contract.md#完整-standard-bash-单次审批与实际重试2026-10-21)。

- 真实完整预设、AgentLoop、官方审批、Bash executor、subprocess 与 macOS Seatbelt 共同执行。只读首次拒绝，同命令带单次申请重试：同意后工作区写入成功，下一普通调用仍拒绝；拒绝审批不启动重试进程；工作区外及第三目录即使同意 workspace-write 仍拒绝。插件自动审批实际写入成功，但显式 never 仍拒绝。
- 六对官方审计 ID/结果、实际进程退出码、磁盘效果、完整官方 JSONL reader、后续模型请求和不变的会话权限均核对。新增 14 次工具调用、12 个真实进程、20 次合成请求；与原有场景合计 12 项通过，22 个进程全部关闭、子进程注册集合为空、临时根删除、禁止访问记录和清理错误为空。535 个实际加载官方文件通过摘要核验。证据为 [standard-shell-acceptance.json](evidence/standard-shell-acceptance.json)，绑定本批探针、夹具和相关产品源码摘要。
- 运行日志：`artifacts/standard-shell-escalation.log`；全量官方隔离回归 `artifacts/shell-escalation-full.log` 为 1102 通过、0 失败、0 跳过。语法 193 项、分层 55 模块检查通过。构建与离线包通过，77 文件、SHA-256 `86b45657e4346f60ba8c09e8078aeb61e852e5fe247c6b2458ad428866602fcb`；产品包与上一批字节一致。

本次前期符号检索曾匹配安装目录既有 `.dshpurge.bak` 的审批相关行；没有执行或复制该备份实现，后续接口检查与加载均使用已校验的官方归档。不能据此次验证声称未曾接触既有材料或严格净室开发。

没有真实模型请求、桌面安装、重载或真实配置/profile/会话变更。预先编排的合成模型重试和合成 answerer 不证明真实模型决策或桌面审批 UI；任意新增目录授权、PowerShell、持久 PTY 权限切换及完整 1:1 仍未完成。117 项原验收目标、NOTICE、开发来源、UNLICENSED 和第三方归属均保留。

## 持久终端权限残留复现与提示修正（2026-10-21）

基于 `8bdbeb8dd7ef2ae4362165a23b22cacb0aa1d8d7`，新增 [PTY 权限探针](../scripts/probe-terminal-permissions.mjs)，结果是 `gap-confirmed`。真实 minimal/AgentLoop/PTY 已证实：原生显式工作区权限必须关闭旧终端后才能切只读；插件全访问默认启动的旧 PTY 在撤销后仍能向外目录写入，只有关闭后新建才拒绝。详见 [权限合同](file-permissions-contract.md#持久-pty-权限切换与撤销缺陷2026-10-21)。

- 第一次执行两个行为场景均复现，但最终守卫发现官方 workspace-write 解析平台临时根时缺少 realpath 元数据许可，因此整体失败且没有发布成功证据。只为已确定的 `/tmp` 和平台临时根增加与既有 shell 场景相同的元数据访问，未开放内容或写入；重跑整体通过。4 个真实 PTY 的退出/FD/registry/subprocess 清理和临时根删除均确认。禁止操作与清理错误为空。
- 原有 minimal 读取/持久状态/撤销正文探针另行复验通过，2 个真实 PTY 均清理；当前依赖由其更新后的 sourceDigests 绑定，脚本 developmentBasis 仍标原场景开发起点。上述回归通过不能当作旧终端权限已自动收回。
- 运行能力说明、还原确认、卸载页面/确认/回执加入真实限制。1280×720 回环合成页面实际打开还原确认，核对提示后取消；维护页也显示关闭终端说明，无 console error。截图 `artifacts/terminal-permission-warning.png`；预览服务正常退出并清理临时库。未执行真实撤销、安装或卸载。
- 全量官方隔离回归 1102 通过、0 失败、0 跳过；194 项语法及 55 模块分层检查通过。构建和离线包通过，77 文件，SHA-256 `2986564b5a7be682f9b11534b709ded912d03af2de7205402ab777f0e3d43d74`。本地日志为 `artifacts/terminal-permissions.log`、`artifacts/terminal-permissions-original.log`、`artifacts/terminal-permissions-full.log`。

本批修复的是错误的完整还原预期；自动收回旧 PTY 权限尚未实现。已询问用户是否在撤销时关闭由插件扩大权限创建的终端（会丢失 shell 状态），或保留并要求手工关闭；该选择未答复前不加入自动终止逻辑。保持 117 项原目标、真实来源、NOTICE、UNLICENSED 和第三方归属，不改真实 DSH 配置/profile/会话。

## 终端只读清单与未知权限来源（2026-10-21）

基于 `d707c33ebcdb97bb181576e0255c8a2d9c702b17`，新增 `DesktopRuntime.terminalStatus()` 与 `status.terminalPermissions`，在诊断页展示当前活动会话的终端归属。检查不调用关闭、发送输入、权限更改或持久化接口；启动权限和插件升权归属明确未知，不能用当前 fullAccess 或只读解析结果倒推。字段及边界见 [权限合同](file-permissions-contract.md#活动终端只读清单2026-10-21)。

- Runtime 与页面定向 37 通过。实际 owner 对象逐项核对，不合并跨会话同名终端；只保留安全元数据，名称/MOTD/PID 不外传；未发布活动、无接口、失败和空清单分别检查。另增加状态 API 回归，验证控制未启用时仍可读取，且没有配置写入或控制操作。
- 真实 minimal/PTY 缺陷探针在撤销后原终端仍可写的时刻，调用新增产品读取方法，核对两个真实终端、精确 Agent/PTY 身份、running 与 unknown 字段，完整 Session 事件没有变化。探针 3 项通过，4 个真实 PTY 清理确认；最终仍标 `gap-confirmed`，因为自动权限收回没有实现。证据 [terminal-permissions-acceptance.json](evidence/terminal-permissions-acceptance.json) 绑定当前源摘要。
- 1280×720 真实组件预览分别展示活动终端/未发布活动、空清单、检查失败，布局和关键文案可见，无 console error。截图 `artifacts/terminal-inventory-preview.png`，数据是原创合成清单，服务器退出 0。另用完整项目合成预览打开诊断页并点击运行诊断，新增检查区刷新、不可用不误报为空，无 console error；Ctrl+C 结束时 npm 返回 1，随后确认该预览端口已关闭，不将 npm 退出码记为 0。预览页均关闭。
- 全量官方隔离回归 1106 通过、0 失败、0 跳过；194 项语法、55 模块分层检查通过。构建与离线包通过，77 文件，SHA-256 `fe39a98e6cfb58f5c64b7923259b7f96b2c2a2731809e8e919da4ba09b9852eb`。日志为 `artifacts/terminal-inventory-targeted.log`、`artifacts/terminal-inventory-host.log`、`artifacts/terminal-inventory-full.log`。

自动关闭方案仍待用户选择，此批没有增加终止行为；现存终端的未知升权归属不能据当前状态补造。117 项原验收目标、来源与许可说明保留，未安装、重载或修改真实 DSH 配置/profile/会话。

## 撤销时回收插件升权终端（2026-10-21）

基于 `89651a3abae5b29a131d11715044a4a50cec4718` 的工作树，用户明确选择关闭插件升权创建的终端后再完成撤销。本批实现创建时归属记录与等待关闭，并更新原对照项 `CORE-FILES / DESK-REVERT / DESK-STATUS` 的状态，未修改原 117 项验收前五列。

- 实际修复：官方终端创建调用与本插件权限解析通过异步作用域关联，只有原受限默认确实被本插件提升才记录。还原先停止后续升权，再等待创建发布和官方关闭；失败不报完成。用户显式全访问、旧终端和未知来源不误关。无需读取终端输出或改写 Session。
- 官方 minimal/AgentLoop/PTY 验收确认：升权终端撤销前实际可写外目录，撤销后注册消失；显式全访问与无关只读终端仍在；下一新建终端被实际只读沙箱拒绝外目录写入。首次 Bash 调用旧缓存会报错并清缓存，下一次才新建；没有自动重放命令。[修复证据](evidence/terminal-revocation-acceptance.json) 绑定最终探针与产品源码摘要，修复前 [缺陷证据](evidence/terminal-permissions-acceptance.json) 保持原文件。
- 初次执行因隔离副本缺少官方后端懒加载的 `@xterm/headless` 而失败；仅向临时干净运行时加入发行清单逐文件摘要核验的该依赖后重跑，未改宿主、未放宽网络或进程守卫。最终真实 PTY 的退出/FD/注册清理、临时根移除及禁止操作检查全部通过。探针日志 `artifacts/terminal-revocation-probe.log`。
- 并发创建/关闭等待、交错显式权限、关闭失败重试、旧回调、外部接口冲突及未发布创建清理失败均有隔离回归。全量官方模块测试 1113 通过、0 失败、0 跳过，日志 `artifacts/terminal-revocation-full.log`。语法/来源/分层检查通过；证据 JSON 格式检查初次失败，格式化后复验。构建、离线打包和 117 项基线检查通过，包含 78 文件，SHA-256 `9160ff34b55272611a73cd8ddbbf931bcbb28f3753e6f6af7c1056fa7124cc64`。
- 1280×720 真实组件与完整合成工作台实际渲染，分别核对已确认/未知归属和还原确认，随后取消，无 console error。截图 `artifacts/terminal-revocation-preview.png`、`artifacts/terminal-revocation-confirmation.png`。组件预览退出 0；完整 npm 预览 Ctrl+C 返回 130，随后确认两端口均关闭。页面全部关闭。

此修复只计入有创建证据的官方终端撤销，不能推定任意后台后代进程、未知旧终端、Windows 或真实桌面均通过。Hook/第三方记忆、完全卸载后的旧提示词恢复、PTC 待办立即恢复等原缺口保持。真实来源、NOTICE、UNLICENSED、DB-IP 归属及原验收基线不变。本批未安装、重载、发起真实模型请求或修改真实 DSH 配置/profile/会话。

## Hook 与第三方记忆接口复核及无效启用修正（2026-10-21）

基于 `f00da73`，优先复核 `CORE-HOOKS / PROMPT-MEMORY`。两项仍缺：当前已核验发行内容中没有定位对应 Hook 执行器/策略接口，也没有确定记忆提供者、来源及独立保留开关。历史 Hook 格式、通用步骤事件、MCP 连接关闭均不算对齐。原因、关键来源行号和继续适配条件见 [合同](hooks-memory-contract.md#本批结论与仍缺条件2026-10-21)。

- 新增只读 `scripts/inspect-hook-memory.mjs`，显式指定运行时，摘要核对后检索发行清单所列入口/声明/patch；不导入宿主、不读 profile、不读备份或自装插件、不联网。结果 [hooks-memory-interface-scan.json](evidence/hooks-memory-interface-scan.json) 只含摘要、路径、匹配行号及调查边界。8 个摘要不符条目仅记录摘要、跳过内容，不据此推导不存在或执行其代码。负向检索不证明整个第三方生态不支持。
- 修复 `settings.save` 仍可新开启无效 Hook 的行为：未适配时从 false 改 true 在持久化前以 `UNSUPPORTED` 拒绝，设置与 revision 不变。已有 true 值保持但不生效，仍能编辑其他设置或明确清除该值。没有引入 Hook 拦截器、记忆删除器或停用 MCP 的替代实现。
- 破甲控制页新增两个未适配原因说明；旧启用值单独注明未生效，原禁用开关不误呈现为有效。完整合成预览在 1280×720 下可见，两项原因准确，Hook 控件禁用、无 console error。截图 `artifacts/hooks-memory-support.png`。关闭预览后 npm 返回 130，回环端口确认关闭；未在真实桌面操作。
- 定向日志 `artifacts/hooks-memory-targeted.log` 为 44 通过、1 项因未设官方运行时门而明确跳过；随后带官方双环境门执行完整回归 `artifacts/hooks-memory-full.log`，1116 通过、0 失败、0 跳过。语法/来源/分层/格式、构建与离线包检查通过；原 117 项验收前五列未变。离线包 78 文件，SHA-256 `bf67b61a641a4d60a9ce3705403395d6f0c70d896a81b6de5365801b85f10637`。

本批完成的是接口核查与无效配置行为修正，不把它记成 Hook/第三方记忆能力已实现。其余已实现破甲路径保持，完全卸载后提示词恢复、PTC 待办恢复等原缺口继续保留。未安装、重载、读写真实 DSH 配置或真实会话，也未改变来源、许可或第三方归属声明。

## 完全卸载提示词与 PTC 待办恢复边界复验（2026-10-21）

基于 `fda11e4` 工作树，用户将 Hook/第三方记忆暂缓，优先补齐这两条恢复路径。本轮没有新增产品实现，两个缺口均保留：当前核验接口未提供所需的合法维护写入路径，不能把绕过原工具边界或伪造宿主步骤当作恢复。

- 提示词新增官方隔离反例：真实步骤完成、插件 scope 卸载后，`runMaintenance()` 内执行原生 `systemPrompt.project()` 替换，内存可以追加，物理 JSONL reader 却以 `system/message does not match an open turn and step` 拒绝。没有制造 turn/step/人类消息、没有清理模型请求，损坏的日志仅在一次性测试目录中存在并被清理。初次断言预期错误文字不准确，随后改为核对实际原因链；产品与原验收标准未变。原卸载残留反例及四协议驻留/冷恢复仍通过，见[合同](prompt-sections-contract.md#完全卸载恢复的入口复核2026-10-21)。
- PTC 完整预设探针按 `env -i PATH=/usr/bin:/bin DSH_UNLIMIT_RUNTIME=<官方运行时> <bundled-node> --expose-internals scripts/probe-ptc-rewind.mjs` 复跑，仍为预期不支持。原会话/待办/JSONL 不变，无创建/归档/工具执行/模型请求/后端进程；更新[证据](evidence/ptc-rewind-acceptance.json)中的时间、当前 fixture 摘要和清理记录。SDK 的 nested 调用参数不作为维护权限，详见[合同](session-attachments-contract.md#原生-todo-语义)。
- 使用 bundled Node v24.21.0、显式 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES` 执行 `node --expose-internals --test tests/*.test.mjs`，1117 通过、0 失败、0 跳过；日志 `artifacts/recovery-gaps-full.log`。定向日志 `artifacts/recovery-boundaries.log`。语法、来源、分层检查通过；客户端构建和离线打包通过，78 文件，SHA-256 `bf67b61a641a4d60a9ce3705403395d6f0c70d896a81b6de5365801b85f10637`，与上批相同，因为交付产品文件未改。

117 项原验收前五列保持。此次只修改隔离测试、合成证据和功能清单/合同，没有 UI 变更或新增桌面验收声明；未安装、重载、请求真实模型或改动真实 DSH 配置、profile、会话。

## 宿主目录资源与首次环境提示（2026-10-22）

基于 `b1e8e30` 工作树，新增两条用户可用路径，117 项原验收前五列不变。

- 宿主技能：明确目录资源根的路径/大小清单、正文面板资源展开、手动任务引用、自动规划选择和执行前重读已接通。官方 SkillRegistry 在临时目录验证作用域同名选择；合成计划协调器验证仅所选任务取得资源、规划后更新正文/文件使用执行时内容、删除后阻断且不启动执行者。拒绝目录链接/特殊文件/危险路径、超限、非文本；不从文件名推测 URL 或不透明提供者。该新增链路没有完整官方 AgentLoop 或真实模型验收。
- 首次环境提示：实际客户端入口通过已有 API 读取状态；无工具且 pending 时提供配置、持久跳过及本次收起。跳过只写临时环境配置，冲突不覆盖，客户端销毁取消请求。没有读取/改写聊天草稿，也不拦截发送。自动化用临时 LocalEnvironment 验证持久跳过、配置/工具存在、冲突、失败和销毁。
- 合成回环页面加载实际客户端源码，验证配置按钮打开正确环境页、跳过后重新加载不提示、合成聊天输入 `SYNTHETIC_DRAFT_KEEP` 保持；工作台正文面板展开 `references/checklist.md` 的路径与 47 字节大小，无 console error。视口约 1280×720；截图 `artifacts/environment-notice-preview.png` 与 `artifacts/host-skill-resources-preview.png`。仅临时数据和原创样本，两个预览进程正常退出、页面已关闭。
- bundled Node v24.21.0，显式 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES`：`node --expose-internals --test tests/*.test.mjs` 1132 通过、0 失败、0 跳过，日志 `artifacts/gap-paths-full.log`。定向日志 `artifacts/new-paths-targeted.log`、`artifacts/host-resources-plan.log`。全套后仅调整初始环境页面包屑和资源大小间隔，已通过页面重新加载读回。

重启接口只读复核范围见[维护合同](maintenance-contract.md#桌面重启入口复核2026-10-22)，仍无适配的 relaunch 接口。Hook、第三方记忆、完全卸载后旧提示词恢复、空闲 PTC 待办恢复、其他网络出口、URL/不透明来源及二进制资源、实际升级和桌面验收等缺口仍保留。没有安装、重载、读写真实 profile/配置/会话、请求真实模型或修改宿主程序；来源与许可声明不变。

本批语法、来源、分层、格式检查通过；客户端构建及本地打包完成，78 文件，SHA-256 `81a9e6c3b31c30ad58f33ea2deaed5b65d3b3e7ad86bcf69ef434a23f3d10864`。最终原验收基线、包内容、首次提示和任务表专项复验通过，日志 `artifacts/gap-paths-final.log`。两个预览回环端口均已确认无监听。

## 本地 URL 技能图片与其他出口复核（2026-10-22）

基于 `02a1265` 工作树，完成本地 file URL 和显式原生图片交付；其他出口没有新增强制范围控制。117 项原验收前五列保持，来源和许可说明不变。

- 目录与 `file://` 资源使用同一受限本地读取路径；拒绝远端 authority、query/hash、编码分隔符、链接根/链接文件和特殊文件。官方 SkillRegistry 同名作用域选择、规划候选、执行前正文/资源更新、所属任务隔离、AgentLoop 请求、JSONL 持久重开及汇总均经过临时合成链路验证。与上批仅 Registry/合成协调器相比，本轮补验了真实官方执行路径。
- 图片通过 `images` 单独选择 PNG/JPEG/WebP/GIF，跨技能使用当前宿主图片限额，预检不写附件。项目/宿主图片经过实际 LocalAttachmentStore、官方子代理/AgentLoop 和持久 reader，原生 readImageRequest 可返回相应规范化字节；未选图片、规划者和无图片任务没有附件。技能来源/原始摘要与原生附件引用分开记录，base64 不进入状态、提示词或日志。项目库原有快照读取保持，图片预算不限制之前的整库/整技能磁盘 I/O。
- 真实附件模块验证损坏批次、当前数量限额、纯文本模型拒绝和保存中取消。取消后不启动执行者，处置并释放槽位；已发布的共享附件对象保留，因为官方存储没有删除回滚或保存取消合同。保存成功不等于任务启动或视觉模型可用。LLM 为合成传输，没有请求外部视觉模型。
- 其他出口只读复核搜索、MCP HTTP/stdio、Bash/Pwsh/PTY、macOS sandbox、Chromium sidebar 及全局代理；逐文件先对官方库存核对摘要。搜索未开放独立 transport；MCP SDK 虽有 fetch 选项，DSH 创建 transport 时未暴露，且服务端下游连接不可见；终端/浏览器缺少插件层逐地址请求合同。没有改写全局 fetch/dispatcher、拦截命令或停用整项工具来冒充出口控制。文件摘要、范围与原因见 [接口证据](evidence/network-egress-interface-review.json) 和 [合同](web-scope-contract.md#其他网络出口接口复核2026-10-22)；没有调查 Electron 主进程或全部第三方生态，不把结论扩张为永久无法实现。
- 实际页面模块在约 1265×720 回环预览验证：生成草稿显示文本与图片路径，填入 JSON 保留 images，提交计划后读回完成及清理状态；图片任务显示来源/原生附件保存状态，其他任务显示无图片。页面所有执行/附件服务为合成，官方存储证据来自上述独立测试。无 console error/warn，截图 `artifacts/skill-images-preview.png`。页面已关闭、预览进程正常退出，端口确认无监听。
- bundled Node v24.21.0、显式 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES`：`node --expose-internals --test tests/*.test.mjs`，1149 通过、0 失败、0 跳过；日志 `artifacts/resource-egress-full.log`。定向日志 `artifacts/skill-images-plan.log`。语法、来源、分层检查通过，客户端构建与本地包完成，78 文件，SHA-256 `20cec8050267557e6206c69f114a991630cd0483bf100b32808d950c878bc77c`。

尚缺：其他网络出口；远端 URL/opaque、其他二进制技能附件、真实视觉模型及桌面验收。Hook/第三方记忆、完全卸载提示词修复、空闲 PTC 待办恢复、重启/实际升级等原差距继续保留。本轮未安装或重载插件，未读写真实配置、profile、会话，未修改宿主程序或连接真实模型。
