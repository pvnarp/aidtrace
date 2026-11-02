import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { readGiftAttribution } from "./attribution-reader";
import { maskTail } from "./display";
import { cleanText, formatUsd, longDate, payoutNoteStatus, readGiftNotes, THANKS_FIRST_PAYOUT_WORDING, type PayoutNoteStatus } from "./note";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md sections 3 and 5.2): the donor gift trail read model.
// buildGiftTrail and donorPageSentence are pure: no clock, no database, no randomness. loadGiftTrailFacts and loadGiftPage issue
// SELECT statements only. Nothing here writes a row, posts a journal entry or calls PayPal, and no ledger writer or PayPal adapter
// is imported (a static test enforces it). Money is bigint integer cents end to end, never converted to a floating point value.
// Claim line descriptions and the vendor are typed by a claimant and are untrusted: only control characters are replaced and the
// length is clipped, and React escapes them on the page (scope section 3.5 and decision 7).
type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
type Db = AppDatabase | Tx;

export type TrailState = "WAITING" | "MATCHED" | "APPROVED" | "PAYING" | "PAID";
export interface TrailApplication {
  lineDescription: string; vendor: string; appliedCents: bigint; lineCents: bigint;
  approvalCount: number; payout: PayoutNoteStatus; batchId: string | null;
}
export interface TrailInput { grossCents: bigint; unspentCents: bigint; fundName: string; effectiveOn: string; applications: readonly TrailApplication[]; }
export type PayoutRollup = PayoutNoteStatus | "PARTLY_PAID";
export type StepState = "done" | "cur" | "fut";
export interface TrailStep { id: 1 | 2 | 3 | 4; state: StepState; title: string; detail: string }
export interface TrailLine {
  description: string; vendor: string; appliedCents: bigint; lineCents: bigint; share: string;
  payout: PayoutNoteStatus; payoutSentence: string; batchTail: string | null;
}
export interface Trail {
  state: TrailState; stateSentence: string;
  gift: { amount: string; fundName: string; received: string };
  steps: TrailStep[]; lines: TrailLine[];
  grossCents: bigint; matchedCents: bigint; unspentCents: bigint; waiting: string | null;
  payout: { status: PayoutRollup; paidLines: number; totalLines: number; batchTail: string | null };
}
// A drift in attribution (matched plus unspent is not the gross amount) or an impossible stored state fails closed.
export class TrailInvariantError extends Error {
  constructor(message: string) { super(message); this.name = "TrailInvariantError"; }
}

export const GIFT_STATE_SENTENCES: Record<TrailState, string> = {
  WAITING: "Your gift has arrived. It is waiting for a matching receipt.",
  MATCHED: "Your gift was applied to a receipt line. It is waiting for approvals.",
  APPROVED: "Your gift was applied to a receipt line and approved by two people.",
  PAYING: "Your gift was applied and approved by two people. The payout is not complete yet.",
  PAID: "Your gift was applied, approved by two people and paid through PayPal.",
};
// The owner-accepted method sentence of renderThanksFirst (src/donation/note.ts). A test keeps the two equal.
export const GIFT_METHOD_SENTENCE = "Gifts are applied to approved lines oldest first. This is a narrative, not a trace of a specific purchase.";
export const MAX_DESCRIPTION_CHARACTERS = 120;
export const MAX_VENDOR_CHARACTERS = 80;
const PRECEDENCE: readonly PayoutNoteStatus[] = ["UNKNOWN", "NEEDS_ATTENTION", "PROCESSING", "NO_PAYMENT"];

// Control characters become spaces (cleanText), then the text is clipped by code point so a pair is never split.
function clean(value: string, max: number, fallback: string): string {
  const characters = Array.from(cleanText(value));
  return (characters.length <= max ? characters.join("") : characters.slice(0, max).join("").trimEnd()) || fallback;
}

// The payout across lines. All PAID is PAID. Some PAID but not all is PARTLY_PAID. Otherwise the first status present in the order
// UNKNOWN, NEEDS_ATTENTION, PROCESSING, NO_PAYMENT wins, so an unverified outcome is never read as better than it is.
export function rollupPayout(statuses: readonly PayoutNoteStatus[]): PayoutRollup {
  if (statuses.length === 0) return "NO_PAYMENT";
  const paid = statuses.filter(status => status === "PAID").length;
  if (paid === statuses.length) return "PAID";
  if (paid > 0) return "PARTLY_PAID";
  return PRECEDENCE.find(status => statuses.includes(status)) ?? "NO_PAYMENT";
}

function payoutSentence(status: PayoutNoteStatus, batchTail: string | null): string {
  if (status !== "PAID") return THANKS_FIRST_PAYOUT_WORDING[status];
  return `Paid. PayPal payout batch ending ${batchTail}.`;
}

