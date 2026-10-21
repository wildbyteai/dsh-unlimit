# 卸载与桌面生命周期合同

当前适配目标为 macOS arm64、DSH `0.2.1-rc.2`。工作台的卸载路径为“确认 → 清理本插件 → 官方移除 → 读回安装记录 → 显示回执”。准备成功不等于卸载完成，官方模块隔离通过不等于真实桌面安装验收。

## 官方入口与身份

后端使用官方 `pluginManager` 服务的公开 `listBundles()` 与 `removeBundle(name: string): Promise<ChangeResult>`。前者分别返回声明安装状态 `installed`、实际来源位置 `availability`、安装来源 `source`、可移除性 `removable` 和贡献 `rows`；后者取消 bundle 选择、协调运行树、检查贡献是否仍活动，再通过官方包管理器移除依赖。

卸载目标固定为 `dsh-unlimit`，请求不能指定其他包。只接受当前受支持桌面宿主中的唯一记录，并要求：

- `installed === true`、`availability === "profile"`、`source` 非空、`removable === true`，没有 `readOnlyReason/error`。
- 贡献条目 `rowId/moduleName` 均为 `dsh-unlimit`，`entryId` 与当前插件 Loader 条目一致。
- 准备后再次读取上述身份，且管理器的 `ownerContext` 不变。

Cordis 每次读取服务会产生不同的上下文代理，不能用代理对象 `===` 判断管理器是否被替换。官方 PluginManager 的 `ownerContext` 是稳定的公开实例字段；该区别已有真实官方实例测试。尚未安装、只有选择记录、安装自带、只读或身份不符时，不做卸载准备。

`setPluginEnabled`、`setBundleEnabled` 和 `fiber.dispose()` 分别属于启用状态、bundle 选择和运行资源释放，不等于移除已安装包。官方无 HMR 且 bundle 正在运行时会返回 `stop-profile`，仍有贡献条目时可返回 `bundle-in-use`。

## 操作与准备

HTTP 接口为 `maintenance.uninstall`，请求必须为 `{bundle:"dsh-unlimit", confirmed:true}`。工作台先显示资料保留和运行影响确认；取消不调用接口。此动作不向模型工具开放。

控制器先停止所属连接检查并等待其请求/套接字关闭，再排空已经接纳的动作，准备/移除期间拒绝新的普通动作。准备持久禁用本插件，撤销当前安装的演练使用确认，按计划协调器 → 工作流顺序停止本项目执行者，撤销自有预设及运行控制，并取消本项目工具版本探测。步骤逐项记录；任一步失败都不调用官方移除，返回 `UNINSTALL_PREPARATION_FAILED` 和已经发生的部分结果。成功后只调用一次官方 `removeBundle("dsh-unlimit")`，重复请求合并进行中的操作。

官方管理器没有在本次适配中建立卸载专属的前置清理钩子。Cordis disposer 中的错误会记录并被吞掉，因此业务准备必须独立执行、检查结果。普通 dispose 仍承担资源释放，不能清空持久演练确认，否则禁用、热重载、退出也会破坏确认持久性。

用户直接从官方插件管理器卸载会绕过本插件准备入口；该路径的持久确认清理目前未覆盖。不能把这个边界改写成所有官方卸载入口均已完成清理。

## 回执和失败

官方 `ChangeResult` 的 `application` 使用 `applied / restart-required / failed / overridden / cancelled`；另有 `changed`、`stage`、`target` 和可选错误、警告、包管理器结果。Promise fulfilled、HTTP 200、`changed:true` 或包管理器退出码 0 都不是卸载完成的充分条件。

本插件解析官方应用结果，再通过先前捕获的管理器读回 `listBundles()`。只有 `applied/restart-required` 且本插件不再安装，才返回 `removed:true`。`UNINSTALL_INCOMPLETE` 保留结构化部分回执；调用拒绝、未知格式或读回失败使用 `UNINSTALL_UNKNOWN`，不自动重试。准备已发生的还原与确认撤销不会因后续失败而伪装成未发生；未知结果的partial保留prepared及managerCalled，省略尚未确认的removed。准备后所有权改变返回UNINSTALL_STATE_CHANGED及已完成准备、removed:false、managerCalled:false。

官方卸载可能在返回前释放本插件和关闭数据库。在途 HTTP handler 仍持有响应，路由注销只影响后续匹配；卸载后的处理只使用捕获的管理器和普通回执值，不再读取 store/status。界面停止轮询并显示回执，之后的本插件请求可能为 404，不能继续把它们当作状态查询通道。

## 资料保留与重启

