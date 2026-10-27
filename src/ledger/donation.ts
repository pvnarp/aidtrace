import { and, eq, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { DonationReader } from "../paypal/adapter";
import type { LedgerTransaction } from "./journal";
import { postJournal } from "./journal";
import { serializable } from "./service";
import { ensureFixtureOpening } from "./opening";
import { reconcile } from "./reconcile";

export interface ExpectedDonation { orderId: string; captureId?: string; fundId: string; amountCents: bigint; }
async function authority(tx: LedgerTransaction, actorId: string, expected: ExpectedDonation) {
  const [actor] = await tx.select().from(s.users).where(eq(s.users.id, actorId));
  const [fund] = await tx.select().from(s.funds).where(eq(s.funds.id, expected.fundId));
  if (!actor || actor.role !== "APPROVER" || !fund || fund.organizationId !== actor.organizationId || fund.fundClass !== "RESTRICTED") throw new Error("Organization approver and designated restricted fund required");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${actor.organizationId})::bigint)`);
  return { actor, fund };
}
// Reconcile an existing owner-created Orders v2 donation. This service never creates or
// captures an order, and never calls a manual lab helper from the application workflow.
export async function recordDesignatedDonation(db: AppDatabase, actorId: string, expected: ExpectedDonation, provider: DonationReader) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(expected.orderId) || expected.captureId && !/^[A-Za-z0-9_-]{1,64}$/.test(expected.captureId) || typeof expected.amountCents !== "bigint" || expected.amountCents <= 0n) throw new Error("Expected donation identity and positive integer cents required");
  await serializable(db, tx => authority(tx, actorId, expected));
  const observation = await provider.donationOrder(expected.orderId);
  if (observation.httpStatus !== 200 || observation.orderId !== expected.orderId || observation.intent !== "CAPTURE" || observation.units.length !== 1 || observation.units[0]!.fundId !== expected.fundId || observation.units[0]!.amountCents !== expected.amountCents || observation.captures.length > 1) throw new Error("Independent donation order binding failed");
  const capture = observation.captures[0];
  if (expected.captureId && capture?.captureId !== expected.captureId) throw new Error("Independent capture ID differs from the expected donation");
  const complete = capture?.status === "COMPLETED";
  if (complete && (observation.status !== "COMPLETED" || !capture.captureId || capture.amountCents !== expected.amountCents || capture.grossCents !== expected.amountCents || capture.feeCents === undefined || capture.netCents === undefined || capture.feeCents < 0n || capture.netCents < 0n || capture.grossCents - capture.feeCents !== capture.netCents)) throw new Error("Completed capture needs exact gross, fee and net reconciliation");
  return serializable(db, async tx => {
    const { actor, fund } = await authority(tx, actorId, expected);
    const [existing] = await tx.select().from(s.donationReceipts).where(eq(s.donationReceipts.orderId, expected.orderId));
    if (existing && (existing.organizationId !== actor.organizationId || existing.fundId !== fund.id || existing.expectedAmountCents !== expected.amountCents || existing.captureId && existing.captureId !== capture?.captureId)) throw new Error("Stored donation identity is immutable");
    if (existing?.status === "COMPLETED") {
      if (!complete || capture!.grossCents !== existing.grossCents || capture!.feeCents !== existing.feeCents || capture!.netCents !== existing.netCents) throw new Error("Completed donation changed; manual review required");
      return { status: "COMPLETED" as const, captureId: existing.captureId, grossCents: existing.grossCents, feeCents: existing.feeCents, netCents: existing.netCents, posted: false };
    }
    const values = { organizationId: actor.organizationId, fundId: fund.id, expectedAmountCents: expected.amountCents, captureId: capture?.captureId ?? null, status: complete ? "COMPLETED" : "PENDING", providerStatus: capture?.status ?? observation.status ?? "UNKNOWN", grossCents: complete ? capture!.grossCents! : null, feeCents: complete ? capture!.feeCents! : null, netCents: complete ? capture!.netCents! : null, effectiveOn: complete ? capture!.effectiveOn ?? new Date().toISOString().slice(0, 10) : null };
    if (existing) await tx.update(s.donationReceipts).set(values).where(eq(s.donationReceipts.orderId, expected.orderId));
    else await tx.insert(s.donationReceipts).values({ orderId: expected.orderId, ...values, recordedBy: actorId });
    if (!complete) return { status: "PENDING" as const, posted: false };
    await ensureFixtureOpening(tx, actor.organizationId);
    const [general] = await tx.select().from(s.funds).where(and(eq(s.funds.organizationId, actor.organizationId), eq(s.funds.id, "fund_g"), eq(s.funds.fundClass, "UNRESTRICTED")));
    if (!general) throw new Error("General fee fund required");
    const effectiveOn = values.effectiveOn!; const captureId = capture!.captureId!;
    await postJournal(tx, { sourceType: "paypal_capture", sourceId: captureId, purpose: "donation", effectiveOn, postings: [{ accountCode: "1010", debitCents: expected.amountCents, creditCents: 0n }, { accountCode: "4100", subKey: fund.id, debitCents: 0n, creditCents: expected.amountCents }] });
    await tx.insert(s.fundCredits).values({ fundId: fund.id, sourceType: "paypal_capture", sourceId: captureId, effectiveOn, amountCents: expected.amountCents, isOpening: false });
    if (capture!.feeCents! > 0n) {
      await postJournal(tx, { sourceType: "paypal_capture", sourceId: captureId, purpose: "donation_fee", effectiveOn, postings: [{ accountCode: "5900", subKey: captureId, debitCents: capture!.feeCents!, creditCents: 0n }, { accountCode: "1010", debitCents: 0n, creditCents: capture!.feeCents! }] });
      await tx.insert(s.fundDebits).values({ fundId: general.id, sourceType: "paypal_capture", sourceId: captureId, effectiveOn, amountCents: capture!.feeCents!, purpose: "donation_fee" });
    }
    if (!(await reconcile(tx, actor.organizationId)).matches) throw new Error("Donation failed ledger tie-out");
    return { status: "COMPLETED" as const, captureId, grossCents: capture!.grossCents, feeCents: capture!.feeCents, netCents: capture!.netCents, posted: true };
  });
}
