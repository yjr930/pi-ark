import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { QUESTION, QUESTION_BACKGROUND, type QuestionItem, type QuestionOutcome } from "../questions.js";

const questionItemSchema = Type.Object({
  header: Type.Optional(Type.String({ maxLength: 120, description: "Short label shown above the question, for example Output format" })),
  question: Type.String({ minLength: 1, maxLength: 2000, description: "Complete question shown to the user" }),
  options: Type.Array(Type.Object({
    label: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 2000 })),
  }), { minItems: 2, maxItems: 12 }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting several options. Defaults to a single choice" })),
  allowCustom: Type.Optional(Type.Boolean({ description: "Allow free text in addition to the options. Defaults to true" })),
});

const parameters = Type.Object({
  questions: Type.Array(questionItemSchema, { minItems: 1, maxItems: 8, description: "Questions submitted together as one form" }),
});

export type BlockingQuestionDispatch = (toolCallId: string, questions: QuestionItem[], signal?: AbortSignal) => Promise<QuestionOutcome>;
export type BackgroundQuestionDispatch = (toolCallId: string, questions: QuestionItem[]) => Promise<{ token?: string }>;

const SHARED_GUIDELINES = [
  "Ask questions only when a decision belongs to the user; derive the answer from the workspace or the conversation whenever evidence exists.",
  "Each question needs a complete sentence and two or more concrete options. Set multiSelect when several options can hold at the same time.",
  "Free text is allowed by default, so options do not need to cover every possibility.",
  "One call is one form. The user either submits the form or dismisses the whole group; a single question may stay empty.",
  "Never repeat a question that is already open or already answered.",
];

export function createQuestionTools(ask: BlockingQuestionDispatch, askBackground: BackgroundQuestionDispatch): ToolDefinition[] {
  const blocking = defineTool({
    name: QUESTION,
    label: "Question",
    description: "Ask the user a group of questions and pause until the user answers or dismisses the group. Use this when your next action depends on the answer. The questions appear as a form with clickable options where the user can select one or several options, add free text, or dismiss the whole group. The result has status answered with the selections, or status unanswered with a reason: the user dismissed the group, sent a new message, the session stopped, or the conversation was rolled back. Treat unanswered as the user leaving the decision to you, and state which default you took.",
    promptSnippet: "Ask the user a blocking question group and wait for the answer",
    promptGuidelines: [...SHARED_GUIDELINES, "Use the blocking question tool when you cannot continue without the answer."],
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(toolCallId, input, signal) {
      const questions = (input as { questions: QuestionItem[] }).questions;
      const outcome = await ask(toolCallId, questions, signal);
      const payload = { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}), answers: outcome.answers };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: { mode: "blocking", ...payload },
        isError: false,
      };
    },
  });

  const background = defineTool({
    name: QUESTION_BACKGROUND,
    label: "Background question",
    description: "Ask the user a group of questions without pausing the run. The call returns at once with status pending and a short token such as Q1. Continue with work that does not depend on the answer, and state which question is still open before ending the turn. The answer arrives later as a separate message starting with [问题回答] or [问题取消] that restates the question. At most one question group stays open in a session; starting a new group cancels the previous one.",
    promptSnippet: "Ask the user a non-blocking question group and keep working",
    promptGuidelines: [...SHARED_GUIDELINES, "Use the background question tool only when the current work does not depend on the answer, and keep working after the call returns."],
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(toolCallId, input) {
      const questions = (input as { questions: QuestionItem[] }).questions;
      const { token } = await askBackground(toolCallId, questions);
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "pending", token }, null, 2) }],
        details: { mode: "background", status: "pending", token },
        isError: false,
      };
    },
  });

  return [blocking, background];
}
