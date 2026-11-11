export type TerminalAppearance = { fontFamily: string; fontSize: number };

export const DEFAULT_TERMINAL_APPEARANCE: TerminalAppearance = Object.freeze({
  fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei", "PingFang SC", monospace',
  fontSize: 13,
});

const storageKey = "pi-ark-terminal-appearance";
const changeEvent = "pi-ark-terminal-appearance-change";
let fallback: TerminalAppearance = { ...DEFAULT_TERMINAL_APPEARANCE };
let useFallback = false;

function normalizeAppearance(value: unknown): TerminalAppearance {
  const appearance = value && typeof value === "object" ? value as Partial<TerminalAppearance> : {};
  return {
    fontFamily: typeof appearance.fontFamily === "string" && appearance.fontFamily.trim() ? appearance.fontFamily : DEFAULT_TERMINAL_APPEARANCE.fontFamily,
    fontSize: typeof appearance.fontSize === "number" && Number.isFinite(appearance.fontSize) && appearance.fontSize >= 10 && appearance.fontSize <= 30 ? appearance.fontSize : DEFAULT_TERMINAL_APPEARANCE.fontSize,
  };
}

function parseAppearance(value: string | null): TerminalAppearance {
  try { return normalizeAppearance(value ? JSON.parse(value) : null); }
  catch { return { ...DEFAULT_TERMINAL_APPEARANCE }; }
}

export function readTerminalAppearance(): TerminalAppearance {
  if (typeof window === "undefined" || useFallback) return { ...fallback };
  try { fallback = parseAppearance(window.localStorage.getItem(storageKey)); }
  catch { useFallback = true; }
  return { ...fallback };
}

export function saveTerminalAppearance(appearance: TerminalAppearance): TerminalAppearance {
  fallback = normalizeAppearance(appearance);
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(storageKey, JSON.stringify(fallback)); useFallback = false; }
    catch { useFallback = true; }
    window.dispatchEvent(new CustomEvent<TerminalAppearance>(changeEvent, { detail: { ...fallback } }));
  }
  return { ...fallback };
}

export function subscribeTerminalAppearance(callback: (appearance: TerminalAppearance) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onChange = (event: Event) => { callback(normalizeAppearance((event as CustomEvent<TerminalAppearance>).detail)); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
    catch { return; }
    fallback = parseAppearance(event.newValue);
    useFallback = false;
    callback({ ...fallback });
  };
  window.addEventListener(changeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(changeEvent, onChange); window.removeEventListener("storage", onStorage); };
}
