import { Check, ShieldAlert, X } from "lucide-react";
import type { ToolApprovalRequest } from "../types";
import { SessionReference } from "./SubagentRun";

/** Inline approval for a bash command that deletes files. The card lives in the Session that owns the decision. */
export function ToolApprovalCard({ request, busy, onDecide }: { request: ToolApprovalRequest; busy: boolean; onDecide: (approvalId: string, approve: boolean) => void }) {
  return <article id={`approval-${request.approvalId}`} className="tool-approval-card" data-approval-id={request.approvalId} aria-label="Delete command waiting for approval">
    <header className="tool-approval-header">
      <span className="tool-approval-icon"><ShieldAlert size={15} /></span>
      <div className="tool-approval-title">
        <strong>Delete command needs approval</strong>
        <span>{request.sessionLink ? `Subagent · ${request.sessionTitle || "Delegated task"}` : "The Agent waits before running this command."}</span>
      </div>
      <span className="tool-approval-state">Waiting</span>
    </header>
    <pre className="tool-approval-command">{request.command}</pre>
    <div className="tool-approval-meta">
      <span>Detected <code>{request.matched}</code></span>
      {request.sessionLink && <SessionReference link={request.sessionLink} className="tool-approval-session">Open subagent session</SessionReference>}
    </div>
    <div className="tool-approval-actions">
      <button type="button" className="secondary-button tool-approval-deny" disabled={busy} onClick={() => onDecide(request.approvalId, false)}><X size={14} />Deny</button>
      <button type="button" className="primary-button tool-approval-approve" disabled={busy} onClick={() => onDecide(request.approvalId, true)}><Check size={14} />Approve</button>
    </div>
  </article>;
}
