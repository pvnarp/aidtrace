import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProposalResult, ProposalState } from "../src/proposal/types";

const recordedAt = () => timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow();
const cents = (name = "amount_cents") => bigint(name, { mode: "bigint" }).notNull();
export const userRole = pgEnum("user_role", ["CLAIMANT", "APPROVER"]);
export const fundClass = pgEnum("fund_class", ["RESTRICTED", "UNRESTRICTED"]);
export const sourceType = pgEnum("source_type", ["fixture_opening_balance", "claim_recognition", "paypal_capture", "paypal_payout_item"]);
export const claimStatus = pgEnum("claim_status", ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "PAYOUT_PROCESSING", "PAID", "REJECTED", "PAYOUT_ISSUE"]);
export const reservationStatus = pgEnum("reservation_status", ["ACTIVE", "RELEASED", "CONSUMED"]);

export const organizations = pgTable("organizations", {
  id: text().primaryKey(), name: text().notNull(), prohibitedCategories: jsonb("prohibited_categories").$type<string[]>().notNull(),
  isFixture: boolean("is_fixture").notNull().default(true), openingSourceType: sourceType("opening_source_type").notNull(),
}, t => [check("organization_opening_source", sql`${t.openingSourceType} in ('fixture_opening_balance', 'paypal_capture')`)]);

export const users = pgTable("users", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  username: text().notNull().unique(), displayName: text("display_name").notNull(), role: userRole().notNull(), passwordHash: text("password_hash").notNull(),
  isFixture: boolean("is_fixture").notNull().default(true),
});

export const funds = pgTable("funds", {
  id: text().primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  name: text().notNull(), fundClass: fundClass("fund_class").notNull(), currentPolicyVersion: integer("current_policy_version").notNull(),
  isFixture: boolean("is_fixture").notNull().default(true),
}, t => [check("fund_policy_version_positive", sql`${t.currentPolicyVersion} > 0`)]);

export const fundPolicyVersions = pgTable("fund_policy_versions", {
  fundId: text("fund_id").notNull().references(() => funds.id), version: integer().notNull(),
  approvedBy: text("approved_by").notNull().references(() => users.id), approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  programs: jsonb().$type<string[] | null>(), allowedCategories: jsonb("allowed_categories").$type<string[] | null>(),
  periodStart: date("period_start"), periodEnd: date("period_end"), breadth: integer(), summary: text().notNull(),
}, t => [primaryKey({ columns: [t.fundId, t.version] }), check("policy_version_positive", sql`${t.version} > 0`),
  check("policy_period_valid", sql`(${t.periodStart} is null and ${t.periodEnd} is null) or (${t.periodStart} is not null and ${t.periodEnd} is not null and ${t.periodStart} <= ${t.periodEnd})`),
  check("policy_breadth_positive", sql`${t.breadth} is null or ${t.breadth} > 0`)]);

export const fundBudgetLines = pgTable("fund_budget_lines", {
  fundId: text("fund_id").notNull(), policyVersion: integer("policy_version").notNull(), budgetLine: text("budget_line").notNull(), capCents: cents("cap_cents"),
}, t => [primaryKey({ columns: [t.fundId, t.policyVersion, t.budgetLine] }),
  foreignKey({ columns: [t.fundId, t.policyVersion], foreignColumns: [fundPolicyVersions.fundId, fundPolicyVersions.version] }),
  check("budget_cap_nonnegative", sql`${t.capCents} >= 0`)]);

export const solverPriorityVersions = pgTable("solver_priority_versions", {
  organizationId: text("organization_id").notNull().references(() => organizations.id), version: integer().notNull(),
  approvedBy: text("approved_by").notNull().references(() => users.id), approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  costsPerCent: jsonb("costs_per_cent").$type<Record<string, string>>().notNull(),
}, t => [primaryKey({ columns: [t.organizationId, t.version] }), check("solver_version_positive", sql`${t.version} > 0`)]);

