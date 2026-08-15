# 架构说明 — DeepSeek Harness VS Code v0.0.2

一页纸。三个稳定边界：**接线**（`extension.ts`）、**编排**（`AppController`）、**语义**（`ConversationModel`）。后续 feature PR 从这些边界向外扩展，而非向内侵入。

## 分层（高内聚，低耦合）

```
┌──────────────────────────────────────────────────────────────────┐
│ extension.ts              — 纯接线（activate、命令、配置）       │
├──────────────────────────────────────────────────────────────────┤
│ app/controller.ts         — AppController: 连接/ws/session/       │
│ app/state.ts              — UiState 形状 + 纯映射辅助函数         │
├──────────────────────────────────────────────────────────────────┤
│ conversation/model.ts     — ConversationModel: 事件 → 对话项     │
│ conversation/types.ts     — ConversationItem 联合类型（5 种）    │
│ workspace/binding.ts      — findHarnessWorkspace / ensureHarness │
├──────────────────────────────────────────────────────────────────┤
│ view/provider.ts          — webview 组合（HTML + CSP）           │
│ view/styles.ts            — CSS                                 │
│ view/html.ts              — HTML 骨架                           │
│ view/client.ts            — webview 侧 JS（渲染 + markdown）     │
│ view/toolPresentation.ts  — 工具名 → 人类可读标题               │
├──────────────────────────────────────────────────────────────────┤
│ harness/client.ts         — HarnessClient: 唯一的网络边界        │
│ harness/events.ts         — MuxStream (WS) + EventBuffer (30ms)  │
│ harness/protocol.ts       — 线缆类型（镜像上游 api/）            │
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` **只有类型**——零运行时、零依赖。它镜像 `@deepseek-ai/dsh-host-apiproxy/api`（权威契约位于 `deepseek-harness/packages/host/apiproxy/src/api/`）。
- `harness/client.ts` 是**唯一**允许调用 `fetch` 或打开 WebSocket 的模块。其上层所有代码都通过 `HarnessClient` 访问网络。
- `conversation/model.ts` 是纯折叠函数（`SessionEvent[] → ConversationItem[]`）；无网络、无 VS Code 依赖，可在纯 Node 环境下单测。
- `app/controller.ts` 接管全部编排（连接/断开、workspace 生命周期、session 生命周期、prompt/cancel、mux 分发、UiState 推送）。`extension.ts` 是纯接线。
- `view/provider.ts` 是**纯组合层**：从 `styles.ts` + `html.ts` + `client.ts` + markdown-it UMD 组装 HTML，并桥接状态/动作。provider 内不持有状态。

## ConversationItem 投影（v0.0.2 升级）

旧的 `SessionModel` 将事件 1:1 映射为渲染瓦片（`tool-call` → 一张卡片，`tool/result` → 另一张卡片）。v0.0.2 用**对话语义投影**取代：

```ts
type ConversationItem =
  | UserMessageItem      // kind: 'user'
  | AssistantMessageItem // kind: 'assistant'（streaming 标记、usage、reasoning）
  | SystemItem           // kind: 'system'（独立类型，不是 UserItem + 标记）
  | ToolItem             // kind: 'tool'（call + result 按 callId 合并）
  | StatusItem           // kind: 'status'（turn start/end）
```

关键变化：
- **Tool call + result 合并**：`tool/call` 创建 `ToolItem`；`tool/result` 按 `callId` **更新同一个** `ToolItem`（state → `completed`/`error`）。不再有独立的 result 瓦片。
- **SystemItem 是独立类型**：没有 `UserItem { system: true }` 标记。过滤条件是 `item.kind === 'system'`，不是 `user && system`。
- **`renderVersion`**：在每次模型变更时单调递增（包括流式文本增量）。webview 以此作为唯一的变更检测签名——修复了"流式文本变了但 seq 不变 → 不重渲染"的 bug。

### 事件折叠

`ConversationModel.applyEvent` 按 `event.type` 分发：

| 事件 | 折叠 |
| --- | --- |
| `user/message` | → `user` 或 `system` 项（`source.kind !== 'user'` 时为 system）；乐观回声已对账 |
| `assistant/chunk`（`text-delta` / `reasoning-delta`） | 累积到尾部的流式 `assistant` 项 |
| `assistant/message` | 定稿 `assistant` 项（权威——替换流式文本） |
| `tool/call` | → 创建 `ToolItem`（state: `running`） |
| `tool/result` | → **更新**已有 `ToolItem`（按 `callId`，state: `completed`/`error`） |
| `turn/start` / `turn/end` | → `status` 行；设置 `running` |
| `session/title` | 更新快照标题 |
| **任何其他类型** | **忽略**（harness 协议是可合并扩展的） |

重放是幂等的（`seq` 守卫），所以断线重连 → 重新获取历史是安全的。

## 线缆契约（由 `scripts/protocol-spike.ts` 验证）

**一元 RPC** — `POST /api/<method>`，`Content-Type: application/json`：

```jsonc
// 请求体
{ "type": "client-request", "rpcId": "<uuid>", "method": "session.prompt", "payload": { … } }
// 响应体
{ "type": "server-response", "rpcId": "<相同>", "result": { "ok": true, "value": { … } } }
```

