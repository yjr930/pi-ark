export type SubagentTaskState = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface SubagentReference { link: string; purpose: string; leafEntryId?: string }
export interface SubagentTaskInput { title: string; task: string; expectedResult: string; references?: SubagentReference[] }
export interface SubagentUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface SubagentTask extends SubagentTaskInput {
  sessionId: string;
  sessionLink: string;
  state: SubagentTaskState;
  references: SubagentReference[];
  startedAt?: string;
  finishedAt?: string;
  currentTool?: string;
  result?: string;
  resultLink?: string;
  resultEntryId?: string;
  resultLeafEntryId?: string;
  truncated?: boolean;
  error?: string;
  usage?: SubagentUsage;
  deleted?: boolean;
}
export interface SubagentRun {
  version: 1;
  id: string;
  parentSessionId: string;
  parentLink: string;
  parentLeafEntryId?: string;
  parentDeleted?: boolean;
  toolCallId: string;
  createdAt: string;
  revision: number;
  model: { provider: string; id: string };
  thinkingLevel: string;
  tools: string[];
  systemPromptAppend: string;
  tasks: SubagentTask[];
}
export interface SubagentOrigin { runId: string; parentSessionId: string; parentLink: string; parentLeafEntryId?: string; parentDeleted?: boolean; title: string; state: SubagentTaskState }
export interface SubagentSessionState { runs: SubagentRun[]; origin?: SubagentOrigin; managed: boolean }
export function isSubagentActive(state: SubagentTaskState): boolean { return state === "queued" || state === "running"; }
