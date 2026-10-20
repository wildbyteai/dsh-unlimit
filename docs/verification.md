# 验证记录与复验边界

当前是独立实现的本地源码验证记录，目标宿主为 macOS arm64 的 `0.2.1-rc.2`，不是完整桌面 1:1 验收报告。行为目标、逐项差距见 [parity.md](parity.md)；源码合同见 [contract.md](contract.md)。本记录对应交付基线提交所含源码，提交标识以仓库记录为准；后续代码变化应重新运行受影响检查，不能沿用旧计数。

## 证据层级

| 层级             | 本文含义                                                                             | 不能据此声称                           |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| 源码实现         | 当前源码有入口、校验和实际处理路径                                                   | 已运行、已接入官方桌面                 |
| 合成验证         | 临时目录、原创数据及受控假服务下验证功能/失败路径                                    | 真实宿主接口或真实设备通过             |
| 官方模块隔离验证 | 从已安装运行时只读加载官方模块，独立 Cordis 上下文、临时数据、假传输，无用户 profile | 已安装本插件、实际桌面 UI/模型联网通过 |
| 预览交互         | 回环 HTTP 上的独立工作台，1280×820 浏览器实看和操作读回                              | 官方桌面嵌入、真实会话/草稿桥通过      |
| 桌面实机验收     | 实际安装后，以授权范围内的桌面操作记录结果                                           | 本轮尚无此级证据                       |

本轮未实际安装插件、未修改真实 profile、未发真实模型联网请求，未执行扫描、登录或远程连接。Windows 未实机验证。所有未验的层级保持未验；`available` 仅表示当前接口条件可用，`active` 才表示本插件拥有的运行时适配已注册，两者均不能代替用户操作验收。

## 合成验证入口

| 证据编号     | 文件                                                | 已覆盖的具体断言                                                                                                                                                                                                         | 仍未覆盖                                                                                    |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| V-STORE      | [store.test.mjs](../tests/store.test.mjs)           | 设置修订冲突；规则 CRUD/UTF-8 限额；工作区与会话绑定；资产/服务归一合并、来源与首次发现；组合筛选；事务导入结果与失败回滚；发现/各类记录；角色隔离/重置；知识全文/过滤/证据验证/复用；按点、资产和服务去重计分及报告脱敏 | 真实采集、连接、任意文件树/二进制证据预览及桌面交互                                         |
| V-RUNTIME    | [runtime.test.mjs](../tests/runtime.test.mjs)       | 关闭时原样返回；完整提示词替换保留工具/上下文；逐步读取新值与模型规则优先；strict 策略；审批审计与取消；明确会话限制/用户审批优先；默认沙箱、子代理动态值；重复注册、回滚、精确撤销与版本拒绝                            | 各模式实机执行；文件/终端/浏览器权限端到端；全局 Hook、读取上限、重试次数                   |
| V-SKILLS     | [skills.test.mjs](../tests/skills.test.mjs)         | 自写技能 CRUD、覆盖备份/删除；文件夹与多技能 ZIP；引用/二进制附属文件；调用标志；CRC/长度/路径/链接/资源限制；中途失败恢复                                                                                               | 桌面斜杠调用和真实技能执行；官方技能全集目录                                                |
| V-SESSIONS   | [sessions.test.mjs](../tests/sessions.test.mjs)     | 合成事件切点、只读 prepare、文本草稿、fork/空会话策略、工作区继承、原记录归档、父子停止确认；缺接口/附件/子代理来源拒绝；部分失败披露新会话身份；并发拒绝                                                                | 实际 SessionController fork；官方编辑器草稿恢复；任务状态重写、附件恢复、子代理映射到父切点 |
| V-FLOW       | [flow.test.mjs](../tests/flow.test.mjs)             | 默认 3 槽/1–10 配额、显式角色分配、会话绑定与跨区拒绝、槽幂等/满额拒绝、降低配额限制、动态角色正文、撤销/重绑/关闭释放                                                                                                   | 自动启动执行者、队列调度、所有官方代理强制领取本地槽                                        |
| V-TOOLKIT    | [toolkit.test.mjs](../tests/toolkit.test.mjs)       | 显式绝对现有目录、realpath、仅根及一层子目录、拒绝链接/PATH 扩张；离线缺失建议；真实 Node 合成可执行文件仅收到 `--version`；参数注入拒绝；错误/超时/输出上限/取消/进程清理                                               | 真正工具扫描、联网安装、任意命令运行；Windows 原生探测及进程树实机验证                      |
| V-EXTENSIONS | [extensions.test.mjs](../tests/extensions.test.mjs) | 日志动态引用不可变而外层字段可替换时的关闭/禁用/精确还原；接口缺失、冲突和失败回滚；对无接口能力明确报告 unsupported                                                                                                     | 关闭所有遥测或已在途上传；Hook/记忆/全局字节读取及重试次数配置                              |

