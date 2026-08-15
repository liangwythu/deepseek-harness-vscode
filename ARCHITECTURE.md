# Architecture — DeepSeek Harness VS Code v0.0.2

One page. Three stable boundaries: **wiring** (`extension.ts`), **orchestration** (`AppController`), **semantics** (`ConversationModel`). Future feature PRs extend outward from these boundaries, not inward.

## Layers (high cohesion, low coupling)

```
┌──────────────────────────────────────────────────────────────────┐
│ extension.ts              — wiring ONLY (activate, commands, cfg)│
├──────────────────────────────────────────────────────────────────┤
│ app/controller.ts         — AppController: connect/ws/session/   │
│ app/state.ts              — UiState shape + pure mapping helpers │
├──────────────────────────────────────────────────────────────────┤
│ conversation/model.ts     — ConversationModel: event → conv item │
│ conversation/types.ts     — ConversationItem union (5 kinds)     │
│ workspace/binding.ts      — findHarnessWorkspace / ensureHarness │
├──────────────────────────────────────────────────────────────────┤
│ view/provider.ts          — webview composition (HTML + CSP)     │
│ view/styles.ts            — CSS                                 │
│ view/html.ts              — HTML skeleton                       │
│ view/client.ts            — webview-side JS (render + markdown)  │
│ view/toolPresentation.ts  — tool name → human title             │
├──────────────────────────────────────────────────────────────────┤
│ harness/client.ts         — HarnessClient: the ONLY network edge │
│ harness/events.ts         — MuxStream (WS) + EventBuffer (30ms)  │
│ harness/protocol.ts       — wire types (mirror of upstream api/) │
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` is **types only** — zero runtime, zero dependencies. It mirrors `@deepseek-ai/dsh-host-apiproxy/api` (the authoritative contract in `deepseek-harness/packages/host/apiproxy/src/api/`).
- `harness/client.ts` is the **single** module allowed to call `fetch` or open a WebSocket. Everything above it goes through `HarnessClient`.
- `conversation/model.ts` is a pure fold (`SessionEvent[] → ConversationItem[]`); it has no network and no VS Code dependency, so it is unit-testable under plain Node.
- `app/controller.ts` owns all orchestration (connect/disconnect, workspace lifecycle, session lifecycle, prompt/cancel, mux dispatch, UiState push). `extension.ts` is pure wiring.
- `view/provider.ts` is a **pure composition layer**: it assembles HTML from `styles.ts` + `html.ts` + `client.ts` + markdown-it UMD, and bridges state/actions. No state lives in the provider.

## ConversationItem projection (v0.0.2 upgrade)

The old `SessionModel` mapped events 1:1 to render tiles (`tool-call` → one card, `tool/result` → another card). v0.0.2 replaces this with a **conversation-semantic projection**:

```ts
type ConversationItem =
  | UserMessageItem      // kind: 'user'
  | AssistantMessageItem // kind: 'assistant' (streaming flag, usage, reasoning)
  | SystemItem           // kind: 'system' (own type, not UserItem + flag)
  | ToolItem             // kind: 'tool' (call + result MERGED by callId)
  | StatusItem           // kind: 'status' (turn start/end)
```

Key changes:
- **Tool call + result merged**: `tool/call` creates a `ToolItem`; `tool/result` updates the **same** `ToolItem` by `callId` (state → `completed`/`error`). No more separate result tiles.
- **SystemItem is its own kind**: no `UserItem { system: true }` flag. Filtering is `item.kind === 'system'`, not `user && system`.
- **`renderVersion`**: monotonically increments on EVERY model mutation (including streaming text deltas). The webview uses this as the sole change-detection signature — fixes the "streaming text changed but same seq → no re-render" bug.

### Event fold

`ConversationModel.applyEvent` switches on `event.type`:

| Event | Fold |
| --- | --- |
| `user/message` | → `user` or `system` item (system if `source.kind !== 'user'`); optimistic echo reconciled |
| `assistant/chunk` (`text-delta` / `reasoning-delta`) | accumulate into streaming `assistant` item at tail |
| `assistant/message` | finalize the `assistant` item (authoritative — replaces streaming text) |
| `tool/call` | → create `ToolItem` (state: `running`) |
| `tool/result` | → **update** existing `ToolItem` by `callId` (state: `completed`/`error`) |
| `turn/start` / `turn/end` | → `status` line; sets `running` |
| `session/title` | updates the snapshot title |
| **any other type** | **ignored** (the harness protocol is merge-extensible) |

