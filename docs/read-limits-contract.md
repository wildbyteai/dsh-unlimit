# 官方文件读取窗口适配

适配对象为 DeepSeek Harness 桌面 `0.2.1-rc.2` 的公开 `@deepseek-ai/dsh-tool-fs` 配置生命周期。这里只调整 `read` 工具正文窗口，不调整其他工具结果、历史消息、上下文压缩、图片大小或实际磁盘读取量。

## 集成接口

`new ReadLimits(ctx, store, host)`，从 `settings.get.value.readLimit` 读取字节预算。导出具名类及默认导出。

- `async apply({signal} = {})`：独立于 `settings.enabled`，应用当前预算。
- `async changed(options)`：与 `apply` 同义；由控制层在控制已启用时调用。
- `async revert()`：仅恢复仍由本实例持有的原配置。
- `capabilities()`：同步返回单项数组。

能力项为 `{id:'readLimit', label, requested, effective, effectiveCaps, state, owned, detail, code?}`。`requested` 为设置字节数（无效时为 `invalid`）；`effective` 为已确认的字节数、`host` 或 `null`；`effectiveCaps` 为当前真实活动配置中的 `{readMaxBytes, readLimit, readMaxLineLength, readStreamMinSize}`。不可信或所有权冲突时，两个有效读回字段均为 `null`。`state` 为 `available / applying / active / unsupported`，`owned` 表示仍保留本实例恢复责任，并不保证没有冲突。冲突另有 `code:'CONFLICT'`。

`readLimit=0` 明确沿用宿主：没有持有配置时不挂载更新；有持有配置时恢复原 cap。绝不把 0 传给官方 cap，也不把 0 描述为无限制。正整数 `B` 必须为安全整数，且 `B+1` 仍为安全整数；映射如下：

| 官方字段                           | 值    | 原因                                                         |
| ---------------------------------- | ----- | ------------------------------------------------------------ |
| `readMaxBytes`                     | `B`   | 官方按 UTF-8 正文与行间 LF 计费                              |
| `readLimit`（行数）                | `B+1` | B 字节最多容纳 B+1 个空行；行间换行也占预算                  |
| `readMaxLineLength`（UTF-16 单元） | `B`   | 任意可容纳的 UTF-8 正文，其 UTF-16 单元数不超过 UTF-8 字节数 |

这两个有限上界用于避免原有行数或行长上限先截断可放进 B 字节的正文，不解释为无限制。其他配置，包括 `read / readImage / write / edit / readStreamMinSize`，完整保留。官方 read 未启用时不擅自启用，返回不支持。

控制层可在首次应用时仅调用受支持的能力；当前安装入口被修改时不能阻断其他独立控制。未持有时 `changed` 遇不可信目标会抛 `UNSUPPORTED_CAPABILITY`；持有后的冲突会抛 `CONFLICT`，必须披露并保留外部配置，不能跳过清理责任。

## 可信门与可撤销更新

要求桌面版本、`desktop-runtime.json` 发行版本一致，tool-fs、Cordis、Loader 及可用 HMR 的实际入口摘要匹配库存，且目录中只有一个活动 tool-fs 条目。目录合并全局 Loader entries 与 Cordis 公开 registry 内的真实 `fiber.entry`，按 Entry 对象身份去重；后者还须满足 entry/fiber/runtime 的相互身份及模块回调一致。这样可以发现不挂入全局 Loader 树的 standard 预设条目，无需读取预设注册器的私有 generation 或制造代理 Entry。要求活动模块 `apply` 在更新前与经摘要校验的实际 import 身份一致。当前真实安装 tool-fs 入口 SHA256 与库存不符，因此业务能力保持 `unsupported`，不会执行修改后的入口。

变更经 HMR 的 `runExclusive`（存在时）及本实例队列串行，调用官方 `Fiber.update(next, true)`。因为该方法返回 void，适配器仅对准确目标 fiber 透明观察 `internal/update`，原样传递 `config / noSave / next`，等待真实异步链以及 `fiber.await()`，核对活动状态、完整配置和持久 entry 原始配置未变；观察器总在 finally 移除。拒绝或异常不会被转换为成功。

持有 entry、fiber、parsed config 对象及其内容、raw entry config 对象及其内容。外部替换或原地修改任一项，恢复均拒绝覆盖；异步模块身份核验返回后再次检查所有权。成功修改预算保留最初宿主配置；失败或更新期间取消时，仅在仍拥有目标状态时回滚到本次调用前的配置。排队取消不更新配置。失败含 `partial:{restored, owned, rollbackError?}`；无法安全恢复时保留实际责任并披露。配置生命周期拒绝恢复也会保留所有权，允许明确重试。无权取消整个宿主或拦截工具、审批、审计链。

