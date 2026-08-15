/**
 * SessionModel — folds the harness SessionEvent log into a renderable
 * conversation surface. The harness Session is the single source of truth
 * (§11): we never persist a second chat DB. History is loaded once, then live
 * session/event frames are applied incrementally.
 *
 * Render item vocabulary (deliberately minimal for v0.0.1):
 *   user         — a user-role message (text only; images are out of scope)
 *   assistant    — an assembled assistant message (text + tool-call refs)
 *   tool-call    — a tool invocation card (name + pretty arguments)
 *   tool-result  — a tool result card (text + isError flag)
 *   status       — a turn/step boundary line ("Turn 1 — completed")
 *
 * Unknown event types are ignored (§13 default-ignore) — the harness protocol
 * is merge-extensible, and a new event type must never crash the client.
 */

import type {
  AssistantChunkData, AssistantMessageData, ContentBlock, SessionEvent,
  SessionId, SessionSummary, ToolCallData, ToolResultData, TurnEndData,
  UserMessageData,
} from './harness/protocol.ts'

export interface UserItem {
  kind: 'user'; seq: number; text: string; source?: string
  /** True when this user/message was injected by a plugin (e.g.
   *  @deepseek-ai/dsh-system-prompt runtime context, user-approval notices)
   *  rather than typed by a human. Hidden by default (§showSystemMessages). */
  system?: boolean
}
export interface AssistantItem { kind: 'assistant'; seq: number; text: string; reasoning?: string; toolCalls: Array<{ callId?: string; name?: string; arguments?: string }>; usage?: { inputTokens?: number; outputTokens?: number }; streaming: boolean }
export interface ToolCallItem { kind: 'tool-call'; seq: number; callId: string; name: string; arguments: string }
export interface ToolResultItem { kind: 'tool-result'; seq: number; callId?: string; text: string; isError: boolean }
export interface StatusItem { kind: 'status'; seq: number; text: string; running: boolean }

export type RenderItem = UserItem | AssistantItem | ToolCallItem | ToolResultItem | StatusItem

export interface SessionSnapshot {
  sessionId: SessionId
  title?: string
  running: boolean
  items: RenderItem[]
  /** Seq of the last event folded into the model (for diagnostics). */
  lastSeq: number
  /** Number of plugin-injected system messages currently hidden. */
  systemMessageCount: number
}

/** Extract displayable text from a content-block array (defensive — upstream is merge-extensible). */
function blocksToText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b) {
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'reasoning' && typeof b.text === 'string') { /* reasoning folded separately */ }
      else if (b.type === 'tool-result') {
        const inner = blocksToText(b.content as ContentBlock[] | undefined)
        if (inner) parts.push(inner)
      }
    }
  }
  return parts.join('\n').trim()
}

function extractReasoning(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b && b.type === 'reasoning' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

function sourceLabel(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const s = source as { kind?: string; plugin?: string }
  if (s.kind === 'user') return undefined // human-typed; no label needed
  if (s.kind && s.plugin) return `${s.plugin}`
  if (s.kind) return s.kind
  return undefined
}

/** True when the user/message was injected by a plugin/agent rather than typed
 *  by a human. source.kind === 'user' is the human-typed path; anything else
 *  (kind 'plugin', 'agent', etc.) is a system injection to hide by default. */
function isSystemSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const s = source as { kind?: string }
  return s.kind !== 'user'
}