Replays are idempotent (`seq`-guarded), so reconnect → refetch history is safe.

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

## Method allowlist

The client only calls: `host.describe`, `workspace.list`, `workspace.create`, `session.list`, `session.history`, `session.create`, `session.prompt`, `session.cancel`. It never calls `/api/respond`, `settings.*`, `credentials.*`, `commands.*`, or any approval/permission mutation.

## Workspace lifecycle (v0.0.2: lazy create)

```
connect
  ↓
pickVsCodeFolder()              — resolve the active VS Code folder
  ↓
findHarnessWorkspace()          — read-only: match folder ↔ harness workspace
  ↓
found?  → load sessions, select first non-blank
not found? → binding stays pending, UI shows "Not registered yet"
                ↓
          user sends first prompt
                ↓
          ensureHarnessWorkspace() — create-on-demand (no modal)
                ↓
          createSession() → selectSession() → prompt()
```

No confirmation modals. The workspace is a **send-time lazily ensured resource**, not a connect-time resource.

## Markdown rendering

`markdown-it` (`html: false`, `linkify: true`, `breaks: false`) runs **inside the webview** — not in the extension host. This keeps `ConversationModel` semantic-only (it sends raw markdown text; the webview does presentation).

- Assistant messages: `body.innerHTML = md.render(item.text)`
- User / System messages: `body.textContent = item.text` (no markdown)
- Tool results: `<pre>` (no markdown)
- Links: `target=_blank rel=noopener`; `javascript:` / `data:` URLs stripped
- `markdown-it.umd.min.js` is bundled in `media/` for VSIX packaging

## Streaming performance

`EventBuffer` coalesces high-frequency `assistant/chunk` frames and flushes at most every **30 ms**. `turn/end` and `assistant/message` force an immediate flush so the UI settles at once. The webview re-renders on `renderVersion` change only — never per token.

## Reconnect

`MuxStream` retries with backoff (250 ms → 5 s). On a `closed → open` transition, `AppController` calls `refetchHistory(activeSessionId)` and reloads the model — the documented Harness resume semantic is **rebuild**, not cursor-resume.

## Security boundary

`HarnessClient.connect()` rejects any host not in `{127.0.0.1, localhost, ::1}` with:

> v0.0.x only supports local DeepSeek Harness instances.

`approval/requested` and `question/requested` frames surface **only** an information message ("Action requires approval in DeepSeek Harness Web UI") and never call `/api/respond`.

## Directory

```
src/
├── extension.ts              # wiring ONLY (activate, commands, config)
├── disposable.ts             # CompositeDisposable helper
├── app/
│   ├── controller.ts         # AppController — orchestration
│   └── state.ts              # UiState shape + mapping helpers
├── conversation/
│   ├── model.ts              # ConversationModel fold
│   └── types.ts              # ConversationItem union (5 kinds)
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── harness/
│   ├── protocol.ts           # wire types (mirror of upstream)
│   ├── client.ts             # HarnessClient — only network edge
│   └── events.ts             # MuxStream (WS) + EventBuffer (30ms)
└── view/
    ├── provider.ts           # webview composition (HTML + CSP + state bridge)
    ├── styles.ts             # CSS
    ├── html.ts               # HTML skeleton
    ├── client.ts             # webview-side JS (render + markdown + actions)
    └── toolPresentation.ts   # tool name → human title
media/
├── icon.png                  # Marketplace + webview brand icon
├── icon.svg                  # Activity Bar icon (currentColor)
├── origin.png                # source material (excluded from VSIX)
└── markdown-it.umd.min.js    # bundled for VSIX (114 KB)
scripts/
├── protocol-spike.ts         # standalone Node validation (no vscode import)
├── integration-test.ts        # closed-loop test against real dsh
└── gen-icon.ts               # icon generation from origin.png
test/fixtures/                # sanitized protocol captures
```

## KV-cache / stability note

The extension holds no model state of its own across reconnects — every reconnect re-derives from `session.history` (the Harness source of truth). The only long-lived client state is the WebSocket downlink and the in-memory `ConversationModel`, both rebuilt from history on resume. This keeps the cache trivially consistent: there is one cache (the Harness session log), and VS Code is a view onto it.
