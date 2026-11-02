import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProposalResult, ProposalState } from "../src/proposal/types";
import type { RulesDraft } from "../src/rules-draft/draft-validate";

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
  check("posting_known_account", sql`${t.accountCode} in ('1010','2010','3100','3200','4100','5100','5200','5300','5400','5500','5900')`)]);

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
  audit: jsonb().$type<Record<string, string | number>>(), provider: text().$type<"local" | "claude">(), model: text(), errorCode: text("error_code"), requestedAt: recordedAt(),
}, t => [unique().on(t.reviewId, t.attempt), check("receipt_attempt_positive", sql`${t.attempt} > 0`), check("receipt_suggestion_status", sql`${t.status} in ('RUNNING','READY','FAILED')`),
  check("receipt_ready_evidence", sql`${t.status} <> 'READY' or (${t.proposals} is not null and ${t.audit} is not null)`),
  // IAC-392 (docs/plans/PROVIDER_COLUMNS.md section 1): the columns must agree with the stored audit and are set only on READY.
  check("receipt_suggestion_provider", sql`(${t.status} = 'READY') = (${t.provider} is not null) and (${t.provider} is null) = (${t.model} is null) and (${t.provider} is null or ${t.provider} in ('local','claude')) and (${t.provider} is distinct from 'local' or (not (${t.audit} ? 'provider') and ${t.model} = ${t.audit}->>'modelRevision' and ${t.model} ~ '^[a-f0-9]{40}$') is true) and (${t.provider} is distinct from 'claude' or (${t.audit}->>'provider' = 'claude' and ${t.model} = ${t.audit}->>'model' and ${t.model} in ('claude-haiku-5-5','claude-sonnet-5-5')) is true)`)]);
export const receiptConfirmations = pgTable("receipt_confirmations", {
  id: uuid().primaryKey().defaultRandom(), reviewId: uuid("review_id").notNull().unique().references(() => receiptReviews.id),
  suggestionId: uuid("suggestion_id").references(() => receiptSuggestions.id), confirmedBy: text("confirmed_by").notNull().references(() => users.id),
  termsHash: text("terms_hash").notNull(), selections: jsonb().$type<{ lineId: string; category: string; provenance: "AI_ACCEPTED" | "HUMAN"; reason: string }[]>().notNull(), confirmedAt: recordedAt(),
  // IAC-394: the receipt text screen stored with the confirmation. Null only on rows confirmed before migration 0013.
  prohibitedScreen: jsonb("prohibited_screen").$type<{ version: string; matches: { category: "alcohol" | "gift_cards"; term: string }[]; unresolved: { category: "alcohol" | "gift_cards"; term: string }[]; acknowledged: boolean } | null>(),
}, t => [check("receipt_confirmation_hash", sql`${t.termsHash} ~ '^[a-f0-9]{64}$'`),
  check("receipt_prohibited_screen_shape", sql`${t.prohibitedScreen} is null or (case when jsonb_typeof(${t.prohibitedScreen}) = 'object' and jsonb_typeof(${t.prohibitedScreen}->'version') = 'string' and jsonb_typeof(${t.prohibitedScreen}->'matches') = 'array' and jsonb_typeof(${t.prohibitedScreen}->'unresolved') = 'array' and jsonb_typeof(${t.prohibitedScreen}->'acknowledged') = 'boolean' then (${t.prohibitedScreen}->'acknowledged' = 'true'::jsonb) = (jsonb_array_length(${t.prohibitedScreen}->'unresolved') > 0) else false end)`)]);

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

