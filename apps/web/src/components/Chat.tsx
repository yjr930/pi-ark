import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ReactNode } from "react";
import { Archive, ArrowDown, ArrowUp, Check, CircleStop, Clock3, Copy, File as FileIcon, GitFork, Info, Link2, LoaderCircle, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, TriangleAlert, Undo2, UserRound, Wrench, X } from "lucide-react";
import { api, websocketUrl } from "../api";
import { buildConversationSegments, previousConversationPageStart } from "../conversation";
import { internalMessageLink, sessionPermalink } from "../permalinks";
import type { AgentMessage, AgentSnapshot, ContentBlock, SessionInfo, SessionModelOption, Workspace } from "../types";
import { Markdown } from "./Markdown";
import { NameDialog } from "./NameDialog";
import { Select } from "./Select";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
type ChatWidth = "compact" | "wide" | "full";
interface PendingAttachment { id: string; file: File; preview?: string }
interface PendingQueuedMessage { id: string; text: string; matchText: string; expectedMatchCount: number; status: "scheduling" | "failed"; error?: string }

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

function MessageLinkButton({ messageNumber, onCopyLink }: { messageNumber: number; onCopyLink: (messageNumber: number) => void }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className="icon-tooltip" aria-label={copied ? "Internal link copied" : `Copy internal link for message ${messageNumber}`} data-tooltip={copied ? "Link copied" : "Copy Pi-Ark link"} onClick={() => { onCopyLink(messageNumber); setCopied(true); window.setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check size={12} /> : <Link2 size={12} />}</button>;
}

function MessageSourceLinks({ sources, onCopyLink }: { sources: Array<{ label: string; messageNumber: number }>; onCopyLink: (messageNumber: number) => void }) {
  return <div className="feed-source-links">{sources.map((source) => <span key={`${source.label}-${source.messageNumber}`}><code>{source.label} #{source.messageNumber}</code><MessageLinkButton messageNumber={source.messageNumber} onCopyLink={onCopyLink} /></span>)}</div>;
}

function FeedTextMeta({ message, messageNumber, onCopyLink }: { message: AgentMessage; messageNumber: number; onCopyLink: (messageNumber: number) => void }) {
  const completed = message.role !== "assistant" || Boolean(message.stopReason && message.stopReason !== "pending");
  const contextTokens = message.usage?.totalTokens || (message.usage ? message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : 0);
  const contextPercent = message.contextWindow && contextTokens ? contextTokens / message.contextWindow * 100 : undefined;
  return <div className="feed-text-meta"><MessageSourceLinks sources={[{ label: "AI", messageNumber }]} onCopyLink={onCopyLink} />{completed && <div className="feed-text-metrics"><span>{message.responseModel || message.model || "Unknown model"}</span>{message.contextWindow && <span>Context {contextPercent?.toFixed(1) || "0.0"}%</span>}{message.usage && <span>I/{number(message.usage.input)} O/{number(message.usage.output)}</span>}</div>}</div>;
}

function FeedTextFooter({ message, messageNumber, infoOpen, onInfoToggle, onCopyLink, onFork }: { message: AgentMessage; messageNumber: number; infoOpen: boolean; onInfoToggle: () => void; onCopyLink: (messageNumber: number) => void; onFork: (entryId: string) => void }) {
  const [markdownCopied, setMarkdownCopied] = useState(false);
  const completed = message.role !== "assistant" || Boolean(message.stopReason && message.stopReason !== "pending");
  const markdown = messageMarkdown(message);
  return <div className="feed-text-footer">{infoOpen && <FeedTextMeta message={message} messageNumber={messageNumber} onCopyLink={onCopyLink} />}<div className="feed-text-actions">{completed && message.entryId && <><button type="button" className="icon-tooltip" aria-label={markdownCopied ? "Markdown copied" : "Copy Markdown"} data-tooltip={markdownCopied ? "Markdown copied" : "Copy Markdown"} disabled={!markdown} onClick={() => void navigator.clipboard.writeText(markdown).then(() => { setMarkdownCopied(true); window.setTimeout(() => setMarkdownCopied(false), 1200); })}>{markdownCopied ? <Check size={13} /> : <Copy size={13} />}</button><button type="button" className="icon-tooltip" aria-label="Fork session" data-tooltip="Fork session" onClick={() => onFork(message.entryId!)}><GitFork size={13} /></button></>}<button type="button" className="icon-tooltip" aria-label={infoOpen ? `Hide information for AI message ${messageNumber}` : `Show information for AI message ${messageNumber}`} aria-expanded={infoOpen} data-tooltip={infoOpen ? "Hide message information" : "Show message information"} onClick={onInfoToggle}><Info size={13} /></button></div></div>;
}

function ToolFeedItem({ call, result, summaryMessage, messageNumber, resultMessageNumber, target, onImageOpen, onCopyLink }: { call?: ContentBlock; result?: AgentMessage; summaryMessage?: AgentMessage; messageNumber: number; resultMessageNumber?: number; target: boolean; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageNumber: number) => void }) {
  const isSummary = Boolean(summaryMessage);
  const isCompaction = summaryMessage?.role === "compactionSummary";
  const name = isSummary ? isCompaction ? "Compact" : "Branch summary" : call?.name || result?.toolName || "Tool";
  const preview = isSummary ? isCompaction && summaryMessage?.tokensBefore ? `${number(summaryMessage.tokensBefore)} tokens before compact` : "Saved conversation context" : call ? toolCallPreview(call) : result ? toolResultPreview(result) : "{}";
  const status = isSummary ? "Saved" : result?.isError ? "Failed" : call ? result ? "Completed" : "Running" : "Result";
  const sources = [{ label: isSummary ? "Message" : call ? "Call" : "Result", messageNumber }, ...(resultMessageNumber ? [{ label: "Result", messageNumber: resultMessageNumber }] : [])];
  return <div className={`feed-tool-item ${target ? "permalink-target" : ""}`}>
    {resultMessageNumber && <span id={`message-${resultMessageNumber}`} data-message-number={resultMessageNumber} data-message-role="toolResult" data-entry-id={result?.entryId} className="message-inline-anchor" />}
    <details className={`feed-tool-details ${result?.isError ? "error" : ""}`} open={target || undefined}><summary><span className="feed-tool-logo">{isSummary ? <Archive size={15} /> : <Wrench size={15} />}</span><strong>{name}</strong><code title={preview}>{preview}</code><span className="feed-tool-status">{status}</span></summary><div className="feed-tool-content"><MessageSourceLinks sources={sources} onCopyLink={onCopyLink} />{call && <section><strong>Arguments</strong><div className="feed-tool-arguments">{Object.entries(call.arguments || {}).length > 0 ? Object.entries(call.arguments || {}).map(([key, value]) => <div key={key}><h5>{key}</h5><pre>{formatToolArgumentValue(value)}</pre></div>) : <p>No arguments</p>}</div></section>}{result && <section><strong>Result</strong><div>{blocks(result.content).map((block, index) => {
      if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown" onImageOpen={onImageOpen} key={index} /> : null;
      if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button" onClick={() => onImageOpen(source, "Tool result image")} key={index}><img className="message-image" src={source} alt="Tool result" /></button>; }
      return null;
    })}</div></section>}{summaryMessage?.summary && <section><strong>Summary</strong><Markdown source={summaryMessage.summary} className="message-markdown" onImageOpen={onImageOpen} /></section>}</div></details>
  </div>;
}

function FeedMessage({ message, messageNumber, numberByMessage, resultByCall, targetMessageNumber, canRollback, rollbackTargetId, onImageOpen, onCopyLink, onFork, onRollback }: { message: AgentMessage; messageNumber: number; numberByMessage: Map<AgentMessage, number>; resultByCall: Map<ContentBlock, AgentMessage>; targetMessageNumber?: number; canRollback: boolean; rollbackTargetId?: string; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageNumber: number) => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const [textInfoOpen, setTextInfoOpen] = useState(false);
  const target = messageNumber === targetMessageNumber;
  if (message.role === "compactionSummary" || message.role === "branchSummary") return <article id={`message-${messageNumber}`} data-message-number={messageNumber} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message ${target ? "permalink-target" : ""}`}><ToolFeedItem summaryMessage={message} messageNumber={messageNumber} target={target} onImageOpen={onImageOpen} onCopyLink={onCopyLink} /></article>;
  if (message.role === "toolResult") return <article id={`message-${messageNumber}`} data-message-number={messageNumber} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message ${target ? "permalink-target" : ""}`}><ToolFeedItem result={message} messageNumber={messageNumber} target={target} onImageOpen={onImageOpen} onCopyLink={onCopyLink} /></article>;
  const isUser = message.role === "user";
  const hasText = hasTextFeedContent(message);
  const contentBlocks = blocks(message.content).map((block, index) => {
    if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown feed-text-block" onImageOpen={onImageOpen} key={index} /> : null;
    if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button feed-text-block" onClick={() => onImageOpen(source, "Attached image")} key={index}><img className="message-image" src={source} alt="Attached image" /></button>; }
    if (block.type === "thinking") return block.thinking ? <details className="thinking feed-text-block" key={index}><summary>Reasoning</summary><Markdown source={block.thinking} className="message-markdown thinking-markdown" onImageOpen={onImageOpen} /></details> : null;
    if (block.type === "toolCall") { const result = resultByCall.get(block); const resultMessageNumber = result ? numberByMessage.get(result) : undefined; return <ToolFeedItem call={block} result={result} messageNumber={messageNumber} resultMessageNumber={resultMessageNumber} target={target || resultMessageNumber === targetMessageNumber} onImageOpen={onImageOpen} onCopyLink={onCopyLink} key={index} />; }
    return null;
  });
  if (isUser) return <article id={`message-${messageNumber}`} data-message-number={messageNumber} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message feed-user message-user ${target ? "permalink-target" : ""}`}><div className="feed-user-header"><div className="feed-user-identity"><div className="feed-user-avatar"><UserRound size={16} /></div><div className="feed-user-label">User <span>#{messageNumber}</span></div></div><div className="feed-user-actions"><MessageLinkButton messageNumber={messageNumber} onCopyLink={onCopyLink} />{canRollback && rollbackTargetId && <button type="button" className="icon-tooltip" aria-label="Roll back latest message" data-tooltip="Roll back latest message" onClick={() => onRollback(rollbackTargetId)}><RotateCcw size={13} /></button>}</div></div><div className="feed-message-content">{contentBlocks}</div></article>;
  const content = hasText ? <div className="feed-ai-text-body"><div className="feed-message-content">{contentBlocks}</div><FeedTextFooter message={message} messageNumber={messageNumber} infoOpen={textInfoOpen} onInfoToggle={() => setTextInfoOpen((current) => !current)} onCopyLink={onCopyLink} onFork={onFork} /></div> : <div className="feed-message-content">{contentBlocks}</div>;
  return <article id={`message-${messageNumber}`} data-message-number={messageNumber} data-message-role={message.role} data-entry-id={message.entryId} className={`feed-source-message feed-ai-message message-agent ${target ? "permalink-target" : ""}`}>{content}</article>;
}

function RunCollapse({ active, duration, toolMessages, target, children }: { active: boolean; duration: string; toolMessages: number; target: boolean; children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const previousActiveRef = useRef(active);
  useLayoutEffect(() => {
    const details = detailsRef.current;
    if (!details) return;
    if (active || target) details.open = true;
    else if (previousActiveRef.current) details.open = false;
    previousActiveRef.current = active;
  }, [active, target]);
  return <details ref={detailsRef} className={`run-collapse ${active ? "active" : ""}`}><summary><Clock3 size={13} />{active ? "Running" : duration}<span>{toolMessages} tool messages</span></summary><div>{children}</div></details>;
}

function TurnMessages({ messages, messageNumberOffset, active, targetMessageNumber, rollbackEntryId, onImageOpen, onCopyLink, onFork, onRollback }: { messages: AgentMessage[]; messageNumberOffset: number; active: boolean; targetMessageNumber?: number; rollbackEntryId?: string; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageNumber: number) => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const numberByMessage = new Map(messages.map((message, index) => [message, messageNumberOffset + index + 1]));
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
  const renderMessage = (message: AgentMessage, key: string) => pairedToolResults.has(message) ? null : <FeedMessage message={message} messageNumber={numberByMessage.get(message) || 0} numberByMessage={numberByMessage} resultByCall={resultByCall} targetMessageNumber={targetMessageNumber} canRollback={message === latestUserMessage} rollbackTargetId={rollbackEntryId} onImageOpen={onImageOpen} onCopyLink={onCopyLink} onFork={onFork} onRollback={onRollback} key={key} />;
  return <>{buildConversationSegments(messages, active).map((segment) => {
    if (segment.type === "message" && segment.message.role === "user") return renderMessage(segment.message, segment.key);
    const turnHeader = segment.type !== "warning" && segment.aiStart ? <div className="ai-turn-header" aria-label="AI response"><div className="ai-turn-avatar"><Sparkles size={15} /></div><div className="ai-turn-label">AI</div></div> : null;
    if (segment.type === "message") return <div className={`ai-feed-segment ${segment.aiStart ? "start" : ""}`} key={segment.key}>{turnHeader}<div className="ai-feed-content">{renderMessage(segment.message, segment.key)}</div></div>;
    if (segment.type === "collapsed") return <div className={`ai-feed-segment ${segment.aiStart ? "start" : ""}`} key={segment.key}>{turnHeader}<div className="ai-feed-content"><RunCollapse active={segment.active} duration={segment.duration} toolMessages={segment.toolMessages} target={segment.messages.some((message) => numberByMessage.get(message) === targetMessageNumber)}>{segment.messages.map((message, index) => renderMessage(message, `${segment.key}-${index}`))}</RunCollapse></div></div>;
    return <div className="ai-feed-segment" key={segment.key}><div className="ai-feed-content"><div className="turn-warning" role="status"><TriangleAlert size={14} /><strong>{segment.title}</strong></div></div></div>;
  })}</>;
}

function number(value: number): string { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value); }
function fileData(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = () => reject(reader.error || new Error("Cannot read attachment")); reader.readAsDataURL(file); }); }

export function Chat({ workspace, session, targetMessageNumber, onSessionChanged, onSessionForked }: { workspace: Workspace; session: SessionInfo; targetMessageNumber?: number; onSessionChanged: () => void; onSessionForked: (sessionId: string) => void }) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [models, setModels] = useState<SessionModelOption[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [preparingAttachments, setPreparingAttachments] = useState(false);
  const [status, setStatus] = useState("Connecting session");
  const [chatWidth, setChatWidth] = useState<ChatWidth>(() => (localStorage.getItem("pi-ark-chat-width") as ChatWidth) || "wide");
  const [infoOpen, setInfoOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState<{ source: string; alt: string } | null>(null);
  const [rollbackEntryId, setRollbackEntryId] = useState<string | null>(null);
  const [forkDialog, setForkDialog] = useState<{ entryId: string; defaultName: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [sessionLinkCopied, setSessionLinkCopied] = useState(false);
  const [stickyUserMessageNumber, setStickyUserMessageNumber] = useState<number>();
  const [historyStartIndex, setHistoryStartIndex] = useState(0);
  const [queuedEditCandidate, setQueuedEditCandidate] = useState<{ id: string; text: string } | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [pendingQueuedMessages, setPendingQueuedMessages] = useState<PendingQueuedMessage[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const infoRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<PendingAttachment[]>([]);
  const rollbackDraftRef = useRef("");
  const scrolledPermalinkRef = useRef("");
  const historyInitializedRef = useRef(false);

  useEffect(() => { void api.sessionModels().then((result) => setModels(result.models)).catch(() => setModels([])); }, [workspace.id]);
  useEffect(() => { attachmentRef.current = attachments; }, [attachments]);
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
  useEffect(() => () => { for (const attachment of attachmentRef.current) if (attachment.preview) URL.revokeObjectURL(attachment.preview); }, []);
  useEffect(() => {
    for (const attachment of attachmentRef.current) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
    setAttachments([]); setDraft(""); setSnapshot(null); setInfoOpen(false); setRenameOpen(false); setForkDialog(null); setRollbackEntryId(null); setStickyUserMessageNumber(undefined); setHistoryStartIndex(0); setQueuedEditCandidate(null); setQueueBusy(false); setPendingQueuedMessages([]); setStatus("Connecting session"); rollbackDraftRef.current = ""; scrolledPermalinkRef.current = ""; historyInitializedRef.current = false; followOutputRef.current = true;
    let active = true;
    const socket = new WebSocket(websocketUrl(`/ws/agent/${encodeURIComponent(workspace.id)}/${encodeURIComponent(session.id)}`));
    socketRef.current = socket;
    socket.onopen = () => { if (active) setStatus("Loading conversation"); };
    socket.onclose = () => { if (active) { setStatus("Disconnected"); setPendingQueuedMessages((current) => current.map((item) => item.status === "scheduling" ? { ...item, status: "failed", error: "Connection lost" } : item)); } };
    socket.onerror = () => { if (active) setStatus("Connection error"); };
    socket.onmessage = (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot") {
        const nextSnapshot = payload.session as AgentSnapshot;
        if (nextSnapshot.rollback && rollbackDraftRef.current !== nextSnapshot.rollback.id) { rollbackDraftRef.current = nextSnapshot.rollback.id; setDraft(nextSnapshot.rollback.draft); window.requestAnimationFrame(() => composerTextareaRef.current?.focus()); }
        if (!nextSnapshot.rollback) rollbackDraftRef.current = "";
        if (!historyInitializedRef.current) {
          const displayMessages = nextSnapshot.messages.filter((message) => message.role !== "system");
          const defaultStart = previousConversationPageStart(displayMessages);
          const targetStart = targetMessageNumber && targetMessageNumber <= displayMessages.length ? previousConversationPageStart(displayMessages, targetMessageNumber) : defaultStart;
          setHistoryStartIndex(Math.min(defaultStart, targetStart));
          historyInitializedRef.current = true;
        }
        setPendingQueuedMessages((current) => current.filter((item) => nextSnapshot.queue.filter((queued) => queued.mode === "followUp" && queuedTextMatches(queued.text, item.matchText)).length < item.expectedMatchCount));
        setSnapshot(nextSnapshot); setStatus(nextSnapshot.isStreaming ? "AI is working" : "Ready");
      }
      if (payload.type === "agent-event") {
        const agentEvent = payload.event;
        if (agentEvent.type === "agent_start") { setStatus("AI is working"); setSnapshot((current) => current ? { ...current, isStreaming: true, isIdle: false } : current); }
        if (agentEvent.type === "agent_settled") { setStatus("Ready"); setSnapshot((current) => current ? { ...current, isStreaming: false, isIdle: true } : current); onSessionChanged(); }
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
            return { ...current, messages, isStreaming: true, isIdle: false };
          });
        }
      }
      if (payload.type === "error") { setStatus(payload.message); setPendingQueuedMessages((current) => { let pendingIndex = -1; for (let index = current.length - 1; index >= 0; index -= 1) if (current[index].status === "scheduling") { pendingIndex = index; break; } return pendingIndex < 0 ? current : current.map((item, index) => index === pendingIndex ? { ...item, status: "failed", error: payload.message } : item); }); }
    };
    return () => { active = false; socket.close(); };
  }, [workspace.id, session.id, onSessionChanged]);

  useEffect(() => {
    if (!infoOpen) return;
    const close = (event: MouseEvent) => { if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [infoOpen]);

  useLayoutEffect(() => {
    const conversation = conversationRef.current;
    if (!conversation) return;
    if (!targetMessageNumber && followOutputRef.current) conversation.scrollTop = conversation.scrollHeight;
    updateConversationPosition(conversation);
  }, [snapshot?.messages, snapshot?.isStreaming, targetMessageNumber]);
  useEffect(() => {
    if (!targetMessageNumber || !snapshot) return;
    const key = `${session.id}:${targetMessageNumber}`;
    if (scrolledPermalinkRef.current === key) return;
    const element = document.getElementById(`message-${targetMessageNumber}`);
    if (!element) return;
    scrolledPermalinkRef.current = key;
    window.requestAnimationFrame(() => element.scrollIntoView({ behavior: "smooth", block: "center" }));
  }, [session.id, snapshot, targetMessageNumber]);
  const isLoading = snapshot === null;
  const active = Boolean(snapshot && !snapshot.isIdle);
  const allMessages = useMemo(() => snapshot?.messages.filter((message) => message.role !== "system") || [], [snapshot]);
  const visibleStartIndex = historyStartIndex < allMessages.length ? historyStartIndex : previousConversationPageStart(allMessages);
  const visibleMessages = useMemo(() => allMessages.slice(visibleStartIndex), [allMessages, visibleStartIndex]);
  const stickyUserMessage = stickyUserMessageNumber ? allMessages[stickyUserMessageNumber - 1] : undefined;
  const stickyUserText = stickyUserMessage?.role === "user" ? messageMarkdown(stickyUserMessage).trim().split("\n", 1)[0] || "User message" : "";
  const title = snapshot?.name || session.name || session.firstMessage || "New session";
  const modelValue = snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const selectedSessionModel = models.find((model) => `${model.provider}/${model.id}` === modelValue);
  const thinkingLevels = snapshot?.availableThinkingLevels?.length ? snapshot.availableThinkingLevels : selectedSessionModel?.thinkingLevels || ["off"];
  const queuedFollowUpCount = snapshot?.queue.filter((item) => item.mode === "followUp").length || 0;
  const sessionContextPercent = snapshot?.stats?.contextUsage?.percent;
  const statusIsError = !["Connecting session", "Loading conversation", "AI is working", "Ready", "Changing model", "Changing thinking level", "Preparing fork", "Forking session", "Rolling back latest message", "Restoring rolled back message"].includes(status) && !status.startsWith("Running ");

  function send(command: object): boolean { if (socketRef.current?.readyState !== WebSocket.OPEN) return false; socketRef.current.send(JSON.stringify(command)); return true; }
  function selectWidth(width: ChatWidth) { setChatWidth(width); localStorage.setItem("pi-ark-chat-width", width); }
  function showEarlierMessages() {
    followOutputRef.current = false;
    setStickyUserMessageNumber(undefined);
    setHistoryStartIndex((current) => previousConversationPageStart(allMessages, current));
  }
  function updateConversationPosition(element: HTMLDivElement) {
    followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
    const containerTop = element.getBoundingClientRect().top;
    let nextUserMessageNumber: number | undefined;
    for (const userMessage of element.querySelectorAll<HTMLElement>(".message-user[data-message-number]")) {
      if (userMessage.getBoundingClientRect().top > containerTop + 1) break;
      nextUserMessageNumber = Number(userMessage.dataset.messageNumber);
    }
    setStickyUserMessageNumber((current) => current === nextUserMessageNumber ? current : nextUserMessageNumber);
  }
  function locateMessage(messageNumber: number) {
    const conversation = conversationRef.current;
    const message = document.getElementById(`message-${messageNumber}`);
    if (!conversation || !message) return;
    followOutputRef.current = false;
    const conversationTop = conversation.getBoundingClientRect().top;
    const messageTop = message.getBoundingClientRect().top;
    conversation.scrollTo({ top: Math.max(0, conversation.scrollTop + messageTop - conversationTop - 8), behavior: "smooth" });
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
      setForkDialog({ entryId, defaultName: `${baseName} - fork ${highestForkNumber + 1}` }); setStatus("Ready");
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
    try { await api.updateQueuedMessage(workspace.id, session.id, itemId, update); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot update queued message"); }
  }
  async function takeQueuedMessageForEdit(item: { id: string; text: string }) {
    if (queueBusy) return;
    setQueueBusy(true);
    try {
      const result = await api.takeQueuedMessage(workspace.id, session.id, item.id);
      for (const attachment of attachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      setAttachments([]);
      setDraft(result.text);
      setQueuedEditCandidate(null);
      window.requestAnimationFrame(() => composerTextareaRef.current?.focus());
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot edit queued message"); }
    finally { setQueueBusy(false); }
  }
  function editQueuedMessage(item: { id: string; text: string }) {
    if (draft.trim() || attachments.length > 0) setQueuedEditCandidate(item);
    else void takeQueuedMessageForEdit(item);
  }
  async function mergeQueuedFollowUps() {
    if (queueBusy) return;
    setQueueBusy(true);
    try { await api.mergeQueuedFollowUps(workspace.id, session.id); }
    catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot merge queued follow-ups"); }
    finally { setQueueBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
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

  return <section className={`chat-page chat-width-${chatWidth}`} aria-busy={isLoading}>
    <header className="page-header chat-header">
      <div className="chat-title"><h2>{title}</h2><button className="subtle-icon-button" title="Rename session" disabled={isLoading} onClick={() => setRenameOpen(true)}><Pencil size={14} /></button><span className={`status-dot ${statusIsError ? "error" : ""}`}><i className={statusIsError ? "error" : active || isLoading ? "working" : ""} />{status}</span></div>
      <div className="chat-header-actions"><span className="chat-context-usage">Context {sessionContextPercent == null ? "—" : `${sessionContextPercent.toFixed(1)}%`}</span><div className="session-info-root" ref={infoRef}><button className="subtle-icon-button" title="Session information" disabled={isLoading} aria-expanded={infoOpen} onClick={() => setInfoOpen((current) => !current)}><Info size={16} /></button>{infoOpen && <div className="session-info-panel"><h3>Session information</h3><dl><div><dt>Created</dt><dd>{new Date(session.created).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{new Date(session.modified).toLocaleString()}</dd></div><div><dt>Messages</dt><dd>{snapshot?.stats?.totalMessages ?? session.messageCount}</dd></div><div><dt>Context</dt><dd>{sessionContextPercent == null ? "Unknown" : `${sessionContextPercent.toFixed(1)}% · ${number(snapshot?.stats?.contextUsage?.tokens || 0)} / ${number(snapshot?.stats?.contextUsage?.contextWindow || 0)}`}</dd></div><div><dt>Input total</dt><dd>{number(snapshot?.stats?.tokens.input ?? 0)}</dd></div><div><dt>Output total</dt><dd>{number(snapshot?.stats?.tokens.output ?? 0)}</dd></div><div><dt>Cost</dt><dd>${number(snapshot?.stats?.cost ?? 0)}</dd></div></dl><div className="session-info-actions"><button type="button" onClick={() => void navigator.clipboard.writeText(sessionPermalink(workspace.id, session.id)).then(() => { setSessionLinkCopied(true); window.setTimeout(() => setSessionLinkCopied(false), 1200); })}>{sessionLinkCopied ? <Check size={14} /> : <Link2 size={14} />}{sessionLinkCopied ? "Session URL copied" : "Copy session URL"}</button><div className="chat-width-control" aria-label="Conversation width">{(["compact", "wide", "full"] as const).map((width) => <button className={chatWidth === width ? "active" : ""} title={`${width} conversation width`} onClick={() => selectWidth(width)} key={width}>{width}</button>)}</div></div></div>}</div></div>
    </header>
    <div ref={conversationRef} className={`conversation ${isLoading ? "conversation-loading" : visibleMessages.length === 0 ? "conversation-empty" : ""}`} onScroll={(event) => updateConversationPosition(event.currentTarget)}>
      {isLoading ? <div className="session-loading" role="status" aria-live="polite"><div className="session-loading-icon"><LoaderCircle size={20} /></div><div><strong>Loading conversation</strong><span>{status}</span></div><div className="session-loading-progress" aria-label="Session loading progress"><i /></div></div> : visibleMessages.length === 0 ? <div className="empty-chat"><div className="empty-orb"><Sparkles size={28} /></div><h1>What are we building?</h1><p>Ask AI to inspect, explain, or change files in <strong>{workspace.name}</strong>.</p></div> : <>{stickyUserMessage?.role === "user" && stickyUserMessageNumber && <div className="conversation-sticky-user"><button type="button" aria-label={`Go to User message ${stickyUserMessageNumber}`} onClick={() => locateMessage(stickyUserMessageNumber)}><span className="sticky-user-avatar"><UserRound size={15} /></span><span className="sticky-user-label">User <span>#{stickyUserMessageNumber}</span></span><span className="sticky-user-text" title={stickyUserText}>{stickyUserText}</span></button></div>}<div className="conversation-content">{visibleStartIndex > 0 && <div className="conversation-history-page"><button type="button" onClick={showEarlierMessages}>Show earlier messages</button><span>{number(visibleStartIndex)} earlier messages</span></div>}<TurnMessages messages={visibleMessages} messageNumberOffset={visibleStartIndex} active={active} targetMessageNumber={targetMessageNumber} rollbackEntryId={snapshot?.rollbackEntryId} onImageOpen={(source, alt) => setImageOpen({ source, alt })} onCopyLink={(messageNumber) => void navigator.clipboard.writeText(internalMessageLink(workspace.id, session.id, messageNumber))} onFork={(entryId) => { if (!actionBusy) void prepareFork(entryId); }} onRollback={setRollbackEntryId} />{active && <div className="working-row"><span /><span /><span /></div>}</div></>}
    </div>
    {!isLoading && <form className="composer" onSubmit={(event) => void submit(event)}>
      {snapshot?.rollback && <div className="rollback-restore"><span><Undo2 size={14} />Latest message rolled back</span><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => void restoreRollback()}><Undo2 size={13} />Restore message</button></div>}
      {((snapshot?.queue.length || 0) + pendingQueuedMessages.length > 0) && <div className="message-queue"><div className="message-queue-title"><div><strong>Queue</strong><span>Steering runs before follow-up</span></div><button type="button" className="queue-merge-button" disabled={queueBusy || queuedFollowUpCount < 2} onClick={() => void mergeQueuedFollowUps()}>Merge follow-ups</button></div>{snapshot?.queue.map((item) => { const sameMode = snapshot.queue.filter((queued) => queued.mode === item.mode); const position = sameMode.findIndex((queued) => queued.id === item.id); return <div className="queued-message" key={item.id}><span className={`queue-mode ${item.mode}`}>{item.mode === "steering" ? "Steering" : "Follow-up"}</span><strong title={item.text}>{item.text.split("\n")[0]}</strong><div><button type="button" title="Edit queued message" aria-label="Edit queued message" disabled={queueBusy} onClick={() => editQueuedMessage(item)}><Pencil size={12} /></button><button type="button" title="Move queued message up" disabled={queueBusy || position === 0} onClick={() => void updateQueue(item.id, { direction: "up" })}><ArrowUp size={13} /></button><button type="button" title="Move queued message down" disabled={queueBusy || position === sameMode.length - 1} onClick={() => void updateQueue(item.id, { direction: "down" })}><ArrowDown size={13} /></button><button type="button" disabled={queueBusy} onClick={() => void updateQueue(item.id, { mode: item.mode === "steering" ? "followUp" : "steering" })}>{item.mode === "steering" ? "Make follow-up" : "Make steering"}</button></div></div>; })}{pendingQueuedMessages.map((item) => <div className={`queued-message pending ${item.status}`} key={item.id}><span className="queue-mode followUp">Follow-up</span><strong title={item.text}>{item.text.split("\n")[0]}</strong><div className="queue-pending-state" title={item.error}><span>{item.status === "scheduling" ? <LoaderCircle className="queue-pending-spinner" size={12} /> : <TriangleAlert size={12} />}{item.status === "scheduling" ? "Scheduling" : "Failed"}</span>{item.status === "failed" && <button type="button" title="Dismiss failed queued message" aria-label="Dismiss failed queued message" onClick={() => setPendingQueuedMessages((current) => current.filter((pending) => pending.id !== item.id))}><X size={12} /></button>}</div></div>)}</div>}
      {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <div className={`attachment-preview ${attachment.preview ? "image" : "file"}`} key={attachment.id}>{attachment.preview ? <img src={attachment.preview} alt={attachment.file.name} /> : <FileIcon size={18} />}<span><strong>{attachment.file.name}</strong><small>{number(attachment.file.size / 1024)} KB</small></span><button type="button" title={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)}><Trash2 size={13} /></button></div>)}</div>}
      <textarea ref={composerTextareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={pasteAttachments} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Send message here" rows={1} />
      <div className="composer-toolbar"><button type="button" className="attach-button" title="Add attachments or images" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button><input ref={fileInputRef} type="file" multiple hidden onChange={(event) => addFiles(event.target.files)} /><div className="composer-runtime composer-model"><Select ariaLabel="Session model" value={modelValue} placeholder={snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "Select…"} options={models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name || model.id, description: model.id, status: model.provider }))} onChange={(value) => { const model = models.find((item) => `${item.provider}/${item.id}` === value); if (model) { setStatus("Changing model"); send({ type: "set-model", provider: model.provider, model: model.id }); } }} /></div><div className="composer-runtime composer-thinking"><Select ariaLabel="Session thinking level" value={snapshot?.thinkingLevel || ""} options={thinkingLevels.map((level) => ({ value: level, label: level }))} onChange={(level) => { setStatus("Changing thinking level"); send({ type: "set-thinking-level", level }); }} /></div><span className="composer-hint">Enter to send · Shift Enter for a new line</span><button className="send-button" title={active ? "Send follow-up" : "Send"} disabled={preparingAttachments || (!draft.trim() && attachments.length === 0)}><ArrowUp size={18} /></button><button type="button" className="stop-button" title="Stop" disabled={!active} onClick={() => send({ type: "abort" })}><CircleStop size={18} /></button></div>
    </form>}
    {!isLoading && renameOpen && <NameDialog title="Rename session" description="Set a title that is easy to find in the session list." label="Session title" initialValue={title} submitLabel="Rename session" icon={<Pencil size={18} />} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { send({ type: "rename-session", name }); setSnapshot((current) => current ? { ...current, name } : current); window.setTimeout(onSessionChanged, 150); setRenameOpen(false); }} />}
    {!isLoading && forkDialog && <NameDialog title="Fork session" description="Choose a name for the new session branch." label="Fork session title" initialValue={forkDialog.defaultName} submitLabel="Fork session" icon={<GitFork size={18} />} onClose={() => setForkDialog(null)} onSubmit={forkSession} />}
    {!isLoading && rollbackEntryId && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionBusy) setRollbackEntryId(null); }}><div className="dialog-card compact-dialog rollback-dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-session-title"><div className="dialog-header no-close"><div className="dialog-icon rollback-dialog-icon"><RotateCcw size={18} /></div><div><h2 id="rollback-session-title">Roll back latest message?</h2><p>This removes the latest conversation turn and returns its message to the composer. Project files stay unchanged.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setRollbackEntryId(null)}>Cancel</button><button type="button" className="secondary-button rollback-confirm-button" disabled={actionBusy} onClick={() => void confirmRollback()}><RotateCcw size={14} />Roll back conversation</button></div></div></div>}
    {!isLoading && queuedEditCandidate && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !queueBusy) setQueuedEditCandidate(null); }}><div className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="replace-composer-title"><div className="dialog-header no-close"><div className="dialog-icon"><Pencil size={18} /></div><div><h2 id="replace-composer-title">Replace composer draft?</h2><p>The composer already contains content. Replace it with the queued message?</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={queueBusy} onClick={() => setQueuedEditCandidate(null)}>Cancel</button><button type="button" className="secondary-button" disabled={queueBusy} onClick={() => void takeQueuedMessageForEdit(queuedEditCandidate)}><Pencil size={14} />Replace draft</button></div></div></div>}
    {imageOpen && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageOpen(null); }}><button type="button" title="Close image preview" onClick={() => setImageOpen(null)}><X size={19} /></button><img src={imageOpen.source} alt={imageOpen.alt} /></div>}
  </section>;
}
