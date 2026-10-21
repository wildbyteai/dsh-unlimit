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

| 证据编号    | 文件                                                    | 已覆盖的具体断言                                                                                                                                                        | 边界                                                   |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| V-FILES     | [files.test.mjs](../tests/files.test.mjs)               | 真实材料目录的文本/二进制读写、批量导入、摘要与关联元信息、覆盖/删除备份持久恢复；跨区/路径/链接/大小写别名拒绝；批量失败回滚与恢复不完整的明确结果；位图容器和尺寸限制 | 图片检查是结构检查，实际解码另见预览；不是远程文件操作 |
| V-SERVERS   | [servers.test.mjs](../tests/servers.test.mjs)           | IP/IPv6/IDNA/用户名主机规范化及去重；密码、密钥、URL、端口、网段、通配符拒绝且错误不回显输入                                                                            | 不提供 DNS/地区判定或网络出口授权                      |
| V-TEMPLATES | [templates.test.mjs](../tests/templates.test.mjs)       | 按正文/相对路径搜索、完整 UTF-8 读取与 SHA-256、未验证标记；目录替换/链接/路径逃逸/二进制/文件和结果上限                                                                | 不执行模板，不自动验证其内容                           |
| V-DRAFTS    | [ui-drafts.test.mjs](../tests/ui-drafts.test.mjs)       | 按工作区/页面/对象隔离，字段差异恢复，保存/放弃/删除精确清理；刷新丢失提示                                                                                              | 仅内存，不是官方 composer 桥或崩溃恢复                 |
| V-CATALOG   | [catalog.test.mjs](../tests/catalog.test.mjs)           | 来源分离、完整正文、显式依赖声明、未知/缺失/就绪区别、真实会话要求、目录失败保留；未声明依赖不猜测                                                                      | 不能把已登记 schema 当连接/执行成功，另见官方目录用例  |
| V-RETRY     | [retry-policy.test.mjs](../tests/retry-policy.test.mjs) | 只有显式开关接管，冻结返回兼容、策略收窄、缺官方执行器拒绝、精确撤销和原所有者保留                                                                                      | 合成适配合同，实际官方循环另见下表                     |
| V-CONTINUE  | [continuation.test.mjs](../tests/continuation.test.mjs) | 根会话 max-tokens 条件、动态正文/用语、默认关闭/有界计数、原生取消、新人工输入竞争、只停止自己所属的自动运行、失败回滚                                                  | 子代理继续明确不支持，官方事件与取消另见下表           |
| V-WORKFLOW  | [workflow.test.mjs](../tests/workflow.test.mjs)         | 首轮前绑定/角色/槽位，独立项目/所有者，预设冲突保留，完成/停止/卸载；清理失败保留槽位并返回 partial，显式停止可再次清理                                                 | 合成收据；官方 spawn 与预设另见下表                    |

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
