/**
 * Protocol Spike — standalone validation of the DeepSeek Harness Web Host API.
 *
 * Run:  npm run spike            # read-only validation (steps 1–5, 7–8)
 * Run:  npm run spike -- --prompt  # also exercises prompt + events + cancel
 *
 * Validates the 9 protocol steps from goal.md §6 against the running `dsh web`:
 *   1. connect dsh web           6. prompt an existing session
 *   2. host.describe             7. open events.mux (SSE)
 *   3. workspace.list            8. receive session events
 *   4. session.list              9. cancel the active session
 *   5. session.history
 *
 * Authoritative contract source: deepseek-harness/packages/host/apiproxy/src/api/
 * Wire format:
 *   POST /api/<method>  Content-Type: application/json
 *     body: { type: 'client-request', rpcId, method, payload }
 *     resp: { type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 *   GET  /api/events.mux  (SSE; first ": connected\n\n", then "data: <ServerRequest JSON>\n\n")
 *
 * This file deliberately imports NO vscode — it must run under plain Node.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── configuration ────────────────────────────────────────────────────────────
const HOST = process.env.DSH_HOST ?? '127.0.0.1'
const PORT = Number(process.env.DSH_PORT ?? 3080)
const BASE = `http://${HOST}:${PORT}`
const WITH_PROMPT = process.argv.includes('--prompt')
const FIXTURE_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'test', 'fixtures')

// ─── wire types (mirror of src/harness/protocol.ts; kept inline so the spike is self-contained) ──
type RpcId = string
interface ClientRequest<P = unknown> { type: 'client-request'; rpcId: RpcId; method: string; payload: P }
interface ServerResponse<V = unknown> { type: 'server-response'; rpcId: RpcId; result: { ok: true; value: V } | { ok: false; error: { code: string; message: string; details: unknown } } }
interface ServerRequest<P = unknown> { type: 'server-request'; rpcId: RpcId; method: string; payload: P }

// ─── tiny RPC client ──────────────────────────────────────────────────────────
class RpcError extends Error {
  constructor(public code: string, message: string, public details: unknown) { super(message) }
}
async function rpc<V>(method: string, payload: unknown, signal?: AbortSignal): Promise<V> {
  const req: ClientRequest = { type: 'client-request', rpcId: randomUUID(), method, payload }
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  }
  if (signal) init.signal = signal
  const res = await fetch(`${BASE}/api/${method}`, init)
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} on /api/${method}`)
  const env = (await res.json()) as ServerResponse<V>
  if (!env.result.ok) throw new RpcError(env.result.error.code, env.result.error.message, env.result.error.details)
  return env.result.value
}

// ─── WebSocket reader for /api/events.mux ────────────────────────────────────
// The harness upgrades /api/events.mux to a downlink-only WebSocket: the client
// only receives JSON ServerRequest envelopes as text frames — sending anything
// closes the socket with 1008 "downlink only". A plain GET returns 426.
async function* openMux(signal: AbortSignal): AsyncIterable<ServerRequest> {
  const wsUrl = `ws://${HOST}:${PORT}/api/events.mux`
  // Node 22+ ships a global WebSocket. The harness trust fence requires a
  // loopback Host header, which the browser-style WebSocket sets from the URL.
  const ws = new WebSocket(wsUrl)
  const queue: ServerRequest[] = []
  let done = false
  let waiter: ((v: IteratorResult<ServerRequest>) => void) | null = null
  const fail = (err: unknown): void => {
    if (done) return
    done = true
    if (waiter) {
      const w = waiter; waiter = null
      w({ done: true, value: undefined })
    }
    if (!signal.aborted) console.warn(`  (mux stream: ${err instanceof Error ? err.message : String(err)})`)
  }
  ws.addEventListener('open', () => { /* connected */ })
  ws.addEventListener('message', (ev: MessageEvent) => {
    try {
      const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as ServerRequest
      if (waiter) { const w = waiter; waiter = null; w({ done: false, value: parsed }) }
      else queue.push(parsed)
    } catch { /* skip malformed */ }
  })
  ws.addEventListener('close', () => fail('socket closed'))
  ws.addEventListener('error', (ev: Event) => fail(ev))
  signal.addEventListener('abort', () => { try { ws.close() } catch { /* noop */ } })
  try {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift() as ServerRequest
        continue
      }
      const next = await new Promise<IteratorResult<ServerRequest>>((resolve) => { waiter = resolve })
      if (next.done) break
      yield next.value
    }
  } finally {
    try { ws.close() } catch { /* noop */ }
  }
}

