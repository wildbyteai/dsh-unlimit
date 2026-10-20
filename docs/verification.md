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

本轮未实际安装插件、未修改真实 profile、未发真实模型联网请求，未执行网络扫描、登录或远程连接。Windows 未实机验证。所有未验的层级保持未验；`available` 仅表示当前接口条件可用，`active` 才表示本插件拥有的运行时适配已注册，两者均不能代替用户操作验收。

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

2026-10-21，在 `849e16b` 后包含本文的工作树，主代理使用 bundled Node **24.21.0** 并提供 `DSH_UNLIMIT_RUNTIME` 与 `DSH_UNLIMIT_OFFICIAL_PACKAGES`，完整运行 `node --expose-internals --test tests/*.test.mjs`，退出码0，结果为 **391通过、0失败、0跳过**。JavaScript 语法检查 **103/103通过**。这些是合成、官方模块隔离和入口集成测试，不是391项桌面验收。构建与离线打包独立核对，包不安装到当前桌面。

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

截图见 [credentials-preview.png](credentials-preview.png) 和 [preflight-preview.png](preflight-preview.png)。浏览器console warning/error为空；结束后关闭临时页、重置视口、停止预览并确认端口无监听，临时库自动清理，自建元信息样本确认内容未变化后删除。所有上传、模型和会话行为仍仅有上述官方模块隔离证据。

新截图见 [admission-preview.png](admission-preview.png) 与 [environment-preview.png](environment-preview.png)。预览结束已关闭两个临时页、重置尺寸、停止服务并核对无端口监听；临时库和元信息样本已核对为本次合成数据后清理。

本轮浏览器控制台未观察到 warning/error。新目录截图见 [catalog-preview.png](catalog-preview.png)，材料恢复截图见 [materials-preview.png](materials-preview.png)。初始基线合成预览截图见 [ui-preview.png](ui-preview.png)。截图证明该视口的最终渲染；上述保存、筛选和下载结论来自实际操作与读回，不能仅由截图推断。

官方桌面嵌入、真实安装与卸载、重启/升级、真实会话草稿桥、多模式工具权限、真实模型联网全部仍待单独授权和验收。未保存内存状态已有限定证据；全部表单失败路径、真实桌面技能调用、外部代理并发仍未因此提升为通过。

本轮工作区规则预览在1280×720完成：父子候选与超限禁选、全文与摘要、取消不保存、确认保存及清空、旧修订冲突保留弹窗，具体修订读回见 [工作区规则合同](workspace-rules-contract.md)。最终控制页也实际检查了read正文预算禁用、0沿用宿主及不生效说明。两次临时页console warning/error均为空；页面和临时服务已关闭，合成文件及临时库已清理。

原生规则策略另做1280×720回环预览：三种策略名称可见，缺官方接口时明确提示只处理本插件所选规则；选择strict后保存revision 0→1，重新加载页面读回strict和revision 1。应用按钮仍禁用，console warning/error为空。截图 [native-rules-preview.png](native-rules-preview.png) 只含合成数据；尚未验证真实桌面的原生能力可用分支。临时标签及服务已关闭，端口无监听；本次合成库和空目录经核对后清理。

卸载新增1280×720合成回环预览：技能页显示最多200普通文件；打开卸载确认后取消，服务端移除调用0次且未收到卸载API。再次明确确认后，合成管理器调用1次，Controller清理全部返回完成，设置enabled与入场accepted均为false，原合成项目仍在。管理器关闭临时库和撤下路由后，页面显示只读回执、导航禁用，未再请求status或数据，后续请求计数0。console warning/error为空；截图 [uninstall-preview.png](uninstall-preview.png)。该预览的管理器是合成服务，与上述真实官方管理器测试分别记证。临时页、服务和数据库已清理；真实桌面未操作。

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

本轮运行控制预览为1280×720，使用项目临时SQLite：缺官方服务时新会话默认和重复提醒下拉框禁用、原因可见，应用按钮禁用。提示词保存revision 0→1，随后重新载入逐字读回（含字面花括号）；保存后刷新状态。截图 [control-defaults-preview.png](control-defaults-preview.png) 仅含合成数据。临时服务、浏览器标签和数据已清理；不等于真实桌面可用目录选择或启用验收。

## 本轮回退与报告补齐

**V-REWIND-PROTOCOL**：[rewind-protocols-host.test.mjs](../tests/rewind-protocols-host.test.mjs) 在真实官方 SessionController、AgentLoop、JSONL 与四个协议适配器下，从两轮实际合成执行回退第二轮，再显式编辑重发。20 次假 SSE fetch 均与请求时 Session 派生内容一致；较早输入与当前系统正文保留，撤回输入和内部标记不进入请求，HTTP400 为 error、用户取消为 aborted。28 个官方入口和 lazy SDK 摘要匹配；假凭据/传输，不代表提供方接纳或真实桌面操作。摘要见 [协议证据](evidence/rewind-protocol-acceptance.json) 与 [合同](rewind-protocol-contract.md)。

此测试发现官方 fork 的精确前缀可继承被撤回轮次的入队事件。实现现在先用公开 cancel/whenIdle 清理新分支队列再归档原会话；保留审计事件，不让撤回文本重新入场。失败返回 settle-new 部分结果与新分支编号。

**V-SESSION-HOST** 本轮增加4项真实 startActivation/catalog 用例：主会话第二轮创建后又有第三轮仍正确定位第二轮、首轮空分支、重复 catalog 写前拒绝、调度轮次不能借用前轮人工输入。该文件9项通过；子代理停在可取消的 pre-step，未调用模型。合成层另验嵌套来源、被插话后拒绝、祖先并发锁、队列清理失败与结果转义；后续激活的普遍来源映射仍缺，见 [子代理合同](child-rewind-contract.md)。

**V-REPORT**：[report.test.mjs](../tests/report.test.mjs) 的3项用例覆盖空库、完整现有字段与12类记录、17条证据记录、计分去重/阶段归属、关联与来源、凭据整条隐藏及嵌套脱敏、跨区拒绝。query_only 下报告前后所有 entries/metadata 逐行一致，重复构建结果一致。保留 stats 原字段并增加记录分类/评估/测试/关系/事件计数；未执行引用文件或网络。详见 [报告合同](report-contract.md)。

1280×720 回环预览核对报告完整正文，合成3资产、2关系、1发现、15分读回一致，页面无控制台错误；导出点击出现下载提示，本轮未取得对应下载文件，因此不把提示当作文件验收。截图见 [报告预览](report-preview.png)。同尺寸独立组件预览使用实际 web/rewind.js 与 styles.css，核对创建来源与切点、队列清空、草稿未发送、导航未确认及部分失败提示，见 [回退结果预览](rewind-result-preview.png)；这不是实际宿主回退窗口的交互验收。两个回环进程均已停止，合成临时库按本轮工作区ID核验后清理。
