import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";

export const TERMINAL_SHELLS = ["auto", "bash", "zsh", "fish", "pwsh", "powershell", "git-bash", "wsl", "custom"] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];
export interface TerminalSettings { shell: TerminalShell; executable: string; args: string[]; env: Record<string, string> }
export interface TerminalProfile { id: TerminalShell; label: string; executable: string; args: string[]; available: boolean }
export const defaultTerminalSettings = (): TerminalSettings => ({ shell: "auto", executable: "", args: [], env: {} });
const invalid = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

export function validateTerminalSettings(input: unknown): TerminalSettings {
  if (!input || typeof input !== "object") throw invalid("Terminal settings are required");
  const value = input as TerminalSettings;
  if (!TERMINAL_SHELLS.includes(value.shell)) throw invalid("Unknown terminal shell");
  if (typeof value.executable !== "string" || value.executable.includes("\0")) throw invalid("Invalid terminal executable");
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw invalid("Terminal arguments must be an array of strings");
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env) || !Object.entries(value.env).every(([key, entry]) => /^[^=\0]+$/.test(key) && typeof entry === "string" && !entry.includes("\0"))) throw invalid("Terminal environment must contain string values");
  if (value.shell === "custom" && !value.executable.trim()) throw invalid("A custom terminal executable is required");
  return { shell: value.shell, executable: value.executable, args: [...value.args], env: { ...value.env } };
}

export function normalizeTerminalSettings(input: unknown): TerminalSettings {
  if (!input || typeof input !== "object") return defaultTerminalSettings();
  try { return validateTerminalSettings({ ...defaultTerminalSettings(), ...input }); }
  catch { return defaultTerminalSettings(); }
}

export interface ShellDiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  executable?: (candidate: string) => boolean;
  locales?: string[];
}

export function discoverTerminalProfiles(options: ShellDiscoveryOptions = {}): TerminalProfile[] {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const windows = platform === "win32";
  const path = windows ? win32 : { join, isAbsolute };
  const executable = options.executable ?? ((candidate: string) => {
    try { accessSync(candidate, windows ? constants.F_OK : constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
  });
  const find = (candidates: string[]): string => {
    for (const candidate of candidates.filter(Boolean)) {
      const paths = path.isAbsolute(candidate) || /[\\/]/.test(candidate) ? [candidate] : (env.PATH ?? env.Path ?? "").split(windows ? ";" : delimiter).filter(Boolean).map((directory) => path.join(directory, candidate));
      for (const target of paths) if (executable(target)) return target;
    }
    return "";
  };
  const profile = (id: TerminalShell, label: string, candidates: string[], args: string[] = []): TerminalProfile => {
    const resolved = find(candidates);
    return { id, label, executable: resolved, args, available: Boolean(resolved) };
  };
  const profiles = [
    profile("bash", "Bash", windows ? ["bash.exe"] : ["bash", "/bin/bash"]),
    profile("zsh", "Zsh", windows ? ["zsh.exe"] : ["zsh", "/bin/zsh"]),
    profile("fish", "Fish", windows ? ["fish.exe"] : ["fish", "/usr/bin/fish"]),
    profile("pwsh", "PowerShell", windows ? ["pwsh.exe", win32.join(env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe")] : ["pwsh"], ["-NoLogo"]),
    profile("powershell", "Windows PowerShell", windows ? ["powershell.exe", win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : ["powershell"], ["-NoLogo"]),
    profile("git-bash", "Git Bash", windows ? [win32.join(env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"), win32.join(env.LOCALAPPDATA || "", "Programs", "Git", "bin", "bash.exe")] : []),
    profile("wsl", "WSL", windows ? ["wsl.exe", win32.join(env.SystemRoot || "C:\\Windows", "System32", "wsl.exe")] : []),
  ];
  let auto: TerminalProfile | undefined;
  if (windows) auto = profiles.find((entry) => entry.id === "pwsh" && entry.available) ?? profiles.find((entry) => entry.id === "powershell" && entry.available);
  else {
    const inherited = env.SHELL && path.isAbsolute(env.SHELL) ? find([env.SHELL]) : "";
    const fallback = find([platform === "darwin" ? "/bin/zsh" : "/bin/bash"]);
    const selected = inherited || fallback;
    if (selected) auto = { id: "auto", label: "Auto", executable: selected, args: /(?:pwsh|powershell)(?:\.exe)?$/i.test(selected) ? ["-NoLogo"] : [], available: true };
  }
  return [{ id: "auto", label: "Auto", executable: auto?.executable || "", args: auto?.args || [], available: Boolean(auto) }, ...profiles, { id: "custom", label: "Custom executable", executable: "", args: [], available: true }];
}

export function terminalEnvironment(settings: TerminalSettings, platform: NodeJS.Platform = process.platform, inherited: NodeJS.ProcessEnv = process.env, availableLocales?: string[]): Record<string, string> {
  const env = Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (platform !== "win32") {
    let locales = availableLocales;
    if (!locales && platform === process.platform) {
      try { locales = execFileSync("locale", ["-a"], { encoding: "utf8", env: { ...env, LC_ALL: "C" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/).filter(Boolean); }
      catch { /* Minimal environments can use their inherited UTF-8 locale. */ }
    }
    const key = (locale: string) => locale.toLowerCase().replace(/-/g, "");
    const effective = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
    const inheritedUtf8 = /utf-?8/i.test(effective) && (!locales?.length || locales.some((locale) => key(locale) === key(effective)));
    if (!inheritedUtf8) {
      const preferred = platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
      const locale = locales?.find((entry) => key(entry) === key(preferred)) ?? locales?.find((entry) => /utf-?8/i.test(entry)) ?? preferred;
      env.LANG = locale;
      env.LC_CTYPE = locale;
      if (env.LC_ALL) env.LC_ALL = locale;
    }
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", ...settings.env };
}

export function resolveTerminalShell(input: TerminalSettings, options: ShellDiscoveryOptions = {}): { executable: string; args: string[]; env: Record<string, string> } {
  const settings = validateTerminalSettings(input);
  const platform = options.platform ?? process.platform;
  const env = terminalEnvironment(settings, platform, options.env ?? process.env, options.locales);
  const profiles = discoverTerminalProfiles({ ...options, env });
  let selected = profiles.find((profile) => profile.id === settings.shell)!;
  if (settings.shell === "custom") {
    const windows = platform === "win32";
    const path = windows ? win32 : { isAbsolute };
    if (!path.isAbsolute(settings.executable)) throw invalid("Custom terminal executable must be an absolute path");
    const canExecute = options.executable ?? ((candidate: string) => { try { accessSync(candidate, windows ? constants.F_OK : constants.X_OK); return statSync(candidate).isFile(); } catch { return false; } });
    if (!canExecute(settings.executable) || (windows && !/\.(exe|com)$/i.test(settings.executable))) throw invalid("Custom terminal executable is not executable");
    selected = { id: "custom", label: "Custom executable", executable: settings.executable, args: [], available: true };
  }
  if (!selected.available) throw invalid(`Terminal shell is unavailable: ${settings.shell}`);
  const args = [...selected.args, ...settings.args];
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(selected.executable)) args.push("-NoExit", "-Command", "$utf8 = New-Object System.Text.UTF8Encoding $false; [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8");
  return { executable: selected.executable, args, env };
}
