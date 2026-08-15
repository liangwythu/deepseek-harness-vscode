/**
 * DeepSeek Harness VS Code v0.0.1 — extension entry point.
 *
 * Wiring only: the network boundary is HarnessClient, the event stream is
 * MuxStream + EventBuffer, the conversation fold is SessionModel, and the UI
 * is a vanilla-JS webview. This module owns the UiState machine and dispatches
 * webview actions to the right client calls.
 *
 * Success criterion (§2): VS Code and the browser see the SAME session — the
 * harness Session is the single source of truth, so any mutation VS Code makes
 * (prompt) is visible to a browser refresh of that session.
 */

import * as vscode from 'vscode'
import { HarnessClient } from './harness/client.ts'
import type { MuxStatus } from './harness/events.ts'
import type { SessionId, SessionSummary, WorkspaceView } from './harness/protocol.ts'
import { SessionModel } from './session.ts'
import { pickVsCodeFolder, resolveHarnessWorkspace } from './workspace.ts'
import {
  HarnessWebviewViewProvider, type UiState, type WebviewAction,
  connectionToUi, sessionsToUi, workspaceToUi,
} from './view/provider.ts'
import { CompositeDisposable } from './disposable.ts'

const SECTION = 'deepseekHarness'
const OUTPUT_CHANNEL = 'DeepSeek Harness'

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true })
  context.subscriptions.push(log)
  log.info('DeepSeek Harness v0.0.1 activating')

  const disposables: CompositeDisposable = new CompositeDisposable()
  context.subscriptions.push(disposables)

  // ─── read config ────────────────────────────────────────────────────────────
  const cfg = readConfig()
  let client = new HarnessClient({ host: cfg.host, port: cfg.port, log: (m) => log.info(m) })

  // ─── orchestrator state ─────────────────────────────────────────────────────
  const state: UiState = {
    connection: 'disconnected',
    sessions: [],
    sending: false,
    canStop: false,
  }
  let workspace: WorkspaceView | undefined | null
  let sessions: SessionSummary[] = []
  let activeSessionId: SessionId | undefined
  let model: SessionModel | undefined
  let muxStatus: MuxStatus | undefined

  const stateListeners = new Set<(s: UiState) => void>()
  function pushState(): void {
    const conn = connectionToUi(client.getState(), muxStatus)
    state.connection = conn.connection
    state.hostInfo = conn.hostInfo
    state.errorMessage = conn.errorMessage
    state.muxStatus = conn.muxStatus
    state.workspace = workspace ? workspaceToUi(workspace) : (workspace === null ? null : undefined)
    state.sessions = sessionsToUi(sessions)
    state.activeSessionId = activeSessionId
    state.snapshot = model?.snapshot()
    state.canStop = model?.snapshot().running === true
    for (const l of stateListeners) {
      try { l(state) } catch { /* listener errors must not propagate */ }
    }
  }

  // ─── webview provider ───────────────────────────────────────────────────────
  const provider = new HarnessWebviewViewProvider({
    client,
    extensionUri: context.extensionUri,
    getState: () => state,
    onState: (listener) => {
      stateListeners.add(listener)
      return { dispose: () => { stateListeners.delete(listener) } }
    },
    dispatch: (action) => { void handleAction(action) },
  })
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    HarnessWebviewViewProvider.viewType, provider, { webviewOptions: { retainContextWhenHidden: true } },
  ))

  // ─── client state wiring ────────────────────────────────────────────────────
  disposables.add(client.onStateChange(() => pushState()))
  // §15: on mux reconnect (closed → open), refetch history for the active
  // session. The harness resume semantic is rebuild — reopen stream + refetch.
  let prevMuxKind: MuxStatus['kind'] | undefined
  disposables.add(client.onMuxStatusChange((s) => {
    const reopened = prevMuxKind !== undefined && prevMuxKind !== 'open' && s.kind === 'open'
    prevMuxKind = s.kind
    muxStatus = s
    if (reopened && activeSessionId) void refetchHistory(activeSessionId)
    pushState()
  }))

  // ─── actions ────────────────────────────────────────────────────────────────
  async function handleAction(action: WebviewAction): Promise<void> {
    switch (action.type) {
      case 'connect': await doConnect(); break
      case 'disconnect': doDisconnect(); break
      case 'selectSession': await selectSession(action.sessionId); break
      case 'newSession': await newSession(); break
      case 'refreshSessions': await refreshSessions(); break
      case 'sendPrompt': await sendPrompt(action.text); break
      case 'stop': await stopActive(); break
      case 'openWebUI': openWebUI(); break
    }
  }

  async function doConnect(): Promise<void> {
    try {
      await client.connect()
      await resolveWorkspaceAndSessions()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('connect failed: ' + msg)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
    pushState()
  }

  function doDisconnect(): void {
    client.disconnect()
    model = undefined
    activeSessionId = undefined
    sessions = []
    workspace = undefined
    pushState()
  }

  async function resolveWorkspaceAndSessions(): Promise<void> {
    const folder = await pickVsCodeFolder(vscode.workspace, vscode.window)
    if (!folder) {
      workspace = null // signals "open a folder" hint
      pushState()
      return
    }
    try {
      workspace = await resolveHarnessWorkspace(client, folder, vscode.window)
      if (!workspace) { pushState(); return }
      await refreshSessions()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('resolve workspace failed: ' + msg)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
  }

  async function refreshSessions(): Promise<void> {
    if (!workspace) return
    try {
      const all = (await client.listSessions()).items
      // Filter to the active workspace's sessions (§11: filter by workspace).
      const wsIds = new Set(workspace.sessionIds)
      sessions = all.filter(s => wsIds.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)
      // Auto-select the most recent non-blank session if none is active.
      if (!activeSessionId && sessions.length > 0) {
        const first = sessions.find(s => !s.blank) ?? sessions[0]
        if (first) await selectSession(first.sessionId)
      } else {
        pushState()
      }
    } catch (e) {
      log.error('list sessions failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function selectSession(sessionId: SessionId): Promise<void> {
    activeSessionId = sessionId
    model = new SessionModel(sessionId)
    pushState()
    try {
      await refetchHistory(sessionId)
      // Subscribe to live frames for this session (filtered inside the client).
      disposables.add(client.subscribe(sessionId, (frames) => {
        for (const f of frames) applyMuxFrame(f)
        pushState()
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error('history/subscribe failed: ' + msg)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
    pushState()
  }

  /** Refetch the session history and rebuild the model (used on initial open and on mux reconnect). */
  async function refetchHistory(sessionId: SessionId): Promise<void> {
    if (!model) return
    const h = await client.getHistory(sessionId, { maxMessages: 50 })
    model.loadHistory(h.events.map(e => e.event))
    pushState()
  }

  function applyMuxFrame(frame: unknown): void {
    if (!model || !activeSessionId) return
    const f = frame as { type?: string; sessionId?: string; event?: unknown; error?: unknown }
    if (f.type === 'session/event' && f.sessionId === activeSessionId && f.event) {
      model.applyEvent(f.event as Parameters<SessionModel['applyEvent']>[0])
      return
    }
    if (f.type === 'approval/requested' || f.type === 'question/requested') {
      // §3: never respond. Only notify the user to act in the web UI.
      vscode.window.showInformationMessage(
        'Action requires approval in DeepSeek Harness Web UI',
      )
      return
    }
    if (f.type === 'stream/error' && f.error) {
      const err = f.error as { message?: string }
      vscode.window.showErrorMessage(`Harness stream error: ${err.message ?? 'unknown'}`)
      return
    }
    // Unknown / unrelated frames: ignore (§13).
  }

  async function newSession(): Promise<void> {
    if (!workspace) return
    try {
      const res = await client.createSession({ workspaceId: workspace.workspaceId })
      await refreshSessions()
      await selectSession(res.sessionId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
  }

  async function sendPrompt(text: string): Promise<void> {
    if (!activeSessionId) return
    state.sending = true
    pushState()
    try {
      model?.optimisticUserEcho(text)
      pushState()
      await client.prompt(activeSessionId, text, Intl.DateTimeFormat().resolvedOptions().timeZone)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    } finally {
      state.sending = false
      pushState()
    }
  }

  async function stopActive(): Promise<void> {
    if (!activeSessionId) return
    try {
      await client.cancel(activeSessionId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
  }

  function openWebUI(): void {
    const c = readConfig()
    // §16: open the harness home. We do not guess session deep-links.
    void vscode.env.openExternal(vscode.Uri.parse(`http://${c.host}:${c.port}/`))
  }

  // ─── commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.connect', () => handleAction({ type: 'connect' })),
    vscode.commands.registerCommand('deepseekHarness.disconnect', () => handleAction({ type: 'disconnect' })),
    vscode.commands.registerCommand('deepseekHarness.openWebUI', openWebUI),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => log.show()),
    vscode.commands.registerCommand('deepseekHarness.newSession', () => handleAction({ type: 'newSession' })),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', () => handleAction({ type: 'refreshSessions' })),
  )

  // ─── config change ──────────────────────────────────────────────────────────
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SECTION)) return
    const next = readConfig()
    if (next.host !== cfg.host || next.port !== cfg.port) {
      // Re-create the client on host/port change (§17).
      vscode.window.showInformationMessage(
        'DeepSeek Harness: configuration changed — reconnecting.',
      )
      client.dispose()
      cfg.host = next.host
      cfg.port = next.port
      client = new HarnessClient({ host: cfg.host, port: cfg.port, log: (m) => log.info(m) })
      disposables.add(client.onStateChange(() => pushState()))
      disposables.add(client.onMuxStatusChange((s) => { muxStatus = s; pushState() }))
      void doConnect()
    }
  }))

  // Auto-connect on activation (the spike validated the loopback instance).
  void doConnect()
}

export function deactivate(): void {
  // Disposables are owned by context.subscriptions; nothing to do here.
}

function readConfig(): { host: string; port: number } {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const host = cfg.get<string>('host') ?? '127.0.0.1'
  const port = cfg.get<number>('port') ?? 3080
  return { host, port }
}
