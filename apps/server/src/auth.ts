import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCallback);
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const SESSION_RENEW_INTERVAL = 60 * 60 * 1000;
const SESSION_FILE_VERSION = 1;

interface PersistedAuthSessions {
  version: number;
  fingerprint: string;
  sessions: Record<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function instanceCookieSettings(): { name: string; path: string } {
  const instance = (process.env.PI_ARK_INSTANCE || "default").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(instance)) throw new Error("PI_ARK_INSTANCE must contain only letters, numbers, underscores, and hyphens");
  const rawBasePath = (process.env.PI_ARK_BASE_PATH || "").trim();
  const basePath = !rawBasePath || rawBasePath === "/" ? "" : rawBasePath.replace(/\/$/, "");
  if (basePath && (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath) || basePath.split("/").some((segment) => segment === "." || segment === ".."))) throw new Error("PI_ARK_BASE_PATH must be an absolute URL path with URL-safe segments");
  return { name: instance === "default" ? "pi_ark_session" : `pi_ark_session_${instance}`, path: basePath ? `${basePath}/` : "/" };
}

export async function hashPassword(password: string, salt = randomBytes(16).toString("hex")): Promise<string> {
  const digest = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${digest.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, expectedHex] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHex) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class AuthService {
  private readonly sessions = new Map<string, number>();
  private readonly renewedAt = new Map<string, number>();
  private readonly cookie = instanceCookieSettings();
  private readonly fingerprint: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly username: string, private readonly passwordHash: string, private readonly sessionFile: string, private readonly renewInterval = SESSION_RENEW_INTERVAL) {
    this.fingerprint = createHash("sha256").update(`${username}\0${passwordHash}`).digest("base64url");
  }

  async initialize(): Promise<void> {
    let persisted: PersistedAuthSessions | undefined;
    try {
      const parsed = JSON.parse(await readFile(this.sessionFile, "utf8")) as unknown;
      if (isRecord(parsed) && parsed.version === SESSION_FILE_VERSION && parsed.fingerprint === this.fingerprint && isRecord(parsed.sessions)) persisted = parsed as unknown as PersistedAuthSessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Cannot read authentication sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.sessions.clear();
    this.renewedAt.clear();
    let changed = !persisted;
    const now = Date.now();
    for (const [key, expires] of Object.entries(persisted?.sessions || {})) {
      if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) { changed = true; continue; }
      this.sessions.set(key, expires);
    }
    if (changed) await this.persist();
  }

  async login(username: string, password: string, reply: FastifyReply): Promise<boolean> {
    if (username !== this.username || !(await verifyPassword(password, this.passwordHash))) return false;
    this.pruneExpired();
    const now = Date.now();
    const token = randomBytes(32).toString("base64url");
    const key = this.sessionKey(token);
    this.sessions.set(key, now + SESSION_LIFETIME);
    this.renewedAt.set(key, now);
    await this.persist();
    reply.setCookie(this.cookie.name, token, this.cookieOptions());
    return true;
  }

  async logout(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[this.cookie.name];
    if (token) {
      const key = this.sessionKey(token);
      this.sessions.delete(key);
      this.renewedAt.delete(key);
      await this.persist();
    }
    reply.clearCookie(this.cookie.name, { path: this.cookie.path, secure: true, sameSite: "strict" });
  }

  authenticated(request: FastifyRequest, reply?: FastifyReply): boolean {
    const token = request.cookies[this.cookie.name];
    if (!token) return false;
    const key = this.sessionKey(token);
    const expires = this.sessions.get(key);
    if (!expires || expires <= Date.now()) {
      if (expires !== undefined) {
        this.sessions.delete(key);
        this.renewedAt.delete(key);
        void this.persist();
      }
      return false;
    }
    this.renew(key, token, reply);
    return true;
  }

  // Throttle renewal so the request rate does not drive session file writes.
  private renew(key: string, token: string, reply?: FastifyReply): void {
    const now = Date.now();
    const renewedAt = this.renewedAt.get(key);
    if (renewedAt !== undefined && now - renewedAt < this.renewInterval) return;
    this.renewedAt.set(key, now);
    this.sessions.set(key, now + SESSION_LIFETIME);
    reply?.setCookie(this.cookie.name, token, this.cookieOptions());
    void this.persist();
  }

  private cookieOptions(): Parameters<FastifyReply["setCookie"]>[2] {
    return { httpOnly: true, secure: true, sameSite: "strict", path: this.cookie.path, maxAge: SESSION_LIFETIME / 1000 };
  }

  private sessionKey(token: string): string {
    return createHash("sha256").update(token).digest("base64url");
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, expires] of this.sessions) {
      if (expires > now) continue;
      this.sessions.delete(key);
      this.renewedAt.delete(key);
    }
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify({ version: SESSION_FILE_VERSION, fingerprint: this.fingerprint, sessions: Object.fromEntries(this.sessions) } satisfies PersistedAuthSessions) + "\n";
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.sessionFile), { recursive: true, mode: 0o700 });
      const temporary = `${this.sessionFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporary, payload, { mode: 0o600 });
        await rename(temporary, this.sessionFile);
      } finally {
        await rm(temporary, { force: true });
      }
    }).catch((error) => {
      console.error(`Cannot persist authentication sessions: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.writeQueue;
  }
}
