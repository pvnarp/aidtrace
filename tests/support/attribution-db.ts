import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../../src/server/db";
import type { AppDatabase } from "../../src/server/db";
import { seedFixture } from "../../db/fixture";
import * as s from "../../db/schema";
import { recordDesignatedDonation } from "../../src/ledger/donation";
import { approveDecision, freezeDecision } from "../../src/ledger/service";
import type { DonationObservation, DonationReader } from "../../src/paypal/adapter";

// IAC-379 step 2 test helpers (DON-05, DON-06). Real Postgres in the isolated check project, stubbed provider observation,
// no network. The donation goes through the existing recordDesignatedDonation path, exactly as donation-ledger.integration.test.ts does.
export interface TestDatabase { db: AppDatabase; name: string; close: () => Promise<void>; }
export async function createTestDatabase(prefix: string): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  if (!/^aidtrace_[a-z0-9_]+_[a-f0-9]{12}$/.test(name)) throw new Error("Unexpected test database name");
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 }); const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin`create database ${admin(name)}`;
  const { db, client } = connectDatabase(url.toString());
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "attribution-test@example.invalid", payeeAllowlist: ["attribution-test@example.invalid"] });
  return { db, name, close: async () => { await client.end(); await admin`drop database ${admin(name)} with (force)`; await admin.end(); } };
}

let serial = 0;
const runTag = randomBytes(4).toString("hex");
// A COMPLETED designated gift to `fundId`, reported by a stubbed provider. Returns the capture ID.
export async function recordGift(db: AppDatabase, fundId: string, amountCents: bigint, feeCents = 0n, status: "COMPLETED" | "PENDING" = "COMPLETED") {
  const n = ++serial; const orderId = `ORDER_${runTag}_${n}`; const captureId = `CAPTURE_${runTag}_${n}`;
  const data: DonationObservation = { httpStatus: 200, orderId, intent: "CAPTURE", status, units: [{ fundId, amountCents }],
    captures: [{ captureId, status, amountCents, grossCents: amountCents, feeCents, netCents: amountCents - feeCents, effectiveOn: "2026-10-22" }] };
  const provider = { donationOrder: vi.fn<DonationReader["donationOrder"]>(async () => data) };
  await recordDesignatedDonation(db, "tara", { orderId, captureId, fundId, amountCents }, provider);
  return captureId;
}

// Allocation, freeze, then both independent approvals, exactly as the ledger integration tests do.
export async function recognizeClaim(db: AppDatabase, claimId: string) {
  const frozen = await freezeDecision(db, claimId, "maria");
  if (frozen.status !== "AWAITING_APPROVAL") throw new Error("Expected a funded frozen decision");
  const first = await approveDecision(db, frozen.decisionId, "tara", frozen.decisionHash);
  const second = await approveDecision(db, frozen.decisionId, "ben", frozen.decisionHash);
  return { frozen, first, second };
}

// A second claim shaped like C-104. Lines are given by the caller. Used only inside tests.
export async function extraClaim(db: AppDatabase, id: string, lines: { id: string; category: string; budgetLine: string; amountCents: bigint }[]) {
  const [base] = await db.select().from(s.claims).where(eq(s.claims.id, "C-104"));
  await db.insert(s.claims).values({ ...base!, id, status: "DRAFT" });
  await db.insert(s.claimLines).values(lines.map(line => ({ claimId: id, claimVersion: 1, description: "Attribution test line", ...line })));
}
export const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