// IAC-379 step 1, hardened by IAC-391 (docs/plans/DONATION_HARDENING.md). Server-authoritative donation order lifecycle
// (docs/plans/DONATION_LOOP_SCOPE.md sections 3 and 8). Stores no payer email, payer ID, address or card data.
// Posting stays in donation_receipts and the ledger.
export const donationOrderStatuses = ["CREATED", "APPROVED", "CAPTURING", "CAPTURE_UNKNOWN", "PENDING", "DECLINED", "COMPLETED", "FAILED", "MISMATCH", "EXPIRED"] as const;
export type DonationOrderStatus = (typeof donationOrderStatuses)[number];
export const donationOrders = pgTable("donation_orders", {
  id: uuid().primaryKey().defaultRandom(), orderId: text("order_id").unique(),
  fundId: text("fund_id").notNull().references(() => funds.id), expectedAmountCents: cents("expected_amount_cents"),
  createRequestId: uuid("create_request_id").notNull().unique(), captureRequestId: uuid("capture_request_id").notNull().unique(),
  status: text().$type<DonationOrderStatus>().notNull().default("CREATED"), captureAttempts: integer("capture_attempts").notNull().default(0),
  // Create sends made with the persisted create_request_id (1 to 3). Capture rounds: the IDs PayPal declined, oldest first.
  createAttempts: integer("create_attempts").notNull().default(1),
  declinedCaptureRequestIds: uuid("declined_capture_request_ids").array().notNull().default(sql`'{}'::uuid[]`),
  displayName: text("display_name"), leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("donation_order_expected_positive", sql`${t.expectedAmountCents} > 0`),
  check("donation_order_expected_bound", sql`${t.expectedAmountCents} <= 9999999999999`),
  check("donation_order_id_format", sql`${t.orderId} is null or ${t.orderId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
  check("donation_order_request_ids_differ", sql`${t.createRequestId} <> ${t.captureRequestId}`),
  check("donation_order_status", sql`${t.status} in ('CREATED','APPROVED','CAPTURING','CAPTURE_UNKNOWN','PENDING','DECLINED','COMPLETED','FAILED','MISMATCH','EXPIRED')`),
  check("donation_order_id_required", sql`${t.status} in ('CREATED','FAILED','EXPIRED') or ${t.orderId} is not null`),
  check("donation_order_attempts", sql`${t.captureAttempts} between 0 and 2`),
  check("donation_order_attempts_by_status", sql`${t.captureAttempts} > 0 or ${t.status} in ('CREATED','APPROVED','FAILED','MISMATCH','EXPIRED')`),
  check("donation_order_attempts_before_capture", sql`${t.status} not in ('CREATED','APPROVED') or ${t.captureAttempts} = 0`),
  check("donation_order_create_attempts", sql`${t.createAttempts} between 1 and 3`),
  check("donation_order_history_bound", sql`cardinality(${t.declinedCaptureRequestIds}) <= 2`),
  check("donation_order_history_distinct", sql`not (${t.captureRequestId} = any(${t.declinedCaptureRequestIds})) and not (${t.createRequestId} = any(${t.declinedCaptureRequestIds}))`),
  check("donation_order_display_name", sql`${t.displayName} is null or (char_length(${t.displayName}) between 1 and 40 and ${t.displayName} = btrim(${t.displayName}))`),
  check("donation_order_lease_pair", sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
  check("donation_order_final_has_no_lease", sql`${t.status} not in ('COMPLETED','FAILED','MISMATCH','EXPIRED') or ${t.leaseToken} is null`),
]);

// IAC-379 step 3b (docs/plans/DONATION_LOOP_SCOPE.md sections 6, 8 and 10). A donor impact note approved by a person who is
// not the claimant, and the per-line gift applications written with it. Both tables are immutable (migration 0014 guards).
// Staleness is computed when the page is read, never by updating a row. No money moves and nothing posts to the ledger here.
export const giftNoteModes = ["TEMPLATE", "AI"] as const;
export const giftPayoutStatuses = ["NO_PAYMENT", "PROCESSING", "UNKNOWN", "NEEDS_ATTENTION", "PAID"] as const;
export type GiftPayoutStatus = (typeof giftPayoutStatuses)[number];
export const giftNotes = pgTable("gift_notes", {
  id: uuid().primaryKey().defaultRandom(), captureId: text("capture_id").notNull().references(() => donationReceipts.captureId),
  claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  decisionHash: text("decision_hash").notNull().references(() => allocationDecisions.decisionHash),
  factSetVersion: text("fact_set_version").notNull(), factDigest: text("fact_digest").notNull(),
  templateId: text("template_id").notNull(), optionalFactIds: text("optional_fact_ids").array().notNull().default(sql`'{}'::text[]`),
  renderedText: text("rendered_text").notNull(), textHash: text("text_hash").notNull(),
  mode: text().$type<(typeof giftNoteModes)[number]>().notNull(), modelMetadata: jsonb("model_metadata").$type<Record<string, string | number> | null>(),
  approverId: text("approver_id").notNull().references(() => users.id), approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  payoutStatus: text("payout_status").$type<GiftPayoutStatus>().notNull(), policyVersion: text("policy_version").notNull(),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique("gift_note_identity").on(t.id, t.captureId, t.claimId, t.claimVersion),
  unique("gift_note_facts_unique").on(t.captureId, t.claimId, t.claimVersion, t.factDigest),
  check("gift_note_fact_set", sql`${t.factSetVersion} = 'donor-note-facts-v1'`),
  check("gift_note_policy", sql`${t.policyVersion} = 'GIFT_ATTRIBUTION_V1'`),
  check("gift_note_mode", sql`${t.mode} in ('TEMPLATE','AI')`),
  check("gift_note_model_metadata", sql`(${t.mode} = 'AI') or (${t.modelMetadata} is null)`),
  check("gift_note_hashes", sql`${t.factDigest} ~ '^[a-f0-9]{64}$' and ${t.textHash} ~ '^[a-f0-9]{64}$'`),
  check("gift_note_payout_status", sql`${t.payoutStatus} in ('NO_PAYMENT','PROCESSING','UNKNOWN','NEEDS_ATTENTION','PAID')`),
  check("gift_note_text_bounded", sql`char_length(${t.renderedText}) between 1 and 8000`)]);

export const giftApplications = pgTable("gift_applications", {
  noteId: uuid("note_id").notNull(), captureId: text("capture_id").notNull(), claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(),
  lineId: text("line_id").notNull(), fundId: text("fund_id").notNull().references(() => funds.id), appliedCents: cents("applied_cents"), policyVersion: text("policy_version").notNull(),
}, t => [primaryKey({ columns: [t.noteId, t.lineId, t.fundId] }),
  foreignKey({ columns: [t.noteId, t.captureId, t.claimId, t.claimVersion], foreignColumns: [giftNotes.id, giftNotes.captureId, giftNotes.claimId, giftNotes.claimVersion] }),
  foreignKey({ columns: [t.claimId, t.claimVersion, t.lineId], foreignColumns: [claimLines.claimId, claimLines.claimVersion, claimLines.id] }),
  check("gift_application_positive", sql`${t.appliedCents} > 0`),
  check("gift_application_policy", sql`${t.policyVersion} = 'GIFT_ATTRIBUTION_V1'`)]);

// IAC-405 step 1 (docs/plans/POLICY_CHECK_SCOPE.md sections 2, 4 and 5). Deterministic policy rule flags for approvers.
// All three tables are append-only (migration 0015 guards): a run row is written once, every flag and the run end are later
// result rows, and nothing is ever updated. None of them is part of the financial hash set, and nothing here moves money,
// changes an approval or posts to the ledger. RULES runs are written by the rules. The MODEL kind and its columns (migration 0017)
// are written by the arm C model check, and its rows live in policy_model_results at the end of this file.
export const policyCheckKinds = ["RULES", "MODEL"] as const;
export type PolicyCheckKind = (typeof policyCheckKinds)[number];
export const policyRuleIds = ["P1", "P2", "P3", "P4", "P5", "P6", "P7"] as const;
export type PolicyRuleId = (typeof policyRuleIds)[number];
export const policyResultEntries = ["FLAG", "NOT_CHECKED", "RUN_END"] as const;
export type PolicyResultEntry = (typeof policyResultEntries)[number];

// Per-fund thresholds, versioned. Cents and day counts only. It has no mode column: a fund mode belongs to a later step.
export const fundCheckSettings = pgTable("fund_check_settings", {
  fundId: text("fund_id").notNull().references(() => funds.id), version: integer().notNull(),
  approvedBy: text("approved_by").notNull().references(() => users.id), approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  suppliesLimitCents: cents("supplies_limit_cents"), equipmentLimitCents: cents("equipment_limit_cents"), claimLimitCents: cents("claim_limit_cents"),
  staleReceiptDays: integer("stale_receipt_days").notNull(), duplicateWindowDays: integer("duplicate_window_days").notNull(), splitWindowDays: integer("split_window_days").notNull(),
}, t => [primaryKey({ columns: [t.fundId, t.version] }), check("check_settings_version_positive", sql`${t.version} > 0`),
  check("check_settings_limits_positive", sql`${t.suppliesLimitCents} > 0 and ${t.equipmentLimitCents} > 0 and ${t.claimLimitCents} > 0`),
  check("check_settings_days", sql`${t.staleReceiptDays} between 1 and 3650 and ${t.duplicateWindowDays} between 1 and 3650 and ${t.splitWindowDays} between 1 and 3650`)]);

export const policyCheckRuns = pgTable("policy_check_runs", {
  id: uuid().primaryKey().defaultRandom(), decisionHash: text("decision_hash").notNull().references(() => allocationDecisions.decisionHash),
  claimId: text("claim_id").notNull(), claimVersion: integer("claim_version").notNull(), organizationId: text("organization_id").notNull().references(() => organizations.id),
  kind: text().$type<PolicyCheckKind>().notNull(), startedBy: text("started_by").notNull().references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  // Fund id to the fund_check_settings version this run read. An empty object means no funding fund had thresholds.
  settingsVersions: jsonb("settings_versions").$type<Record<string, number>>().notNull(), ruleSetVersion: text("rule_set_version").notNull(),
  // SHA-256 of the canonical fact set the rules read, so the same claim can be explained later.
  factsDigest: text("facts_digest").notNull(),
  model: text(), effort: text(), promptVersion: text("prompt_version"), schemaVersion: text("schema_version"), clauseSetHash: text("clause_set_hash"), requestDigest: text("request_digest"),
}, t => [foreignKey({ columns: [t.claimId, t.claimVersion], foreignColumns: [claims.id, claims.version] }),
  unique("policy_run_per_decision_kind").on(t.decisionHash, t.kind),
  check("policy_run_kind", sql`${t.kind} in ('RULES','MODEL')`),
  check("policy_run_settings_object", sql`jsonb_typeof(${t.settingsVersions}) = 'object'`),
  check("policy_run_facts_digest", sql`${t.factsDigest} ~ '^[a-f0-9]{64}$'`),
  check("policy_run_model_columns", sql`(${t.kind} = 'RULES' and ${t.model} is null and ${t.effort} is null and ${t.promptVersion} is null and ${t.schemaVersion} is null and ${t.clauseSetHash} is null and ${t.requestDigest} is null) or (${t.kind} = 'MODEL' and ${t.model} is not null and ${t.effort} is not null and ${t.promptVersion} is not null and ${t.schemaVersion} is not null and ${t.clauseSetHash} is not null and ${t.requestDigest} is not null)`)]);

export const policyCheckResults = pgTable("policy_check_results", {
  runId: uuid("run_id").notNull().references(() => policyCheckRuns.id), sequence: integer().notNull(),
  entry: text().$type<PolicyResultEntry>().notNull(), ruleId: text("rule_id").$type<PolicyRuleId>(), severity: text().$type<"HOLD" | "NOTE">(),
  lineId: text("line_id"), fundId: text("fund_id").references(() => funds.id), settingsVersion: integer("settings_version"),
  reasonCode: text("reason_code"), flagText: text("flag_text"), inputs: jsonb().$type<Record<string, unknown>>().notNull(), recordedAt: recordedAt(),
}, t => [primaryKey({ columns: [t.runId, t.sequence] }),
  foreignKey({ columns: [t.fundId, t.settingsVersion], foreignColumns: [fundCheckSettings.fundId, fundCheckSettings.version] }),
  check("policy_result_sequence", sql`${t.sequence} > 0`),
  check("policy_result_entry", sql`${t.entry} in ('FLAG','NOT_CHECKED','RUN_END')`),
  check("policy_result_fund_version", sql`(${t.fundId} is null) = (${t.settingsVersion} is null)`),
  check("policy_result_text_bounded", sql`${t.flagText} is null or char_length(${t.flagText}) between 1 and 600`),
  check("policy_result_inputs", sql`jsonb_typeof(${t.inputs}) = 'object' and octet_length(${t.inputs}::text) <= 8000`),
  check("policy_result_shape", sql`(${t.entry} = 'FLAG' and ${t.ruleId} in ('P1','P2','P3','P4','P5','P6','P7') and ${t.severity} in ('HOLD','NOTE') and ${t.flagText} is not null and ${t.reasonCode} is null)
    or (${t.entry} = 'NOT_CHECKED' and ${t.ruleId} in ('P1','P2','P3','P5','P6') and ${t.severity} is null and ${t.reasonCode} = 'NO_THRESHOLDS' and ${t.flagText} is not null and ${t.fundId} is null and ${t.lineId} is null)
    or (${t.entry} = 'RUN_END' and ${t.ruleId} is null and ${t.severity} is null and ${t.reasonCode} is null and ${t.flagText} is null and ${t.lineId} is null and ${t.fundId} is null)`)]);

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md sections 2 and 5). The private gift link. Only the SHA-256 of the bearer token is
// stored, so nobody can recover or regenerate a link. The table is append-only (migration 0016 guards): one row per completed gift,
// never updated or deleted. It holds no contact method and is outside the financial hash set.
export const giftLinkPolicy = "GIFT_LINK_V1" as const;
export const giftLinks = pgTable("gift_links", {
  tokenHash: text("token_hash").primaryKey(), captureId: text("capture_id").notNull().unique().references(() => donationReceipts.captureId),
  policyVersion: text("policy_version").notNull(), recordedAt: recordedAt(),
}, t => [check("gift_link_hash", sql`${t.tokenHash} ~ '^[a-f0-9]{64}$'`), check("gift_link_policy", sql`${t.policyVersion} = 'GIFT_LINK_V1'`)]);

// IAC-405 step 1 piece G and N1 (docs/plans/POLICY_CHECK_SCOPE.md sections 2.2, 3 and 4; docs/ASSUMPTIONS.md section 60). Migration 0017.
// fund_policy_clauses is the clause text the model reads, append-only, one row per fund policy version and clause id. The model writes
// no quote: the app looks the text up here by the validated clause id. policy_model_results holds the arm C rows of a MODEL run
// (policy_check_results cannot: its shape checks and its guard are rules only, and migration 0015 stays unchanged). Both tables are
// append-only (migration 0017 guards), outside the financial hash set, and move no money.
export const policyModelEntries = ["CALL", "LINE", "NOT_CHECKED", "SKIPPED", "RUN_END"] as const;
export type PolicyModelEntry = (typeof policyModelEntries)[number];
export const modelVerdicts = ["OK", "CONFLICT", "UNSURE"] as const;
export type ModelVerdict = (typeof modelVerdicts)[number];
export const modelReasonCodes = ["TIMEOUT", "UNAVAILABLE", "INVALID", "LIMIT", "NO_CLAUSES", "GENERAL_FUND"] as const;
export type ModelReasonCode = (typeof modelReasonCodes)[number];

export const fundPolicyClauses = pgTable("fund_policy_clauses", {
  fundId: text("fund_id").notNull(), policyVersion: integer("policy_version").notNull(), clauseId: text("clause_id").notNull(),
  text: text().notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.fundId, t.policyVersion, t.clauseId] }),
  foreignKey({ columns: [t.fundId, t.policyVersion], foreignColumns: [fundPolicyVersions.fundId, fundPolicyVersions.version] }),
  check("clause_id_shape", sql`${t.clauseId} ~ '^[0-9]{1,2}[.][0-9]{1,2}$'`),
  check("clause_text_bounded", sql`char_length(${t.text}) between 1 and 600 and ${t.text} = btrim(${t.text})`)]);

export const policyModelResults = pgTable("policy_model_results", {
  runId: uuid("run_id").notNull().references(() => policyCheckRuns.id), sequence: integer().notNull(),
  entry: text().$type<PolicyModelEntry>().notNull(), fundId: text("fund_id"), policyVersion: integer("policy_version"),
  lineId: text("line_id"), verdict: text().$type<ModelVerdict>(), clauseId: text("clause_id"),
  // The model id and effort that produced the row, or that failed to. Null only where no model was involved.
  model: text(), effort: text(), reasonCode: text("reason_code").$type<ModelReasonCode>(),
  // CALL rows only: the digest of the exact request, the stop reason and the token counts. Never the key, headers or raw model text.
  requestDigest: text("request_digest"), stopReason: text("stop_reason"), inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"),
  recordedAt: recordedAt(),
}, t => [primaryKey({ columns: [t.runId, t.sequence] }),
  foreignKey({ columns: [t.fundId, t.policyVersion], foreignColumns: [fundPolicyVersions.fundId, fundPolicyVersions.version] }),
  foreignKey({ columns: [t.fundId, t.policyVersion, t.clauseId], foreignColumns: [fundPolicyClauses.fundId, fundPolicyClauses.policyVersion, fundPolicyClauses.clauseId] }),
  check("model_result_sequence", sql`${t.sequence} > 0`),
  check("model_result_entry", sql`${t.entry} in ('CALL','LINE','NOT_CHECKED','SKIPPED','RUN_END')`),
  check("model_result_verdict", sql`${t.verdict} is null or ${t.verdict} in ('OK','CONFLICT','UNSURE')`),
  check("model_result_reason", sql`${t.reasonCode} is null or ${t.reasonCode} in ('TIMEOUT','UNAVAILABLE','INVALID','LIMIT','NO_CLAUSES','GENERAL_FUND')`),
  check("model_result_fund_version", sql`(${t.fundId} is null) = (${t.policyVersion} is null)`),
  check("model_result_clause_scope", sql`${t.clauseId} is null or ${t.fundId} is not null`),
  check("model_result_model_effort", sql`(${t.model} is null) = (${t.effort} is null)`),
  check("model_result_digest", sql`${t.requestDigest} is null or ${t.requestDigest} ~ '^[a-f0-9]{64}$'`),
  check("model_result_counts", sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0) and (${t.outputTokens} is null or ${t.outputTokens} >= 0)`),
  check("model_result_shape", sql`(${t.entry} = 'CALL' and ${t.fundId} is not null and ${t.model} is not null and ${t.requestDigest} is not null and ${t.lineId} is null and ${t.verdict} is null and ${t.clauseId} is null and (${t.reasonCode} is null or ${t.reasonCode} in ('TIMEOUT','UNAVAILABLE','INVALID')))
    or (${t.entry} = 'LINE' and ${t.fundId} is not null and ${t.model} is not null and ${t.lineId} is not null and ${t.verdict} is not null and ${t.reasonCode} is null and ${t.requestDigest} is null and ${t.stopReason} is null and ${t.inputTokens} is null and ${t.outputTokens} is null
      and ((${t.verdict} = 'OK' and ${t.clauseId} is null) or ${t.verdict} = 'UNSURE' or (${t.verdict} = 'CONFLICT' and ${t.clauseId} is not null)))
    or (${t.entry} = 'NOT_CHECKED' and ${t.fundId} is not null and ${t.reasonCode} in ('TIMEOUT','UNAVAILABLE','INVALID','LIMIT','NO_CLAUSES') and ${t.lineId} is null and ${t.verdict} is null and ${t.clauseId} is null and ${t.requestDigest} is null and ${t.stopReason} is null and ${t.inputTokens} is null and ${t.outputTokens} is null and ((${t.reasonCode} = 'NO_CLAUSES') = (${t.model} is null)))
    or (${t.entry} = 'SKIPPED' and ${t.fundId} is not null and ${t.reasonCode} = 'GENERAL_FUND' and ${t.model} is null and ${t.lineId} is null and ${t.verdict} is null and ${t.clauseId} is null and ${t.requestDigest} is null and ${t.stopReason} is null and ${t.inputTokens} is null and ${t.outputTokens} is null)
    or (${t.entry} = 'RUN_END' and ${t.fundId} is null and ${t.model} is null and ${t.lineId} is null and ${t.verdict} is null and ${t.clauseId} is null and ${t.reasonCode} is null and ${t.requestDigest} is null and ${t.stopReason} is null and ${t.inputTokens} is null and ${t.outputTokens} is null)`)]);

