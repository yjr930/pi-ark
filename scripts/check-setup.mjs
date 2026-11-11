import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createPrivateKey, scrypt as scryptCallback, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, get } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scrypt = promisify(scryptCallback);
const setupScript = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("./setup.mjs", import.meta.url));
const directory = await realpath(await mkdtemp(join(tmpdir(), "pi-ark setup 中文 ")));
const workspacePath = join(directory, "工作目录 with spaces");
const home = join(directory, "Global 数据 with spaces");
const userHome = join(directory, "用户 home");
const password = "setup password 中文 !";
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["path", "pi_ark_home", "pi_ark_username", "pi_ark_password"].includes(key.toLowerCase())));
Object.assign(env, { PATH: "", HOME: userHome, USERPROFILE: userHome });

async function verifySetup(dataHome, expected) {
  const config = JSON.parse(await readFile(join(dataHome, "config.json"), "utf8"));
  assert.deepEqual(config.listen, expected.listen);
  assert.deepEqual(config.workspaces, [expected.workspace]);
  assert.deepEqual(config.ui, { theme: "ark-dark", hideReasoning: false });
  assert.equal(config.auth.username, expected.username);
  assert.deepEqual(config.tls, { keyPath: join(dataHome, "tls", "server.key"), certPath: join(dataHome, "tls", "server.crt") });
  const [scheme, salt, digest] = config.auth.passwordHash.split("$");
  assert.equal(scheme, "scrypt");
  assert.match(salt, /^[a-f0-9]{32}$/);
  assert.equal(digest, Buffer.from(await scrypt(password, salt, 64)).toString("hex"));

  const key = await readFile(config.tls.keyPath, "utf8");
  const cert = await readFile(config.tls.certPath, "utf8");
  const certificate = new X509Certificate(cert);
  assert.equal(certificate.subject, "CN=localhost");
  assert.equal(certificate.issuer, certificate.subject);
  assert.equal(certificate.subjectAltName, "DNS:localhost, IP Address:127.0.0.1");
  assert.equal(certificate.checkHost("localhost", { subject: "never" }), "localhost");
  assert.equal(certificate.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(certificate.publicKey.asymmetricKeyType, "rsa");
  assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 3072);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(key)), true);
  assert.equal(certificate.verify(certificate.publicKey), true);
  assert.equal(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom), 825 * 24 * 60 * 60 * 1000);
  assert.ok(Date.parse(certificate.validFrom) <= Date.now());
  assert.ok(Date.parse(certificate.validTo) > Date.now());

  const server = createServer({ key, cert }, (_request, response) => response.end("setup HTTPS ready"));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    for (const servername of ["localhost", ""]) {
      await new Promise((resolveRequest, reject) => {
        const request = get({ host: "127.0.0.1", port: server.address().port, servername, ca: cert, rejectUnauthorized: true, agent: false }, (response) => {
          try {
            assert.equal(response.socket.authorized, true);
            assert.equal(response.statusCode, 200);
          } catch (error) { response.resume(); reject(error); return; }
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("error", reject);
          response.on("end", () => {
            try { assert.equal(body, "setup HTTPS ready"); resolveRequest(); }
            catch (error) { reject(error); }
          });
        });
        request.on("error", reject);
        request.setTimeout(10000, () => request.destroy(new Error("Setup HTTPS request timed out")));
      });
    }
  } finally {
    await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
}

try {
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(home, "pi-agent"), { recursive: true });
  const sentinel = join(home, "pi-agent", "existing-data.json");
  await writeFile(sentinel, "existing Global data\n");
  await assert.rejects(() => exec(process.execPath, [setupScript], { cwd: workspacePath, env: { ...env, PI_ARK_HOME: join(directory, "missing credentials") } }), /Usage:/);
  await exec(process.execPath, [setupScript, "--username", "setup-user", "--password", password, "--workspace", workspacePath, "--id", "setup-id", "--name", "初始化 Workspace", "--host", "0.0.0.0", "--port", "32123"], { cwd: directory, env: { ...env, PI_ARK_HOME: home }, timeout: 60000 });
  await verifySetup(home, { username: "setup-user", listen: { host: "0.0.0.0", port: 32123 }, workspace: { id: "setup-id", name: "初始化 Workspace", path: workspacePath } });
  assert.equal(await readFile(sentinel, "utf8"), "existing Global data\n");

  await mkdir(userHome, { recursive: true });
  await exec(process.execPath, [setupScript], { cwd: workspacePath, env: { ...env, PI_ARK_USERNAME: "environment-user", PI_ARK_PASSWORD: password }, timeout: 60000 });
  const id = workspacePath.split(/[\\/]/).filter(Boolean).at(-1).replace(/[^a-zA-Z0-9_-]/g, "-");
  await verifySetup(join(userHome, ".pi-ark"), { username: "environment-user", listen: { host: "127.0.0.1", port: 31415 }, workspace: { id, name: id, path: workspacePath } });
  console.log("setup checks passed");
} finally {
  await rm(directory, { recursive: true, force: true });
}
