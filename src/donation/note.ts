import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import * as s from "../../db/schema";
import type { AppDatabase } from "../server/db";
import type { LedgerTransaction } from "../ledger/journal";
import { GIFT_ATTRIBUTION_POLICY, type AttributionResult, type GiftApplication } from "./attribution";
import { readGiftAttribution } from "./attribution-reader";

// IAC-379 step 3b: the deterministic template donor impact note.
// The facts loader and the renderer issue SELECT statements and compute text only. Nothing here writes a row, posts a
// journal entry, calls PayPal or calls a model. The approval write lives in note-approval.ts.
// Claim line descriptions, the vendor and the donor's typed display name are untrusted text. They are carried as data:
// only control characters (which could forge extra lines in a plain-text download) are replaced, and nothing is parsed,
// interpreted or turned into markup. React escapes them on the page and the download is served as text/plain.
export const NOTE_FACT_SET = "donor-note-facts-v1" as const;
export const TEMPLATE_LABEL = "Template, no AI used";
export const DEFAULT_DONOR_NAME = "A donor";
// Step 4 adds the AI selection on top of this seam: it may choose up to two optional facts and one of the fixed template IDs.
// IAC-379 Option A: "thanks-first" is the default for new notes. "default" stays renderable so stored notes still display.
export const NOTE_TEMPLATE_IDS = ["default", "thanks-first"] as const;
export const OPTIONAL_FACT_IDS = ["fund-policy", "claim-total", "method"] as const;
export type OptionalFactId = (typeof OPTIONAL_FACT_IDS)[number];
export interface NoteSelection { templateId: string; optional: readonly string[] }
export const DEFAULT_SELECTION: NoteSelection = { templateId: "thanks-first", optional: [] };

type Db = AppDatabase | LedgerTransaction;
export type PayoutNoteStatus = s.GiftPayoutStatus;
export interface NoteFacts {
  version: typeof NOTE_FACT_SET;
  gift: { donorName: string; amountCents: string; fundName: string; capturedOn: string };
  lines: { lineId: string; description: string; lineAmountCents: string; appliedCents: string; vendor: string }[];
  approvals: { name: string; approvedOn: string }[];
  payout: { status: PayoutNoteStatus; batchId: string | null };
  optional: {
    "fund-policy": { fundName: string; summary: string };
    "claim-total": { totalCents: string; split: { fundName: string; amountCents: string }[] };
    method: { policy: typeof GIFT_ATTRIBUTION_POLICY };
  };
}
export type NoteRefusal = "CLAIM_NOT_FOUND" | "CLAIM_REJECTED" | "CLAIM_NOT_RECOGNIZED" | "GIFT_NOT_FOUND" | "NO_ATTRIBUTION" | "APPROVALS_INCOMPLETE";
export type NoteFactsResult =
  | { ok: true; facts: NoteFacts; applications: GiftApplication[]; decisionHash: string }
  | { ok: false; refusal: NoteRefusal };