/** Pretty-print a tool arguments JSON string; fall back to the raw string. */
export function prettyToolArgs(raw: string): string {
  if (!raw) return ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

export class SessionModel {
  private items: RenderItem[] = []
  private running = false
  private title: string | undefined
  private lastSeq = -1
  /** Whether plugin-injected user/messages (system prompts, approval notices)
   *  are included in the snapshot. Hidden by default. */
  private showSystemMessages = false
  /** Pending assistant text per (turn,step) while chunks stream, before assistant/message finalizes. */
  private streaming = new Map<string, { text: string; reasoning: string }>()

  constructor(private readonly sessionId: SessionId) {}

  /** Toggle visibility of plugin-injected system messages. Off by default. */
  setShowSystemMessages(show: boolean): void {
    this.showSystemMessages = show
  }

  /** Seed the model from a history page (applied in seq order). */
  loadHistory(events: SessionEvent[]): void {
    // History is authoritative — reset and re-fold. The tail page may carry
    // the in-flight partial (chunks for an unfinalized message).
    this.items = []
    this.running = false
    this.lastSeq = -1
    this.streaming.clear()
    for (const e of events) this.applyEvent(e)
  }

  /** Apply one live session/event frame (idempotent on seq — replays are safe). */
  applyEvent(event: SessionEvent): void {
    if (event.seq <= this.lastSeq && this.lastSeq !== -1) return // already folded
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    switch (event.type) {
      case 'user/message': this.applyUserMessage(event); break
      case 'assistant/chunk': this.applyAssistantChunk(event); break
      case 'assistant/message': this.applyAssistantMessage(event); break
      case 'tool/call': this.applyToolCall(event); break
      case 'tool/result': this.applyToolResult(event); break
      case 'turn/start': this.applyTurnStart(event); break
      case 'turn/end': this.applyTurnEnd(event); break
      case 'session/title': this.applyTitle(event); break
      // step/*, request/*, session/end-seed, command/*, permission/*, sandbox/*,
      // approval/*, agent/inbox/*, session/title-llm-request, todo/write, etc.:
      // ignored per §13. New event types must not crash the client.
      default: break
    }
  }

  /** Optimistic echo of a just-sent prompt (§12) — replaced when the harness
   *  emits the authoritative user/message event for that turn. */
  optimisticUserEcho(text: string): void {
    const seq = this.lastSeq + 0.5 // fractional seq sorts after the last real event
    this.items.push({ kind: 'user', seq, text, source: undefined })
  }

  snapshot(): SessionSnapshot {
    const systemMessageCount = this.items.filter(i => i.kind === 'user' && i.system).length
    const items = this.showSystemMessages
      ? this.items
      : this.items.filter(i => !(i.kind === 'user' && i.system))
    return {
      sessionId: this.sessionId,
      title: this.title,
      running: this.running,
      items: items.map(i => ({ ...i })),
      lastSeq: this.lastSeq,
      systemMessageCount,
    }
  }

  // ─── per-type folds ─────────────────────────────────────────────────────────
  private applyUserMessage(event: SessionEvent): void {
    const d = event.data as UserMessageData
    const text = blocksToText(d.content)
    // Drop an optimistic echo of the same text if one is pending at the tail.
    const last = this.items[this.items.length - 1]
    if (last && last.kind === 'user' && last.text === text && !Number.isInteger(last.seq)) {
      this.items.pop()
    }
    if (!text) return
    // A user/message with source.kind !== 'user' is plugin-injected (e.g.
    // @deepseek-ai/dsh-system-prompt runtime context, user-approval notices).
    // Flag it so the view can hide it by default.
    const system = isSystemSource(d.source)
    this.items.push({ kind: 'user', seq: event.seq, text, source: sourceLabel(d.source), system })
  }

  private applyAssistantChunk(event: SessionEvent): void {
    const d = event.data as AssistantChunkData
    const key = `${d.turn}:${d.step}`
    let entry = this.streaming.get(key)
    if (!entry) { entry = { text: '', reasoning: '' }; this.streaming.set(key, entry) }
    const c = d.chunk
    if (c.type === 'text-delta' && typeof c.text === 'string') entry.text += c.text
    else if (c.type === 'reasoning-delta' && typeof c.text === 'string') entry.reasoning += c.text

    // Live-update the streaming assistant item at the tail (or create it).
    const last = this.items[this.items.length - 1]
    if (last && last.kind === 'assistant' && last.streaming && last.seq === -d.turn - d.step / 1000) {
      last.text = entry.text
      last.reasoning = entry.reasoning || undefined
    } else if (entry.text || entry.reasoning) {
      this.items.push({
        kind: 'assistant',
        seq: -d.turn - d.step / 1000, // synthetic seq: sorts below real events of the same turn
        text: entry.text,
        reasoning: entry.reasoning || undefined,
        toolCalls: [],
        streaming: true,
      })
    }
  }

  private applyAssistantMessage(event: SessionEvent): void {
    const d = event.data as AssistantMessageData
    const key = `${d.turn}:${d.step}`
    this.streaming.delete(key)
    const msg = d.message
    const text = blocksToText(msg.content)
    const reasoning = extractReasoning(msg.content)
    const toolCalls = (msg.content ?? [])
      .filter((b): b is { type: 'tool-call'; id?: string; name?: string; arguments?: string } =>
        b?.type === 'tool-call')
      .map(b => ({ callId: b.id, name: b.name, arguments: b.arguments }))
    // Replace the streaming placeholder (matched by synthetic seq) if present.
    const synthSeq = -d.turn - d.step / 1000
    const idx = this.items.findIndex(i => i.kind === 'assistant' && i.seq === synthSeq)
    const item: AssistantItem = {
      kind: 'assistant', seq: event.seq, text, reasoning: reasoning || undefined, toolCalls, usage: d.usage, streaming: false,
    }
    if (idx >= 0) this.items[idx] = item
    else this.items.push(item)
  }

  private applyToolCall(event: SessionEvent): void {
    const d = event.data as ToolCallData
    this.items.push({ kind: 'tool-call', seq: event.seq, callId: d.callId, name: d.name, arguments: d.arguments })
  }

  private applyToolResult(event: SessionEvent): void {
    const d = event.data as ToolResultData
    const block = (d.message.content ?? []).find((b): b is { type: 'tool-result'; toolCallId?: string; content?: ContentBlock[]; isError?: boolean } => b?.type === 'tool-result')
    const text = blocksToText(block?.content) || '(no output)'
    this.items.push({
      kind: 'tool-result',
      seq: event.seq,
      callId: block?.toolCallId ?? d.message.source?.callId,
      text,
      isError: block?.isError === true || d.error !== undefined,
    })
  }

  private applyTurnStart(event: SessionEvent): void {
    const d = event.data as { turn: number }
    this.running = true
    this.items.push({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — started`, running: true })
  }

  private applyTurnEnd(event: SessionEvent): void {
    const d = event.data as TurnEndData
    this.running = false
    this.streaming.clear()
    const reason = d.reason?.kind ?? 'unknown'
    this.items.push({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — ${reason}`, running: false })
  }

  private applyTitle(event: SessionEvent): void {
    const d = event.data as { title?: string }
    if (typeof d.title === 'string' && d.title.length > 0) this.title = d.title
  }
}

/** Human-readable label for a session dropdown entry. */
export function sessionLabel(s: SessionSummary, fallbackIndex: number): string {
  const stamp = new Date(s.updatedAt).toLocaleString()
  const id8 = s.sessionId.replace(/^session-/, '').slice(0, 8)
  const state = s.running ? '● ' : (s.blank ? '○ ' : '')
  // Prefer the AI-generated projection title (same "summary" the web UI shows);
  // fall back to the sessionId hash prefix for blank/untitled sessions.
  const title = s.projections?.values?.title
  if (title && !s.blank) return `${state}${fallbackIndex}. ${title} — ${stamp}`
  return `${state}${fallbackIndex}. ${id8} — ${stamp}`
}
