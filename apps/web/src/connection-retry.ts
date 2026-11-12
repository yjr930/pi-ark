export const reconnectBaseDelayMs = 500;
export const reconnectMaxDelayMs = 10_000;
export const connectionStaleAfterMs = 45_000;
export const connectionWatchdogIntervalMs = 5_000;

export function reconnectDelay(attempt: number): number {
  return Math.min(reconnectMaxDelayMs, reconnectBaseDelayMs * 2 ** Math.max(0, attempt));
}

export function isConnectionStale(lastMessageAt: number, now: number): boolean {
  return now - lastMessageAt > connectionStaleAfterMs;
}
