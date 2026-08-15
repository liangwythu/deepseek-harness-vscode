/**
 * AppController — owns the full orchestration that used to live inline in
 * extension.ts (v0.0.1→v0.0.2 refactor). This module is now the only thing that touches:
 *   - connect/disconnect
 *   - workspace lifecycle (find + ensure on demand)
 *   - session lifecycle (select / create / prompt)
 *   - mux dispatch (frames → ConversationModel)
 *   - UiState push (with renderVersion bumping)
 *
 * extension.ts stays as the pure wiring module: instantiate, register
 * commands, config changes, dispose.
 */

import type * as vscode from 'vscode'
import type { HarnessClient } from '../harness/client.ts'
import type { MuxStatus } from '../harness/events.ts'
import type { SessionId, SessionSummary, WorkspaceView } from '../harness/protocol.ts'
import { ConversationModel, sessionLabel } from '../conversation/model.ts'
import type { ConversationItem, SessionSnapshot } from '../conversation/types.ts'
import {
  findHarnessWorkspace, ensureHarnessWorkspace, pickVsCodeFolder,
  type WorkspaceBinding,
} from '../workspace/binding.ts'
import type { UiState } from './state.ts'
import { connectionToUi, sessionsToUi, workspaceToUi } from './state.ts'
import type { WebviewAction } from '../view/provider.ts'
import { CompositeDisposable } from '../disposable.ts'

export interface ControllerDeps {
  client: HarnessClient
  vscodeAPI: {
    window: typeof vscode.window
    workspace: typeof vscode.workspace
  }
  getState: () => UiState
  setState: (patch: Partial<UiState>) => void
  bump: () => void
  pushState: () => void
  notifyError: (msg: string) => void
  notifyInfo: (msg: string) => void
  openHarnessHome: () => void
  moveToSecondarySideBar: () => Promise<void>
  log: { info: (m: string) => void; error: (m: string) => void }
}

export class AppController {
  private disposables = new CompositeDisposable()
  private binding: WorkspaceBinding | null = null
  /** null = "we looked and there is no folder". undefined = "not looked yet". */
  private noFolder: null | undefined = undefined
  private sessions: SessionSummary[] = []
  private activeSessionId: SessionId | undefined
  private model: ConversationModel | undefined
  private muxStatus: MuxStatus | undefined

  constructor(private readonly d: ControllerDeps) {}

  start(): vscode.Disposable {
    // Wire client state → UiState
    this.disposables.add(this.d.client.onStateChange(() => this.pushFromClient()))
    let prevMuxKind: MuxStatus['kind'] | undefined
    this.disposables.add(this.d.client.onMuxStatusChange((s) => {
      const reopened = prevMuxKind !== undefined && prevMuxKind !== 'open' && s.kind === 'open'
      prevMuxKind = s.kind
      this.muxStatus = s
      if (reopened && this.activeSessionId) void this.refetchHistory(this.activeSessionId)
      this.pushFromClient()
    }))
    return this.disposables
  }

  // ─── actions (called by webview + commands) ────────────────────────────────
  async dispatch(action: WebviewAction): Promise<void> {
    switch (action.type) {
      case 'connect': await this.doConnect(); break
      case 'disconnect': this.doDisconnect(); break
      case 'selectSession': await this.selectSession(action.sessionId); break
      case 'newSession': await this.newSession(); break
      case 'refreshSessions': await this.refreshSessions(); break
      case 'sendPrompt': await this.sendPrompt(action.text); break
      case 'stop': await this.stopActive(); break
      case 'openWebUI': this.d.openHarnessHome(); break
      case 'toggleSystemMessages': this.toggleSystemMessages(); break
      case 'moveToSecondarySideBar': void this.d.moveToSecondarySideBar(); break
    }
  }

  async doConnect(): Promise<void> {
    try {
      await this.d.client.connect()
      await this.discoverFolder()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('connect failed: ' + msg)
      this.d.notifyError(msg)
    }
    this.d.pushState()
  }