// A separate row for each claim version preserves historical decisions and approvals.
export const claims = pgTable("claims", {
  id: text().notNull(), version: integer().notNull(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  claimantId: text("claimant_id").notNull().references(() => users.id), program: text().notNull(), vendor: text().notNull(), incurredOn: date("incurred_on").notNull(),
  payeeEmail: text("payee_email").notNull(), payeeIsPlaceholder: boolean("payee_is_placeholder").notNull().default(false),
  status: claimStatus().notNull().default("DRAFT"), isFixture: boolean("is_fixture").notNull().default(true),
}, t => [primaryKey({ columns: [t.id, t.version] }), check("claim_version_positive", sql`${t.version} > 0`)]);

export const claimLines = pgTable("claim_lines", {
  claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(), id: text().notNull(), description: text().notNull(),
  category: text().notNull(), budgetLine: text("budget_line").notNull(), amountCents: cents(),
}, t => [primaryKey({ columns: [t.claimId, t.claimVersion, t.id] }),
  foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  check("claim_line_amount_positive", sql`${t.amountCents} > 0`)]);

export const allocationDecisions = pgTable("allocation_decisions", {
  id: uuid().primaryKey().defaultRandom(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  organizationId: text("organization_id").notNull(), solverPriorityVersion: integer("solver_priority_version").notNull(),
  decisionHash: text("decision_hash").notNull().unique(), payload: jsonb().notNull(), frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  comparison: jsonb().$type<{ status: string; unrestrictedCents?: string; edges: { fundId: string; lineId: string; amountCents: string }[] }>(),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }), recognizedAt: timestamp("recognized_at", { withTimezone: true }),
  createdTransactionId: bigint("created_transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  foreignKey({ columns: [t.organizationId, t.solverPriorityVersion], foreignColumns: [solverPriorityVersions.organizationId, solverPriorityVersions.version] }),
  unique("decision_claim_version_unique").on(t.id, t.claimId, t.claimVersion), check("decision_hash_sha256", sql`${t.decisionHash} ~ '^[0-9a-f]{64}$'`)]);

export const allocationEdges = pgTable("allocation_edges", {
  decisionId: uuid("decision_id").notNull(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  lineId: text("line_id").notNull(), fundId: text("fund_id").notNull(), policyVersion: integer("policy_version").notNull(),
  solverPriorityVersion: integer("solver_priority_version").notNull(), amountCents: cents(), reason: text().notNull(),
}, t => [primaryKey({ columns: [t.decisionId, t.fundId, t.lineId] }),
  foreignKey({ columns: [t.decisionId, t.claimId, t.claimVersion], foreignColumns: [allocationDecisions.id, allocationDecisions.claimId, allocationDecisions.claimVersion] }),
  foreignKey({ columns: [t.claimId, t.claimVersion, t.lineId], foreignColumns: [claimLines.claimId, claimLines.claimVersion, claimLines.id] }),
  foreignKey({ columns: [t.fundId, t.policyVersion], foreignColumns: [fundPolicyVersions.fundId, fundPolicyVersions.version] }),
  check("allocation_amount_positive", sql`${t.amountCents} > 0`)]);

export const fundReservations = pgTable("fund_reservations", {
  id: uuid().primaryKey().defaultRandom(), decisionId: uuid("decision_id").notNull().references(() => allocationDecisions.id),
  fundId: text("fund_id").notNull().references(() => funds.id), amountCents: cents(), status: reservationStatus().notNull().default("ACTIVE"), recordedAt: recordedAt(),
}, t => [unique("reservation_per_decision_fund").on(t.decisionId, t.fundId), check("reservation_amount_positive", sql`${t.amountCents} > 0`)]);

export const reservationBudgetLines = pgTable("reservation_budget_lines", {
  reservationId: uuid("reservation_id").notNull().references(() => fundReservations.id), budgetLine: text("budget_line").notNull(), amountCents: cents(),
}, t => [primaryKey({ columns: [t.reservationId, t.budgetLine] }), check("reserved_budget_amount_positive", sql`${t.amountCents} > 0`)]);

export const approvals = pgTable("approvals", {
  id: uuid().primaryKey().defaultRandom(), decisionHash: text("decision_hash").notNull().references(() => allocationDecisions.decisionHash),
  approverId: text("approver_id").notNull().references(() => users.id), approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [unique("approval_per_hash_user").on(t.decisionHash, t.approverId)]);

export const claimRejections = pgTable("claim_rejections", {
  id: uuid().primaryKey().defaultRandom(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  rejectedBy: text("rejected_by").notNull().references(() => users.id), reason: text().notNull(), recordedAt: recordedAt(),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique("rejection_per_claim_version").on(t.claimId, t.claimVersion), check("rejection_reason_length", sql`length(trim(${t.reason})) between 1 and 500`)]);

export const fundCredits = pgTable("fund_credits", {
  id: uuid().primaryKey().defaultRandom(), fundId: text("fund_id").notNull().references(() => funds.id), amountCents: cents(),
  sourceType: sourceType("source_type").notNull(), sourceId: text("source_id").notNull(), effectiveOn: date("effective_on").notNull(),
  recordedAt: recordedAt(), isOpening: boolean("is_opening").notNull().default(false),
}, t => [unique("credit_source_fund_unique").on(t.sourceType, t.sourceId, t.fundId), check("credit_amount_positive", sql`${t.amountCents} > 0`)]);

export const fundDebits = pgTable("fund_debits", {
  id: uuid().primaryKey().defaultRandom(), fundId: text("fund_id").notNull().references(() => funds.id), budgetLine: text("budget_line"), amountCents: cents(),
  sourceType: sourceType("source_type").notNull(), sourceId: text("source_id").notNull(), effectiveOn: date("effective_on").notNull(), recordedAt: recordedAt(),
  decisionId: uuid("decision_id").references(() => allocationDecisions.id), purpose: text().notNull(),
}, t => [unique("debit_source_fund_purpose_unique").on(t.sourceType, t.sourceId, t.fundId, t.purpose), check("debit_amount_positive", sql`${t.amountCents} > 0`)]);

export const journalEntries = pgTable("journal_entries", {
  id: uuid().primaryKey().defaultRandom(), sourceType: sourceType("source_type").notNull(), sourceId: text("source_id").notNull(), purpose: text().notNull(),
  effectiveOn: date("effective_on").notNull(), recordedAt: recordedAt(),
  createdTransactionId: bigint("created_transaction_id", { mode: "bigint" }).notNull().default(sql`txid_current()`),
}, t => [unique("journal_source_purpose_unique").on(t.sourceType, t.sourceId, t.purpose)]);

// GA-3 enforces immutability and deferred balance through database triggers.
export const journalPostings = pgTable("journal_postings", {
  id: uuid().primaryKey().defaultRandom(), entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
  accountCode: text("account_code").notNull(), subKey: text("sub_key"), debitCents: cents("debit_cents"), creditCents: cents("credit_cents"),
}, t => [check("posting_one_positive_side", sql`(${t.debitCents} > 0 and ${t.creditCents} = 0) or (${t.creditCents} > 0 and ${t.debitCents} = 0)`),
  check("posting_known_account", sql`${t.accountCode} in ('1010','2010','3100','3200','4100','5100','5200','5900')`)]);

export const disbursements = pgTable("disbursements", {
  id: uuid().primaryKey().defaultRandom(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  decisionHash: text("decision_hash").notNull().references(() => allocationDecisions.decisionHash), payeeEmail: text("payee_email").notNull(),
  amountCents: cents(), currency: text().notNull().default("USD"), recordedAt: recordedAt(),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique("disbursement_per_claim_version").on(t.claimId, t.claimVersion), check("disbursement_positive_usd", sql`${t.amountCents} > 0 and ${t.currency} = 'USD'`)]);

export const disbursementAttempts = pgTable("disbursement_attempts", {
  id: uuid().primaryKey().defaultRandom(), disbursementId: uuid("disbursement_id").notNull().references(() => disbursements.id), attemptNumber: integer("attempt_number").notNull(),
  senderBatchId: text("sender_batch_id").notNull().unique(), senderItemId: text("sender_item_id").notNull().unique(),
  payoutBatchId: text("payout_batch_id"), payoutItemId: text("payout_item_id"), batchStatus: text("batch_status"), itemStatus: text("item_status"),
  state: text().notNull().default("PREPARED"), amountCents: cents(), payeeEmail: text("payee_email").notNull(), feeCents: bigint("fee_cents", { mode: "bigint" }), recordedAt: recordedAt(),
  lastHttpStatus: integer("last_http_status"), lastErrorCode: text("last_error_code"), lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  providerBalanceCents: bigint("provider_balance_cents", { mode: "bigint" }), providerBalanceAsOf: text("provider_balance_as_of"),
  settledOn: date("settled_on"),
}, t => [unique("attempt_number_per_disbursement").on(t.disbursementId, t.attemptNumber),
  check("attempt_number_amount_positive", sql`${t.attemptNumber} > 0 and ${t.amountCents} > 0`), check("attempt_fee_nonnegative", sql`${t.feeCents} is null or ${t.feeCents} >= 0`)]);

export const retryAuthorizations = pgTable("retry_authorizations", {
  id: uuid().primaryKey().defaultRandom(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  decisionHash: text("decision_hash").notNull().references(() => allocationDecisions.decisionHash), attemptNumber: integer("attempt_number").notNull(),
  payeeEmail: text("payee_email").notNull(), amountCents: cents(), authorizedBy: text("authorized_by").notNull().references(() => users.id),
  authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique("retry_authorization_per_claim_attempt").on(t.claimId, t.claimVersion, t.attemptNumber),
  check("retry_number_amount_positive", sql`${t.attemptNumber} > 1 and ${t.amountCents} > 0`)]);

export const providerEvents = pgTable("provider_events", {
  id: uuid().primaryKey().defaultRandom(), eventId: text("event_id").notNull().unique(), eventType: text("event_type").notNull(),
  verificationStatus: text("verification_status").notNull(), resourceId: text("resource_id"), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

export const donationReceipts = pgTable("donation_receipts", {
  orderId: text("order_id").primaryKey(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  fundId: text("fund_id").notNull().references(() => funds.id), expectedAmountCents: cents("expected_amount_cents"),
  captureId: text("capture_id").unique(), status: text().notNull(), providerStatus: text("provider_status").notNull(),
  grossCents: bigint("gross_cents", { mode: "bigint" }), feeCents: bigint("fee_cents", { mode: "bigint" }), netCents: bigint("net_cents", { mode: "bigint" }),
  effectiveOn: date("effective_on"), recordedBy: text("recorded_by").notNull().references(() => users.id), recordedAt: recordedAt(),
}, t => [check("donation_expected_positive", sql`${t.expectedAmountCents} > 0`),
  check("donation_status", sql`${t.status} in ('PENDING','COMPLETED')`),
  check("donation_completed_amounts", sql`${t.status} <> 'COMPLETED' or (${t.captureId} is not null and ${t.effectiveOn} is not null and ${t.grossCents} is not null and ${t.feeCents} is not null and ${t.netCents} is not null and ${t.grossCents} = ${t.expectedAmountCents} and ${t.feeCents} >= 0 and ${t.netCents} >= 0 and ${t.grossCents} - ${t.feeCents} = ${t.netCents})`)]);

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(), userId: text("user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [check("session_hash_sha256", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`), check("session_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`)]);

export const loginWindows = pgTable("login_windows", {
  username: text().primaryKey(), attempts: integer().notNull(), resetsAt: timestamp("resets_at", { withTimezone: true }).notNull(),
}, t => [check("login_attempts_positive", sql`${t.attempts} > 0`)]);

export const receiptReviews = pgTable("receipt_reviews", {
  id: uuid().primaryKey().defaultRandom(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(), revision: integer().notNull(),
  source: text().notNull(), sourceHash: text("source_hash").notNull(), draftHash: text("draft_hash").notNull(), createdBy: text("created_by").notNull().references(() => users.id), createdAt: recordedAt(),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique().on(t.claimId, t.claimVersion, t.revision), check("receipt_claim_namespace", sql`${t.claimId} ~ '^R-[a-f0-9-]{36}$'`),
  check("receipt_revision_positive", sql`${t.revision} > 0`), check("receipt_source_bounded", sql`octet_length(${t.source}) between 1 and 16384`),
  check("receipt_hashes", sql`${t.sourceHash} ~ '^[a-f0-9]{64}$' and ${t.draftHash} ~ '^[a-f0-9]{64}$'`)]);
export const receiptSuggestions = pgTable("receipt_suggestions", {
  id: uuid().primaryKey().defaultRandom(), reviewId: uuid("review_id").notNull().references(() => receiptReviews.id),
  attempt: integer().notNull(), status: text().notNull(), proposals: jsonb().$type<{ lineId: string; category: string; quote: string; start: number | null; end: number | null }[]>(),
  audit: jsonb().$type<Record<string, string | number>>(), errorCode: text("error_code"), requestedAt: recordedAt(),
}, t => [unique().on(t.reviewId, t.attempt), check("receipt_attempt_positive", sql`${t.attempt} > 0`), check("receipt_suggestion_status", sql`${t.status} in ('RUNNING','READY','FAILED')`),
  check("receipt_ready_evidence", sql`${t.status} <> 'READY' or (${t.proposals} is not null and ${t.audit} is not null)`)]);
export const receiptConfirmations = pgTable("receipt_confirmations", {
  id: uuid().primaryKey().defaultRandom(), reviewId: uuid("review_id").notNull().unique().references(() => receiptReviews.id),
  suggestionId: uuid("suggestion_id").references(() => receiptSuggestions.id), confirmedBy: text("confirmed_by").notNull().references(() => users.id),
  termsHash: text("terms_hash").notNull(), selections: jsonb().$type<{ lineId: string; category: string; provenance: "AI_ACCEPTED" | "HUMAN"; reason: string }[]>().notNull(), confirmedAt: recordedAt(),
}, t => [check("receipt_confirmation_hash", sql`${t.termsHash} ~ '^[a-f0-9]{64}$'`)]);

export const expenseProposals = pgTable("expense_proposals", {
  id: uuid().primaryKey().defaultRandom(), reviewId: uuid("review_id").notNull().references(() => receiptReviews.id),
  claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizations.id), actorId: text("actor_id").notNull().references(() => users.id),
  requestKey: text("request_key").notNull().unique(), draftHash: text("draft_hash").notNull(), sourceHash: text("source_hash").notNull(), payeeHash: text("payee_hash").notNull(),
  state: text().$type<ProposalState>().notNull(), suggestionId: uuid("suggestion_id").references(() => receiptSuggestions.id),
  suggestionDigest: text("suggestion_digest"), snapshotDigest: text("snapshot_digest"), result: jsonb().$type<ProposalResult>(),
  errorCode: text("error_code"), createdAt: recordedAt(), deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  uniqueIndex("expense_proposal_active_review").on(t.reviewId).where(sql`${t.state} = 'RUNNING'`),
  uniqueIndex("expense_proposal_active_slot").on(sql`(true)`).where(sql`${t.state} = 'RUNNING'`),
  check("expense_proposal_state", sql`${t.state} in ('RUNNING','READY_FOR_REVIEW','NEEDS_REVIEW','POLICY_BLOCKED','UNAVAILABLE','STALE')`),
  check("expense_proposal_deadline", sql`${t.deadlineAt} > ${t.createdAt} and ${t.deadlineAt} <= ${t.createdAt} + interval '65 seconds'`),
  check("expense_proposal_hashes", sql`${t.requestKey} ~ '^[a-f0-9]{64}$' and ${t.draftHash} ~ '^[a-f0-9]{64}$' and ${t.sourceHash} ~ '^[a-f0-9]{64}$' and ${t.payeeHash} ~ '^[a-f0-9]{64}$'`),
  check("expense_proposal_completion", sql`(${t.state} = 'RUNNING' and ${t.completedAt} is null and ${t.result} is null) or (${t.state} <> 'RUNNING' and ${t.completedAt} is not null)`),
]);

// IAC-379 step 1. Server-authoritative donation order lifecycle (docs/plans/DONATION_LOOP_SCOPE.md sections 3 and 8).
// Stores no payer email, payer ID, address or card data. Posting stays in donation_receipts and the ledger.
export const donationOrderStatuses = ["CREATED", "APPROVED", "CAPTURING", "CAPTURE_UNKNOWN", "PENDING", "COMPLETED", "FAILED", "MISMATCH"] as const;
export type DonationOrderStatus = (typeof donationOrderStatuses)[number];
export const donationOrders = pgTable("donation_orders", {
  id: uuid().primaryKey().defaultRandom(), orderId: text("order_id").unique(),
  fundId: text("fund_id").notNull().references(() => funds.id), expectedAmountCents: cents("expected_amount_cents"),
  createRequestId: uuid("create_request_id").notNull().unique(), captureRequestId: uuid("capture_request_id").notNull().unique(),
  status: text().$type<DonationOrderStatus>().notNull().default("CREATED"), captureAttempts: integer("capture_attempts").notNull().default(0),
  displayName: text("display_name"), leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("donation_order_expected_positive", sql`${t.expectedAmountCents} > 0`),
  check("donation_order_id_format", sql`${t.orderId} is null or ${t.orderId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  check("donation_order_request_ids_differ", sql`${t.createRequestId} <> ${t.captureRequestId}`),
  check("donation_order_status", sql`${t.status} in ('CREATED','APPROVED','CAPTURING','CAPTURE_UNKNOWN','PENDING','COMPLETED','FAILED','MISMATCH')`),
  check("donation_order_id_required", sql`${t.status} in ('CREATED','FAILED') or ${t.orderId} is not null`),
  check("donation_order_attempts", sql`${t.captureAttempts} between 0 and 2`),
  check("donation_order_attempts_by_status", sql`${t.captureAttempts} > 0 or ${t.status} in ('CREATED','APPROVED','FAILED','MISMATCH')`),
  check("donation_order_display_name", sql`${t.displayName} is null or (char_length(${t.displayName}) between 1 and 40 and ${t.displayName} = btrim(${t.displayName}))`),
  check("donation_order_lease_pair", sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
  check("donation_order_final_has_no_lease", sql`${t.status} not in ('COMPLETED','FAILED','MISMATCH') or ${t.leaseToken} is null`),
]);