export function buildGiftTrail(input: TrailInput): Trail {
  const { grossCents, unspentCents, applications } = input;
  const matchedCents = applications.reduce((sum, row) => sum + row.appliedCents, 0n);
  if (grossCents <= 0n || unspentCents < 0n || applications.some(row => row.appliedCents <= 0n) || matchedCents + unspentCents !== grossCents) {
    throw new TrailInvariantError("Matched plus unspent cents must equal the gross cents of the gift");
  }
  const lines: TrailLine[] = applications.map(row => {
    if (row.payout === "PAID" && !row.batchId) throw new TrailInvariantError("A paid line needs a verified payout batch ID");
    const batchTail = row.payout === "PAID" ? maskTail(row.batchId) : null;
    return {
      description: clean(row.lineDescription, MAX_DESCRIPTION_CHARACTERS, "Receipt line"), vendor: clean(row.vendor, MAX_VENDOR_CHARACTERS, "A vendor"),
      appliedCents: row.appliedCents, lineCents: row.lineCents, payout: row.payout, batchTail,
      share: `Your ${formatUsd(row.appliedCents)} of the ${formatUsd(row.lineCents)} line`, payoutSentence: payoutSentence(row.payout, batchTail),
    };
  });
  const rollup = rollupPayout(applications.map(row => row.payout));
  const paidLines = applications.filter(row => row.payout === "PAID").length;
  const totalLines = applications.length;
  const approved = totalLines > 0 && applications.every(row => row.approvalCount >= 2);
  const matched = totalLines > 0;
  const amount = formatUsd(grossCents); const fundName = clean(input.fundName, MAX_VENDOR_CHARACTERS, "the fund"); const received = longDate(input.effectiveOn);

  let state: TrailState;
  if (!matched) state = "WAITING";
  else if (!approved) state = "MATCHED";
  else if (rollup === "NO_PAYMENT") state = "APPROVED";
  else if (rollup === "PAID") state = "PAID";
  else state = "PAYING";

  const vendors = [...new Set(lines.map(line => line.vendor))];
  const matchDetail = unspentCents > 0n ? `${formatUsd(matchedCents)} of ${amount} matched`
    : totalLines === 1 ? `1 receipt line from ${vendors[0]}`
      : vendors.length === 1 ? `${totalLines} receipt lines from ${vendors[0]}` : `${totalLines} receipt lines from ${vendors.length} vendors`;
  const step4Current: Record<Exclude<PayoutRollup, "PAID" | "NO_PAYMENT">, string> = {
    PROCESSING: "Processing", UNKNOWN: "Being verified", NEEDS_ATTENTION: "Needs attention", PARTLY_PAID: `Paid for ${paidLines} of ${totalLines} lines`,
  };
  const batchTail = rollup === "PAID" && totalLines === 1 ? lines[0]!.batchTail : null;
  const step4: TrailStep = !matched || !approved || rollup === "NO_PAYMENT" ? { id: 4, state: "fut", title: "Paid through PayPal", detail: "Not sent yet" }
    : rollup === "PAID" ? { id: 4, state: "done", title: "Paid through PayPal", detail: totalLines === 1 ? `Paid, batch ending ${batchTail}` : `Paid, all ${totalLines} lines` }
      : { id: 4, state: "cur", title: "Paid through PayPal", detail: step4Current[rollup] };
  const steps: TrailStep[] = [
    { id: 1, state: "done", title: "Gift received", detail: `${amount} to ${fundName}, ${received}` },
    matched ? { id: 2, state: "done", title: "Matched to a receipt", detail: matchDetail } : { id: 2, state: "cur", title: "Matched to a receipt", detail: "Waiting for a matching receipt" },
    !matched ? { id: 3, state: "fut", title: "Approved by two people", detail: "Not started" }
      : approved ? { id: 3, state: "done", title: "Approved by two people", detail: "Two people approved" } : { id: 3, state: "cur", title: "Approved by two people", detail: "Waiting for approvals" },
    step4,
  ];
  const waiting = unspentCents > 0n ? `Still waiting: ${formatUsd(unspentCents)} of your gift has no matching receipt yet.` : null;
  return {
    state, stateSentence: GIFT_STATE_SENTENCES[state], gift: { amount, fundName, received }, steps, lines,
    grossCents, matchedCents, unspentCents, waiting, payout: { status: rollup, paidLines, totalLines, batchTail },
  };
}

