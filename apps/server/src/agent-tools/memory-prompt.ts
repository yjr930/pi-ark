export const MEMORY_PROMPT_SECTION = "pi_ark_memory";

export const MEMORY_PROACTIVE_PROMPT = [
  "Before finishing the current user request, check whether the user gave a durable correction or preference, or whether this turn established a verified fact that will help in future sessions in this Workspace.",
  "When there is a clear source and lasting value, use memory_propose in this turn. Record one lesson, why it matters, and when it applies. If the evidence is a visible tool result rather than the latest user message, cite it using its message ID when available, or describe the evidence in the draft.",
  "Treat requests scoped to this task as temporary. Skip credentials, transient state, duplicated guidance, and unverified guesses. Follow the user's request if they ask to leave no memory for this task.",
  "Tell the user where to review a suggestion. Only the user can confirm it as an active Memory entry.",
].join("\n\n");