## 实际限制

官方实现按完整行加入窗口：下一行超过预算时不返回该行，并给出分页提示。单行先受 UTF-16 上界处理，截断说明也参与字节预算，因此超大单行可能整行不返回；并不提供按字节切片或拆分非 BMP 字符的额外行为。行号、路径、XML 封装和页尾不计入正文预算。源码扫描仍可能到 EOF；本适配不限制 I/O、运行耗时或总内存。调用者可显式选择更小的行数窗口。

生命周期重挂载会短暂撤下工具和提示段，在途旧调用沿用其原 cap。配置仅进程内，不保存 profile，不保证跨进程生效。不修补已安装文件，不提供对不可信入口的替换加载；干净副本仅用于下述隔离测试。

当前仍是单一目标的所有权合同。若同时存在多个活动 tool-fs 条目，包括多个预设或保留的旧 revision，则明确 `unsupported`，不挑选首项或宣称全局预算已生效。拥有配置后遇此歧义，撤销也保留恢复责任并报冲突；清除歧义后可再次明确撤销。跨多个预设的统一预算与恢复仍是功能差距。

## 隔离验证

普通测试：

```sh
node --test tests/read-limits.test.mjs tests/read-limits-host.test.mjs
```

真实官方测试需显式设置两个根并开启官方 HMR 所需的 internals：

```sh
DSH_UNLIMIT_RUNTIME=/path/to/official/runtime \
DSH_UNLIMIT_OFFICIAL_PACKAGES=/path/to/ignored/official-packages \
node --expose-internals --test tests/read-limits.test.mjs tests/read-limits-host.test.mjs
```

缺任一环境门时官方测试明确跳过；两个环境门显式设置后路径缺失或摘要不符必须失败。已单独验证缺失缓存以 exit 1 失败，合成校验用例确认错误 SRI 在加载前拒绝。`tests/helpers/official-packages.mjs` 的唯一用途是从固定 npm SRI 校验的 `dsh-tool-fs-0.2.1-rc.2.tgz` 在临时目录构造测试运行时，绕开已知修改入口而不改实际安装。它校验 tar 普通成员和入口库存 SHA，复制库存校验的 Cordis/Loader/HMR；公开 Node 同步解析钩子把这些包一致解析到临时实例，其余依赖逐个核对桌面库存。没有下载、私有 npm 凭据、第三方依赖或业务运行时替换机制。官方代码不会写入源码、文档或提交。

已用 bundled Node24 实际验证 15 项通过（8 合成测试、1 官方父测试和 6 官方子场景），无跳过：B=1、换行、阈值上下、中文和非 BMP UTF-8、长行、整读/流读、头尾内容；真实异步 update、veto/异常、启动失败回滚、队列及更新期间取消、原 cap 恢复、恢复核验竞争；其他文件工具保留、原 raw entry 未变化且 Loader 持久写入计数 0；路径拒绝、pre deny、post block 和工具取消仍有效。测试只读合成临时材料，禁止 socket、fetch 和子进程；没有真实 profile 或桌面安装验收。

## 完整 standard 与多轮工具结果（2026-10-21）

本批先实际复现全局 Loader entries 无 tool-fs、预算显示不支持，再通过上述公开目录发现修复。新增 `tests/tool-results-host.test.mjs` 在未删减的官方 standard 预设中执行真实 `Fiber.update(config,true)`：1024 字节映射三个 cap，原始声明对象与内容不变，撤销恢复完整原配置。

同一个真实 AgentLoop 会话跨 3 个 turn 发出 7 次合成模型请求、完成 4 次实际 read。两份含中文与 emoji 的合成材料完整返回；超预算文件只返回可容纳的整行，撤销后同一文件返回全部头尾内容。每个后续请求按非重复 `toolCallId` 与此前 canonical 工具消息逐项深比较，同时验证 assistant 调用一一配对、30 个工具仍在目录中；每轮全部事件经官方 JSONL 读回。撤销本身不改写已有历史。

另注册第二个完整预设，核对两个真实读取条目并存时应用明确拒绝、两份配置均不变；移除该测试拥有的预设后恢复可用。对应 4 个场景及父测试共 5 项，见 [执行证据](evidence/tool-results-acceptance.json)。原子测试另补 5 项目录与所有权边界，原断言继续保留。

本次没有发生上下文压力压缩，不能证明无限上下文或压缩后完整保留。官方分页、上下文压缩和结果剪裁仍由宿主负责，本插件未增加历史删除。模型传输是合成响应，没有真实模型、桌面安装或 profile 读写；当前安装摘要不符的限制也没有被临时干净副本解除。
