# 本地环境配置

`new LocalEnvironment(dataRoot)`，从 `src/core/environment.js` 导入。`dataRoot` 必须是现有的规范化绝对目录，路径所有组件不能是符号链接。macOS 临时目录应传入 `realpath` 后的 `/private/...` 路径。模块只管理该根下 `.environment/config.json`，不使用 settings、records 或 store 通用接口存放实际变量值。

## 公开接口

`dispatch(action, payload)` 为同步接口。未知 action/字段明确报错，没有通用成功响应。

| Action                         | Payload                                    | 结果             |
| ------------------------------ | ------------------------------------------ | ---------------- |
| `environment.capabilities`     | `{}`                                       | 能力与保护边界   |
| `environment.status`           | `{}`                                       | 当前脱敏状态     |
| `environment.variables.save`   | `{revision,name,secret?,value?}`           | 保存后的脱敏状态 |
| `environment.variables.delete` | `{revision,name}`                          | 删除后的脱敏状态 |
| `environment.hosts.save`       | `{revision,items:string[]}`                | 保存后的脱敏状态 |
| `environment.keys.save`        | `{revision,id?,label,path}`                | 保存后的脱敏状态 |
| `environment.keys.delete`      | `{revision,id}`                            | 删除后的脱敏状态 |
| `environment.onboarding`       | `{revision,decision:'configured'\|'skip'}` | 保存后的脱敏状态 |

所有写操作要求最新 `revision`。`CONFLICT` 后应重新获取脱敏状态，请求不能用旧表单覆盖较新的配置。变量名使用 `[A-Za-z_][A-Za-z0-9_]{0,127}`，变量最多 128 个，单值最多 32 KiB UTF-8，不接受 NUL。主机最多 128 个，私钥路径最多 32 个，配置文件最多 1 MiB。

新变量必须明确给出 `secret` 和 `value`。已有变量省略 `value` 表示保留当前值，明确传入 `""` 表示清空值。不要把页面的掩码当成新值提交。已有变量不能通过保存改变敏感性；需要删除后明确重建。

状态结构：

```js
{
  revision: 1,
  variables: [
    { name: 'TOKEN', secret: true, configured: true, masked: '••••••••', updatedAt: '...' },
    { name: 'MODE', secret: false, configured: true, value: 'synthetic', updatedAt: '...' }
  ],
  hosts: ['operator@example.invalid'],
  privateKeys: [{
    id: 'uuid', label: '合成路径示例', path: '/absolute/path', updatedAt: '...',
    metadata: { available: true, validation: 'metadata-only', bytes: 32, modifiedAt: '...', mode: '600' }
  }],
  onboarding: { state: 'configured', configured: true, blocksChat: false, grantsAuthorization: false }
}
```

`hosts` 是基础设施/连接主机清单，经现有 `normalizeServers` 校验；它不是 `settings.ownServers` 的目标例外名单，不授予任务或目标权限。私钥只校验明确的现有普通文件路径和元信息，不打开文件、不读取字节、不验证密钥格式、不连接主机。原路径之后失效时，状态保留该条目并返回 `metadata.available:false`。删除路径条目不会删除密钥文件。

首次状态为 `pending`。保存任一变量/主机/私钥条目会标记 `configured`；这里表示已有保存的配置，不代表连通性、凭据有效性或工具就绪。清空最后一项时 `configured` 回到 `pending`。`skip` 独立持久化为 `skipped`，不清空已有配置；两种状态都不阻塞普通聊天，也不替代演练入场确认或宿主权限。

## 仅内部解析

`resolve(name)` 返回一个已配置变量的实际字符串。`exportEnvironment(names)` 只返回调用方明确列出的变量，不读取或合并 `process.env`。缺少任一指定变量会整体报错。二者不能注册为 Controller、HTTP、模型工具或 UI action，返回值不能进入日志、报告、提示词或错误响应。后续受控进程适配器须自行限定变量名单与获授权的使用场景。

## 持久化与边界

目录使用 0700、配置和临时写文件使用 0600；POSIX 下拒绝非当前用户所有或有组/其他用户权限的存储。拒绝存储路径中的符号链接和配置文件硬链接。写入使用短暂排他锁、修订校验、同目录暂存、文件同步及原子 rename。失败诊断不附原始文件系统异常或变量值，秘密没有长度、哈希或尾字符读回。

这不是加密存储或系统钥匙串；`capabilities.encryptedAtRest` 固定为 `false`。持有当前操作系统账户权限的程序仍可能读取文件。Windows ACL 与实际桌面 UI/受控进程消费未验，能力结果明确返回 `platform-acl-unverified`。本模块不运行命令或网络任务。

进程在写入中崩溃可能留下受限暂存文件或 `write.lock`；遇到 `BUSY` 不自动抢占锁。需确认没有活动写入者后再由本地管理操作处理遗留文件。本模块不提供自动修复或秘密导出接口。

## 已验证

使用 bundled Node24 执行 `node --test tests/environment.test.mjs`，全部为新建临时目录与虚构值，覆盖持久化脱敏、遗漏秘密保留、单项删除、内部明确名单解析、修订冲突、排他锁、原子写失败、异常脱敏、主机规范化、密钥元信息不读字节、路径/链接/权限拒绝、首次配置/跳过及数据根隔离。没有访问真实 profile、密钥或网络。

## 通用进程路径的接口核对（2026-10-21）

