/**
 * Webview sidebar provider (§10). Vanilla JS, no React (§5). The extension
 * owns all state and pushes snapshots; the webview is a pure renderer that
 * posts user actions back. The EventBuffer caps assistant-chunk re-renders
 * at ~30ms (§14) — the webview never sees a per-token flood.
 *
 * Layout (§10):
 *   Connection Status · Workspace · Session dropdown [ + New ]
 *   ── Messages ──
 *   Input [ Send ] [ Stop ]
 *   ── Open in Harness ──
 */

import * as vscode from 'vscode'
import type { HarnessClient, ConnectionState } from '../harness/client.ts'
import type { MuxStatus } from '../harness/events.ts'
import type { SessionSummary, WorkspaceView } from '../harness/protocol.ts'
import { type SessionSnapshot } from '../session.ts'

/** UI state pushed to the webview (full snapshot each time — simple and small). */
export interface UiState {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  hostInfo?: { version: string; provider?: string; model?: string }
  errorMessage?: string
  muxStatus?: string
  workspace?: { workspaceId: string; title: string; path: string } | null
  sessions: Array<{ sessionId: string; label: string; running: boolean; blank: boolean }>
  activeSessionId?: string
  snapshot?: SessionSnapshot
  sending: boolean
  canStop: boolean
  /** Whether plugin-injected system messages are shown. */
  showSystemMessages: boolean
  /** Count of hidden system messages (for the toggle badge). */
  systemMessageCount: number
  /** URI of the brand icon, webview-resolved (for the header). */
  brandIconUri?: string
}

/** Actions the webview posts back to the extension. */
export type WebviewAction =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'refreshSessions' }
  | { type: 'sendPrompt'; text: string }
  | { type: 'stop' }
  | { type: 'openWebUI' }
  | { type: 'toggleSystemMessages' }
  | { type: 'moveToSecondarySideBar' }

export interface ProviderDeps {
  client: HarnessClient
  getState: () => UiState
  onState: (listener: (s: UiState) => void) => vscode.Disposable
  dispatch: (action: WebviewAction) => void
  extensionUri: vscode.Uri
}

