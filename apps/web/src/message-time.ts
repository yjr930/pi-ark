export function formatMessageTime(timestamp: number | undefined): { dateTime: string; label: string } | undefined {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, "0");
  return { dateTime: date.toISOString(), label: `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` };
}
