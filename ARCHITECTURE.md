# Architecture — DeepSeek Harness VS Code v0.0.1

One page. The goal is the **minimum** code that proves Browser ↔ Harness ↔ VS Code share one Session.

## Layers (high cohesion, low coupling)

```
┌─────────────────────────────────────────────────────────────┐
│ extension.ts        — wiring + UiState machine + actions    │
├─────────────────────────────────────────────────────────────┤
│ view/provider.ts    — webview (vanilla JS, no React)        │
│ session.ts          — SessionModel: event log → render items│
│ workspace.ts        — VS Code folder ↔ Harness workspace    │
├─────────────────────────────────────────────────────────────┤
│ harness/client.ts   — HarnessClient: the ONLY network edge  │
│ harness/events.ts   — MuxStream (WS) + EventBuffer (30ms)   │
│ harness/protocol.ts — wire types (mirror of upstream api/)  │
└─────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` is **types only** — zero runtime, zero dependencies. It mirrors `@deepseek-ai/dsh-host-apiproxy/api` (the authoritative contract in `deepseek-harness/packages/host/apiproxy/src/api/`).
- `harness/client.ts` is the **single** module allowed to call `fetch` or open a WebSocket. Everything above it goes through `HarnessClient`.
- `session.ts` is a pure fold (`SessionEvent[] → RenderItem[]`); it has no network and no VS Code dependency, so it is unit-testable under plain Node.
- `view/provider.ts` is a **pure renderer**: the extension pushes a full `UiState` snapshot, the webview posts back discrete actions. No state lives in the webview.

## Wire contract (validated by `scripts/protocol-spike.ts`)

**Unary RPC** — `POST /api/<method>`, `Content-Type: application/json`:

```jsonc
// request body
{ "type": "client-request", "rpcId": "<uuid>", "method": "session.prompt", "payload": { … } }
// response body
{ "type": "server-response", "rpcId": "<same>", "result": { "ok": true, "value": { … } } }
```

Business errors are always `200` + `{ ok: false, error: { code, message, details } }`. HTTP status expresses only the carrier (`handler.ts` in upstream).

**Event stream** — `GET /api/events.mux` is upgraded to a **WebSocket** (a plain GET returns `426 Upgrade Required`). The socket is **downlink-only**: sending any client message closes it with code `1008 "downlink only"`. Each text frame is one JSON `ServerRequest`:

```jsonc
{ "type": "server-request", "rpcId": "<uuid>", "method": "session/event",
  "payload": { "type": "session/event", "sessionId": "…", "event": { … SessionEvent … } } }
```

**Trust fence** (`api-request-trust.ts` upstream): the `Host` header must be loopback or in `--trusted-host`; an attached `Origin` must match. Our client only ever connects to loopback, so it passes naturally.

## v0.0.1 method allowlist

The client only calls: `host.describe`, `workspace.list`, `workspace.create`, `session.list`, `session.history`, `session.create`, `session.prompt`, `session.cancel`. It never calls `/api/respond`, `settings.*`, `credentials.*`, `commands.*`, or any approval/permission mutation.

## Event fold

`SessionModel.applyEvent` switches on `event.type`:

| Event | Fold |
| --- | --- |
| `user/message` | → `user` item (text extracted from content blocks; optimistic echo reconciled) |
| `assistant/chunk` (`text-delta` / `reasoning-delta`) | accumulate into a streaming `assistant` item at the tail |
| `assistant/message` | finalize the `assistant` item (authoritative — replaces streaming text) |
| `tool/call` | → `tool-call` card |
| `tool/result` | → `tool-result` card (with `isError`) |
| `turn/start` / `turn/end` | → `status` line; sets `running` |
| `session/title` | updates the snapshot title |
| **any other type** | **ignored** (§13 default-ignore; the harness protocol is merge-extensible) |

Replays are idempotent (`seq`-guarded), so reconnect → refetch history is safe.

## Streaming performance (§14)

`EventBuffer` coalesces high-frequency `assistant/chunk` frames and flushes at most every **30 ms**. `turn/end` and `assistant/message` force an immediate flush so the UI settles at once. The webview never re-renders per token.

## Reconnect (§15)

`MuxStream` retries with backoff (250 ms → 5 s). On a `closed → open` transition, `extension.ts` calls `refetchHistory(activeSessionId)` and reloads the model — the documented Harness resume semantic is **rebuild**, not cursor-resume.

## Security boundary (§3)

`HarnessClient.connect()` rejects any host not in `{127.0.0.1, localhost, ::1}` with:

> v0.0.1 only supports local DeepSeek Harness instances.

`approval/requested` and `question/requested` frames surface **only** an information message ("Action requires approval in DeepSeek Harness Web UI") and never call `/api/respond`.

## Directory

```
src/
├── extension.ts          # entry + orchestrator
├── harness/
│   ├── protocol.ts       # wire types (mirror of upstream)
│   ├── client.ts         # HarnessClient — only network edge
│   └── events.ts         # MuxStream (WS) + EventBuffer (30ms)
├── workspace.ts          # VS Code folder → Harness workspace
├── session.ts            # SessionModel fold
└── view/
    └── provider.ts       # webview (vanilla JS)
scripts/
└── protocol-spike.ts     # standalone Node validation (no vscode import)
test/fixtures/            # sanitized protocol captures
```

## KV-cache / stability note

The extension holds no model state of its own across reconnects — every reconnect re-derives from `session.history` (the Harness source of truth). The only long-lived client state is the WebSocket downlink and the in-memory `SessionModel`, both rebuilt from history on resume. This keeps the cache trivially consistent: there is one cache (the Harness session log), and VS Code is a view onto it.
