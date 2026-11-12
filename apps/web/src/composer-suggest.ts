export type TriggerSymbol = "/" | "$" | "@";

export type SuggestKind = "skill" | "mcp" | "file";

export interface Trigger {
  symbol: TriggerSymbol;
  kind: SuggestKind;
  query: string;
  start: number;
  end: number;
}

export interface SuggestItem {
  id: string;
  kind: SuggestKind;
  label: string;
  detail?: string;
  status?: string;
  insert: string;
}

const MAX_TRIGGER_LENGTH = 120;
const BOUNDARY = new Set([" ", "\n", "\t", "\r"]);

export function suggestKindFor(symbol: TriggerSymbol): SuggestKind {
  if (symbol === "/") return "skill";
  if (symbol === "$") return "mcp";
  return "file";
}

export function detectTrigger(text: string, caret: number): Trigger | null {
  if (caret < 0 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !BOUNDARY.has(text[start - 1])) start -= 1;
  const token = text.slice(start, caret);
  if (token.length < 1 || token.length > MAX_TRIGGER_LENGTH) return null;
  const symbol = token[0];
  if (symbol !== "/" && symbol !== "$" && symbol !== "@") return null;
  return { symbol, kind: suggestKindFor(symbol), query: token.slice(1), start, end: caret };
}

export function scoreText(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();
  if (!query) return 0;
  if (text.startsWith(query)) return 1000 - text.length * 0.01;
  const index = text.indexOf(query);
  if (index >= 0) return 800 - index - text.length * 0.01;
  let cursor = 0;
  let gaps = 0;
  let previous = -1;
  for (let position = 0; position < text.length && cursor < query.length; position += 1) {
    if (text[position] !== query[cursor]) continue;
    if (previous >= 0) gaps += position - previous - 1;
    previous = position;
    cursor += 1;
  }
  if (cursor < query.length) return -1;
  return 500 - gaps * 0.8 - text.length * 0.02;
}

export function filterSuggestItems(items: SuggestItem[], query: string): SuggestItem[] {
  const trimmed = query.trim();
  if (!trimmed) return items;
  const scored: Array<{ item: SuggestItem; score: number }> = [];
  for (const item of items) {
    const labelScore = scoreText(item.label, trimmed);
    const detailScore = item.detail ? scoreText(item.detail, trimmed) - 200 : -1;
    const score = Math.max(labelScore, detailScore);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((left, right) => right.score - left.score || left.item.label.length - right.item.label.length);
  return scored.map((entry) => entry.item);
}

export function applySuggestion(text: string, trigger: Trigger, insert: string): { text: string; caret: number } {
  const before = text.slice(0, trigger.start);
  const after = text.slice(trigger.end);
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const insertion = needsSpace ? `${insert} ` : insert;
  return { text: `${before}${insertion}${after}`, caret: before.length + insertion.length };
}

export function splitMcpQuery(query: string): { server: string; tool: string } | null {
  const index = query.indexOf("/");
  if (index < 0) return null;
  return { server: query.slice(0, index), tool: query.slice(index + 1) };
}
