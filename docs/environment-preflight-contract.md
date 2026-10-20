# 环境依赖预检

基于当前独立实现，为 `HostCatalog` 增加只读安装级环境配置依赖：

```js
const catalog = new HostCatalog(ctx, { library, toolkit, environment });
```

`environment` 是当前安装数据根的 `LocalEnvironment` 实例。模块只调用一次 `environment.dispatch('environment.status')` 脱敏快照；不调用 `resolve`、`exportEnvironment` 或任何写动作。

`src/host/catalog.js` 导出 `normalizeRequirements(items)`，供调度计划与目录预检共用。现有 `tool/toolkit/directory/skill` 合同保留，新增：

| 声明                                                                | 通过条件                                           |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| `{kind:'environment-variable',name:'TOKEN'}`                        | 当前安装登记了变量且值非空；`nonEmpty` 默认 `true` |
| `{kind:'environment-variable',name:'EMPTY_ALLOWED',nonEmpty:false}` | 仅要求当前安装登记该变量，允许空值                 |
| `{kind:'environment-host',name:'operator@example.invalid'}`         | `normalizeServers` 规范后精确匹配环境 `hosts` 清单 |
| `{kind:'environment-key',name:'已登记私钥UUID'}`                    | ID 已登记，当前元信息确认路径仍为可接受的普通文件  |

以上声明可用于 `catalog.preflight` 顶层 `requirements`、`skills:[{origin,id,requirements}]` 的明确声明，以及技能元信息 `metadata['dsh-unlimit'].requirements`。仍不从技能正文猜测依赖。变量名使用既有环境变量格式；主机不接受密码、URL、端口、网段或通配符；私钥只接受登记 ID，不接受任意文件路径。其他字段明确拒绝。

新增环境检查的 `checks[].state` 是 `ready/missing/unknown`。未登记、要求非空但为空、主机不匹配、私钥路径已知消失或不安全均为 `missing`。配置服务缺失/读取失败、密钥元信息受权限限制或其他无法确认的状态为 `unknown`。环境检查通过只表示本地配置满足声明，不表示凭据有效、主机可达、密钥格式有效或任务获得授权。

顶层沿用既有 `status:'ready'|'blocked'|'unknown'`：任意 `missing/invalid` 导致 `blocked`，否则任意未知项导致 `unknown`。新增环境检查不会改变已有工具检查的 `available` 状态。仅当实际声明环境依赖时增加 `environment:{state,revision?,detail}` 观测摘要；不返回变量值（包括普通变量值）、其他变量/主机清单、私钥正文或路径。检查中的名字只是调用方明确请求的标识。

未声明依赖仍是 `unknown`，明确 `requirements:[]` 仍表示本次没有额外声明；现有目录与目录来源完整性检查继续生效。没有环境依赖时不会读取环境配置，也不会因未注入环境模块平白增加未知项。预检不写修订号、不处理修订冲突、不注入进程环境、不读取密钥字节、不联网/扫描/执行工具；`executionAuthorized` 保持 `false`。

根集成只需将当前 `LocalEnvironment` 实例传给 `HostCatalog`，并在调度计划复用导出的 `normalizeRequirements`。现有 `catalog.preflight` 动作可直接承载新增声明，不需要公开秘密解析动作。

验证使用 bundled Node24 运行 `node --test tests/catalog.test.mjs tests/environment.test.mjs`，仅新建临时根和合成变量/主机/密钥文件，覆盖一次快照、值与未请求项不泄漏、默认非空/显式允许空、主机身份精确匹配、登记文件消失/权限未知、安装根隔离、环境错误脱敏及空声明语义。配置字节与 revision 在预检前后相同。宿主桌面入口、UI 编辑器及真实凭据/连接未在本层验证。
