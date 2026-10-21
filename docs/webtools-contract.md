# 网页工具可用性与网页数据边界

本项对应 `CORE-WEBTOOLS`，目标为 macOS arm64、官方 desktop **0.2.1-rc.2**。本插件沿用官方 `ToolRuntime → web_fetch → WebRuntime → HttpFetchProvider`，本轮没有发现需要修改功能源码的缺陷。网络范围执行仍以 [web-scope-contract.md](web-scope-contract.md) 为准；本验收没有安装插件、修改真实 profile 或访问真实会话。

## 已执行的最小路径

[webtools-host.test.mjs](../tests/webtools-host.test.mjs) 复用现有官方运行时辅助。每个实际导入的运行时文件先通过 `desktop-runtime.json` 的 SHA-256 校验；额外使用的官方 Session、SessionProjection、PlanModeController 和 AgentLoop 入口也先校验，后者仅提供 `turnBoundary` 投影定义，没有启动 AgentLoop。官方模块和用户 profile 不随项目分发。

三个成功抓取场景均使用合成 `.invalid` URL、假 DNS 答案和 Undici MockAgent 传输，真实执行官方工具和 HTTP provider 的调度、正文转换及结果格式化：

| 场景               | 实际观察                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| native 主代理文本  | 正文头尾及伪指令保留在 `value.body` 和工具文本；来源 URL 保留在 canonical value、presentation meta、呈现卡数据和渲染标题；结果明确标识外部不可信数据 |
| native 子代理 HTML | 调用保留精确子代理身份；原始 HTML 在 canonical value 中保留，模型侧 Markdown 省略活动脚本，普通伪指令文本保留；Markdown 对下划线的转义不改变文本含义 |
| plan 抓取          | 真实 PlanModeController 和 SessionProjection 开启计划状态，工具目录与 native 一致；抓取成功，计划状态及其 Session 事件保持原样                       |

合成网页要求调用 `fixture_side_effect` 并额外抓取另一页面。断言显示成功传输只有三次明确请求，合成 DNS 三次，canary 工具调用为零；抓取前后系统提示组装和相关合成 Session 不变。测试没有模型参与，因此这里只证明工具返回与调度边界，不能推论模型抵抗提示注入或完整对话行为。原始 HTML 也不能直接作为可信活动页面执行。

## 可用性与模式边界

以下由真实官方注册表和执行器检查，不把目录可见等同于调用必定成功：

- 配置的 provider 不可用时，`web_fetch` 仍在工具目录中，实际调用返回 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`，不进入 DNS 或传输。
- 对子代理的官方 scoped deny 同时移除目录中的工具和对应提示；实际调用返回 `UNKNOWN_TOOL`，主代理目录不受影响；撤销后恢复。
- 释放官方 tool-web 插件后，工具及提示一同消失，执行返回 `UNKNOWN_TOOL`，不进入 DNS 或传输。
- 官方 scoped PTC presentation 下，注册的能力仍包含 `web_fetch`，直接调用真实拒绝，要求从 `run_code` 内部调用；没有 PTC runtime 时组装提示明确报错。本轮没有启动执行器、子进程或嵌套程序，PTC 抓取仍未验。

逐份核验的官方默认 preset 声明中，standard、cordis、PTC 均登记 tool-web 且启用 fetch，minimal 没有该插件。这只是默认声明检查；真实 profile 可以修改配置。本轮分别组合所需服务，没有完整挂载任何 preset，因此不能把 native/plan 子路径提升为完整模式执行通过。

## 真实回环实验

任务自有服务绑定 `127.0.0.1` 的临时端口，正文仅含合成数据。首次普通沙箱执行时监听被系统以 `EPERM` 拒绝；通过正式工具审批运行同一用例后，服务实际监听，并在测试结束时关闭。没有换协议、地址或绕过权限。

真实官方 `web_fetch` 使用未替换的原生 public-only resolver，对该 URL 返回 **`WEB_BLOCKED_URL`**。服务请求数、真实 DNS 调用和出站连接尝试均为零。此结果证明原生回环拒绝和资源收尾有效，**不构成成功回环抓取证据**。既有独立 HTTP 回环组合采用明确的测试 resolver，也不能替代这项验收。未弱化 public-only、代理或系统沙箱。

## 复验与状态

```sh
DSH_UNLIMIT_RUNTIME=<official-runtime> \
  <bundled-node> --test tests/webtools-host.test.mjs