// ---- Payout wording (scope section 6 table), from the stored disbursement attempt only ----
export interface PayoutAttemptView { state: string; itemStatus: string | null; payoutBatchId: string | null }
const SAFE_BATCH_ID = /^[A-Za-z0-9_-]{1,64}$/;
// Pure. The cautious reading wins whenever a stored state does not fit a row cleanly:
// "Paid" needs a SETTLED attempt, which the ledger writes only after an independently fetched item reports SUCCESS, and a
// usable PayPal batch ID. An attempt with no stored state we know, or a claim already past APPROVED with no attempt row, reads
// as "outcome being verified", never as paid and never as "no payment".
export function payoutNoteStatus(attempt: PayoutAttemptView | null, claimStatus?: string): { status: PayoutNoteStatus; batchId: string | null } {
  if (!attempt) return { status: ["PAID", "PAYOUT_PROCESSING", "PAYOUT_ISSUE"].includes(claimStatus ?? "") ? "UNKNOWN" : "NO_PAYMENT", batchId: null };
  switch (attempt.state) {
    case "SETTLED":
      return attempt.itemStatus === "SUCCESS" && attempt.payoutBatchId !== null && SAFE_BATCH_ID.test(attempt.payoutBatchId)
        ? { status: "PAID", batchId: attempt.payoutBatchId } : { status: "UNKNOWN", batchId: null };
    case "SUBMITTED": case "PENDING": case "HELD": return { status: "PROCESSING", batchId: null };
    case "FAILED": case "MANUAL_REVIEW": case "FUNDING_REJECTED": return { status: "NEEDS_ATTENTION", batchId: null };
    default: return { status: "UNKNOWN", batchId: null };
  }
}
export const PAYOUT_WORDING: Record<Exclude<PayoutNoteStatus, "NO_PAYMENT" | "PAID">, string> = {
  PROCESSING: "Approved. PayPal payout is processing.",
  UNKNOWN: "Approved. The PayPal payout outcome is being verified.",
  NEEDS_ATTENTION: "Approved. The payout needs attention.",
};
// IAC-379 Option A: the "thanks-first" payout sentences. The approval sentence precedes them, so there is no
// "Approved." prefix, and none names a provider because the note facts carry a status and a batch ID, not a provider. PAID is built by paidSentence.
export const THANKS_FIRST_PAYOUT_WORDING: Record<Exclude<PayoutNoteStatus, "PAID">, string> = {
  NO_PAYMENT: "No payment has been sent in this environment.",
  PROCESSING: "The payout is processing.",
  UNKNOWN: "The payout outcome is being verified.",
  NEEDS_ATTENTION: "The payout needs attention.",
};
const paidSentence = (batchId: string | null) => {
  if (!batchId || !SAFE_BATCH_ID.test(batchId)) throw new Error("A paid note needs a verified PayPal payout batch ID");
  return `Paid. Payout batch ${batchId}.`;
};