// The facts-built sentence for the note panel. It names no person: not the donor, the claimant or either approver. The stored note
// text is never used because it names the approvers (scope section 8, decision 1). Null until every applied line is approved.
export function donorPageSentence(trail: Trail): string | null {
  if (trail.state === "WAITING" || trail.state === "MATCHED" || trail.lines.length === 0) return null;
  const applied = trail.lines.map(line => `${line.description} from ${line.vendor}: ${line.share.replace(/^Your /, "")}`).join("; ");
  const opening = trail.unspentCents > 0n ? `Part of your ${trail.gift.amount} gift was applied to` : `Your ${trail.gift.amount} gift was applied to`;
  const { status, paidLines, totalLines } = trail.payout;
  const payout = status === "PAID" ? (totalLines === 1 ? trail.lines[0]!.payoutSentence : `Paid. All ${totalLines} lines were paid.`)
    : status === "PARTLY_PAID" ? `Paid for ${paidLines} of ${totalLines} lines.` : THANKS_FIRST_PAYOUT_WORDING[status];
  return `${opening} ${applied}. Two people approved it. ${payout}`;
}

// ---- Facts loader (SELECT only, set based) ----
export interface GiftTrailFacts {
  captureId: string; organizationId: string; input: TrailInput;
  // The recognized claim versions the gift was applied to. Internal: used to look up current notes, never rendered.
  claims: { claimId: string; claimVersion: number }[];
}
const pair = (claimId: string, claimVersion: number) => JSON.stringify([claimId, claimVersion]);

// One attribution read, then one query each for receipts, funds, claims, lines, decisions, approvals, disbursements and attempts,
// for one capture, a list of captures or every completed gift of the organization. Newest gift first.
export async function loadGiftTrailFacts(db: Db, organizationId: string, captureIds: readonly string[] | "ALL"): Promise<GiftTrailFacts[]> {
  if (captureIds !== "ALL" && captureIds.length === 0) return [];
  const receipts = await db.select().from(s.donationReceipts).where(and(eq(s.donationReceipts.organizationId, organizationId), eq(s.donationReceipts.status, "COMPLETED"),
    ...(captureIds === "ALL" ? [] : [inArray(s.donationReceipts.captureId, [...captureIds])]))).orderBy(desc(s.donationReceipts.recordedAt), desc(s.donationReceipts.captureId));
  if (receipts.length === 0) return [];
  const attribution = await readGiftAttribution(db, organizationId);
  const wanted = new Set(receipts.map(row => row.captureId));
  const applications = attribution.applications.filter(row => wanted.has(row.captureId));
  const claimIds = [...new Set(applications.map(row => row.claimId))];
  const funds = await db.select({ id: s.funds.id, name: s.funds.name }).from(s.funds).where(eq(s.funds.organizationId, organizationId));
  const claims = claimIds.length ? await db.select({ id: s.claims.id, version: s.claims.version, vendor: s.claims.vendor, status: s.claims.status }).from(s.claims)
    .where(and(eq(s.claims.organizationId, organizationId), inArray(s.claims.id, claimIds))) : [];
  const lines = claimIds.length ? await db.select({ claimId: s.claimLines.claimId, claimVersion: s.claimLines.claimVersion, id: s.claimLines.id, description: s.claimLines.description, amountCents: s.claimLines.amountCents })
    .from(s.claimLines).where(inArray(s.claimLines.claimId, claimIds)) : [];
  // The latest recognized, non-invalidated decision of each claim version, as buildNoteFacts reads it.
  const decisionRows = claimIds.length ? await db.select({ claimId: s.allocationDecisions.claimId, claimVersion: s.allocationDecisions.claimVersion, decisionHash: s.allocationDecisions.decisionHash,
    recognizedAt: s.allocationDecisions.recognizedAt, invalidatedAt: s.allocationDecisions.invalidatedAt }).from(s.allocationDecisions)
    .where(and(eq(s.allocationDecisions.organizationId, organizationId), inArray(s.allocationDecisions.claimId, claimIds))).orderBy(desc(s.allocationDecisions.recognizedAt)) : [];
  const decisionHash = new Map<string, string>();
  for (const row of decisionRows) if (row.recognizedAt !== null && row.invalidatedAt === null && !decisionHash.has(pair(row.claimId, row.claimVersion))) decisionHash.set(pair(row.claimId, row.claimVersion), row.decisionHash);
  const hashes = [...new Set(decisionHash.values())];
  const approvalRows = hashes.length ? await db.select({ decisionHash: s.approvals.decisionHash, count: sql<number>`count(*)::int` }).from(s.approvals)
    .where(inArray(s.approvals.decisionHash, hashes)).groupBy(s.approvals.decisionHash) : [];
  const approvalCount = new Map(approvalRows.map(row => [row.decisionHash, row.count]));
  const disbursementRows = claimIds.length ? await db.select({ id: s.disbursements.id, claimId: s.disbursements.claimId, claimVersion: s.disbursements.claimVersion }).from(s.disbursements)
    .where(inArray(s.disbursements.claimId, claimIds)) : [];
  const attemptRows = disbursementRows.length ? await db.select({ disbursementId: s.disbursementAttempts.disbursementId, state: s.disbursementAttempts.state, itemStatus: s.disbursementAttempts.itemStatus,
    payoutBatchId: s.disbursementAttempts.payoutBatchId }).from(s.disbursementAttempts)
    .where(inArray(s.disbursementAttempts.disbursementId, disbursementRows.map(row => row.id))).orderBy(desc(s.disbursementAttempts.attemptNumber)) : [];
  const latestAttempt = new Map<string, (typeof attemptRows)[number]>();
  for (const row of attemptRows) if (!latestAttempt.has(row.disbursementId)) latestAttempt.set(row.disbursementId, row);

  const payoutOf = (claimId: string, claimVersion: number) => {
    const claim = claims.find(row => row.id === claimId && row.version === claimVersion);
    if (!claim) throw new TrailInvariantError("An applied claim version must exist");
    const disbursement = disbursementRows.find(row => row.claimId === claimId && row.claimVersion === claimVersion);
    return { vendor: claim.vendor, ...payoutNoteStatus(disbursement ? latestAttempt.get(disbursement.id) ?? null : null, claim.status) };
  };
  return receipts.map(receipt => {
    const mine = applications.filter(row => row.captureId === receipt.captureId);
    if (receipt.grossCents === null || !receipt.effectiveOn || !receipt.captureId) throw new TrailInvariantError("A completed gift needs a capture ID, an amount and a date");
    const unspent = attribution.unspent.find(row => row.captureId === receipt.captureId)?.remainingCents ?? 0n;
    return {
      captureId: receipt.captureId, organizationId,
      claims: [...new Map(mine.map(row => [pair(row.claimId, row.claimVersion), { claimId: row.claimId, claimVersion: row.claimVersion }])).values()],
      input: {
        grossCents: receipt.grossCents, unspentCents: unspent, fundName: funds.find(fund => fund.id === receipt.fundId)?.name ?? "the fund", effectiveOn: receipt.effectiveOn,
        applications: mine.map(row => {
          const line = lines.find(item => item.claimId === row.claimId && item.claimVersion === row.claimVersion && item.id === row.lineId);
          if (!line) throw new TrailInvariantError("An applied line must belong to the claim version");
          const payout = payoutOf(row.claimId, row.claimVersion);
          const hash = decisionHash.get(pair(row.claimId, row.claimVersion));
          return { lineDescription: line.description, vendor: payout.vendor, appliedCents: row.appliedCents, lineCents: line.amountCents,
            approvalCount: hash ? approvalCount.get(hash) ?? 0 : 0, payout: payout.status, batchId: payout.batchId };
        }),
      },
    };
  });
}

