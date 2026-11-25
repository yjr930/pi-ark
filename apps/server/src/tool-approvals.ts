/** Delete detection for bash commands and the approval state shared with the web interface. */

export interface DeleteDetection {
  /** The delete command found in the script, for example `rm` or `find -delete`. */
  matched: string;
}

export interface ToolApprovalRequest {
  approvalId: string;
  toolCallId: string;
  /** Tool call in the Session that displays the card. Subagent calls anchor to the parent `subagent` call. */
  anchorToolCallId: string;
  toolName: string;
  command: string;
  matched: string;
  /** Session that issued the command. */
  sessionId: string;
  sessionLink?: string;
  sessionTitle?: string;
  requestedAt: number;
}

export type ToolApprovalDecision = { approved: true } | { approved: false; reason: string };
export type ToolApprovalCloseReason = "denied" | "aborted" | "deleted" | "rollback" | "unavailable";

const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "shred"]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
// Commands that run another command. Their leading words and options are skipped before the real command is read.
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "setsid", "xargs", "timeout", "watch", "busybox"]);
const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-p", "-C", "-D", "-R", "-T", "-U"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S"]),
  nice: new Set(["-n"]),
  ionice: new Set(["-c", "-n", "-p"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k"]),
  watch: new Set(["-n", "-d", "-q"]),
  xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a"]),
};
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "in", "case", "esac", "select", "function", "!", "{", "}"]);
const MAX_DEPTH = 3;

/** Split a shell script into simple commands, keeping quoted text inside its own command. */
function splitCommands(script: string): string[] {
  const commands: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  const flush = () => { if (current.trim()) commands.push(current); current = ""; };
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index];
    if (quote) {
      current += char;
      if (char === "\\" && quote === '"' && index + 1 < script.length) { current += script[index + 1]; index += 1; continue; }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "\\" && index + 1 < script.length) { current += char + script[index + 1]; index += 1; continue; }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (char === "$" && script[index + 1] === "(") { flush(); index += 1; continue; }
    if (char === "(" || char === ")" || char === "`" || char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r") { flush(); continue; }
    current += char;
  }
  flush();
  return commands;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  const flush = () => { if (started) { tokens.push(current); current = ""; started = false; } };
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < segment.length) { current += segment[index + 1]; index += 1; continue; }
      if (char === quote) { quote = undefined; continue; }
      current += char;
      continue;
    }
    if (char === "\\" && index + 1 < segment.length) { current += segment[index + 1]; started = true; index += 1; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === " " || char === "\t") { flush(); continue; }
    current += char;
    started = true;
  }
  flush();
  return tokens;
}

function commandName(token: string): string {
  const trimmed = token.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

function isAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Index of the command word after leading assignments and wrapper commands, or -1 when the command is empty. */
function commandIndex(tokens: string[]): number {
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (isAssignment(token) || SHELL_KEYWORDS.has(token)) { index += 1; continue; }
    const name = commandName(token);
    if (!WRAPPERS.has(name)) return index;
    const values = WRAPPER_VALUE_FLAGS[name];
    index += 1;
    while (index < tokens.length && tokens[index].startsWith("-")) {
      const flag = tokens[index];
      index += 1;
      if (values?.has(flag)) index += 1;
    }
    // `timeout 30 rm ...` puts the duration before the command.
    if (name === "timeout" && /^[0-9]+(?:\.[0-9]+)?[smhd]?$/.test(tokens[index] || "")) index += 1;
  }
  return -1;
}

function findDetection(tokens: string[]): DeleteDetection | undefined {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-delete") return { matched: "find -delete" };
    if (token === "-exec" || token === "-execdir" || token === "-ok" || token === "-okdir") {
      const command = tokens[index + 1];
      if (command && DELETE_COMMANDS.has(commandName(command))) return { matched: `find ${token} ${commandName(command)}` };
    }
  }
  return undefined;
}

function gitDetection(tokens: string[]): DeleteDetection | undefined {
  let index = 0;
  while (index < tokens.length && tokens[index].startsWith("-")) {
    const flag = tokens[index];
    index += 1;
    // Git global options that take a separate value.
    if (flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree" || flag === "--namespace") index += 1;
  }
  const subcommand = tokens[index]?.toLowerCase();
  const rest = tokens.slice(index + 1);
  if (subcommand === "clean") {
    const dryRun = rest.some((token) => token === "--dry-run" || (token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("n")));
    if (dryRun) return undefined;
    const force = rest.some((token) => token === "--force" || (token.startsWith("-") && !token.startsWith("--") && token.slice(1).includes("f")));
    return force ? { matched: "git clean" } : undefined;
  }
  if (subcommand === "rm" && !rest.includes("--cached")) return { matched: "git rm" };
  return undefined;
}

function shellDetection(tokens: string[], depth: number): DeleteDetection | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-") || token.startsWith("--")) continue;
    if (!token.slice(1).includes("c")) continue;
    const script = tokens[index + 1];
    return script ? detectDeleteCommand(script, depth + 1) : undefined;
  }
  return undefined;
}

function detectInTokens(tokens: string[], depth: number): DeleteDetection | undefined {
  const index = commandIndex(tokens);
  if (index < 0) return undefined;
  const name = commandName(tokens[index]);
  if (DELETE_COMMANDS.has(name)) return { matched: name };
  if (name === "find") return findDetection(tokens.slice(index + 1));
  if (name === "git") return gitDetection(tokens.slice(index + 1));
  if (SHELL_COMMANDS.has(name)) return shellDetection(tokens.slice(index), depth);
  if (name === "eval" && depth < MAX_DEPTH) {
    const script = tokens.slice(index + 1).join(" ");
    return script ? detectDeleteCommand(script, depth + 1) : undefined;
  }
  return undefined;
}

/**
 * Detects a file-deleting command in a bash script. Quoted arguments and the arguments of other commands
 * stay out of the check because only command words are read.
 */
export function detectDeleteCommand(script: string, depth = 0): DeleteDetection | undefined {
  if (depth > MAX_DEPTH) return undefined;
  for (const segment of splitCommands(script)) {
    const detection = detectInTokens(tokenize(segment), depth);
    if (detection) return detection;
  }
  return undefined;
}

export function approvalCloseReasonText(reason: ToolApprovalCloseReason): string {
  if (reason === "aborted") return "会话被中止，该命令没有执行";
  if (reason === "deleted") return "会话被删除，该命令没有执行";
  if (reason === "rollback") return "会话回滚取消了该命令";
  if (reason === "unavailable") return "无法取得审批界面，该命令没有执行";
  return "用户拒绝了该删除命令";
}

/** Text the model receives when a delete command is blocked. */
export function formatApprovalDenialReason(command: string, reason: ToolApprovalCloseReason): string {
  return `[删除审批] ${approvalCloseReasonText(reason)}。命令：${command}`;
}
