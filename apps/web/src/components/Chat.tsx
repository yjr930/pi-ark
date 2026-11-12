import { FormEvent, createContext, useContext, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Archive, ArrowDown, ArrowUp, Check, ChevronDown, ChevronUp, CircleStop, Clock3, Copy, File as FileIcon, GitFork, Info, Link2, LoaderCircle, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, TriangleAlert, Undo2, UserRound, Wrench, X } from "lucide-react";
import { api, websocketUrl } from "../api";
import { buildConversationSegments, buildToolCallGroups } from "../conversation";
import { formatMessageTime } from "../message-time";
import { internalMessageLink, internalSessionLink, sessionPermalink } from "../permalinks";
import { cacheSessionSnapshot, cacheSessionUiState, getCachedSessionSnapshot, getCachedSessionUiState, sessionCacheKey, type CachedSessionAttachment } from "../session-cache";
import type { AgentMessage, AgentSnapshot, ContentBlock, QueuedMessage, QueueState, QuestionAnswer, QuestionGroupState, SessionInfo, SessionModelOption, SessionRuntimeStatus, Workspace } from "../types";
import { Markdown } from "./Markdown";
import { NameDialog } from "./NameDialog";
import { Select } from "./Select";
import { ComposerSuggest } from "./ComposerSuggest";
import { applySuggestion, detectTrigger, filterSuggestItems, splitMcpQuery, type SuggestItem, type Trigger } from "../composer-suggest";
import { SubagentBadge, SubagentList, SessionReference } from "./SubagentRun";
import { QuestionCard } from "./QuestionCard";
import { subagentListItems } from "../subagent-view";
import { pinnedPiArkLink } from "../../../server/src/internal-links";

const RoleLabels = createContext({ user: "User", assistant: "AI" });

interface QuestionUi {
  groups: Map<string, QuestionGroupState>;
  busyId?: string;
  onAnswer: (toolCallId: string, answers: QuestionAnswer[]) => void;
  onDismiss: (toolCallId: string) => void;
}

const QuestionUiContext = createContext<QuestionUi | undefined>(undefined);

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type ChatWidth = "compact" | "wide" | "full";
type PendingAttachment = CachedSessionAttachment;
type DisclosureChange = (key: string, open: boolean) => void;
interface ComposerSuggestState { trigger: Trigger; items: SuggestItem[]; selected: number; loading: boolean; truncated: boolean }
interface PendingQueuedMessage { id: string; text: string; matchText: string; expectedMatchCount: number; status: "scheduling" | "failed"; error?: string }
type OptimisticQueueOperation =
  | { id: string; type: "update"; itemId: string; update: { direction?: "up" | "down"; mode?: "steering" | "followUp" } }
  | { id: string; type: "remove"; itemId: string }
  | { id: string; type: "merge-follow-ups" };

