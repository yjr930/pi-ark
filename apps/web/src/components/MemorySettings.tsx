import { BookOpen, Check, CircleAlert, FileText, Folder, LoaderCircle } from "lucide-react";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import { api } from "../api";
import type { MemorySettings as MemoryFlags, Workspace } from "../types";
import "./MemorySettings.css";

const fields = [
  { key: "enabled", label: "Enable Memory", description: "Give the main Session access to Workspace Memory." },
  { key: "autoIndex", label: "Include short index", description: "Attach a short index of relevant entries to model requests." },
  { key: "proactive", label: "Proactive suggestions", description: "Include the built-in prompt that encourages the agent to suggest useful memories." },
] as const;

type RequestPhase = "loading" | "ready" | "saving" | "saved" | "load-error" | "save-error";
type RequestState<T> = { key: string; phase: RequestPhase; data?: T; error?: string };
export type MemorySettingsHandle = { refresh: () => Promise<void> };

function readDefaults(_id: string, signal: AbortSignal) {
  return api.globalMemorySettings(signal);
}

function useMemorySettingsResource<T>(active: boolean, id: string, read: (id: string, signal: AbortSignal) => Promise<T>, revision = 0) {
  const key = `${revision}:${id}`;
  const [stored, setStored] = useState<RequestState<T>>();
  const reader = useRef<AbortController | null>(null);
  const writer = useRef<Promise<void> | null>(null);
  const state = stored?.key === key ? stored : undefined;
  const cancelRead = useCallback(() => reader.current?.abort(), []);

  const refresh = useCallback(async () => {
    if (!active || !id) return;
    cancelRead();
    const controller = new AbortController();
    reader.current = controller;
    setStored((current) => ({ key, phase: "loading", data: current?.key === key ? current.data : undefined }));
    try {
      // A refresh requested while saving must read after the PATCH completes.
      await writer.current;
      if (controller.signal.aborted) return;
      const data = await read(id, controller.signal);
      if (!controller.signal.aborted) setStored({ key, phase: "ready", data });
    } catch (reason) {
      if (!controller.signal.aborted) setStored({ key, phase: "load-error", error: reason instanceof Error ? reason.message : undefined });
    }
  }, [active, id, key, read, cancelRead]);

  useEffect(() => {
    void refresh();
    return cancelRead;
  }, [refresh, cancelRead]);

  function persist(patch: () => Promise<T>, onSaved?: () => void) {
    if (!state?.data || state.phase === "loading" || writer.current) return;
    // A GET already in flight belongs to the settings before this edit.
    cancelRead();
    setStored({ key, phase: "saving", data: state.data });
    const finish = (next: RequestState<T>) => setStored((current) => current?.key === key && current.phase === "saving" ? next : current);
    writer.current = Promise.resolve().then(patch).then((data) => {
      finish({ key, phase: "saved", data });
      onSaved?.();
    }, (reason) => {
      finish({ key, phase: "save-error", data: state.data, error: reason instanceof Error ? reason.message : undefined });
    }).finally(() => { writer.current = null; });
  }

  return { state, refresh, persist };
}

function RequestFeedback({ state, scope, onRetry }: { state: RequestState<unknown> | undefined; scope: string; onRetry: () => void }) {
  switch (state?.phase ?? "loading") {
    case "loading":
      return <div className="settings-inline-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />{state?.data ? "Refreshing" : "Loading"} {scope}…</div>;
    case "saving":
      return <div className="settings-inline-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />Saving {scope}…</div>;
    case "saved":
      return <div className="settings-notice success" role="status"><Check size={15} aria-hidden="true" />Changes saved.</div>;
    case "load-error":
      return <div className="settings-notice error memory-settings-notice" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>Could not load {scope}.{state?.error && ` ${state.error}`}</span><button type="button" className="secondary-button" onClick={onRetry}>Retry loading {scope}</button></div>;
    case "save-error":
      return <div className="settings-notice error memory-settings-notice" role="alert"><CircleAlert size={15} aria-hidden="true" /><span>Could not save {scope}.{state?.error && ` ${state.error}`}</span></div>;
    default:
      return null;
  }
}

type MemorySettingsProps = {
  active: boolean;
  workspaceId: string;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  onBusyChange: (busy: boolean) => void;
};

