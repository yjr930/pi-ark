import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: node scripts/check-ci-command.mjs <command> [arguments]");
const timeout = Number(process.env.PI_ARK_CI_COMMAND_TIMEOUT_MS || 600000);
if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("PI_ARK_CI_COMMAND_TIMEOUT_MS must be a positive integer");
const directory = join(process.cwd(), "dist", "native-ci");
mkdirSync(directory, { recursive: true });
const name = [command, ...args].join("-").replace(/[^a-z0-9.-]+/gi, "-").slice(-160);
const log = openSync(join(directory, `${name}.log`), "w");
const npmCli = process.env.npm_execpath || (process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
const executable = command === "node" || command === "npm" && npmCli ? process.execPath : command;
const commandArgs = command === "npm" && npmCli ? [npmCli, ...args] : args;
let tail = "";
let closed = false;
let timedOut = false;
let annotated = false;
let escalation;
let fallback;
const record = (text, stream) => { if (!closed) writeSync(log, text); stream.write(text); tail = (tail + text).slice(-2800); };
function annotate(code, signal) {
  if (annotated) return;
  annotated = true;
  const message = `${`${command} ${args.join(" ")}`.slice(0, 500)}\n${tail}\nExit: ${code}, signal: ${signal}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::error title=Native CI command failed::${message}`);
}
const child = spawn(executable, commandArgs, { stdio: ["inherit", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
function terminate(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const taskkill = spawn(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", (error) => record(`Process cleanup failed: ${error.message}\n`, process.stderr));
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") record(`Process cleanup failed: ${error.message}\n`, process.stderr); }
  }
}
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (text) => record(text, process.stdout));
child.stderr.on("data", (text) => record(text, process.stderr));
child.on("error", (error) => record(`${error.stack}\n`, process.stderr));
const timer = setTimeout(() => {
  timedOut = true;
  record(`Command timed out after ${timeout} ms; stopping its process tree.\n`, process.stderr);
  annotate(1, "timeout");
  terminate("SIGTERM");
  escalation = setTimeout(() => terminate("SIGKILL"), 3000);
  fallback = setTimeout(() => process.exit(1), 5000);
}, timeout);
child.on("close", (code, signal) => {
  clearTimeout(timer);
  clearTimeout(escalation);
  clearTimeout(fallback);
  closed = true;
  closeSync(log);
  if (code === 0 && !timedOut) return;
  annotate(code, signal);
  process.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
});
