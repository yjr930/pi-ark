export const QUESTION = "question";
export const QUESTION_BACKGROUND = "question_background";
export const QUESTION_TOOLS = [QUESTION, QUESTION_BACKGROUND] as const;
export const QUESTION_ANSWER_TYPE = "pi-ark.question-answer";

export type QuestionMode = "blocking" | "background";
export type QuestionStatus = "pending" | "answered" | "unanswered";
export type QuestionReason = "dismissed" | "user_prompt" | "aborted" | "superseded" | "deleted" | "rollback";

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItem {
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  allowCustom: boolean;
}

export interface QuestionAnswer {
  index: number;
  selected: string[];
  custom: string;
}

export interface QuestionOutcome {
  status: "answered" | "unanswered";
  reason?: QuestionReason;
  answers: QuestionAnswer[];
}

export interface QuestionGroupState {
  toolCallId: string;
  mode: QuestionMode;
  token?: string;
  questions: QuestionItem[];
  status: QuestionStatus;
  reason?: QuestionReason;
  answers: QuestionAnswer[];
}

export const MAX_QUESTION_ITEMS = 8;
export const MAX_QUESTION_OPTIONS = 12;
const MAX_TEXT_LENGTH = 2000;
const MAX_LABEL_LENGTH = 120;

interface QuestionMessageLike {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  customType?: string;
  details?: unknown;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse model-supplied tool arguments into the normalized question group shown in the interface. */
export function normalizeQuestions(input: unknown): QuestionItem[] {
  const raw = isRecord(input) && Array.isArray(input.questions) ? input.questions : [];
  const questions: QuestionItem[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = text(item.question, MAX_TEXT_LENGTH);
    const options: QuestionOption[] = [];
    for (const option of Array.isArray(item.options) ? item.options : []) {
      if (!isRecord(option)) continue;
      const label = text(option.label, MAX_LABEL_LENGTH);
      if (!label || options.some((existing) => existing.label === label)) continue;
      const description = text(option.description, MAX_TEXT_LENGTH);
      options.push(description ? { label, description } : { label });
    }
    if (!question || options.length === 0) continue;
    const header = text(item.header, MAX_LABEL_LENGTH);
    questions.push({ ...(header ? { header } : {}), question, options: options.slice(0, MAX_QUESTION_OPTIONS), multiSelect: item.multiSelect === true, allowCustom: item.allowCustom !== false });
    if (questions.length >= MAX_QUESTION_ITEMS) break;
  }
  return questions;
}

export function normalizeAnswers(questions: QuestionItem[], input: unknown): QuestionAnswer[] {
  const raw = Array.isArray(input) ? input : [];
  return questions.map((question, index) => {
    const answer = raw.find((item) => isRecord(item) && item.index === index);
    if (!isRecord(answer)) return { index, selected: [], custom: "" };
    const selected = Array.isArray(answer.selected) ? [...new Set(answer.selected.filter((label): label is string => typeof label === "string" && question.options.some((option) => option.label === label)))] : [];
    const custom = question.allowCustom ? text(answer.custom, MAX_TEXT_LENGTH) : "";
    return { index, selected: question.multiSelect ? selected : selected.slice(0, 1), custom };
  });
}

export function answeredOutcome(questions: QuestionItem[], input: unknown): QuestionOutcome {
  return { status: "answered", answers: normalizeAnswers(questions, input) };
}

export function unansweredOutcome(reason: QuestionReason): QuestionOutcome {
  return { status: "unanswered", reason, answers: [] };
}

export function hasAnswer(answer: QuestionAnswer): boolean {
  return answer.selected.length > 0 || Boolean(answer.custom);
}

export function questionToken(index: number): string {
  return `Q${index}`;
}

export function questionReasonText(reason: QuestionReason | undefined): string {
  if (reason === "user_prompt") return "用户没有回答，直接发送了新的指令";
  if (reason === "aborted") return "会话被中止";
  if (reason === "superseded") return "用户收到了新的提问";
  if (reason === "deleted") return "会话被删除";
  if (reason === "rollback") return "会话回滚取消了该提问";
  return "用户放弃了作答";
}

/** Text the model receives when a background question is answered or abandoned later in the session. */
export function formatOutcomeMessage(token: string | undefined, questions: QuestionItem[], outcome: QuestionOutcome): string {
  const label = token || "问题";
  if (outcome.status === "unanswered") return `[问题取消] ${label} ${questionReasonText(outcome.reason)}。问题：${questionPromptText(questions)}`;
  const lines = questions.map((question, index) => {
    const answer = outcome.answers.find((item) => item.index === index);
    const parts = [...(answer?.selected || [])];
    if (answer?.custom) parts.push(`自由输入：${answer.custom}`);
    const block = question.header ? `「${question.header}」${question.question}` : question.question;
    return `${label} ${block} → ${parts.length ? parts.join("；") : "未选择"}`;
  });
  return `[问题回答] ${lines.join("\n[问题回答] ")}`;
}

function questionPromptText(questions: QuestionItem[]): string {
  return questions.map((question) => question.header ? `「${question.header}」${question.question}` : question.question).join("；");
}

export function formatUnansweredReason(reason: QuestionReason | undefined): string {
  return questionReasonText(reason);
}

function toolCallGroups(message: QuestionMessageLike): Array<{ toolCallId: string; name: string; input: unknown }> {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") return [];
    const name = typeof block.name === "string" ? block.name : "";
    if (!QUESTION_TOOLS.includes(name as (typeof QUESTION_TOOLS)[number])) return [];
    return [{ toolCallId: block.id, name, input: block.arguments }];
  });
}

