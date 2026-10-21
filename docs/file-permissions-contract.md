# 官方文件工具与预览权限隔离验收

本验收对应 `CORE-FILES`，目标为 DeepSeek Harness `0.2.1-rc.2`、macOS arm64。它执行真实官方文件工具和文件后端，只能支持“官方模块隔离部分通过”；没有安装本插件、重载桌面、访问真实 profile 或真实会话。

## 被验证的执行链

`tests/file-permissions-host.test.mjs` 通过真实官方 `ToolRuntime.execute` 调用 `read / write / edit`，再进入官方 `SandboxedFileSystem` 和其继承的 `LocalFileSystem` 进行真实临时文件 I/O。沙箱模式来自官方 `SandboxPolicyService`，显式会话模式通过官方 `setSandboxMode` 写入内存合成 Session 的 `sandbox/mode` 事件。文件服务、权限解析器和观察策略均未替换为 mock。

本项目 `DesktopRuntime.apply / revert` 在同一组合中执行，核对 `fullAccess` 对默认会话的实际写入效果，以及显式受限会话、禁用和撤销后的真实拒绝。设置存储只是合成输入；真实文件成功与失败均由官方执行链返回并逐项读回磁盘结果。

预览覆盖真实官方 `WorkspaceFiles` Host 服务的 `read / readBytes / list`，作用域取自它注册的 `workspaceFileScope` lookup，lookup 实际读取官方内存 Session header。没有模拟文件读取结果。此处直接调用 Host 服务；不覆盖 Gateway 传输、远程授权、桌面侧边栏渲染或 Office 转换。

终端覆盖真实官方 `TerminalSessionService` 和六个 `terminal_*` 工具的注册，以及没有终端后端时 `terminal_open` 的实际失败。工具返回错误而非创建确认，注册表保持空；直接调用官方 registry 得到 `NO_BACKEND`。`TerminalError` 在工具结果中保留错误文本，不承诺 `error.info.code`；文件 `FsError` 则从工具结果的 `error.info.code` 核对。这不构成任何终端进程读写权限通过。

## 有效权限语义

官方文件沙箱只约束变更。三个模式都保留本地后端的读取权限；`read-only` 不是禁止读取工作区外文件。

| 模式                 | 普通文件读取               | 创建与编辑                           |
| -------------------- | -------------------------- | ------------------------------------ |
| `read-only`          | 本地后端允许读取的文件可读 | 全部拒绝                             |
| `workspace-write`    | 同上                       | 工作区与官方平台临时根可写，其余拒绝 |
| `danger-full-access` | 同上                       | 不由文件模式限制；观察版本策略仍生效 |

预览服务同样允许读取工作区外的普通文件，且不会修改文件；预览目录列表保留工作区包含检查。预览拒绝最终文件软链接，即使目标仍在工作区内；文件工具的普通读取可以按文件后端规则解析路径。不能把这两个不同接口的路径合同误写成完全相同的拒绝规则。

为避免把平台临时目录的固有放行当成工作区隔离，负向场景在项目忽略的 `artifacts/file-permissions-*` 临时根中创建同级 `workspace` 和 `outside` 两个目录，并断言 `outside` 不位于 `os.tmpdir()` 或 `/tmp` 下。另建平台临时根，单独核对其预期可写行为。所有内容均为原创合成标记或 4 字节合成二进制，验收结束清理全部临时根。

## 已执行场景

当前证据为官方 Node `v24.21.0` 下 **9 项通过、0 失败、0 跳过**（1 个父测试、8 个子场景）。文件工具调用均真实执行；终端失败只按下表限定范围计入。