// IAC-440 Package A (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 5; docs/ASSUMPTIONS.md section 70). Migration 0018.
// policy_drafts is one immutable row per AI draft, refused AI draft or human edit. An edit is a new row that points at its parent, so the
// model output and every human change stay separately visible. Status is never stored: it is derived from policy_draft_events, which is
// append-only. Both tables are outside the financial hash set and move no money. Neither stores the key, headers or raw model text.
export const draftOutcomes = ["DRAFTED", "REFUSED"] as const;
export type DraftOutcome = (typeof draftOutcomes)[number];
export const draftEventKinds = ["APPROVED", "BOUND", "WITHDRAWN"] as const;
export type DraftEventKind = (typeof draftEventKinds)[number];

export const policyDrafts = pgTable("policy_drafts", {
  id: uuid().primaryKey().defaultRandom(), fundId: text("fund_id").notNull(), basePolicyVersion: integer("base_policy_version").notNull(),
  // Null for a model draft. An edit names the row it changed.
  parentDraftId: uuid("parent_draft_id"),
  inputSha256: text("input_sha256").notNull(), inputText: text("input_text").notNull(),
  outcome: text().$type<DraftOutcome>().notNull(),
  // The validated draft for DRAFTED rows. REFUSED rows hold the refusal code and the path of the first rule that failed instead.
  draft: jsonb().$type<RulesDraft | null>(), refusalReason: text("refusal_reason"), refusalPath: text("refusal_path"),
  // Edit rows only: the field names a person changed against the parent.
  changedFields: jsonb("changed_fields").$type<string[] | null>(),
  // Model rows only (a human edit involved no model). Never the key, headers or raw model text.
  model: text(), effort: text(), promptVersion: text("prompt_version"), schemaVersion: text("schema_version"), requestDigest: text("request_digest"),
  stopReason: text("stop_reason"), inputTokens: integer("input_tokens"), outputTokens: integer("output_tokens"),
  draftedBy: text("drafted_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.fundId, t.basePolicyVersion], foreignColumns: [fundPolicyVersions.fundId, fundPolicyVersions.version] }),
  foreignKey({ columns: [t.parentDraftId], foreignColumns: [t.id] }),
  check("draft_input_bounded", sql`char_length(${t.inputText}) between 1 and 20000 and btrim(${t.inputText}, E' \\n\\r\\t') <> ''`),
  check("draft_input_hash", sql`${t.inputSha256} = encode(sha256(convert_to(${t.inputText}, 'UTF8')), 'hex')`),
  check("draft_outcome", sql`${t.outcome} in ('DRAFTED','REFUSED')`),
  check("draft_outcome_shape", sql`(${t.outcome} = 'DRAFTED' and ${t.draft} is not null and jsonb_typeof(${t.draft}) = 'object' and ${t.refusalReason} is null and ${t.refusalPath} is null)
    or (${t.outcome} = 'REFUSED' and ${t.draft} is null and ${t.refusalReason} ~ '^[A-Z_]{1,40}$' and ${t.refusalPath} ~ '^[A-Za-z0-9_.]{1,80}$' and ${t.parentDraftId} is null and ${t.changedFields} is null)`),
  check("draft_edit_shape", sql`(${t.parentDraftId} is null and ${t.changedFields} is null
      and ${t.model} is not null and ${t.effort} is not null and ${t.promptVersion} is not null and ${t.schemaVersion} is not null and ${t.requestDigest} is not null)
    or (${t.parentDraftId} is not null and ${t.outcome} = 'DRAFTED' and ${t.changedFields} is not null and jsonb_typeof(${t.changedFields}) = 'array' and jsonb_array_length(${t.changedFields}) > 0
      and ${t.model} is null and ${t.effort} is null and ${t.promptVersion} is null and ${t.schemaVersion} is null and ${t.requestDigest} is null and ${t.stopReason} is null and ${t.inputTokens} is null and ${t.outputTokens} is null)`),
  check("draft_digest", sql`${t.requestDigest} is null or ${t.requestDigest} ~ '^[a-f0-9]{64}$'`),
  check("draft_stop_reason", sql`${t.stopReason} is null or ${t.stopReason} ~ '^[a-z_]{1,40}$'`),
  check("draft_counts", sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0) and (${t.outputTokens} is null or ${t.outputTokens} >= 0)`)]);

export const policyDraftEvents = pgTable("policy_draft_events", {
  id: uuid().primaryKey().defaultRandom(), draftId: uuid("draft_id").notNull().references(() => policyDrafts.id),
  kind: text().$type<DraftEventKind>().notNull(), actorId: text("actor_id").notNull().references(() => users.id),
  // BOUND only: the fund_policy_versions version this draft created.
  boundPolicyVersion: integer("bound_policy_version"), recordedAt: recordedAt(),
}, t => [
  check("draft_event_kind", sql`${t.kind} in ('APPROVED','BOUND','WITHDRAWN')`),
  check("draft_event_bound_version", sql`(${t.kind} = 'BOUND') = (${t.boundPolicyVersion} is not null) and (${t.boundPolicyVersion} is null or ${t.boundPolicyVersion} > 1)`),
  // One approval per person per draft, one binding, one withdrawal. The service checks first, the database backs it.
  uniqueIndex("draft_event_one_approval_per_person").on(t.draftId, t.actorId).where(sql`${t.kind} = 'APPROVED'`),
  uniqueIndex("draft_event_one_bound").on(t.draftId).where(sql`${t.kind} = 'BOUND'`),
  uniqueIndex("draft_event_one_withdrawn").on(t.draftId).where(sql`${t.kind} = 'WITHDRAWN'`)]);
