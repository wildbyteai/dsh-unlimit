# 新会话权限默认预设合同

目标：DSH desktop `0.2.1-rc.2`，对应 `CORE-PERMISSION` 的未来新会话默认值。实现位于 `src/host/permission-defaults.js`，不改 preset 表、不写 profile、不直接写既有会话。

## 设置与接口

新增设置由根集成层定义：`permissionDefault: string`，默认 `''`。

- `''`：跟随宿主原始动态引用的当前值，包括其 undefined 推导默认语义。
- 非空：只能是当前官方 `permissionPresets.catalog().defaultOptions` 中一个精确的 `value`，不 trim、改写或猜测名称。
- 官方 `catalog.options` 中的动态 Auto 及派生 Custom 不因此成为可用默认项。
- `settings.enabled !== true` 时跟随宿主原引用；仅 enabled 且非空选择时覆盖未来默认。

导出 `PermissionDefaults(ctx, store, host)`，`ctx` 可由组合层同步更新。方法：

| 方法             | 结果与行为                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `status()`       | `{available,active,requested,effective,options,detail}`；effective 为字符串或 null；options 仅来自官方 defaultOptions                     |
| `capabilities()` | 一项 `id:'permissionDefault'`，状态 unsupported / available / active                                                                      |
| `validate(name)` | 返回有效原字符串；无匹配项抛 `INVALID_PERMISSION_DEFAULT`，非字符串抛 `INVALID_INPUT`；空选择可在宿主缺服务时清除                         |
| `apply()`        | 安装可撤销动态引用，返回 status；重复安装不堆叠；显式选择而宿主不可用时拒绝                                                               |
| `revert()`       | 恢复仍属于本插件的原描述符及原引用；重复撤销安全；外部修改保留并抛 `CONFLICT`                                                             |
| `changed()`      | 调用当前官方 `emitCatalogChanged()`；成功返回 `{notified:true,deliveryConfirmed:false}`；缺服务且没有选择时返回 `{notified:false,detail}` |

当未选择且缺服务时，apply 返回不可用 status，不阻止主功能。未知选择不降级成其他 preset。状态读取异常会明确显示 unavailable/detail，不伪造生效值。

`active` 表示本插件仍拥有引用、enabled 为 true 且存在有效非空选择；仅安装了透传引用不标 active。`effective` 来自实际官方 catalog 的 defaultPreset，不把 requested 当作已生效默认。

## 官方动态引用与所有权

只读查找 configEditor / loader 的 `entries()`，必须唯一匹配活动 `@deepseek-ai/dsh-permission-presets` fiber（state 2），且其 config.defaultPreset 是可替换的动态引用。目录服务必须属于同一 fiber。

官方 Cordis 每次 `ctx.get` 会创建新的 traceable Proxy，直接比较 Proxy 会误判替换。因此只用官方导出的 `symbols.original`（`Symbol.for('cordis.original')`）取得稳定服务身份作相等性和提供者 fiber 核对；方法调用仍走官方服务接口。

官方 README 明确 configured preset table 在该 plugin lifetime 内固定，只有不进入 defaultOptions 的 Auto 可动态贡献。因此 apply **在替换前**读取并验证 defaultOptions 快照，绑定 entry/fiber/config/服务身份。getter 只用该快照选择，不调用 catalog，不做重入机制。status 在 getter 外读取官方 catalog。

替换的是 config 容器字段，原引用保持不变。包装引用复制官方 volatile symbol 写协议，并把未覆盖时的 get 委托原引用。官方 `updateVolatile` 无论作用于原引用或包装引用，都继续更新原引用闭包；禁用、空选择、撤销后看到最新宿主值。

每次 get 核对所有权及身份。宿主重挂载、config/服务替换或字段/描述符外部变更后，旧 wrapper 停止使用旧快照，沿用原 get。status 显示冲突，apply 拒绝；只有明确撤销后才能对新实例重新 apply。撤销不覆盖外部引用或属性元数据修改。

apply 安装后发送官方目录变更通知；若该次通知调用失败，恢复本次刚安装的字段、清除所有权并抛出错误，允许干净重试。revert 先恢复引用、清除所有权，再通知当前同一实例；通知失败仍抛出，但不误报还拥有已恢复字段。重挂载时只清理旧实例中仍拥有的字段，不通知已接管的新实例。

根集成层在保存 enabled / permissionDefault 后调用 changed 刷新官方目录缓存。外层 changed 失败不撤销已保存设置或已应用引用，调用方须准确报告“已应用但目录通知未确认”。官方 emitCatalogChanged 本身将订阅者异常记 warn 并隔离，未返回投递确认；本插件不能声称每个客户端都已刷新。

## 新会话、已有会话与官方 UI

真正的新会话仍由官方 `pinInitialPermission` 读取 defaultPreset，并追加其 canonical 事件：

- `permission/preset {preset}`
- `sandbox/mode {mode}`
- `approval/policy {policy}`

适配器从不直接追加这些事件，也不调用 `permissionPresets.set` 改已有会话。官方保留已有、seeded（包括明确空 seed）或已有显式权限事实的会话；其中缺少的事实由官方按原有规则补齐。撤销只恢复未来默认，**不会回滚已经 pin 的会话权限**。

官方当前会话 UI 写路径 `permissionPresets.set(session,name)` 继续生效，并只修改该会话。用户选择未来默认，不阻止其随后在当前会话改回限制预设。

不能把 autoApprove 映射成 approval `never`。官方 danger-full-access 预设当前组合为 sandbox `danger-full-access` 与 approval `never`；这是用户明确选择的官方组合。`never` 会拒绝仍需审批的请求，不是授予 allowed-once。隔离测试直接验证其官方 decide 返回 rejected。autoApprove 为 true 而 permissionDefault 为空时，新会话仍保持官方 workspace-write / ask 默认。

## 验证与边界

```sh
DSH_UNLIMIT_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' \
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
--test tests/permission-defaults.test.mjs tests/permission-defaults-host.test.mjs
```

本次专项结果：**10 tests / 10 pass / 0 fail / 0 skip**（8 单元 + 2 官方模块隔离）。官方测试每场景 9 个直接入口 SHA256 与 desktop-runtime.json 匹配，release 为 0.2.1-rc.2。

官方隔离测试使用真实 PermissionPresetService、SessionStore、ProjectionRegistry、ApprovalService、SandboxPolicyService、volatile 引用与官方 fiber。活动配置目录是明确的内存合成目录，指向真实官方 fiber，避免加载 profile。Shell 仅提供 pin 读取的 workspace-write 声明，不挂载执行器。

17 个合成会话核对：未来 fresh 默认、既有记录不变、空 seed / 受限 seed、官方 UI set、禁用 / 空选择 / 撤销后默认、owner volatile 更新、真实 fiber 重挂载、外部字段替换和通知行为。SessionStore 本身没有 AgentLoop 自动日志 owner；测试通过公开 persistence.create/append/flush 将观测到的 canonical 事件写入临时 JSONL，再逐项读回比对，不把这描述成 AgentLoop 自动持久化 E2E。

单元测试另覆盖非法名称、不可用 / 歧义 / 不可写目录、上下文与服务替换、descriptor 冲突、重复 apply/revert、应用异常及通知失败清理。无 runtime 环境时，两个官方测试明确 skip，不能计为验收通过。

不使用 tool-fs，不声称文件工具 E2E 或实际操作系统权限执行已验证。没有安装、重载、连接运行中桌面、读取真实会话 / profile / 密钥、发模型请求或网络。尚未验证实际桌面设置选择器和未来会话创建 UI 的完整链路。
