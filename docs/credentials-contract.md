# 凭据记录与安全读回

凭据是当前项目的本地登记，不执行登录、连接、验证口令或授权目标访问。`role` 和 `source` 只是记录者的声明，不改变宿主权限。没有原值揭示、复制、模型读取秘密或自动使用凭据的接口。

## 保存与读回

现有动作保持 `records.save/list/delete`，凭据使用 `kind:"credential"`。`data` 只接受以下非秘密元数据字段和可写的 `secret`；新未知字段、非法类型明确拒绝，错误不回显输入值或未知键名。

| 字段                                  | 合同                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `name`、`username`、`target`、`notes` | 字符串，作为非秘密元数据读回；不要在这些字段登记秘密。账号可读，不代表账号身份已验证。               |
| `assetId`                             | 当前项目的资产 ID；不接受其他项目资产。                                                              |
| `serviceId`                           | 需要 `assetId`，且服务必须属于所选资产；不接受同项目其他资产或其他项目的服务。                       |
| `role`、`source`                      | 自由字符串声明，不授予角色、目标或系统权限。                                                         |
| `secret`                              | 只写：缺省保留原值，非空字符串替换，显式 `""` 清空。界面遮罩不能作为新值保存。不会出现在默认读回中。 |

元数据采用合并更新：缺省保留，显式空串删除对应字段。因此取消资产关联时，应同时清空 `assetId` 与 `serviceId`，避免留下无所属资产的服务引用。凭据正文及元数据类型错误不会部分写入。

```js
// 只用原创虚构内容登记；响应不会包含 secret。
const { item } = store.dispatch("records.save", {
  workspaceId,
  kind: "credential",
  data: {
    name: "合成只读账号",
    username: "fixture-reader",
    role: "只读用途声明",
    source: "合成验收材料",
    secret: "SYNTHETIC-ONLY-EXAMPLE",
  },
});

// 改说明并保留原秘密。
store.dispatch("records.save", {
  workspaceId,
  kind: "credential",
  id: item.id,
  data: { notes: "仅登记，未连接目标" },
});

// 明确清空 canonical secret；没有占位符往返。
store.dispatch("records.save", {
  workspaceId,
  kind: "credential",
  id: item.id,
  data: { secret: "" },
});
```

列表、保存响应及 `WorkspaceStore.get/list/save` 对凭据默认使用相同安全投影：

```js
{
  id, workspaceId, kind: "credential", createdAt, updatedAt,
  data: { /* 仅上述合法字符串元数据 */ },
  secretState: { hasSecret: true, legacyFieldCount: 0 }
}
```

`secretState` 位于记录顶层，不能作为 `data` 再次提交。`hasSecret` 只描述 canonical `data.secret` 是否存在非空值，包含无法安全解释的旧非空类型；`legacyFieldCount` 独立描述其他隐藏字段数量。`hasSecret:false` 不能证明没有遗留秘密。UI 应让秘密输入初始留空，显示存在状态，另以明确操作决定是否发送空串清空；不要把旧值、状态或遮罩自动预填为新秘密，也不要把秘密捕获为页面草稿。

## 遗留字段的保留与显式清理

旧版本允许任意 JSON。未知键及旧非法类型的元数据默认保存在原记录中，普通编辑不会丢失，但这些键名和内容均不回传 API。它们不参与新凭据的有效资产/服务关联。安全投影只返回 `legacyFieldCount`，不猜测某个旧字段是否属于秘密。

需要清理时，通过原保存动作明确提交顶层布尔字段：

```js
store.dispatch("records.save", {
  workspaceId,
  kind: "credential",
  id,
  clearLegacyFields: true,
  data: {},
});
```

这会删除所有未知字段及旧非法类型的元数据，可能包含旧口令、令牌，也可能包含旧自定义资料；必须向用户说明该范围，不能自动勾选或静默执行。已知合法元数据及 canonical `secret` 保留；若同时要清空 canonical secret，再明确提交 `data:{secret:""}`。清理计数通过新 `secretState.legacyFieldCount` 读回。非凭据记录不接受 `clearLegacyFields`。没有新增原始值读取或按秘密搜索接口。

## 边界与存储

原记录 ID 不能通过改 `kind`、工作区或其他保存动作迁移，从而绕过投影。报告仍整条隐藏凭据内容；凭据登记不产生资产探测事件。其他业务记录保留既有字段合同，本次不增加猜测性秘密字段迁移。

原始读取集中在 `WorkspaceStore` 私有 `#entry()`：`get()` 读取后对凭据投影，`save()` 用于归并已有行；凭据更新用它保留未提交的原秘密和遗留字段。`list()` 对凭据行直接投影。公共读取/保存 helper 同样不返回凭据原值。原始 SQLite 和 `store.db` 是受信任本地实现的存储层，不是 HTTP/模型 API；拥有本地代码或数据库访问权仍可读取它，不能据本功能声称加密或隔离恶意同进程插件。

数据库仍以 JSON 明文持久化，插件已有目录/文件权限不等于加密。本次没有迁移真实 profile、读取已有真实凭据、引入密钥库或执行登录。

## 验证边界

临时 SQLite 和原创虚构值覆盖安全读回、秘密保留/替换/清空、遗留字段不丢失与显式清理、错误无输入回显、资产/服务及 ID 作用域、报告隐藏和不执行登录。还回归其他记录的既有合同。UI、HTTP 与模型工具由接入层独立验证；这份 store 证据不能代替页面或真实桌面验收。

```sh
DSH_NODE='/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node'
"$DSH_NODE" --test tests/store.test.mjs tests/credentials.test.mjs
```
