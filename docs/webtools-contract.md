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

`CORE-WEBTOOLS` 维持部分验收：官方 native/plan 工具数据与可用性子路径已执行，成功回环抓取被官方策略拒绝；完整 preset、PTC 嵌套调用、AgentLoop/模型行为、真实桌面嵌入、外部目标和真实 DNS 均未验。公开证据只包含独立测试与合成摘要，不包含官方源码、默认提示词或真实业务数据。
