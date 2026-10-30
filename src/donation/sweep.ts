import { and, asc, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { maskTail } from "./display";
import { expireDonationOrders, reconcileDonationOrder, type DonationOrderPayments, type DonationOrderResult } from "./orders";

// IAC-379 step 3a, owner answer 3 (docs/decisions.md): one worker pass. It expires abandoned orders with no provider call,
// then, only in a KEYED session, reconciles rows that may hold money. The single same-ID capture retry lives inside
// reconcileDonationOrder and is not reimplemented here. Logs carry counts and IDs masked to six characters, nothing else.
export const SWEEP_BATCH = 25;
export interface SweepReport { mode: "KEYED" | "KEYLESS"; expired: number; considered: number; reconciled: number; failed: number; skipped: string | null }
export type SweepLog = (entry: Record<string, string | number | null>) => void;
const RECONCILABLE: s.DonationOrderStatus[] = ["CAPTURE_UNKNOWN", "PENDING", "CAPTURING"];

export async function runDonationSweep(db: AppDatabase, options: {
  mode: "KEYED" | "KEYLESS"; payments: () => DonationOrderPayments; log?: SweepLog; batch?: number; abandonAfterMs?: number;
  reconcile?: (db: AppDatabase, payments: DonationOrderPayments, orderId: string) => Promise<DonationOrderResult>;
}): Promise<SweepReport> {
  const log = options.log ?? (() => undefined); const reconcile = options.reconcile ?? reconcileDonationOrder;
  const batch = options.batch ?? SWEEP_BATCH;
  const expiredIds = await expireDonationOrders(db, options.abandonAfterMs === undefined ? {} : { abandonAfterMs: options.abandonAfterMs });
  for (const id of expiredIds) log({ event: "expired", row: maskTail(id) });
  const report: SweepReport = { mode: options.mode, expired: expiredIds.length, considered: 0, reconciled: 0, failed: 0, skipped: null };
  if (options.mode !== "KEYED") {
    report.skipped = "reconcile skipped: no PayPal sandbox credentials in this session";
    log({ event: "pass", mode: options.mode, expired: report.expired, note: report.skipped });
    return report;
  }
  // Oldest first. A row whose lease is live belongs to a request in flight and is left alone; a stale lease may be reclaimed.
  const candidates = await db.select({ id: s.donationOrders.id, orderId: s.donationOrders.orderId }).from(s.donationOrders).where(and(
    inArray(s.donationOrders.status, RECONCILABLE), isNotNull(s.donationOrders.orderId),
    or(isNull(s.donationOrders.leaseExpiresAt), lt(s.donationOrders.leaseExpiresAt, sql`now()`)),
  )).orderBy(asc(s.donationOrders.updatedAt)).limit(batch);
  report.considered = candidates.length;
  if (candidates.length) {
    let payments: DonationOrderPayments | undefined;
    for (const candidate of candidates) {
      try {
        const result = await reconcile(db, payments ??= options.payments(), candidate.orderId!);
        report.reconciled++;
        log({ event: "reconciled", row: maskTail(candidate.id), order: maskTail(candidate.orderId), status: result.status, posted: result.posted ? 1 : 0, reason: result.reason ?? null });
      } catch (error) {
        report.failed++; // one row never stops the pass; only the error class is logged, never its message
        log({ event: "row-failed", row: maskTail(candidate.id), order: maskTail(candidate.orderId), error: error instanceof Error ? error.name : "Error" });
      }
    }
  }
  log({ event: "pass", mode: options.mode, expired: report.expired, considered: report.considered, reconciled: report.reconciled, failed: report.failed });
  return report;
}
