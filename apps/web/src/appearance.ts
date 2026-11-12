import { applyTheme, themes, type ThemeId } from "./theme";
import { applyFontScale, DEFAULT_FONT_SCALE, normalizeFontScale } from "./typography";

export interface AppearanceSettings {
  theme: ThemeId;
  hideReasoning: boolean;
  markdownLineBreaks: boolean;
  fontScale: number;
  showWorkingCount: boolean;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = Object.freeze({
  theme: "ark-dark",
  hideReasoning: false,
  markdownLineBreaks: true,
  fontScale: DEFAULT_FONT_SCALE,
  showWorkingCount: true,
});

const storageKey = "pi-ark-appearance";
const legacyThemeKey = "pi-ark-theme";
const changeEvent = "pi-ark-appearance-change";
let fallback: AppearanceSettings = { ...DEFAULT_APPEARANCE };
let useFallback = false;

export function normalizeAppearance(value: unknown): AppearanceSettings {
  const appearance = value && typeof value === "object" ? value as Partial<AppearanceSettings> : {};
  const theme = themes.find((item) => item.id === appearance.theme);
  return {
    theme: (theme?.id || DEFAULT_APPEARANCE.theme) as ThemeId,
    hideReasoning: appearance.hideReasoning === true,
    markdownLineBreaks: appearance.markdownLineBreaks !== false,
    fontScale: normalizeFontScale(appearance.fontScale),
    showWorkingCount: appearance.showWorkingCount !== false,
  };
}

function parseAppearance(value: string | null, legacyTheme: string | null): AppearanceSettings {
  if (!value) return normalizeAppearance({ theme: legacyTheme });
  try { return normalizeAppearance(JSON.parse(value)); }
  catch { return { ...DEFAULT_APPEARANCE }; }
}

export function readAppearance(): AppearanceSettings {
  if (typeof window === "undefined" || useFallback) return { ...fallback };
  try { fallback = parseAppearance(window.localStorage.getItem(storageKey), window.localStorage.getItem(legacyThemeKey)); }
  catch { useFallback = true; }
  return { ...fallback };
}

export function applyAppearance(value: unknown): AppearanceSettings {
  const appearance = normalizeAppearance(value);
  fallback = appearance;
  if (typeof document !== "undefined") {
    applyTheme(appearance.theme);
    applyFontScale(appearance.fontScale);
  }
  return { ...appearance };
}

export function saveAppearance(value: unknown): AppearanceSettings {
  const appearance = applyAppearance(value);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(appearance));
      window.localStorage.removeItem(legacyThemeKey);
      useFallback = false;
    } catch { useFallback = true; }
    window.dispatchEvent(new CustomEvent<AppearanceSettings>(changeEvent, { detail: { ...appearance } }));
  }
  return { ...appearance };
}

export function subscribeAppearance(callback: (appearance: AppearanceSettings) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onChange = (event: Event) => { callback(normalizeAppearance((event as CustomEvent<AppearanceSettings>).detail)); };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    try { if (event.storageArea && event.storageArea !== window.localStorage) return; }
    catch { return; }
    callback(applyAppearance(parseAppearance(event.newValue, null)));
  };
  window.addEventListener(changeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => { window.removeEventListener(changeEvent, onChange); window.removeEventListener("storage", onStorage); };
}

export function applyStoredAppearance(): AppearanceSettings {
  return applyAppearance(readAppearance());
}