2026-10-20，主代理在 bundled Node `24.21` 下，提供 `DSH_UNLIMIT_RUNTIME` 完整运行 `node --test tests/*.test.mjs`，结果为 **84通过、0失败、0跳过**；这包含合成测试及下述官方模块隔离用例，不是84项桌面验收。其中 [controller.test.mjs](../tests/controller.test.mjs) 验证未知宿主版本的 prepare/rewind 均在调用会话服务前拒绝。JavaScript 语法检查34/34通过，格式检查通过。宿主相关测试未提供该变量时会明确跳过，不能将 skipped 计作官方模块通过。

## 官方模块隔离证据

| 证据编号   | 入口                                                                                                                   | 实际接口及观察                                                                                                                                                                                                                                                                                   | 边界                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| V-HOST     | [verify-host.mjs](../scripts/verify-host.mjs)                                                                          | 官方 Cordis、SystemPrompt、ApprovalService、SandboxPolicyService、Session/投影和 SubagentRuntime；真实 `createVolatile` 冻结引用，外层配置替换后深度/数量动态生效、原所有者更新保留，禁用/撤销恢复；提示词和审批审计保留                                                                         | 只核验实际导入入口的清单摘要，非整棵依赖/整个已安装应用完整性结论；不启动桌面或实际子进程代理                                     |
| V-PLUGIN   | [plugin.test.mjs](../tests/plugin.test.mjs)                                                                            | 真实 ToolRuntime/defineTool schema 与执行、SkillRegistry/provider、系统提示词/审批/沙箱及 SessionStore；mount→运行→dispose；模型工具写入同一存储后 HTTP/UI 数据接口读回；同会话及子代理绑定隔离；技能导入后可列/正文/引用可读、编辑删除目录失效；缺可选服务仍启动；释放路由/工具/provider/数据库 | webServer、connection 是受控 Service，认证与同源拒绝契约可测，未使用真实桌面认证；会话控制/工作区注册为假服务；未验实际浏览器嵌入 |
| V-LOG      | [extensions.test.mjs](../tests/extensions.test.mjs) 的官方模块用例                                                     | 真实官方日志插件持有的 config 引用通过临时替换动态读为 false，原引用保持不变，撤销精确恢复；不写 profile                                                                                                                                                                                         | 仅指定会话日志插件 `enabled`，不扩张成全应用隐私保证                                                                              |
| V-PROTOCOL | [verify-protocols.mjs](../scripts/verify-protocols.mjs)、[protocol-acceptance.json](evidence/protocol-acceptance.json) | 官方 AgentLoop→LlmRuntime→实际适配器/SDK 序列化→本地假 SSE fetch；四协议首轮、第二轮修改、官方创建的子会话首轮、503 后官方重试改正文；20 次传输捕获均与持久会话完整 messages 相等，重试新正文存在真实 `system/message` 事件；当前文本不进入人工 user 槽                                          | 合成密钥/文本和假 SSE；没有真实模型输出质量或服务端接纳证据；子会话为进程内官方所有权，未验外部代理进程                           |

以上专项运行已通过其限定断言。主代理再次执行 `verify-host.mjs` 为 **14/14通过**，只读doctor确认 `0.2.1-rc.2 / darwin / arm64`。协议 artifact 的 `passed` 为 true、`networkRequests` 为 0、`blockedNetworkAttempts` 为 0，21 个直接导入入口（含延迟协议 SDK）摘要匹配清单。此结果不能推论未加载的模块干净，也不代表整个本机安装未被修改；不匹配模块不能用作官方原始证据。

