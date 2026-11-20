import type { AgentMessage, AgentSnapshot, ContentBlock } from "./types";

/** A compact `message_update` event sent by the Server: only the appended content, no partial message. */
export interface AssistantUpdate {
  type: "message_update";
  messageTimestamp?: number;
  contentIndex?: number;
  kind?: "text_start" | "text_delta" | "text_end" | "thinking_start" | "thinking_delta" | "thinking_end" | "toolcall_start" | "toolcall_end";
  delta?: string;
  content?: string;
  thinking?: string;
  thinkingSignature?: string;
  toolCall?: ContentBlock;
}

function blocks(message: AgentMessage): ContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function applyAssistantUpdate(message: AgentMessage, update: AssistantUpdate): AgentMessage {
  const index = update.contentIndex;
  if (index === undefined || !Number.isInteger(index) || index < 0) return message;
  if (update.messageTimestamp !== undefined && message.timestamp !== undefined && update.messageTimestamp !== message.timestamp) return message;
  const content = [...blocks(message)];
  const current = content[index];
  switch (update.kind) {
    case "text_start":
      content[index] = { type: "text", text: "" };
      break;
    case "text_delta":
      content[index] = { ...current, type: "text", text: `${current?.type === "text" ? current.text || "" : ""}${update.delta || ""}` };
      break;
    case "text_end":
      content[index] = { ...current, type: "text", text: update.content || "" };
      break;
    case "thinking_start":
      content[index] = { type: "thinking", thinking: update.thinking || "", ...(update.thinkingSignature ? { thinkingSignature: update.thinkingSignature } : {}) };
      break;
    case "thinking_delta":
      content[index] = { ...current, type: "thinking", thinking: `${current?.type === "thinking" ? current.thinking || "" : ""}${update.delta || ""}` };
      break;
    case "thinking_end":
      content[index] = { ...current, type: "thinking", thinking: update.content || "", ...(update.thinkingSignature ? { thinkingSignature: update.thinkingSignature } : {}) };
      break;
    case "toolcall_start":
    case "toolcall_end":
      content[index] = update.toolCall ? { ...update.toolCall } : { ...current, type: "toolCall" };
      break;
    default:
      return message;
  }
  return { ...message, content };
}

/**
 * Applies an authoritative snapshot to the current view. When the snapshot only carries the
 * messages after `messageSliceOffset`, keep the messages before that offset and replace the tail.
 * The in-progress assistant message is kept when the snapshot does not contain it.
 */
export function mergeAgentSnapshot(current: AgentSnapshot | undefined, next: AgentSnapshot, streaming?: AgentMessage): AgentSnapshot {
  const containsStreaming = (messages: AgentMessage[]) => Boolean(streaming && messages.some((message) => message.role === streaming.role && message.timestamp === streaming.timestamp));
  const withStreaming = (messages: AgentMessage[]) => (streaming && !containsStreaming(messages) ? [...messages, streaming] : messages);
  const slice = next.messageSliceOffset;
  if (!current || current.id !== next.id || slice === undefined) return { ...next, messages: withStreaming(next.messages) };
  const offset = current.messageNumberOffset;
  if (!Number.isInteger(slice) || slice < offset || slice > offset + current.messages.length) return { ...next, messages: withStreaming(next.messages) };
  const messages = withStreaming([...current.messages.slice(0, slice - offset), ...next.messages]);
  return { ...next, messageNumberOffset: offset, messageSliceOffset: undefined, messages };
}
