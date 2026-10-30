import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../../src/server/db";
import { seedFixture } from "../../db/fixture";
import { ensureFixtureOpening } from "../../src/ledger/opening";
import type { DonationObservation, DonationOrderCreateResult, DonationCaptureResult } from "../../src/paypal/adapter";
import type { DonationOrderPayments } from "../../src/donation/orders";

// IAC-379 step 3a test helpers (DON-09, DON-12). The provider is always a scripted stand-in written here: no network, no
// credentials, no PayPal. These prove AidTrace's wiring against a real isolated PostgreSQL, not PayPal behavior.
export async function createDonationTestDatabase(prefix: string) {
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  if (!/^aidtrace_[a-z0-9_]+_[a-f0-9]{12}$/.test(name)) throw new Error("Unexpected test database name");
  const adminUrl = new URL(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace"); adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 }); const url = new URL(adminUrl); url.pathname = `/${name}`;
  await admin`create database ${admin(name)}`;
  const { db, client } = connectDatabase(url.toString());
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seedFixture(db, { passwords: { maria: randomBytes(18).toString("hex"), tara: randomBytes(18).toString("hex"), ben: randomBytes(18).toString("hex") }, payeeEmail: "donation-routes-test@example.invalid", payeeAllowlist: ["donation-routes-test@example.invalid"] });
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  return { db, close: async () => { await client.end(); await admin`drop database ${admin(name)} with (force)`; await admin.end(); } };
}

type Capture = DonationObservation["captures"][number];
export type CaptureStep = "complete" | "pending" | "decline" | "timeout" | "timeout-complete";
export type CreateStep = "ok" | "timeout" | { httpStatus: number; errorCode?: string; errorIssues?: string[] };
let sequence = 0;
export function makeDonationStub() {
  const serial = ++sequence;
  const world: { orderId?: string; status: string; units: { fundId?: string; amountCents?: bigint }[]; captures: Capture[] } = { status: "CREATED", units: [], captures: [] };
  const script: { create: CreateStep[]; capture: CaptureStep[]; createsOrder: boolean } = { create: [], capture: [], createsOrder: true };
  const calls: string[] = []; const sentRequestIds: string[] = []; const madeFor = new Set<string>();
  const finish = (status: "COMPLETED" | "PENDING") => {
    const gross = world.units[0]?.amountCents ?? 0n; const fee = gross / 10n;
    world.captures = [{ captureId: `CAPTURE_${serial}_LONGID`, status, amountCents: gross, ...(status === "COMPLETED" ? { grossCents: gross, feeCents: fee, netCents: gross - fee, effectiveOn: "2026-10-30" } : {}) }];
    world.status = "COMPLETED";
  };
  const read = (): DonationObservation => ({ httpStatus: 200, orderId: world.orderId, intent: "CAPTURE", status: world.status, units: world.units.map(unit => ({ ...unit })), captures: world.captures.map(capture => ({ ...capture })) });
  const payments = {
    createDonationOrder: vi.fn(async (order: Parameters<DonationOrderPayments["createDonationOrder"]>[0]): Promise<DonationOrderCreateResult> => {
      calls.push("create");
      if (script.createsOrder && !madeFor.has(order.requestId)) { madeFor.add(order.requestId); world.orderId = `ORDER_${serial}_${madeFor.size}`; world.units = [{ fundId: order.fundId, amountCents: order.amountCents }]; world.status = "CREATED"; world.captures = []; }
      const step = script.create.shift() ?? "ok";
      if (step === "timeout") throw new Error("synthetic timeout");
      if (typeof step === "object") return { httpStatus: step.httpStatus, errorCode: step.errorCode, errorIssues: step.errorIssues ?? [] };
      return { httpStatus: 201, orderId: world.orderId, status: "CREATED", errorIssues: [] };
    }),
    donationOrder: vi.fn(async (): Promise<DonationObservation> => { calls.push("read"); return read(); }),
    captureDonationOrder: vi.fn(async (_orderId: string, requestId: string): Promise<DonationCaptureResult> => {
      calls.push("capture"); sentRequestIds.push(requestId);
      const step = script.capture.shift() ?? "complete";
      if (step === "decline") return { httpStatus: 422, units: [], captures: [], errorCode: "UNPROCESSABLE_ENTITY", errorIssues: ["INSTRUMENT_DECLINED"] };
      if (step === "complete" || step === "timeout-complete") finish("COMPLETED");
      if (step === "pending") finish("PENDING");
      if (step === "timeout" || step === "timeout-complete") throw new Error("synthetic timeout");
      return { ...read(), httpStatus: 201, errorIssues: [] };
    }),
  } satisfies DonationOrderPayments;
  return { payments, world, script, calls, sentRequestIds, approve: () => { world.status = "APPROVED"; }, captureId: `CAPTURE_${serial}_LONGID` };
}
export type DonationStub = ReturnType<typeof makeDonationStub>;