// ---- Formatting: integer cents only, no floating point ----
export function formatUsd(cents: bigint): string {
  const negative = cents < 0n; const value = negative ? -cents : cents;
  const dollars = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${dollars}.${(value % 100n).toString().padStart(2, "0")}`;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function longDate(isoDate: string): string {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const month = found ? Number(found[2]) : 0;
  if (!found || month < 1 || month > 12) throw new Error("A calendar date as YYYY-MM-DD is required");
  return `${MONTHS[month - 1]} ${Number(found[3])}, ${found[1]}`;
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Control characters, line and paragraph separators, and bidirectional controls become one space. Everything else is kept.
export const cleanText = (value: string) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+/gu, " ").trim();
const sentence = (value: string) => /[.!?]$/.test(value) ? value : `${value}.`;
const joinNames = (names: string[]) => names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export function factDigest(facts: NoteFacts): string {
  const canonical = canonicalize(facts);
  if (canonical === undefined) throw new Error("Note facts could not be canonicalized");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
export const noteTextHash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function validateSelection(selection: NoteSelection): void {
  if (!selection || typeof selection.templateId !== "string" || !(NOTE_TEMPLATE_IDS as readonly string[]).includes(selection.templateId)) throw new Error("Unknown note template");
  if (!Array.isArray(selection.optional) || selection.optional.length > 2 || new Set(selection.optional).size !== selection.optional.length
    || selection.optional.some(id => !(OPTIONAL_FACT_IDS as readonly string[]).includes(id))) throw new Error("Optional facts must be at most two distinct known fact IDs");
}

// The Option A template. It is the run 3 candidate "thanks-first" of scripts/support/donor-note-eval.ts
// except for the payout sentence, and tests prove that equality. Optional facts are written in OPTIONAL_FACT_IDS order, as in that candidate.
// The shares line of the page is built from the same current facts, never from this text.
function renderThanksFirst(facts: NoteFacts, selection: NoteSelection): string {
  const { gift, lines, approvals, payout } = facts;
  const vendor = lines[0]!.vendor;
  const applied = lines.length === 1 ? `${lines[0]!.description} from ${vendor}` : `${lines.length} receipt lines from ${vendor}: ${joinNames(lines.map(line => line.description))}`;
  const optional: string[] = [];
  for (const id of OPTIONAL_FACT_IDS.filter(known => selection.optional.includes(known))) {
    if (id === "fund-policy") {
      const policy = facts.optional["fund-policy"];
      if (policy.summary) optional.push(sentence(`${policy.fundName} restriction: ${policy.summary}`));
    } else if (id === "claim-total") {
      const total = facts.optional["claim-total"]; const amount = formatUsd(BigInt(total.totalCents));
      optional.push(sentence(total.split.length === 1 ? `The full receipt was ${amount}, all from ${total.split[0]!.fundName}`
        : `The full receipt was ${amount}: ${total.split.map(row => `${row.fundName} ${formatUsd(BigInt(row.amountCents))}`).join(", ")}`));
    } else optional.push("Gifts are applied to approved lines oldest first. This is a narrative, not a trace of a specific purchase.");
  }
  const dates = [...new Set(approvals.map(row => row.approvedOn))];
  const approvedBy = dates.length === 1 ? `${joinNames(approvals.map(row => row.name))} on ${longDate(dates[0]!)}` : joinNames(approvals.map(row => `${row.name} on ${longDate(row.approvedOn)}`));
  const payoutSentence = payout.status === "PAID" ? paidSentence(payout.batchId) : THANKS_FIRST_PAYOUT_WORDING[payout.status];
  return [sentence(`Thank you, ${gift.donorName}`), sentence(`Your ${formatUsd(BigInt(gift.amountCents))} gift was applied to ${applied}`), ...optional, sentence(`Approved by ${approvedBy}`), payoutSentence].join(" ");
}

// "$25.00 of the $280.00 line", or per line "{description}: $x of the $y line" joined by "; " (integer cents only).
export function formatShares(shares: readonly { description: string; appliedCents: bigint; lineCents: bigint }[]): string {
  const part = (row: { appliedCents: bigint; lineCents: bigint }) => `${formatUsd(row.appliedCents)} of the ${formatUsd(row.lineCents)} line`;
  return shares.length === 1 ? part(shares[0]!) : shares.map(row => `${row.description}: ${part(row)}`).join("; ");
}

// Pure and deterministic: the same facts and selection always give the same text. The server writes every number and name.
// The label "Template, no AI used" is shown beside a TEMPLATE note and is not part of this text or its hash.
export function renderTemplateNote(facts: NoteFacts, selection: NoteSelection = DEFAULT_SELECTION): string {
  validateSelection(selection);
  if (facts.version !== NOTE_FACT_SET || facts.lines.length === 0 || facts.approvals.length === 0) throw new Error("Complete donor note facts are required");
  if (selection.templateId === "thanks-first") return renderThanksFirst(facts, selection);
  const { gift, lines, approvals, payout } = facts;
  const vendor = lines[0]!.vendor;
  const share = (line: NoteFacts["lines"][number]) => `${formatUsd(BigInt(line.appliedCents))} of the ${formatUsd(BigInt(line.lineAmountCents))} line`;
  const appliedTo = lines.length === 1 ? `${lines[0]!.description} from ${vendor}: ${share(lines[0]!)}`
    : `${lines.length} receipt lines from ${vendor}: ${lines.map(line => `${line.description}, ${share(line)}`).join("; ")}`;
  const parts = [`Thank you, ${gift.donorName}.`, `Your gift of ${formatUsd(BigInt(gift.amountCents))} to ${gift.fundName} on ${longDate(gift.capturedOn)} was applied to ${appliedTo}.`];
  if (selection.optional.includes("fund-policy") && facts.optional["fund-policy"].summary) parts.push(`Restriction on ${facts.optional["fund-policy"].fundName}: ${sentence(facts.optional["fund-policy"].summary)}`);
  if (selection.optional.includes("claim-total")) {
    const total = facts.optional["claim-total"];
    parts.push(`The receipt total is ${formatUsd(BigInt(total.totalCents))}, split as ${total.split.map(row => `${row.fundName} ${formatUsd(BigInt(row.amountCents))}`).join(", ")}.`);
  }
  if (selection.optional.includes("method")) parts.push(`Method: ${facts.optional.method.policy} applies gifts to approved receipt lines, oldest gift first. It is a narrative, not an accounting method, and it does not trace a gift to a specific purchase.`);
  const dates = [...new Set(approvals.map(row => row.approvedOn))];
  const approvedBy = dates.length === 1 ? `${joinNames(approvals.map(row => row.name))} on ${longDate(dates[0]!)}` : joinNames(approvals.map(row => `${row.name} on ${longDate(row.approvedOn)}`));
  if (payout.status === "NO_PAYMENT") parts.push(`Approved by ${approvedBy}. No payment has been sent in this environment.`);
  else {
    parts.push(`Two approvers, ${approvedBy}, signed off.`);
    if (payout.status === "PAID") {
      if (!payout.batchId || !SAFE_BATCH_ID.test(payout.batchId)) throw new Error("A paid note needs a verified PayPal payout batch ID");
      parts.push(`Paid. PayPal payout batch ${payout.batchId}.`);
    } else parts.push(PAYOUT_WORDING[payout.status]);
  }
  return parts.join(" ");
}

// ---- Facts loader (SELECT only) ----
const refuse = (refusal: NoteRefusal): NoteFactsResult => ({ ok: false, refusal });
// A typed refusal, never a throw, for every state that cannot yield a note. `attribution` may be passed to avoid rereading it.
export async function buildNoteFacts(db: Db, organizationId: string, captureId: string, claimId: string, claimVersion: number, attribution?: AttributionResult): Promise<NoteFactsResult> {
  const [claim] = await db.select().from(s.claims).where(and(eq(s.claims.id, claimId), eq(s.claims.version, claimVersion)));
  if (!claim || claim.organizationId !== organizationId) return refuse("CLAIM_NOT_FOUND");
  const [rejection] = await db.select({ id: s.claimRejections.id }).from(s.claimRejections).where(and(eq(s.claimRejections.claimId, claimId), eq(s.claimRejections.claimVersion, claimVersion)));
  if (rejection) return refuse("CLAIM_REJECTED");
  const [decision] = await db.select().from(s.allocationDecisions).where(and(eq(s.allocationDecisions.claimId, claimId), eq(s.allocationDecisions.claimVersion, claimVersion), eq(s.allocationDecisions.organizationId, organizationId),
    isNotNull(s.allocationDecisions.recognizedAt), isNull(s.allocationDecisions.invalidatedAt))).orderBy(desc(s.allocationDecisions.recognizedAt)).limit(1);
  if (!decision) return refuse("CLAIM_NOT_RECOGNIZED");
  const [receipt] = await db.select().from(s.donationReceipts).where(and(eq(s.donationReceipts.captureId, captureId), eq(s.donationReceipts.organizationId, organizationId), eq(s.donationReceipts.status, "COMPLETED")));
  if (!receipt || receipt.grossCents === null || !receipt.effectiveOn) return refuse("GIFT_NOT_FOUND");
  const result = attribution ?? await readGiftAttribution(db, organizationId);
  const applications = result.applications.filter(row => row.captureId === captureId && row.claimId === claimId && row.claimVersion === claimVersion);
  if (applications.length === 0) return refuse("NO_ATTRIBUTION");

  const lines = await db.select().from(s.claimLines).where(and(eq(s.claimLines.claimId, claimId), eq(s.claimLines.claimVersion, claimVersion)));
  const funds = await db.select().from(s.funds).where(eq(s.funds.organizationId, organizationId));
  const fundName = (id: string) => funds.find(fund => fund.id === id)?.name ?? id;
  const approvalRows = await db.select({ name: s.users.displayName, approvedAt: s.approvals.approvedAt, approverId: s.approvals.approverId }).from(s.approvals)
    .innerJoin(s.users, eq(s.users.id, s.approvals.approverId)).where(eq(s.approvals.decisionHash, decision.decisionHash)).orderBy(asc(s.approvals.approvedAt), asc(s.approvals.approverId));
  if (approvalRows.length < 2) return refuse("APPROVALS_INCOMPLETE");
  const [order] = await db.select({ displayName: s.donationOrders.displayName }).from(s.donationOrders).where(eq(s.donationOrders.orderId, receipt.orderId));
  const [disbursement] = await db.select({ id: s.disbursements.id }).from(s.disbursements).where(and(eq(s.disbursements.claimId, claimId), eq(s.disbursements.claimVersion, claimVersion)));
  const [attempt] = disbursement ? await db.select({ state: s.disbursementAttempts.state, itemStatus: s.disbursementAttempts.itemStatus, payoutBatchId: s.disbursementAttempts.payoutBatchId })
    .from(s.disbursementAttempts).where(eq(s.disbursementAttempts.disbursementId, disbursement.id)).orderBy(desc(s.disbursementAttempts.attemptNumber)).limit(1) : [];
  const edges = await db.select().from(s.allocationEdges).where(eq(s.allocationEdges.decisionId, decision.id));
  const giftFund = receipt.fundId;
  const giftEdge = edges.find(edge => edge.fundId === giftFund);
  const [policy] = giftEdge ? await db.select().from(s.fundPolicyVersions).where(and(eq(s.fundPolicyVersions.fundId, giftFund), eq(s.fundPolicyVersions.version, giftEdge.policyVersion))) : [];
  const split = new Map<string, bigint>();
  for (const edge of edges) split.set(edge.fundId, (split.get(edge.fundId) ?? 0n) + edge.amountCents);

  const noteLines = applications.map(row => {
    const line = lines.find(item => item.id === row.lineId);
    if (!line) throw new Error("An applied line must belong to the claim version");
    return { lineId: row.lineId, description: cleanText(line.description), lineAmountCents: line.amountCents.toString(), appliedCents: row.appliedCents.toString(), vendor: cleanText(claim.vendor) };
  }).sort((a, b) => compareText(a.lineId, b.lineId));
  const donorName = cleanText(order?.displayName ?? "");
  const paid = payoutNoteStatus(attempt ?? null, claim.status);
  const facts: NoteFacts = {
    version: NOTE_FACT_SET,
    gift: { donorName: donorName || DEFAULT_DONOR_NAME, amountCents: receipt.grossCents.toString(), fundName: cleanText(fundName(giftFund)), capturedOn: receipt.effectiveOn },
    lines: noteLines,
    approvals: approvalRows.map(row => ({ name: cleanText(row.name), approvedOn: row.approvedAt.toISOString().slice(0, 10) })),
    payout: { status: paid.status, batchId: paid.batchId },
    optional: {
      "fund-policy": { fundName: cleanText(fundName(giftFund)), summary: cleanText(policy?.summary ?? "") },
      "claim-total": { totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0n).toString(), split: [...split].sort((a, b) => compareText(a[0], b[0])).map(([id, cents]) => ({ fundName: cleanText(fundName(id)), amountCents: cents.toString() })) },
      method: { policy: GIFT_ATTRIBUTION_POLICY },
    },
  };
  return { ok: true, facts, applications, decisionHash: decision.decisionHash };
}

// ---- Read model for the claim page and the download (SELECT only) ----
export interface StoredGiftNote {
  id: string; captureId: string; claimId: string; claimVersion: number; factDigest: string; templateId: string; optionalFactIds: string[]; renderedText: string; mode: "TEMPLATE" | "AI";
  approverId: string; approverName: string; approvedAt: Date; payoutStatus: PayoutNoteStatus;
  // Computed now, never stored: true when the current facts or payout status differ from what was approved.
  stale: boolean;
}
export interface GiftNoteEntry {
  captureId: string; fundName: string; giftCents: bigint; draftText: string; draftDigest: string; payoutStatus: PayoutNoteStatus;
  // From the same current facts as the draft, for the meta line: the applied share of each line and the gift capture date (YYYY-MM-DD).
  shares: { description: string; appliedCents: bigint; lineCents: bigint }[]; capturedOn: string;
  // A stored note whose digest equals the current digest exists, so no new approval is offered.
  approvedCurrent: boolean; notes: StoredGiftNote[];
}
async function storedNotes(db: Db, captureId: string, claimId: string, claimVersion: number) {
  return db.select({ note: s.giftNotes, approverName: s.users.displayName }).from(s.giftNotes).innerJoin(s.users, eq(s.users.id, s.giftNotes.approverId))
    .where(and(eq(s.giftNotes.captureId, captureId), eq(s.giftNotes.claimId, claimId), eq(s.giftNotes.claimVersion, claimVersion))).orderBy(desc(s.giftNotes.approvedAt), desc(s.giftNotes.id));
}
function stored(row: Awaited<ReturnType<typeof storedNotes>>[number], current: { digest: string; payoutStatus: PayoutNoteStatus } | null): StoredGiftNote {
  const { note } = row;
  return { id: note.id, captureId: note.captureId, claimId: note.claimId, claimVersion: note.claimVersion, factDigest: note.factDigest, templateId: note.templateId, optionalFactIds: note.optionalFactIds,
    renderedText: note.renderedText, mode: note.mode, approverId: note.approverId, approverName: row.approverName, approvedAt: note.approvedAt, payoutStatus: note.payoutStatus,
    // If the facts can no longer be built, nothing can confirm the note is current, so it reads as out of date.
    stale: !current || current.digest !== note.factDigest || current.payoutStatus !== note.payoutStatus };
}
// One entry per gift applied to this recognized claim version. A claim with no applied gift returns an empty list.
export async function readGiftNotes(db: Db, organizationId: string, claimId: string, claimVersion: number): Promise<GiftNoteEntry[]> {
  const attribution = await readGiftAttribution(db, organizationId);
  const captureIds = [...new Set(attribution.applications.filter(row => row.claimId === claimId && row.claimVersion === claimVersion).map(row => row.captureId))].sort(compareText);
  const entries: GiftNoteEntry[] = [];
  for (const captureId of captureIds) {
    const built = await buildNoteFacts(db, organizationId, captureId, claimId, claimVersion, attribution);
    if (!built.ok) continue;
    const digest = factDigest(built.facts);
    const notes = (await storedNotes(db, captureId, claimId, claimVersion)).map(row => stored(row, { digest, payoutStatus: built.facts.payout.status }));
    entries.push({ captureId, fundName: built.facts.gift.fundName, giftCents: BigInt(built.facts.gift.amountCents), draftText: renderTemplateNote(built.facts), draftDigest: digest,
      payoutStatus: built.facts.payout.status, shares: built.facts.lines.map(line => ({ description: line.description, appliedCents: BigInt(line.appliedCents), lineCents: BigInt(line.lineAmountCents) })),
      capturedOn: built.facts.gift.capturedOn, approvedCurrent: notes.some(note => !note.stale), notes });
  }
  return entries;
}
// One approved note by ID, with its staleness, for the download. The caller checks organization and claimant access.
export async function readGiftNoteById(db: Db, noteId: string): Promise<{ note: StoredGiftNote; organizationId: string; claimantId: string } | null> {
  const [row] = await db.select({ note: s.giftNotes, approverName: s.users.displayName, organizationId: s.claims.organizationId, claimantId: s.claims.claimantId }).from(s.giftNotes)
    .innerJoin(s.users, eq(s.users.id, s.giftNotes.approverId))
    .innerJoin(s.claims, and(eq(s.claims.id, s.giftNotes.claimId), eq(s.claims.version, s.giftNotes.claimVersion))).where(eq(s.giftNotes.id, noteId));
  if (!row) return null;
  const built = await buildNoteFacts(db, row.organizationId, row.note.captureId, row.note.claimId, row.note.claimVersion);
  return { note: stored({ note: row.note, approverName: row.approverName }, built.ok ? { digest: factDigest(built.facts), payoutStatus: built.facts.payout.status } : null), organizationId: row.organizationId, claimantId: row.claimantId };
}
