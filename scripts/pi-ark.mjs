#!/usr/bin/env node

import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const args = process.argv.slice(2);
const command = args[0];

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp() {
  console.log(`Pi-Ark command line

Usage:
  pi-ark password [--config <path>] [--no-restart]
  pi-ark passwd   [--config <path>] [--no-restart]
  pi-ark help

Environment:
  PI_ARK_HOME          Pi-Ark data directory (default: ~/.pi-ark)
  PI_ARK_NEW_PASSWORD  Non-interactive password input
`);
}

async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Interactive password input requires a TTY. Use PI_ARK_NEW_PASSWORD for non-interactive input.");
  }

  process.stdout.write(label);
  emitKeypressEvents(process.stdin);
  const previousRawMode = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolvePromise, rejectPromise) => {
    let value = "";
    const finish = (error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(Boolean(previousRawMode));
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const onKeypress = (text, key) => {
      if (key?.ctrl && key.name === "c") return finish(new Error("Password change cancelled"));
      if (key?.name === "return" || key?.name === "enter") return finish();
      if (key?.name === "backspace") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      if (text && !key?.ctrl && !key?.meta) {
        value += text;
        process.stdout.write("*".repeat([...text].length));
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const digest = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${Buffer.from(digest).toString("hex")}`;
}

async function changePassword() {
  const arkHome = resolve(process.env.PI_ARK_HOME || join(homedir(), ".pi-ark"));
  const targetConfig = resolve(option("--config") || join(arkHome, "config.json"));
  const environmentPassword = process.env.PI_ARK_NEW_PASSWORD;
  const password = environmentPassword || await promptSecret("New Pi-Ark password: ");
  if (password.length < 6) throw new Error("Password must contain at least 6 characters");
  if (!environmentPassword) {
    const confirmation = await promptSecret("Confirm new password: ");
    if (password !== confirmation) throw new Error("Passwords do not match");
  }

  const config = JSON.parse(await readFile(targetConfig, "utf8"));
  if (!config.auth?.username) throw new Error(`Invalid Pi-Ark configuration: ${targetConfig}`);
  config.auth.passwordHash = await hashPassword(password);

  await mkdir(dirname(targetConfig), { recursive: true, mode: 0o700 });
  const temporaryPath = `${targetConfig}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, targetConfig);
  await chmod(targetConfig, 0o600);
  await unlink(join(dirname(targetConfig), "initial-credentials.txt")).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  console.log(`Password updated in ${targetConfig}`);
  if (!args.includes("--no-restart")) {
    try {
      execFileSync("systemctl", ["is-active", "--quiet", "pi-ark.service"], { stdio: "ignore" });
      execFileSync("systemctl", ["restart", "pi-ark.service"], { stdio: "inherit" });
      console.log("Pi-Ark service restarted");
    } catch (error) {
      if (error?.status === 3) console.log("Pi-Ark service is inactive; the new password will apply at the next start");
      else throw error;
    }
  } else {
    console.log("Restart Pi-Ark to apply the new password");
  }
}

try {
  if (command === "password" || command === "passwd") await changePassword();
  else if (!command || command === "help" || command === "--help" || command === "-h") printHelp();
  else {
    printHelp();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