业务错误始终返回 `200` + `{ ok: false, error: { code, message, details } }`。HTTP 状态码仅表示传输层（上游 `handler.ts`）。

**事件流** — `GET /api/events.mux` 会被升级为 **WebSocket**（普通 GET 返回 `426 Upgrade Required`）。该 socket 是**仅下行**的：发送任何客户端消息都会以 `1008 "downlink only"` 关闭连接。每个文本帧是一个 JSON `ServerRequest`：

```jsonc
{ "type": "server-request", "rpcId": "<uuid>", "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "…", "event": { … SessionEvent … } } }
```

**信任围栏**（上游 `api-request-trust.ts`）：`Host` 头必须是回环地址或在 `--trusted-host` 中；附带的 `Origin` 必须匹配。我们的客户端只连接回环地址，因此天然通过。

## 方法白名单

客户端只调用：`host.describe`、`workspace.list`、`workspace.create`、`session.list`、`session.history`、`session.create`、`session.prompt`、`session.cancel`。绝不调用 `/api/respond`、`settings.*`、`credentials.*`、`commands.*` 或任何审批/权限变更操作。

## Workspace 生命周期（v0.0.2：惰性创建）

```
连接
  ↓
pickVsCodeFolder()              — 解析当前 VS Code 文件夹
  ↓
findHarnessWorkspace()          — 只读：匹配文件夹 ↔ harness workspace
  ↓
找到?  → 加载 sessions，选择第一个非空
没找到? → binding 保持 pending，UI 显示"尚未注册"
                ↓
          用户发送第一条提示
                ↓
          ensureHarnessWorkspace() — 按需创建（无弹窗）
                ↓
          createSession() → selectSession() → prompt()
```

无确认弹窗。workspace 是**发送时按需确保的资源**，不是连接时的资源。

## Markdown 渲染

`markdown-it`（`html: false`、`linkify: true`、`breaks: false`）在 **webview 侧**运行——不在 extension host 中。这保持 `ConversationModel` 纯语义（发送原始 markdown 文本；webview 负责展示）。

- Assistant 消息：`body.innerHTML = md.render(item.text)`
- User / System 消息：`body.textContent = item.text`（无 markdown）
- Tool 结果：`<pre>`（无 markdown）
- 链接：`target=_blank rel=noopener`；`javascript:` / `data:` URL 被剥离
- `markdown-it.umd.min.js` 打包在 `media/` 目录中供 VSIX 使用

## 流式性能

`EventBuffer` 合并高频 `assistant/chunk` 帧，最多每 **30 ms** 刷新一次。`turn/end` 和 `assistant/message` 强制立即刷新，使 UI 即时定稿。webview 仅在 `renderVersion` 变化时重渲染——绝不按 token 逐次重渲染。

## 重连

`MuxStream` 以退避策略重试（250 ms → 5 s）。在 `closed → open` 转换时，`AppController` 调用 `refetchHistory(activeSessionId)` 并重建模型——Harness 文档化的恢复语义是**重建**，不是游标续传。

## 安全边界

`HarnessClient.connect()` 拒绝任何不在 `{127.0.0.1, localhost, ::1}` 中的主机，提示：

> v0.0.x only supports local DeepSeek Harness instances.

`approval/requested` 和 `question/requested` 帧**仅**显示一条信息消息（"该操作需要在 DeepSeek Harness Web UI 中审批"），绝不调用 `/api/respond`。

## 目录结构

```
src/
├── extension.ts              # 纯接线（activate、命令、配置）
├── disposable.ts             # CompositeDisposable 辅助
├── app/
│   ├── controller.ts         # AppController — 编排
│   └── state.ts              # UiState 形状 + 映射辅助
├── conversation/
│   ├── model.ts              # ConversationModel 折叠
│   └── types.ts              # ConversationItem 联合类型（5 种）
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── harness/
│   ├── protocol.ts           # 线缆类型（镜像上游）
│   ├── client.ts             # HarnessClient — 唯一网络边界
│   └── events.ts             # MuxStream (WS) + EventBuffer (30ms)
└── view/
    ├── provider.ts           # webview 组合（HTML + CSP + 状态桥接）
    ├── styles.ts             # CSS
    ├── html.ts               # HTML 骨架
    ├── client.ts             # webview 侧 JS（渲染 + markdown + 动作）
    └── toolPresentation.ts   # 工具名 → 人类可读标题
media/
├── icon.png                  # Marketplace + webview 品牌图标
├── icon.svg                  # 活动栏图标（currentColor）
├── origin.png                # 源材料（VSIX 排除）
└── markdown-it.umd.min.js    # VSIX 打包用（114 KB）
scripts/
├── protocol-spike.ts         # 独立 Node 验证（不导入 vscode）
├── integration-test.ts        # 针对 real dsh 的闭环测试
└── gen-icon.ts               # 从 origin.png 生成图标
test/fixtures/                # 脱敏协议快照
```

## KV-cache / 稳定性说明

扩展自身不跨重连持有任何模型状态——每次重连都从 `session.history`（Harness 真相源）重新派生。唯一的长期客户端状态是 WebSocket 下行链路和内存中的 `ConversationModel`，二者在恢复时都从历史记录重建。这使得缓存一致性不言自明：只有一个缓存（Harness 会话日志），VS Code 只是它的一个视图。
