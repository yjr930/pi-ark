import { useEffect, useRef, useState } from "react";
import { Maximize2, TerminalSquare } from "lucide-react";
import { Terminal as XTerminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { websocketUrl } from "../api";
import type { Workspace } from "../types";

export function Terminal({ workspace }: { workspace: Workspace }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [connected, setConnected] = useState(false);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace', fontSize: 13, lineHeight: 1.35, theme: { background: "#0b0b0c", foreground: "#d6d6d7", cursor: "#a7f3d0", selectionBackground: "#3f3f46" }, allowTransparency: true });
    const fit = new FitAddon();
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const socket = new WebSocket(websocketUrl(`/ws/terminal/${encodeURIComponent(workspace.id)}`));
    socket.onopen = () => { setConnected(true); socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); };
    socket.onclose = () => setConnected(false);
    socket.onmessage = (event) => { const payload = JSON.parse(event.data); if (payload.type === "output") terminal.write(payload.data); if (payload.type === "exit") terminal.writeln(`\r\n[process exited: ${payload.exitCode}]`); };
    const input = terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
    const resizeObserver = new ResizeObserver(() => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); });
    resizeObserver.observe(hostRef.current);
    return () => { resizeObserver.disconnect(); input.dispose(); socket.close(); terminal.dispose(); };
  }, [workspace.id]);

  return <section className="terminal-page">
    <header className="page-header terminal-header"><div><h2><TerminalSquare size={18} />Terminal</h2><p>{workspace.path}</p></div><div className="terminal-status"><i className={connected ? "connected" : ""} />{connected ? "Connected" : "Disconnected"}<button title="Fit terminal" onClick={() => fitRef.current?.fit()}><Maximize2 size={15} /></button></div></header>
    <div className="terminal-host" ref={hostRef} />
  </section>;
}