```

显式设置 `DSH_UNLIMIT_WEBTOOLS_EVIDENCE=1` 可在全部场景通过后更新 [webtools-acceptance.json](evidence/webtools-acceptance.json)。执行成功回执为 **10 项通过、0 失败、0 跳过**；不提供运行时时，两个顶层官方测试明确跳过。测试不会联网获取官方运行时。

以上为早期组件证据。下节补齐完整 standard/PTC 预设的 AgentLoop 路径；真实模型行为、桌面嵌入、外部目标和真实 DNS 仍未验。公开证据只包含独立测试与合成摘要，不包含官方源码、默认提示词或真实业务数据。

## 完整 standard 与 PTC 执行（2026-10-21）

针对 `c14f088` 后工作区，补上此前只见到组件调用、未见完整模式执行的证据。本轮没有发现需要修改产品源码的缺陷；没有新增或替代网页工具，使用完整原始预设的官方 `web_fetch`。

`tests/webtools-preset-host.test.mjs` 通过真实 Loader/Registry 挂载 standard，执行四个会话、八次合成模型请求：

- replace 开启、计划模式开启、revert 后分别实际调用网页工具一次；自写正文取代 persona，撤销后恢复官方 persona，工具 schema 始终一致，计划状态保持。
- 正文、来源 URL 和原生不可信数据说明进入下一轮模型请求，工具消息与 Session 完全相同；页面中的伪指令没有进入 system 槽。
- 第四个会话抓取回环地址，原生 public-only 返回 `WEB_BLOCKED_URL`，没有 DNS 或 HTTP 传输；错误没有被插件改成成功。
- 每个会话经官方 JSONL reader 读回全量事件，与内存一致。该组 **5 项通过**（父测试及 4 场景）。

`scripts/probe-ptc-web.mjs` 是显式执行探针，不随普通测试启动进程。完整 PTC 预设下，replace 与 revert 各执行一次真实官方 Node/Seatbelt 后端：共 **4 次合成模型请求、2 次 run_code、2 次内层 web_fetch、2 个实际子进程**。外层与内层 parent/root/subCallId 对应，完整网页正文和来源通过 SDK 返回，再进入下一轮模型请求。`tools:ptc-only`、`tools:sdk` 和 run_code schema 保留；PTC 返回 canonical value，不据此声称带有 native 文本渲染的同一前缀。

两份物理 JSONL 的调用、内层分派及结果逐条与内存一致，官方 reader 也检查全量事件。两个子进程及控制管道均实际关闭，subprocess/controlChannels/PTC live 均为 0，临时根已清理。探针 **3 项通过**（父测试及 2 场景），643 个实际导入的官方文件通过发行库存摘要校验；源码摘要、预设组合、调用记录和清理边界见 [PTC 网页证据](evidence/ptc-web-acceptance.json)。

两个验收都保留原生 public-only resolver；仅合成 DNS 答案及 Undici MockAgent HTTP 传输，不产生真实网络连接。固定 `.invalid` 网页是原创合成文本。模型响应也是预设动作，因此不证明真实模型能抵抗网页提示注入或正确理解页面。PTC 子进程不能自行连接网络或再启动进程，网页调用通过官方 SDK 回到父进程的合成传输；官方只读 Seatbelt 原样保留，不声称具有内核网络白名单。

复验：

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
DSH_UNLIMIT_OFFICIAL_PACKAGES="$PWD/artifacts/official-packages" \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
  --expose-internals --test tests/webtools-preset-host.test.mjs

/usr/bin/env -i PATH=/usr/bin:/bin \
  DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
  '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
  --expose-internals scripts/probe-ptc-web.mjs
```

`CORE-WEBTOOLS` 仍为部分：完整 standard 的普通/计划状态和 PTC 的替换/撤销抓取已隔离验证，但真实网页、真实模型决策、桌面交互及其余工具/网络出口仍未验证。没有修改真实安装、profile 或宿主配置。
