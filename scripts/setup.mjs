import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import selfsigned from "selfsigned";

const scrypt = promisify(scryptCallback);
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
const notBeforeDate = new Date();
const certificate = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
  keyType: "rsa",
  keySize: 3072,
  algorithm: "sha256",
  notBeforeDate,
  notAfterDate: new Date(notBeforeDate.getTime() + 825 * 24 * 60 * 60 * 1000),
  extensions: [
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
  ],
});
await writeFile(keyPath, certificate.private, { mode: 0o600 });
await writeFile(certPath, certificate.cert, { mode: 0o600 });
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
console.log(`Start Pi-Ark, then open https://${config.listen.host}:${config.listen.port}`);