四协议原生槽观察：

| 路径                    | 捕获到的系统位置                                            | 注意事项                                                                                |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 默认 DeepSeek 适配器    | 首轮顶层 `system`，后续更新为 `messages` 中的 `role:system` | 直接挂载官方适配器类并注入合成身份/文件回调，避开默认包装器的匿名身份落盘和本机文件索引 |
| PiAI Chat Completions   | `messages[].role:system`                                    | 使用合成 provider 配置，官方 SDK 负责序列化                                             |
| PiAI Responses          | `input[].role:system`                                       | 同上，无自行重写的协议转换                                                              |
| PiAI Anthropic Messages | 顶层 `system`                                               | 同上                                                                                    |

`in-history` 模式保留旧系统提示词作为历史审计；当前最新系统事件包含新正文，不要求抹除历史正文。重试刷新发生在官方 `agent/request` 与系统投影路径，仍由官方写入事件；检查完整 `options.messages` 与 `session.deriveMessages()` 相等，避免只改传输副本而日志仍是旧值。尚未把“回退后重发”和“手动/自动继续”纳入这份协议通过结论。

## 预览交互记录

主代理在1280×820本地预览中完成下列真实浏览器操作，并以服务端数据或下载文件读回确认。全部输入均为合成数据；这是独立工作台预览证据。

| 对照行为                           | 已操作与读回结果                                                                                          | 仍需区分的边界                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| RULE-LIBRARY、SKILL-LIST           | 创建规则、创建技能，保存后读取一致                                                                        | 未覆盖全部编辑/删除边界、官方技能实际调用                        |
| SKILL-FOLDER                       | 通过目录选择器上传包含 `SKILL.md` 和 `references/local.txt` 的文件夹，导入结果为1个技能、2个文件、220字节 | 不是桌面嵌入或真实技能执行；ZIP选择器仍另验                      |
| DATA-LINK                          | 3节点、2边资产图实际渲染                                                                                  | 未验证图路径查询或跨工作区全部交互                               |
| FLOW-SLOTS                         | 上限从3改为2，保存后读取为2                                                                               | 不是实际代理调度/并发强制证据                                    |
| DATA-KNOWLEDGE、DATA-KNOWLEDGE-USE | 创建含正文证据、标为verified的记录并读回；修改正文后已验证标记撤回，服务端读回为未验证                    | 本地模板目录、复用筛选等全部UI组合尚未穷举                       |
| DATA-REPORT                        | 点击导出下载实际Markdown文件，读回报告标题、3资产统计和本地证据说明                                       | 该报告在后续导入前生成；不代表旧版全部字段报告或任意数据集都已验 |
| DATA-IMPORT、DATA-ASSET            | 3行资产JSON导入结果为新增1/合并1/拒绝1，列表共4条；合并资产读回 `tcp/443`、`https` 及稳定服务ID           | 只验证当前资产JSON格式，不是任意采集包格式                       |
| DATA-SEARCH                        | 导入后的外网与host组合筛选返回2条，符合合成样本                                                           | 不替代其他筛选组合的独立合成测试                                 |

最终合成预览截图见 [ui-preview.png](ui-preview.png)。截图证明该视口的最终渲染；上述保存、筛选和下载结论来自实际操作与读回，不能仅由截图推断。

官方桌面嵌入、真实安装与卸载、重启/升级、真实会话草稿桥、多模式工具权限、真实模型联网全部仍待单独授权和验收。未保存状态保留、全部表单失败路径、真实宿主技能调用与实际代理并发均未因此提升为通过。

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
"$NODE_BIN" --test tests/plugin.test.mjs tests/extensions.test.mjs
"$NODE_BIN" scripts/verify-host.mjs --runtime "$DSH_UNLIMIT_RUNTIME"
"$NODE_BIN" scripts/verify-protocols.mjs --runtime "$DSH_UNLIMIT_RUNTIME"
```

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
