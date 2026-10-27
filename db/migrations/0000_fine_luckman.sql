CREATE TYPE "public"."claim_status" AS ENUM('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'PAYOUT_PROCESSING', 'PAID', 'REJECTED', 'PAYOUT_ISSUE');--> statement-breakpoint
CREATE TYPE "public"."fund_class" AS ENUM('RESTRICTED', 'UNRESTRICTED');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('ACTIVE', 'RELEASED', 'CONSUMED');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('fixture_opening_balance', 'claim_recognition', 'paypal_capture', 'paypal_payout_item');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('CLAIMANT', 'APPROVER');--> statement-breakpoint
CREATE TABLE "allocation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"organization_id" text NOT NULL,
	"solver_priority_version" integer NOT NULL,
	"decision_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_at" timestamp with time zone,
	"recognized_at" timestamp with time zone,
	CONSTRAINT "allocation_decisions_decision_hash_unique" UNIQUE("decision_hash"),
	CONSTRAINT "decision_claim_version_unique" UNIQUE("id","claim_id","claim_version"),
	CONSTRAINT "decision_hash_sha256" CHECK ("allocation_decisions"."decision_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "allocation_edges" (
	"decision_id" uuid NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"line_id" text NOT NULL,
	"fund_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"solver_priority_version" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	CONSTRAINT "allocation_edges_decision_id_fund_id_line_id_pk" PRIMARY KEY("decision_id","fund_id","line_id"),
	CONSTRAINT "allocation_amount_positive" CHECK ("allocation_edges"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_hash" text NOT NULL,
	"approver_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_per_hash_user" UNIQUE("decision_hash","approver_id")
);
--> statement-breakpoint
CREATE TABLE "claim_lines" (
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"id" text NOT NULL,
	"description" text NOT NULL,
	"category" text NOT NULL,
	"budget_line" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "claim_lines_claim_id_claim_version_id_pk" PRIMARY KEY("claim_id","claim_version","id"),
	CONSTRAINT "claim_line_amount_positive" CHECK ("claim_lines"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text NOT NULL,
	"version" integer NOT NULL,
	"organization_id" text NOT NULL,
	"claimant_id" text NOT NULL,
	"program" text NOT NULL,
	"vendor" text NOT NULL,
	"incurred_on" date NOT NULL,
	"payee_email" text NOT NULL,
	"payee_is_placeholder" boolean DEFAULT false NOT NULL,
	"status" "claim_status" DEFAULT 'DRAFT' NOT NULL,
	"is_fixture" boolean DEFAULT true NOT NULL,
	CONSTRAINT "claims_id_version_pk" PRIMARY KEY("id","version"),
	CONSTRAINT "claim_version_positive" CHECK ("claims"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "disbursement_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"sender_batch_id" text NOT NULL,
	"sender_item_id" text NOT NULL,
	"payout_batch_id" text,
	"payout_item_id" text,
	"batch_status" text,
	"item_status" text,
	"state" text DEFAULT 'PREPARED' NOT NULL,
	"amount_cents" bigint NOT NULL,
	"payee_email" text NOT NULL,
	"fee_cents" bigint,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disbursement_attempts_sender_batch_id_unique" UNIQUE("sender_batch_id"),
	CONSTRAINT "disbursement_attempts_sender_item_id_unique" UNIQUE("sender_item_id"),
	CONSTRAINT "attempt_number_per_disbursement" UNIQUE("disbursement_id","attempt_number"),
	CONSTRAINT "attempt_number_amount_positive" CHECK ("disbursement_attempts"."attempt_number" > 0 and "disbursement_attempts"."amount_cents" > 0),
	CONSTRAINT "attempt_fee_nonnegative" CHECK ("disbursement_attempts"."fee_cents" is null or "disbursement_attempts"."fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "disbursements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"decision_hash" text NOT NULL,
	"payee_email" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disbursement_per_claim_version" UNIQUE("claim_id","claim_version"),
	CONSTRAINT "disbursement_positive_usd" CHECK ("disbursements"."amount_cents" > 0 and "disbursements"."currency" = 'USD')
);
--> statement-breakpoint
CREATE TABLE "fund_budget_lines" (
	"fund_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"budget_line" text NOT NULL,
	"cap_cents" bigint NOT NULL,
	CONSTRAINT "fund_budget_lines_fund_id_policy_version_budget_line_pk" PRIMARY KEY("fund_id","policy_version","budget_line"),
	CONSTRAINT "budget_cap_nonnegative" CHECK ("fund_budget_lines"."cap_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fund_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_id" text NOT NULL,
	"effective_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_opening" boolean DEFAULT false NOT NULL,
	CONSTRAINT "credit_source_fund_unique" UNIQUE("source_type","source_id","fund_id"),
	CONSTRAINT "credit_amount_positive" CHECK ("fund_credits"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "fund_debits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" text NOT NULL,
	"budget_line" text,
	"amount_cents" bigint NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_id" text NOT NULL,
	"effective_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decision_id" uuid,
	"purpose" text NOT NULL,
	CONSTRAINT "debit_source_fund_purpose_unique" UNIQUE("source_type","source_id","fund_id","purpose"),
	CONSTRAINT "debit_amount_positive" CHECK ("fund_debits"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "fund_policy_versions" (
	"fund_id" text NOT NULL,
	"version" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"programs" jsonb,
	"allowed_categories" jsonb,
	"period_start" date,
	"period_end" date,
	"breadth" integer,
	"summary" text NOT NULL,
	CONSTRAINT "fund_policy_versions_fund_id_version_pk" PRIMARY KEY("fund_id","version"),
	CONSTRAINT "policy_version_positive" CHECK ("fund_policy_versions"."version" > 0),
	CONSTRAINT "policy_period_valid" CHECK (("fund_policy_versions"."period_start" is null and "fund_policy_versions"."period_end" is null) or ("fund_policy_versions"."period_start" is not null and "fund_policy_versions"."period_end" is not null and "fund_policy_versions"."period_start" <= "fund_policy_versions"."period_end")),
	CONSTRAINT "policy_breadth_positive" CHECK ("fund_policy_versions"."breadth" is null or "fund_policy_versions"."breadth" > 0)
);
--> statement-breakpoint
CREATE TABLE "fund_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"fund_id" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'ACTIVE' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservation_per_decision_fund" UNIQUE("decision_id","fund_id"),
	CONSTRAINT "reservation_amount_positive" CHECK ("fund_reservations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "funds" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"fund_class" "fund_class" NOT NULL,
	"current_policy_version" integer NOT NULL,
	"is_fixture" boolean DEFAULT true NOT NULL,
	CONSTRAINT "fund_policy_version_positive" CHECK ("funds"."current_policy_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" "source_type" NOT NULL,
	"source_id" text NOT NULL,
	"purpose" text NOT NULL,
	"effective_on" date NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_source_purpose_unique" UNIQUE("source_type","source_id","purpose")
);
--> statement-breakpoint
CREATE TABLE "journal_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_code" text NOT NULL,
	"sub_key" text,
	"debit_cents" bigint NOT NULL,
	"credit_cents" bigint NOT NULL,
	CONSTRAINT "posting_one_positive_side" CHECK (("journal_postings"."debit_cents" > 0 and "journal_postings"."credit_cents" = 0) or ("journal_postings"."credit_cents" > 0 and "journal_postings"."debit_cents" = 0)),
	CONSTRAINT "posting_known_account" CHECK ("journal_postings"."account_code" in ('1010','2010','3100','3200','4100','5100','5200','5900'))
);
--> statement-breakpoint
CREATE TABLE "login_windows" (
	"username" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"resets_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_attempts_positive" CHECK ("login_windows"."attempts" > 0)
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"prohibited_categories" jsonb NOT NULL,
	"is_fixture" boolean DEFAULT true NOT NULL,
	"opening_source_type" "source_type" NOT NULL,
	CONSTRAINT "organization_opening_source" CHECK ("organizations"."opening_source_type" in ('fixture_opening_balance', 'paypal_capture'))
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"verification_status" text NOT NULL,
	"resource_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "provider_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "reservation_budget_lines" (
	"reservation_id" uuid NOT NULL,
	"budget_line" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "reservation_budget_lines_reservation_id_budget_line_pk" PRIMARY KEY("reservation_id","budget_line"),
	CONSTRAINT "reserved_budget_amount_positive" CHECK ("reservation_budget_lines"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "retry_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"decision_hash" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"payee_email" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"authorized_by" text NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retry_authorization_per_claim_attempt" UNIQUE("claim_id","claim_version","attempt_number"),
	CONSTRAINT "retry_number_amount_positive" CHECK ("retry_authorizations"."attempt_number" > 1 and "retry_authorizations"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_hash_sha256" CHECK ("sessions"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_expiry_after_creation" CHECK ("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "solver_priority_versions" (
	"organization_id" text NOT NULL,
	"version" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"costs_per_cent" jsonb NOT NULL,
	CONSTRAINT "solver_priority_versions_organization_id_version_pk" PRIMARY KEY("organization_id","version"),
	CONSTRAINT "solver_version_positive" CHECK ("solver_priority_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"password_hash" text NOT NULL,
	"is_fixture" boolean DEFAULT true NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "allocation_decisions" ADD CONSTRAINT "allocation_decisions_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_decisions" ADD CONSTRAINT "allocation_decisions_organization_id_solver_priority_version_solver_priority_versions_organization_id_version_fk" FOREIGN KEY ("organization_id","solver_priority_version") REFERENCES "public"."solver_priority_versions"("organization_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_edges" ADD CONSTRAINT "allocation_edges_decision_id_claim_id_claim_version_allocation_decisions_id_claim_id_claim_version_fk" FOREIGN KEY ("decision_id","claim_id","claim_version") REFERENCES "public"."allocation_decisions"("id","claim_id","claim_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_edges" ADD CONSTRAINT "allocation_edges_claim_id_claim_version_line_id_claim_lines_claim_id_claim_version_id_fk" FOREIGN KEY ("claim_id","claim_version","line_id") REFERENCES "public"."claim_lines"("claim_id","claim_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocation_edges" ADD CONSTRAINT "allocation_edges_fund_id_policy_version_fund_policy_versions_fund_id_version_fk" FOREIGN KEY ("fund_id","policy_version") REFERENCES "public"."fund_policy_versions"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_lines" ADD CONSTRAINT "claim_lines_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_claimant_id_users_id_fk" FOREIGN KEY ("claimant_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD CONSTRAINT "disbursement_attempts_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_budget_lines" ADD CONSTRAINT "fund_budget_lines_fund_id_policy_version_fund_policy_versions_fund_id_version_fk" FOREIGN KEY ("fund_id","policy_version") REFERENCES "public"."fund_policy_versions"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_credits" ADD CONSTRAINT "fund_credits_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_debits" ADD CONSTRAINT "fund_debits_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_debits" ADD CONSTRAINT "fund_debits_decision_id_allocation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."allocation_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_policy_versions" ADD CONSTRAINT "fund_policy_versions_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_policy_versions" ADD CONSTRAINT "fund_policy_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_reservations" ADD CONSTRAINT "fund_reservations_decision_id_allocation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."allocation_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_reservations" ADD CONSTRAINT "fund_reservations_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funds" ADD CONSTRAINT "funds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_postings" ADD CONSTRAINT "journal_postings_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_budget_lines" ADD CONSTRAINT "reservation_budget_lines_reservation_id_fund_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."fund_reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_authorizations" ADD CONSTRAINT "retry_authorizations_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_authorizations" ADD CONSTRAINT "retry_authorizations_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retry_authorizations" ADD CONSTRAINT "retry_authorizations_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solver_priority_versions" ADD CONSTRAINT "solver_priority_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solver_priority_versions" ADD CONSTRAINT "solver_priority_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;