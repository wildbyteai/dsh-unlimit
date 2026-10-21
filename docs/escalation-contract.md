# 官方单次权限扩大验收

本合同对应 `CORE-ESCALATION`，目标为 DSH desktop `0.2.1-rc.2`、macOS arm64。已验证真实官方文件执行链，以及完整 standard 预设下 Bash/Seatbelt 的单次模式升权；**不能把它解释为“仅授权任意新增目录”的完整闭环**。桌面审批 UI 与持久 PTY 权限切换仍未验收。

## 官方公开合同

| 接口                                              | 实际签名与含义                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approveEscalation(request, approval)`            | `request = {requestedMode, effectiveMode, justification, subject}`；`approval = {approver?, agent?, toolName?, callId?, signal?}`；异步返回获批的 mode 字符串，不返回目录 Grant 或令牌 |
| `SandboxPolicyService.resolve({session?, mode?})` | 返回 `{mode, workspaceRoot, sessionId?}`；workspaceRoot 取原 Session header.cwd 或部署默认根                                                                                           |
| `ApprovalService.request(req)`                    | `req = {agent, toolName, callId?, reason?, displayReason?, signal?}`；必须在打开的 turn 内，写入 `approval/asked` 与 `approval/decided`，返回四种闭合 outcome                          |
| `approval/request`                                | 按 Agent 作用域路由的 answerer waterfall；本验收只替换最终 answerer，官方审批、审计、取消逻辑全部执行                                                                                  |
| `write / edit`                                    | 原工具参数外增加 `sandbox_permissions: "workspace-write" \| "danger-full-access"` 与 `justification`；两项必须成对且理由非空                                                           |

升权阶梯为 read-only → workspace-write / danger-full-access，workspace-write → danger-full-access。重复当前模式不需要审批；更窄或非法目标拒绝。缺审批服务、缺 Agent、拒绝、取消或不可用都不会转为同意。`allowed-once` 只被当前调用消费，不写入 Session sandbox mode，也没有记忆授权或目录 Grant 存储。

文件工具先取得审批结果，再把包含获批 mode 的完整 per-call policy 传入真实 `SandboxedFileSystem.writeText / editText`；文件后端按该 policy 执行真实 I/O。官方 `workspace-write` 只覆盖原 Session 工作区，以及 `/tmp` 和 `os.tmpdir()` 等平台临时根。审批不会替换 workspaceRoot，系统临时根的额外可写性不能隐去。

本次实际组合没有注册 `request_permissions` 工具；已检查的官方升权 surface 是变更工具上的上述参数。`write` 的 schema 未声明新增目录字段，并未设置 `additionalProperties:false`。探针实际传入 `additional_write_roots` 后，字段被执行器忽略：原工作区内的调用可成功，指定的外目录仍被拒绝。额外字段被接受不等于目录授权生效。

## 已执行回归

[escalation-host.test.mjs](../tests/escalation-host.test.mjs) 直接复用 [file-permissions-fixture.mjs](../tests/helpers/file-permissions-fixture.mjs)。它使用真实官方 ToolRuntime、干净 tool-fs、SandboxPolicyService、ApprovalService、内存 Session、观察策略和实际本地文件后端。只注入原创合成数据与合成 answerer，没有 mock 权限判断或文件写入结果。

官方 Node `v24.21.0` 下 **10 项通过、0 失败、0 跳过**（1 个父测试和 9 个子场景）；摘要见 [escalation-acceptance.json](evidence/escalation-acceptance.json)。

| 场景 ID                                         | 实际结果                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ESC-SCHEMA`                                    | 核对真实 write schema 的四个字段与两种升权目标，明确当前组合没有 request_permissions                                                       |
| `ESC-READONLY-TO-WORKSPACE`                     | 先实际写入拒绝，再经官方审批 allowed-once；原工作区目标实际创建并逐字读回；站立策略仍为 read-only、原 workspaceRoot 不变                   |
| `ESC-ROOT-NOT-EXTENDED-AND-TEMP-ALLOWED`        | 外目录及第三目录即使获得 workspace-write 单次同意，仍为 `FS_SANDBOX_DENIED` 且无文件；平台临时根按原生规则写入成功；额外目录字段不改变结果 |
| `ESC-ONE-SHOT-AND-AGENT-ISOLATION`              | 下一普通调用仍拒绝，新升权需新审批；另一 Agent 无法消费当前 Agent 的 answerer，得到 unavailable 且无文件                                   |
| `ESC-REJECT-CANCEL-UNAVAILABLE`                 | rejected、cancelled、unavailable 均保留；抛错与非法 answerer outcome 归一为 unavailable，全部无文件                                        |
| `ESC-PENDING-CANCEL-IGNORES-LATE-ALLOW`         | 等待中的审批被调用者取消，审计记录 cancelled，迟到 allowed-once 不创建文件                                                                 |
| `ESC-PLUGIN-AUTOAPPROVE-OFF-AND-EXPLICIT-NEVER` | 本插件启用但 autoApprove 关闭时保留合成拒绝；打开 autoApprove 后，显式 never 仍在 answerer 前拒绝                                          |
| `ESC-VALIDATION-AND-EQUAL-MODE`                 | 缺少配对参数、空理由不发起审批或落盘；已是 workspace-write 时重复相同模式直接执行，较窄目标拒绝                                            |
| `ESC-NO-APPROVER-AND-CLOSED-TURN`               | 缺审批服务明确失败；turn 已关闭时 request 拒绝且不写审计尾事件                                                                             |

