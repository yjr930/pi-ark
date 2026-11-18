import type { SuggestItem } from "./composer-suggest";

export const builtinCommandItems: SuggestItem[] = [
  { id: "command:compact", kind: "command", label: "compact", detail: "Compact the session context now", status: "Built-in", insert: "/compact" },
  { id: "command:reload", kind: "command", label: "reload", detail: "Reload extensions, MCP, skills, and project context", status: "Built-in", insert: "/reload" },
];

export function withBuiltinCommands(items: SuggestItem[]): SuggestItem[] {
  return [...builtinCommandItems, ...items.filter((item) => !builtinCommandItems.some((builtin) => builtin.insert === item.insert))];
}

const compactCommandPattern = /^\/compact(?:\s+([\s\S]*))?$/;
const reloadCommandPattern = /^\/reload(?:\s+([\s\S]*))?$/;

export function compactCommandInstructions(text: string): string | null {
  const match = compactCommandPattern.exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}

export function reloadCommandArguments(text: string): string | null {
  const match = reloadCommandPattern.exec(text.trim());
  return match ? (match[1] || "").trim() : null;
}
