import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  status?: string;
}

export function Select({ value, options, onChange, ariaLabel, ariaDescribedBy, disabled = false, placeholder = "Select…", searchable = false, searchPlaceholder = "Search…" }: { value: string; options: SelectOption[]; onChange: (value: string) => void; ariaLabel: string; ariaDescribedBy?: string; disabled?: boolean; placeholder?: string; searchable?: boolean; searchPlaceholder?: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const needle = query.trim().toLowerCase();
  const matched = needle ? options.filter((option) => [option.label, option.value, option.description || "", option.status || ""].join(" ").toLowerCase().includes(needle)) : options;

  function close() {
    setQuery("");
    setOpen(false);
  }

  function choose(option: SelectOption) {
    onChange(option.value);
    close();
  }

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  return <div className={`ark-select ${open ? "open" : ""}`} ref={rootRef}>
    <button type="button" className="ark-select-trigger" aria-label={ariaLabel} aria-describedby={ariaDescribedBy} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} disabled={disabled} onClick={() => open ? close() : setOpen(true)}>
      <span>{selected?.label || placeholder}</span>{selected?.status && <small>{selected.status}</small>}<ChevronDown size={14} />
    </button>
    {open && <div className="ark-select-menu" id={listId} role="listbox" aria-label={ariaLabel}>
      {searchable && <div className="ark-select-search"><Search size={13} aria-hidden="true" /><input type="text" autoFocus value={query} placeholder={searchPlaceholder} aria-label={`Search ${ariaLabel}`} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key !== "Enter" || event.nativeEvent.isComposing) return; const first = matched[0]; if (first) choose(first); }} /></div>}
      {matched.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? "selected" : ""} key={option.value} onClick={() => choose(option)}>
        <span className="ark-select-check">{option.value === value && <Check size={13} />}</span><span className="ark-select-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.status && <em>{option.status}</em>}
      </button>)}
      {matched.length === 0 && <div className="ark-select-empty" role="presentation">{options.length === 0 ? "No options available" : "No options match this search"}</div>}
    </div>}
  </div>;
}
