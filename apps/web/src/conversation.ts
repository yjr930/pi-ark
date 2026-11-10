import type { AgentMessage, ContentBlock } from "./types";

export type ConversationSegment =
  | { type: "message"; message: AgentMessage; key: string; aiStart?: boolean }
  | { type: "collapsed"; messages: AgentMessage[]; finalMessage: AgentMessage; key: string; toolMessages: number; duration: string; active: boolean; aiStart?: boolean }
  | { type: "warning"; key: string; title: string };

export const CONVERSATION_PAGE_SIZE = 100;

function isConversationBoundary(message: AgentMessage): boolean {
  return message.role === "user" || message.role === "compactionSummary" || message.role === "branchSummary";
}

export function previousConversationPageStart(messages: AgentMessage[], currentStart = messages.length, pageSize = CONVERSATION_PAGE_SIZE): number {
  const boundedStart = Math.max(0, Math.min(currentStart, messages.length));
  let nextStart = Math.max(0, boundedStart - pageSize);
  while (nextStart > 0 && !isConversationBoundary(messages[nextStart])) nextStart -= 1;
  return nextStart;
}

function blocks(content: AgentMessage["content"]): ContentBlock[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content || [];
}

function hasToolActivity(message: AgentMessage): boolean {
  return message.role === "toolResult" || blocks(message.content).some((block) => block.type === "toolCall");
}

function hasAssistantOutput(message: AgentMessage): boolean {
  return message.role === "assistant" && blocks(message.content).some((block) => block.type === "text" ? Boolean(block.text?.trim()) : block.type === "thinking" ? Boolean(block.thinking?.trim()) : block.type === "image");
}

function durationLabel(messages: AgentMessage[], finalMessage: AgentMessage): string {
  const start = messages.find((message) => message.timestamp)?.timestamp;
  const end = finalMessage.timestamp;
  if (!start || !end || end <= start) return "用时 <1 秒";
  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) return `用时 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `用时 ${minutes} 分 ${seconds % 60} 秒`;
}

export function buildConversationSegments(messages: AgentMessage[], active: boolean): ConversationSegment[] {
  const segments: ConversationSegment[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (message.role !== "user") { segments.push({ type: "message", message, key: `loose-${index}`, ...(message.role === "assistant" ? { aiStart: true } : {}) }); index += 1; continue; }
    segments.push({ type: "message", message, key: `user-${index}` });
    const responseStart = index + 1;
    let responseEnd = responseStart;
    while (responseEnd < messages.length && !isConversationBoundary(messages[responseEnd])) responseEnd += 1;
    const response = messages.slice(responseStart, responseEnd);
    const responseSegments: ConversationSegment[] = [];
    const currentTurn = active && responseEnd === messages.length;
    const lastTool = response.reduce((found, item, itemIndex) => hasToolActivity(item) ? itemIndex : found, -1);
    let finalOutput = -1;
    for (let itemIndex = response.length - 1; itemIndex > lastTool; itemIndex -= 1) if (hasAssistantOutput(response[itemIndex])) { finalOutput = itemIndex; break; }
    if (currentTurn && lastTool >= 0) {
      const collapsed = response.slice(0, lastTool + 1);
      const lastMessage = collapsed[collapsed.length - 1];
      responseSegments.push({ type: "collapsed", messages: collapsed, finalMessage: lastMessage, key: `run-${index}`, toolMessages: collapsed.filter(hasToolActivity).length, duration: durationLabel(collapsed, lastMessage), active: true });
      response.slice(lastTool + 1).forEach((item, itemIndex) => responseSegments.push({ type: "message", message: item, key: `final-${index}-${itemIndex}` }));
    } else if (!currentTurn && lastTool >= 0 && finalOutput > 0) {
      const collapsed = response.slice(0, finalOutput);
      responseSegments.push({ type: "collapsed", messages: collapsed, finalMessage: response[finalOutput], key: `run-${index}`, toolMessages: collapsed.filter(hasToolActivity).length, duration: durationLabel(collapsed, response[finalOutput]), active: false });
      response.slice(finalOutput).forEach((item, itemIndex) => responseSegments.push({ type: "message", message: item, key: `final-${index}-${itemIndex}` }));
    } else if (!currentTurn && lastTool >= 0 && response.length > 0) {
      const lastMessage = response[response.length - 1];
      responseSegments.push({ type: "collapsed", messages: response, finalMessage: lastMessage, key: `run-${index}`, toolMessages: response.filter(hasToolActivity).length, duration: durationLabel(response, lastMessage), active: false });
      responseSegments.push({ type: "warning", key: `warning-${index}`, title: "Response interrupted" });
    } else response.forEach((item, itemIndex) => responseSegments.push({ type: "message", message: item, key: `response-${index}-${itemIndex}` }));
    const firstResponseSegment = responseSegments.find((segment) => segment.type !== "warning");
    if (firstResponseSegment) firstResponseSegment.aiStart = true;
    segments.push(...responseSegments);
    index = responseEnd;
  }
  return segments;
}
