import { LoaderCircle } from "lucide-react";
import { FormEvent, useEffect, useState, type ReactNode } from "react";

export function NameDialog({ title, description, label, initialValue = "", submitLabel, icon, onClose, onSubmit }: { title: string; description: string; label: string; initialValue?: string; submitLabel: string; icon: ReactNode; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    setSaving(true); setError("");
    try { await onSubmit(value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : `Cannot ${submitLabel.toLowerCase()}`); setSaving(false); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="dialog-card compact-dialog" role="dialog" aria-modal="true" aria-labelledby="name-dialog-title" onSubmit={submit}>
    <div className="dialog-header no-close"><div className="dialog-icon">{icon}</div><div><h2 id="name-dialog-title">{title}</h2><p>{description}</p></div></div>
    <label className="dialog-field"><span>{label}</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    {error && <div className="dialog-error">{error}</div>}
    <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saving || !name.trim()}>{saving && <LoaderCircle size={15} />}{submitLabel}</button></div>
  </form></div>;
}
