import { Check, CircleAlert, Keyboard, LoaderCircle, Palette, RotateCcw, Save, TerminalSquare } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api";
import { DEFAULT_TERMINAL_APPEARANCE, readTerminalAppearance, saveTerminalAppearance, subscribeTerminalAppearance } from "../terminal-preferences";
import type { TerminalAppearance } from "../terminal-preferences";
import type { TerminalSettings as ShellSettings, TerminalSettingsResponse, TerminalShell } from "../types";
import { Select } from "./Select";

type ShellDraft = { shell: TerminalShell; executable: string; args: string; env: string };
type Notice = { kind: "success" | "error"; text: string };
export type TerminalSettingsHandle = { refresh: () => Promise<void> };

function toDraft(settings: ShellSettings): ShellDraft {
  return { shell: settings.shell, executable: settings.executable, args: JSON.stringify(settings.args), env: Object.entries(settings.env).map(([key, value]) => `${key}=${value}`).join("\n") };
}

function sameDraft(left: ShellDraft, right: ShellDraft): boolean {
  return left.shell === right.shell && left.executable === right.executable && left.args === right.args && left.env === right.env;
}

function parseDraft(draft: ShellDraft): ShellSettings {
  let args: unknown;
  try { args = JSON.parse(draft.args); }
  catch { throw new Error('Shell arguments must be a JSON array of strings, for example ["-l"].'); }
  if (!Array.isArray(args) || !args.every((value) => typeof value === "string")) throw new Error('Shell arguments must be a JSON array of strings, for example ["-l"].');
  const env: Record<string, string> = Object.create(null);
  for (const [index, line] of draft.env.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    if (separator < 1 || !/^[^=\0]+$/.test(key)) throw new Error(`Environment variable on line ${index + 1} must use KEY=VALUE, for example LANG=en_US.UTF-8.`);
    if (Object.hasOwn(env, key)) throw new Error(`Environment variable ${key} is listed more than once.`);
    env[key] = line.slice(separator + 1);
  }
  if (draft.shell === "custom" && !draft.executable.trim()) throw new Error("Enter the custom shell executable path before saving.");
  return { shell: draft.shell, executable: draft.executable.trim(), args: args as string[], env };
}

