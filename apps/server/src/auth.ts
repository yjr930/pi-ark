import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCallback);
const SESSION_TTL = 24 * 60 * 60 * 1000;

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
  private readonly cookie = instanceCookieSettings();

  constructor(private readonly username: string, private readonly passwordHash: string) {}

  async login(username: string, password: string, reply: FastifyReply): Promise<boolean> {
    if (username !== this.username || !(await verifyPassword(password, this.passwordHash))) return false;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL);
    reply.setCookie(this.cookie.name, token, { httpOnly: true, secure: true, sameSite: "strict", path: this.cookie.path, maxAge: SESSION_TTL / 1000 });
    return true;
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[this.cookie.name];
    if (token) this.sessions.delete(token);
    reply.clearCookie(this.cookie.name, { path: this.cookie.path, secure: true, sameSite: "strict" });
  }

  authenticated(request: FastifyRequest): boolean {
    const token = request.cookies[this.cookie.name];
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires <= Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    this.sessions.set(token, Date.now() + SESSION_TTL);
    return true;
  }
}
