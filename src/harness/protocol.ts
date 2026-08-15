/**
 * Wire protocol types — a faithful, dependency-free mirror of the DeepSeek
 * Harness `@deepseek-ai/dsh-host-apiproxy/api` contract. This file is the
 * single source of truth for everything that crosses the network.
 *
 * Authoritative upstream: deepseek-harness/packages/host/apiproxy/src/api/
 * The harness protocol is merge-extensible: unknown event/frame types MUST be
 * ignored by callers (default policy), so every union here is treated as open.
 *
 * No runtime code lives here — types only (plus a few narrowing guards).
 */

// ─── brands (opaque string ids; structural, same as upstream) ─────────────────
export type RpcId = string
export type SessionId = string
export type WorkspaceId = string
export type CallId = string
export type MessageId = string

// ─── RPC envelope (the four-quadrant message model) ──────────────────────────
export interface ClientRequest<P = unknown> {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: P
}

export interface ServerResponse<V = unknown> {
  type: 'server-response'
  rpcId: RpcId
  result: { ok: true; value: V } | { ok: false; error: RpcError }
}

/** Server-initiated message — frames on the mux WebSocket, or any push. */
export interface ServerRequest<P = unknown> {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: P
}

export interface RpcError {
  code: string
  message: string
  details: unknown
}

// ─── host.describe ───────────────────────────────────────────────────────────
export interface HostDescribe {
  version: string
  cwd: string
  provider?: string
  model?: string
  attachedSessions: number
  canOpenPath: boolean
}

// ─── workspace domain ────────────────────────────────────────────────────────
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

// ─── session domain ──────────────────────────────────────────────────────────
export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  /** Server-side projections (title, stats, etc.) — the same view the web UI renders. */
  projections?: {
    asOfSeq: number
    values: {
      /** AI-generated session title (the "summary" the web UI shows). null for blank sessions. */
      title?: string | null
      [k: string]: unknown
    }
  }
}

/** One content part of a prompt. v0.0.1 only sends text. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

export interface ToolEventView {
  for: 'call' | 'result'
  view: { card: string; [k: string]: unknown }
}

// ─── SessionEvent — the merge-extensible append-only log entry ───────────────
// Strict envelope + wide `data`; the harness schema is deliberately open so
// plugins can add event types. We narrow the few we render and ignore the rest.
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
}

// ─── content-block shapes we render (defensive — upstream is merge-extensible) ─
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id?: string; name?: string; arguments?: string }
  | { type: 'tool-result'; toolCallId?: string; content?: ContentBlock[]; isError?: boolean }
  | { type: 'reasoning'; text?: string }
  | { type: string; [k: string]: unknown }

export interface UserMessageData {
  content?: ContentBlock[]
  source?: { kind?: string; plugin?: string }
  role?: string
  id?: string
}

export interface AssistantMessageData {
  turn: number
  step: number
  message: { role: string; content?: ContentBlock[]; source?: { kind?: string; provider?: string; model?: string }; id?: string }
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
}

export interface ToolCallData {
  turn: number
  step: number
  callId: CallId
  name: string
  arguments: string
}

export interface ToolResultData {
  turn: number
  step: number
  message: { content?: ContentBlock[]; source?: { callId?: string }; role?: string; id?: string }
  error?: { name: string; code: string }
  meta?: unknown
}

export interface TurnEndData {
  turn: number
  reason: { kind: string; [k: string]: unknown }
}

// ─── StreamChunk — assistant streaming deltas (text-delta carries the text) ────
export type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; argumentsDelta: string }
  | { type: 'block-start'; index: number; blockType: string; id?: string; name?: string }
  | { type: 'block-end'; index: number; block?: unknown }
  | { type: 'message-end'; message?: unknown }
  | { type: 'usage'; usage?: unknown }
  | { type: 'finish'; reason?: string }
  | { type: string; [k: string]: unknown }

export interface AssistantChunkData {
  turn: number
  step: number
  chunk: StreamChunk
}

// ─── MuxFrame — the WebSocket downlink payload union ─────────────────────────
// session/event carries a raw SessionEvent; the rest are control/snapshot frames.
// Unknown frame types are ignored (the harness extends this union over time).
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'session/queue'; sessionId: SessionId; items: unknown[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: CallId; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: string }
  | { type: 'question/requested'; sessionId: SessionId; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; [k: string]: unknown }

// ─── narrowing guards (the only runtime code in this file) ───────────────────
export function isSessionEventFrame(f: MuxFrame): f is { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView } {
  return f.type === 'session/event'
}
