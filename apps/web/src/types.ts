import type { SubagentOrigin, SubagentSessionState } from "../../server/src/subagent-types";
export type { SubagentSessionState, SubagentRun, SubagentOrigin } from "../../server/src/subagent-types";
export type { QuestionAnswer, QuestionGroupState, QuestionItem, QuestionOption } from "../../server/src/questions";

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
  subagentOrigin?: SubagentOrigin;
}

export interface SessionGroup {
  id: string;
  name: string;
}

export interface SessionRuntimeStatus {
  id: string;
  state: "ready" | "running" | "error";
  waitingForAnswer?: boolean;
  statusRevision: number;
  updateRevision: number;
  errorMessage?: string;
}

export interface SessionStatusView extends SessionRuntimeStatus {
  viewedUpdateRevision: number;
  unread: boolean;
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
  errorMessage?: string;
  entryId?: string;
  messageId?: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  contextWindow?: number;
  summary?: string;
  tokensBefore?: number;
  compaction?: {
    tokensAfter: number;
    systemPromptTokens?: number;
    summaryTokens: number;
    retainedTokens: number;
    durationMs?: number;
    reason?: "manual" | "threshold" | "overflow";
    summarizerInputTokens?: number;
    summarizerOutputTokens?: number;
  };
  fromId?: string | null;
  customType?: string;
  display?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost?: { total: number } };
}

export interface QueuedMessage {
  id: string;
  mode: "steering" | "followUp";
  text: string;
}

export interface QueueState {
  queue: QueuedMessage[];
  queueRevision: number;
  confirmedOperationId?: string;
}

export interface AgentSnapshot {
  id: string;
  name?: string;
  messages: AgentMessage[];
  messageNumberOffset: number;
  totalDisplayMessages: number;
  targetMessageId?: string;
  hasEarlierMessages: boolean;
  isStreaming: boolean;
  isIdle: boolean;
  leafEntryId?: string;
  subagents?: SubagentSessionState;
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  availableThinkingLevels: string[];
  queue: QueuedMessage[];
  queueRevision: number;
  questions?: import("../../server/src/questions").QuestionGroupState[];
  waitingForAnswer?: boolean;
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

export interface GlobalSettings extends GlobalPreferences {
  provider: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  compactionEnabled: boolean;
  retryEnabled: boolean;
  providers: ProviderOption[];
}

export type TerminalShell = "auto" | "bash" | "zsh" | "fish" | "pwsh" | "powershell" | "git-bash" | "wsl" | "custom";

export interface TerminalSettings {
  shell: TerminalShell;
  executable: string;
  args: string[];
  env: Record<string, string>;
}

export interface TerminalProfile {
  id: TerminalShell;
  label: string;
  executable: string;
  args: string[];
  available: boolean;
}

export interface TerminalSettingsResponse {
  settings: TerminalSettings;
  profiles: TerminalProfile[];
  platform: string;
}

export interface TerminalInfo {
  id: string;
  title: string;
  createdAt: string;
  status: "running" | "exited";
  exitCode?: number;
  shell: string;
  cols: number;
  rows: number;
}

export type FileListSource = "rg" | "git" | "walk";

export interface FileSearchEntry {
  path: string;
  score: number;
}

export interface FileSearchResponse {
  query: string;
  entries: FileSearchEntry[];
  matches: number;
  total: number;
  truncated: boolean;
  source: FileListSource;
  builtAt: number;
  cached: boolean;
}

export type SkillScope = "builtin" | "global" | "workspace";

export type SkillSource = "built-in" | "managed";

export interface SkillView {
  name: string;
  description: string;
  scope: SkillScope;
  source: SkillSource;
  location: string;
  enabled: boolean;
  explicitOnly: boolean;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

export interface SkillsResponse {
  builtin: SkillView[];
  global: SkillView[];
  workspace: SkillView[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillSelection {
  disabledBuiltin: string[];
  disabledGlobal: string[];
  disabledWorkspace: Record<string, string[]>;
}

export type ExtensionStatus = "loaded" | "failed";

export interface ExtensionToolView {
  name: string;
  active: boolean;
}

export interface ExtensionView {
  name: string;
  path: string;
  entry: string;
  status: ExtensionStatus;
  tools: ExtensionToolView[];
  commands: string[];
  diagnostics: string[];
}

export interface ExtensionDiagnostic {
  path: string;
  message: string;
}

export interface ExtensionsResponse {
  directory: string;
  extensions: ExtensionView[];
  diagnostics: ExtensionDiagnostic[];
}

export type McpServerSource = "built-in" | "user";

export type McpServerState = "connected" | "disabled" | "failed" | "needs-sign-in" | "starting";

export interface McpServerView {
  name: string;
  source: McpServerSource;
  advanced: boolean;
  enabled: boolean;
  exposure: string;
  transport: string;
  state: McpServerState;
  tools: string[];
  diagnostics: string[];
}

export interface McpConfiguredServer {
  name: string;
  source: McpServerSource;
  enabled: boolean;
  exposure: string;
  description: string;
  transport: string;
}

export interface McpServersResponse {
  servers: McpServerView[];
  errors: string[];
}

export type McpBrowserState = "not-installed" | "installing" | "installed" | "failed";

export interface McpBrowserStatus {
  state: McpBrowserState;
  version?: string;
  directory: string;
  log?: string;
}

export interface GlobalPreferences {
  agent: { systemPrompt: { append: string } };
  files: { showHiddenFiles: boolean; maxPreviewSizeMb: number };
  terminal: TerminalSettings;
}
