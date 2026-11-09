import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Bot, CircleStop, Code2, Sparkles, UserRound, Wrench } from "lucide-react";
import { websocketUrl } from "../api";
import type { AgentMessage, AgentSnapshot, ContentBlock, Workspace } from "../types";

function blocks(content: AgentMessage["content"]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

function Message({ message }: { message: AgentMessage }) {
  if (message.role === "system") return null;
  const isUser = message.role === "user";
  const icon = isUser ? <UserRound size={16} /> : message.role === "assistant" ? <Sparkles size={16} /> : <Wrench size={16} />;
  return <article className={`message ${isUser ? "message-user" : "message-agent"}`}>
    <div className="message-avatar">{icon}</div>
    <div className="message-body">
      <div className="message-label">{isUser ? "You" : message.role === "assistant" ? "Pi" : message.toolName || message.role}</div>
      {blocks(message.content).map((block, index) => {
        if (block.type === "text") return <div className="message-text" key={index}>{block.text}</div>;
        if (block.type === "thinking") return block.thinking ? <details className="thinking" key={index}><summary>Reasoning</summary><div>{block.thinking}</div></details> : null;
        if (block.type === "toolCall") return <div className="tool-call" key={index}><Code2 size={14} /><span>{block.name}</span><code>{JSON.stringify(block.arguments)}</code></div>;
        return null;
      })}
    </div>
  </article>;
}

export function Chat({ workspace, sessionId, onSessionSettled }: { workspace: Workspace; sessionId: string; onSessionSettled: () => void }) {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("Connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSnapshot(null);
    const socket = new WebSocket(websocketUrl(`/ws/agent/${encodeURIComponent(workspace.id)}/${encodeURIComponent(sessionId)}`));
    socketRef.current = socket;
    socket.onopen = () => setStatus("Ready");
    socket.onclose = () => setStatus("Disconnected");
    socket.onerror = () => setStatus("Connection error");
    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === "snapshot") {
        setSnapshot(payload.session);
        setStatus(payload.session.isStreaming ? "Pi is working" : "Ready");
      }
      if (payload.type === "agent-event") {
        const agentEvent = payload.event;
        if (agentEvent.type === "agent_start") setStatus("Pi is working");
        if (agentEvent.type === "agent_settled") {
          setStatus("Ready");
          onSessionSettled();
        }
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
    return () => socket.close();
  }, [workspace.id, sessionId, onSessionSettled]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [snapshot?.messages.length, snapshot?.isStreaming]);
  const visibleMessages = useMemo(() => snapshot?.messages.filter((message) => message.role !== "system") || [], [snapshot]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: "prompt", text }));
    setDraft("");
  }

  return <section className="chat-page">
    <header className="page-header chat-header">
      <div><h2>{snapshot?.name || "New agent session"}</h2><span className="status-dot"><i className={snapshot?.isStreaming ? "working" : ""} />{status}</span></div>
      {snapshot?.model && <div className="model-chip"><Bot size={14} />{snapshot.model.id}<span>{snapshot.thinkingLevel}</span></div>}
    </header>
    <div className={`conversation ${visibleMessages.length === 0 ? "conversation-empty" : ""}`}>
      {visibleMessages.length === 0 ? <div className="empty-chat"><div className="empty-orb"><Sparkles size={28} /></div><h1>What are we building?</h1><p>Ask Pi to inspect, explain, or change files in <strong>{workspace.name}</strong>.</p></div> : visibleMessages.map((message, index) => <Message message={message} key={`${message.timestamp || 0}-${index}`} />)}
      {snapshot?.isStreaming && <div className="working-row"><span /><span /><span /></div>}
      <div ref={bottomRef} />
    </div>
    <form className="composer" onSubmit={submit}>
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={`Message Pi in ${workspace.name}`} rows={1} />
      {snapshot?.isStreaming ? <button type="button" className="stop-button" title="Stop" onClick={() => socketRef.current?.send(JSON.stringify({ type: "abort" }))}><CircleStop size={18} /></button> : <button className="send-button" title="Send" disabled={!draft.trim()}><ArrowUp size={18} /></button>}
      <div className="composer-hint">Enter to send · Shift Enter for a new line</div>
    </form>
  </section>;
}