interface ResultPayload {
  status?: string;
  reason?: string;
  token?: string;
  answers?: unknown;
}

function resultPayload(message: QuestionMessageLike): ResultPayload | undefined {
  if (message.role !== "toolResult" || !Array.isArray(message.content)) return undefined;
  const value = message.content.find((block) => isRecord(block) && block.type === "text" && typeof block.text === "string") as { text?: string } | undefined;
  if (!value?.text) return undefined;
  try {
    const parsed = JSON.parse(value.text) as unknown;
    return isRecord(parsed) ? parsed as ResultPayload : undefined;
  } catch {
    return undefined;
  }
}

/** Question state is derived from session messages so restarts and branches need no separate store. */
export function deriveQuestionGroups(messages: QuestionMessageLike[]): QuestionGroupState[] {
  const groups: QuestionGroupState[] = [];
  const byToken = new Map<string, QuestionGroupState>();
  for (const message of messages) {
    for (const call of toolCallGroups(message)) {
      const group: QuestionGroupState = {
        toolCallId: call.toolCallId,
        mode: call.name === QUESTION_BACKGROUND ? "background" : "blocking",
        questions: normalizeQuestions(call.input),
        status: "pending",
        answers: [],
      };
      groups.push(group);
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const group = groups.find((item) => item.toolCallId === message.toolCallId);
      const payload = resultPayload(message);
      if (!group || !payload) continue;
      if (payload.status === "pending") {
        if (payload.token) { group.token = payload.token; byToken.set(payload.token, group); }
        continue;
      }
      group.status = payload.status === "answered" ? "answered" : "unanswered";
      if (typeof payload.reason === "string") group.reason = payload.reason as QuestionReason;
      group.answers = normalizeAnswers(group.questions, payload.answers);
    }
    if (message.role === "custom" && message.customType === QUESTION_ANSWER_TYPE && isRecord(message.details)) {
      const details = message.details as { token?: unknown; status?: unknown; reason?: unknown; answers?: unknown };
      const group = typeof details.token === "string" ? byToken.get(details.token) : undefined;
      if (!group) continue;
      group.status = details.status === "answered" ? "answered" : "unanswered";
      if (typeof details.reason === "string") group.reason = details.reason as QuestionReason;
      group.answers = normalizeAnswers(group.questions, details.answers);
    }
  }
  return groups;
}

export function pendingQuestionGroups(groups: QuestionGroupState[]): QuestionGroupState[] {
  return groups.filter((group) => group.status === "pending");
}
