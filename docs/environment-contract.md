# 本地环境配置

`new LocalEnvironment(dataRoot)`，从 `src/core/environment.js` 导入。`dataRoot` 必须是现有的规范化绝对目录，路径所有组件不能是符号链接。macOS 临时目录应传入 `realpath` 后的 `/private/...` 路径。模块只管理该根下 `.environment/config.json`，不使用 settings、records 或 store 通用接口存放实际变量值。

## 公开接口

`dispatch(action, payload)` 为同步接口。未知 action/字段明确报错，没有通用成功响应。

| Action                         | Payload                                    | 结果             |
| ------------------------------ | ------------------------------------------ | ---------------- |
| `environment.capabilities`     | `{}`                                       | 能力与保护边界   |
| `environment.status`           | `{}`                                       | 当前脱敏状态     |
| `environment.variables.save`   | `{revision,name,secret?,value?}`           | 保存后的脱敏状态 |
| `environment.variables.delete` | `{revision,name}`                          | 删除后的脱敏状态 |
| `environment.hosts.save`       | `{revision,items:string[]}`                | 保存后的脱敏状态 |
| `environment.keys.save`        | `{revision,id?,label,path}`                | 保存后的脱敏状态 |
| `environment.keys.delete`      | `{revision,id}`                            | 删除后的脱敏状态 |
| `environment.onboarding`       | `{revision,decision:'configured'\|'skip'}` | 保存后的脱敏状态 |

所有写操作要求最新 `revision`。`CONFLICT` 后应重新获取脱敏状态，请求不能用旧表单覆盖较新的配置。变量名使用 `[A-Za-z_][A-Za-z0-9_]{0,127}`，变量最多 128 个，单值最多 32 KiB UTF-8，不接受 NUL。主机最多 128 个，私钥路径最多 32 个，配置文件最多 1 MiB。

新变量必须明确给出 `secret` 和 `value`。已有变量省略 `value` 表示保留当前值，明确传入 `""` 表示清空值。不要把页面的掩码当成新值提交。已有变量不能通过保存改变敏感性；需要删除后明确重建。

状态结构：

```js
{
  revision: 1,
  variables: [
    { name: 'TOKEN', secret: true, configured: true, masked: '••••••••', updatedAt: '...' },
    { name: 'MODE', secret: false, configured: true, value: 'synthetic', updatedAt: '...' }
  ],
  hosts: ['operator@example.invalid'],
  privateKeys: [{
    id: 'uuid', label: '合成路径示例', path: '/absolute/path', updatedAt: '...',
    metadata: { available: true, validation: 'metadata-only', bytes: 32, modifiedAt: '...', mode: '600' }
  }],
  onboarding: { state: 'configured', configured: true, blocksChat: false, grantsAuthorization: false }
}
```

`hosts` 是基础设施/连接主机清单，经现有 `normalizeServers` 校验；它不是 `settings.ownServers` 的目标例外名单，不授予任务或目标权限。私钥只校验明确的现有普通文件路径和元信息，不打开文件、不读取字节、不验证密钥格式、不连接主机。原路径之后失效时，状态保留该条目并返回 `metadata.available:false`。删除路径条目不会删除密钥文件。

首次状态为 `pending`。保存任一变量/主机/私钥条目会标记 `configured`；这里表示已有保存的配置，不代表连通性、凭据有效性或工具就绪。清空最后一项时 `configured` 回到 `pending`。`skip` 独立持久化为 `skipped`，不清空已有配置；两种状态都不阻塞普通聊天，也不替代演练入场确认或宿主权限。

## 仅内部解析

`resolve(name)` 返回一个已配置变量的实际字符串。`exportEnvironment(names)` 只返回调用方明确列出的变量，不读取或合并 `process.env`。缺少任一指定变量会整体报错。二者不能注册为 Controller、HTTP、模型工具或 UI action，返回值不能进入日志、报告、提示词或错误响应。后续受控进程适配器须自行限定变量名单与获授权的使用场景。

## 持久化与边界

目录使用 0700、配置和临时写文件使用 0600；POSIX 下拒绝非当前用户所有或有组/其他用户权限的存储。拒绝存储路径中的符号链接和配置文件硬链接。写入使用短暂排他锁、修订校验、同目录暂存、文件同步及原子 rename。失败诊断不附原始文件系统异常或变量值，秘密没有长度、哈希或尾字符读回。

这不是加密存储或系统钥匙串；`capabilities.encryptedAtRest` 固定为 `false`。持有当前操作系统账户权限的程序仍可能读取文件。Windows ACL 与实际桌面 UI/受控进程消费未验，能力结果明确返回 `platform-acl-unverified`。本模块不运行命令或网络任务。

进程在写入中崩溃可能留下受限暂存文件或 `write.lock`；遇到 `BUSY` 不自动抢占锁。需确认没有活动写入者后再由本地管理操作处理遗留文件。本模块不提供自动修复或秘密导出接口。

## 已验证

使用 bundled Node24 执行 `node --test tests/environment.test.mjs`，全部为新建临时目录与虚构值，覆盖持久化脱敏、遗漏秘密保留、单项删除、内部明确名单解析、修订冲突、排他锁、原子写失败、异常脱敏、主机规范化、密钥元信息不读字节、路径/链接/权限拒绝、首次配置/跳过及数据根隔离。没有访问真实 profile、密钥或网络。
