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
  pinned: boolean;
  archived: boolean;
  groups: string[];
}

export interface SessionGroup {
  id: string;
  name: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}

export interface AgentMessage {
  role: string;
  content?: string | ContentBlock[];
  timestamp?: number;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  stopReason?: string;
  entryId?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  contextWindow?: number;
  summary?: string;
  tokensBefore?: number;
  fromId?: string | null;
  customType?: string;
  display?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } };
}

export interface AgentSnapshot {
  id: string;
  name?: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  isIdle: boolean;
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  queue: Array<{ id: string; mode: "steering" | "followUp"; text: string }>;
  rollbackEntryId?: string;
  rollback?: { id: string; targetId: string; restoreEntryId: string; draft: string };
  stats: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    totalMessages: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
    contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  };
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
}

export type FileContent = { name: string; path: string; size: number } & ({ kind: "text"; content: string; markdown: boolean } | { kind: "image"; mimeType: string });

export interface ProviderOption {
  id: string;
  name: string;
  configured: boolean;
  authSource?: string;
  authLabel?: string;
  canDisconnect: boolean;
  supportsSubscription: boolean;
  subscriptionName?: string;
  subscriptionLoginLabel?: string;
  usingSubscription: boolean;
}

export interface SubscriptionAuthEvent {
  id: number;
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  url?: string;
  instructions?: string;
  links?: Array<{ url: string; label?: string }>;
  userCode?: string;
  verificationUri?: string;
  expiresInSeconds?: number;
}

export interface SubscriptionAuthFlow {
  id: string;
  providerId: string;
  status: "pending" | "success" | "error" | "cancelled";
  events: SubscriptionAuthEvent[];
  prompt?: { id: string; type: "text" | "secret" | "manual_code" | "select"; message: string; placeholder?: string; options?: Array<{ id: string; label: string; description?: string }> };
  error?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  input: string[];
  thinkingLevels: GlobalSettings["thinkingLevel"][];
}

export interface SessionModelOption extends Omit<ModelOption, "input"> {
  provider: string;
}

export interface ModelPreferenceOption extends SessionModelOption {
  providerName: string;
  enabled: boolean;
}

export interface ModelPreferences {
  models: ModelPreferenceOption[];
  defaultProvider: string;
  defaultModel: string;
  thinkingLevel: GlobalSettings["thinkingLevel"];
}

export type ThemeId = "ark-dark" | "graphite" | "midnight" | "paper" | "snow";

export interface ReleaseInfo {
  version: string;
  coreVersion: string;
  corePath: string;
  agentDir: string;
  dataDir: string;
  installPath: string;
  installedRelease: boolean;
  channel: string;
  latestVersion?: string;
  latestUrl?: string;
  updateAvailable: boolean;
  updating: boolean;
  previousVersion?: string;
  rollbackAvailable: boolean;
  restartScheduled?: boolean;
  restartDelaySeconds?: number;
  commands: { update: string; rollback: string; status: string; logs: string; restart: string };
}

export interface GlobalSettings {
  theme: ThemeId;
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  compactionEnabled: boolean;
  retryEnabled: boolean;
  providers: ProviderOption[];
}

export interface WorkspaceSettings {
  version: 5;
  workspaceId: string;
  agent: { tools: Array<"read" | "bash" | "edit" | "write">; systemPrompt: { append: string } };
  files: { showHiddenFiles: boolean; maxPreviewSizeMb: number };
}
