import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  status?: string;
}

export function Select({ value, options, onChange, ariaLabel, disabled = false, placeholder = "Select…" }: { value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel: string; disabled?: boolean; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className={`ark-select ${open ? "open" : ""}`} ref={rootRef}>
    <button type="button" className="ark-select-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label || placeholder}</span>{selected?.status && <small>{selected.status}</small>}<ChevronDown size={14} />
    </button>
    {open && <div className="ark-select-menu" id={listId} role="listbox">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span className="ark-select-check">{option.value === value && <Check size={13} />}</span><span className="ark-select-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.status && <em>{option.status}</em>}
      </button>)}
      {options.length === 0 && <div className="ark-select-empty">No options available</div>}
    </div>}
  </div>;
}
