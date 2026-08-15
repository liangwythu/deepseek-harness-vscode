/**
 * HarnessClient — the single network boundary for the extension.
 *
 * All HTTP and WebSocket access goes through here; the rest of the extension
 * never calls fetch or opens a WebSocket directly (§8). The wire format mirrors
 * `@deepseek-ai/dsh-host-apiproxy/api` exactly:
 *
 *   POST /api/<method>
 *     Content-Type: application/json
 *     body: { type: 'client-request', rpcId, method, payload }
 *     resp: { type: 'server-response', rpcId, result: { ok, value | error } }
 *
 *   GET  /api/events.mux  (WebSocket upgrade; 426 on plain GET)
 *     frame: { type: 'server-request', rpcId, method, payload: MuxFrame }
 *
 * v0.0.x security boundary (§3): only 127.0.0.1 / localhost are accepted.
 * The harness trust fence enforces the same on the server side.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable } from '../disposable.ts'
import { CompositeDisposable } from '../disposable.ts'
import { EventBuffer, MuxStream, type MuxStatus } from './events.ts'
import type {
  ClientRequest, HistoryEntry, HostDescribe, MuxFrame, PromptContentPart,
  RpcError, ServerResponse, SessionId, SessionSummary, WorkspaceId, WorkspaceView,
} from './protocol.ts'

/** A typed view onto a business error from the harness. */
export class HarnessRpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown) {
    super(message)
    this.name = 'HarnessRpcError'
  }
}

/** Connection states surfaced to the UI. */
export type ConnectionState =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; describe: HostDescribe }
  | { kind: 'error'; message: string }

/** Listener for the active session's event stream (already filtered by sessionId). */
export type SessionEventListener = (frame: MuxFrame) => void

export interface HarnessClientOptions {
  host: string
  port: number
  log: (msg: string) => void
}

