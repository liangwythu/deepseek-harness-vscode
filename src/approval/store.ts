/**
 * ApprovalStore — owns PendingApproval lifecycle.
 *
 * Receives approval/requested frames from the mux stream and tracks them
 * until resolution (approval/resolved frame or user respond).
 *
 * Security (goal.md §15-16):
 *   - Only render Allow when approval.sessionId === activeSessionId
 *   - callId must match a known ToolItem (checked by controller)
 *   - Never auto-approve — explicit human click only
 *   - Allowlist: only write/edit + low-risk approvals get Allow in VS Code;
 *     danger-full-access and unknown → "Review in Web UI" only
 */

import type { CallId, RpcId, SessionId } from '../harness/protocol.ts'
import type { ApprovalChangeListener, ApprovalSummary, PendingApproval } from './types.ts'

/** Tools that are safe to allow from the VS Code sidebar. */
const ALLOW_TOOL_NAMES = new Set([
  'write', 'write_file', 'edit', 'edit_file', 'read', 'read_file',
  'ls', 'list_dir', 'list_directory', 'grep', 'search', 'search_code',
])

/** Approval reasons that are too dangerous for inline allow. */
const HIGH_RISK_PATTERNS = [
  'danger-full-access',
  'danger_full_access',
  'full-access',
  'full_access',
  'escalation',
  'sandbox-escalate',
]

export interface UpsertApprovalInput {
  rpcId: RpcId
  sessionId: SessionId
  approvalId: string
  toolName?: string
  callId?: CallId
  reason?: string
}

export class ApprovalStore {
  private approvals = new Map<RpcId, PendingApproval>()
  private byCallId = new Map<CallId, RpcId>()
  private listeners = new Set<ApprovalChangeListener>()

  onApprovalChange(listener: ApprovalChangeListener): { dispose: () => void } {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private notify(approval: PendingApproval): void {
    for (const l of this.listeners) {
      try { l(approval) } catch { /* listener errors must not break store */ }
    }
  }

  upsert(input: UpsertApprovalInput): PendingApproval {
    const existing = this.approvals.get(input.rpcId)
    if (existing) {
      // Update fields if provided (e.g. replays may have more info)
      if (input.toolName && !existing.toolName) existing.toolName = input.toolName
      if (input.callId && !existing.callId) {
        existing.callId = input.callId
        this.byCallId.set(input.callId, input.rpcId)
      }
      if (input.reason && !existing.reason) existing.reason = input.reason
      this.notify(existing)
      return existing
    }

    const approval: PendingApproval = {
      rpcId: input.rpcId,
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      toolName: input.toolName,
      callId: input.callId,
      reason: input.reason,
      state: 'pending',
      createdAt: Date.now(),
    }
    this.approvals.set(input.rpcId, approval)
    if (input.callId) this.byCallId.set(input.callId, input.rpcId)
    this.notify(approval)
    return approval
  }

  /** Mark as responding (user clicked Allow/Deny, waiting for server). */
  setResponding(rpcId: RpcId): void {
    const a = this.approvals.get(rpcId)
    if (!a || a.state !== 'pending') return
    a.state = 'responding'
    this.notify(a)
  }

  /** Mark as resolved (from approval/resolved frame or our respond success). */
  resolve(rpcId: RpcId, outcome: string): void {
    const a = this.approvals.get(rpcId)
    if (!a) return
    a.state = 'resolved'
    a.outcome = outcome
    this.notify(a)
    // Clean up after a delay so the UI can show the resolved state
    setTimeout(() => {
      this.approvals.delete(rpcId)
      if (a.callId) this.byCallId.delete(a.callId)
    }, 5000)
  }

  getByRpcId(rpcId: RpcId): PendingApproval | undefined {
    return this.approvals.get(rpcId)
  }

  getByCallId(callId: CallId): PendingApproval | undefined {
    const rpcId = this.byCallId.get(callId)
    return rpcId ? this.approvals.get(rpcId) : undefined
  }

  /** Pending approvals for a session (resolved ones are cleaned up). */
  pending(sessionId: SessionId): PendingApproval[] {
    const out: PendingApproval[] = []
    for (const a of this.approvals.values()) {
      if (a.sessionId === sessionId && a.state !== 'resolved') out.push(a)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  summaries(activeSessionId: SessionId | undefined): ApprovalSummary[] {
    const all = activeSessionId
      ? this.pending(activeSessionId)
      : [...this.approvals.values()]
    return all.map(a => ({
      rpcId: a.rpcId,
      approvalId: a.approvalId,
      sessionId: a.sessionId,
      toolName: a.toolName,
      callId: a.callId,
      reason: a.reason,
      state: a.state,
      outcome: a.outcome,
      canAllow: this.canAllow(a, activeSessionId),
      createdAt: a.createdAt,
    }))
  }

  clearSession(sessionId: SessionId): void {
    for (const [rpcId, a] of this.approvals) {
      if (a.sessionId === sessionId) {
        this.approvals.delete(rpcId)
        if (a.callId) this.byCallId.delete(a.callId)
      }
    }
  }

  /** Security gate: can this approval be Allowed from VS Code? */
  canAllow(approval: PendingApproval, activeSessionId: SessionId | undefined): boolean {
    // 1. Session must match active session
    if (!activeSessionId || approval.sessionId !== activeSessionId) return false
    // 2. Must be pending
    if (approval.state !== 'pending') return false
    // 3. Check for high-risk patterns in reason
    const reason = approval.reason ?? ''
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (reason.toLowerCase().includes(pattern)) return false
    }
    // 4. Tool name allowlist (if known)
    if (approval.toolName && !ALLOW_TOOL_NAMES.has(approval.toolName)) return false
    return true
  }
}
