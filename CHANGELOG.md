# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] — 2026-08-15

The first public release. This version proves **one** thing: VS Code and the
browser share the same DeepSeek Harness session.

```
Browser ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘

Same Workspace. Same Session. Same Agent Runtime.
```

### Added

- **Connect** to a local `dsh web` instance via `HTTP /api/*` + `WebSocket /api/events.mux`.
  Loopback-only trust fence (`127.0.0.1` / `localhost` / `::1`); any other host
  is refused with a clear message.
- **Workspace mapping** — match the active VS Code folder to an existing Harness
  workspace by canonical path; offer to create one if absent (no second workspace ID).
- **Session list** filtered by the resolved workspace, with `+ New Session`.
- **Session history** loaded from the Harness (the single source of truth — no
  local session DB, no `.vscode/deepseek-sessions.json`).
- **Plain-text prompt** sent to the active session.
- **Live streaming** of `assistant/chunk` deltas and tool activity, coalesced by
  an `EventBuffer` that flushes at most every ~30 ms (no per-token re-render).
- **Stop / cancel** the active turn.
- **Reconnect** — on WebSocket close→open, the stream reopens and history is
  refetched (the documented Harness resume semantic is *rebuild*, not cursor-resume).
- **Open Web UI** command (opens `http://127.0.0.1:<port>`; session deep-links are
  intentionally not guessed).
- **Show Logs** command → the `DeepSeek Harness` output channel.
- **Sidebar webview** (vanilla JS, no React) with connection status, workspace,
  session dropdown, message list, input + Send/Stop.
- **Right-side docking** — a "Move to Right Side Bar" command (⇲ button in the
  webview header) relocates the view to the secondary side bar so it no longer
  competes with the file explorer.
- **System-message hiding** — plugin-injected `user/message` frames (e.g.
  `@deepseek-ai/dsh-system-prompt` runtime context, `user-approval` notices)
  are detected via `source.kind !== 'user'` and hidden by default. A `SYS`
  toggle in the header reveals them; the `deepseekHarness.showSystemMessages`
  setting controls the default.
- **Brand icon** — a generated 128×128 PNG (`media/icon.png`) serves as the
  Marketplace icon and the webview header logo; the SVG activity-bar icon uses
  `currentColor` to adapt to the theme. Regenerate with `npm run gen-icon`.
- **Protocol fixtures** (`test/fixtures/`) — sanitized captures of the live wire
  format for detecting upstream protocol drift.
- **Protocol spike** (`scripts/protocol-spike.ts`) and **integration test**
  (`scripts/integration-test.ts`) — standalone Node validation of the full loop
  against a running `dsh web`.

### Security

- Method allowlist: only `host.describe`, `workspace.{list,create}`,
  `session.{list,history,create,prompt,cancel}`.
- Never calls `/api/respond`, `settings.*`, `credentials.*`, `commands.*`, or any
  approval / permission mutation.
- `approval/requested` and `question/requested` frames surface **only** an
  information message ("Action requires approval in DeepSeek Harness Web UI") and
  never respond on the user's behalf.

### Verified against

- DeepSeek Harness host `v0.0.1` (`@deepseek-ai/dsh-root`), default `dsh web`
  port `3080`.
- Wire contract source: `packages/host/apiproxy/src/api/` (authoritative).
- Integration test: 11/11 checks pass against a live local `dsh web`.

### Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- Text prompts only (no image attachments).
- History loads the last ~50 messages; "load older" is deferred.
- Session deep-links in "Open Web UI" are intentionally not guessed.
- Unknown harness event types are ignored (the protocol is merge-extensible);
  they do not crash the client but also do not render.

[0.0.1]: https://github.com/deepseek-harness-community/deepseek-harness-vscode/releases/tag/v0.0.1
