import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadApprovalSettings } from "../config.js";
import { detectDeleteCommand, formatApprovalDenialReason, type ToolApprovalDecision } from "../tool-approvals.js";

export interface DeleteApprovalInput {
  sessionId: string;
  toolCallId: string;
  /** Set when a script-issued call, such as a codemode script, runs the command. */
  parentToolCallId?: string;
  command: string;
  matched: string;
  signal?: AbortSignal;
}

export type DeleteApprovalDispatch = (input: DeleteApprovalInput) => Promise<ToolApprovalDecision>;

/** Blocks bash calls that delete files until the approval is decided in a Session interface. */
export function createDeleteApprovalExtension(request: DeleteApprovalDispatch): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (event.toolName !== "bash") return undefined;
      const command = event.input.command;
      if (typeof command !== "string" || !command.trim()) return undefined;
      const detection = detectDeleteCommand(command);
      if (!detection) return undefined;
      const settings = await loadApprovalSettings().catch(() => ({ deleteCommands: true }));
      if (!settings.deleteCommands) return undefined;
      const decision = await request({ sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId, ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}), command, matched: detection.matched, signal: ctx.signal });
      if (decision.approved) return undefined;
      return { block: true, reason: decision.reason || formatApprovalDenialReason(command, "denied") };
    });
  };
}
