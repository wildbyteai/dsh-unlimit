# dsh-unlimit

本项目是桌面端独立实现。需求范围与差距在 [docs/parity.md](docs/parity.md)，接口和数据约定在 [docs/contract.md](docs/contract.md)，已验证证据在 [docs/verification.md](docs/verification.md)，开发来源和检查边界在 [docs/provenance.md](docs/provenance.md)。

- 适配版本以 `src/host/desktop.js` 的 `SUPPORTED_HOST` 为准。新版本不能仅修改版本号就宣称适配完成；按 [维护流程](docs/maintenance.md) 验证受影响路径。
- 不复制其他插件的源码、默认提示词、技能或素材，不添加其激活、遥测或更新服务。保留对开发来源的准确说明。
- 宿主依赖在运行时解析，安装包不分发宿主代码或用户 profile。新代码应放入对应的 `core / host / server / web` 层。
- 运行控制保持可撤销；恢复时只还原本插件仍拥有的接口。会话部分失败必须披露已创建的分支等实际结果。
- 测试使用临时根目录和原创合成数据。真实 profile 写入、安装、重载和正在使用的会话变更需要明确授权；普通测试不能读取真实会话。
- `npm run check`、`npm test`、`npm run build`、`npm run pack:local` 是基本检查；`npm run format` 统一格式。官方模块测试用 `DSH_UNLIMIT_RUNTIME` 显式选定运行时，缺失时保持明确跳过。
- 本机官方隔离验收使用 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`（已验 `v24.21.0`）；Node 版本探测也只调用这个可执行文件，不把 `Contents/MacOS/DeepSeek Harness` 应用主程序当作 Node。
- 本地页面预览用 `npm run preview`，只监听回环地址。UI 修改验证实际渲染和关键交互；预览通过不能替代桌面嵌入验收。
- GitHub 只提交独立源码、合成测试、文档与合成截图；`artifacts/`、`dist/`、数据库、工具目录与用户资料不入库。

- `docs/parity.md` 的 117 项既定验收是当前范围基线；补充规格不能覆盖它。状态可随真实证据更新，不能改写期望结果来消除差距。
- 来源与发布检查只验证其列出的文件、路径和分层约束，不能证明原创性或严格净室开发，不得据此删除第三方依法应保留的声明。