// ─── sanitized fixture writer ─────────────────────────────────────────────────
function sanitizeText(s: string): string {
  // Redact any text content in fixtures; the shape is what matters for drift detection.
  if (typeof s !== 'string') return s
  if (s.length <= 12) return '<redacted>'
  return `<redacted:len=${s.length}>`
}
function sanitizeEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const e = event as Record<string, unknown>
  const data = e.data as Record<string, unknown> | undefined
  // Recursively redact likely-sensitive string fields while preserving shape.
  const REDACT = new Set(['text', 'content', 'arguments', 'message', 'system', 'snippet', 'reason', 'name'])
  const redact = (v: unknown): unknown => {
    if (typeof v === 'string') return sanitizeText(v)
    if (Array.isArray(v)) return v.length ? [redact(v[0])] : []
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v)) out[k] = REDACT.has(k) && typeof val === 'string' ? sanitizeText(val) : redact(val)
      return out
    }
    return v
  }
  return { ...e, data: data ? redact(data) : data }
}
async function saveFixture(name: string, value: unknown): Promise<void> {
  const path = join(FIXTURE_DIR, `${name}.json`)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
  console.log(`  ✓ fixture → test/fixtures/${name}.json`)
}

// ─── test runner ──────────────────────────────────────────────────────────────
const results: Array<{ step: string; ok: boolean; detail: string }> = []
function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${step}: ${detail}`)
}

async function main(): Promise<void> {
  console.log(`\nDeepSeek Harness Protocol Spike → ${BASE}\n`)

  // Step 1+2: connect + host.describe
  try {
    const describe = await rpc<{
      version: string; cwd: string; provider?: string; model?: string;
      attachedSessions: number; canOpenPath: boolean
    }>('host.describe', {})
    check('01 connect + host.describe', true, `v${describe.version} cwd=${describe.cwd} attached=${describe.attachedSessions} provider=${describe.provider ?? '-'} model=${describe.model ?? '-'}`)
    await saveFixture('host-describe', describe)
  } catch (e) {
    check('01 connect + host.describe', false, (e as Error).message)
    console.log('\nSpike aborted: cannot reach dsh web. Is `dsh web` running on', BASE, '?')
    printSummary(); process.exit(1)
  }

  // Step 3: workspace.list
  let workspaces: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }> = []
  try {
    const r = await rpc<{ items: typeof workspaces; archivedSessionIds: string[] }>('workspace.list', {})
    workspaces = r.items
    check('03 workspace.list', true, `${workspaces.length} workspace(s)`)
    await saveFixture('workspace-list', { items: workspaces.slice(0, 2).map(w => ({ ...w, path: '<redacted>', title: sanitizeText(w.title) })), archivedSessionIds: r.archivedSessionIds })
  } catch (e) {
    check('03 workspace.list', false, (e as Error).message)
  }

  // Step 4: session.list
  let sessions: Array<{ sessionId: string; updatedAt: number; running: boolean; blank: boolean; cwd?: string }> = []
  try {
    const r = await rpc<{ items: typeof sessions }>('session.list', {})
    sessions = r.items
    check('04 session.list', true, `${sessions.length} session(s) (${sessions.filter(s => s.running).length} running)`)
    await saveFixture('session-list', { items: sessions.slice(0, 3).map(s => ({ ...s, cwd: s.cwd ? '<redacted>' : undefined })) })
  } catch (e) {
    check('04 session.list', false, (e as Error).message)
  }

  // Step 5: session.history on the first non-blank session
  let historySessionId: string | undefined
  if (sessions.length > 0) {
    const target = sessions.find(s => !s.blank) ?? sessions[0]
    if (target) {
    historySessionId = target.sessionId
    try {
      const h = await rpc<{ events: Array<{ event: unknown; view?: unknown }>; hasMore: boolean }>(
        'session.history', { sessionId: target.sessionId, maxMessages: 20 })
      check('05 session.history', true, `${h.events.length} event(s), hasMore=${h.hasMore}`)
      await saveFixture('session-history', {
        sessionId: '<redacted>',
        hasMore: h.hasMore,
        events: h.events.slice(0, 4).map(e => ({ event: sanitizeEvent(e.event), view: e.view })),
      })
    } catch (e) {
      check('05 session.history', false, (e as Error).message)
    }
    }
  } else {
    check('05 session.history', false, 'no sessions to read')
  }

  // Step 7+8: open events.mux and listen briefly for any frames
  let receivedFrame: ServerRequest | undefined
  let muxOk = false
  try {
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 4000)
    for await (const frame of openMux(ac.signal)) {
      receivedFrame = frame
      muxOk = true
      // Capture one frame as a fixture (sanitized) then stop.
      break
    }
    clearTimeout(timeout)
    check('07 events.mux open', muxOk, muxOk ? `received first frame (method=${receivedFrame?.method})` : 'stream opened, no frame in 4s (idle host is OK)')
    if (receivedFrame) {
      await saveFixture('session-event', {
        method: receivedFrame.method,
        payload: receivedFrame.method === 'session/event'
          ? { type: 'session/event', sessionId: '<redacted>', event: sanitizeEvent((receivedFrame.payload as { event: unknown }).event) }
          : receivedFrame.payload,
      })
    }
  } catch (e) {
    check('07 events.mux open', false, (e as Error).message)
  }

  // Step 6 + 8 + 9: prompt an existing session, watch events, then cancel.
  // Only runs with --prompt: a real prompt consumes model credits.
  if (WITH_PROMPT && historySessionId) {
    const sid = historySessionId
    const promptText = `[vscode-spike] protocol ping ${new Date().toISOString()}`
    try {
      // Open a fresh mux listener that filters to this session, in parallel with the prompt.
      const ac = new AbortController()
      const events: unknown[] = []
      const watcher = (async () => {
        for await (const frame of openMux(ac.signal)) {
          if (frame.method === 'session/event' && (frame.payload as { sessionId?: string }).sessionId === sid) {
            events.push(sanitizeEvent((frame.payload as { event: unknown }).event))
          }
          if (events.length >= 3) break
        }
      })()
      const promptRes = await rpc<{ accepted: true; command?: { kind: 'success'; text?: string } }>(
        'session.prompt', { sessionId: sid, mode: 'queue', content: [{ type: 'text', text: promptText }], clientTimeZone: 'UTC' })
      check('06 session.prompt', true, `accepted=${promptRes.accepted}`)
      await saveFixture('session-prompt', { request: { mode: 'queue', content: [{ type: 'text', text: sanitizeText(promptText) }] }, response: promptRes })

      // Give the agent up to 8s to stream at least one event back.
      const raced = await Promise.race([
        watcher.then(() => 'completed' as const),
        new Promise<'timeout'>((r) => setTimeout(() => { ac.abort(); r('timeout') }, 8000)),
      ])
      check('08 receive session events', events.length > 0, events.length > 0
        ? `received ${events.length} event(s) for ${sid.slice(0, 8)}… (${raced})`
        : `no events in 8s (${raced}); session may be idle/queued`)

      // Step 9: cancel — always attempt, even if events arrived, to validate the wire.
      try {
        const cancelRes = await rpc<{ accepted: true }>('session.cancel', { sessionId: sid })
        check('09 session.cancel', true, `accepted=${cancelRes.accepted}`)
      } catch (e) {
        check('09 session.cancel', false, (e as Error).message)
      }
      ac.abort()
    } catch (e) {
      const code = e instanceof RpcError ? `${e.code}: ` : ''
      check('06 session.prompt', false, code + (e as Error).message)
    }
  } else if (WITH_PROMPT) {
    check('06 session.prompt', false, 'no existing session to prompt')
  } else {
    console.log('\n  (skipping steps 6/8/9 — pass --prompt to exercise prompt+events+cancel)')
  }

  printSummary()
  const failed = results.filter(r => !r.ok).length
  process.exit(failed === 0 ? 0 : 1)
}

function printSummary(): void {
  const passed = results.filter(r => r.ok).length
  console.log(`\n────────────────────────────────────────`)
  console.log(`  ${passed}/${results.length} steps passed`)
  console.log(`────────────────────────────────────────\n`)
}

main().catch((e) => { console.error(e); process.exit(1) })