  doDisconnect(): void {
    this.d.client.disconnect()
    this.model = undefined
    this.activeSessionId = undefined
    this.sessions = []
    this.binding = null
    this.noFolder = undefined
    this.d.setState({ snapshot: undefined, activeSessionId: undefined, sessions: [], workspace: undefined })
    this.d.pushState()
  }

  /** Discover the VS Code folder + matching harness workspace. Read-only.
   *  If no matching harness workspace exists, we don't create yet — the
   *  binding stays pending until the user's first Send. */
  private async discoverFolder(): Promise<void> {
    const folder = await pickVsCodeFolder(this.d.vscodeAPI.workspace, this.d.vscodeAPI.window)
    if (!folder) {
      this.noFolder = null
      this.d.setState({ workspace: null })
      return
    }
    const harness = await findHarnessWorkspace(this.d.client, folder)
    this.binding = { folder, harness }
    this.d.setState({ workspace: workspaceToUi(harness ?? null) })
    if (harness) await this.refreshSessions()
  }

  async refreshSessions(): Promise<void> {
    const ws = this.binding?.harness
    if (!ws) return
    try {
      const all = (await this.d.client.listSessions()).items
      const wsIds = new Set(ws.sessionIds)
      this.sessions = all.filter(s => wsIds.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)
      this.d.setState({ sessions: sessionsToUi(this.sessions, sessionLabel) })
      if (!this.activeSessionId && this.sessions.length > 0) {
        const first = this.sessions.find(s => !s.blank) ?? this.sessions[0]
        if (first) await this.selectSession(first.sessionId)
        return
      }
      this.d.pushState()
    } catch (e) {
      this.d.log.error('list sessions: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async selectSession(sessionId: SessionId): Promise<void> {
    this.activeSessionId = sessionId
    this.model = new ConversationModel(sessionId)
    this.model.setShowSystemMessages(this.d.getState().showSystemMessages)
    this.d.setState({ activeSessionId: sessionId, snapshot: this.model.snapshot() })
    try {
      await this.refetchHistory(sessionId)
      this.disposables.add(this.d.client.subscribe(sessionId, (frames) => {
        for (const f of frames) this.applyMuxFrame(f)
        this.d.pushState()
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('history/subscribe: ' + msg)
      this.d.notifyError(msg)
    }
    this.d.pushState()
  }

  private async refetchHistory(sessionId: SessionId): Promise<void> {
    if (!this.model) return
    const h = await this.d.client.getHistory(sessionId, { maxMessages: 50 })
    this.model.loadHistory(h.events.map(e => e.event))
    this.d.setState({ snapshot: this.model.snapshot() })
  }

  private applyMuxFrame(frame: unknown): void {
    if (!this.model || !this.activeSessionId) return
    const f = frame as { type?: string; sessionId?: string; event?: unknown; error?: unknown }
    if (f.type === 'session/event' && f.sessionId === this.activeSessionId && f.event) {
      this.model.applyEvent(f.event as Parameters<ConversationModel['applyEvent']>[0])
      this.d.setState({ snapshot: this.model.snapshot() })
      const snap = this.d.getState().snapshot
      this.d.setState({ canStop: snap?.running === true })
      return
    }
    if (f.type === 'approval/requested' || f.type === 'question/requested') {
      this.d.notifyInfo('Action requires approval in DeepSeek Harness Web UI')
      return
    }
    if (f.type === 'stream/error' && f.error) {
      const err = f.error as { message?: string }
      this.d.notifyError('Harness stream error: ' + (err.message ?? 'unknown'))
    }
  }

  async newSession(): Promise<void> {
    // Make sure workspace exists; user may be clicking this on a pending binding.
    const ws = this.binding?.harness ?? await this.ensureWorkspaceQuiet()
    if (!ws) return
    try {
      const res = await this.d.client.createSession({ workspaceId: ws.workspaceId })
      await this.refreshSessions()
      await this.selectSession(res.sessionId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    }
  }

  /** Send a prompt. Implements lazy workspace+session create (v0.0.2 UX):
   *  1. If no folder → tell user.
   *  2. If no harness workspace → ensureHarnessWorkspace (no modal).
   *  3. If no session → create session.
   *  4. Prompt.
   *
   * On failure the text is echoed back (caller's webview responsibility is
   * to clear input only after optimistic echo ack — which is automatic when
   * optimisticUserEcho runs, since the snapshot.renderVersion bump triggers
   * a render). We don't mutate textarea here.
   */
  async sendPrompt(text: string): Promise<void> {
    const st = this.d.getState()
    this.d.setState({ sending: true })
    this.d.pushState()
    try {
      // 1+2: ensure workspace
      let ws = this.binding?.harness
      if (!ws) {
        ws = await this.ensureWorkspaceQuiet()
        if (!ws) {
          if (this.noFolder === null) {
            this.d.notifyError('Open a VS Code folder first — DeepSeek Harness needs a workspace root.')
          }
          return
        }
      }
      // 3: ensure session
      if (!this.activeSessionId) {
        const created = await this.d.client.createSession({ workspaceId: ws.workspaceId })
        await this.refreshSessions()
        await this.selectSession(created.sessionId)
      }
      if (!this.activeSessionId) return
      // 4: optimistic echo → prompt
      this.model?.optimisticUserEcho(text)
      this.d.setState({ snapshot: this.model?.snapshot() })
      this.d.pushState()
      await this.d.client.prompt(this.activeSessionId, text, Intl.DateTimeFormat().resolvedOptions().timeZone)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    } finally {
      this.d.setState({ sending: false })
      this.d.pushState()
    }
  }

  /** Resolve-or-create a workspace, without user prompts. Errors bubble.
   *  Updates this.binding.harness on success. */
  private async ensureWorkspaceQuiet(): Promise<WorkspaceView | undefined> {
    if (!this.binding) {
      // Try picking folder once (discovery may have been skipped)
      const folder = await pickVsCodeFolder(this.d.vscodeAPI.workspace, this.d.vscodeAPI.window)
      if (!folder) { this.noFolder = null; return undefined }
      const existing = await findHarnessWorkspace(this.d.client, folder)
      this.binding = { folder, harness: existing }
    }
    if (!this.binding.harness) {
      const ws = await ensureHarnessWorkspace(this.d.client, this.binding)
      this.d.setState({ workspace: workspaceToUi(ws) })
      // Sessions list is out of date now (new workspace has none)
      this.sessions = []
      this.d.setState({ sessions: sessionsToUi(this.sessions, sessionLabel) })
    }
    return this.binding.harness
  }

  async stopActive(): Promise<void> {
    if (!this.activeSessionId) return
    try { await this.d.client.cancel(this.activeSessionId) } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    }
  }

  toggleSystemMessages(): void {
    const next = !this.d.getState().showSystemMessages
    this.model?.setShowSystemMessages(next)
    this.d.setState({
      showSystemMessages: next,
      snapshot: this.model?.snapshot() ?? this.d.getState().snapshot,
    })
    this.d.pushState()
  }

  /** Called by extension.ts on config change for showSystemMessages. */
  applyConfigShowSystem(v: boolean): void {
    if (v === this.d.getState().showSystemMessages) return
    this.model?.setShowSystemMessages(v)
    this.d.setState({
      showSystemMessages: v,
      snapshot: this.model?.snapshot() ?? this.d.getState().snapshot,
    })
    this.d.pushState()
  }

  /** Replace the underlying client (e.g. on host/port config change). */
  replaceClient(next: HarnessClient): void {
    this.disposables.dispose()
    // Rebuild state on new client; connect flow handled by caller.
  }

  // ─── helper: push client-derived state (onStateChange + onMuxStatusChange) ──
  private pushFromClient(): void {
    const conn = connectionToUi(this.d.client.getState(), this.muxStatus)
    this.d.setState({
      connection: conn.connection,
      hostInfo: conn.hostInfo,
      errorMessage: conn.errorMessage,
      muxStatus: conn.muxStatus,
    })
    this.d.pushState()
  }
}


