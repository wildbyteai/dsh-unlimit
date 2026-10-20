# 工作区规则候选、选择与只读预览

对应 `RULE-DISCOVER` / `RULE-SELECT`。本合同描述独立 core / web 的文件浏览和选择，不把规则正文作为代码执行。宿主原生指令的运行策略由另一适配器处理，见 [原生规则合同](native-instructions-contract.md)。

## Core 导出与路径边界

`src/core/workspace-rules.js` 导出：

```js
workspaceInstructions(directory); // 数组，保留原有 path / name / bytes 字段
readWorkspaceRule({ directory, path }); // 单个完整正文与元数据
MAX_WORKSPACE_RULE_BYTES; // 256 * 1024
```

目录必须由调用方明确提供为绝对路径；不默认使用进程 cwd。目录先 realpath 规范化，然后枚举该目录到文件系统根的祖先链，每层仅识别 `AGENTS.md` / `CLAUDE.md`。返回按祖先从远到近排序，同层 AGENTS 在 CLAUDE 前。

扫描项：

```js
{
  path, name, bytes,              // 候选绝对路径、文件名、原始字节数；无法确定时 bytes:null
  directory, workspaceDirectory, // 当前候选所在目录、用户目录的 canonical 路径
  depth, level,                  // depth: 距用户目录的父级距离；level: 从根开始的层级索引
  readable,
  resolvedPath?, linked?, sha256?,
  error?: {code, message}
}
```

正常不存在的规则不产生候选；已经存在但不可预览的文件保留 `readable:false` 及错误，不能默默省略或默认勾选。目录本身失效 / 不可访问则扫描整体报错，不返回假空列表。扫描会有界读取候选以核对 UTF-8 与摘要，但不把正文放入扫描列表响应。

预览每次重新核对当前目录的祖先链，只接受该链中支持文件的候选路径。`path` 的父目录先 realpath 规范化，支持 macOS `/var`、`/tmp` 及用户明确的目录别名；不会先解析文件链接从而绕过候选名称检查。不接受其他名字、子目录、兄弟项目或任意本机路径。成功返回：

```js
const item = {
  path,
  name,
  bytes,
  directory,
  workspaceDirectory,
  depth,
  level,
  resolvedPath,
  linked,
  sha256,
  content,
};
```

扫描和预览的 path 一致。对于符号链接，候选 path 保持原本祖先目录下的固定名字，resolvedPath 另行展示；仅当其最终目标也是同一祖先链中的支持文件才允许读取。跨链、错误名字的链接目标、循环链接均拒绝；断链明确报告失效。用户目录本身若为链接，按其明确指向的 canonical 目录建立祖先链，不混合另一套 lexical 祖先。

读取通过 final-component `O_NOFOLLOW` / `O_NONBLOCK` 打开，核对普通文件、inode / device、解析路径及读取前后大小 / 时间。有界读取至 256 KiB + 1，避免文件增长绕过大小判断。发生链接替换或文件变化时拒绝并要求重扫。它不是跨平台文件锁或任意恶意并发修改下的内容快照保证。

正文用严格 UTF-8 解码；保留 BOM、CRLF、空白、末尾换行与空文件，不 trim。SHA256 和 bytes 对应原字节。256 KiB 正好可读，超出拒绝。无效 UTF-8 不按替换字符冒充正文。

主要错误：`INVALID_DIRECTORY`、`INVALID_RULE_PATH`、`RULE_OUTSIDE_CHAIN`、`RULE_LINK_ESCAPE`、`RULE_NOT_FOUND`、`RULE_NOT_FILE`、`RULE_TOO_LARGE`、`RULE_INVALID_UTF8`、`RULE_CHANGED`、`RULE_UNREADABLE`。

## Web 模块接线

`web/workspace-rules.js` 不依赖框架，导出：