已只读核对与发行库存一致的 `dsh-subprocess`、`dsh-subprocess-local`、`dsh-sandbox`、`dsh-sandbox-local`、`dsh-sandbox-policy`、`dsh-user-approval` 和 jobs 接口。官方 `sandbox.confine(argv, policy, signal)` 可配合 `subprocess.spawn` 启动精确参数进程，但 subprocess 自身不做会话权限或批准。`ApprovalService.request` 要求真实打开中的 turn；当前 Controller/UI 没有该执行上下文，不能用拼造 agent/turn 或直接 raw spawn 代替审批。安装 tool-bash 入口摘要不符，核对时使用已有固定公开归档，未执行该安装入口或读取其备份。

本次调查确认适配须在真实模型工具 `execution.agent` 中取得会话权限，走官方审批、沙箱及进程句柄；输出按 offset 读回并披露 lossy，停止只针对本插件保存的句柄并等待 done 与 waitForExit。macOS 官方进程树归属不保证收回逃离的后代。调查本身没有新增或验证通用 start/output/stop；下节记录后续实现，验证证据单独记录。

## 本地工具进程接口

`src/host/processes.js` 的 `DesktopProcesses` 接入官方会话策略、单次提权审批、沙箱与 subprocess。模型入口是 `unlimit_process`，action 为 `start/list/output/stop`；Controller 内部使用 `processes.*`。可信执行上下文单独传参，HTTP JSON 中的 agent、callId 或 execution 不能成为该上下文。启动必须来自宿主注册的当前 agent，已绑定项目且当前安装完成演练确认。

| 操作   | 参数                                                                     | 返回                   |
| ------ | ------------------------------------------------------------------------ | ---------------------- |
| start  | `tool,args:string[],cwd?,timeoutMs?,sandbox_permissions?,justification?` | `{item}`               |
| list   | UI 必填 `workspaceId`；模型取会话绑定                                    | `{items}`              |
| output | `id,stdoutOffset?,stderrOffset?`，UI 另填 `workspaceId`                  | `{item,stdout,stderr}` |
| stop   | `id`，UI 另填 `workspaceId`                                              | `{item,stopped}`       |

`tool` 是已配置并可用的工具标识，只启动该路径和精确参数数组，不拼 shell、不搜索系统 PATH。保存路径不会启动工具；版本探测仍使用原有独立入口。参数最多 256 项、单项 32 KiB、合计 256 KiB，不接受 NUL。cwd 默认会话目录，可以指定现有绝对目录，但不会据此扩大宿主策略的写入根。审批或沙箱准备后重新核对 agent、项目绑定、路径和文件元信息，变化则拒绝启动。

默认使用会话当前权限。扩大权限须成对提供 `sandbox_permissions`（`workspace-write` 或 `danger-full-access`）和非空 `justification`，调用官方审批；拒绝、取消和缺通道均不启动。受限模式必须通过官方 confine；当前会话已为 full-access 或明确获批的单次 full-access 按官方模式直接交给 subprocess。沙箱失败不自动降级。这里不另行实现网络目标过滤；通用外部工具的网络出口范围仍属于未补齐项。

开始接纳后在后台运行，原工具调用结束不会自动终止；指定 `timeoutMs` 时为 50–86400000 毫秒，否则直到退出、明确停止、演练确认撤销或插件释放。未完成的审批/沙箱准备可被取消，迟到结果不会启动进程。只保存本插件创建的句柄，不接管系统进程或调用宿主全局清理。模型只能管理自己会话的记录；UI 可管理所选项目内本插件记录。记录仅保存在插件实例内存中，重载不提供历史输出恢复。

每路 stdout/stderr 保留最多 64 KiB，返回 `{text,nextOffset,lossy}`；不创建输出溢出文件、不返回 PID/句柄或溢出路径。UI 手动读取保留片段并明确显示截断。元信息包含项目、会话、工具、参数、目录、模式、状态、时间与退出信息。状态包括 `preparing/running/settling/stopping`、`exited/failed/denied/stopped/timed-out`；只有命令退出和官方管理范围结束都确认后才给出终态。不能确认清理时返回 `cleanup-pending` 和错误，允许再次停止。

不把 LocalEnvironment 的秘密、主机或私钥登记注入进程；使用官方 subprocess 默认环境清理。页面位于“工具与环境”，提供列表、输出、停止与手动刷新；启动仍在真实会话中完成，因为独立页面没有宿主审批轮次。缺少进程服务只禁用启动，不使其他配置页面失效。官方运行时隔离测试与实际桌面验收的区别见 [验证记录](verification.md)。

## 首次客户端环境提示（2026-10-22）

客户端加载后先读取 `environment.status`。仅 `pending` 时继续读取 `toolkit.status`，没有检测到可用工具才显示非阻塞提示；已配置或已跳过不再提示。这里只检查既有工具目录，不执行版本探测、不安装工具。读取失败单独显示，不能当成没有工具。

“配置环境”打开工作台环境页，不写配置；已打开的同源工作台通过固定消息导航，保持原页面状态。“本次收起”只隐藏当前提示。“暂不配置，继续使用”通过已有 `environment.onboarding` 携带 revision 保存 skip，确认返回 skipped 后收起；重复点击不重复写入，修订冲突要求重新读取，不覆盖新配置。客户端释放时取消请求并清除提示。

该提示没有读取、改写、拦截或发送聊天输入，也不是发送前阻塞门。合成客户端页面验证配置页导航、跳过后重开不提示、原输入保留；临时环境状态测试覆盖冲突、失败与销毁。真实 DSH 嵌入与首次发送尚未验收。
