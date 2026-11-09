import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = "pi_ark_session";
const SESSION_TTL = 24 * 60 * 60 * 1000;

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

  constructor(private readonly username: string, private readonly passwordHash: string) {}

  async login(username: string, password: string, reply: FastifyReply): Promise<boolean> {
    if (username !== this.username || !(await verifyPassword(password, this.passwordHash))) return false;
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, Date.now() + SESSION_TTL);
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: SESSION_TTL / 1000 });
    return true;
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[COOKIE_NAME];
    if (token) this.sessions.delete(token);
    reply.clearCookie(COOKIE_NAME, { path: "/", secure: true, sameSite: "strict" });
  }

  authenticated(request: FastifyRequest): boolean {
    const token = request.cookies[COOKIE_NAME];
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
