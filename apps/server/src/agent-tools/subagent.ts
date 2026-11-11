import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { subagentResult } from "../subagents.js";
import type { SubagentRun, SubagentTaskInput } from "../subagent-types.js";

export const SUBAGENT = "subagent";
export function createSubagentTool(dispatch: (toolCallId: string, tasks: SubagentTaskInput[], signal?: AbortSignal, onUpdate?: (run: SubagentRun) => void) => Promise<SubagentRun>) {
  return defineTool({
    name: SUBAGENT,
    label: "Subagents",
    description: "Delegate 1–8 self-contained tasks to persistent child Pi-Ark Sessions. Tasks share workspace files. Omit the sessionId property to create a child inheriting this session's model and thinking level; never pass a placeholder such as none or __new__. Provide a returned sessionId to continue an idle child of this parent with its existing context and configuration. Up to 4 tasks per parent and 8 per server execute concurrently. This call waits for all tasks and streams progress. Supply an objective, expected result, file ownership, and optional Pi-Ark reference links with their purposes. Results include sessionId, status, up to 4096 bytes or 200 lines per task, session links, and final Message links; use read_pi_ark_link for full results and evidence. Child sessions have independent conversation context.",
    promptSnippet: "Delegate self-contained tasks to persistent subagent Sessions",
    promptGuidelines: [
      "Use subagent for independent tasks with complete instructions and explicit expected results. Parallel editing tasks must have disjoint file ownership; coordinate shared-file changes sequentially.",
      "Use subagent references to share source messages. The subagent does not inherit your conversation. Keep commit, push, deployment, and service changes coordinated by the parent.",
      "To send another task to an existing subagent, pass its returned sessionId with complete task instructions and expectedResult. Each delegation keeps its own result links.",
      "To start a new subagent, leave the sessionId property out of the task object; placeholders such as none or __new__ are rejected.",
      "After subagent completes, use read_pi_ark_link with the returned resultLink and leafEntryId to read full results or verify evidence as needed.",
    ],
    parameters: Type.Object({ tasks: Type.Array(Type.Object({
      sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Continue an existing idle child Session of this parent; leave this property out to create a new child. Placeholders such as none or __new__ are rejected" })),
      title: Type.String({ minLength: 1, maxLength: 120 }),
      task: Type.String({ minLength: 1, maxLength: 16000 }),
      expectedResult: Type.String({ minLength: 1, maxLength: 4000 }),
      references: Type.Optional(Type.Array(Type.Object({ link: Type.String({ maxLength: 1024 }), purpose: Type.String({ minLength: 1, maxLength: 1000 }), leafEntryId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }), { maxItems: 8 })),
    }), { minItems: 1, maxItems: 8 }) }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(toolCallId, input, signal, onUpdate) {
      const run = await dispatch(toolCallId, input.tasks, signal, (current) => onUpdate?.({ content: [{ type: "text", text: JSON.stringify(subagentResult(current)) }], details: current }));
      const result = subagentResult(run);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: run, isError: run.tasks.some((task) => task.state !== "completed") };
    },
  });
}