/** v0.0.x: only loopback hosts are accepted. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export class HarnessClient implements Disposable {
  private readonly disposables = new CompositeDisposable()
  private state: ConnectionState = { kind: 'disconnected' }
  private mux: MuxStream | undefined
  /** Active session filter; only frames for this session reach `sessionListeners`. */
  private activeSessionId: SessionId | undefined
  private readonly sessionListeners = new Set<SessionEventListener>()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private readonly muxStatusListeners = new Set<(s: MuxStatus) => void>()
  private buffer: EventBuffer | undefined

  constructor(private readonly opts: HarnessClientOptions) {}

  // ─── state ──────────────────────────────────────────────────────────────────
  getState(): ConnectionState { return this.state }
  onStateChange(listener: (s: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener)
    return { dispose: () => { this.stateListeners.delete(listener) } }
  }
  onMuxStatusChange(listener: (s: MuxStatus) => void): Disposable {
    this.muxStatusListeners.add(listener)
    return { dispose: () => { this.muxStatusListeners.delete(listener) } }
  }
  private setState(s: ConnectionState): void {
    this.state = s
    for (const l of this.stateListeners) {
      try { l(s) } catch { /* listener errors must not propagate */ }
    }
  }

  // ─── connect / disconnect ───────────────────────────────────────────────────
  /**
   * Validate the host is loopback, probe host.describe, and open the mux
   * downlink. Throws on security-boundary violation or unreachable host.
   */
  async connect(): Promise<void> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      const msg = 'v0.0.x only supports local DeepSeek Harness instances.'
      this.setState({ kind: 'error', message: msg })
      throw new Error(msg)
    }
    if (this.state.kind === 'connected' || this.state.kind === 'connecting') return
    this.setState({ kind: 'connecting' })
    try {
      const describe = await this.rpc<HostDescribe>('host.describe', {})
      this.setState({ kind: 'connected', describe })
      this.openMux()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ kind: 'error', message })
      throw e
    }
  }

  disconnect(): void {
    if (this.mux) { this.mux.dispose(); this.mux = undefined }
    if (this.buffer) { this.buffer.dispose(); this.buffer = undefined }
    this.activeSessionId = undefined
    this.setState({ kind: 'disconnected' })
  }

  dispose(): void {
    this.disconnect()
    this.disposables.dispose()
  }

  // ─── unary RPCs (the only methods business code may call) ───────────────────
  describe(): Promise<HostDescribe> { return this.rpc<HostDescribe>('host.describe', {}) }

  listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }> {
    return this.rpc('workspace.list', {})
  }

  /** Create or idempotently resolve a workspace over an existing directory. */
  createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc('workspace.create', { path })
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    return this.rpc('session.list', {})
  }

  getHistory(sessionId: SessionId, opts: { beforeSeq?: number; maxMessages?: number } = {}): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    return this.rpc('session.history', { sessionId, ...opts })
  }

  createSession(opts: { workspaceId?: WorkspaceId; cwd?: string } = {}): Promise<{ sessionId: SessionId; agentPreset?: string }> {
    return this.rpc('session.create', opts)
  }

  /** Send a text prompt to an existing session (mode 'queue' = normal send). */
  prompt(sessionId: SessionId, text: string, clientTimeZone?: string): Promise<{ accepted: true; command?: { kind: 'success'; text?: string } }> {
    const content: PromptContentPart[] = [{ type: 'text', text }]
    return this.rpc('session.prompt', { sessionId, mode: 'queue', content, clientTimeZone })
  }

  /** Cancel the session's active turn (preserves pending inbox work). */
  cancel(sessionId: SessionId): Promise<{ accepted: true }> {
    return this.rpc('session.cancel', { sessionId })
  }

  // ─── event subscription ─────────────────────────────────────────────────────
  /**
   * Subscribe to frames for `sessionId`. Frames for other sessions are dropped.
   * The buffer coalesces high-frequency chunks; `onFlush` receives batches.
   */
  subscribe(sessionId: SessionId, onFlush: (frames: MuxFrame[]) => void, opts: { flushMs?: number } = {}): Disposable {
    this.activeSessionId = sessionId
    if (this.buffer) { this.buffer.dispose(); this.buffer = undefined }
    this.buffer = new EventBuffer((batch) => onFlush(batch as MuxFrame[]), opts.flushMs ?? 30)
    const listener: SessionEventListener = (frame) => {
      const fs = frame as { sessionId?: string }
      if (fs.sessionId !== undefined && fs.sessionId !== sessionId) return
      // turn/end and stream/error flush immediately so the UI settles at once.
      const t = (frame as { type?: string }).type
      if (t === 'stream/error') { this.buffer?.flushNow(); return }
      this.buffer?.push(frame)
      if (t === 'session/event') {
        const evt = (frame as { event?: { type?: string } }).event
        if (evt?.type === 'turn/end' || evt?.type === 'assistant/message') this.buffer?.flushNow()
      }
    }
    this.sessionListeners.add(listener)
    // If the mux is already open, the subscription is live. Otherwise connect()
    // will open it; the harness replays pending approval/question frames on open.
    if (!this.mux) this.openMux()
    return {
      dispose: () => {
        this.sessionListeners.delete(listener)
        if (this.activeSessionId === sessionId) this.activeSessionId = undefined
        if (this.buffer) { this.buffer.dispose(); this.buffer = undefined }
      },
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────
  private async rpc<V>(method: string, payload: unknown): Promise<V> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      throw new Error('v0.0.1 only supports local DeepSeek Harness instances.')
    }
    const req: ClientRequest = { type: 'client-request', rpcId: randomUUID(), method, payload }
    const url = `http://${this.opts.host}:${this.opts.port}/api/${method}`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach dsh web at ${this.opts.host}:${this.opts.port} — ${message}`)
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} on /api/${method}`)
    }
    const env = (await res.json()) as ServerResponse<V>
    if (!env.result.ok) {
      const err = env.result.error as RpcError
      throw new HarnessRpcError(err.code, err.message, err.details)
    }
    return env.result.value
  }

  private openMux(): void {
    if (this.mux) return
    const url = `ws://${this.opts.host}:${this.opts.port}/api/events.mux`
    this.mux = new MuxStream({
      url,
      onFrame: (frame) => {
        // Notify every listener; the active-session filter lives in subscribe().
        for (const l of this.sessionListeners) {
          try { l(frame) } catch { /* listener errors must not break the stream */ }
        }
      },
      onStatus: (s) => {
        this.opts.log(`mux ${s.kind}${'reason' in s ? `: ${s.reason}` : ''}${'message' in s ? `: ${s.message}` : ''}`)
        for (const l of this.muxStatusListeners) {
          try { l(s) } catch { /* noop */ }
        }
      },
      log: this.opts.log,
    })
    this.mux.open()
  }
}
