import { useEffect, useRef } from "react";
import { File as FileIcon, Sparkles, Terminal, Wrench } from "lucide-react";
import type { SuggestItem, SuggestKind } from "../composer-suggest";

const TITLES: Record<SuggestKind, string> = { skill: "Skills and commands", command: "Commands", mcp: "MCP", file: "Files" };
const HINTS: Record<SuggestKind, string> = { skill: "Type a skill or command name", command: "Type a command name", mcp: "Type a server name, or server/ for its tools", file: "Type part of a path" };

export interface ComposerSuggestProps {
  kind: SuggestKind;
  query: string;
  items: SuggestItem[];
  selected: number;
  loading: boolean;
  truncated: boolean;
  onHover: (index: number) => void;
  onSelect: (item: SuggestItem) => void;
}

function ItemIcon({ kind }: { kind: SuggestKind }) {
  if (kind === "skill") return <Sparkles size={13} />;
  if (kind === "command") return <Terminal size={13} />;
  if (kind === "mcp") return <Wrench size={13} />;
  return <FileIcon size={13} />;
}

export function ComposerSuggest({ kind, query, items, selected, loading, truncated, onHover, onSelect }: ComposerSuggestProps) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[selected] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [selected, items]);
  return (
    <div className="composer-suggest" role="listbox" aria-label={`${TITLES[kind]} suggestions`}>
      <div className="composer-suggest-head"><span>{TITLES[kind]}</span><small>{query ? HINTS[kind] : "Type to filter"}</small></div>
      <ul ref={listRef} className="composer-suggest-list">
        {items.map((item, index) => (
          <li key={item.id}>
            <button type="button" role="option" aria-selected={index === selected} className={index === selected ? "selected" : undefined} onMouseDown={(event) => { event.preventDefault(); onSelect(item); }} onMouseEnter={() => onHover(index)}>
              <ItemIcon kind={item.kind} />
              <span className="suggest-label">{item.label}</span>
              {item.detail ? <span className="suggest-detail">{item.detail}</span> : null}
              {item.status ? <small className="suggest-status">{item.status}</small> : null}
            </button>
          </li>
        ))}
      </ul>
      {loading && items.length === 0 ? <div className="composer-suggest-empty">Searching…</div> : null}
      {!loading && items.length === 0 ? <div className="composer-suggest-empty">No matches</div> : null}
      {truncated ? <div className="composer-suggest-note">Result list is capped; refine the keyword to narrow it.</div> : null}
    </div>
  );
}
