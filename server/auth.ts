import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as argon2 from "argon2";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { logger } from "./logger.js";

export type AuthUser = { id: string; email: string; passwordHash: string; role: "admin" | "operator" };
export type AuthSession = { tokenHash: string; userId: string; expiresAt: string };
export type Operator = Pick<AuthUser, "id" | "email" | "role">;

export interface AuthStore {
  findUserByEmail(email: string): Promise<AuthUser | undefined>;
  findUserById(id: string): Promise<AuthUser | undefined>;
  saveUser(user: AuthUser): Promise<void>;
  getSession(tokenHash: string): Promise<AuthSession | undefined>;
  saveSession(session: AuthSession): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
}

/** Simulator/test implementation. Production supplies the Postgres implementation. */
export class InMemoryAuthStore implements AuthStore {
  private readonly users = new Map<string, AuthUser>();
  private readonly sessions = new Map<string, AuthSession>();
  async findUserByEmail(email: string) { return [...this.users.values()].find((user) => user.email === email); }
  async findUserById(id: string) { return this.users.get(id); }
  async saveUser(user: AuthUser) { this.users.set(user.id, structuredClone(user)); }
  async getSession(tokenHash: string) { return this.sessions.get(tokenHash); }
  async saveSession(session: AuthSession) {
    for (const [hash, candidate] of this.sessions) {
      if (Date.parse(candidate.expiresAt) <= Date.now()) this.sessions.delete(hash);
    }
    this.sessions.set(session.tokenHash, structuredClone(session));
  }
  async deleteSession(tokenHash: string) { this.sessions.delete(tokenHash); }
}

const seedSchema = z.object({ email: z.string().trim().email().transform((value) => value.toLowerCase()), password: z.string().min(16).max(256) });
export const loginSchema = z.object({ email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()), password: z.string().min(1).max(256) }).strict();
export const SESSION_COOKIE = "__Host-mktr_session";
const sessionDurationMs = 8 * 60 * 60 * 1000;
const cookieOptions = { httpOnly: true, secure: true, sameSite: "strict" as const, path: "/" };
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
const publicUser = ({ id, email, role }: AuthUser): Operator => ({ id, email, role });

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
}

export async function seedAdmin(store: AuthStore, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (!env.MKTR_ADMIN_EMAIL && !env.MKTR_ADMIN_PASSWORD) {
    if (env.NODE_ENV === "production") throw new Error("MKTR_ADMIN_EMAIL and MKTR_ADMIN_PASSWORD are required to bootstrap the operator account.");
    logger.warn("No admin seed configured; sign-in is unavailable until MKTR_ADMIN_EMAIL and MKTR_ADMIN_PASSWORD are set.");
    return false;
  }
  const input = seedSchema.parse({ email: env.MKTR_ADMIN_EMAIL, password: env.MKTR_ADMIN_PASSWORD });
  const existing = await store.findUserByEmail(input.email);
  if (existing) {
    if (existing.role !== "admin") throw new Error("The configured admin email already belongs to a non-admin account.");
    return true;
  }
  await store.saveUser({ id: randomUUID(), email: input.email, passwordHash: await hashPassword(input.password), role: "admin" });
  logger.info("Initial administrator account created from environment.");
  return true;
}

function readSessionToken(request: Request): string | undefined {
  const part = request.headers.cookie?.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  const token = part?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}

export function timingSafeTokenMatches(candidate: string | undefined, expected: string): boolean {
  // Hashing both sides keeps timingSafeEqual lengths fixed, including malformed headers.
  const matches = timingSafeEqual(createHash("sha256").update(candidate ?? "").digest(), createHash("sha256").update(expected).digest());
  return expected.length > 0 && matches;
}

export function requireMediaGateway(expectedToken: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!expectedToken || !timingSafeTokenMatches(request.header("authorization"), `Bearer ${expectedToken}`)) {
      response.status(401).json({ error: "Media gateway authorization failed." });
      return;
    }
    next();
  };
}

export function createAuth(store: AuthStore, clock = Date.now) {
  // Unknown users still incur a real argon2 verification, avoiding an email-existence timing shortcut.
  let dummyHash: Promise<string> | undefined;
  return {
    async login(request: Request, response: Response) {
      const { email, password } = loginSchema.parse(request.body);
      const user = await store.findUserByEmail(email);
      const hash = user?.passwordHash ?? await (dummyHash ??= hashPassword(randomBytes(32).toString("hex")));
      const valid = await argon2.verify(hash, password);
      if (!user || !valid) return response.status(401).json({ error: "Email or password is incorrect." });
      const previous = readSessionToken(request);
      if (previous) await store.deleteSession(tokenHash(previous));
      const token = randomBytes(32).toString("hex");
      await store.saveSession({ tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(clock() + sessionDurationMs).toISOString() });
      response.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: sessionDurationMs });
      return response.json({ user: publicUser(user) });
    },
    async requireOperator(request: Request, response: Response, next: NextFunction) {
      const token = readSessionToken(request);
      const session = token ? await store.getSession(tokenHash(token)) : undefined;
      if (!session || Date.parse(session.expiresAt) <= clock()) {
        if (session) await store.deleteSession(session.tokenHash);
        response.clearCookie(SESSION_COOKIE, cookieOptions);
        response.status(401).json({ error: "Sign in to continue." });
        return;
      }
      const user = await store.findUserById(session.userId);
      if (!user) {
        await store.deleteSession(session.tokenHash);
        response.clearCookie(SESSION_COOKIE, cookieOptions);
        response.status(401).json({ error: "Sign in to continue." });
        return;
      }
      response.locals.operator = publicUser(user);
      next();
    },
    async logout(request: Request, response: Response) {
      const token = readSessionToken(request);
      if (token) await store.deleteSession(tokenHash(token));
      response.clearCookie(SESSION_COOKIE, cookieOptions);
      response.json({ ok: true });
    }
  };
}

export function requireAdmin(_request: Request, response: Response, next: NextFunction) {
  if ((response.locals.operator as Operator | undefined)?.role !== "admin") {
    response.status(403).json({ error: "Administrator access is required." });
    return;
  }
  next();
}
