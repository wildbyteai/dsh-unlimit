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
- 没有运行 PTY、shell 命令或操作系统进程沙箱；文件与终端跨执行族的内核权限一致性仍未验收。
- 没有执行 `read_image`、文件搜索、`present`、文件 watch 或扩大权限后的重试；这些接口不能由本证据推定通过。
- 文件后端的官方 trusted-code fence 不等于内核安全边界。当前安装 tool-fs 摘要不符仍是实际部署限制，临时干净副本不会修复安装或授予额外权限。