主 Agent 的 15 对审计事件逐项匹配请求 ID，审批请求核对确切 Agent/Session 身份、工具名与 callId；另一 Agent 的不可用审计也单独核对。整个升权过程没有追加 `sandbox/mode` 事件。所有正向成功均读回真实文件，所有负向结果均核对目标不存在。

## 生命周期与本插件接点

`allowed-once` 是当前异步调用的返回值，没有跨调用或跨 Session 的授权对象可撤销。取消可以撤回在途审批，本次已验证迟到答复被丢弃；已完成的文件变更不会因取消或插件撤销而自动回滚。`setSandboxMode` / permission preset 是改变后续会话模式的另一条官方路径，不属于单次目录授权。

本插件当前接点是 `DesktopRuntime` 对 `approval.decide` 和 `sandboxPolicy.resolve` 的可撤销包装，以及 `PermissionDefaults` 的未来会话默认选项。本次没有增加 grant store、request_permissions 或工具执行替换层；测试启用插件时关闭 fullAccess，确保成功来自真实单次审批而非默认放开。autoApprove 关闭与显式 policy 拒绝单独执行，不能把审批策略设置成功当成实际权限通过。

## 可信门与复验

安装 tool-fs 的入口摘要不符，不执行它。夹具从固定 npm SRI 与库存入口 SHA256 校验过的公开归档构造临时干净运行时，其余加载的官方依赖逐项核对库存。证据包含归档摘要、20 个直接加载入口、已知修改入口的只读检查与相关源码摘要。

所有业务路径都是 `artifacts/file-permissions-*` 下原创临时工作区、同级外目录和第三目录，另有专门的平台临时根。网络、UDP、fetch 和 child_process 启动入口一律禁止，直到官方生命周期清理完成。没有真实 profile、持久化 Session、桌面安装或真实进程执行；临时根清理和安装入口未变化断言通过后才生成证据。

```sh
DSH_UNLIMIT_RUNTIME=/path/to/official/runtime \
DSH_UNLIMIT_OFFICIAL_PACKAGES=/path/to/ignored/official-packages \
node --expose-internals --test tests/escalation-host.test.mjs
```

两个环境门任一缺失时明确跳过；显式设置后缺文件或摘要不符必须失败。增加 `DSH_UNLIMIT_ESCALATION_EVIDENCE=1` 才更新本项目固定证据文件，普通回归不改写证据。

## 保留差距

- 原目标要求“仅授权任意选定临时目录，第三目录继续受限”，官方这些 API 没有额外授权目录列表或受范围约束的 Grant；不能修改前述要求来宣称通过。
- `danger-full-access` 是本次调用不受文件沙箱约束的模式，不是指定目录授权；本回归没有执行它。
- Bash/Seatbelt 的限定单次升权已补验，见下节；PowerShell、持久 PTY 权限切换、真实审批 UI、跨进程会话恢复与桌面操作未验收。
- 当前安装 tool-fs 不可信的部署限制仍保留；临时干净副本没有修复安装，也没有提供规避权限控制的路径。

## 完整 standard Bash 单次审批与实际重试（2026-10-21）

[probe-standard-shell.mjs](../scripts/probe-standard-shell.mjs) 在原有三模式文件/Bash 对照后，增加六个完整 AgentLoop 场景。每个场景先执行固定 printf 命令，由真实 Seatbelt 在只读模式下拒绝；下一次合成模型响应提交**同一命令**及 `workspace-write`、非空理由。审批仍经过官方 ApprovalService，只在需要人工答复时提供合成 answerer。没有自动伪造同意事件或直接调用 shell 后端。

| 场景                         | 实际结果                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| 同意一次，原工作区           | 首次进程退出 1 且无文件；审批 allowed-once 后重试退出 0，逐字读回；紧接着普通调用退出 1，新文件不存在 |
| 拒绝一次                     | 首次进程退出 1；重试返回 user rejected，不启动第二个进程，无文件                                      |
| 同意一次，工作区外与第三目录 | 两个独立场景均获得 allowed-once，但重试仍由 workspace-write 内核沙箱拒绝，退出 1 且无文件             |
| 插件自动审批，无显式会话策略 | 不调用 answerer，官方审计记录 allowed-once；仅重试命令写入成功，下一普通调用仍只读                    |
| 插件自动审批，显式 never     | 不调用 answerer，官方审计记录 rejected；不启动重试进程，无文件                                        |

新增部分为 6 个合成会话、14 次官方 Bash 工具调用、12 个真实子进程、20 次合成模型请求。六对 `approval/asked` / `approval/decided` 的 ID 与结果逐项核对；answerer 核对 Agent、工具名与 callId。所有会话的 `sandbox/mode` 事件没有新增，最终 mode 仍为 read-only、workspaceRoot 保持原值。每个结果进入下一次模型输入，官方 JSONL reader 与内存完整事件一致。

原有五场景也一起复验：整份探针共 12 项通过、0 失败、0 跳过，22 个实际子进程全部关闭，subprocess/controlChannels 为空，临时根删除、安装入口不变。新摘要与实际 argv/profile 记录在 [standard-shell-acceptance.json](evidence/standard-shell-acceptance.json)，复验命令见 [文件与 shell 对照](file-permissions-contract.md#完整-standard-文件与-shell-权限对照2026-10-21)。

此批没有修改产品权限实现，只补足当前实现的实际进程证据。合成模型预先选择重试，不证明真实模型会正确判断何时重试；合成 answerer 不是桌面确认框。仍不覆盖任意额外目录授权、PowerShell、持久 PTY 或真实桌面。
