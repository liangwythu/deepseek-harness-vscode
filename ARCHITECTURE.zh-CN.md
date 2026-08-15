# 架构说明 — DeepSeek Harness VS Code v0.0.1

一页纸。目标是**最小**代码量，证明浏览器 ↔ Harness ↔ VS Code 共享同一个 Session。

## 分层（高内聚，低耦合）

```
┌─────────────────────────────────────────────────────────────┐
│ extension.ts        — 接线 + UiState 状态机 + 动作分发      │
├─────────────────────────────────────────────────────────────┤
│ view/provider.ts    — webview（原生 JS，无 React）          │
│ session.ts          — SessionModel: 事件日志 → 渲染项       │
│ workspace.ts        — VS Code 文件夹 ↔ Harness 工作区       │
├─────────────────────────────────────────────────────────────┤
│ harness/client.ts   — HarnessClient: 唯一的网络边界         │
│ harness/events.ts   — MuxStream (WS) + EventBuffer (30ms)   │
│ harness/protocol.ts — 线缆类型（镜像上游 api/）             │
└─────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` **只有类型**——零运行时、零依赖。它镜像 `@deepseek-ai/dsh-host-apiproxy/api`（权威契约位于 `deepseek-harness/packages/host/apiproxy/src/api/`）。
- `harness/client.ts` 是**唯一**允许调用 `fetch` 或打开 WebSocket 的模块。其上层所有代码都通过 `HarnessClient` 访问网络。
- `session.ts` 是纯折叠函数（`SessionEvent[] → RenderItem[]`）；无网络、无 VS Code 依赖，可在纯 Node 环境下单测。
- `view/provider.ts` 是**纯渲染器**：扩展推送完整的 `UiState` 快照，webview 回传离散动作。webview 内不持有任何状态。

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

## v0.0.1 方法白名单

客户端只调用：`host.describe`、`workspace.list`、`workspace.create`、`session.list`、`session.history`、`session.create`、`session.prompt`、`session.cancel`。绝不调用 `/api/respond`、`settings.*`、`credentials.*`、`commands.*` 或任何审批/权限变更操作。

## 事件折叠

`SessionModel.applyEvent` 按 `event.type` 分发：

| 事件 | 折叠 |
| --- | --- |
| `user/message` | → `user` 项（从 content blocks 提取文本；乐观回声已对账） |
| `assistant/chunk`（`text-delta` / `reasoning-delta`） | 累积到尾部的流式 `assistant` 项 |
| `assistant/message` | 定稿 `assistant` 项（权威——替换流式文本） |
| `tool/call` | → `tool-call` 卡片 |
| `tool/result` | → `tool-result` 卡片（带 `isError`） |
| `turn/start` / `turn/end` | → `status` 行；设置 `running` |
| `session/title` | 更新快照标题 |
| **任何其他类型** | **忽略**（§13 默认忽略；harness 协议是可合并扩展的） |

重放是幂等的（`seq` 守卫），所以断线重连 → 重新获取历史是安全的。

## 流式性能（§14）

`EventBuffer` 合并高频 `assistant/chunk` 帧，最多每 **30 ms** 刷新一次。`turn/end` 和 `assistant/message` 强制立即刷新，使 UI 即时定稿。webview 绝不按 token 逐次重渲染。

## 重连（§15）

`MuxStream` 以退避策略重试（250 ms → 5 s）。在 `closed → open` 转换时，`extension.ts` 调用 `refetchHistory(activeSessionId)` 并重建模型——Harness 文档化的恢复语义是**重建**，不是游标续传。

## 安全边界（§3）

`HarnessClient.connect()` 拒绝任何不在 `{127.0.0.1, localhost, ::1}` 中的主机，提示：

> v0.0.1 only supports local DeepSeek Harness instances.

`approval/requested` 和 `question/requested` 帧**仅**显示一条信息消息（"该操作需要在 DeepSeek Harness Web UI 中审批"），绝不调用 `/api/respond`。

## 目录结构

```
src/
├── extension.ts          # 入口 + 协调器
├── harness/
│   ├── protocol.ts       # 线缆类型（镜像上游）
│   ├── client.ts         # HarnessClient — 唯一网络边界
│   └── events.ts         # MuxStream (WS) + EventBuffer (30ms)
├── workspace.ts          # VS Code 文件夹 → Harness 工作区
├── session.ts            # SessionModel 折叠
└── view/
    └── provider.ts       # webview（原生 JS）
scripts/
└── protocol-spike.ts     # 独立 Node 验证（不导入 vscode）
test/fixtures/            # 脱敏协议快照
```

## KV-cache / 稳定性说明

扩展自身不跨重连持有任何模型状态——每次重连都从 `session.history`（Harness 真相源）重新派生。唯一的长期客户端状态是 WebSocket 下行链路和内存中的 `SessionModel`，二者在恢复时都从历史记录重建。这使得缓存一致性不言自明：只有一个缓存（Harness 会话日志），VS Code 只是它的一个视图。
