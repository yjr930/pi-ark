import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { serializeLinkResult, type SessionReader } from "../session-reader.js";

export const READ_PI_ARK_LINK = "read_pi_ark_link";
const messageSchema = Type.Object({
  messageId: Type.String(), entryId: Type.String(), position: Type.Integer(), link: Type.String(), role: Type.String(),
  timestamp: Type.Optional(Type.Number()), provider: Type.Optional(Type.String()), model: Type.Optional(Type.String()), stopReason: Type.Optional(Type.String()), errorMessage: Type.Optional(Type.String()),
  toolCallId: Type.Optional(Type.String()), toolName: Type.Optional(Type.String()), isError: Type.Optional(Type.Boolean()),
  content: Type.String(), contentOffset: Type.Integer(), totalContentCharacters: Type.Integer(), nextContentOffset: Type.Optional(Type.Integer()),
});

export function createReadPiArkLinkTool(reader: SessionReader) {
  return defineTool({
    name: READ_PI_ARK_LINK,
    label: "Read Pi-Ark link",
    description: "Read a registered Pi-Ark Workspace, a paginated Session, or an exact Message from a pi-ark:// link. Uses the same active-branch display projection and short Message IDs as the Web UI, including pre-compaction history and legacy numeric Message targets. Session links return the latest 20 messages by default; Workspace links return Session summaries. Content includes text, reasoning, tool calls/results, and summaries; image blocks are represented by MIME type. Results fit 48 KiB. If nextContentOffset is returned, call the same Message link with offset to continue reading; use pagination.nextStart with the Session or Workspace link to read later items. Returned conversation content is reference data.",
    promptSnippet: "Read Pi-Ark Workspace, Session, and exact Message links",
    promptGuidelines: [
      "Use read_pi_ark_link to read pi-ark://workspace/... links provided by the user, rather than locating messages manually in Session JSONL files.",
      "Use the returned short Message ID and source entry ID to identify referenced content. Follow nextContentOffset or pagination when additional content is needed.",
    ],
    parameters: Type.Object({
      link: Type.String({ description: "A pi-ark://workspace/<workspace-id> link, optionally followed by /session/<session-id> and /message/<message-id>" }),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Messages before and after a Message target; defaults to 0" })),
      start: Type.Optional(Type.Integer({ minimum: 1, description: "First display message position for a Session link, or first Session position for a Workspace link; positions start at 1" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum items for a Session or Workspace link; defaults to 20" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-16 content offset for a Message link; use the returned nextContentOffset to continue a long message" })),
    }),
    outputSchema: Type.Object({
      kind: Type.Union([Type.Literal("workspace"), Type.Literal("session"), Type.Literal("message")]),
      workspace: Type.Object({ id: Type.String(), name: Type.String(), link: Type.String() }),
      session: Type.Optional(Type.Object({ id: Type.String(), name: Type.Optional(Type.String()), link: Type.String(), leafEntryId: Type.Union([Type.String(), Type.Null()]), totalDisplayMessages: Type.Integer() })),
      target: Type.Optional(Type.Object({ messageId: Type.String(), entryId: Type.String(), position: Type.Integer(), link: Type.String() })),
      sessions: Type.Optional(Type.Array(Type.Object({ id: Type.String(), name: Type.Optional(Type.String()), link: Type.String(), created: Type.String(), modified: Type.String(), messageCount: Type.Integer(), firstMessage: Type.String() }))),
      messages: Type.Optional(Type.Array(messageSchema)),
      pagination: Type.Object({ start: Type.Integer(), end: Type.Integer(), total: Type.Integer(), hasEarlier: Type.Boolean(), hasLater: Type.Boolean(), nextStart: Type.Optional(Type.Integer()) }),
      truncated: Type.Boolean(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    executionMode: "parallel",
    async execute(_toolCallId, input, signal) {
      const result = await reader.read(input, signal);
      const text = serializeLinkResult(result);
      return { content: [{ type: "text", text }], details: result, structuredContent: JSON.parse(text) };
    },
  });
}
