import { Check, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import type { MemoryDraft, MemoryEntry, MemoryProposal, MemoryProposalReview as ProposalReview } from "../types";
import { cleanMemoryDraft, memoryError, MemoryDraftFields, MemorySourceLink, memoryStatuses } from "./MemoryDraftFields";

interface Props {
  workspaceId: string;
  proposalId: string;
  enabled: boolean;
  entries: MemoryEntry[];
  busy: boolean;
  run: (task: () => Promise<void>) => void;
  onChanged: (proposal: MemoryProposal) => Promise<void>;
  onRefreshEntries: () => void;
  onClose: () => void;
  onOpenNotebook: () => void;
  failure?: ReturnType<typeof memoryError>;
}

export function MemoryProposalReview({ workspaceId, proposalId, enabled, entries, busy, run, onChanged, onRefreshEntries, onClose, onOpenNotebook, failure }: Props) {
  const [detail, setDetail] = useState<ProposalReview>();
  const [draft, setDraft] = useState<MemoryDraft>();
  const [target, setTarget] = useState<MemoryEntry | null>();
  const [historicalReviewed, setHistoricalReviewed] = useState(false);
  const [reason, setReason] = useState("");
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api.memoryProposal(workspaceId, proposalId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setDetail(result);
      setDraft((current) => current ?? result.proposal.draft);
      setTarget(reload || result.matches.length ? undefined : null);
      setHistoricalReviewed(false);
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(memoryError(error, "Refresh the suggestion to see its latest status.").text);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [workspaceId, proposalId, reload]);

  function reloadDetails() {
    setLoadError("");
    setLoading(true);
    setReload((current) => current + 1);
  }

  async function apply(task: () => Promise<MemoryProposal>) {
    const proposal = await task();
    setDetail((current) => current && { ...current, proposal });
    await onChanged(proposal);
  }

  const canConfirm = enabled && detail?.proposal.status === "pending" && detail.sourceAvailable && (!detail.historical || historicalReviewed) && target !== undefined && !failure?.conflict && !loadError && !busy && !loading;
  function confirm(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canConfirm || !detail) return;
    run(() => apply(() => api.confirmMemoryProposal(workspaceId, proposalId, {
      draft: cleanMemoryDraft(draft),
      target: target ? { id: target.id, revision: target.revision } : undefined,
      reviewHistorical: detail.historical && historicalReviewed ? true : undefined,
      reason: reason.trim() || undefined,
    })));
  }

  const latestEntries = new Map(entries.map((entry) => [entry.id, entry]));
  const matches = (detail?.matches ?? []).map((match) => {
    const latest = latestEntries.get(match.id);
    return latest && latest.revision > match.revision ? latest : match;
  });
  const otherEntries = entries.filter((entry) => !matches.some((match) => match.id === entry.id));
  const candidates = [...matches, ...otherEntries];
  return <section className="memory-panel memory-editor" aria-busy={loading || busy}>
    <div className="memory-panel-heading"><h3>Review memory suggestion</h3><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Back to entries</button></div>
    {loading && <p className="memory-message" role="status"><LoaderCircle size={15} className="memory-spinner" />Loading suggestion…</p>}
    {loadError && <p className="memory-message memory-warning" role="alert">{loadError} <button type="button" className="secondary-button" onClick={reloadDetails}>Retry</button></p>}
    {detail && <>
      <div className="memory-source"><MemorySourceLink source={detail.proposal.source} unavailable={!detail.sourceAvailable} onOpenNotebook={onOpenNotebook} /></div>
      {detail.proposal.status !== "pending" ? <p role="status" className="memory-message"><Check size={15} />{detail.proposal.status === "confirmed" ? "This suggestion has been saved to Memory." : "This suggestion has been dismissed."}</p> : draft && <form className="memory-form" onSubmit={confirm}>
        <p>Review the content before saving. Entries may be sent to the configured model.</p>
        {detail.historical && <p className="memory-message memory-warning"><TriangleAlert size={15} />This suggestion comes from a historical Session branch. Check the original message before using it.</p>}
        {!detail.sourceAvailable && <p className="memory-warning">The source cannot be found. You can dismiss this suggestion.</p>}
        {!enabled && <p>Enable Memory for this Workspace to confirm the suggestion.</p>}
        <fieldset disabled={busy || loading}>
          <MemoryDraftFields draft={draft} onChange={setDraft} />
          <label className="dialog-field"><span>Save suggestion as</span><select value={target === null ? "new" : target?.id ?? ""} onChange={(event) => setTarget(event.target.value === "new" ? null : candidates.find((entry) => entry.id === event.target.value))} required>
            <option value="" disabled>Choose how to save</option>
            <option value="new">Create a new entry</option>
            {matches.length > 0 && <optgroup label="Possible duplicates or conflicts">{matches.map((entry) => <option value={entry.id} key={entry.id}>{entry.title} · {memoryStatuses[entry.status]}</option>)}</optgroup>}
            {otherEntries.length > 0 && <optgroup label="Other existing entries">{otherEntries.map((entry) => <option value={entry.id} key={entry.id}>{entry.title} · {memoryStatuses[entry.status]}</option>)}</optgroup>}
          </select></label>
          {matches.length > 0 && <p className="memory-warning">Possible duplicates or conflicts: {matches.map((entry) => entry.title).join(", ")}. Choose an entry to review and update it.</p>}
          {target && <details className="memory-body"><summary>Review the current entry: {target.title}</summary><p>{target.summary}</p><pre>{target.body}</pre></details>}
          <label className="dialog-field"><span>Reason for this change (optional)</span><input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          {detail.historical && detail.sourceAvailable && <label className="memory-check"><input type="checkbox" checked={historicalReviewed} onChange={(event) => setHistoricalReviewed(event.target.checked)} /><span>I reviewed the original message and want to use this historical source.</span></label>}
        </fieldset>
        <div className="memory-actions">
          <button type="button" className="secondary-button" disabled={loading || busy} onClick={() => run(() => apply(() => api.dismissMemoryProposal(workspaceId, proposalId)))}>Dismiss suggestion</button>
          <button type="submit" className="primary-button" disabled={!canConfirm}><Check size={15} />{target ? "Update existing entry" : "Create entry"}</button>
        </div>
      </form>}
    </>}
    {failure && <div className="memory-message memory-warning" role="alert"><span>{failure.text}</span>{failure.conflict && <button type="button" className="secondary-button" disabled={busy || loading} onClick={() => { reloadDetails(); onRefreshEntries(); }}>Reload suggestion details</button>}</div>}
  </section>;
}
