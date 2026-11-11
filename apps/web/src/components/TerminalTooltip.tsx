import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

type TriggerProps = { "aria-describedby"?: string; "aria-controls"?: string; "aria-expanded"?: boolean; "aria-haspopup"?: "dialog" };

export function TerminalTooltip({ children, content, interactive = false, label, resetKey, enabled = true, className = "" }: {
  children: ReactElement<TriggerProps>;
  content: ReactNode;
  interactive?: boolean;
  label?: string;
  resetKey: string;
  enabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const visible = open && enabled;

  function cancelClose() { clearTimeout(timer.current); }
  function close() { cancelClose(); pinned.current = false; setOpen(false); setPosition(null); }
  function show() {
    cancelClose();
    if (!enabled) return;
    window.dispatchEvent(new CustomEvent("terminal-tooltip-open", { detail: id }));
    setOpen(true);
  }
  function scheduleClose() {
    cancelClose();
    if (!pinned.current) timer.current = setTimeout(() => { setOpen(false); setPosition(null); }, 140);
  }
  function contains(target: EventTarget | null) { return target instanceof Node && (anchor.current?.contains(target) || panel.current?.contains(target)); }

  useEffect(() => { close(); }, [resetKey, enabled]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => { if (!contains(event.target)) close(); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panel.current?.contains(document.activeElement)) anchor.current?.querySelector<HTMLButtonElement>("button")?.focus();
      close();
    };
    const other = (event: Event) => { if ((event as CustomEvent<string>).detail !== id) close(); };
    const followPointer = (event: PointerEvent) => {
      if (interactive || event.pointerType === "touch" || !panel.current) return;
      const rect = panel.current.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) cancelClose();
      else if (!anchor.current?.matches(":hover") && !contains(document.activeElement)) scheduleClose();
    };
    document.addEventListener("pointermove", followPointer);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("terminal-tooltip-open", other);
    return () => { document.removeEventListener("pointermove", followPointer); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); window.removeEventListener("terminal-tooltip-open", other); };
  }, [visible, id, interactive]);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const bounds = panel.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const leftEdge = (viewport?.offsetLeft || 0) + 8;
      const topEdge = (viewport?.offsetTop || 0) + 8;
      const rightEdge = leftEdge + (viewport?.width || window.innerWidth) - 16;
      const bottomEdge = topEdge + (viewport?.height || window.innerHeight) - 16;
      const left = Math.max(leftEdge, Math.min(rect.left, rightEdge - bounds.width));
      const below = rect.bottom + 6;
      const top = Math.max(topEdge, Math.min(below + bounds.height <= bottomEdge ? below : rect.top - bounds.height - 6, bottomEdge - bounds.height));
      setPosition((current) => current?.left === left && current.top === top ? current : { left, top });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place); };
  }, [visible, content]);

  const trigger = cloneElement(children, interactive ? { "aria-controls": visible ? id : undefined, "aria-expanded": visible, "aria-haspopup": "dialog" } : { "aria-describedby": visible ? id : undefined });
  return <span ref={anchor} className={`terminal-tooltip-anchor ${className}`} onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }} onPointerLeave={scheduleClose} onFocus={show} onBlur={(event) => { if (!contains(event.relatedTarget)) { pinned.current = false; scheduleClose(); } }} onClick={(event) => { if (interactive && !panel.current?.contains(event.target as Node)) { if (pinned.current) close(); else { pinned.current = true; show(); } } }} onKeyDown={(event) => {
    if (!interactive || panel.current?.contains(event.target as Node) || (event.key !== "ArrowDown" && (event.key !== "Tab" || event.shiftKey || !visible))) return;
    const action = panel.current?.querySelector<HTMLButtonElement>("button");
    if (event.key === "Tab" && !action) return;
    event.preventDefault();
    pinned.current = true;
    show();
    requestAnimationFrame(() => (panel.current?.querySelector<HTMLButtonElement>("button") || panel.current)?.focus());
  }}>
    {trigger}
    {visible && createPortal(<div ref={panel} id={id} className={`terminal-tooltip ${interactive ? "terminal-popover" : ""}`} role={interactive ? "dialog" : "tooltip"} aria-label={interactive ? label : undefined} tabIndex={interactive ? -1 : undefined} style={{ left: position?.left || 0, top: position?.top || 0, visibility: position ? "visible" : "hidden" }} onPointerEnter={cancelClose} onPointerLeave={scheduleClose} onFocus={cancelClose} onBlur={(event) => { if (!contains(event.relatedTarget)) { pinned.current = false; scheduleClose(); } }}>
      {content}
    </div>, document.body)}
  </span>;
}
