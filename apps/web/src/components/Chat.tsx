import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { ArrowDown, ArrowUp, Braces, Check, CircleStop, Clock3, Code2, Copy, File as FileIcon, GitFork, Info, Link2, LoaderCircle, Paperclip, Pencil, RotateCcw, Sparkles, Trash2, TriangleAlert, Undo2, UserRound, Wrench, X } from "lucide-react";
import { api, websocketUrl } from "../api";
import { buildConversationSegments } from "../conversation";
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

function blocks(content: AgentMessage["content"]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

function messageMarkdown(message: AgentMessage): string {
  return blocks(message.content).filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n\n");
}

function ToolResult({ message, onImageOpen }: { message: AgentMessage; onImageOpen: (source: string, alt: string) => void }) {
  return <details className={`tool-activity tool-result ${message.isError ? "error" : ""}`}><summary><Wrench size={13} /><strong>{message.toolName || "Tool"}</strong><span>{message.isError ? "Failed" : "Result"}</span></summary><div className="tool-activity-content">{blocks(message.content).map((block, index) => {
    if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown" onImageOpen={onImageOpen} key={index} /> : null;
    if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button" onClick={() => onImageOpen(source, "Tool result image")} key={index}><img className="message-image" src={source} alt="Tool result" /></button>; }
    return null;
  })}</div></details>;
}

function Message({ message, messageNumber, target, canRollback, onImageOpen, onCopyLink, onFork, onRollback }: { message: AgentMessage; messageNumber: number; target: boolean; canRollback: boolean; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageNumber: number, kind: "url" | "internal") => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const [markdownCopied, setMarkdownCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [internalLinkCopied, setInternalLinkCopied] = useState(false);
  if (message.role === "system") return null;
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const icon = isUser ? <UserRound size={16} /> : isAssistant ? <Sparkles size={16} /> : <Wrench size={16} />;
  const markdown = messageMarkdown(message);
  const contextTokens = message.usage?.totalTokens || (message.usage ? message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite : 0);
  const contextPercent = message.contextWindow && contextTokens ? contextTokens / message.contextWindow * 100 : undefined;
  const showFooter = isAssistant && Boolean(message.entryId) && message.stopReason !== "pending";
  return <article id={`message-${messageNumber}`} className={`message ${isUser ? "message-user" : "message-agent"} ${target ? "permalink-target" : ""}`}>
    <div className="message-avatar">{icon}</div>
    <div className="message-body">
      <div className="message-heading"><div className="message-label">{isUser ? "You" : isAssistant ? "Pi" : message.toolName || message.role}<span>#{messageNumber}</span></div><div className="message-heading-actions"><button type="button" className="message-icon-action icon-tooltip" aria-label={urlCopied ? "Message URL copied" : `Copy URL for message ${messageNumber}`} data-tooltip={urlCopied ? "URL copied" : "Copy message URL"} onClick={() => { onCopyLink(messageNumber, "url"); setUrlCopied(true); window.setTimeout(() => setUrlCopied(false), 1200); }}>{urlCopied ? <Check size={12} /> : <Link2 size={12} />}</button><button type="button" className="message-icon-action icon-tooltip" aria-label={internalLinkCopied ? "Internal link copied" : `Copy internal link for message ${messageNumber}`} data-tooltip={internalLinkCopied ? "Internal link copied" : "Copy Pi-Ark internal link"} onClick={() => { onCopyLink(messageNumber, "internal"); setInternalLinkCopied(true); window.setTimeout(() => setInternalLinkCopied(false), 1200); }}>{internalLinkCopied ? <Check size={12} /> : <Braces size={12} />}</button>{isUser && canRollback && <button type="button" className="message-icon-action icon-tooltip" aria-label="Roll back latest message" data-tooltip="Roll back latest message" onClick={() => onRollback(message.entryId!)}><RotateCcw size={12} /></button>}</div></div>
      {message.role === "toolResult" ? <ToolResult message={message} onImageOpen={onImageOpen} /> : blocks(message.content).map((block, index) => {
        if (block.type === "text") return block.text ? <Markdown source={block.text} className="message-markdown" onImageOpen={onImageOpen} key={index} /> : null;
        if (block.type === "image" && block.data && block.mimeType) { const source = `data:${block.mimeType};base64,${block.data}`; return <button type="button" className="message-image-button" onClick={() => onImageOpen(source, "Attached image")} key={index}><img className="message-image" src={source} alt="Attached image" /></button>; }
        if (block.type === "thinking") return block.thinking ? <details className="thinking" key={index}><summary>Reasoning</summary><Markdown source={block.thinking} className="message-markdown thinking-markdown" onImageOpen={onImageOpen} /></details> : null;
        if (block.type === "toolCall") return <details className="tool-activity tool-call-activity" key={index}><summary><Code2 size={13} /><strong>{block.name || "Tool"}</strong><span>Call</span></summary><pre>{JSON.stringify(block.arguments || {}, null, 2)}</pre></details>;
        return null;
      })}
      {showFooter && <div className="message-footer">
        <div className="message-metrics"><span>{message.responseModel || message.model || "Unknown model"}</span>{message.contextWindow && <span>Context {contextPercent?.toFixed(1) || "0.0"}% · {number(contextTokens)} / {number(message.contextWindow)}</span>}{message.usage && <span>Input {number(message.usage.input)} · Output {number(message.usage.output)}</span>}</div>
        <div className="message-actions"><button type="button" className="icon-tooltip" aria-label={markdownCopied ? "Markdown copied" : "Copy Markdown"} data-tooltip={markdownCopied ? "Markdown copied" : "Copy Markdown"} disabled={!markdown} onClick={() => void navigator.clipboard.writeText(markdown).then(() => { setMarkdownCopied(true); window.setTimeout(() => setMarkdownCopied(false), 1200); })}>{markdownCopied ? <Check size={13} /> : <Copy size={13} />}</button><button type="button" className="icon-tooltip" aria-label="Fork session" data-tooltip="Fork session" onClick={() => onFork(message.entryId!)}><GitFork size={13} /></button></div>
      </div>}
    </div>
  </article>;
}

function TurnMessages({ messages, streaming, targetMessageNumber, rollbackEntryId, onImageOpen, onCopyLink, onFork, onRollback }: { messages: AgentMessage[]; streaming: boolean; targetMessageNumber?: number; rollbackEntryId?: string; onImageOpen: (source: string, alt: string) => void; onCopyLink: (messageNumber: number, kind: "url" | "internal") => void; onFork: (entryId: string) => void; onRollback: (entryId: string) => void }) {
  const numberByMessage = new Map(messages.map((message, index) => [message, index + 1]));
  let latestUserMessage: AgentMessage | undefined;
  if (rollbackEntryId) for (let index = messages.length - 1; index >= 0; index -= 1) { const candidate = messages[index]; if (candidate.role === "user") { latestUserMessage = candidate; break; } }
  const render = (message: AgentMessage, key: string) => { const messageNumber = numberByMessage.get(message) || 0; return <Message message={message} messageNumber={messageNumber} target={messageNumber === targetMessageNumber} canRollback={message === latestUserMessage} onImageOpen={onImageOpen} onCopyLink={onCopyLink} onFork={onFork} onRollback={() => { if (rollbackEntryId) onRollback(rollbackEntryId); }} key={key} />; };
  return <>{buildConversationSegments(messages, streaming).map((segment) => segment.type === "message" ? render(segment.message, segment.key) : segment.type === "collapsed" ? <details className="run-collapse" open={segment.messages.some((message) => numberByMessage.get(message) === targetMessageNumber) || undefined} key={segment.key}><summary><Clock3 size={13} />{segment.duration}<span>{segment.toolMessages} tool messages</span></summary><div>{segment.messages.map((message, index) => render(message, `${segment.key}-${index}`))}</div></details> : <div className="turn-warning" role="status" key={segment.key}><TriangleAlert size={15} /><div><strong>{segment.title}</strong><span>{segment.message}</span></div></div>)}</>;
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
  const socketRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentRef = useRef<PendingAttachment[]>([]);
  const rollbackDraftRef = useRef("");
  const scrolledPermalinkRef = useRef("");

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
    setAttachments([]); setDraft(""); setSnapshot(null); setInfoOpen(false); setRenameOpen(false); setForkDialog(null); setRollbackEntryId(null); setStatus("Connecting session"); rollbackDraftRef.current = ""; scrolledPermalinkRef.current = "";
    let active = true;
    const socket = new WebSocket(websocketUrl(`/ws/agent/${encodeURIComponent(workspace.id)}/${encodeURIComponent(session.id)}`));
    socketRef.current = socket;
    socket.onopen = () => { if (active) setStatus("Loading conversation"); };
    socket.onclose = () => { if (active) setStatus("Disconnected"); };
    socket.onerror = () => { if (active) setStatus("Connection error"); };
    socket.onmessage = (event) => {
      if (!active) return;
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot") {
        const nextSnapshot = payload.session as AgentSnapshot;
        if (nextSnapshot.rollback && rollbackDraftRef.current !== nextSnapshot.rollback.id) { rollbackDraftRef.current = nextSnapshot.rollback.id; setDraft(nextSnapshot.rollback.draft); window.requestAnimationFrame(() => composerTextareaRef.current?.focus()); }
        if (!nextSnapshot.rollback) rollbackDraftRef.current = "";
        setSnapshot(nextSnapshot); setStatus(nextSnapshot.isStreaming ? "Pi is working" : "Ready");
      }
      if (payload.type === "agent-event") {
        const agentEvent = payload.event;
        if (agentEvent.type === "agent_start") setStatus("Pi is working");
        if (agentEvent.type === "agent_settled") { setStatus("Ready"); onSessionChanged(); }
        if (agentEvent.type === "tool_execution_start") setStatus(`Running ${agentEvent.toolName}`);
        if (["message_start", "message_update", "message_end"].includes(agentEvent.type) && agentEvent.message) {
          setSnapshot((current) => {
            if (!current) return current;
            const messages = [...current.messages];
            const last = messages.at(-1);
            const incoming = agentEvent.message as AgentMessage;
            const replaceLast = agentEvent.type !== "message_start" && last?.role === incoming.role;
            if (replaceLast) messages[messages.length - 1] = incoming;
            else if (last?.timestamp !== incoming.timestamp || last?.role !== incoming.role) messages.push(incoming);
            return { ...current, messages, isStreaming: agentEvent.type !== "message_end" };
          });
        }
      }
      if (payload.type === "error") setStatus(payload.message);
    };
    return () => { active = false; socket.close(); };
  }, [workspace.id, session.id, onSessionChanged]);

  useEffect(() => {
    if (!infoOpen) return;
    const close = (event: MouseEvent) => { if (!infoRef.current?.contains(event.target as Node)) setInfoOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [infoOpen]);

  useEffect(() => { if (!targetMessageNumber) bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [snapshot?.messages.length, snapshot?.isStreaming, targetMessageNumber]);
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
  const visibleMessages = useMemo(() => snapshot?.messages.filter((message) => message.role !== "system") || [], [snapshot]);
  const title = snapshot?.name || session.name || session.firstMessage || "New session";
  const modelValue = snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : "";
  const selectedSessionModel = models.find((model) => `${model.provider}/${model.id}` === modelValue);
  const thinkingLevels = snapshot?.availableThinkingLevels?.length ? snapshot.availableThinkingLevels : selectedSessionModel?.thinkingLevels || ["off"];

  function send(command: object) { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(command)); }
  function selectWidth(width: ChatWidth) { setChatWidth(width); localStorage.setItem("pi-ark-chat-width", width); }
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
  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && attachments.length === 0) || socketRef.current?.readyState !== WebSocket.OPEN || preparingAttachments) return;
    setPreparingAttachments(true);
    try {
      const encoded = await Promise.all(attachments.map(async (attachment) => ({ name: attachment.file.name, mimeType: attachment.file.type || "application/octet-stream", data: await fileData(attachment.file) })));
      send({ type: "prompt", text, attachments: encoded });
      for (const attachment of attachments) if (attachment.preview) URL.revokeObjectURL(attachment.preview);
      rollbackDraftRef.current = ""; setSnapshot((current) => current ? { ...current, rollback: undefined } : current); setAttachments([]); setDraft("");
    } catch (reason) { setStatus(reason instanceof Error ? reason.message : "Cannot read attachments"); }
    finally { setPreparingAttachments(false); }
  }

  return <section className={`chat-page chat-width-${chatWidth}`} aria-busy={isLoading}>
    <header className="page-header chat-header">
      <div className="chat-title"><div><h2>{title}</h2><span className="status-dot"><i className={snapshot?.isStreaming || isLoading ? "working" : ""} />{status}</span></div><button className="subtle-icon-button" title="Rename session" disabled={isLoading} onClick={() => setRenameOpen(true)}><Pencil size={14} /></button></div>
      <div className="chat-header-actions"><button className="subtle-icon-button" title="Copy session URL" disabled={isLoading} onClick={() => void navigator.clipboard.writeText(sessionPermalink(workspace.id, session.id)).then(() => { setSessionLinkCopied(true); window.setTimeout(() => setSessionLinkCopied(false), 1200); })}>{sessionLinkCopied ? <Check size={15} /> : <Link2 size={15} />}</button><div className="chat-width-control" aria-label="Conversation width">{(["compact", "wide", "full"] as const).map((width) => <button className={chatWidth === width ? "active" : ""} title={`${width} conversation width`} disabled={isLoading} onClick={() => selectWidth(width)} key={width}>{width}</button>)}</div><div className="session-info-root" ref={infoRef}><button className="subtle-icon-button" title="Session information" disabled={isLoading} aria-expanded={infoOpen} onClick={() => setInfoOpen((current) => !current)}><Info size={16} /></button>{infoOpen && <div className="session-info-panel"><h3>Session information</h3><dl><div><dt>Created</dt><dd>{new Date(session.created).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{new Date(session.modified).toLocaleString()}</dd></div><div><dt>Messages</dt><dd>{snapshot?.stats?.totalMessages ?? session.messageCount}</dd></div><div><dt>Context</dt><dd>{snapshot?.stats?.contextUsage?.percent == null ? "Unknown" : `${snapshot.stats.contextUsage.percent.toFixed(1)}% · ${number(snapshot.stats.contextUsage.tokens || 0)} / ${number(snapshot.stats.contextUsage.contextWindow)}`}</dd></div><div><dt>Input total</dt><dd>{number(snapshot?.stats?.tokens.input ?? 0)}</dd></div><div><dt>Output total</dt><dd>{number(snapshot?.stats?.tokens.output ?? 0)}</dd></div><div><dt>Cost</dt><dd>${number(snapshot?.stats?.cost ?? 0)}</dd></div></dl></div>}</div></div>
    </header>
    <div className={`conversation ${isLoading ? "conversation-loading" : visibleMessages.length === 0 ? "conversation-empty" : ""}`}>
      {isLoading ? <div className="session-loading" role="status" aria-live="polite"><div className="session-loading-icon"><LoaderCircle size={20} /></div><div><strong>Loading conversation</strong><span>{status}</span></div><div className="session-loading-progress" aria-label="Session loading progress"><i /></div></div> : visibleMessages.length === 0 ? <div className="empty-chat"><div className="empty-orb"><Sparkles size={28} /></div><h1>What are we building?</h1><p>Ask Pi to inspect, explain, or change files in <strong>{workspace.name}</strong>.</p></div> : <TurnMessages messages={visibleMessages} streaming={Boolean(snapshot?.isStreaming)} targetMessageNumber={targetMessageNumber} rollbackEntryId={snapshot?.rollbackEntryId} onImageOpen={(source, alt) => setImageOpen({ source, alt })} onCopyLink={(messageNumber, kind) => void navigator.clipboard.writeText(kind === "url" ? sessionPermalink(workspace.id, session.id, messageNumber) : internalMessageLink(workspace.id, session.id, messageNumber))} onFork={(entryId) => { if (!actionBusy) void prepareFork(entryId); }} onRollback={setRollbackEntryId} />}
      {!isLoading && snapshot?.isStreaming && <div className="working-row"><span /><span /><span /></div>}
      <div ref={bottomRef} />
    </div>
    {!isLoading && <form className="composer" onSubmit={(event) => void submit(event)}>
      {snapshot?.rollback && <div className="rollback-restore"><span><Undo2 size={14} />Latest message rolled back</span><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => void restoreRollback()}><Undo2 size={13} />Restore message</button></div>}
      {snapshot?.queue && snapshot.queue.length > 0 && <div className="message-queue"><div className="message-queue-title"><strong>Queue</strong><span>Steering runs before follow-up</span></div>{snapshot.queue.map((item) => { const sameMode = snapshot.queue.filter((queued) => queued.mode === item.mode); const position = sameMode.findIndex((queued) => queued.id === item.id); return <div className="queued-message" key={item.id}><span className={`queue-mode ${item.mode}`}>{item.mode === "steering" ? "Steering" : "Follow-up"}</span><strong title={item.text}>{item.text.split("\n")[0]}</strong><div><button type="button" title="Move queued message up" disabled={position === 0} onClick={() => void updateQueue(item.id, { direction: "up" })}><ArrowUp size={13} /></button><button type="button" title="Move queued message down" disabled={position === sameMode.length - 1} onClick={() => void updateQueue(item.id, { direction: "down" })}><ArrowDown size={13} /></button><button type="button" onClick={() => void updateQueue(item.id, { mode: item.mode === "steering" ? "followUp" : "steering" })}>{item.mode === "steering" ? "Make follow-up" : "Make steering"}</button></div></div>; })}</div>}
      {attachments.length > 0 && <div className="composer-attachments">{attachments.map((attachment) => <div className={`attachment-preview ${attachment.preview ? "image" : "file"}`} key={attachment.id}>{attachment.preview ? <img src={attachment.preview} alt={attachment.file.name} /> : <FileIcon size={18} />}<span><strong>{attachment.file.name}</strong><small>{number(attachment.file.size / 1024)} KB</small></span><button type="button" title={`Remove ${attachment.file.name}`} onClick={() => removeAttachment(attachment.id)}><Trash2 size={13} /></button></div>)}</div>}
      <textarea ref={composerTextareaRef} value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={pasteAttachments} onKeyDown={(event) => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return; if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={`Message Pi in ${workspace.name}`} rows={1} />
      <div className="composer-toolbar"><button type="button" className="attach-button" title="Add attachments or images" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></button><input ref={fileInputRef} type="file" multiple hidden onChange={(event) => addFiles(event.target.files)} /><div className="composer-runtime composer-model"><span>Model</span><Select ariaLabel="Session model" value={modelValue} options={models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name || model.id, description: model.id, status: model.provider }))} onChange={(value) => { const model = models.find((item) => `${item.provider}/${item.id}` === value); if (model) { setStatus("Changing model"); send({ type: "set-model", provider: model.provider, model: model.id }); } }} /></div><div className="composer-runtime composer-thinking"><span>Thinking</span><Select ariaLabel="Session thinking level" value={snapshot?.thinkingLevel || ""} options={thinkingLevels.map((level) => ({ value: level, label: level }))} onChange={(level) => { setStatus("Changing thinking level"); send({ type: "set-thinking-level", level }); }} /></div><span className="composer-hint">Enter to send · Shift Enter for a new line</span>{snapshot?.isStreaming ? <button type="button" className="stop-button" title="Stop" onClick={() => send({ type: "abort" })}><CircleStop size={18} /></button> : <button className="send-button" title="Send" disabled={preparingAttachments || (!draft.trim() && attachments.length === 0)}><ArrowUp size={18} /></button>}</div>
    </form>}
    {!isLoading && renameOpen && <NameDialog title="Rename session" description="Set a title that is easy to find in the session list." label="Session title" initialValue={title} submitLabel="Rename session" icon={<Pencil size={18} />} onClose={() => setRenameOpen(false)} onSubmit={async (name) => { send({ type: "rename-session", name }); setSnapshot((current) => current ? { ...current, name } : current); window.setTimeout(onSessionChanged, 150); setRenameOpen(false); }} />}
    {!isLoading && forkDialog && <NameDialog title="Fork session" description="Choose a name for the new session branch." label="Fork session title" initialValue={forkDialog.defaultName} submitLabel="Fork session" icon={<GitFork size={18} />} onClose={() => setForkDialog(null)} onSubmit={forkSession} />}
    {!isLoading && rollbackEntryId && <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionBusy) setRollbackEntryId(null); }}><div className="dialog-card compact-dialog rollback-dialog" role="dialog" aria-modal="true" aria-labelledby="rollback-session-title"><div className="dialog-header no-close"><div className="dialog-icon rollback-dialog-icon"><RotateCcw size={18} /></div><div><h2 id="rollback-session-title">Roll back latest message?</h2><p>This removes the latest conversation turn and returns its message to the composer. Project files stay unchanged.</p></div></div><div className="dialog-actions"><button type="button" className="secondary-button" disabled={actionBusy} onClick={() => setRollbackEntryId(null)}>Cancel</button><button type="button" className="secondary-button rollback-confirm-button" disabled={actionBusy} onClick={() => void confirmRollback()}><RotateCcw size={14} />Roll back conversation</button></div></div></div>}
    {imageOpen && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageOpen(null); }}><button type="button" title="Close image preview" onClick={() => setImageOpen(null)}><X size={19} /></button><img src={imageOpen.source} alt={imageOpen.alt} /></div>}
  </section>;
}