| 场景 ID                    | 实际断言                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FILES-READ-ONLY`          | 两个临时目录的 `read` 均含头尾标记；创建、覆盖、编辑返回 `FS_SANDBOX_DENIED`，原内容保持且新文件不存在                                                                                    |
| `FILES-WORKSPACE-WRITE`    | 工作区内实际创建、随后编辑并读回；同级目录、`../`、指向外部目录的软链接写入拒绝；外部已读文件编辑拒绝；平台临时根创建成功                                                                 |
| `FILES-FULL-ACCESS`        | 插件启用后，默认会话在工作区外实际创建并编辑；显式 read-only/workspace-write 会话仍拒绝；当前会话经官方切回 read-only 后也拒绝                                                            |
| `FILES-DISABLE-REVERT`     | 禁用后默认会话恢复实际拒绝；撤销恢复原始官方 service 的 `resolve` 方法引用，工作区内也保持 read-only 拒绝                                                                                 |
| `FILES-OBSERVATION-ERRORS` | 未读编辑/覆盖为 `FS_NOT_OBSERVED`；外部合成改写后编辑为 `FS_STALE_VERSION`；重读后编辑成功；缺失文件与目录读取返回真实错误                                                                |
| `FILES-DENIAL-CANCEL`      | 官方 pre-execute 明确拒绝及已取消调用均不创建文件                                                                                                                                         |
| `FILES-PREVIEW`            | 从官方 Session header lookup 取得作用域，逐字核对内外文本、完整字节与 EOF；二进制文本读取、目录、缺失文件、最终软链接均拒绝；工作区列表成功、外部目录列表拒绝、未知 Session lookup 无结果 |
| `FILES-TERMINAL-REFUSAL`   | 六个工具实际存在；`terminal_open` 因无后端失败，registry 为 `NO_BACKEND`，`terminal_list` 成功且没有创建任何终端                                                                          |

## 归档可信门与隔离

安装的 `dsh-tool-fs` 入口已不符合发行库存，不执行该入口。夹具复用 [official-packages.mjs](../tests/helpers/official-packages.mjs)，从 `artifacts/official-packages/dsh-tool-fs-0.2.1-rc.2.tgz` 校验固定 npm SRI 与入口 SHA256，在临时根构造干净运行时；Cordis、Loader、HMR 按库存复制，其余被加载的官方依赖经同步解析钩子逐项检查库存摘要。不复制官方实现到源码或文档，不读取其他插件的备份或实现。

已核对归档 SHA256 为 `6b3f1d6136fb49b908eb85c563b7aa13f052c982bcc71f591a75003b9b78aaaa`，干净 tool-fs 入口为 `b11d3fa50b9042019a91cc38a6abe35d74ed651374278f95e60b42734e079df1`。逐个执行入口、发行清单、本测试与涉及适配源码的摘要见 [验收证据](evidence/file-permissions-acceptance.json)。已知安装的 tool-fs、tool-bash、tool-pwsh 仅作摘要检查并核对前后不变，后两者不会由本夹具执行或修复。

测试禁止 socket connect/listen、UDP bind/send、fetch 和全部 `child_process` 启动入口，直到官方生命周期清理完成。任何尝试都会抛错并使测试失败。profile 配置读写服务也是拒绝桩；没有真实配置服务、持久化 Session 服务或桌面安装入口。临时目录删除及安装入口未变的断言通过后才生成证据。

## 复验

常规运行缺任一环境门时明确跳过，不访问默认安装路径。两个门都设置后，路径缺失、归档完整性或模块摘要不符必须失败。

已额外执行环境门检查：缺少环境门时为 1 项明确跳过；显式提供不存在的归档根时以 exit 1 失败，未变成跳过或成功。

```sh
DSH_UNLIMIT_RUNTIME=/path/to/official/runtime \
DSH_UNLIMIT_OFFICIAL_PACKAGES=/path/to/ignored/official-packages \
node --expose-internals --test tests/file-permissions-host.test.mjs
```

刷新本项目固定证据文件需额外设置 `DSH_UNLIMIT_FILE_PERMISSIONS_EVIDENCE=1`。普通测试不改写文档证据；失败场景不会生成新成功摘要。

## 保留缺口

- 真实桌面安装与嵌入操作、侧边栏预览渲染、Gateway 认证授权和真实会话权限选择未验收。
- 早期组件场景没有运行 shell；后续标准模式的文件/Bash 写入对照见下节。持久 PTY 的三模式权限切换、任意额外目录授权及所有 shell 命令仍未验收。
- 本文件权限场景没有执行 `read_image`、文件搜索、`present`、文件 watch 或扩大权限后的重试；这些接口不能由本证据推定通过。后续 `present` 与权限扩大已有独立限定场景，分别见 [交付合同](deliverables-contract.md) 和 [扩大权限合同](escalation-contract.md)，不倒推本场景覆盖了它们。
- 文件后端的官方 trusted-code fence 不等于内核安全边界。当前安装 tool-fs 摘要不符仍是实际部署限制，临时干净副本不会修复安装或授予额外权限。

## 完整 standard 文件与 shell 权限对照（2026-10-21）

`scripts/probe-standard-shell.mjs` 挂载完整原始 standard 预设，经真实 Loader/Registry 和 AgentLoop 执行官方 `write` 与 `bash`，使用已核验的干净归档。文件后端、沙箱策略、shell executor、subprocess 和 macOS Seatbelt 都是真实官方实现；仅模型动作和输入文件是合成。没有修改产品代码，也没有拿直接调用后端代替工具执行。

在项目忽略目录下建立同级 workspace/outside；outside 不位于平台临时根。每个场景分别用 write 和 bash 向内外两个新文件写入同一标记，共 **20 次工具调用、10 个真实 shell 子进程、25 次合成模型请求**：

| 场景                             | 文件工具和 Bash 的实际磁盘结果                          |
| -------------------------------- | ------------------------------------------------------- |
| 显式只读、插件启用               | 内外均拒绝，新文件均不存在                              |
| 显式工作区可写                   | 内部创建且字节准确，外部拒绝                            |
| 插件全访问默认、新会话无显式覆盖 | 内外均实际创建，字节准确                                |
| 同一个全访问会话显式切回只读     | 下一轮内外均拒绝，新目标不存在；插件全访问设置仍为 true |
| 撤销插件后新建无显式覆盖会话     | 恢复官方只读默认，内外均拒绝                            |

初始五个场景 **6 项通过**（父测试及 5 场景）。相同会话切换前后的历史结果保留；每次结果进入下一步模型输入，schema 不变，自写正文随启用/撤销一致。官方 JSONL reader 核对全部事件，物理 JSONL 另核对调用、结果和权限切换事件；四个会话、五轮数据均可追溯。

**拒绝语义不同，效果一致：**文件工具返回 `isError:true / FS_SANDBOX_DENIED`；已完成的 Bash 进程即使退出码非零，官方工具仍可返回 `isError:false`。本探针同时断言真实进程退出码为 1、原生沙箱拒绝说明存在、目标文件不存在；正向场景要求退出码 0 和逐字磁盘读回。不能把 Bash 的工具包装成功当作命令成功。

只读和工作区模式实际通过官方生成的 `sandbox-exec` profile 执行；全访问路径按官方合同直接执行 Bash。命令只包含固定 printf 重定向，无外部程序、网络或用户输入。父环境从 `env -i` 建立，HOME/TMPDIR 均为本次临时目录；实际启动的 argv、环境及调用 Agent 身份检查后才允许执行。保持官方 profile，没有关闭或伪造内核沙箱。

初始 10 个子进程 close 均确认，subprocess/controlChannels 集合为 0，两处临时根删除，禁止访问记录与清理错误为空。源码摘要、逐场景结果和原生进程记录见 [standard-shell-acceptance.json](evidence/standard-shell-acceptance.json)。后续同一探针增加六个单次审批重试场景，累计 22 个子进程均清理，见 [扩大权限合同](escalation-contract.md#完整-standard-bash-单次审批与实际重试2026-10-21)。这不是 PTY、真实审批 UI 或网络限制验收；只证明固定文件变更及指定重试场景，不证明全部内核隔离性质。

```sh
/usr/bin/env -i PATH=/usr/bin:/bin \
  DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
  --expose-internals scripts/probe-standard-shell.mjs
```

探针独立于 `npm test`，需要本机已核验的官方归档。它不安装或重载插件，不读写真实 profile、会话或配置。
