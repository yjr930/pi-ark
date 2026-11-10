import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const exec = promisify(execFile);
const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith("--") ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const username = args.username || process.env.PI_ARK_USERNAME;
const password = args.password || process.env.PI_ARK_PASSWORD;
const workspacePath = resolve(args.workspace || process.cwd());
const home = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));

if (!username || !password) {
  console.error("Usage: npm run setup -- --username <name> --password <password> --workspace </absolute/path>");
  process.exit(1);
}
if (!isAbsolute(workspacePath)) throw new Error("Workspace path must be absolute");

await mkdir(join(home, "tls"), { recursive: true, mode: 0o700 });
const keyPath = join(home, "tls", "server.key");
const certPath = join(home, "tls", "server.crt");
await exec("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "825", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"]);
const salt = randomBytes(16).toString("hex");
const digest = await scrypt(password, salt, 64);
const id = (args.id || workspacePath.split(/[\\/]/).filter(Boolean).at(-1) || "workspace").replace(/[^a-zA-Z0-9_-]/g, "-");
const config = {
  listen: { host: args.host || "127.0.0.1", port: Number(args.port || 31415) },
  tls: { keyPath, certPath },
  auth: { username, passwordHash: `scrypt$${salt}$${Buffer.from(digest).toString("hex")}` },
  workspaces: [{ id, name: args.name || id, path: workspacePath }],
  ui: { theme: "ark-dark", hideReasoning: false },
};
await writeFile(join(home, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(`Pi-Ark configuration written to ${join(home, "config.json")}`);
console.log(`Open https://${config.listen.host}:${config.listen.port} after running npm run build && npm start`);
