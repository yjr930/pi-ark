export interface MemorySettings {
  enabled: boolean;
  autoIndex: boolean;
  proactive: boolean;
}

export interface WorkspaceMemorySettings {
  defaults: MemorySettings;
  overrides: Partial<MemorySettings>;
  effective: MemorySettings;
}

export type MemorySettingsPatch = { [K in keyof MemorySettings]?: boolean | null };
export const MEMORY_SETTING_KEYS = ["enabled", "autoIndex", "proactive"] as const;

export function normalizeMemoryDefaults(input?: unknown): MemorySettings {
  const defaults = { enabled: false, autoIndex: false, proactive: false };
  if (input && typeof input === "object") {
    for (const key of MEMORY_SETTING_KEYS) {
      if (!Object.hasOwn(input, key)) continue;
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "boolean") defaults[key] = value;
    }
  }
  return defaults;
}

function settingsError(message: string) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

export function validateMemorySettingsPatch(input: unknown, allowNull: true): MemorySettingsPatch;
export function validateMemorySettingsPatch(input: unknown, allowNull?: false): Partial<MemorySettings>;
export function validateMemorySettingsPatch(input: unknown, allowNull = false): MemorySettingsPatch {
  if (!input || typeof input !== "object" || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw settingsError("Expected a Memory settings object");
  }
  const patch: MemorySettingsPatch = {};
  for (const name of Reflect.ownKeys(input)) {
    const key = MEMORY_SETTING_KEYS.find((field) => field === name);
    if (!key) throw settingsError("Unknown Memory settings field");
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== "boolean" && !(allowNull && value === null)) {
      throw settingsError(`Memory ${key} must be a boolean${allowNull ? " or null" : ""}`);
    }
    patch[key] = value;
  }
  return patch;
}

export function validateLegacyMemorySettings(input: unknown): Pick<MemorySettings, "enabled" | "autoIndex"> {
  const { enabled, autoIndex, proactive } = validateMemorySettingsPatch(input);
  if (enabled === undefined || autoIndex === undefined || proactive !== undefined) {
    throw settingsError("Memory settings require enabled and autoIndex flags");
  }
  return { enabled, autoIndex };
}

export function effectiveMemorySettings(defaults: MemorySettings, overrides: Partial<MemorySettings>): MemorySettings {
  const { enabled, autoIndex, proactive } = { ...defaults, ...overrides };
  return { enabled, autoIndex: enabled && autoIndex, proactive: enabled && proactive };
}
