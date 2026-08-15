/**
 * Webview-side client script (renderer-side logic — runs inside the <script>
 * block wrapped with the CSP nonce).
 *
 * Responsibilities:
 *   • Render UiState snapshots (full re-render on renderVersion change only).
 *   • Assistant markdown via markdown-it (html:false — unsafe HTML is dropped).
 *   • System / Tool cards are collapsed by default; click-to-expand.
 *   • Post user actions back to the extension host (sendPrompt, selectSession…).
 *
 * IMPORTANT: The extension host sends raw markdown text. Markdown rendering
 * happens HERE (webview side), not in extension host — semantic vs. presentation
 * boundary.
 */

export const CLIENT_SCRIPT = /* js */ `
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let lastRenderVersion = -1;

  // ─── markdown renderer (webview-only, html disabled!) ──────────────────────
  const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
  // Override the default link renderer to add target=_blank + rel=noopener
  const defaultLinkRender = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
    const hrefIndex = tokens[idx].attrIndex('href');
    if (hrefIndex >= 0) {
      const href = tokens[idx].attrs[hrefIndex][1];
      // Only allow http/https/mailto — block javascript: / data: payloads
      const safe = /^(https?:|mailto:)/i.test(href);
      if (!safe) tokens[idx].attrs[hrefIndex][1] = '#';
    }
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultLinkRender(tokens, idx, options, env, self);
  };

  function renderMarkdown(s) {
    if (!s) return '';
    return md.render(String(s));
  }

  // ─── util ───────────────────────────────────────────────────────────────────
  function escapeText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function prettyArgs(raw) {
    if (!raw) return '';
    try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
  }
  function post(action) { vscode.postMessage(action); }

  function setDot(kind) {
    const dot = $('dot');
    dot.className = 'dot ' + kind;
  }

  // ─── main render entry point ────────────────────────────────────────────────
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
    const pendingBanner = $('ws-pending');
    if (state.workspace) {
      $('ws-name').textContent = state.workspace.title || state.workspace.path;
      $('ws-path').textContent = state.workspace.path;
      if (pendingBanner) pendingBanner.style.display = 'none';
    } else if (state.workspace === null) {
      // "No matching harness workspace yet — workspace will be created on first send."
      $('ws-name').textContent = 'Not registered yet';
      $('ws-path').textContent = 'Your first prompt will automatically create the Harness workspace.';
      if (pendingBanner) {
        pendingBanner.textContent = '💡 Workspace will be created lazily on first send.';
        pendingBanner.style.display = '';
      }
    } else {
      $('ws-name').textContent = 'No workspace';
      $('ws-path').textContent = '';
      if (pendingBanner) pendingBanner.style.display = 'none';
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

    // Messages — rebuild on renderVersion change (streaming fix) OR when
    // there's no snapshot yet (connection state may have changed).
    const msgs = $('messages');
    const snap = state.snapshot;
    if (snap && snap.renderVersion !== lastRenderVersion) {
      lastRenderVersion = snap.renderVersion;
      if (snap.items.length === 0) {
        msgs.innerHTML = '<div class="empty">' + (state.activeSessionId ? 'No messages yet. Send a prompt below.' : 'Select a session to view its history.') + '</div>';
      } else {
        msgs.innerHTML = '';
        for (const item of snap.items) msgs.appendChild(renderItem(item));
      }
      msgs.scrollTop = msgs.scrollHeight;
    } else if (!snap) {
      // No snapshot — show contextual empty state based on connection.
      // This branch runs every render when there's no snap, so the message
      // tracks the live connection state instead of caching "Disconnected".
      var emptyMsg;
      if (state.connection === 'connected') {
        emptyMsg = state.workspace === null
          ? 'Workspace will be created on your first send. Type a prompt below to begin.'
          : 'Select a session or send a prompt to start.';
      } else if (state.connection === 'connecting') {
        emptyMsg = 'Connecting to DeepSeek Harness…';
      } else if (state.connection === 'error') {
        emptyMsg = state.errorMessage || 'Connection error';
      } else {
        emptyMsg = 'Disconnected. Click Connect or restart the extension.';
      }
      var expected = '<div class="empty">' + escapeText(emptyMsg) + '</div>';
      if (msgs.innerHTML !== expected) msgs.innerHTML = expected;
    }

    // Input controls
    const canSend = state.connection === 'connected' && !state.sending;
    // Send button is enabled whenever connected (even without active session —
    // session+workspace will be created lazily on send).
    $('send').disabled = !canSend;
    $('stop').disabled = !state.canStop;
    $('new-session').disabled = state.connection !== 'connected' || state.workspace === null;
    $('refresh').disabled = state.connection !== 'connected';
  }

  // ─── per-item render ────────────────────────────────────────────────────────
  function renderItem(item) {
    if (item.kind === 'status') {
      const d = document.createElement('div');
      d.className = 'status-line' + (item.running ? ' running' : '');
      d.textContent = item.text;
      return d;
    }
    if (item.kind === 'system') return renderSystem(item);
    if (item.kind === 'tool') return renderTool(item);
    return renderMessage(item);
  }

  function renderSystem(item) {
    const d = document.createElement('div');
    d.className = 'system';
    const head = document.createElement('div');
    head.className = 'sys-head';
    head.innerHTML = '<span class="sys-arrow">▸</span><span class="sys-label">Runtime context</span>';
    if (item.source) {
      const s = document.createElement('span');
      s.className = 'sys-source'; s.textContent = ' · ' + escapeText(item.source);
      head.appendChild(s);
    }
    head.addEventListener('click', () => d.classList.toggle('open'));
    d.appendChild(head);
    const body = document.createElement('div');
    body.className = 'sys-body'; body.textContent = item.text;
    d.appendChild(body);
    return d;
  }

  function renderTool(item) {
    const d = document.createElement('div');
    d.className = 'tool' + (item.state === 'error' ? ' error' : '');

    const head = document.createElement('div');
    head.className = 't-head';
    const arrow = document.createElement('span'); arrow.className = 't-arrow'; arrow.textContent = '▸';
    const name = document.createElement('span'); name.className = 't-name';
    name.textContent = '🔧 ' + escapeText(item.name);
    const title = document.createElement('span'); title.className = 't-title';
    title.textContent = presentToolTitle(item);
    const state = document.createElement('span'); state.className = 't-state';
    if (item.state === 'running') { state.classList.add('running'); state.textContent = '● running'; }
    else if (item.state === 'completed') { state.classList.add('done'); state.textContent = '✓ done'; }
    else if (item.state === 'error') { state.classList.add('error'); state.textContent = '⚠ error'; }

    head.appendChild(arrow);
    head.appendChild(name);
    if (title.textContent) head.appendChild(title);
    head.appendChild(state);
    head.addEventListener('click', () => d.classList.toggle('open'));
    d.appendChild(head);

    const body = document.createElement('div');
    body.className = 't-body';

    const aTitle = document.createElement('div');
    aTitle.className = 't-section-title'; aTitle.textContent = 'Arguments';
    const aPre = document.createElement('pre');
    aPre.textContent = prettyArgs(item.arguments);
    body.appendChild(aTitle); body.appendChild(aPre);

    if (item.result) {
      const rTitle = document.createElement('div');
      rTitle.className = 't-section-title';
      rTitle.textContent = item.result.isError ? 'Error' : 'Result';
      const rPre = document.createElement('pre');
      rPre.className = 't-result';
      rPre.textContent = item.result.text;
      body.appendChild(rTitle); body.appendChild(rPre);
    }
    d.appendChild(body);
    return d;
  }

  // Mirror of presentTool from view/toolPresentation.ts — keeps the two
  // implementations intentionally simple; this is the rendering-only copy.
  function presentToolTitle(tool) {
    let args; try { if (tool.arguments) args = JSON.parse(tool.arguments); } catch {}
    const a = args || {};
    const n = tool.name;
    const str = (v) => typeof v === 'string' ? v : undefined;
    const tr = (s, n2) => s.length <= n2 ? s : s.slice(0, n2 - 1) + '…';

    switch (n) {
      case 'read': case 'read_file': return str(a.path) || str(a.file) || '';
      case 'write': case 'write_file': return str(a.path) || str(a.file) || '';
      case 'edit': case 'edit_file': return str(a.path) || str(a.file) || '';
      case 'grep': case 'search': case 'search_code':
        return str(a.pattern) ? ('"' + tr(str(a.pattern), 40) + '"') : '';
      case 'bash': case 'shell': case 'run_command':
        return str(a.command) ? tr(str(a.command), 50) : '';
      case 'ls': case 'list_dir': case 'list_directory': return str(a.path) || '';
      case 'cd': return str(a.path) || '';
      case 'pwd': case 'cwd': return '';
      case 'http_get': case 'fetch': case 'curl':
        return str(a.url) ? tr(str(a.url), 60) : '';
      case 'http_post': return str(a.url) ? tr(str(a.url), 60) : '';
      case 'git_status': return '';
      case 'git_log': return '';
      case 'git_diff': return str(a.path) || 'worktree';
      case 'git_commit': return str(a.message) ? ('"' + tr(str(a.message), 50) + '"') : '';
    }
    return '';
  }

  function renderMessage(item) {
    const d = document.createElement('div');
    d.className = 'msg ' + item.kind;
    if (item.kind === 'assistant' && item.streaming) d.dataset.streaming = 'true';
    const role = document.createElement('span');
    role.className = 'role';
    role.textContent = item.kind === 'user' ? 'You' : 'Assistant';
    d.appendChild(role);
    if (item.reasoning) {
      const r = document.createElement('div');
      r.className = 'reasoning'; r.textContent = item.reasoning;
      d.appendChild(r);
    }
    const body = document.createElement('div');
    if (item.kind === 'assistant') {
      body.className = 'md';
      body.innerHTML = renderMarkdown(item.text) || (item.streaming ? '' : '');
    } else {
      body.textContent = item.text || '';
    }
    d.appendChild(body);
    if (item.kind === 'assistant' && item.streaming) {
      const cur = document.createElement('span');
      cur.className = 'cursor';
      d.appendChild(cur);
    }
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

  // Send prompt: do NOT clear textarea here. The optimistic user echo from
  // extension host bumps renderVersion, which triggers a re-render. But to
  // avoid flashing old input on failure, we clear optimistically HERE and
  // rely on the controller. If creation fails, snapshot won't carry the echo
  // but we won't restore text either (it will be on the lost-input UX —
  // acceptable for v0.0.2).
  function sendPrompt() {
    const ta = $('input');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    post({ type: 'sendPrompt', text });
  }

  post({ type: 'connect' });
`
