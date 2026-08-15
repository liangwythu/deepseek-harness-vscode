/** CSS for the webview sidebar. Kept as a plain string template; physical
 *  file separation makes it easier to edit without touching provider.ts. */
export const STYLES = /* css */ `
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
.ws-pending { color: var(--vscode-charts-yellow, #ca9c2e); font-size: 11px; margin-top: 2px; }
#messages { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 6px 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
.msg.user { background: var(--vscode-input-background); border-left: 3px solid var(--vscode-charts-blue, #1b7fbd); }
.msg.user .role { color: var(--vscode-charts-blue, #1b7fbd); }
.msg.assistant { background: var(--vscode-editor-background); border-left: 3px solid var(--vscode-charts-green, #2da44e); }
.msg.assistant .role { color: var(--vscode-charts-green, #2da44e); }
.msg .role { font-weight: 600; font-size: 11px; display: block; margin-bottom: 2px; }
.msg .reasoning { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; border-left: 2px solid var(--vscode-panel-border); padding-left: 6px; }
.msg .usage { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 4px; }

/* Markdown content (assistant messages only). */
.msg .md { line-height: 1.55; }
.msg .md p { margin: 0 0 0.7em; }
.msg .md p:last-child { margin-bottom: 0; }
.msg .md h1, .msg .md h2, .msg .md h3, .msg .md h4 { margin: 1em 0 0.4em; line-height: 1.25; font-weight: 600; }
.msg .md h1 { font-size: 1.25em; }
.msg .md h2 { font-size: 1.15em; }
.msg .md h3 { font-size: 1.08em; }
.msg .md code {
  font-family: var(--vscode-editor-font-family, monospace);
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  padding: 1px 4px; border-radius: 3px; font-size: 0.92em;
}
.msg .md pre {
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12));
  border-radius: 4px; padding: 8px; overflow-x: auto; margin: 0.6em 0;
}
.msg .md pre code { background: transparent; padding: 0; }
.msg .md blockquote {
  margin: 0.4em 0; padding: 2px 10px;
  border-left: 3px solid var(--vscode-charts-yellow, #ca9c2e);
  color: var(--vscode-descriptionForeground);
}
.msg .md ul, .msg .md ol { padding-left: 1.4em; margin: 0.4em 0; }
.msg .md li { margin: 2px 0; }
.msg .md a { color: var(--vscode-textLink-foreground); }
.msg .md table { border-collapse: collapse; margin: 0.6em 0; font-size: 0.95em; }
.msg .md th, .msg .md td { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); padding: 4px 8px; }
.msg .md th { background: var(--vscode-textBlockQuote-background, rgba(128,128,128,.08)); font-weight: 600; }
.msg .md img { max-width: 100%; }
.msg .md hr { border: 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); margin: 0.8em 0; }

/* System item (collapsed by default) */
.system {
  padding: 4px 8px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  font-size: 11px; color: var(--vscode-descriptionForeground);
}
.system .sys-head { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; font-weight: 500; }
.system .sys-head:hover { color: var(--vscode-foreground); }
.system .sys-arrow { display: inline-block; width: 10px; transition: transform 0.15s; }
.system.open .sys-arrow { transform: rotate(90deg); }
.system .sys-body { display: none; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
.system.open .sys-body { display: block; }
.system .sys-source { color: var(--vscode-textLink-foreground); font-size: 10px; margin-left: auto; }

/* ToolItem: single collapsed card (call + result merged). */
.tool {
  padding: 4px 8px; border-radius: 4px;
  background: var(--vscode-textBlockQuote-background);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
}
.tool .t-head {
  cursor: pointer; user-select: none;
  display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 12px;
}
.tool .t-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); border-radius: 3px; }
.tool .t-arrow { display: inline-block; width: 10px; transition: transform 0.15s; color: var(--vscode-descriptionForeground); }
.tool.open .t-arrow { transform: rotate(90deg); }
.tool .t-name { color: var(--vscode-symbolIcon-functionForeground, #b58900); flex: 0 0 auto; }
.tool.error .t-name { color: var(--vscode-errorForeground, #c53149); }
.tool .t-title { flex: 1; }
.tool .t-state { font-size: 10px; flex: 0 0 auto; }
.tool .t-state.running { color: var(--vscode-charts-yellow, #ca9c2e); }
.tool .t-state.done { color: var(--vscode-charts-green, #2da44e); }
.tool .t-state.error { color: var(--vscode-errorForeground, #c53149); }
.tool .t-body { display: none; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.tool.open .t-body { display: block; }
.tool .t-section-title { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 6px 0 2px; }
.tool pre {
  margin: 0; font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; white-space: pre-wrap; word-break: break-word;
  max-height: 260px; overflow-y: auto;
  background: var(--vscode-editor-background);
  padding: 6px; border-radius: 3px;
}
.tool.error .t-result { color: var(--vscode-errorForeground); }

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
`
