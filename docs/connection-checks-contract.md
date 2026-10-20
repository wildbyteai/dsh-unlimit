# 连接检查

对应 DATA-PROBE 的桌面端 WebShell URL 与隧道 TCP 监听检查。仅本插件检查入口适用；这不是宿主所有工具的网络拦截器。地区数据、未登记目标的地区判定、登记域名派生 IP 的跨记录例外仍有差距，SCOPE-REGION / SCOPE-ENFORCE 不因此完成。

## 触发与范围

保存记录、读取页面、准备检查均不查 DNS、不发包。模型数据工具不能调用检查接口。已通过入场确认的用户在页面预览目标后明确确认，才发起一次检查；入场确认和服务器清单本身不证明目标授权。

当前检查入口只允许清单中精确登记的完整主机名或 IP；可选 `user@` 不参与连接，也不携带账号。未登记返回 `denied / scope-unverified`，不查 DNS。此限制明确表示缺少地区判定的当前覆盖范围，不代替原功能的完整地区语义。子域名、另一域名共享的 IP、相邻地址均不自动扩大范围。

每批 1 至 32 条同项目 WebShell / 隧道记录。准备回执的摘要绑定记录内容、服务器清单和入场版本；确认前变化拒绝执行。每项目只运行一批；无自动定时检查、重试或重定向。每项含 DNS 的总预算默认 6 秒，最多 10 秒。

## 连接语义

- WebShell 只接受 HTTP/HTTPS URL，拒绝 URL 用户名、密码、fragment、空白或反斜杠。发送 HEAD，不附加 Cookie、认证头、请求正文或台账凭据；**登记 URL 的查询参数原样发送**，回执隐藏查询值。任意完整 HTTP 响应（包括 3xx/4xx/5xx）表示 HTTP 可达，保留状态码，不证明 WebShell 登录或功能可用。
- 隧道需要明确填写 `listenHost`、整数 `listenPort`（1..65535）。不解析来源、去向、备注、命令或 DSH 会话 ID；UDP 不支持。只建立和关闭 TCP 连接，不发送应用数据，不证明整条隧道或最终目的地可用。
- DNS 使用系统查询结果的一个地址，连接固定该 IP，不由 HTTP 库再解析。Host 和 TLS 证书校验保留原主机名，HTTPS 使用正常证书校验，域名使用原名 SNI；字面 IP 不设置 SNI。无代理环境变量、TLS 降级、重定向或候选地址重试。只返回选定地址、延迟、状态码和固定原因，不返回响应正文、响应头或原始网络异常。

## 回执与生命周期

手工登记状态不变。可信检查结果存放在服务私有 metadata，普通 `records.save` 中的伪造检查字段不作为实际结果。页面分别展示登记状态与上次检查。记录内容变化时历史结果标记过期。

记录或范围在检查中变化，不把旧目标的结果写成新记录的结果；返回实际已观察事实及 `persisted:false / discardReason`。写入失败返回 `CONNECTION_CHECK_PARTIAL`，保留本批已观察的结果，停止后续连接，不宣称保存成功。取消、未授权、不支持均不显示成离线。

停止操作等待本批请求/套接字结束。撤销入场、改变服务器清单、插件卸载准备和 dispose 取消本插件检查；卸载先停止检查，再等待已接纳动作，防止长期等待检查。资料保留。

## API

`connectionChecks.status({workspaceId})` 只读，返回当前批次进度与现有记录的 `lastCheck / stale`。`prepare({workspaceId,recordIds})` 返回 `snapshot` 和逐项 `ready / denied / unsupported`。`run({workspaceId,recordIds,snapshot,confirmed:true,timeoutMs?})` 返回逐项检查回执。`stop({workspaceId})` 返回 `{stopped:true}`。这些操作不加入模型工具的白名单。

逐项回执含 `recordId / kind / name / target / checkType / state / reason / checkedAt / latencyMs / persisted`，实际连接可附带 `transport:{type,address,family,httpStatus?}`。记录或范围变化附 `discardReason`，不混淆“已观察”和“已保存”。

## 验证边界

使用临时 SQLite 和任务所属回环 HTTP/TCP/TLS 服务验证成功、拒绝、超时、取消、范围变更、持久化失败与 UI。未安装真实 DSH、未访问真实目标；真实桌面端嵌入与外部目标连通性尚未验收。具体通过结果记入 verification.md，设计文字不作为通过证据。
