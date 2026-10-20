# 重复调用建议提醒控制

`new RepeatReminder(ctx, store, host)`，从 `src/host/repeat-reminder.js` named/default 导入。仅适配 `host.kind:'desktop'`、`version:'0.2.1-rc.2'`、`supported:true` 及明确的 `runtimeRoot`。

设置为 `repeatReminder:'host'|'off'`，缺省值为 `host`：

- `host`：沿用宿主当前配置；若本实例持有修改，则通过官方生命周期恢复其原配置。
- `off`：仅在官方 repeat 插件原有 `exclude` 中追加 `'*'`，保留阈值、include、参数预览长度与其他配置。不以空 thresholds 关闭插件。

## 集成接口

| 方法                       | 行为                                                                      |
| -------------------------- | ------------------------------------------------------------------------- |
| `await apply({signal?})`   | 应用当前设置，不依赖 `settings.enabled`；允许 root 在标记控制启用之前调用 |
| `await revert()`           | 恢复本实例仍拥有的配置；重复恢复无额外重挂载                              |
| `await changed({signal?})` | 等同应用；仅由根集成在控制已启用时调用                                    |
| `capabilities()`           | 单项能力数组，供根能力目录合并                                            |

能力项包含 `id:'repeatReminder'`、`requested/effective:'host'|'off'`、`state`、`owned`、`advisoryOnly:true` 和说明。`available` 表示可尝试官方生命周期，`active` 只在更新、异步瀑布、挂载稳定和配置读回均已完成后返回。外部所有权变化返回 `unsupported`、`code:'CONFLICT'`；不得把 unsupported 的 effective 字段当作生效证明。设置 host 不强制启用被宿主配置排除的提醒。

根控制器必须 await apply/revert/changed；不要只按设置保存成功报告已生效。根负责设置校验、启用时机、页面与命令入口，本模块不修改这些共享层。没有公开模型工具/HTTP 动作，不使用 ConfigEditor/Settings/Profile 写接口。

## 官方与所有权边界

在任何生命周期调用前，核对发行版本及 repeat、Cordis、Loader 的入口摘要；存在 HMR 时也校验其入口。摘要必须匹配 `desktop-runtime.json` 库存，并只允许唯一活动 repeat 条目。应用时还将已校验入口的实际模块导出与条目 `moduleNamespace.apply`、fiber runtime callback 比较，拒绝同名替身。

应用使用公开 `Fiber.update(nextConfig,true)`。true 是 noSave：真实 Loader 的保存钩子保持 entry.options.config 与树持久配置不变。可用 HMR 时经 `runExclusive` 串行；没有 HMR 时只保证本实例队列，不宣称能锁住第三方变更。

由于 Fiber.update 本身返回 void，本次调用期间添加一个准确匹配目标 fiber 的透明 `internal/update` 观察器，原样调用并返回 next，捕获真实瀑布的完成/拒绝；随后等待 fiber.await 并读回目标身份与完整配置。观察器 finally 撤销，不改变 config、noSave、拒绝或错误，不接触工具、审批、权限、审计事件。已经失败的自有启动恢复使用官方 inactive-fiber 更新分支，该分支没有 update 瀑布，仍须等待挂载稳定与读回。

记录原配置数据、entry/fiber 身份、应用后的 config 对象身份及数据、原始条目配置引用/数据。撤销或失败回滚只在这些仍属于本实例时进行；外部替换或修改返回 CONFLICT 并保留其配置。更新失败可能带 `partial:{restored,owned,rollbackError?}`；若恢复失败仍保留所有权，不报告成功。取消发生在排队时不更新；发生在更新期间则先等待生命周期结束，再恢复本实例仍持有的修改后返回 ABORTED。

## 提醒不等于拒绝

官方 repeat 插件在 post-execute 追加建议上下文，从不拒绝、延迟或改写工具调用。本模块只调整该建议的跟踪范围，任何下游 block、feedback、pre-execute 拒绝和取消保持原结果。关闭提醒不是解除工具限制或扩大任务授权。

重挂载会重置本包的内存重复计数；恢复不会删除已写入会话历史的提醒。已进入 post-execute 的旧监听器仍可能完成一次在途提醒，本模块不追溯改写在途结果。工具注册和其他策略监听器不由本模块变更。

本模块不实现 tool-fs：当前本机其入口摘要与库存不一致，文件读取 cap 继续明确不支持，不读取备份或改写安装。

## 验证与剩余边界

定向命令：设置 `DSH_UNLIMIT_RUNTIME` 为明确官方运行时目录，使用 bundled Node24 执行 `node --test tests/repeat-reminder.test.mjs tests/repeat-reminder-host.test.mjs`。

真实测试挂载库存摘要匹配的 Cordis、Loader、repeat、ToolRuntime、SystemPrompt、Scope、Timer、HMR。HMR 没有 profileContext，watch roots 为空，base 指向新临时目录；工具仅读固定合成临时文本。禁止 socket/fetch/child_process。验证三次调用仍执行、提醒开/关/恢复，post block/feedback/额外上下文、pre 拒绝及取消保持；noSave 期间 Loader.write 为零、原条目配置对象与 JSON 不变，并用普通 update 作为写钩子正向对照。真实异步 update/veto/错误、启动失败回滚、HMR 队列取消/更新后取消、外部官方配置替换冲突均验证。

合成接口测试补齐未知版本、摘要差异、多实例/非活动目录、幂等、未启用时应用及原始条目配置所有权。真实桌面三入口、宿主在途调用及第三方额外动态更新组合未验；这组隔离测试不等同于安装验收。