// ---- The public page's data: one gift, one read-only transaction ----
export interface GiftPageData {
  trail: Trail;
  // Present only when every applied claim version has a current approved note (scope section 3.2). Never the stored note text.
  note: { sentence: string; organizationName: string } | null;
}
// Null when the capture is not a completed gift. Throws TrailInvariantError when the stored facts cannot be shown honestly.
export async function loadGiftPage(db: AppDatabase, captureId: string): Promise<GiftPageData | null> {
  return db.transaction(async tx => {
    await tx.execute(sql`set transaction read only`);
    const [receipt] = await tx.select({ organizationId: s.donationReceipts.organizationId }).from(s.donationReceipts)
      .where(and(eq(s.donationReceipts.captureId, captureId), eq(s.donationReceipts.status, "COMPLETED"))).limit(1);
    if (!receipt) return null;
    const [facts] = await loadGiftTrailFacts(tx, receipt.organizationId, [captureId]);
    if (!facts) return null;
    const trail = buildGiftTrail(facts.input);
    const sentence = donorPageSentence(trail);
    let note: GiftPageData["note"] = null;
    if (sentence && facts.claims.length > 0) {
      let everyCurrent = true;
      for (const claim of facts.claims) {
        const entry = (await readGiftNotes(tx, receipt.organizationId, claim.claimId, claim.claimVersion)).find(row => row.captureId === captureId);
        if (!entry?.approvedCurrent) { everyCurrent = false; break; }
      }
      if (everyCurrent) {
        const [organization] = await tx.select({ name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.id, receipt.organizationId)).limit(1);
        note = { sentence, organizationName: clean(organization?.name ?? "", MAX_VENDOR_CHARACTERS, "the organization") };
      }
    }
    return { trail, note };
  }, { isolationLevel: "repeatable read" });
}
