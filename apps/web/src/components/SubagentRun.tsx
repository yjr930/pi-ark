import { useEffect, useState, type ReactNode } from "react";
import { GitFork } from "lucide-react";
import { sessionPermalink, parseInternalSessionLink } from "../permalinks";
import { pinnedPiArkLink } from "../../../server/src/internal-links";
import { subagentCounts, subagentFinished, type SubagentListItem } from "../subagent-view";

export function SessionReference({ link, leafEntryId, children, className, title }: { link: string; leafEntryId?: string; children: ReactNode; className?: string; title?: string }) {
  const pinned = pinnedPiArkLink(link, leafEntryId);
  const target = parseInternalSessionLink(pinned);
  return target ? <a className={className} title={title} href={sessionPermalink(target.workspaceId, target.sessionId, target.messageId, target.leafEntryId)} data-pi-ark-link={pinned}>{children}</a> : <span className={className}>{children}</span>;
}

export function SubagentBadge({ items, open, onToggle }: { items: SubagentListItem[]; open: boolean; onToggle: () => void }) {
  const counts = subagentCounts(items);
  if (!counts.total) return null;
  return <button type="button" className="subagent-badge" aria-label={`Subagents: ${counts.running} running, ${counts.complete} complete, ${counts.total} total`} title="Subagents · running / complete / total" aria-expanded={open} aria-controls="subagent-list" onClick={onToggle}><GitFork size={14} /><span>{counts.running}/{counts.complete}/{counts.total}</span></button>;
}

function AgentRow({ item, selected }: { item: SubagentListItem; selected: boolean }) {
  const date = new Date(item.updatedAt);
  const timestamp = date.toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return <SessionReference link={item.sessionLink} className={`agent-list-row ${selected ? "selected" : ""}`} title={item.error || item.title}><strong>{item.title}</strong><span className={`agent-list-state state-${item.state}`}>{item.state}</span><time dateTime={item.updatedAt} title={`Last updated: ${date.toLocaleString()}`}>{timestamp}</time></SessionReference>;
}

export function SubagentList({ items, sessionId }: { items: SubagentListItem[]; sessionId: string }) {
  const [completedOpen, setCompletedOpen] = useState(false);
  const active = items.filter((item) => !subagentFinished(item));
  const completed = items.filter(subagentFinished);
  const completedSignature = completed.map((item) => `${item.sessionId}:${item.runId}:${item.state}`).join("|");
  useEffect(() => { setCompletedOpen(false); }, [completedSignature]);
  return <nav className="subagent-list" id="subagent-list" aria-label="Subagent list"><div className="agent-list-columns"><span>Title</span><span>Status</span><span>Last updated</span></div>{active.map((item) => <AgentRow item={item} selected={item.sessionId === sessionId} key={item.sessionId} />)}{completed.length > 0 && <details className="completed-agents" open={completedOpen} onToggle={(event) => { if (event.currentTarget.open !== completedOpen) setCompletedOpen(event.currentTarget.open); }}><summary>Completed <span>{completed.length}</span></summary><div>{completed.map((item) => <AgentRow item={item} selected={item.sessionId === sessionId} key={item.sessionId} />)}</div></details>}</nav>;
}
