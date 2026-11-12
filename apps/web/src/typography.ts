export type FontLevelId = "micro" | "caption" | "dense" | "ui" | "reading" | "section" | "page";

export interface FontLevel {
  id: FontLevelId;
  label: string;
  role: string;
  baseSize: number;
}

export const FONT_LEVELS: readonly FontLevel[] = Object.freeze([
  { id: "micro", label: "Micro", role: "Badges, counts, and status text", baseSize: 8 },
  { id: "caption", label: "Caption", role: "Hints, secondary labels, and inline code", baseSize: 9 },
  { id: "dense", label: "Dense", role: "Dense rows, field hints, and tool summaries", baseSize: 10 },
  { id: "ui", label: "Interface", role: "Buttons, list titles, and form values", baseSize: 11 },
  { id: "reading", label: "Reading", role: "Conversations, Markdown files, and dialog titles", baseSize: 14 },
  { id: "section", label: "Section title", role: "Page sections and empty states", baseSize: 20 },
  { id: "page", label: "Page title", role: "Sign-in and welcome headings", baseSize: 24 },
]);

export const MIN_FONT_SCALE = 0.9;
export const MAX_FONT_SCALE = 1.3;
export const FONT_SCALE_STEP = 0.05;
export const DEFAULT_FONT_SCALE = 1;

export function normalizeFontScale(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_FONT_SCALE;
  const stepped = Math.round(numeric / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  const bounded = Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, stepped));
  return Number(bounded.toFixed(2));
}

export function levelPixels(level: FontLevel, scale: number): number {
  return Math.round(level.baseSize * normalizeFontScale(scale) * 100) / 100;
}

export function applyFontScale(value: unknown): number {
  const scale = normalizeFontScale(value);
  if (typeof document !== "undefined") document.documentElement.style.setProperty("--fs-scale", String(scale));
  return scale;
}
