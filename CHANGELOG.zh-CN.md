# 变更日志

本项目所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.2] — 2026-08-15

版本定位：**对话 UX & 架构基线版。**

这是 main 分支最后一次直推版本。整理主干结构、渲染正确性和交互体验，使 v0.0.3+ 可以全部基于稳定边界通过 feature PR 并行开发，不再产生冲突中心。

### 架构（结构边界收口）

- **新增 `src/app/controller.ts` + `state.ts`** — `AppController` 接管全部编排职责：连接/断开、workspace 生命周期、session 生命周期、prompt/cancel、mux 分发、UiState 推送。`extension.ts` 保持纯 wiring：只有 `activate() / deactivate()`、`readConfig()`、命令注册、依赖装配四件事。
- **新增 `src/conversation/`** — `ConversationModel` 取代平铺的 `SessionModel`。事件不再 1:1 映射 UI 瓦片，而是投影为对话语义的 `ConversationItem[]`（`user`、`assistant`、`system`、`tool`、`status`）。
- **新增 `src/workspace/binding.ts`** — workspace 建立拆为 `findHarnessWorkspace()`（连接时只做探测）与 `ensureHarnessWorkspace()`（首次发送时按需创建）。旧的 `resolveHarnessWorkspace()` 在 connect 流程中急切弹窗创建的机制已被移除。
- **`src/view/` 拆分** — `provider.ts` 仅保留组合逻辑，与 `styles.ts`、`html.ts`、`client.ts`（Webview 侧 JS）、`toolPresentation.ts` 物理分开。刻意不引入 React/Preact/Vite；原生 DOM 再撑一两个版本没问题。

### 交互修正

- **首次 Send 惰性创建 workspace + session。** 用户打开 repo 没有对应 Harness workspace 时，侧边栏仍可操作，并显示"尚未注册 — 第一次发送时会自动创建"的提示条。第一次点击 Send 时，隐式完成 workspace 创建 → session 创建 → prompt 发送，完全不弹确认框。文本框在 optimistic echo 到达 snapshot 后才清空，创建失败时用户输入不会丢失。
- **Tool 调用与结果合并为一张卡片。** `tool/call` 与对应 `tool/result` 以 `callId` 合并为单一 `ToolItem`。侧边栏渲染为一条折叠的标题 `🔧 read src/session.ts → ✓ done`，点击展开 Arguments / Result 两段。彻底消灭"粉色整块 result"的噪声。`toolPresentation.ts` 针对 read / grep / bash / write / edit / git_* 等工具名给出语义化标题。
- **System message 升级为独立 item 类型。** `SystemItem` 不再复用带 `system: true` 标记的 `UserItem`。全链路过滤只看 `item.kind === 'system'`，不再到处出现 `if user && system` 的条件分支。默认 UI 是一条折叠行 `▸ Runtime context · @deepseek-ai/dsh-system-prompt`。
- **Assistant 支持 Markdown 渲染。** `markdown-it`（`html: false`, `linkify: true`）在 **Webview 侧**运行，Extension Host 侧不做渲染，保持 `ConversationModel` 纯语义。用户 / system 消息保持 `textContent` 纯文本。链接自动以 `target=_blank rel=noopener` 打开，`javascript:` / `data:` 开头的被剥离。Tool 结果第一版保留 `<pre>`。
- **Streaming 文本现在一定触发重渲染。** 每次 model 变更都会自增 `renderVersion`。Webview 只以 `snapshot.renderVersion` 作为重建消息列表的唯一签名，修复了旧版只看 `lastSeq` / `items.length` 导致 streaming 内容变化但 UI 不刷新的 bug。

### 测试覆盖

- 集成测试升级到 `ConversationModel`。新增断言：
  - `renderVersion` 在一次 prompt 结束后严格递增（标准 "pong" 用例从 1 → 19）。
  - `ConversationItem` 中不再出现 `tool-call` 或 `tool-result` 两种旧瓦片——它们在 model 层已被合并，类型与运行时双重保证。
  - `systemMessageCount` 单独统计系统消息数量。

### 红线纪律

- **v0.0.2 明确不做**：Diff Review、approval/respond、inline completion、context injection、filesystem provider、terminal integration、LSP/ACP/SDK 抽象、transport 接口。全部从 v0.0.3 起在 feature branch / PR 中逐步引入。