export const TerminalSettings = forwardRef<TerminalSettingsHandle, { active: boolean; onBusyChange: (busy: boolean) => void }>(function TerminalSettings({ active, onBusyChange }, ref) {
  const [response, setResponse] = useState<TerminalSettingsResponse | null>(null);
  const [draft, setDraft] = useState<ShellDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [appearance, setAppearance] = useState(readTerminalAppearance);
  const [fontFamily, setFontFamily] = useState(appearance.fontFamily);
  const [fontSize, setFontSize] = useState(String(appearance.fontSize));
  const [appearanceError, setAppearanceError] = useState("");
  const responseRef = useRef(response);
  const draftRef = useRef(draft);
  const editRevision = useRef(0);
  const saveRevision = useRef(0);
  const loadRevision = useRef(0);
  const requested = useRef(false);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saving = pending > 0;
  const dirty = Boolean(response && draft && !sameDraft(draft, toDraft(response.settings)));

  function replaceDraft(next: ShellDraft) { draftRef.current = next; setDraft(next); }
  function receiveResponse(next: TerminalSettingsResponse) { responseRef.current = next; setResponse(next); }

  const refresh = useCallback(async () => {
    const request = ++loadRevision.current;
    const revision = editRevision.current;
    const current = responseRef.current;
    const preserveDraft = current && draftRef.current && !sameDraft(draftRef.current, toDraft(current.settings));
    setLoading(true); setNotice(null);
    try {
      await saveQueue.current;
      const next = await api.terminalSettings();
      if (request !== loadRevision.current) return;
      receiveResponse(next);
      if (!preserveDraft && revision === editRevision.current) replaceDraft(toDraft(next.settings));
      else setNotice({ kind: "success", text: "Server settings refreshed. Your pending edits are preserved." });
    } catch (reason) {
      if (request === loadRevision.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot load Terminal settings" });
    } finally { if (request === loadRevision.current) setLoading(false); }
  }, []);

  useImperativeHandle(ref, () => ({ refresh }), [refresh]);
  useEffect(() => { if (active && !requested.current) { requested.current = true; void refresh(); } }, [active, refresh]);
  useEffect(() => { onBusyChange(loading || saving); }, [loading, saving, onBusyChange]);
  useEffect(() => subscribeTerminalAppearance((next) => { setAppearance(next); setFontFamily(next.fontFamily); setFontSize(String(next.fontSize)); setAppearanceError(""); }), []);

  function editDraft(next: ShellDraft) {
    ++editRevision.current; replaceDraft(next); setNotice(null);
  }

  function persist(settings: ShellSettings, revision: number) {
    const request = ++saveRevision.current;
    ++loadRevision.current;
    setLoading(false); setPending((count) => count + 1); setNotice(null);
    const task = saveQueue.current.catch(() => undefined).then(async () => {
      const next = await api.saveTerminalSettings(settings);
      receiveResponse(next);
      if (request === saveRevision.current) {
        if (revision === editRevision.current) replaceDraft(toDraft(next.settings));
        setNotice({ kind: "success", text: revision === editRevision.current ? "Server shell settings saved. New Terminal tabs will use these settings." : "Server shell settings saved. Your newer edits are ready to save." });
      }
    }).catch((reason) => {
      if (request === saveRevision.current) setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Cannot save Server shell settings" });
    }).finally(() => setPending((count) => count - 1));
    saveQueue.current = task;
  }

  function selectShell(shell: TerminalShell) {
    if (!draft || !response) return;
    const next = { ...draft, shell };
    const savedDraft = toDraft(response.settings);
    const hasFieldEdits = draft.executable !== savedDraft.executable || draft.args !== savedDraft.args || draft.env !== savedDraft.env;
    editDraft(next);
    if (shell !== "custom" && !hasFieldEdits) persist({ ...response.settings, shell }, editRevision.current);
  }

  function saveDraft() {
    if (!draft) return;
    try { persist(parseDraft(draft), editRevision.current); }
    catch (reason) { setNotice({ kind: "error", text: reason instanceof Error ? reason.message : "Check the shell settings" }); }
  }

  function updateAppearance(next: TerminalAppearance) {
    const saved = saveTerminalAppearance(next);
    setAppearance(saved); setAppearanceError("");
  }

  const options = [
    { value: "auto", label: "Auto (Server default)", description: "Windows: PowerShell · macOS: SHELL or zsh · Linux: SHELL or bash" },
    ...(response?.profiles || []).filter((profile) => profile.available && profile.id !== "auto" && profile.id !== "custom").map((profile) => ({ value: profile.id, label: profile.label, description: profile.executable })),
    { value: "custom", label: "Custom executable", description: "Choose a shell installed on the Server" },
  ];

  return <>
    {notice && <div role={notice.kind === "error" ? "alert" : "status"} className={`settings-notice ${notice.kind}`}>{notice.kind === "success" ? <Check size={15} /> : <CircleAlert size={15} />}{notice.text}</div>}
    <section className="settings-section" aria-label="Server shell settings">
      <div className="settings-section-title"><TerminalSquare size={17} /><div><h3>Server shell</h3><p>Shared by all workspaces and browsers. Saved changes apply to new Terminal tabs; existing tabs continue with their current shell.</p></div></div>
      {loading && <div className="settings-inline-loading" role="status"><LoaderCircle size={16} />Loading Terminal settings</div>}
      {!response && !loading && <div className="settings-inline-loading"><button type="button" className="secondary-button" onClick={() => void refresh()}>Load Terminal settings</button></div>}
      {response && draft && <>
        <div className="settings-rows"><div className="settings-row"><div><strong>Server platform</strong><span>{response.platform}</span></div></div></div>
        <label className="settings-field"><span>Shell profile</span><Select ariaLabel="Terminal shell profile" value={draft.shell} placeholder={`Current shell: ${draft.shell} (unavailable)`} options={options} disabled={loading} onChange={(value) => selectShell(value as TerminalShell)} /><small>Available shells are detected on the Server. Selecting a profile saves immediately when additional fields have no pending edits. Custom settings use Save shell settings.</small></label>
        {draft.shell === "custom" && <label className="settings-field settings-api-key"><span>Custom shell executable</span><input aria-label="Custom shell executable" autoComplete="off" spellCheck={false} value={draft.executable} onChange={(event) => editDraft({ ...draft, executable: event.target.value })} placeholder={"/bin/bash or C:\\Program Files\\PowerShell\\7\\pwsh.exe"} /><small>Enter the absolute executable path on the Server. Enter startup arguments in the separate field below.</small></label>}
        <label className="settings-field settings-api-key"><span>Additional shell arguments (JSON array)</span><textarea aria-label="Terminal shell arguments" className="settings-textarea" rows={3} spellCheck={false} value={draft.args} onChange={(event) => editDraft({ ...draft, args: event.target.value })} /><small>{'Use a JSON array of strings, such as ["-l"] or ["-NoLogo"]. Each string is passed as one additional argument after the profile’s startup arguments. [] keeps the profile’s default arguments.'}</small></label>
        <label className="settings-field settings-api-key"><span>Environment variables</span><textarea aria-label="Terminal environment variables" className="settings-textarea" rows={5} autoComplete="off" spellCheck={false} value={draft.env} onChange={(event) => editDraft({ ...draft, env: event.target.value })} placeholder={"LANG=en_US.UTF-8\nMY_VARIABLE=value=with=equals"} /><small>Use one KEY=VALUE per line. Values are literal text, including spaces and additional equals signs. These values extend the Server environment for each new Terminal tab.</small></label>
        <div className="inline-setting-actions"><button type="button" className="secondary-button" disabled={!dirty || saving || loading} onClick={() => { ++editRevision.current; replaceDraft(toDraft(response.settings)); setNotice(null); }}>Cancel</button><button type="button" className="primary-button" disabled={!dirty || saving || loading} onClick={saveDraft}>{saving ? <LoaderCircle size={14} /> : <Save size={14} />}{saving ? "Saving shell settings…" : "Save shell settings"}</button></div>
      </>}
    </section>
    <section className="settings-section" aria-label="Browser Terminal appearance">
      <div className="settings-section-title"><Palette size={17} /><div><h3>Browser appearance</h3><p>Font preferences are saved in this browser and apply immediately to its open Terminal tabs.</p></div></div>
      {appearanceError && <div className="settings-notice error" role="alert"><CircleAlert size={15} />{appearanceError}</div>}
      <div className="settings-grid">
        <label className="settings-field"><span>Font family</span><input aria-label="Terminal font family" value={fontFamily} spellCheck={false} onChange={(event) => { const value = event.target.value; setFontFamily(value); if (value.trim()) updateAppearance({ ...appearance, fontFamily: value }); else setAppearanceError("Enter at least one font family."); }} onBlur={() => { if (!fontFamily.trim()) { setFontFamily(appearance.fontFamily); setAppearanceError(""); } }} /><small>Use installed font names separated by commas, for example Consolas, monospace. Fonts with spaces can be quoted.</small></label>
        <label className="settings-field"><span>Font size</span><input aria-label="Terminal font size" type="number" min={10} max={30} step={1} value={fontSize} onChange={(event) => { const value = event.target.value; setFontSize(value); const size = Number(value); if (value && Number.isFinite(size) && size >= 10 && size <= 30) updateAppearance({ ...appearance, fontSize: size }); else setAppearanceError("Font size must be between 10 and 30 pixels."); }} onBlur={() => { setFontSize(String(appearance.fontSize)); setAppearanceError(""); }} /><small>10–30 pixels. Default: 13 pixels.</small></label>
      </div>
      <div className="inline-setting-actions"><button type="button" className="secondary-button" onClick={() => { updateAppearance({ ...DEFAULT_TERMINAL_APPEARANCE }); setFontFamily(DEFAULT_TERMINAL_APPEARANCE.fontFamily); setFontSize(String(DEFAULT_TERMINAL_APPEARANCE.fontSize)); }}><RotateCcw size={14} />Reset font defaults</button></div>
    </section>
    <section className="settings-section" aria-label="Terminal keyboard shortcuts">
      <div className="settings-section-title"><Keyboard size={17} /><div><h3>Keyboard shortcuts</h3><p>Paste uses the default shortcuts provided by your operating system, browser, and terminal. The Terminal toolbar also provides Copy and Paste buttons. Ctrl+Shift+C / Cmd+C copies selected text. Ctrl+C interrupts the running terminal program.</p></div></div>
    </section>
  </>;
});
