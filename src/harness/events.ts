/**
 * Event-stream layer: the WebSocket downlink for /api/events.mux, plus the
 * EventBuffer that coalesces assistant chunks into ~30ms flushes.
 *
 * Wire facts (validated by the protocol spike):
 *   - /api/events.mux is a downlink-only WebSocket. A plain GET returns 426.
 *   - Each text frame is one JSON `ServerRequest` envelope:
 *       { type: 'server-request', rpcId, method, payload: MuxFrame }
 *   - Sending any client message closes the socket with code 1008 'downlink only'.
 *   - The harness trust fence requires a loopback Host header; the browser-style
 *     WebSocket sets Host from the URL, so loopback URLs pass naturally.
 *
 * Reconnect (§15): the harness resume semantic is rebuild — reopen the stream
 * and refetch history. No cursor resume. We retry with backoff.
 */

import type { Disposable } from '../disposable.ts'
import type { MuxFrame, ServerRequest } from './protocol.ts'

/** A listener receives every mux frame the host pushes, unfiltered. */
export type MuxListener = (frame: MuxFrame, envelope: ServerRequest<MuxFrame>) => void

export interface MuxStreamOptions {
  /** ws://host:port/api/events.mux */
  url: string
  onFrame: MuxListener
  onStatus: (status: MuxStatus) => void
  /** Logger sink for diagnostics (not surfaced to UI). */
  log?: (msg: string) => void
}

export type MuxStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason: string }
  | { kind: 'error'; message: string }

/** Reconnect backoff: 250ms, 500ms, 1s, 2s, 5s (capped). */
const BACKOFF_STEPS = [250, 500, 1000, 2000, 5000] as const

/**
 * Manages one WebSocket downlink with automatic reconnect. The harness pushes
 * frames; we never send. On close, we reconnect with backoff and let the caller
 * refetch history (the documented rebuild semantic).
 */
export class MuxStream implements Disposable {
  private ws: WebSocket | undefined
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private readonly opts: MuxStreamOptions

  constructor(opts: MuxStreamOptions) {
    this.opts = opts
  }

  /** Open (or reopen) the downlink. Idempotent if already open. */
  open(): void {
    if (this.disposed) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.setStatus({ kind: 'connecting' })
    const ws = new WebSocket(this.opts.url)
    this.ws = ws
    ws.addEventListener('open', () => {
      this.backoff = 0
      this.setStatus({ kind: 'open' })
    })
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerRequest<MuxFrame>
        if (env && env.type === 'server-request' && env.payload && typeof env.payload === 'object') {
          this.opts.onFrame(env.payload as MuxFrame, env)
        }
      } catch (e) {
        this.opts.log?.(`mux: dropped malformed frame (${e instanceof Error ? e.message : String(e)})`)
      }
    })
    ws.addEventListener('close', (ev: CloseEvent) => {
      this.opts.log?.(`mux: closed (code=${ev.code} reason=${ev.reason || '—'})`)
      if (this.disposed) { this.setStatus({ kind: 'closed', reason: ev.reason || 'disposed' }); return }
      this.setStatus({ kind: 'closed', reason: ev.code === 1008 ? 'downlink-only violation' : `code ${ev.code}` })
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // The 'error' event carries no detail in the browser WS API; the close
      // event that follows is where we report and reconnect. Surface a generic
      // error status only if no close follows shortly.
      this.opts.log?.('mux: error event')
      this.setStatus({ kind: 'error', message: 'websocket error' })
    })
  }

  /** Force-close without reconnect (used when the user disconnects). */
  close(): void {
    this.disposed = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    if (this.ws) { try { this.ws.close() } catch { /* noop */ } this.ws = undefined }
    this.setStatus({ kind: 'closed', reason: 'closed' })
  }

  dispose(): void { this.close() }

  private scheduleReconnect(): void {
    if (this.disposed) return
    const delay = BACKOFF_STEPS[Math.min(this.backoff, BACKOFF_STEPS.length - 1)]
    this.backoff += 1
    this.opts.log?.(`mux: reconnecting in ${delay}ms (attempt ${this.backoff})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }

  private setStatus(s: MuxStatus): void {
    try { this.opts.onStatus(s) } catch { /* listener errors must not break the stream */ }
  }
}

/**
 * EventBuffer — coalesces high-frequency assistant chunks into periodic flushes
 * so the webview does not render once per token (§14). Default flush: 30ms.
 *
 * Usage: call `push(event)` for every session/event frame; the buffer invokes
 * `onFlush` at most every `flushMs` with the batched events. `flushNow()`
 * forces a drain (used on turn/end or dispose).
 */
export class EventBuffer implements Disposable {
  private pending: unknown[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly onFlush: (events: unknown[]) => void,
    private readonly flushMs = 30,
  ) {}

  push(event: unknown): void {
    if (this.disposed) return
    this.pending.push(event)
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.drain(), this.flushMs)
    }
  }

  /** Drain immediately (e.g. on turn/end so the final state renders at once). */
  flushNow(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.drain()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.drain()
  }

  private drain(): void {
    this.timer = undefined
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    try { this.onFlush(batch) } catch { /* a flush failure must not kill the buffer */ }
  }
}
