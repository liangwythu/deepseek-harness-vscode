/**
 * Approval types — PendingApproval represents an approval/requested event
 * from the Harness host that requires a human decision (Allow/Deny).
 *
 * Approval and Diff Review are separate semantic chains (goal.md §14):
 * they are correlated by `callId` but do not depend on each other.
 * The UI couples them visually (approval card embedded in ToolItem),
 * but the stores are independent.
 */

import type { CallId, RpcId, SessionId } from '../harness/protocol.ts'

export type ApprovalState = 'pending' | 'responding' | 'resolved'

export interface PendingApproval {
  /** The mux frame's rpcId — used as the stable correlation key for replay. */
  rpcId: RpcId
  sessionId: SessionId
  approvalId: string
  /** Tool name that triggered the approval (if known). */
  toolName?: string
  /** Tool callId — links to ToolItem for UI embedding. */
  callId?: CallId
  /** Human-readable reason for the approval request. */
  reason?: string
  state: ApprovalState
  /** Outcome once resolved (from approval/resolved frame or our respond). */
  outcome?: string
  createdAt: number
}

/** Opaque approval summary for UI serialization. */
export interface ApprovalSummary {
  rpcId: RpcId
  approvalId: string
  sessionId: SessionId
  toolName?: string
  callId?: CallId
  reason?: string
  state: ApprovalState
  outcome?: string
  /** Whether VS Code-side Allow is permitted (safety allowlist). */
  canAllow: boolean
  createdAt: number
}

export type ApprovalChangeListener = (approval: PendingApproval) => void
