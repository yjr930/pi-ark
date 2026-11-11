import os from "node:os";
import type { IPty } from "node-pty";
import pty from "node-pty";
import type { WebSocket } from "ws";

interface TerminalInput {
  type: "input" | "resize";
  data?: string;
  cols?: number;
  rows?: number;
}

export function openTerminal(socket: WebSocket, cwd: string): () => void {
  const shell = os.platform() === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash";
  const processPty: IPty = pty.spawn(shell, [], {
    name: "xterm-256color",
    cwd,
    cols: 100,
    rows: 30,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
  });

  const dataSubscription = processPty.onData((data) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "output", data }));
  });
  processPty.onExit(({ exitCode }) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "exit", exitCode }));
    socket.close();
  });

  const onMessage = (raw: Buffer) => {
    try {
      const message = JSON.parse(raw.toString()) as TerminalInput;
      if (message.type === "input" && typeof message.data === "string") processPty.write(message.data);
      if (message.type === "resize" && message.cols && message.rows) processPty.resize(Math.max(2, message.cols), Math.max(1, message.rows));
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "Invalid terminal message" }));
    }
  };
  socket.on("message", onMessage);

  return () => {
    socket.off("message", onMessage);
    dataSubscription.dispose();
    try { processPty.kill(); } catch { /* PTY already exited. */ }
  };
}
