import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: node scripts/check-ci-command.mjs <command> [arguments]");
const directory = join(process.cwd(), "dist", "native-ci");
mkdirSync(directory, { recursive: true });
const name = [command, ...args].join("-").replace(/[^a-z0-9.-]+/gi, "-").slice(-160);
const log = openSync(join(directory, `${name}.log`), "w");
const npmCli = process.env.npm_execpath || (process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined);
const executable = command === "node" || command === "npm" && npmCli ? process.execPath : command;
const commandArgs = command === "npm" && npmCli ? [npmCli, ...args] : args;
let tail = "";
const record = (text, stream) => { writeSync(log, text); stream.write(text); tail = (tail + text).slice(-24000); };
const child = spawn(executable, commandArgs, { stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (text) => record(text, process.stdout));
child.stderr.on("data", (text) => record(text, process.stderr));
child.on("error", (error) => record(`${error.stack}\n`, process.stderr));
child.on("close", (code, signal) => {
  closeSync(log);
  if (code === 0) return;
  const message = `${command} ${args.join(" ")}\n${tail}\nExit: ${code}, signal: ${signal}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.log(`::error title=Native CI command failed::${message}`);
  process.exitCode = Number.isInteger(code) && code > 0 ? code : 1;
});