function applyQueueOperation(queue: QueuedMessage[], operation: OptimisticQueueOperation): QueuedMessage[] {
  const next = queue.map((item) => ({ ...item }));
  if (operation.type === "remove") return next.filter((item) => item.id !== operation.itemId);
  if (operation.type === "merge-follow-ups") {
    const followUps = next.filter((item) => item.mode === "followUp");
    if (followUps.length < 2) return next;
    const firstFollowUpIndex = next.findIndex((item) => item.mode === "followUp");
    const merged = { ...followUps[0], text: followUps.map((item) => item.text).join("\n\n") };
    const withoutFollowUps = next.filter((item) => item.mode !== "followUp");
    withoutFollowUps.splice(firstFollowUpIndex, 0, merged);
    return withoutFollowUps;
  }
  const index = next.findIndex((item) => item.id === operation.itemId);
  if (index < 0) return next;
  const item = next[index];
  if (operation.update.mode && operation.update.mode !== item.mode) {
    next.splice(index, 1);
    item.mode = operation.update.mode;
    let insertAt = next.length;
    if (item.mode === "steering") {
      insertAt = 0;
      for (let queuedIndex = next.length - 1; queuedIndex >= 0; queuedIndex -= 1) if (next[queuedIndex].mode === "steering") { insertAt = queuedIndex + 1; break; }
    }
    next.splice(insertAt, 0, item);
  } else if (operation.update.direction) {
    const siblings = next.map((queued, queuedIndex) => queued.mode === item.mode ? queuedIndex : -1).filter((queuedIndex) => queuedIndex >= 0);
    const siblingIndex = siblings.indexOf(index);
    const targetSibling = operation.update.direction === "up" ? siblingIndex - 1 : siblingIndex + 1;
    if (targetSibling >= 0 && targetSibling < siblings.length) {
      const targetIndex = siblings[targetSibling];
      [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    }
  }
  return next;
}

function applyQueueOperations(queue: QueuedMessage[], operations: OptimisticQueueOperation[]): QueuedMessage[] {
  return operations.reduce(applyQueueOperation, queue);
}

function blocks(content: AgentMessage["content"]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

function messageMarkdown(message: AgentMessage): string {
  return blocks(message.content).filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n\n");
}

function queuedTextMatches(queuedText: string, matchText: string): boolean {
  return queuedText === matchText || queuedText.startsWith(`${matchText}\n\nAttached files:\n`);
}

function hasTextFeedContent(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return blocks(message.content).some((block) => block.type === "text" ? Boolean(block.text?.trim()) : block.type === "thinking" ? Boolean(block.thinking?.trim()) : block.type === "image");
}

function hasAssistantFooterContent(message: AgentMessage): boolean {
  return message.role === "assistant" && blocks(message.content).some((block) => block.type === "text" ? Boolean(block.text?.trim()) : block.type === "image");
}

function matchesToolResult(call: ContentBlock, result: AgentMessage | undefined): result is AgentMessage {
  if (result?.role !== "toolResult") return false;
  return call.id && result.toolCallId ? call.id === result.toolCallId : true;
}

function toolCallPreview(call: ContentBlock): string {
  const argumentsValue = call.arguments || {};
  for (const key of ["command", "path", "filePath", "file_path", "query", "pattern", "url"]) {
    const value = argumentsValue[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
  }
  return JSON.stringify(argumentsValue);
}

function toolResultPreview(message: AgentMessage): string {
  const text = blocks(message.content).find((block) => block.type === "text" && block.text?.trim())?.text;
  if (text) return text.trim().replace(/\s+/g, " ");
  if (blocks(message.content).some((block) => block.type === "image")) return "Image result";
  return "Empty result";
}

function formatToolArgumentValue(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) return value.length ? value.map((item) => typeof item === "object" && item !== null ? `${indent}-\n${formatToolArgumentValue(item, depth + 1)}` : `${indent}- ${formatToolArgumentValue(item, 0)}`).join("\n") : "No values";
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length ? entries.map(([key, item]) => typeof item === "object" && item !== null ? `${indent}${key}:\n${formatToolArgumentValue(item, depth + 1)}` : `${indent}${key}: ${formatToolArgumentValue(item, 0)}`).join("\n") : "No values";
  }
  return String(value);
}

function MessageLinkButton({ messageId, label, onCopyLink }: { messageId?: string; label?: string; onCopyLink: (messageId: string) => void }) {
  const [copied, setCopied] = useState(false);
  const [tooltip, setTooltip] = useState<{ left: number; top: number; above: boolean }>();
  const tooltipId = useId();
  useEffect(() => {
    if (!tooltip) return;
    const hide = () => setTooltip(undefined);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide); };
  }, [tooltip]);
  if (!messageId) return null;
  const showTooltip = (element: HTMLButtonElement) => {
    const box = element.getBoundingClientRect();
    const above = box.top > 36;
    setTooltip({ left: Math.max(100, Math.min(window.innerWidth - 100, box.left + box.width / 2)), top: above ? box.top - 7 : box.bottom + 7, above });
  };
  return <><button type="button" className={`message-link-button ${label ? "message-source-link" : ""}`} aria-describedby={tooltip ? tooltipId : undefined} aria-label={copied ? "Internal link copied" : `Copy internal link for message ${messageId}`} onMouseEnter={(event) => showTooltip(event.currentTarget)} onMouseLeave={() => setTooltip(undefined)} onFocus={(event) => showTooltip(event.currentTarget)} onBlur={() => setTooltip(undefined)} onClick={() => { onCopyLink(messageId); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{label && <code>{label}</code>}{copied ? <Check size={12} /> : <Link2 size={12} />}</button>{tooltip && createPortal(<div className={`message-link-tooltip ${tooltip.above ? "above" : ""}`} role="tooltip" id={tooltipId} style={{ left: tooltip.left, top: tooltip.top }}>{copied ? "Link copied" : "Copy Pi-Ark link"}</div>, document.body)}</>;
}

function MessageSourceLinks({ sources, onCopyLink }: { sources: Array<{ label: string; messageId?: string }>; onCopyLink: (messageId: string) => void }) {
  const availableSources = sources.filter((source): source is { label: string; messageId: string } => Boolean(source.messageId));
  return availableSources.length ? <div className="feed-source-links">{availableSources.map((source) => <MessageLinkButton label={source.label} messageId={source.messageId} onCopyLink={onCopyLink} key={`${source.label}-${source.messageId}`} />)}</div> : null;
}

function FeedTextMeta({ message, messageId, onCopyLink }: { message: AgentMessage; messageId?: string; onCopyLink: (messageId: string) => void }) {
  const completed = message.role !== "assistant" || Boolean(message.stopReason && message.stopReason !== "pending");
  const roles = useContext(RoleLabels);
  const contextTokens = message.usage?.totalTokens || (message.usage ? message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : 0);
  const contextPercent = message.contextWindow && contextTokens ? contextTokens / message.contextWindow * 100 : undefined;
  return <div className="feed-text-meta"><MessageSourceLinks sources={[{ label: roles.assistant, messageId }]} onCopyLink={onCopyLink} />{completed && <div className="feed-text-metrics"><span>{message.responseModel || message.model || "Unknown model"}</span>{message.contextWindow && <span>Context {contextPercent?.toFixed(1) || "0.0"}%</span>}{message.usage && <span>I/{number(message.usage.input)} O/{number(message.usage.output)}</span>}</div>}</div>;
}

function MessageTime({ timestamp, className = "" }: { timestamp?: number; className?: string }) {
  const time = formatMessageTime(timestamp);
  return time ? <time className={`message-time ${className}`} dateTime={time.dateTime}>{time.label}</time> : null;
}

function FeedTextFooter({ message, messageId, infoOpen, onInfoToggle, onCopyLink, onFork }: { message: AgentMessage; messageId?: string; infoOpen: boolean; onInfoToggle: () => void; onCopyLink: (messageId: string) => void; onFork: (entryId: string) => void }) {
  const [markdownCopied, setMarkdownCopied] = useState(false);
  const completed = message.role !== "assistant" || Boolean(message.stopReason && message.stopReason !== "pending");
  const markdown = messageMarkdown(message);
  const roles = useContext(RoleLabels);
  const informationLabel = messageId ? `${roles.assistant} message ${messageId}` : `streaming ${roles.assistant} message`;
  return <div className="feed-text-footer">{infoOpen && <FeedTextMeta message={message} messageId={messageId} onCopyLink={onCopyLink} />}<div className="feed-text-actions"><MessageTime timestamp={message.timestamp} />{completed && message.entryId && <><button type="button" className="icon-tooltip" aria-label={markdownCopied ? "Markdown copied" : "Copy Markdown"} data-tooltip={markdownCopied ? "Markdown copied" : "Copy Markdown"} disabled={!markdown} onClick={() => void navigator.clipboard.writeText(markdown).then(() => { setMarkdownCopied(true); window.setTimeout(() => setMarkdownCopied(false), 1200); })}>{markdownCopied ? <Check size={13} /> : <Copy size={13} />}</button><button type="button" className="icon-tooltip" aria-label="Fork session" data-tooltip="Fork session" onClick={() => onFork(message.entryId!)}><GitFork size={13} /></button></>}<button type="button" className="icon-tooltip" aria-label={infoOpen ? `Hide information for ${informationLabel}` : `Show information for ${informationLabel}`} aria-expanded={infoOpen} data-tooltip={infoOpen ? "Hide message information" : "Show message information"} onClick={onInfoToggle}><Info size={13} /></button></div></div>;
}

function compactDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "—";
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.floor(durationMs / 60_000)}m ${Math.round(durationMs % 60_000 / 1000)}s`;
}

function CompactOverview({ message }: { message: AgentMessage }) {
  const stats = message.compaction;
  const estimate = (tokens: number | undefined) => tokens === undefined ? "—" : `≈${Math.round(tokens)}`;
  return <div className="compact-overview"><div className="compact-title"><strong>Compact</strong><span>Duration {compactDuration(stats?.durationMs)}</span></div><div className="compact-context"><span>Before <b>{message.tokensBefore === undefined ? "—" : Math.round(message.tokensBefore)}</b></span><span aria-hidden="true">→</span><span>After <b>{estimate(stats?.tokensAfter)}{stats && stats.systemPromptTokens === undefined ? " + system" : ""}</b> tokens</span></div><div className="compact-breakdown"><span>System prompt <b>{estimate(stats?.systemPromptTokens)}</b></span><span>Summary <b>{estimate(stats?.summaryTokens)}</b></span><span>Retained <b>{estimate(stats?.retainedTokens)}</b></span></div></div>;
}

function ToolFeedItem({ call, callTimestamp, result, summaryMessage, messageId, resultMessageId, target, stateKey, disclosureOpen, onDisclosureChange, onImageOpen, onCopyLink }: { call?: ContentBlock; callTimestamp?: number; result?: AgentMessage; summaryMessage?: AgentMessage; messageId?: string; resultMessageId?: string; target: boolean; stateKey: string; disclosureOpen?: boolean; onDisclosureChange: DisclosureChange; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageId: string) => void }) {
  const previousRunningRef = useRef(Boolean(call && !result));
  const targetOpenedRef = useRef(false);
  const isSummary = Boolean(summaryMessage);
  const isCompaction = summaryMessage?.role === "compactionSummary";
  const isSubagentTool = call?.name === "subagent" || result?.toolName === "subagent";
  const name = isSummary ? isCompaction ? "Compact" : "Branch summary" : call?.name || result?.toolName || "Tool";
  const preview = isSummary ? isCompaction && summaryMessage?.tokensBefore ? `${number(summaryMessage.tokensBefore)} tokens before compact` : "Saved conversation context" : call ? toolCallPreview(call) : result ? toolResultPreview(result) : "{}";
  const status = isSummary ? "Saved" : result?.isError ? "Failed" : call ? result ? "Completed" : "Running" : "Result";
  const statusClass = `status-${status.toLowerCase()}`;
  const running = Boolean(call && !result);
  const sources = [{ label: isSummary ? "Message" : call ? "Call" : "Result", messageId }, ...(resultMessageId ? [{ label: "Result", messageId: resultMessageId }] : [])];
  useLayoutEffect(() => {
    if (target && !running && !targetOpenedRef.current) {
      targetOpenedRef.current = true;
      if (disclosureOpen !== true) onDisclosureChange(stateKey, true);
    } else if (running && !previousRunningRef.current) onDisclosureChange(stateKey, false);
    previousRunningRef.current = running;
  }, [disclosureOpen, onDisclosureChange, running, stateKey, target]);
  const open = disclosureOpen ?? (target && !running);
  const questionUi = useContext(QuestionUiContext);
  const question = !isSummary && call?.id ? questionUi?.groups.get(call.id) : undefined;
  if (question) return <div className={`feed-tool-item question-tool-item ${target ? "permalink-target" : ""}`}>
    {resultMessageId && <span id={`message-${resultMessageId}`} data-message-id={resultMessageId} data-message-role="toolResult" data-entry-id={result?.entryId} className="message-inline-anchor" />}
    <QuestionCard group={question} busy={questionUi?.busyId === question.toolCallId} onSubmit={(answers) => questionUi?.onAnswer(question.toolCallId, answers)} onDismiss={() => questionUi?.onDismiss(question.toolCallId)} />
  </div>;
  return <div className="feed-tool-item">
    {resultMessageId && <span id={`message-${resultMessageId}`} data-message-id={resultMessageId} data-message-role="toolResult" data-entry-id={result?.entryId} className="message-inline-anchor" />}
    <details open={open} onToggle={(event) => { if (event.currentTarget.open !== open) onDisclosureChange(stateKey, event.currentTarget.open); }} className={`feed-tool-details ${statusClass} ${isCompaction ? "is-compaction" : ""} ${isSubagentTool ? "is-subagent-tool" : ""} ${target ? "permalink-target" : ""}`}><summary><span className="feed-tool-logo">{isSummary ? <Archive size={15} /> : isSubagentTool ? <GitFork size={15} /> : <Wrench size={15} />}</span>{isCompaction && summaryMessage ? <CompactOverview message={summaryMessage} /> : <><strong>{name}</strong><code title={preview}>{preview}</code></>}<span className="feed-tool-status">{status}</span></summary><div className="feed-tool-content"><MessageSourceLinks sources={sources} onCopyLink={onCopyLink} />{call && <section><strong>Arguments</strong><div className="feed-tool-arguments">{Object.entries(call.arguments || {}).length > 0 ? Object.entries(call.arguments || {}).map(([key, value]) => <div key={key}><h5>{key}</h5><pre>{formatToolArgumentValue(value)}</pre></div>) : <p>No arguments</p>}</div></section>}{result && <section><strong>Result</strong><div>{blocks(result.content).map((block, index) => {
      if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown" onImageOpen={onImageOpen} key={index} /> : null;
      if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button" onClick={() => onImageOpen(source, "Tool result image")} key={index}><img className="message-image" src={source} alt="Tool result" /></button>; }
      return null;
    })}</div></section>}{isCompaction && summaryMessage?.compaction && <section className="compact-generation-details"><strong>Compaction details</strong><dl><div><dt>Trigger</dt><dd>{summaryMessage.compaction.reason || "—"}</dd></div><div><dt>Duration</dt><dd>{compactDuration(summaryMessage.compaction.durationMs)}</dd></div>{summaryMessage.compaction.summarizerInputTokens !== undefined && <div><dt>Summarizer input tokens</dt><dd>{summaryMessage.compaction.summarizerInputTokens}</dd></div>}{summaryMessage.compaction.summarizerOutputTokens !== undefined && <div><dt>Summarizer output tokens</dt><dd>{summaryMessage.compaction.summarizerOutputTokens}</dd></div>}</dl><p>≈ Token estimates from pi SDK</p></section>}{summaryMessage?.summary && <section><strong>Summary</strong><Markdown source={summaryMessage.summary} className="message-markdown" onImageOpen={onImageOpen} /></section>}{!isSummary && <MessageTime timestamp={result?.timestamp ?? callTimestamp} className="feed-tool-time" />}</div></details>
  </div>;
}

function AssistantError({ message }: { message: string }) {
  return <div className="feed-assistant-error" role="status"><TriangleAlert size={13} /><span>{message}</span></div>;
}

function FeedMessage({ message, hiddenCalls, idByMessage, resultByCall, targetMessageId, hideReasoning, canRollback, rollbackTargetId, disclosures, onDisclosureChange, onImageOpen, onCopyLink, onFork, onRollback }: { message: AgentMessage; hiddenCalls?: ReadonlySet<ContentBlock>; idByMessage: Map<AgentMessage, string | undefined>; resultByCall: Map<ContentBlock, AgentMessage>; targetMessageId?: string; hideReasoning: boolean; canRollback: boolean; rollbackTargetId?: string; disclosures: Record<string, boolean>; onDisclosureChange: DisclosureChange; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageId: string) => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const roles = useContext(RoleLabels);
  const messageId = idByMessage.get(message);
  const target = Boolean(messageId && messageId === targetMessageId);
  const messageIdentity = message.entryId || messageId || `${message.role}-${message.timestamp || "pending"}`;
  const textInfoKey = `info:${messageIdentity}`;
  const textInfoOpen = disclosures[textInfoKey] ?? false;
  if (message.role === "compactionSummary" || message.role === "branchSummary") { const stateKey = `tool:${messageIdentity}`; return <article id={messageId ? `message-${messageId}` : undefined} data-message-id={messageId} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message ${target ? "permalink-target" : ""}`}><ToolFeedItem summaryMessage={message} messageId={messageId} target={target} stateKey={stateKey} disclosureOpen={disclosures[stateKey]} onDisclosureChange={onDisclosureChange} onImageOpen={onImageOpen} onCopyLink={onCopyLink} /></article>; }
  if (message.role === "toolResult") { const stateKey = `tool:${messageIdentity}`; return <article id={messageId ? `message-${messageId}` : undefined} data-message-id={messageId} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message ${target ? "permalink-target" : ""}`}><ToolFeedItem result={message} messageId={messageId} target={target} stateKey={stateKey} disclosureOpen={disclosures[stateKey]} onDisclosureChange={onDisclosureChange} onImageOpen={onImageOpen} onCopyLink={onCopyLink} /></article>; }
  const isUser = message.role === "user";
  const hasText = hasTextFeedContent(message);
  const showAssistantFooter = hasAssistantFooterContent(message);
  const contentBlocks = blocks(message.content).map((block, index) => {
    if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown feed-text-block" onImageOpen={onImageOpen} key={index} /> : null;
    if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button feed-text-block" onClick={() => onImageOpen(source, "Attached image")} key={index}><img className="message-image" src={source} alt="Attached image" /></button>; }
    if (block.type === "thinking") { const stateKey = `reasoning:${messageIdentity}:${index}`; const open = disclosures[stateKey] ?? false; return !hideReasoning && block.thinking ? <details open={open} onToggle={(event) => { if (event.currentTarget.open !== open) onDisclosureChange(stateKey, event.currentTarget.open); }} className="thinking feed-text-block" key={index}><summary>Reasoning</summary><Markdown source={block.thinking} className="message-markdown thinking-markdown" onImageOpen={onImageOpen} /></details> : null; }
    if (block.type === "toolCall") { const result = resultByCall.get(block); const resultMessageId = result ? idByMessage.get(result) : undefined; const stateKey = `tool:${block.id || `${messageIdentity}:${index}`}`; return <div hidden={hiddenCalls?.has(block)} className="feed-tool-call-slot" key={index}><ToolFeedItem call={block} callTimestamp={message.timestamp} result={result} messageId={messageId} resultMessageId={resultMessageId} target={target || Boolean(resultMessageId && resultMessageId === targetMessageId)} stateKey={stateKey} disclosureOpen={disclosures[stateKey]} onDisclosureChange={onDisclosureChange} onImageOpen={onImageOpen} onCopyLink={onCopyLink} /></div>; }
    return null;
  });
  if (isUser) return <article id={messageId ? `message-${messageId}` : undefined} data-message-id={messageId} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message feed-user message-user ${target ? "permalink-target" : ""}`}><div className="feed-user-header"><div className="feed-user-identity"><div className="feed-user-avatar"><UserRound size={16} /></div><div className="feed-user-label">{roles.user}</div></div><div className="feed-user-actions"><MessageLinkButton messageId={messageId} onCopyLink={onCopyLink} />{canRollback && rollbackTargetId && <button type="button" className="icon-tooltip" aria-label="Roll back latest message" data-tooltip="Roll back latest message" onClick={() => onRollback(rollbackTargetId)}><RotateCcw size={13} /></button>}</div></div><div className="feed-message-content">{contentBlocks}</div></article>;
  const assistantError = message.role === "assistant" && message.stopReason === "error" ? message.errorMessage || "Unknown response error" : undefined;
  const content = hasText ? <div className="feed-ai-text-body"><div className="feed-message-content">{contentBlocks}</div>{assistantError && <AssistantError message={assistantError} />}{showAssistantFooter && <FeedTextFooter message={message} messageId={messageId} infoOpen={textInfoOpen} onInfoToggle={() => onDisclosureChange(textInfoKey, !textInfoOpen)} onCopyLink={onCopyLink} onFork={onFork} />}</div> : <div className="feed-message-content">{contentBlocks}{assistantError && <AssistantError message={assistantError} />}</div>;
  const calls = blocks(message.content).filter((block) => block.type === "toolCall");
  const allCallsHidden = Boolean(hiddenCalls && calls.length > 0 && calls.every((block) => hiddenCalls.has(block)));
  return <article hidden={allCallsHidden} id={messageId ? `message-${messageId}` : undefined} data-message-id={messageId} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message feed-ai-message message-agent ${target ? "permalink-target" : ""}`}>{content}</article>;
}

function RunCollapse({ active, duration, toolMessages, target, stateKey, disclosureOpen, onDisclosureChange, children }: { active: boolean; duration: string; toolMessages: number; target: boolean; stateKey: string; disclosureOpen?: boolean; onDisclosureChange: DisclosureChange; children: ReactNode }) {
  const previousActiveRef = useRef(active);
  const targetOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (target && !targetOpenedRef.current) {
      targetOpenedRef.current = true;
      if (disclosureOpen !== true) onDisclosureChange(stateKey, true);
    } else if (previousActiveRef.current && !active) onDisclosureChange(stateKey, false);
    else if (active && disclosureOpen === undefined) onDisclosureChange(stateKey, true);
    previousActiveRef.current = active;
  }, [active, disclosureOpen, onDisclosureChange, stateKey, target]);
  const open = disclosureOpen ?? (active || target);
  return <details open={open} onToggle={(event) => { if (event.currentTarget.open !== open) onDisclosureChange(stateKey, event.currentTarget.open); }} className={`run-collapse ${active ? "active" : ""}`}><summary><Clock3 size={13} />{active ? "Running" : duration}<span>{toolMessages} tool messages</span></summary><div>{children}</div></details>;
}

function ToolCallSequence({ calls, target, stateKey, disclosureOpen, onDisclosureChange, children }: { calls: ContentBlock[]; target: boolean; stateKey: string; disclosureOpen?: boolean; onDisclosureChange: DisclosureChange; children: (hiddenCalls: ReadonlySet<ContentBlock>) => ReactNode }) {
  const expanded = disclosureOpen ?? target;
  const targetOpenedRef = useRef(false);
  useLayoutEffect(() => {
    if (target && !targetOpenedRef.current) {
      targetOpenedRef.current = true;
      if (disclosureOpen !== true) onDisclosureChange(stateKey, true);
    }
  }, [disclosureOpen, onDisclosureChange, stateKey, target]);
  const hiddenCalls = new Set(expanded ? [] : calls.slice(0, -3).filter((call) => call.name !== "question" && call.name !== "question_background"));
  return <div className="feed-tool-sequence"><button type="button" className="tool-sequence-toggle" aria-expanded={expanded} onClick={() => onDisclosureChange(stateKey, !expanded)}>{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{expanded ? "show less tool call" : "show more tool call"}</button>{children(hiddenCalls)}</div>;
}

function TurnMessages({ messages, active, targetMessageId, hideReasoning, rollbackEntryId, disclosures, onDisclosureChange, onImageOpen, onCopyLink, onFork, onRollback }: { messages: AgentMessage[]; active: boolean; targetMessageId?: string; hideReasoning: boolean; rollbackEntryId?: string; disclosures: Record<string, boolean>; onDisclosureChange: DisclosureChange; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageId: string) => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const roles = useContext(RoleLabels);
  const idByMessage = new Map(messages.map((message) => [message, message.messageId]));
  const resultByToolCallId = new Map<string, AgentMessage>();
  for (const message of messages) if (message.role === "toolResult" && message.toolCallId) resultByToolCallId.set(message.toolCallId, message);
  const resultByCall = new Map<ContentBlock, AgentMessage>();
  const pairedToolResults = new Set<AgentMessage>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const calls = blocks(message.content).filter((block) => block.type === "toolCall");
    for (const call of calls) {
      const result = call.id ? resultByToolCallId.get(call.id) : calls.length === 1 && matchesToolResult(call, messages[index + 1]) ? messages[index + 1] : undefined;
      if (result) { resultByCall.set(call, result); pairedToolResults.add(result); }
    }
  }
  let latestUserMessage: AgentMessage | undefined;
  if (rollbackEntryId) for (let index = messages.length - 1; index >= 0; index -= 1) { const candidate = messages[index]; if (candidate.role === "user") { latestUserMessage = candidate; break; } }
  const renderMessage = (message: AgentMessage, key: string, hiddenCalls?: ReadonlySet<ContentBlock>) => pairedToolResults.has(message) ? null : <FeedMessage message={message} hiddenCalls={hiddenCalls} idByMessage={idByMessage} resultByCall={resultByCall} targetMessageId={targetMessageId} hideReasoning={hideReasoning} canRollback={message === latestUserMessage} rollbackTargetId={rollbackEntryId} disclosures={disclosures} onDisclosureChange={onDisclosureChange} onImageOpen={onImageOpen} onCopyLink={onCopyLink} onFork={onFork} onRollback={onRollback} key={key} />;
  const renderToolGroups = (items: AgentMessage[]) => buildToolCallGroups(items, pairedToolResults, hideReasoning).map((group, groupIndex) => {
    if (group.type === "message") return renderMessage(group.message, `message-${groupIndex}`);
    const first = group.messages[0];
    const stateKey = `tool-sequence:${first.entryId || first.messageId || groupIndex}:${group.calls[0].id || 0}`;
    if (group.calls.length <= 3) return group.messages.map((message, index) => renderMessage(message, `${stateKey}-${index}`));
    const target = Boolean(targetMessageId && (group.messages.some((message) => message.messageId === targetMessageId) || group.calls.some((call) => resultByCall.get(call)?.messageId === targetMessageId)));
    return <ToolCallSequence calls={group.calls} target={target} stateKey={stateKey} disclosureOpen={disclosures[stateKey]} onDisclosureChange={onDisclosureChange} key={stateKey}>{(hiddenCalls) => group.messages.map((message, index) => renderMessage(message, `${stateKey}-${index}`, hiddenCalls))}</ToolCallSequence>;
  });
  return <>{buildConversationSegments(messages, active).map((segment) => {
    if (segment.type === "message" && segment.message.role === "user") return renderMessage(segment.message, segment.key);
    const turnHeader = segment.type !== "warning" && segment.aiStart ? <div className="ai-turn-header" aria-label={`${roles.assistant} response`}><div className="ai-turn-avatar"><Sparkles size={15} /></div><div className="ai-turn-label">{roles.assistant}</div></div> : null;
    if (segment.type === "message") return <div className={`ai-feed-segment ${segment.aiStart ? "start" : ""}`} key={segment.key}>{turnHeader}<div className="ai-feed-content">{renderMessage(segment.message, segment.key)}</div></div>;
    if (segment.type === "collapsed") { const firstMessage = segment.messages[0]; const stateKey = `run:${firstMessage?.entryId || firstMessage?.messageId || segment.key}`; return <div className={`ai-feed-segment ${segment.aiStart ? "start" : ""}`} key={segment.key}>{turnHeader}<div className="ai-feed-content"><RunCollapse active={segment.active} duration={segment.duration} toolMessages={segment.toolMessages} target={segment.messages.some((message) => message.messageId === targetMessageId)} stateKey={stateKey} disclosureOpen={disclosures[stateKey]} onDisclosureChange={onDisclosureChange}>{renderToolGroups(segment.messages)}</RunCollapse></div></div>; }
    return <div className="ai-feed-segment" key={segment.key}><div className="ai-feed-content"><div className="turn-warning" role="status"><TriangleAlert size={14} /><div className="turn-warning-copy"><strong>{segment.title}</strong>{segment.detail && <span>{segment.detail}</span>}</div></div></div></div>;
  })}</>;
}

function number(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function fileData(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = () => reject(reader.error || new Error("Cannot read attachment")); reader.readAsDataURL(file); }); }

export function Chat({ workspace, session, sessions, sessionStatuses, targetMessageId, leafEntryId, restorePosition, hideReasoning, onSessionChanged, onSessionForked }: { workspace: Workspace; session: SessionInfo; sessions: SessionInfo[]; sessionStatuses: Record<string, SessionRuntimeStatus>; targetMessageId?: string; leafEntryId?: string; restorePosition?: { scrollTop: number; followOutput: boolean }; hideReasoning: boolean; onSessionChanged: () => void; onSessionForked: (sessionId: string) => void }) {
  const cacheKey = sessionCacheKey(workspace.id, session.id) + (leafEntryId ? `:${leafEntryId}` : "");
  const [cachedSnapshot] = useState<AgentSnapshot | null>(() => {
    const cached = getCachedSessionSnapshot(cacheKey);
    if (!cached || !targetMessageId || restorePosition) return cached || null;
    if (/^[1-9]\d*$/.test(targetMessageId)) { const legacyNumber = Number(targetMessageId); return legacyNumber > cached.messageNumberOffset && legacyNumber <= cached.messageNumberOffset + cached.messages.length ? cached : null; }
    return cached.messages.some((message) => message.messageId === targetMessageId) ? cached : null;
  });
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(cachedSnapshot);
  const [cachedUiState] = useState(() => getCachedSessionUiState(cacheKey));
  const [models, setModels] = useState<SessionModelOption[]>([]);
  const [draft, setDraft] = useState(cachedUiState?.draft || "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>(cachedUiState?.attachments || []);
  const [disclosures, setDisclosures] = useState<Record<string, boolean>>(cachedUiState?.disclosures || {});
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [status, setStatus] = useState(cachedSnapshot ? "Refreshing conversation" : "Connecting session");
  const [chatWidth, setChatWidth] = useState<ChatWidth>(() => (localStorage.getItem("pi-ark-chat-width") as ChatWidth) || "wide");
  const [infoOpen, setInfoOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState<{ source: string; alt: string } | null>(null);
  const [rollbackEntryId, setRollbackEntryId] = useState<string | null>(null);
  const [forkDialog, setForkDialog] = useState<{ entryId: string; defaultName: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const [subagentListOpen, setSubagentListOpen] = useState(false);
  const [stickyUserMessageId, setStickyUserMessageId] = useState<string>();
  const [loadingEarlierMessages, setLoadingEarlierMessages] = useState(false);
  const [queuedEditCandidate, setQueuedEditCandidate] = useState<{ id: string; text: string } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [pendingQueuedMessages, setPendingQueuedMessages] = useState<PendingQueuedMessage[]>([]);
  const [optimisticQueueOperations, setOptimisticQueueOperations] = useState<OptimisticQueueOperation[]>([]);
  const [retryNotice, setRetryNotice] = useState<{ attempt: number; maxAttempts: number; errorMessage: string } | null>(null);
  const [questionBusyId, setQuestionBusyId] = useState<string>();
  const [suggest, setSuggest] = useState<ComposerSuggestState | null>(null);
  const suggestCacheRef = useRef<{ workspaceId: string; skills?: SuggestItem[]; configured?: import("../types").McpConfiguredServer[]; servers?: import("../types").McpServerView[]; prefetching?: boolean }>({ workspaceId: "" });
  const suggestTimerRef = useRef<number | undefined>(undefined);
  const suggestSequenceRef = useRef(0);
  const socketRef = useRef<WebSocket | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(restorePosition?.followOutput ?? true);
  const restoredPositionRef = useRef<typeof restorePosition>(undefined);
  const infoRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rollbackDraftRef = useRef("");
  const scrolledPermalinkRef = useRef("");
  const sessionListedRef = useRef(sessions.some((item) => item.id === session.id));
  const changeDisclosure = useCallback<DisclosureChange>((key, open) => setDisclosures((current) => current[key] === open ? current : { ...current, [key]: open }), []);

  useEffect(() => { sessionListedRef.current = sessions.some((item) => item.id === session.id); }, [session.id, sessions]);

  useEffect(() => { void api.sessionModels().then((result) => setModels(result.models)).catch(() => setModels([])); }, [workspace.id]);
  useEffect(() => { if (snapshot) cacheSessionSnapshot(cacheKey, snapshot); }, [cacheKey, snapshot]);
  useEffect(() => { cacheSessionUiState(cacheKey, { draft, attachments, disclosures }); }, [attachments, cacheKey, disclosures, draft]);
  useLayoutEffect(() => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const style = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight) || 21;
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const maxHeight = lineHeight * 10 + verticalPadding;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
  }, [draft]);
  useEffect(() => {
    setInfoOpen(false); setRenameOpen(false); setForkDialog(null); setRollbackEntryId(null); setStickyUserMessageId(undefined); setLoadingEarlierMessages(false); setQueuedEditCandidate(null); setQueueBusy(false); setPendingQueuedMessages([]); setOptimisticQueueOperations([]); setRetryNotice(null); setStatus(cachedSnapshot ? "Refreshing conversation" : "Connecting session"); rollbackDraftRef.current = ""; scrolledPermalinkRef.current = ""; followOutputRef.current = restorePosition?.followOutput ?? true;
    let active = true;
    const connectionQuery = new URLSearchParams();
    if (leafEntryId) connectionQuery.set("leafEntryId", leafEntryId);
    if (restorePosition && cachedSnapshot) connectionQuery.set("start", String(cachedSnapshot.messageNumberOffset || 0));
    else if (targetMessageId) connectionQuery.set("message", targetMessageId);
    else if (cachedSnapshot) connectionQuery.set("start", String(cachedSnapshot.messageNumberOffset || 0));
    const socket = new WebSocket(websocketUrl(`/ws/agent/${encodeURIComponent(workspace.id)}/${encodeURIComponent(session.id)}${connectionQuery.size ? `?${connectionQuery}` : ""}`));
    socketRef.current = socket;
    socket.onopen = () => { if (active) setStatus(cachedSnapshot ? "Refreshing conversation" : "Loading conversation"); };
    socket.onclose = () => { if (active) { setStatus("Disconnected"); setLoadingEarlierMessages(false); setPendingQueuedMessages((current) => current.map((item) => item.status === "scheduling" ? { ...item, status: "failed", error: "Connection lost" } : item)); } };
    socket.onerror = () => { if (active) { setStatus("Connection error"); setLoadingEarlierMessages(false); } };
    socket.onmessage = (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot") {
        const nextSnapshot = payload.session as AgentSnapshot;
        if (nextSnapshot.rollback && rollbackDraftRef.current !== nextSnapshot.rollback.id) { rollbackDraftRef.current = nextSnapshot.rollback.id; setDraft(nextSnapshot.rollback.draft); window.requestAnimationFrame(() => composerTextareaRef.current?.focus()); }
        if (!nextSnapshot.rollback) rollbackDraftRef.current = "";
        setLoadingEarlierMessages(false);
        setQuestionBusyId(undefined);
        setPendingQueuedMessages((current) => current.filter((item) => nextSnapshot.queue.filter((queued) => queued.mode === "followUp" && queuedTextMatches(queued.text, item.matchText)).length < item.expectedMatchCount));
        setSnapshot(nextSnapshot); setStatus(nextSnapshot.isStreaming ? "AI is working" : "Ready");
      }
      if (payload.type === "subagent-state") {
        setSnapshot((current) => current ? { ...current, subagents: payload.subagents } : current);
        onSessionChanged();
      }
      if (payload.type === "queue-state") applyAuthoritativeQueueState(payload as QueueState);
      if (payload.type === "agent-event") {
        const agentEvent = payload.event;
        if (agentEvent.type === "agent_start") { setRetryNotice(null); setStatus("AI is working"); setSnapshot((current) => current ? { ...current, isStreaming: true, isIdle: false } : current); }
        if (agentEvent.type === "auto_retry_start") { setRetryNotice({ attempt: agentEvent.attempt, maxAttempts: agentEvent.maxAttempts, errorMessage: agentEvent.errorMessage || "Unknown error" }); setStatus(`Retrying (${agentEvent.attempt}/${agentEvent.maxAttempts})`); setSnapshot((current) => current ? { ...current, isStreaming: true, isIdle: false } : current); }
        if (agentEvent.type === "auto_retry_end") { setRetryNotice(null); if (!agentEvent.success) setStatus(`Retry failed: ${agentEvent.finalError || "Unknown error"}`); }
        if (agentEvent.type === "message_end" && agentEvent.message?.role === "user" && !sessionListedRef.current) { sessionListedRef.current = true; onSessionChanged(); }
        if (agentEvent.type === "agent_settled") { setRetryNotice(null); setStatus("Ready"); setSnapshot((current) => current ? { ...current, isStreaming: false, isIdle: true } : current); onSessionChanged(); }
        if (agentEvent.type === "tool_execution_start") { setStatus(`Running ${agentEvent.toolName}`); setSnapshot((current) => current ? { ...current, isStreaming: true, isIdle: false } : current); }
        if (["message_start", "message_update", "message_end"].includes(agentEvent.type) && agentEvent.message) {
          setSnapshot((current) => {
            if (!current) return current;
            const messages = [...current.messages];
            const last = messages.at(-1);
            const incoming = agentEvent.message as AgentMessage;
            const replaceLast = agentEvent.type !== "message_start" && last?.role === incoming.role;
            if (replaceLast) messages[messages.length - 1] = incoming;
            else if (last?.timestamp !== incoming.timestamp || last?.role !== incoming.role) messages.push(incoming);
            return { ...current, messages, totalDisplayMessages: current.totalDisplayMessages + Math.max(0, messages.length - current.messages.length), isStreaming: true, isIdle: false };
          });
        }
      }
      if (payload.type === "error") { setStatus(payload.message); setLoadingEarlierMessages(false); setQuestionBusyId(undefined); setPendingQueuedMessages((current) => { let pendingIndex = -1; for (let index = current.length - 1; index >= 0; index -= 1) if (current[index].status === "scheduling") { pendingIndex = index; break; } return pendingIndex < 0 ? current : current.map((item, index) => index === pendingIndex ? { ...item, status: "failed", error: payload.message } : item); }); }
    };
    return () => { active = false; socket.close(); };
  }, [workspace.id, session.id, targetMessageId, leafEntryId, restorePosition?.scrollTop, restorePosition?.followOutput, onSessionChanged, cachedSnapshot]);

  useEffect(() => {
    if (!infoOpen) return;
    const close = (event: MouseEvent) => { if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [infoOpen]);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation || !snapshot) return;
    const restoring = restorePosition && restoredPositionRef.current !== restorePosition;
    if (restoring) conversation.scrollTop = restorePosition.scrollTop;
    else if ((!targetMessageId || restorePosition) && followOutputRef.current) conversation.scrollTop = conversation.scrollHeight;
    updateConversationPosition(conversation);
    if (restoring) followOutputRef.current = restorePosition.followOutput;
    restoredPositionRef.current = restorePosition;
  }, [snapshot?.messages, snapshot?.isStreaming, targetMessageId, restorePosition]);
  const resolvedTargetMessageId = targetMessageId ? snapshot?.targetMessageId || (/^m[0-9a-z]{6}$/.test(targetMessageId) ? targetMessageId : undefined) : undefined;
  useEffect(() => {
    if (restorePosition || !resolvedTargetMessageId || !snapshot) return;
    const key = `${session.id}:${resolvedTargetMessageId}`;
    if (scrolledPermalinkRef.current === key) return;
    const element = document.getElementById(`message-${resolvedTargetMessageId}`);
    if (!element) return;
    const frame = window.requestAnimationFrame(() => { scrolledPermalinkRef.current = key; element.scrollIntoView({ behavior: "smooth", block: "center" }); });
    return () => window.cancelAnimationFrame(frame);
  }, [resolvedTargetMessageId, restorePosition, session.id, snapshot]);
  const isLoading = snapshot === null;
  const active = Boolean(snapshot && !snapshot.isIdle);
  const origin = snapshot?.subagents?.origin || session.subagentOrigin;
  const isSubagent = Boolean(origin);
  const roles = { user: isSubagent ? "Parent Agent" : "User", assistant: isSubagent ? "SubAgent" : "AI" };
  const agentItems = useMemo(() => subagentListItems((snapshot?.subagents?.origin ? snapshot.subagents.parentRuns : snapshot?.subagents?.runs) || []), [snapshot?.subagents]);
  const parentSession = origin ? sessions.find((item) => item.id === origin.parentSessionId) : undefined;
  const parentStatus = origin ? sessionStatuses[origin.parentSessionId] : undefined;
  const runtimeStatus = sessionStatuses[session.id];
  const runtimeError = status === "Ready" && runtimeStatus?.state === "error" ? runtimeStatus.errorMessage || "Session error" : undefined;
  const displayStatus = runtimeError ? "Error" : Boolean(snapshot?.waitingForAnswer) ? "Waiting for answer" : status === "AI is working" && isSubagent ? "SubAgent is working" : status;
  const allMessages = useMemo(() => snapshot?.messages.filter((message) => message.role !== "system") || [], [snapshot]);
  const messageNumberOffset = snapshot?.messageNumberOffset || 0;
  const stickyUserMessage = stickyUserMessageId ? allMessages.find((message) => message.messageId === stickyUserMessageId) : undefined;
  const stickyUserText = stickyUserMessage?.role === "user" ? messageMarkdown(stickyUserMessage).trim().split("\n", 1)[0] || `${roles.user} message` : "";
  const title = snapshot?.name || session.name || session.firstMessage || "New session";
  const modelValue = snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const selectedSessionModel = models.find((model) => `${model.provider}/${model.id}` === modelValue);
  const thinkingLevels = snapshot?.availableThinkingLevels?.length ? snapshot.availableThinkingLevels : selectedSessionModel?.thinkingLevels || ["off"];
  const displayedQueue = useMemo(() => applyQueueOperations(snapshot?.queue || [], optimisticQueueOperations), [snapshot?.queue, optimisticQueueOperations]);
  const queuedFollowUpCount = displayedQueue.filter((item) => item.mode === "followUp").length;
  const sessionContextPercent = snapshot?.stats?.contextUsage?.percent;
  const questionUi = useMemo<QuestionUi>(() => ({
    groups: new Map((snapshot?.questions || []).map((group) => [group.toolCallId, group])),
    busyId: questionBusyId,
    onAnswer: (toolCallId, answers) => { if (!send({ type: "answer-question", toolCallId, answers })) setStatus("Connection is not ready"); else setQuestionBusyId(toolCallId); },
    onDismiss: (toolCallId) => { if (!send({ type: "dismiss-question", toolCallId })) setStatus("Connection is not ready"); else setQuestionBusyId(toolCallId); },
  }), [snapshot?.questions, questionBusyId]);
  const statusIsError = Boolean(runtimeError) || !["Connecting session", "Loading conversation", "Refreshing conversation", "AI is working", "Ready", "Changing model", "Changing thinking level", "Preparing fork", "Forking session", "Rolling back latest message", "Restoring rolled back message"].includes(status) && !status.startsWith("Running ");

  function applyAuthoritativeQueueState(state: QueueState) {
    if (state.confirmedOperationId) setOptimisticQueueOperations((current) => current.filter((operation) => operation.id !== state.confirmedOperationId));
    setPendingQueuedMessages((current) => current.filter((item) => state.queue.filter((queued) => queued.mode === "followUp" && queuedTextMatches(queued.text, item.matchText)).length < item.expectedMatchCount));
    setSnapshot((current) => !current || state.queueRevision < current.queueRevision ? current : { ...current, queue: state.queue, queueRevision: state.queueRevision });
  }

  function send(command: object): boolean { if (socketRef.current?.readyState !== WebSocket.OPEN) return false; socketRef.current.send(JSON.stringify(command)); return true; }
  function selectWidth(width: ChatWidth) { setChatWidth(width); localStorage.setItem("pi-ark-chat-width", width); }
  function showEarlierMessages() {
    if (!snapshot?.hasEarlierMessages || loadingEarlierMessages) return;
    followOutputRef.current = false;
    setStickyUserMessageId(undefined);
    setLoadingEarlierMessages(true);
    if (!send({ type: "load-earlier" })) setLoadingEarlierMessages(false);
  }
  function updateConversationPosition(element: HTMLDivElement) {
    followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
    const containerTop = element.getBoundingClientRect().top;
    let nextUserMessageId: string | undefined;
    for (const userMessage of element.querySelectorAll<HTMLElement>(".message-user[data-message-id]")) {
      if (userMessage.getBoundingClientRect().top > containerTop + 1) break;
      nextUserMessageId = userMessage.dataset.messageId;
    }
    setStickyUserMessageId((current) => current === nextUserMessageId ? current : nextUserMessageId);
  }
  function locateMessage(messageId: string) {
    const conversation = conversationRef.current;
    const message = document.getElementById(`message-${messageId}`);
    if (!conversation || !message) return;
    followOutputRef.current = false;
    const conversationTop = conversation.getBoundingClientRect().top;
    const messageTop = message.getBoundingClientRect().top;
    const stickyHeight = conversation.querySelector<HTMLElement>(".conversation-sticky-user")?.getBoundingClientRect().height || 0;
    conversation.scrollTo({ top: Math.max(0, conversation.scrollTop + messageTop - conversationTop - stickyHeight - 8), behavior: "smooth" });
  }
  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const nextFiles = Array.from(files);
    if (attachments.length + nextFiles.length > 8) { setStatus("Attach no more than 8 files at once"); return; }
    if (nextFiles.some((file) => file.size > MAX_ATTACHMENT_BYTES)) { setStatus("Each attachment must be 10 MB or smaller"); return; }
    if ([...attachments.map((item) => item.file), ...nextFiles].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) { setStatus("Attachments exceed the 20 MB message limit"); return; }
    if (nextFiles.some((file) => file.type.startsWith("image/") && !SUPPORTED_IMAGES.has(file.type))) { setStatus("Use PNG, JPEG, GIF, or WebP images"); return; }
    setAttachments((current) => [...current, ...nextFiles.map((file) => ({ id: crypto.randomUUID(), file, preview: SUPPORTED_IMAGES.has(file.type) ? URL.createObjectURL(file) : undefined }))]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  function pasteAttachments(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const images = Array.from(event.clipboardData.items).filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => Boolean(file));
    if (images.length === 0) return;
    event.preventDefault();
    addFiles(images.map((file, index) => file.name ? file : new File([file], `pasted-image-${Date.now()}-${index + 1}.png`, { type: file.type || "image/png" })));
  }
  function removeAttachment(id: string) {
    setAttachments((current) => { const removed = current.find((item) => item.id === id); if (removed?.preview) URL.revokeObjectURL(removed.preview); return current.filter((item) => item.id !== id); });
  }
  async function prepareFork(entryId: string) {
    setActionBusy(true); setStatus("Preparing fork");
    try {
      const result = await api.sessions(workspace.id);
      const baseName = title.replace(/ - fork \d+$/, "");
      const escapedBaseName = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`^${escapedBaseName} - fork (\\d+)$`);
      const highestForkNumber = result.sessions.reduce((highest, item) => { const match = pattern.exec(item.name || item.firstMessage || "New session"); return Math.max(highest, match ? Number(match[1]) : 0); }, 0);
      setForkDialog({ entryId, defaultName: `${baseName} - fork ${highestForkNumber + 1}` }); setStatus(snapshot && !snapshot.isIdle ? "AI is working" : "Ready");
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot prepare fork"); }
    finally { setActionBusy(false); }
  }
  async function forkSession(name: string) {
    if (!forkDialog) return;
    setActionBusy(true); setStatus("Forking session");
    try {
      const forked = await api.forkSession(workspace.id, session.id, forkDialog.entryId);
      await api.updateSession(workspace.id, forked.id, { name });
      setForkDialog(null); onSessionChanged(); onSessionForked(forked.id);
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot fork session"); throw reason; }
    finally { setActionBusy(false); }
  }
  async function confirmRollback() {
    if (!rollbackEntryId) return;
    setActionBusy(true); setStatus("Rolling back latest message");
    try {
      const rollback = await api.rollbackSession(workspace.id, session.id, rollbackEntryId);
      rollbackDraftRef.current = rollback.id; setDraft(rollback.draft); setSnapshot((current) => current ? { ...current, rollbackEntryId: undefined, rollback } : current); setRollbackEntryId(null); onSessionChanged(); setStatus("Ready"); window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot roll back session"); }
    finally { setActionBusy(false); }
  }
  async function restoreRollback() {
    if (!snapshot?.rollback || actionBusy) return;
    setActionBusy(true); setStatus("Restoring rolled back message");
    try { await api.restoreRollback(workspace.id, session.id); rollbackDraftRef.current = ""; setDraft(""); setSnapshot((current) => current ? { ...current, rollback: undefined } : current); onSessionChanged(); setStatus("Ready"); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot restore rolled back message"); }
    finally { setActionBusy(false); }
  }
  async function updateQueue(itemId: string, update: { direction?: "up" | "down"; mode?: "steering" | "followUp" }) {
    const operation: OptimisticQueueOperation = { id: crypto.randomUUID(), type: "update", itemId, update };
    setOptimisticQueueOperations((current) => [...current, operation]);
    try { applyAuthoritativeQueueState(await api.updateQueuedMessage(workspace.id, session.id, itemId, update, operation.id)); }
    catch (reason) { setOptimisticQueueOperations((current) => current.filter((item) => item.id !== operation.id)); setStatus(reason instanceof Error ? reason.message : "Cannot update queued message"); }
  }
  async function takeQueuedMessageForEdit(item: { id: string; text: string }) {
    if (queueBusy) return;
    const operation: OptimisticQueueOperation = { id: crypto.randomUUID(), type: "remove", itemId: item.id };
    setQueueBusy(true);
    setOptimisticQueueOperations((current) => [...current, operation]);
    try {
      const result = await api.takeQueuedMessage(workspace.id, session.id, item.id, operation.id);
      applyAuthoritativeQueueState(result);
      for (const attachment of attachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      setAttachments([]);
      setDraft(result.text);
      setQueuedEditCandidate(null);
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    } catch (reason) { setOptimisticQueueOperations((current) => current.filter((queuedOperation) => queuedOperation.id !== operation.id)); setStatus(reason instanceof Error ? reason.message : "Cannot edit queued message"); }
    finally { setQueueBusy(false); }
  }
  function editQueuedMessage(item: { id: string; text: string }) {
    if (draft.trim() || attachments.length > 0) setQueuedEditCandidate(item);
    else void takeQueuedMessageForEdit(item);
  }
  async function mergeQueuedFollowUps() {
    if (queueBusy) return;
    const operation: OptimisticQueueOperation = { id: crypto.randomUUID(), type: "merge-follow-ups" };
    setQueueBusy(true);
    setOptimisticQueueOperations((current) => [...current, operation]);
    try { applyAuthoritativeQueueState(await api.mergeQueuedFollowUps(workspace.id, session.id, operation.id)); }
    catch (reason) { setOptimisticQueueOperations((current) => current.filter((item) => item.id !== operation.id)); setStatus(reason instanceof Error ? reason.message : "Cannot merge queued follow-ups"); }
    finally { setQueueBusy(false); }
  }
  function suggestCache() {
    if (suggestCacheRef.current.workspaceId !== workspace.id) suggestCacheRef.current = { workspaceId: workspace.id };
    return suggestCacheRef.current;
  }
  function mcpItemsFor(configured: import("../types").McpConfiguredServer[], servers: import("../types").McpServerView[] | undefined, query: string): SuggestItem[] {
    const split = splitMcpQuery(query);
    if (split) {
      const server = servers?.find((entry) => entry.name === split.server);
      if (!server) return [];
      return filterSuggestItems(server.tools.map((tool) => ({ id: `mcp:${server.name}/${tool}`, kind: "mcp" as const, label: `${server.name}/${tool}`, detail: "tool", insert: `$${server.name}/${tool}` })), split.tool);
    }
    return filterSuggestItems(configured.map((server) => ({ id: `mcp:${server.name}`, kind: "mcp" as const, label: server.name, detail: server.description || server.transport, status: server.exposure, insert: `$${server.name}` })), query);
  }
  function prefetchMcpTools() {
    const cache = suggestCache();
    if (cache.servers || cache.prefetching) return;
    const workspaceId = workspace.id;
    cache.prefetching = true;
    void api.mcpServers(workspaceId).then((response) => {
      if (suggestCacheRef.current.workspaceId !== workspaceId) return;
      suggestCacheRef.current.servers = response.servers.filter((server) => server.enabled);
    }).catch(() => undefined).finally(() => { suggestCacheRef.current.prefetching = false; });
  }
  function closeSuggest() {
    suggestSequenceRef.current += 1;
    setSuggest(null);
  }
  function applySuggestItem(item: SuggestItem) {
    if (!suggest) return;
    const next = applySuggestion(draft, suggest.trigger, item.insert);
    setDraft(next.text);
    closeSuggest();
    window.requestAnimationFrame(() => {
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  }
  function updateSuggest(text: string, caret: number) {
    if (suggestTimerRef.current !== undefined) window.clearTimeout(suggestTimerRef.current);
    const trigger = detectTrigger(text, caret);
    const sequence = suggestSequenceRef.current + 1;
    suggestSequenceRef.current = sequence;
    if (!trigger) { setSuggest(null); return; }
    if (trigger.kind === "file") {
      setSuggest({ trigger, items: [], selected: 0, loading: true, truncated: false });
      suggestTimerRef.current = window.setTimeout(() => {
        void api.searchWorkspaceFiles(workspace.id, trigger.query).then((result) => {
          if (suggestSequenceRef.current !== sequence) return;
          setSuggest({ trigger, items: result.entries.map((entry) => ({ id: `file:${entry.path}`, kind: "file" as const, label: entry.path.split("/").pop() || entry.path, detail: entry.path, insert: `@${entry.path}` })), selected: 0, loading: false, truncated: result.truncated });
        }).catch(() => { if (suggestSequenceRef.current === sequence) setSuggest({ trigger, items: [], selected: 0, loading: false, truncated: false }); });
      }, 120);
      return;
    }
    const cache = suggestCache();
    if (trigger.kind === "skill") {
      if (cache.skills) { setSuggest({ trigger, items: filterSuggestItems(cache.skills, trigger.query), selected: 0, loading: false, truncated: false }); return; }
      setSuggest({ trigger, items: [], selected: 0, loading: true, truncated: false });
      void api.skills(workspace.id).then((response) => {
        const items = [...response.builtin, ...response.global, ...response.workspace].filter((skill) => skill.enabled).map((skill) => ({ id: `skill:${skill.name}`, kind: "skill" as const, label: skill.name, detail: skill.description, status: skill.source, insert: `/${skill.name}` }));
        suggestCacheRef.current.skills = items;
        if (suggestSequenceRef.current !== sequence) return;
        setSuggest({ trigger, items: filterSuggestItems(items, trigger.query), selected: 0, loading: false, truncated: false });
      }).catch(() => { if (suggestSequenceRef.current === sequence) setSuggest(null); });
      return;
    }
    if (splitMcpQuery(trigger.query)) {
      if (cache.servers) { setSuggest({ trigger, items: mcpItemsFor(cache.configured || [], cache.servers, trigger.query), selected: 0, loading: false, truncated: false }); return; }
      setSuggest({ trigger, items: [], selected: 0, loading: true, truncated: false });
      void api.mcpServers(workspace.id).then((response) => {
        const servers = response.servers.filter((server) => server.enabled);
        suggestCacheRef.current.servers = servers;
        if (suggestSequenceRef.current !== sequence) return;
        setSuggest({ trigger, items: mcpItemsFor(cache.configured || [], servers, trigger.query), selected: 0, loading: false, truncated: false });
      }).catch(() => { if (suggestSequenceRef.current === sequence) setSuggest(null); });
      return;
    }
    if (cache.configured) {
      setSuggest({ trigger, items: mcpItemsFor(cache.configured, cache.servers, trigger.query), selected: 0, loading: false, truncated: false });
      prefetchMcpTools();
      return;
    }
    setSuggest({ trigger, items: [], selected: 0, loading: true, truncated: false });
    void api.mcpConfigured().then((response) => {
      const configured = response.servers.filter((server) => server.enabled);
      if (suggestCacheRef.current.workspaceId !== workspace.id) return;
      suggestCacheRef.current.configured = configured;
      if (suggestSequenceRef.current !== sequence) return;
      setSuggest({ trigger, items: mcpItemsFor(configured, cache.servers, trigger.query), selected: 0, loading: false, truncated: false });
      prefetchMcpTools();
    }).catch(() => { if (suggestSequenceRef.current === sequence) setSuggest(null); });
  }
  function moveSuggestion(direction: number) {
    if (!suggest) return;
    const count = suggest.items.length;
    if (count === 0) return;
    setSuggest({ ...suggest, selected: (suggest.selected + direction + count) % count });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    closeSuggest();
    const text = draft.trim();
    if (leafEntryId || isSubagent) return;
    if ((!text && attachments.length === 0) || socketRef.current?.readyState !== WebSocket.OPEN || preparingAttachments) return;
    const pendingId = active ? crypto.randomUUID() : undefined;
    const pendingMatchText = text || "Review the attached files.";
    if (pendingId) {
      const authoritativeMatches = snapshot?.queue.filter((item) => item.mode === "followUp" && queuedTextMatches(item.text, pendingMatchText)).length || 0;
      const localMatches = pendingQueuedMessages.filter((item) => item.matchText === pendingMatchText).length;
      const displayText = text || `Attachments: ${attachments.map((attachment) => attachment.file.name).join(", ")}`;
      setPendingQueuedMessages((current) => [...current, { id: pendingId, text: displayText, matchText: pendingMatchText, expectedMatchCount: authoritativeMatches + localMatches + 1, status: "scheduling" }]);
    }
    setPreparingAttachments(true);
    try {
      const encoded = await Promise.all(attachments.map(async (attachment) => ({ name: attachment.file.name, mimeType: attachment.file.type || "application/octet-stream", data: await fileData(attachment.file) })));
      followOutputRef.current = true;
      if (!send({ type: "prompt", text, attachments: encoded })) throw new Error("Connection is not ready");
      for (const attachment of attachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      rollbackDraftRef.current = ""; setSnapshot((current) => current ? { ...current, rollback: undefined } : current); setAttachments([]); setDraft("");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Cannot read attachments";
      if (pendingId) setPendingQueuedMessages((current) => current.map((item) => item.id === pendingId ? { ...item, status: "failed", error: message } : item));
      setStatus(message);
    }
    finally { setPreparingAttachments(false); }
  }

  return <RoleLabels.Provider value={roles}><QuestionUiContext.Provider value={questionUi}><section className={`chat-page ${leafEntryId ? "historical-branch" : ""} chat-width-${chatWidth}`} aria-busy={isLoading}>
    <div className="chat-top">{origin && <div className="parent-agent-bar" aria-label="Parent Agent status"><Sparkles size={14} /><span>Parent Agent</span>{origin.parentDeleted ? <strong>Session deleted</strong> : <SessionReference className="parent-agent-title" link={internalSessionLink(workspace.id, origin.parentSessionId)}>{parentSession?.name || parentSession?.firstMessage || "Parent Agent"}</SessionReference>}<SubagentBadge items={agentItems} open={subagentListOpen} onToggle={() => setSubagentListOpen((open) => !open)} /><span className={`status-dot ${parentStatus?.state === "error" ? "error" : ""}`} title={parentStatus?.errorMessage}><i className={parentStatus?.state === "running" ? "working" : parentStatus?.state === "error" ? "error" : ""} /><span>{parentStatus?.state || "ready"}</span></span>{!origin.parentDeleted && <SessionReference className="parent-request-link" link={origin.parentLink} leafEntryId={origin.parentLeafEntryId}>Open parent request</SessionReference>}</div>}<header className="page-header chat-header">
      <div className="chat-title"><h2>{title}</h2><button className="subtle-icon-button" title="Rename session" disabled={isLoading || Boolean(leafEntryId)} onClick={() => setRenameOpen(true)}><Pencil size={14} /></button>{!isSubagent && <SubagentBadge items={agentItems} open={subagentListOpen} onToggle={() => setSubagentListOpen((open) => !open)} />}<span className={`status-dot ${statusIsError ? "error" : ""}`} title={runtimeError || (statusIsError ? displayStatus : undefined)}><i className={statusIsError ? "error" : active || isLoading ? "working" : ""} /><span>{displayStatus}</span></span></div>
      <div className="chat-header-actions"><span className="chat-context-usage" aria-label={sessionContextPercent == null ? "Context usage unavailable" : `Context usage ${sessionContextPercent.toFixed(1)}%`}>{sessionContextPercent == null ? "—" : `${sessionContextPercent.toFixed(1)}%`}</span><div className="session-info-root" ref={infoRef}><button className="subtle-icon-button" title="Session information" disabled={isLoading} aria-expanded={infoOpen} onClick={() => setInfoOpen((current) => !current)}><Info size={16} /></button>{infoOpen && <div className="session-info-panel"><h3>Session information</h3><dl><div><dt>Created</dt><dd>{new Date(session.created).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{new Date(session.modified).toLocaleString()}</dd></div><div><dt>Messages</dt><dd>{snapshot?.totalDisplayMessages ?? session.messageCount}</dd></div><div><dt>Context</dt><dd>{sessionContextPercent == null ? "Unknown" : `${sessionContextPercent.toFixed(1)}% · ${number(snapshot?.stats?.contextUsage?.tokens || 0)} / ${number(snapshot?.stats?.contextUsage?.contextWindow || 0)}`}</dd></div><div><dt>Input total</dt><dd>{number(snapshot?.stats?.tokens.input ?? 0)}</dd></div><div><dt>Output total</dt><dd>{number(snapshot?.stats?.tokens.output ?? 0)}</dd></div><div><dt>Cost</dt><dd>${number(snapshot?.stats?.cost ?? 0)}</dd></div></dl><div className="session-info-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(sessionPermalink(workspace.id, session.id, undefined, leafEntryId)).then(() => { setSessionLinkCopied(true); window.setTimeout(() => setSessionLinkCopied(false), 1200); })}>{sessionLinkCopied ? <Check size={14} /> : <Link2 size={14} />}{sessionLinkCopied ? "Session URL copied" : "Copy session URL"}</button><div className="chat-width-control" aria-label="Conversation width">{(["compact", "wide", "full"] as const).map((width) => <button className={chatWidth === width ? "active" : ""} title={`${width} conversation width`} onClick={() => selectWidth(width)} key={width}>{width}</button>)}</div></div></div>}</div></div>
    </header>
    {leafEntryId && <div className="historical-branch-banner"><span>Historical conversation branch</span><SessionReference link={`pi-ark://workspace/${encodeURIComponent(workspace.id)}/session/${encodeURIComponent(session.id)}`}>Open current conversation</SessionReference></div>}
    {subagentListOpen && agentItems.length > 0 && <SubagentList items={agentItems} sessionId={session.id} />}</div>
    <div ref={conversationRef} className={`conversation ${isLoading ? "conversation-loading" : allMessages.length === 0 ? "conversation-empty" : ""}`} onScroll={(event) => updateConversationPosition(event.currentTarget)}>
      {isLoading ? <div className="session-loading" role="status" aria-live="polite"><div className="session-loading-icon"><LoaderCircle size={20} /></div><div><strong>Loading conversation</strong><span>{status}</span></div><div className="session-loading-progress" aria-label="Session loading progress"><i /></div></div> : allMessages.length === 0 ? <div className="empty-chat"><div className="empty-orb"><Sparkles size={28} /></div><h1>{isSubagent ? "SubAgent conversation" : "What are we building?"}</h1><p>{isSubagent ? <>Parent Agent manages this conversation in <strong>{workspace.name}</strong>.</> : <>Ask AI to inspect, explain, or change files in <strong>{workspace.name}</strong>.</>}</p></div> : <>{stickyUserMessage?.role === "user" && stickyUserMessageId && <div className="conversation-sticky-user"><button type="button" aria-label={`Go to ${roles.user} message ${stickyUserMessageId}`} onClick={() => locateMessage(stickyUserMessageId)}><span className="sticky-user-avatar"><UserRound size={15} /></span><span className="sticky-user-label">{roles.user}</span><span className="sticky-user-text" title={stickyUserText}>{stickyUserText}</span></button></div>}<div className="conversation-content">{snapshot?.hasEarlierMessages && <div className="conversation-history-page"><button type="button" disabled={loadingEarlierMessages} onClick={showEarlierMessages}>{loadingEarlierMessages ? "Loading earlier messages" : "Show earlier messages"}</button><span>{number(messageNumberOffset)} earlier messages</span></div>}<TurnMessages messages={allMessages} active={active} targetMessageId={restorePosition ? undefined : resolvedTargetMessageId} hideReasoning={hideReasoning} rollbackEntryId={snapshot?.rollbackEntryId} disclosures={disclosures} onDisclosureChange={changeDisclosure} onImageOpen={(source, alt) => setImageOpen({ source, alt })} onCopyLink={(messageId) => void navigator.clipboard.writeText(pinnedPiArkLink(internalMessageLink(workspace.id, session.id, messageId), leafEntryId))} onFork={(entryId) => { if (!actionBusy && !leafEntryId) void prepareFork(entryId); }} onRollback={setRollbackEntryId} />{retryNotice && <div className="ai-feed-segment"><div className="ai-feed-content"><div className="turn-warning retrying" role="status"><TriangleAlert size={14} /><div className="turn-warning-copy"><strong>Retrying after error (attempt {retryNotice.attempt} of {retryNotice.maxAttempts})</strong><span>{retryNotice.errorMessage}</span></div></div></div></div>}{active && <div className="working-row"><span /><span /><span /></div>}</div></>}
    </div>
    {!isLoading && snapshot?.subagents?.managed && !leafEntryId && <div className="subagent-managed-notice"><span>The parent is managing this task.</span><button type="button" className="stop-button" title="Stop" onClick={() => send({ type: "abort" })}><CircleStop size={18} /></button></div>}
    {!isLoading && !leafEntryId && !isSubagent && <form className="composer" onSubmit={(event) => void submit(event)}>
      {suggest && <ComposerSuggest kind={suggest.trigger.kind} query={suggest.trigger.query} items={suggest.items} selected={suggest.selected} loading={suggest.loading} truncated={suggest.truncated} onHover={(index) => setSuggest((current) => current ? { ...current, selected: index } : current)} onSelect={applySuggestItem} />}
      {snapshot?.rollback && <div className="rollback-restore"><span><Undo2 size={14} />Latest message rolled back</span><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => void restoreRollback()}><Undo2 size={13} />Restore message</button></div>}
      {(displayedQueue.length + pendingQueuedMessages.length > 0) && <div className="message-queue"><div className="message-queue-title"><div><strong>Queue</strong><span>Steering runs before follow-up</span></div><button type="button" className="queue-merge-button" disabled={queueBusy || queuedFollowUpCount < 2} onClick={() => void mergeQueuedFollowUps()}>Merge follow-ups</button></div>{displayedQueue.map((item) => { const sameMode = displayedQueue.filter((queued) => queued.mode === item.mode); const position = sameMode.findIndex((queued) => queued.id === item.id); return <div className="queued-message" key={item.id}><span className={`queue-mode ${item.mode}`}>{item.mode === "steering" ? "Steering" : "Follow-up"}</span><strong title={item.text}>{item.text.split("\n")[0]}</strong><div><button type="button" title="Edit queued message" aria-label="Edit queued message" disabled={queueBusy} onClick={() => editQueuedMessage(item)}><Pencil size={12} /></button><button type="button" title="Move queued message up" disabled={queueBusy || position === 0} onClick={() => void updateQueue(item.id, { direction: "up" })}><ArrowUp size={13} /></button><button type="button" title="Move queued message down" disabled={queueBusy || position === sameMode.length - 1} onClick={() => void updateQueue(item.id, { direction: "down" })}><ArrowDown size={13} /></button><button type="button" disabled={queueBusy} onClick={() => void updateQueue(item.id, { mode: item.mode === "steering" ? "followUp" : "steering" })}>{item.mode === "steering" ? "Make follow-up" : "Make steering"}</button></div></div>; })}{pendingQueuedMessages.map((item) => <div className={`queued-message pending ${item.status}`} key={item.id}><span className="queue-mode followUp">Follow-up</span><strong title={item.text}>{item.text.split("\n")[0]}</strong><div className="queue-pending-state" title={item.error}><span>{item.status === "scheduling" ? <LoaderCircle className="queue-pending-spinner" size={12} /> : <TriangleAlert size={12} />}{item.status === "scheduling" ? "Scheduling" : "Failed"}</span>{item.status === "failed" && <button type="button" title="Dismiss failed queued message" aria-label="Dismiss failed queued message" onClick={() => setPendingQueuedMessages((current) => current.filter((pending) => pending.id !== item.id))}><X size={12} /></button>}</div></div>)}</div>}
      {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <div className={`attachment-preview ${attachment.preview ? "image" : "file"}`} key={attachment.id}>{attachment.preview ? <img src={attachment.preview} alt={attachment.file.name} /> : <FileIcon size={18} />}<span><strong>{attachment.file.name}</strong><small>{number(attachment.file.size / 1024)} KB</small></span><button type="button" title={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)}><Trash2 size={13} /></button></div>)}</div>}
      <textarea ref={composerTextareaRef} value={draft} onChange={(event) => { const value = event.target.value; setDraft(value); updateSuggest(value, event.currentTarget.selectionStart); }} onPaste={pasteAttachments} onClick={(event) => updateSuggest(event.currentTarget.value, event.currentTarget.selectionStart)} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (suggest) { if (event.key === "ArrowDown") { event.preventDefault(); moveSuggestion(1); return; } if (event.key === "ArrowUp") { event.preventDefault(); moveSuggestion(-1); return; } if (event.key === "Escape") { event.preventDefault(); closeSuggest(); return; } if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) { const item = suggest.items[suggest.selected]; if (item) { event.preventDefault(); applySuggestItem(item); return; } } } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Send message here" rows={1} />
      <div className="composer-toolbar"><button type="button" className="attach-button" title="Add attachments or images" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button><input ref={fileInputRef} type="file" multiple hidden onChange={(event) => addFiles(event.target.files)} /><div className="composer-runtime composer-model"><Select ariaLabel="Session model" value={modelValue} placeholder={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "Select…"} options={models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name || model.id, description: model.id, status: model.provider }))} onChange={(value) => { const model = models.find((item) => `${item.provider}/${item.id}` === value); if (model) { setStatus("Changing model"); send({ type: "set-model", provider: model.provider, model: model.id }); } }} /></div><div className="composer-runtime composer-thinking"><Select ariaLabel="Session thinking level" value={snapshot?.thinkingLevel || ""} options={thinkingLevels.map((level) => ({ value: level, label: level }))} onChange={(level) => { setStatus("Changing thinking level"); send({ type: "set-thinking-level", level }); }} /></div><span className="composer-hint">Enter to send · Shift Enter for a new line</span><button className="send-button" title={active ? "Send follow-up" : "Send"} disabled={preparingAttachments || (!draft.trim() && attachments.length === 0)}><ArrowUp size={18} /></button><button type="button" className="stop-button" title="Stop" disabled={!active} onClick={() => send({ type: "abort" })}><CircleStop size={18} /></button></div>
    </form>}
    {!isLoading && renameOpen && <NameDialog title="Rename session" description="Set a title that is easy to find in the session list." label="Session title" initialValue={title} submitLabel="Rename session" icon={<Pencil size={18} />} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { send({ type: "rename-session", name }); setSnapshot((current) => current ? { ...current, name } : current); window.setTimeout(onSessionChanged, 150); setRenameOpen(false); }} />}
    {!isLoading && forkDialog && <NameDialog title="Fork session" description="Choose a name for the new session branch." label="Fork session title" initialValue={forkDialog.defaultName} submitLabel="Fork session" icon={<GitFork size={18} />} onClose={() => setForkDialog(null)} onSubmit={forkSession} />}
    {!isLoading && rollbackEntryId && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionBusy) setRollbackEntryId(null); }}><div className="dialog-card compact-dialog rollback-dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-session-title"><div className="dialog-header no-close"><div className="dialog-icon rollback-dialog-icon"><RotateCcw size={18} /></div><div><h2 id="rollback-session-title">Roll back latest message?</h2><p>This removes the latest conversation turn and returns its message to the composer. Project files stay unchanged.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setRollbackEntryId(null)}>Cancel</button><button type="button" className="secondary-button rollback-confirm-button" disabled={actionBusy} onClick={() => void confirmRollback()}><RotateCcw size={14} />Roll back conversation</button></div></div></div>}
    {!isLoading && queuedEditCandidate && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !queueBusy) setQueuedEditCandidate(null); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="replace-composer-title"><div className="dialog-header no-close"><div className="dialog-icon"><Pencil size={18} /></div><div><h2 id="replace-composer-title">Replace composer draft?</h2><p>The composer already contains content. Replace it with the queued message?</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={queueBusy} onClick={() => setQueuedEditCandidate(null)}>Cancel</button><button type="button" className="secondary-button" disabled={queueBusy} onClick={() => void takeQueuedMessageForEdit(queuedEditCandidate)}><Pencil size={14} />Replace draft</button></div></div></div>}
    {imageOpen && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageOpen(null); }}><button type="button" title="Close image preview" onClick={() => setImageOpen(null)}><X size={19} /></button><img src={imageOpen.source} alt={imageOpen.alt} /></div>}
  </section></QuestionUiContext.Provider></RoleLabels.Provider>;
}
