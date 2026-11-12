import assert from "node:assert/strict";
import { answeredOutcome, deriveQuestionGroups, formatOutcomeMessage, normalizeAnswers, normalizeQuestions, QUESTION_ANSWER_TYPE, questionToken, unansweredOutcome } from "../apps/server/src/questions.ts";

const questions = normalizeQuestions({
  questions: [
    { header: " Output format ", question: " How should the report be formatted? ", options: [{ label: "Summary", description: "Brief overview" }, { label: "Detailed" }, { label: " " }], multiSelect: true },
    { question: "Which quarters?", options: [{ label: "Q1" }, { label: "Q1" }, { label: "Q2" }], allowCustom: false, extra: true },
    { question: "", options: [{ label: "A" }, { label: "B" }] },
    { question: "No options", options: [] },
  ],
});
assert.equal(questions.length, 2);
assert.equal(questions[0].header, "Output format");
assert.equal(questions[0].question, "How should the report be formatted?");
assert.deepEqual(questions[0].options, [{ label: "Summary", description: "Brief overview" }, { label: "Detailed" }]);
assert.equal(questions[0].multiSelect, true);
assert.equal(questions[0].allowCustom, true);
assert.equal(questions[1].header, undefined);
assert.deepEqual(questions[1].options.map((option) => option.label), ["Q1", "Q2"]);
assert.equal(questions[1].multiSelect, false);
assert.equal(questions[1].allowCustom, false);

const many = normalizeQuestions({ questions: Array.from({ length: 12 }, (_, index) => ({ question: `Question ${index}`, options: [{ label: "A" }, { label: "B" }] })) });
assert.equal(many.length, 8);
assert.equal(normalizeQuestions(undefined).length, 0);
assert.equal(normalizeQuestions({ questions: "nope" }).length, 0);

const single = normalizeAnswers([questions[1]], [{ index: 0, selected: ["Q2", "Q1", "Unknown"], custom: "ignored" }]);
assert.deepEqual(single, [{ index: 0, selected: ["Q2"], custom: "" }]);
const multi = normalizeAnswers([questions[0]], [{ index: 0, selected: ["Summary", "Detailed", "Missing"], custom: " 按季度拆分 " }]);
assert.deepEqual(multi, [{ index: 0, selected: ["Summary", "Detailed"], custom: "按季度拆分" }]);
assert.deepEqual(normalizeAnswers([questions[0]], []), [{ index: 0, selected: [], custom: "" }]);
assert.deepEqual(normalizeAnswers([questions[0]], [{ index: 4, selected: ["Summary"] }])[0].selected, []);

assert.equal(questionToken(1), "Q1");
assert.equal(questionToken(12), "Q12");

const answered = answeredOutcome([questions[0]], [{ index: 0, selected: ["Summary"], custom: "" }]);
assert.equal(answered.status, "answered");
assert.equal(formatOutcomeMessage("Q1", [questions[0]], answered), "[问题回答] Q1 「Output format」How should the report be formatted? → Summary");
const cancelled = unansweredOutcome("user_prompt");
assert.equal(cancelled.status, "unanswered");
assert.match(formatOutcomeMessage("Q1", [questions[0]], cancelled), /^\[问题取消\] Q1 用户没有回答，直接发送了新的指令/);
assert.match(formatOutcomeMessage("Q1", [questions[0]], cancelled), /How should the report be formatted\?/);

const blockingCall = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "question", arguments: { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] } }] };
const blockingResult = { role: "toolResult", toolCallId: "call-1", toolName: "question", content: [{ type: "text", text: JSON.stringify({ status: "answered", answers: [{ index: 0, selected: ["B"], custom: "" }] }) }] };
const blockingGroups = deriveQuestionGroups([blockingCall, blockingResult]);
assert.equal(blockingGroups.length, 1);
assert.equal(blockingGroups[0].mode, "blocking");
assert.equal(blockingGroups[0].status, "answered");
assert.deepEqual(blockingGroups[0].answers, [{ index: 0, selected: ["B"], custom: "" }]);
assert.equal(blockingGroups[0].questions[0].question, "Pick one");

assert.equal(deriveQuestionGroups([blockingCall])[0].status, "pending");
const dismissedGroups = deriveQuestionGroups([blockingCall, { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: JSON.stringify({ status: "unanswered", reason: "rollback", answers: [] }) }] }]);
assert.equal(dismissedGroups[0].status, "unanswered");
assert.equal(dismissedGroups[0].reason, "rollback");

const backgroundCall = { role: "assistant", content: [{ type: "toolCall", id: "call-2", name: "question_background", arguments: { questions: [{ question: "Which style?", options: [{ label: "Terse" }, { label: "Verbose" }] }] } }] };
const backgroundPending = { role: "toolResult", toolCallId: "call-2", toolName: "question_background", content: [{ type: "text", text: JSON.stringify({ status: "pending", token: "Q2" }) }] };
const pendingGroups = deriveQuestionGroups([backgroundCall, backgroundPending]);
assert.equal(pendingGroups[0].mode, "background");
assert.equal(pendingGroups[0].status, "pending");
assert.equal(pendingGroups[0].token, "Q2");

const answerMessage = { role: "custom", customType: QUESTION_ANSWER_TYPE, content: [{ type: "text", text: "[问题回答] Q2 「Which style?」→ Terse" }], details: { token: "Q2", status: "answered", answers: [{ index: 0, selected: ["Terse"], custom: "" }] } };
const answeredGroups = deriveQuestionGroups([backgroundCall, backgroundPending, answerMessage]);
assert.equal(answeredGroups[0].status, "answered");
assert.deepEqual(answeredGroups[0].answers, [{ index: 0, selected: ["Terse"], custom: "" }]);
assert.equal(deriveQuestionGroups([backgroundCall, backgroundPending, { ...answerMessage, details: { token: "Q9", status: "answered" } }])[0].status, "pending");
assert.equal(deriveQuestionGroups([{ role: "assistant", content: [{ type: "toolCall", id: "call-3", name: "bash", arguments: {} }] }]).length, 0);

console.log("Question normalization, answer parsing, derivation, and outcome text checks passed.");
