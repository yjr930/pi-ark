export interface Workspace {
  id: string;
  name: string;
  path: string;
}

export interface SessionInfo {
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  timestamp?: number;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
}

export interface AgentSnapshot {
  id: string;
  name?: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  isIdle: boolean;
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

export interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  markdown: boolean;
}
