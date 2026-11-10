import { useState } from "react";
import { CircleStop, GitFork, LoaderCircle } from "lucide-react";
import { api } from "../api";
import { sessionPermalink, parseInternalSessionLink } from "../permalinks";
import { pinnedPiArkLink } from "../../../server/src/internal-links";
import type { SubagentSessionState } from "../types";

export function SessionReference({ link, leafEntryId, children }: { link: string; leafEntryId?: string; children: React.ReactNode }) {
  const pinned = pinnedPiArkLink(link, leafEntryId);
  const target = parseInternalSessionLink(pinned);
  return target ? <a href={sessionPermalink(target.workspaceId, target.sessionId, target.messageId, target.leafEntryId)} data-pi-ark-link={pinned}>{children}</a> : <span>{children}</span>;
}

export function SubagentRuns({ workspaceId, state, onChanged }: { workspaceId: string; state?: SubagentSessionState; onChanged: () => void }) {
  const [stopping, setStopping] = useState<string[]>([]);
  const [error, setError] = useState("");
  if (!state || (!state.origin && !state.runs.length)) return null;
  async function stop(sessionId: string) {
    setStopping((current) => [...current, sessionId]); setError("");
    try { await api.stopSession(workspaceId, sessionId); onChanged(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Cannot stop subagent"); }
    finally { setStopping((current) => current.filter((item) => item !== sessionId)); }
  }
  return <aside className="subagent-panel" aria-label="Subagent tasks">
    {state.origin && <div className="subagent-origin"><GitFork size={14} /><strong>Subagent · {state.origin.state}</strong>{state.origin.parentDeleted ? <span>Parent session deleted</span> : <SessionReference link={state.origin.parentLink} leafEntryId={state.origin.parentLeafEntryId}>Open parent request</SessionReference>}{state.managed && <span>Parent-managed task</span>}</div>}
    {state.runs.map((run) => <details className="subagent-run" key={run.id} open={run.tasks.some((task) => task.state === "queued" || task.state === "running") || undefined}><summary><GitFork size={14} /><strong>Subagent tasks</strong><span>{run.tasks.filter((task) => task.state === "completed").length} / {run.tasks.length} completed</span><span>{run.model.id}</span></summary><div className="subagent-task-list">{run.tasks.map((task) => {
      const active = task.state === "queued" || task.state === "running";
      return <div className={`subagent-task state-${task.state}`} key={task.sessionId}><div className="subagent-task-heading"><strong>{task.title}</strong><span className="subagent-task-state">{active && <LoaderCircle size={12} />}{task.state}{task.currentTool && ` · ${task.currentTool}`}</span></div><div className="subagent-task-links">{task.deleted ? <span>Session deleted</span> : !task.startedAt ? <span>Session awaiting execution</span> : <><SessionReference link={task.sessionLink}>Open session</SessionReference>{task.resultLink && <SessionReference link={task.resultLink} leafEntryId={task.resultLeafEntryId}>Open result</SessionReference>}</>}{active && <button type="button" disabled={stopping.includes(task.sessionId)} onClick={() => void stop(task.sessionId)}><CircleStop size={13} />Stop task</button>}</div>{task.result && <pre className="subagent-task-result">{task.result}</pre>}{task.error && <p className="subagent-task-error">{task.error}</p>}{task.usage && <small>Input {task.usage.input} · Output {task.usage.output} · Cost ${task.usage.cost.toFixed(4)}</small>}</div>;
    })}</div></details>)}
    {state.runs.some((run) => run.tasks.some((task) => task.usage)) && <div className="subagent-usage">Subagent totals · Input {state.runs.reduce((sum, run) => sum + run.tasks.reduce((total, task) => total + (task.usage?.input || 0), 0), 0)} · Output {state.runs.reduce((sum, run) => sum + run.tasks.reduce((total, task) => total + (task.usage?.output || 0), 0), 0)} · Cost ${state.runs.reduce((sum, run) => sum + run.tasks.reduce((total, task) => total + (task.usage?.cost || 0), 0), 0).toFixed(4)}</div>}
    {error && <p className="subagent-task-error" role="alert">{error}</p>}
  </aside>;
}
