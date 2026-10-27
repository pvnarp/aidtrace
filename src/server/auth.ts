import { createHash, randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { and, eq, gt, sql } from "drizzle-orm";
import { loginWindows, sessions, users } from "../../db/schema";
import { getDatabase, type AppDatabase } from "./db";

export const SESSION_COOKIE = "aidtrace_session";
const SESSION_SECONDS = 8 * 60 * 60;
const dummyHash = hash("synthetic-login-timing-value", 12);
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export function appOrigin() {
  const origin = process.env.APP_ORIGIN;
  if (!origin || !["http://127.0.0.1:3100", "http://localhost:3100"].includes(origin)) throw new Error("APP_ORIGIN must be the explicit local demo origin");
  return origin;
}
export function isSameOrigin(request: Request) { return request.headers.get("origin") === appOrigin(); }
export function sessionToken(request: Request) {
  return request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
}
export function sessionCookie(token: string, expires: Date) {
  // The permitted app origins are loopback HTTP. HTTPS hosting is outside this package.
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}; Expires=${expires.toUTCString()}`;
}
export const expiredSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
export async function authenticate(username: string, password: string, db: AppDatabase = getDatabase()) {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(username) || password.length < 1 || Buffer.byteLength(password, "utf8") > 72) return null;
  // Atomic per-account limit: ten attempts per fifteen minutes, shared across app instances.
  const now = new Date();
  const [window] = await db.insert(loginWindows).values({ username, attempts: 1, resetsAt: new Date(now.getTime() + 15 * 60_000) })
    .onConflictDoUpdate({ target: loginWindows.username, set: {
      attempts: sql`case when ${loginWindows.resetsAt} <= now() then 1 else ${loginWindows.attempts} + 1 end`,
      resetsAt: sql`case when ${loginWindows.resetsAt} <= now() then now() + interval '15 minutes' else ${loginWindows.resetsAt} end`,
    } }).returning();
  if (!window || window.attempts > 10) return null;
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  const valid = await compare(password, user?.passwordHash ?? await dummyHash);
  if (!user || !valid) return null;
  await db.delete(loginWindows).where(eq(loginWindows.username, username));
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_SECONDS * 1000);
  await db.insert(sessions).values({ tokenHash: digest(token), userId: user.id, expiresAt: expires });
  return { token, expires, user: { id: user.id, username: user.username, displayName: user.displayName, role: user.role } };
}
export async function findSession(token: string | undefined, db: AppDatabase = getDatabase()) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const [result] = await db.select({ id: users.id, username: users.username, displayName: users.displayName, role: users.role })
    .from(sessions).innerJoin(users, eq(sessions.userId, users.id)).where(and(eq(sessions.tokenHash, digest(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  return result ?? null;
}
export async function revokeSession(token: string | undefined, db: AppDatabase = getDatabase()) {
  if (token && /^[0-9a-f]{64}$/.test(token)) await db.delete(sessions).where(eq(sessions.tokenHash, digest(token)));
}