默认保留本插件整个数据目录，包括 `workspace.sqlite` 中的业务记录、规则、导入技能和材料，以及官方技能和无关文件。清理仅撤销本安装的演练使用确认与运行控制，不递归删除资料目录。重新加载同一数据根时须重新确认演练使用。

本插件不自动重启桌面。官方管理器返回 `restart-required` 时，回执明确提示用户保存工作后自行重启。已核对的 `fiber.restart()` 只重载插件，`Loader.exit()` 是空钩子；它们都不能充当桌面重启成功证据。尚无已适配的通用桌面 relaunch 公共合同，`LIFE-RESTART` 仍未实现、未实机验证。

## 本地包升级接口核查（2026-10-21）

`0.2.1-rc.2` 的公开 `pluginManager.installBundle(spec, options)` 接受绝对 `.tgz/.tar.gz` 路径，但不能据此声明离线升级已实现。已核对发行清单中插件管理器的 JavaScript/JSON 文件摘要；本次仅阅读程序文件，未调用该接口、包管理器或真实 profile。

- 选项有 `enabled/requestId/approvedBuilds/saveExact/registry`，没有逐次 `offline` 或 `ignore-scripts` 控制。它先查询 registry，再执行普通 `pnpm add`；缺失依赖可能联网，脚本遵循 pnpm/profile 的既有策略。
- 本地包的官方 `inspect` 只检查路径存在，不提供包名和版本，而且也会调用 pnpm。实际安装之后才从依赖变化识别目标、检查 bundle 与兼容性，不能充当只读包身份预检。
- 有 HMR 且 spec 已识别为已安装包时会拒绝 `already-installed`。新 tgz 路径未必能在执行前识别包名，这不构成可靠的自身升级合同；本项目不会靠换路径规避已安装检查。
- 返回的 `application/changed` 需与安装记录和运行状态分别核对；失败快照恢复主要覆盖 manifest/lockfile，不证明下载、node_modules 或脚本副作用已还原。

源码定位为 `@deepseek-ai/dsh-plugin-manager/lib/index.js` 的 `parseInstallSpec`、`inspect`、`installBundle`、`runPnpm` 与 `publishAndReload`。因此 `maintenance.install` 继续明确拒绝，工作台安装按钮保持禁用；LIFE-OFFLINE 的零网络请求、升级保留资料和真实桌面安装仍为缺口，不用包构建或假包管理器结果代替。

## 证据与复验

运行：

```sh
DSH_UNLIMIT_RUNTIME="/path/to/dsh" node --test tests/maintenance-host.test.mjs
```

未提供运行时路径时明确跳过。测试入口逐项核对官方发行版本和入口 SHA256，测试仅创建系统临时目录中的原创合成 profile 和 SQLite，不读取真实用户 profile。需要回环 HTTP 监听权限；发生环境拒绝时应报告或使用工具支持的权限流程，不能以换端口、协议或宿主规避。

本轮 `maintenance-host.test.mjs` 的 6 项官方隔离验证实际通过：

- 真实 PluginManager 执行 `listBundles/removeBundle`、取消选择、文件锁及结果处理，真实 Cordis 释放插件，真实 WebServer 在 self-dispose 后仍返回当前 HTTP 回执；后续请求 404。
- 临时 profile 中仅移除自身依赖声明和选择，其他 bundle/字段保持；用户技能、插件导入技能、材料及无关文件字节保留。有效 SQLite 重开后其他记录保留，演练确认已撤销，关闭后 store 读取计数为零。
- 真实管理器无 HMR 时返回 `stop-profile`；包管理器失败和假退出 0 却未移除依赖都不报告完成；安装自带条目拒绝且不做准备。另用合成 `cancelled` 响应验证失败语义。

包管理器 `runPnpm` 是假边界，只接受 `remove dsh-unlimit` 并修改临时依赖声明，没有执行 pnpm、删除实际包、访问外网或启动子进程。HMR/Loader 后端也是假边界，负责按选择变化释放测试 fiber；没有验证真实 HMR 重组。测试使用真实维护适配器和 HTTP handler，但没有挂载完整 Controller/桌面 UI；控制器准备链、并发和HTTP部分回执由maintenance.test.mjs的10项覆盖；maintenance-ui.test.mjs有8项界面流程测试，实际1280×720合成预览另见 [验证记录](verification.md#预览交互记录)。

真实桌面安装/卸载、实际 pnpm 文件处理、完整 HMR、外部官方管理器卸载、Windows 和桌面重启仍未验收。临时隔离证据不能提高这些条目的验收层级。
