import { and, eq, inArray, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { maskTail } from "./display";
import { cleanText, DEFAULT_DONOR_NAME, noteTextHash, type PayoutNoteStatus } from "./note";
import { buildGiftTrail, loadGiftTrailFacts, type PayoutRollup, type Trail, type TrailState } from "./trail";

// IAC-413 PR B (docs/plans/DONOR_TRAIL_SCOPE.md section 4): the approver donations grid loader.
// One transaction that starts `set transaction read only` at repeatable read, and SELECT statements only. It imports neither the
// PayPal adapter nor a ledger writer. It never reads the gift link table: an approver cannot see or regenerate a donor link (GT-29).
// Every cent value leaves this module as a decimal string, and the grid turns it into a bigint. No floating point value appears.
export class DonationsAccessError extends Error {
  constructor(public readonly status: 403) { super("Approver access required"); this.name = "DonationsAccessError"; }
}

// The grid shows at most this many gifts, newest first. The cap is a guess sized for the demo fixture. `total` and the totals cover every gift.
export const DONATIONS_ROW_CAP = 2000;
export const NONE_YET = "None yet";

export const TRAIL_STATE_LABELS: Readonly<Record<TrailState, string>> = {
  WAITING: "Waiting for a receipt", MATCHED: "Applied", APPROVED: "Approved", PAYING: "Payout in progress", PAID: "Paid",
};
export const PAYOUT_LABELS: Readonly<Record<PayoutRollup, string>> = {
  NO_PAYMENT: "No payment", PROCESSING: "Processing", UNKNOWN: "Being verified", NEEDS_ATTENTION: "Needs attention", PAID: "Paid", PARTLY_PAID: "Partly paid",
};
// Words, never color alone. An unverified outcome is neither paid nor failed, so its tooltip says both.
export const PAYOUT_TIPS: Readonly<Record<PayoutRollup, string>> = {
  NO_PAYMENT: "No payment has been sent for this gift.",
  PROCESSING: "A payout was submitted and has not settled yet.",
  UNKNOWN: "The outcome is not verified. It is not paid and it is not failed. It needs reconciliation.",
  NEEDS_ATTENTION: "A payout failed, was held for review or was rejected for funding. A person must look at it.",
  PAID: "Every line of this gift has a verified settlement.",
  PARTLY_PAID: "Some lines of this gift have a verified settlement and the rest do not.",
};
export type PayoutDot = "gx-dot-ok" | "gx-dot-hold" | "gx-dot-stop" | "gx-dot-idle";

/** One row per completed gift. Cents are decimal strings. Nothing here names a claimant, an approver, a link or a full provider id. */
export interface DonationRow {
  /** An opaque stable key. It is not the capture id, so the full capture id never reaches the browser. */
  id: string;
  received: string;
  donor: string;
  amountCents: string;
  fund: string;
  capture: string;
  state: string;
  matchedCents: string;
  waitingCents: string;
  lines: string;
  linesTip: string;
  vendor: string;
  vendorTip: string;
  payoutStatus: string;
  payoutTip: string;
  payoutDot: PayoutDot;
  paypalReference: string;
  paypalTip: string;
  /** True when any applied line has an UNKNOWN payout. The grid marks the row with gx-row-verify and the words are in Payout Status. */
  verify: boolean;
}
export interface DonationsGrid {
  organization: string;
  observedAt: string;
  /** Every completed gift of the organization, not only the rows returned. */
  total: number;
  capped: boolean;
  rows: DonationRow[];
  /** Sums over every completed gift, as decimal strings of cents. */
  totals: { amountCents: string; matchedCents: string; waitingCents: string };
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const rowKey = (captureId: string) => `gift-${noteTextHash(`donations-grid-row-v1:${captureId}`).slice(0, 16)}`;

/** A partly paid gift must not hide an unverified or failed line behind the word "Partly paid". The extra words name them. */
export function payoutLabel(trail: Trail): string {
  const base = PAYOUT_LABELS[trail.payout.status];
  if (trail.payout.status !== "PARTLY_PAID") return base;
  const count = (status: PayoutNoteStatus) => trail.lines.filter(line => line.payout === status).length;
  const unknown = count("UNKNOWN"); const attention = count("NEEDS_ATTENTION");
  return [base, ...(unknown ? [`${unknown} being verified`] : []), ...(attention ? [`${attention} ${plural(attention, "needs", "need")} attention`] : [])].join(", ");
}
function payoutDot(trail: Trail): PayoutDot {
  const lines = trail.lines;
  if (lines.some(line => line.payout === "UNKNOWN")) return "gx-dot-hold";
  if (lines.some(line => line.payout === "NEEDS_ATTENTION")) return "gx-dot-stop";
  return trail.payout.status === "PAID" ? "gx-dot-ok" : "gx-dot-idle";
}

/** Pure row mapper: the trail of one gift plus its donor name, fund label and masked capture become one grid row. */
export function mapDonationRow(captureId: string, effectiveOn: string, donorName: string | null | undefined, trail: Trail): DonationRow {
  const lineCount = trail.lines.length;
  const vendors = [...new Set(trail.lines.map(line => line.vendor))];
  const tails = [...new Set(trail.lines.flatMap(line => (line.payout === "PAID" && line.batchTail ? [line.batchTail] : [])))];
  return {
    id: rowKey(captureId),
    received: effectiveOn,
    donor: cleanText(donorName ?? "") || DEFAULT_DONOR_NAME,
    amountCents: trail.grossCents.toString(),
    fund: trail.gift.fundName,
    capture: maskTail(captureId) ?? "",
    state: TRAIL_STATE_LABELS[trail.state],
    matchedCents: trail.matchedCents.toString(),
    waitingCents: trail.unspentCents.toString(),
    lines: `${lineCount} ${plural(lineCount, "line", "lines")}`,
    linesTip: lineCount === 0 ? "No receipt line has matched this gift yet."
      : trail.lines.map(line => `${line.description}: ${line.share.replace(/^Your /, "")}`).join("\n"),
    vendor: vendors.length === 0 ? NONE_YET : vendors.length === 1 ? vendors[0]! : `${vendors.length} vendors`,
    vendorTip: vendors.length === 0 ? "No receipt line has matched this gift yet." : vendors.join("\n"),
    payoutStatus: payoutLabel(trail),
    payoutTip: PAYOUT_TIPS[trail.payout.status],
    payoutDot: payoutDot(trail),
    paypalReference: tails.length === 0 ? NONE_YET : tails.length === 1 ? tails[0]! : `${tails.length} batches`,
    paypalTip: tails.length === 0 ? "No verified PayPal payout batch exists for this gift yet." : `Batch IDs end with ${tails.join(", ")}. Only the last 6 characters are shown.`,
    verify: trail.lines.some(line => line.payout === "UNKNOWN"),
  };
}

export async function loadDonationsGrid(db: AppDatabase, actorId: string): Promise<DonationsGrid> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [actor] = await tx.select({ organizationId: s.users.organizationId, role: s.users.role }).from(s.users).where(eq(s.users.id, actorId));
    if (!actor || actor.role !== "APPROVER") throw new DonationsAccessError(403);
    const [organization] = await tx.select({ name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.id, actor.organizationId));

    // Every completed gift of this organization, newest first. Totals cover all of them; only the newest DONATIONS_ROW_CAP become rows.
    const facts = await loadGiftTrailFacts(tx, actor.organizationId, "ALL");
    let amount = 0n; let matched = 0n; let waiting = 0n;
    for (const gift of facts) {
      amount += gift.input.grossCents; waiting += gift.input.unspentCents;
      for (const application of gift.input.applications) matched += application.appliedCents;
    }
    const shown = facts.slice(0, DONATIONS_ROW_CAP);
    const captureIds = shown.map(gift => gift.captureId);
    const donors = captureIds.length ? await tx.select({ captureId: s.donationReceipts.captureId, displayName: s.donationOrders.displayName }).from(s.donationReceipts)
      .leftJoin(s.donationOrders, eq(s.donationOrders.orderId, s.donationReceipts.orderId))
      .where(and(eq(s.donationReceipts.organizationId, actor.organizationId), eq(s.donationReceipts.status, "COMPLETED"), inArray(s.donationReceipts.captureId, captureIds))) : [];
    const donorOf = new Map(donors.flatMap(row => (row.captureId ? [[row.captureId, row.displayName] as const] : [])));

    return {
      organization: organization?.name ?? "", observedAt: new Date().toISOString(),
      total: facts.length, capped: facts.length > DONATIONS_ROW_CAP,
      rows: shown.map(gift => mapDonationRow(gift.captureId, gift.input.effectiveOn, donorOf.get(gift.captureId), buildGiftTrail(gift.input))),
      totals: { amountCents: amount.toString(), matchedCents: matched.toString(), waitingCents: waiting.toString() },
    };
  }, { isolationLevel: "repeatable read" });
}
