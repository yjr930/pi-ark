import { ExternalLink, Link2, NotebookPen } from "lucide-react";
import { useId, useState } from "react";
import { ApiError } from "../api";
import { parseInternalSessionLink, sessionPermalink } from "../permalinks";
import type { MemoryDraft, MemoryEntry, MemorySource, MemoryStatus, MemoryType } from "../types";

export const memoryTypes: Record<MemoryType, string> = { user: "Preference", feedback: "Feedback", project: "Project fact", reference: "Reference" };
export const memoryStatuses: Record<MemoryStatus, string> = { active: "Active", review: "Needs review", archived: "Archived" };

export function emptyMemoryDraft(notebookText?: string): MemoryDraft {
  return { type: "project", title: "", summary: "", body: notebookText ?? "", tags: [], pinned: false, ...(notebookText !== undefined ? { fromNotebook: true } : {}) };
}

export function draftFromMemoryEntry(entry: MemoryEntry): MemoryDraft {
  return { type: entry.type, title: entry.title, summary: entry.summary, body: entry.body, tags: entry.tags, pinned: entry.pinned, reviewAfter: entry.reviewAfter, ...(entry.source.kind === "external" ? { sourceUrl: entry.source.url } : {}) };
}

function httpUrl(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value.trim())) return;
  try {
    const url = new URL(value.trim());
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) return url.href;
  } catch { /* Invalid URL. */ }
}

export function reviewDateText(value: string | null | undefined): string {
  const day = value?.slice(0, 10) ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day.replaceAll("-", "/") : value ?? "";
}

function parseReviewDate(value: string): string | null | undefined {
  const input = value.trim();
  if (!input) return null;
  const match = /^(\d{4})([/-])(\d{1,2})\2(\d{1,2})(?:T.*)?$/.exec(input);
  if (!match) return undefined;
  const day = `${match[1]}-${match[3].padStart(2, "0")}-${match[4].padStart(2, "0")}`;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : undefined;
}

export function cleanMemoryDraft(draft: MemoryDraft): MemoryDraft {
  const sourceUrl = draft.sourceUrl ? httpUrl(draft.sourceUrl) : draft.sourceUrl;
  if (draft.sourceUrl && !sourceUrl) throw new Error("Enter an HTTP or HTTPS source URL without credentials.");
  const title = draft.title.trim();
  const summary = draft.summary.trim();
  if (!title || !summary || !draft.body.trim()) throw new Error("Enter a title, summary, and body before saving.");
  let reviewAfter: string | null | undefined;
  if (draft.reviewAfter !== undefined) {
    reviewAfter = parseReviewDate(draft.reviewAfter ?? "");
    if (reviewAfter === undefined) throw new Error("Enter the review date as yyyy/mm/dd.");
  }
  return { ...draft, title, summary, tags: [...new Set(draft.tags.map((tag) => tag.trim()).filter(Boolean))], sourceUrl, ...(reviewAfter !== undefined ? { reviewAfter } : {}) };
}

export function memoryError(reason: unknown, conflictHint: string): { text: string; conflict: boolean } {
  const text = reason instanceof Error ? reason.message : "The Memory request failed.";
  const conflict = reason instanceof ApiError && reason.status === 409;
  return { text: conflict ? `Conflict: ${text} ${conflictHint}` : text, conflict };
}

export function MemorySourceLink({ source, unavailable, onOpenNotebook }: { source: MemorySource; unavailable?: boolean; onOpenNotebook: () => void }) {
  if (unavailable) return <span className="memory-warning"><Link2 size={14} />Source unavailable</span>;
  if (source.kind === "message") {
    const target = parseInternalSessionLink(source.link);
    return target ? <a href={sessionPermalink(target.workspaceId, target.sessionId, target.messageId, target.leafEntryId)} data-pi-ark-link={source.link}><Link2 size={14} />Open source message</a> : <span>Invalid session source</span>;
  }
  if (source.kind === "external") {
    const url = httpUrl(source.url);
    return url ? <a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />Open external source</a> : <span>Invalid external source</span>;
  }
  if (source.kind === "notebook") return <button type="button" onClick={onOpenNotebook}><NotebookPen size={14} />Open source Notebook</button>;
  return <span>Manually entered</span>;
}

export function MemoryDraftFields({ draft, onChange, showSourceUrl, source }: { draft: MemoryDraft; onChange: (value: MemoryDraft) => void; showSourceUrl?: boolean; source?: MemorySource }) {
  const [tags, setTags] = useState(draft.tags.join(", "));
  const reviewNoteId = useId();
  const update = (change: Partial<MemoryDraft>) => onChange({ ...draft, ...change });
  return <div className="memory-fields">
    <div className="memory-field-grid">
      <label className="dialog-field"><span>Type</span><select value={draft.type} onChange={(event) => update({ type: event.target.value as MemoryType })}>{Object.entries(memoryTypes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="dialog-field"><span>Review after</span><input value={reviewDateText(draft.reviewAfter)} placeholder="yyyy/mm/dd" inputMode="numeric" autoComplete="off" aria-describedby={reviewNoteId} onChange={(event) => update({ reviewAfter: event.target.value })} /></label>
    </div>
    <p className="memory-field-note" id={reviewNoteId}>After this date the entry shows Needs review and stays in Memory. The main Session reads it while Use entries needing review is on under Memory settings. Clearing the field removes the date; a new project fact saved without a date gets one 90 days later.</p>
    <label className="dialog-field"><span>Title</span><input value={draft.title} onChange={(event) => update({ title: event.target.value })} required /></label>
    <label className="dialog-field"><span>Summary</span><input value={draft.summary} onChange={(event) => update({ summary: event.target.value })} required /></label>
    <label className="dialog-field"><span>Body (Markdown)</span><textarea rows={6} value={draft.body} onChange={(event) => update({ body: event.target.value })} required /></label>
    <label className="dialog-field"><span>Tags</span><input value={tags} placeholder="Separate tags with commas" onChange={(event) => { setTags(event.target.value); update({ tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }); }} /></label>
    {showSourceUrl && <label className="dialog-field"><span>{source?.kind === "message" || source?.kind === "notebook" ? "Replace source with external URL (optional)" : "Source URL (optional)"}</span><input type="url" placeholder="https://…" value={draft.sourceUrl ?? ""} onChange={(event) => update({ sourceUrl: event.target.value || (source?.kind === "external" ? null : undefined) })} /></label>}
    <label className="memory-check"><input type="checkbox" checked={draft.pinned} onChange={(event) => update({ pinned: event.target.checked })} /><span>Pin entry</span></label>
  </div>;
}
