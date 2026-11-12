import type { SuggestItem } from "./composer-suggest";

export const builtinCommandItems: SuggestItem[] = [{ id: "command:compact", kind: "command", label: "compact", detail: "Compact the session context now", status: "Built-in", insert: "/compact" }];

const compactCommandPattern = /^\/compact(?:\s+([\s\S]*))?$/;

export function compactCommandInstructions(text: string): string | null {
  const match = compactCommandPattern.exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}
