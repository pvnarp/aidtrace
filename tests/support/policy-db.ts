import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase, type AppDatabase } from "../../src/server/db";
import { seedFixture } from "../../db/fixture";
import * as s from "../../db/schema";
import { SESSION_COOKIE } from "../../src/server/auth";

// IAC-405 step 1 test helpers. Real Postgres in the isolated check project. No network, no model, no provider.
export interface PolicyDatabase { db: AppDatabase; client: ReturnType<typeof postgres>; name: string; close: () => Promise<void> }
export async function createPolicyDatabase(prefix: string, options: { migrationsFolder?: string; seed?: boolean } = {}): Promise<PolicyDatabase> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  if (!/^aidtrace_[a-z0-9_]+_[a-f0-9]{12}$/.test(name)) throw new Error("Unexpected test database name");
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 }); const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin`create database ${admin(name)}`;
  const { db, client } = connectDatabase(url.toString());
  await migrate(db, { migrationsFolder: options.migrationsFolder ?? "db/migrations" });
  if (options.seed !== false) await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "policy-test@example.invalid", payeeAllowlist: ["policy-test@example.invalid"] });
  return { db, client, name, close: async () => { await client.end(); await admin`drop database ${admin(name)} with (force)`; await admin.end(); } };
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export async function sessionFor(db: AppDatabase, userId: string) {
  const token = randomBytes(32).toString("hex");
  await db.insert(s.sessions).values({ tokenHash: digest(token), userId, expiresAt: new Date(Date.now() + 3_600_000) });
  return token;
}
export const ORIGIN = "http://127.0.0.1:3100";
export function postRequest(claimId: string, token: string | null, fields: Record<string, string | string[]> | string, patch: { origin?: string | null; contentType?: string | null; method?: string } = {}) {
  const body = typeof fields === "string" ? fields : new URLSearchParams(Object.entries(fields).flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map(item => [key, item] as [string, string]))).toString();
  const headers: Record<string, string> = {};
  if (patch.origin !== null) headers.origin = patch.origin ?? ORIGIN;
  if (patch.contentType !== null) headers["content-type"] = patch.contentType ?? "application/x-www-form-urlencoded";
  if (token) headers.cookie = `${SESSION_COOKIE}=${token}`;
  const method = patch.method ?? "POST";
  return new Request(`${ORIGIN}/api/claims/${claimId}/policy-checks`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body });
}

export type ClaimSpec = { id: string; vendor?: string; incurredOn?: string; status?: (typeof s.claims.$inferInsert)["status"]; claimantId?: string; organizationId?: string; version?: number;
  lines: { id: string; category: string; budgetLine: string; amountCents: bigint; description?: string }[] };
// Inserts a claim shaped like C-104 with the caller's overrides. Tests only. It writes claims and claim_lines and nothing else.
export async function insertClaim(db: AppDatabase, spec: ClaimSpec) {
  const [base] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  const version = spec.version ?? 1;
  await db.insert(s.claims).values({ ...base!, id: spec.id, version, vendor: spec.vendor ?? base!.vendor, incurredOn: spec.incurredOn ?? base!.incurredOn, status: spec.status ?? "DRAFT",
    claimantId: spec.claimantId ?? base!.claimantId, organizationId: spec.organizationId ?? base!.organizationId });
  await db.insert(s.claimLines).values(spec.lines.map(line => ({ claimId: spec.id, claimVersion: version, description: "Policy test line", ...line })));
}

// The sixteen tables the financial hash covers (tests/analytics.integration.test.ts). The policy tables are not among them.
export const FINANCIAL_TABLES = ["claims", "claim_lines", "allocation_decisions", "allocation_edges", "approvals", "fund_reservations", "reservation_budget_lines", "fund_credits", "fund_debits",
  "journal_entries", "journal_postings", "disbursements", "disbursement_attempts", "donation_receipts", "retry_authorizations", "provider_events"];
export async function financialHash(client: ReturnType<typeof postgres>) {
  const rows = [];
  for (const table of FINANCIAL_TABLES) rows.push(await client`select to_jsonb(r)::text as v from ${client(table)} r order by (to_jsonb(r)::text) collate "C"`);
  return digest(JSON.stringify(rows));
}
export async function tableHash(client: ReturnType<typeof postgres>, table: string) {
  const rows = await client`select to_jsonb(r)::text as v from ${client(table)} r order by (to_jsonb(r)::text) collate "C"`;
  return { count: rows.length, hash: digest(JSON.stringify(rows)) };
}
