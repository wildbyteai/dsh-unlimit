# 官方文件交付执行验收

对应 `CORE-DELIVERABLE`，目标是 DSH desktop `0.2.1-rc.2`。文件交付验收覆盖官方工具写文件、`present` 声明、临时 JSONL 读回、官方打开处理器和预览后端。下文另列受控回环预览进程的隔离场景；两组场景不合并声称完整桌面链路通过。桌面文件卡与原生应用打开仍未验收，不能将该行标为完整通过。

## 实际执行链

[回归测试](../tests/deliverables-host.test.mjs) 复用带发行清单校验的 [文件夹具](../tests/helpers/file-permissions-fixture.mjs)。通过真实 ToolRuntime 调用干净官方 `write`，在临时工作区生成原创文本，再调用官方 `present`。文件提供者、沙箱判定、工作目录、Session、turnBoundary 投影、SessionQuery 和 JSONL 后端均为真实官方模块。这里仅导入 AgentLoop 的官方投影定义，没有运行完整模型循环。

`present` 在打开的 turn 中检查现存普通文件，把绝对路径、说明、turn 和 callId 写为调用方 Session 的 `deliverables/presented` 事件。失败或取消不发布交付事件，多个文件中一个无效也不能产生部分声明。事件不复制文件内容；文件变化、删除或变成最终符号链接时，后续打开结果相应变化。

打开阶段调用官方 `dsh-client-ui-deliverables` 向 Connection 注册的处理器，由它校验 Session、事件序号、文件索引、文件类型和宿主路径映射，再请求桌面打开。测试捕获 Connection 注册和最终桌面调用，**没有挂载真实 HTTP 认证服务，也没有打开原生应用**。因此该证据证明处理器正确选取已声明路径，不能证明认证传输、桌面 UI 或应用实际启动。额外传入的 path 查询参数不能替代事件中的路径。

## 已通过场景

官方 Node `v24.21.0` 下 9 项通过（父测试 1 项、下表 8 个场景），摘要见 [执行证据](evidence/deliverables-acceptance.json)。

| 场景                                    | 验证结果                                                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `DEL-PROMPT-AND-WRITE`                  | 本插件 replace 模式保留真实官方交付说明与工具集合；实际 `write` 生成文件并读回，`present` 发布路径元数据。                   |
| `DEL-SESSION-OWNERSHIP`                 | 第二个独立 Session 不自动拥有第一个 Session 的声明；必须自己调用 `present`，各自 callId 与事件独立。不是完整子代理执行验收。 |
| `DEL-OPEN-AND-PREVIEW-BACKEND`          | GET 查询应用、POST 打开和 reveal 参数到达捕获边界；真实预览后端读取文本页与原始字节。                                        |
| `DEL-INVALID-DECLARATIONS`              | 空列表、超过 8 个文件、空路径、缺失文件、目录、最终符号链接、部分无效列表及取消都不新增声明。                                |
| `DEL-OPEN-REFUSALS`                     | 非法动作/坐标、错误 Session/事件/索引、桌面不可用与取消均不触发桌面调用。                                                    |
| `DEL-ABSOLUTE-PATH-AND-CURRENT-CONTENT` | Session 工作目录改变后声明仍指原绝对路径；预览读到修改后的内容；删除或改成最终符号链接后拒绝打开。                           |
| `DEL-CLOSED-TURN-AND-DURABLE-READBACK`  | 关闭 turn 后拒绝新声明；两份临时 JSONL 经 flush、关闭写句柄、重新读取后，交付事件逐字段相同。                                |
| `DEL-REVERT-AND-ROUTE-LIFETIME`         | 撤销本插件后保留官方交付段；官方交付模块卸载后捕获的旧处理器因生命周期取消而拒绝执行。                                       |

预览 `read` 的官方合同是按行分页，返回文本不带最后一行的换行终止符；测试另用 `readBytes` 逐字节核对文件内容，避免把显示格式与原文件混淆。文件声明是实时路径引用，不是文件备份，也不消除原生打开前的文件变化窗口。

## 隔离与复验

不执行安装中摘要不符的工具入口。文件工具来自固定 SRI 的公开归档，其他直接入口与加载依赖按夹具规则核对发行清单。测试只写自己的临时工作区和临时 JSONL；网络、UDP、fetch 和子进程入口禁止，清理后核对安装入口未变。没有读取真实 profile 或真实会话。

```sh
DSH_UNLIMIT_RUNTIME=/path/to/official/runtime \
DSH_UNLIMIT_OFFICIAL_PACKAGES=/path/to/ignored/official-packages \
node --expose-internals --test tests/deliverables-host.test.mjs
```

缺少任一环境门时明确跳过；明确配置但归档或摘要错误时失败。设置 `DSH_UNLIMIT_DELIVERABLES_EVIDENCE=1` 才更新固定证据文件。普通回归不改写证据；证据源码摘要只对应生成时的文件版本。

后续仍需真实桌面文件卡与预览、官方原生打开。文件交付场景没有启动回环服务；新增进程场景的独立边界见下节。本批未安装或重载插件，不修改真实 DSH 配置。

## 受控回环预览进程

显式运行的 [预览探针](../scripts/probe-preview-process.mjs) 复用 [进程夹具](../tests/helpers/process-host-fixture.mjs) 的 `preview:true` 分支，默认进程测试保持原路径。测试使用实际 `installTools` 注册的 `unlimit_process`，直接通过官方 ToolRuntime 调用 `start/output/stop`，进入本项目 `DesktopProcesses` 和官方 `LocalSubprocessRuntime`。没有手写生产 `tool/call`、结果或 AgentLoop 日志。

固定原创 Node 程序仅在临时 cwd 中运行，以 `127.0.0.1:0` 监听，提供一段固定合成 HTML；不暴露文件目录。夹具核对精确可执行文件、脚本文本、参数、cwd 和最小环境，通过真实 stdout 取得端口。父测试只允许两次对该端口的连接：第一次核对 HTTP 200 与完整正文；经插件工具停止、等待实际 exit/close 后，第二次必须得到 `ECONNREFUSED`。其余网络和进程入口继续拒绝，结束时确认连接、子进程和临时根均清理。

这是插件工具和实际本地进程的集成验证。Agent 是注册在官方 AgentRegistry 中的合成对象，Session 是官方内存对象；调用参数、项目绑定、入场确认与 full-access 模式均为合成设置。工具目录将测试标识映射到 bundled Node，不证明该标识对应的真实安全工具已运行。官方 AgentLoop、真实模型、人工审批、受限内核沙箱、桌面渲染及浏览器交互不在此场景内；没有安装、重载或修改真实 DSH 配置。

2026-10-21 显式探针 **1 项通过**，包含启动、实际响应、停止退出和停止后连接拒绝四组断言；182 个实际加载的官方文件通过发行清单摘要校验。原有进程回归 **7 项通过**。结果及五个源码摘要见 [预览进程证据](evidence/preview-process-acceptance.json)。探针只有全部断言和清理成功后才更新该证据，不进入普通 `npm test`。

```sh
env -i PATH=/usr/bin:/bin \
  DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
  --expose-internals scripts/probe-preview-process.mjs
```

常规进程测试没有选择运行时时明确跳过；在目标 macOS 平台上显式提供无效路径则失败，不把环境故障记录为跳过。上述显式探针也要求完整指定环境及固定 Node，任何不符直接失败。
