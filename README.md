# DeepSeek Harness Connector for VS Code (v0.0.1)

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)

> Native VS Code client for DeepSeek Harness.
>
> Connect to your existing local Harness instance and continue the same workspaces and sessions directly inside VS Code.

**Same Harness. Same Workspace. Same Session. VS Code Client.**

This is **not** a Cursor replacement, a Claude Code replacement, or a full coding agent. v0.0.1 only proves one thing:

```
Browser ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘
```

VS Code connects to your already-running local `dsh web` instance, reads the workspaces and sessions the browser already has, and continues the **same** session — so a browser refresh of that session sees exactly what VS Code sent.

## What v0.0.1 does

- Connect to a **local** `dsh web` (loopback only — `127.0.0.1` / `localhost`).
- Match the active VS Code folder to a Harness workspace (and offer to create one if absent).
- List the workspace's existing sessions.
- Open a session and render its history.
- Send a plain-text prompt to that session.
- Stream the assistant's reply (text deltas + tool activity) live.
- Stop the active turn.
- Reopen the stream and refetch history on disconnect.
- "Open in Harness Web UI" command.

## What v0.0.1 deliberately does NOT do

For your safety, v0.0.1 refuses to touch anything beyond read + prompt + cancel:

- No `/api/respond`, no approval allow/reject, no permission changes.
- No `commands/execute`, no `credentials` or `settings` API.
- No model switching.
- No diff review, file edits, inline completion, terminal/LSP integration.
- No second session database — the Harness Session is the **only** source of truth.
- No auto-install / auto-start / auto-upgrade of `dsh`.
- Does not fork or modify the Harness source.

If an action requires approval, VS Code only shows:

> Action requires approval in DeepSeek Harness Web UI

and never responds on your behalf.

## Requirements

- VS Code ≥ 1.85
- A running local `dsh web` (default port `3080`). This extension does **not** start it for you.

## Quick start

1. Start Harness locally:

   ```bash
   dsh web
   # → http://127.0.0.1:3080
   ```

2. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) or via command line:

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   Or install the VSIX from [GitHub Releases](https://github.com/liangwythu/deepseek-harness-vscode/releases):

   ```bash
   code --install-extension harness-connector-deepseek-0.0.1.vsix
   ```

3. Open a folder in VS Code that you want to bind to a Harness workspace.

4. The DeepSeek Harness activity-bar icon appears; the extension auto-connects. If your folder matches an existing Harness workspace, its sessions appear in the dropdown. Pick one and continue the conversation.

5. Open the same session in your browser at `http://127.0.0.1:3080/` — both surfaces see the same turn.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.1 only allows `127.0.0.1` or `localhost`.** Any other value is refused. |
| `deepseekHarness.port` | `3080` | The default `dsh web` port. Override if you started `dsh web --port <n>`. |
| `deepseekHarness.showSystemMessages` | `false` | Show plugin-injected system messages (runtime context, approval notices). Hidden by default; toggle live with the `SYS` button in the webview header. |

## Commands

- `DeepSeek Harness: Connect` / `Disconnect`
- `DeepSeek Harness: New Session` (in the active workspace)
- `DeepSeek Harness: Refresh Sessions`
- `DeepSeek Harness: Move to Right Side Bar` — dock the view in the secondary side bar (like Chat) so it stops competing with the file explorer. Also available via the ⇲ button in the webview header.
- `DeepSeek Harness: Open Web UI`
- `DeepSeek Harness: Show Logs` (the `DeepSeek Harness` output channel)

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the one-page design and the protocol contract. (中文版: [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md))

## Protocol fixtures

`test/fixtures/` holds sanitized captures of the live wire format, useful for detecting upstream Harness protocol drift:

- `host-describe.json`, `workspace-list.json`, `session-list.json`, `session-history.json`, `session-prompt.json`, `session-event.json`

No credentials, API keys, or real prompt content are stored — only the JSON shapes (text fields are redacted).

## Protocol spike

A standalone Node script validates the full loop against your running `dsh web`:

```bash
npm run spike            # read-only validation (connect / list / history / mux open)
npm run spike -- --prompt  # also exercises prompt + live events + cancel
```

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # rebuild on change
npm run typecheck
npm run package      # → harness-connector-deepseek-0.0.1.vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Verified against

- DeepSeek Harness host `v0.0.1` (`@deepseek-ai/dsh-root`), default `dsh web` port `3080`.
- Wire contract: `packages/host/apiproxy/src/api/` (authoritative).

## Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- Text prompts only (no image attachments).
- History loads the last ~50 messages; "load older" is v0.0.2.
- Session deep-links in "Open Web UI" are intentionally not guessed — only the Harness home opens.
- Unknown harness event types are ignored (the protocol is merge-extensible); they do not crash the client but also do not render.

## v0.0.2 TODO (recorded, not implemented)

- Diff Review
- Approval integration
- Inline Completion
- VS Code filesystem provider

## License

MIT