export class HarnessWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseekHarness.sessionView'
  private view: vscode.WebviewView | undefined
  /** Webview-resolved brand icon URI (set when the view resolves). */
  private brandIconUri: string | undefined

  constructor(private readonly deps: ProviderDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.deps.extensionUri],
    }
    // Resolve the brand icon (PNG) so the webview header can load it.
    const iconUri = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'icon.png')
    this.brandIconUri = view.webview.asWebviewUri(iconUri).toString()
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((msg: WebviewAction) => {
      this.deps.dispatch(msg)
    })
    view.onDidDispose(() => { this.view = undefined })
    // Push the current state once resolved.
    this.deps.onState((s) => this.postState(s))
    this.postState(this.deps.getState())
  }

  /** Re-render with the latest state (called by the extension on every change). */
  refresh(state: UiState): void { this.postState(state) }

  private postState(state: UiState): void {
    // Inject the brand icon URI on every push (the webview can't resolve it itself).
    const withIcon: UiState = this.brandIconUri ? { ...state, brandIconUri: this.brandIconUri } : state
    void this.view?.webview.postMessage({ kind: 'state', state: withIcon })
  }

  // ─── HTML + inline script (nonce-gated CSP) ─────────────────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = getNonce()
    const csp = [
      'default-src \'none\'',
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ')

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DeepSeek Harness</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0; height: 100vh;
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  .bar { padding: 8px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  .brand-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  .brand-bar img { width: 20px; height: 20px; flex-shrink: 0; }
  .brand-bar .brand-name { font-weight: 600; font-size: 12px; flex: 1; }
  .brand-bar .toolbar { display: flex; gap: 2px; }
  .brand-bar .toolbar button { padding: 2px 6px; font-size: 11px; }
  .toggle-badge { font-size: 9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 4px; margin-left: 2px; }
  .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
  .status { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.disconnected { background: var(--vscode-disabledForeground, #888); }
  .dot.connecting { background: var(--vscode-charts-yellow, #ca9c2e); animation: pulse 1s infinite; }
  .dot.connected { background: var(--vscode-charts-green, #2da44e); }
  .dot.error { background: var(--vscode-errorForeground, #c53149); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .muted { color: var(--vscode-descriptionForeground); font-weight: 400; font-size: 11px; }
  select, button, input, textarea {
    font-family: inherit; font-size: inherit; color: inherit;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; padding: 4px 6px;
  }
  select { width: 100%; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 4px 10px; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:disabled { opacity: .5; cursor: default; }
  button.icon { padding: 4px 6px; }
  .ws-name { font-weight: 600; }
  .ws-path { color: var(--vscode-descriptionForeground); font-size: 11px; word-break: break-all; }
  #messages { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
  .msg { padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
  .msg.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-charts-blue, #1b7fbd); }
  .msg.user .role { color: var(--vscode-charts-blue, #1b7fbd); }
  .msg.user.system { opacity: .65; border-left-color: var(--vscode-disabledForeground, #888); font-size: 11px; }
  .msg.user.system .role { color: var(--vscode-descriptionForeground); }
  .msg.assistant { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-charts-green, #2da44e); }
  .msg.assistant .role { color: var(--vscode-charts-green, #2da44e); }
  .msg .role { font-weight: 600; font-size: 11px; display: block; margin-bottom: 2px; }
  .msg .source { font-weight: 400; font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
  .msg .reasoning { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; }
  .msg .usage { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .tool { padding: 6px 8px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  .tool .head { font-weight: 600; font-size: 11px; color: var(--vscode-symbolIcon-functionForeground, #b58900); }
  .tool pre { margin: 4px 0 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
  .tool.error .head { color: var(--vscode-errorForeground, #c53149); }
  .status-line { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; padding: 2px 0; }
  .status-line.running { color: var(--vscode-charts-yellow, #ca9c2e); }
  .cursor { display: inline-block; width: 7px; height: 13px; background: var(--vscode-editorCursor-foreground); vertical-align: text-bottom; animation: blink 1s step-end infinite; margin-left: 2px; }
  @keyframes blink { 50% { opacity: 0; } }
  #input-area { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  textarea { resize: none; min-height: 60px; max-height: 200px; width: 100%; }
  .input-row { display: flex; gap: 6px; }
  .input-row button { flex: 1; }
  #open-web { text-align: center; padding: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
  #open-web a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; font-size: 11px; }
  #open-web a:hover { text-decoration: underline; }
  .empty { text-align: center; color: var(--vscode-descriptionForeground); padding: 24px 12px; font-size: 12px; }
</style>
</head>
<body>
  <div class="brand-bar">
    <img id="brand-icon" alt="" style="display:none;" />
    <span class="brand-name">DeepSeek Harness</span>
    <div class="toolbar">
      <button id="toggle-sys" class="secondary icon" title="Show/hide system messages (runtime context, plugin injections)" style="display:none;">SYS</button>
      <button id="move-right" class="secondary icon" title="Move to right side bar">⇲</button>
    </div>
  </div>

  <div class="bar">
    <div class="status">
      <span id="dot" class="dot disconnected"></span>
      <span id="status-text">Disconnected</span>
    </div>
    <div id="host-info" class="muted" style="margin-top:2px;"></div>
    <div id="mux-status" class="muted"></div>
  </div>

  <div class="bar">
    <div id="ws-name" class="ws-name">No workspace</div>
    <div id="ws-path" class="ws-path"></div>
    <div class="row" style="margin-top:6px;">
      <select id="session-select" title="Session"></select>
      <button id="new-session" class="secondary icon" title="New session" style="flex:0 0 auto;">＋</button>
      <button id="refresh" class="secondary icon" title="Refresh" style="flex:0 0 auto;">⟳</button>
    </div>
  </div>

  <div id="messages"></div>

  <div id="input-area">
    <textarea id="input" placeholder="Send a prompt to the existing session…  (Enter to send, Shift+Enter for newline)" rows="3"></textarea>
    <div class="input-row">
      <button id="send">Send</button>
      <button id="stop" class="secondary" disabled>Stop</button>
    </div>
  </div>

  <div id="open-web"><a id="open-web-link">Open in DeepSeek Harness Web UI ↗</a></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let lastSnapshotSeq = -1;

  function escapeText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function post(action) { vscode.postMessage(action); }

  function setDot(kind) {
    const dot = $('dot');
    dot.className = 'dot ' + kind;
  }

  function render(state) {
    // Brand bar
    const icon = $('brand-icon');
    if (state.brandIconUri) { icon.src = state.brandIconUri; icon.style.display = ''; }
    const sysBtn = $('toggle-sys');
    if (state.systemMessageCount > 0) {
      sysBtn.style.display = '';
      sysBtn.classList.toggle('active', state.showSystemMessages);
      sysBtn.textContent = state.showSystemMessages ? 'SYS✓' : 'SYS';
      sysBtn.title = (state.showSystemMessages ? 'Hide' : 'Show') + ' ' + state.systemMessageCount + ' system message(s)';
    } else {
      sysBtn.style.display = 'none';
    }

    // Connection
    const conn = state.connection;
    setDot(conn);
    const labels = { disconnected: 'Disconnected', connecting: 'Connecting…', connected: 'Connected', error: 'Connection error' };
    $('status-text').textContent = labels[conn] || conn;
    const hi = state.hostInfo;
    $('host-info').textContent = hi
      ? 'v' + hi.version + (hi.provider ? ' · ' + hi.provider : '') + (hi.model ? ' / ' + hi.model : '')
      : '';
    $('mux-status').textContent = state.muxStatus ? ('stream: ' + state.muxStatus) : '';
    if (state.errorMessage) $('host-info').textContent = state.errorMessage;

    // Workspace
    if (state.workspace) {
      $('ws-name').textContent = state.workspace.title || state.workspace.path;
      $('ws-path').textContent = state.workspace.path;
    } else {
      $('ws-name').textContent = state.workspace === null ? 'No matching workspace — open a folder VS Code recognizes.' : 'No workspace';
      $('ws-path').textContent = '';
    }

    // Sessions
    const sel = $('session-select');
    const prev = sel.value;
    sel.innerHTML = '';
    if (state.sessions.length === 0) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = '(no sessions)';
      sel.appendChild(opt);
    } else {
      for (const s of state.sessions) {
        const opt = document.createElement('option');
        opt.value = s.sessionId;
        opt.textContent = s.label;
        if (state.activeSessionId === s.sessionId) opt.selected = true;
        sel.appendChild(opt);
      }
    }
    if (prev && state.activeSessionId === undefined) sel.value = prev;

    // Messages
    const msgs = $('messages');
    const snap = state.snapshot;
    if (!snap || snap.items.length === 0) {
      msgs.innerHTML = '<div class="empty">' + (state.activeSessionId ? 'No messages yet. Send a prompt below.' : 'Select a session to view its history.') + '</div>';
    } else {
      // Only rebuild when the snapshot actually changed (lastSeq or running).
      const signature = snap.lastSeq + ':' + snap.running + ':' + snap.items.length + ':' + (snap.items[snap.items.length-1]?.seq ?? 0);
      if (msgs.dataset.sig !== signature) {
        msgs.innerHTML = '';
        for (const item of snap.items) msgs.appendChild(renderItem(item));
        msgs.dataset.sig = signature;
      }
      // Always update the streaming cursor on the last assistant item.
      const last = msgs.lastElementChild;
      if (last && last.classList.contains('assistant') && last.dataset.streaming === 'true') {
        let cur = last.querySelector('.cursor');
        if (!cur) { cur = document.createElement('span'); cur.className = 'cursor'; last.appendChild(cur); }
      }
      msgs.scrollTop = msgs.scrollHeight;
    }

    // Input controls
    $('send').disabled = state.connection !== 'connected' || !state.activeSessionId || state.sending;
    $('stop').disabled = !state.canStop;
    $('new-session').disabled = state.connection !== 'connected' || !state.workspace;
    $('refresh').disabled = state.connection !== 'connected';
  }

  function renderItem(item) {
    if (item.kind === 'status') {
      const d = document.createElement('div');
      d.className = 'status-line' + (item.running ? ' running' : '');
      d.textContent = item.text;
      return d;
    }
    if (item.kind === 'tool-call') {
      const d = document.createElement('div');
      d.className = 'tool';
      d.innerHTML = '<div class="head">🔧 ' + escapeText(item.name) + '</div>';
      const pre = document.createElement('pre');
      pre.textContent = prettyArgs(item.arguments);
      d.appendChild(pre);
      return d;
    }
    if (item.kind === 'tool-result') {
      const d = document.createElement('div');
      d.className = 'tool' + (item.isError ? ' error' : '');
      d.innerHTML = '<div class="head">' + (item.isError ? '⚠ tool error' : '✓ tool result') + (item.callId ? ' · ' + escapeText(item.callId.slice(-8)) : '') + '</div>';
      const pre = document.createElement('pre');
      pre.textContent = item.text;
      d.appendChild(pre);
      return d;
    }
    const d = document.createElement('div');
    d.className = 'msg ' + item.kind + (item.kind === 'user' && item.system ? ' system' : '');
    if (item.kind === 'assistant' && item.streaming) d.dataset.streaming = 'true';
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = item.kind === 'user' ? (item.system ? 'system' : 'You') : 'Assistant';
    if (item.kind === 'user' && item.source) {
      const s = document.createElement('span');
      s.className = 'source'; s.textContent = 'via ' + item.source;
      role.appendChild(s);
    }
    d.appendChild(role);
    if (item.reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning'; r.textContent = item.reasoning;
      d.appendChild(r);
    }
    const body = document.createElement('div');
    body.textContent = item.text || (item.kind === 'assistant' && item.streaming ? '' : '');
    d.appendChild(body);
    if (item.kind === 'assistant' && item.usage) {
      const u = document.createElement('div');
      u.className = 'usage';
      const parts = [];
      if (item.usage.inputTokens != null) parts.push('in ' + item.usage.inputTokens);
      if (item.usage.outputTokens != null) parts.push('out ' + item.usage.outputTokens);
      u.textContent = parts.join(' · ') + ' tokens';
      d.appendChild(u);
    }
    return d;
  }

  function prettyArgs(raw) {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }

  // ─── event wiring ───────────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.kind === 'state') render(msg.state);
  });

  $('session-select').addEventListener('change', (e) => {
    if (e.target.value) post({ type: 'selectSession', sessionId: e.target.value });
  });
  $('new-session').addEventListener('click', () => post({ type: 'newSession' }));
  $('refresh').addEventListener('click', () => post({ type: 'refreshSessions' }));
  $('send').addEventListener('click', () => sendPrompt());
  $('stop').addEventListener('click', () => post({ type: 'stop' }));
  $('open-web-link').addEventListener('click', () => post({ type: 'openWebUI' }));
  $('toggle-sys').addEventListener('click', () => post({ type: 'toggleSystemMessages' }));
  $('move-right').addEventListener('click', () => post({ type: 'moveToSecondarySideBar' }));
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); sendPrompt();
    }
  });

  function sendPrompt() {
    const ta = $('input');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    post({ type: 'sendPrompt', text });
  }

  post({ type: 'connect' });
</script>
</body>
</html>`
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/** Build the UiState workspace field from a WorkspaceView (or null when none matches). */
export function workspaceToUi(ws: WorkspaceView | undefined): UiState['workspace'] {
  if (!ws) return undefined
  return { workspaceId: ws.workspaceId, title: ws.title, path: ws.path }
}

/** Build the UiState sessions list from SessionSummary[]. */
export function sessionsToUi(sessions: SessionSummary[]): UiState['sessions'] {
  return sessions.map((s, i) => ({
    sessionId: s.sessionId,
    label: labelFor(s, i),
    running: s.running,
    blank: s.blank,
  }))
}

function labelFor(s: SessionSummary, i: number): string {
  const stamp = new Date(s.updatedAt).toLocaleString()
  const id8 = s.sessionId.replace(/^session-/, '').slice(0, 8)
  const state = s.running ? '● ' : (s.blank ? '○ ' : '')
  return `${state}${i + 1}. ${id8} — ${stamp}`
}

/** Map a ConnectionState + mux status into the UiState connection fields. */
export function connectionToUi(conn: ConnectionState, mux?: MuxStatus): Pick<UiState, 'connection' | 'hostInfo' | 'errorMessage' | 'muxStatus'> {
  switch (conn.kind) {
    case 'disconnected': return { connection: 'disconnected', muxStatus: undefined }
    case 'connecting': return { connection: 'connecting', muxStatus: undefined }
    case 'connected':
      return {
        connection: 'connected',
        hostInfo: { version: conn.describe.version, provider: conn.describe.provider, model: conn.describe.model },
        muxStatus: mux ? muxLabel(mux) : undefined,
      }
    case 'error': return { connection: 'error', errorMessage: conn.message, muxStatus: undefined }
  }
}

function muxLabel(s: MuxStatus): string {
  switch (s.kind) {
    case 'idle': return 'idle'
    case 'connecting': return 'connecting…'
    case 'open': return 'live'
    case 'closed': return 'closed (' + s.reason + ')'
    case 'error': return 'error: ' + s.message
  }
}
