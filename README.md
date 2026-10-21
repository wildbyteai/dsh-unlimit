# dsh-unlimit

**DeepSeek Harness 桌面端的本地运行控制与演练工作台。** 配置自己的系统提示词和规则，管理技能、会话回退、项目资产与证据，通过同一页面检查实际生效状态。

当前版本 **0.1.0**，适配目标为 **DSH 0.2.1-rc.2 · macOS arm64**。已完成合成数据与官方模块的隔离测试，尚未安装到真实桌面验收，完整功能对齐仍在进行。[查看已验证范围与缺口](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/parity.md)。

![dsh-unlimit 桌面工作台，图中为合成数据](docs/ui-preview.jpg)

## 功能

| 工作区域   | 可以做什么                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| 运行控制   | 替换或追加系统正文，配置规则、未来会话默认策略、读取窗口、重试与截断继续；查看能力状态并还原自有修改。 |
| 技能与工具 | 编辑、导入和管理本地技能，查看工具来源和前置条件，配置本地工具目录与环境元信息。                       |
| 会话与任务 | 准备会话回退、分支与草稿恢复；分派明确任务，查看子任务收据、依赖和槽位。                               |
| 演练工作台 | 管理项目、资产、服务、发现、凭据元数据和证据，查询资产关系，导出 Markdown 报告。                       |
| 网络范围   | 手动导入本地国家数据，确认域名解析与连接检查，对已适配的本地 HTTP 路径执行范围判定。                   |

逐项行为、启用方式、数据保存与当前限制见[用户指南](docs/user-guide.md)。网络范围控制尚未覆盖所有工具出口；权限仍由宿主和操作系统决定。

运行代码没有自动更新、激活服务或分析埋点。数据由当前桌面 profile 下的本地服务管理；模型请求仍使用你配置的宿主模型服务。

## 从源码运行

需要 Node.js **24.13 或更高版本**。没有 npm 运行时依赖；Prettier 仅用于开发期格式化。以下命令在克隆的源码仓库中执行：

```sh
npm ci
npm run check
npm test
npm run build
npm run preview
```

打开 `http://127.0.0.1:4177/dsh-unlimit/ui/`。预览只监听回环地址，使用临时 SQLite、合成记录与独立技能目录，退出时清理；不读取真实 profile，也不能启用真实宿主控制。

```sh
npm run doctor -- --app "/Applications/DeepSeek Harness.app"
npm run pack:local
```

`doctor` 只读检查已安装程序。打包生成 `artifacts/dsh-unlimit-0.1.0.tgz` 并打印 SHA-256；本地包通过官方插件管理器安装。[安装、还原与资料保留](docs/user-guide.md#安装还原与资料保留)包含操作和未验收边界。本仓库尚未执行真实安装，默认加载不启用运行控制。

## 开发与验证

代码按 `src/core/` 本地逻辑、`src/host/` 宿主适配、`src/server/` 同源 API、`web/` 页面分层。`scripts/` 提供检查和打包，`tests/` 使用合成数据与官方模块执行验收。`npm run format:check` 检查格式。

官方模块测试需显式设置 `DSH_UNLIMIT_RUNTIME`，部分测试还需经校验的官方归档；缺失环境门会明确跳过。复验命令、实际结果和执行边界见[验证记录](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/verification.md)。未调用真实模型的测试不等于完整桌面验收。

- [维护流程](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/maintenance.md)：版本探测、适配和交付。
- [接口约定](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/contract.md)：数据、服务和副作用。
- [验收清单](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/parity.md)：保留 117 项原始行为目标，持续记录差距。
- [开发来源](https://github.com/wildbyteai/dsh-unlimit/blob/main/docs/provenance.md)：实际开发历史及检查的证明范围。

公开源码供审阅；当前许可证尚未选定，包元数据为 `UNLICENSED`。使用与第三方归属见 [NOTICE.md](NOTICE.md)。本项目不代表 DeepSeek 官方。