export const MemorySettings = forwardRef<MemorySettingsHandle, MemorySettingsProps>(function MemorySettings({ active, workspaceId, workspaces, workspacesLoading, onBusyChange }, ref) {
  const scope = useId();
  const [selection, setSelection] = useState<{ origin: string; id: string }>();
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  useEffect(() => { if (!active) setSelection(undefined); }, [active]);

  const selected = workspaces.find((item) => selection?.origin === workspaceId && item.id === selection.id)
    ?? workspaces.find((item) => item.id === workspaceId)
    ?? workspaces[0];
  const selectedId = selected?.id || "";
  const global = useMemorySettingsResource(active, "global", readDefaults);
  const workspace = useMemorySettingsResource(active, selectedId, api.workspaceMemorySettings, defaultsRevision);
  const { refresh: refreshGlobal } = global;
  const { refresh: refreshWorkspace } = workspace;
  const savedDefaults = global.state?.data;
  const savedWorkspace = workspace.state?.data;
  const saving = global.state?.phase === "saving" || workspace.state?.phase === "saving";
  const loadingGlobal = !global.state || global.state.phase === "loading";
  const loadingWorkspace = !!selected && (!workspace.state || workspace.state.phase === "loading");
  const busy = active && (saving || loadingGlobal || loadingWorkspace);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useImperativeHandle(ref, () => ({
    refresh: async () => { await Promise.all([refreshGlobal(), refreshWorkspace()]); },
  }), [refreshGlobal, refreshWorkspace]);

  const effective = savedWorkspace?.effective;
  const proactiveActive = effective?.enabled && effective.proactive;
  const promptStatus = workspacesLoading ? "Loading Workspaces…"
    : !selected ? "No open Workspace uses this prompt."
    : loadingWorkspace ? `Checking whether ${selected.name} gets this prompt…`
    : !effective ? `Prompt status is unavailable for ${selected.name}.`
    : proactiveActive ? `Included for ${selected.name} on the next turn in the main Session.`
    : `Not included for ${selected.name}: ${effective.enabled ? "proactive suggestions are off" : "Memory is off"}.`;

  return <div className="memory-settings">
    <section className="settings-section" aria-labelledby={`${scope}-defaults`}>
      <div className="settings-section-title"><BookOpen size={17} aria-hidden="true" /><div><h3 id={`${scope}-defaults`}>Global defaults</h3><p>Workspaces inherit these settings unless they have an override.</p></div></div>
      <RequestFeedback state={global.state} scope="global defaults" onRetry={() => void refreshGlobal()} />
      {savedDefaults && <div className="settings-rows">
        {fields.map(({ key, label, description }) => {
          const labelId = `${scope}-default-${key}`;
          const enabled = savedDefaults.defaults[key];
          return <div className="settings-row" key={key}>
            <div><strong id={labelId}>{label}</strong><span id={`${labelId}-hint`}>{description}</span></div>
            <button type="button" className="memory-settings-switch" role="switch" aria-checked={enabled} aria-labelledby={labelId} aria-describedby={`${labelId}-hint`} disabled={saving || loadingGlobal} onClick={() => global.persist(() => api.saveGlobalMemorySettings({ [key]: !enabled }), () => setDefaultsRevision((current) => current + 1))}>
              <span className={`settings-toggle ${enabled ? "enabled" : ""}`} aria-hidden="true"><span /></span>
            </button>
          </div>;
        })}
      </div>}
    </section>

    <section className="settings-section" aria-labelledby={`${scope}-overrides`}>
      <div className="settings-section-title"><Folder size={17} aria-hidden="true" /><div>
        <h3 id={`${scope}-overrides`}>Workspace overrides</h3>
        <p>You can configure the short index and proactive suggestions at any time. They take effect when Memory is on for the Workspace.</p>
      </div></div>
      {workspacesLoading ? <div className="settings-inline-loading" role="status"><LoaderCircle size={16} aria-hidden="true" />Loading Workspaces…</div> : !selected ? <p className="memory-settings-caption">Open a Workspace to configure overrides.</p> : <>
        <label className="settings-field memory-settings-workspace">
          <span>Workspace</span>
          <select className="memory-settings-select" value={selectedId} disabled={saving} onChange={(event) => setSelection({ origin: workspaceId, id: event.target.value })}>
            {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <RequestFeedback state={workspace.state} scope="Workspace overrides" onRetry={() => void refreshWorkspace()} />
        {savedWorkspace && <div className="settings-rows">
          {fields.map(({ key, label }) => {
            const id = `${scope}-override-${key}`;
            const value = savedWorkspace.overrides[key];
            const inactive = key !== "enabled" && !savedWorkspace.effective.enabled;
            const actual = !inactive && savedWorkspace.effective[key];
            return <div className="settings-row memory-settings-override" key={key}>
              <div><label htmlFor={id}>{label}</label><span id={`${id}-status`}>Global default: {savedWorkspace.defaults[key] ? "On" : "Off"} · Effective: {actual ? "On" : "Off"}{inactive && " (Memory is off)"}</span></div>
              <select id={id} className="memory-settings-select" aria-describedby={`${id}-status`} value={value === undefined ? "inherit" : value ? "on" : "off"} disabled={saving || loadingWorkspace} onChange={(event) => {
                const next = event.target.value;
                workspace.persist(() => api.saveWorkspaceMemorySettings(selectedId, { [key]: next === "inherit" ? null : next === "on" }));
              }}>
                <option value="inherit">Use global default</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>;
          })}
        </div>}
      </>}
    </section>

    <section className="settings-section memory-settings-prompt" aria-label="Proactive suggestion prompt preview">
      <details className="settings-prompt-preview">
        <summary aria-label="Proactive suggestion prompt"><FileText size={15} aria-hidden="true" />Proactive suggestion prompt</summary>
        {savedDefaults?.prompt ? <pre>{savedDefaults.prompt}</pre> : <p className="memory-settings-caption">{loadingGlobal ? "Loading prompt…" : "Prompt preview is unavailable."}</p>}
      </details>
      <p className="memory-settings-caption" role="status">{promptStatus}</p>
      <p className="memory-settings-caption">You still need to confirm each suggestion before it is saved to Memory.</p>
    </section>
  </div>;
});