```js
renderWorkspaceRules({items, selectedPaths = [], esc?}) // 返回已转义表格 HTML
openWorkspaceRules({api, esc?, directory, selectedPaths = [], onSelect, document?})
// 同步返回 {dialog, dispose, refresh}，内部启动只读扫描
```

Controller 已接入的 API：

- `api('rules.workspace', {directory}) → {items}`
- `api('rules.preview', {directory,path}) → {item}`
- `api('rules.select', {revision,paths}) → {revision,value}`
- `api('rules.policy', {revision,policy}) → {revision,value}`

后两个动作必须提供页面读取到的设置修订；缺失或过期会拒绝，不从服务端偷偷取得最新修订覆盖其他窗口的保存。浏览器明确确认后持久化路径，取消不修改设置。

模块自建 dialog，展示目录层级、名称、大小、路径、链接目标和诊断；不可读行 checkbox / 预览按钮禁用。正文经 textContent 写入只读 pre，不渲染 HTML、不执行规则，不存浏览器持久数据。

确认时仅传递当前候选中 `readable:true` 且勾选的 path，按表格顺序调用 `await onSelect(paths)`；成功后才关闭。回调失败则保留弹窗、勾选项与明确错误。`onSelect` 决定填回表单还是调用设置 API，本模块不自行写设置。

取消 / Escape / 关闭不调用 onSelect；扫描或预览迟到结果不更新已关闭弹窗。保存回调进行时暂禁取消，避免“取消”误表示已撤销正在提交的修改。清空选择后仍需确认；成功空扫描允许确认空数组，扫描失败禁用确认。扫描、预览和保存有加载状态及重复点击抑制。

初始 selectedPaths 中若含当前不可读或跨目录路径，弹窗明确列出，并说明确认只保留当前勾选项；取消保留原设置。没有默默把另一工作区的路径混入本次选择。

## 集成边界

prompts.js 重导出新扫描函数。**扫描数组含诊断项，不能直接把每项 path 都纳入 selectedInstructions 的允许集合。** 选定正文逐项调用 `readWorkspaceRule({directory,path})`；注入仍按既有合同 trim、跳过空文件、按选择顺序合并，并限制组合为 512 KiB。fallback 有有效规则或保存正文时不读取未被采用的文件；仅空白正文不阻止兜底。

本轮不改变全局 workspaceFiles 与各会话 cwd 的作用域语义：选定路径若不属于当前会话目录祖先链，仍应明确拒绝，不能通过另一个工作区目录偷偷读取。候选发现不授予任意本机文件访问能力。

## 检查

```sh
'/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node' \
--test tests/workspace-rules.test.mjs
```

专项结果：9 tests / 9 pass / 0 fail。覆盖祖先排序 / 元数据、完整 UTF-8 字节 / hash、空文件与空扫描、失效、256 KiB 边界、无效编码、目录、越界和跨工作区路径、合法 / 逃逸 / 断开 / 循环链接、目录别名、扫描后替换、读取拒绝 / 读取中增长及 HTML 转义 / 禁选渲染。

测试只创建临时原创规则；专项对临时根外的 AGENTS / CLAUDE stat 作合成不存在处理，并禁止打开临时根外正文，未读取真实用户规则、profile、真实会话，没有模型请求。根集成检查见 `tests/rules-controller.test.mjs`：扫描与预览不持久化，明确选择及清空可读回，旧修订拒绝覆盖，跨区路径拒绝，组合阈值上下均有断言。

1280×720 浏览器已实际验证三项父子候选、超限项禁选、全文及摘要、勾选后取消保持 revision 0、确认保存两项至 revision 1、再次打开读回勾选。通过本地 API 模拟另一个窗口保存到 revision 2 后，旧弹窗清空提交得到 CONFLICT，保留弹窗与未保存选择，后台原路径未变；刷新修订后确认清空到 revision 3。控制台 warning/error 为空。截图见 [workspace-rules-preview.png](workspace-rules-preview.png)。临时页面、服务和合成文件已清理；官方桌面嵌入与键盘完整流程仍未验。