---

## [0.0.1] — 2026-08-15

首次公开发布。此版本只证明**一件事**：VS Code 和浏览器共享同一个 DeepSeek Harness 会话。

```
浏览器 ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘

同一个工作区。同一个会话。同一个 Agent 运行时。
```

### 新增

- **连接**到本地 `dsh web` 实例，通过 `HTTP /api/*` + `WebSocket /api/events.mux`。
  仅限回环的信任围栏（`127.0.0.1` / `localhost` / `::1`）；其他主机会被拒绝并给出明确提示。
- **工作区映射**——按规范路径将当前 VS Code 文件夹匹配到已有的 Harness
  工作区；若不存在则提示创建（不产生第二个工作区 ID）。
- **会话列表**按解析到的工作区过滤，带 `+ 新建会话`。
- **会话历史**从 Harness 加载（唯一真相源——无本地会话数据库，
  无 `.vscode/deepseek-sessions.json`）。
- **纯文本提示**发送到当前会话。
- **实时流式传输** `assistant/chunk` 增量和工具活动，由
  `EventBuffer` 合并，最多每约 30 ms 刷新一次（不逐 token 重渲染）。
- **停止/取消**当前回合。
- **重连**——WebSocket 断开→重连时，重新打开流并重新获取历史
  （Harness 文档化的恢复语义是*重建*，非游标续传）。
- **打开 Web UI** 命令（打开 `http://127.0.0.1:<port>`；会话深链接不做猜测）。
- **显示日志** 命令 → `DeepSeek Harness` 输出通道。
- **侧边栏 webview**（原生 JS，无 React），含连接状态、工作区、
  会话下拉、消息列表、输入框 + 发送/停止。
- **右侧停靠**——"移至右侧边栏"命令（webview 头部的 ⇲ 按钮）将
  视图移至辅助侧边栏，不再与文件浏览器争抢左侧空间。
- **系统消息隐藏**——插件注入的 `user/message` 帧（如
  `@deepseek-ai/dsh-system-prompt` 运行时上下文、`user-approval` 通知）
  通过 `source.kind !== 'user'` 检测，默认隐藏。头部 `SYS`
  按钮可显示它们；`deepseekHarness.showSystemMessages` 设置控制默认值。
- **品牌图标**——生成的 128×128 PNG（`media/icon.png`）作为
  Marketplace 图标和 webview 头部 Logo；SVG 活动栏图标使用
  `currentColor` 适配主题。通过 `npm run gen-icon` 重新生成。
- **协议固件**（`test/fixtures/`）——线缆格式的脱敏快照，
  用于检测上游协议漂移。
- **协议探测**（`scripts/protocol-spike.ts`）和**集成测试**
  （`scripts/integration-test.ts`）——独立的 Node 验证脚本，在运行的
  `dsh web` 上测试完整闭环。

### 安全

- 方法白名单：仅 `host.describe`、`workspace.{list,create}`、
  `session.{list,history,create,prompt,cancel}`。
- 绝不调用 `/api/respond`、`settings.*`、`credentials.*`、`commands.*` 或任何
  审批/权限变更操作。
- `approval/requested` 和 `question/requested` 帧**仅**显示一条
  信息消息（"该操作需要在 DeepSeek Harness Web UI 中审批"），
  绝不代用户响应。

### 已验证版本

- DeepSeek Harness host `v0.0.1`（`@deepseek-ai/dsh-root`），默认 `dsh web`
  端口 `3080`。
- 线缆契约来源：`packages/host/apiproxy/src/api/`（权威）。
- 集成测试：11/11 检查通过（针对运行中的本地 `dsh web`）。

### 限制

- 仅限回环——不支持远程 / 局域网 / WSL 桥接的主机。
- 仅支持文本提示（不支持图片附件）。
- 历史记录加载最近约 50 条消息；"加载更早"已推迟。
- "Open Web UI" 中的会话深链接不做猜测。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；
  不会导致客户端崩溃，但也不会渲染。

[0.0.1]: https://github.com/liangwythu/deepseek-harness-vscode/releases/tag/v0.0.1
