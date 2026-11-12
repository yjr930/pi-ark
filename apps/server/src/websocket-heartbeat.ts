import type { WebSocket } from "ws";

export const heartbeatIntervalMs = 15_000;

/**
 * Keeps a WebSocket connection observable for both sides. The protocol ping makes the client answer with a pong, and the optional `ping` message lets the browser detect a connection that stopped delivering data.
 */
export function startHeartbeat(socket: WebSocket, options: { notice?: boolean; intervalMs?: number } = {}): () => void {
  const intervalMs = options.intervalMs ?? heartbeatIntervalMs;
  let answered = true;
  const timer = setInterval(() => {
    if (!answered) {
      socket.terminate();
      return;
    }
    answered = false;
    try {
      socket.ping();
      if (options.notice) socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      socket.terminate();
    }
  }, intervalMs);
  const onPong = () => { answered = true; };
  const stop = () => { clearInterval(timer); socket.off("pong", onPong); };
  socket.on("pong", onPong);
  socket.once("close", stop);
  return stop;
}
