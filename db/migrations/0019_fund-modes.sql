CREATE TABLE "automated_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_hash" text NOT NULL,
	"kind" text NOT NULL,
	"rules_run_id" uuid,
	"model_run_id" uuid,
	"rule_set_version" text,
	"model" text,
	"prompt_version" text,
	"inputs" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automated_decision_kind" CHECK ("automated_decisions"."kind" in ('NO_HOLDS','HELD','AUDIT_SAMPLED','GUARDRAIL_REFUSED','AUTO_RECOGNIZED','AUTO_SENT')),
	CONSTRAINT "automated_decision_inputs" CHECK (jsonb_typeof("automated_decisions"."inputs") = 'object' and octet_length("automated_decisions"."inputs"::text) <= 8000),
	CONSTRAINT "automated_decision_no_holds_runs" CHECK ("automated_decisions"."kind" <> 'NO_HOLDS' or ("automated_decisions"."rules_run_id" is not null and "automated_decisions"."model_run_id" is not null and "automated_decisions"."rule_set_version" is not null and "automated_decisions"."model" is not null and "automated_decisions"."prompt_version" is not null))
);
--> statement-breakpoint
CREATE TABLE "decision_modes" (
	"decision_hash" text PRIMARY KEY NOT NULL,
	"effective_mode" text NOT NULL,
	"fund_mode_versions" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decision_mode_mode" CHECK ("decision_modes"."effective_mode" in ('MANUAL','ASSISTED','AUTOPILOT')),
	CONSTRAINT "decision_mode_versions_object" CHECK (jsonb_typeof("decision_modes"."fund_mode_versions") = 'object')
);
--> statement-breakpoint
CREATE TABLE "fund_mode_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" text NOT NULL,
	"mode" text NOT NULL,
	"base_version" integer NOT NULL,
	"proposed_by" text NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fund_mode_proposal_mode" CHECK ("fund_mode_proposals"."mode" in ('MANUAL','ASSISTED','AUTOPILOT')),
	CONSTRAINT "fund_mode_proposal_base_version" CHECK ("fund_mode_proposals"."base_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "fund_modes" (
	"fund_id" text NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	"proposal_id" uuid NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fund_modes_fund_id_version_pk" PRIMARY KEY("fund_id","version"),
	CONSTRAINT "fund_modes_proposal_id_unique" UNIQUE("proposal_id"),
	CONSTRAINT "fund_mode_version_positive" CHECK ("fund_modes"."version" > 0),
	CONSTRAINT "fund_mode_mode" CHECK ("fund_modes"."mode" in ('MANUAL','ASSISTED','AUTOPILOT'))
);
--> statement-breakpoint
ALTER TABLE "policy_check_runs" ALTER COLUMN "started_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD COLUMN "trigger" text DEFAULT 'APPROVER' NOT NULL;--> statement-breakpoint
ALTER TABLE "automated_decisions" ADD CONSTRAINT "automated_decisions_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automated_decisions" ADD CONSTRAINT "automated_decisions_rules_run_id_policy_check_runs_id_fk" FOREIGN KEY ("rules_run_id") REFERENCES "public"."policy_check_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automated_decisions" ADD CONSTRAINT "automated_decisions_model_run_id_policy_check_runs_id_fk" FOREIGN KEY ("model_run_id") REFERENCES "public"."policy_check_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_modes" ADD CONSTRAINT "decision_modes_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_mode_proposals" ADD CONSTRAINT "fund_mode_proposals_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_mode_proposals" ADD CONSTRAINT "fund_mode_proposals_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_modes" ADD CONSTRAINT "fund_modes_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_modes" ADD CONSTRAINT "fund_modes_proposal_id_fund_mode_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."fund_mode_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_modes" ADD CONSTRAINT "fund_modes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_run_trigger" CHECK ("policy_check_runs"."trigger" in ('APPROVER','SWEEP'));--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_run_trigger_user" CHECK (("policy_check_runs"."trigger" = 'APPROVER' and "policy_check_runs"."started_by" is not null) or ("policy_check_runs"."trigger" = 'SWEEP' and "policy_check_runs"."started_by" is null));
--> statement-breakpoint
-- IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 3; docs/ASSUMPTIONS.md section 76). Hand-written guards, appended after the
-- generated DDL as migrations 0014 to 0018 did. All four new tables are immutable: no update, no delete, no truncate. Migrations 0015 and
-- 0017 are not edited: their run guard is replaced here with CREATE OR REPLACE. An APPROVER run keeps today's rule exactly (an approver of the
-- claim organization who is not the claimant, same message). A SWEEP run carries no user and belongs only to a decision whose recorded
-- mode is not Manual. Nothing here touches an approval, a reservation or a journal entry, and an automated record is never an approval.
CREATE FUNCTION aidtrace_fund_mode_proposal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM funds f JOIN users u ON u.organization_id = f.organization_id WHERE f.id = NEW.fund_id AND u.id = NEW.proposed_by AND u.role = 'APPROVER') THEN
    RAISE EXCEPTION 'A fund mode is proposed by an approver of the fund organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fund_mode_proposal_insert_guard BEFORE INSERT ON fund_mode_proposals FOR EACH ROW EXECUTE FUNCTION aidtrace_fund_mode_proposal_insert_guard();
--> statement-breakpoint
CREATE TRIGGER fund_mode_proposal_immutable BEFORE UPDATE OR DELETE ON fund_mode_proposals FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER fund_mode_proposal_no_truncate BEFORE TRUNCATE ON fund_mode_proposals FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_fund_mode_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal_row fund_mode_proposals%ROWTYPE;
  last_version integer;
BEGIN
  SELECT * INTO proposal_row FROM fund_mode_proposals WHERE id = NEW.proposal_id;
  IF proposal_row.id IS NULL OR proposal_row.fund_id IS DISTINCT FROM NEW.fund_id OR proposal_row.mode IS DISTINCT FROM NEW.mode THEN
    RAISE EXCEPTION 'A fund mode records the fund and the mode that were proposed' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM funds f JOIN users u ON u.organization_id = f.organization_id WHERE f.id = NEW.fund_id AND u.id = NEW.approved_by AND u.role = 'APPROVER') THEN
    RAISE EXCEPTION 'A fund mode is approved by an approver of the fund organization' USING ERRCODE = '23514';
  END IF;
  IF NEW.approved_by = proposal_row.proposed_by THEN
    RAISE EXCEPTION 'A fund mode is approved by a second approver, not the proposer' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fund_modes WHERE proposal_id = NEW.proposal_id) THEN
    RAISE EXCEPTION 'A fund mode proposal is approved at most once' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(version), 0) INTO last_version FROM fund_modes WHERE fund_id = NEW.fund_id;
  IF NEW.version <> last_version + 1 THEN
    RAISE EXCEPTION 'Fund mode versions are numbered in order' USING ERRCODE = '23514';
  END IF;
  -- A proposal is made against the mode version the fund held then (0 for none). If another mode was approved since, the proposal is stale and cannot be approved.
  IF NEW.version <> proposal_row.base_version + 1 THEN
    RAISE EXCEPTION 'A fund mode proposal made before a later mode change cannot be approved' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fund_mode_insert_guard BEFORE INSERT ON fund_modes FOR EACH ROW EXECUTE FUNCTION aidtrace_fund_mode_insert_guard();
--> statement-breakpoint
CREATE TRIGGER fund_mode_immutable BEFORE UPDATE OR DELETE ON fund_modes FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER fund_mode_no_truncate BEFORE TRUNCATE ON fund_modes FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_decision_mode_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_xid bigint;
BEGIN
  -- Mirrors the frozen decision guard of migration 0003: a decision's mode is written only by the transaction that froze the decision, never later.
  SELECT created_transaction_id INTO owner_xid FROM allocation_decisions WHERE decision_hash = NEW.decision_hash;
  IF owner_xid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'A decision mode is recorded only when the decision is frozen' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER decision_mode_insert_guard BEFORE INSERT ON decision_modes FOR EACH ROW EXECUTE FUNCTION aidtrace_decision_mode_insert_guard();
--> statement-breakpoint
CREATE TRIGGER decision_mode_immutable BEFORE UPDATE OR DELETE ON decision_modes FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER decision_mode_no_truncate BEFORE TRUNCATE ON decision_modes FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_automated_decision_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rules_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policy_check_runs WHERE id = NEW.rules_run_id AND decision_hash = NEW.decision_hash AND kind = 'RULES') THEN
    RAISE EXCEPTION 'An automated record names the rules run of its own decision' USING ERRCODE = '23514';
  END IF;
  IF NEW.model_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policy_check_runs WHERE id = NEW.model_run_id AND decision_hash = NEW.decision_hash AND kind = 'MODEL') THEN
    RAISE EXCEPTION 'An automated record names the model run of its own decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER automated_decision_insert_guard BEFORE INSERT ON automated_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_automated_decision_insert_guard();
--> statement-breakpoint
CREATE TRIGGER automated_decision_immutable BEFORE UPDATE OR DELETE ON automated_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER automated_decision_no_truncate BEFORE TRUNCATE ON automated_decisions FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION aidtrace_policy_run_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  starter_row users%ROWTYPE;
  claim_row claims%ROWTYPE;
BEGIN
  IF NEW.kind IS NULL OR NEW.kind NOT IN ('RULES', 'MODEL') THEN
    RAISE EXCEPTION 'Policy check runs are rule checks or model checks' USING ERRCODE = '23514';
  END IF;
  IF NEW.trigger IS NULL OR NEW.trigger NOT IN ('APPROVER', 'SWEEP') THEN
    RAISE EXCEPTION 'Policy check runs start from an approver or from the sweep' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO claim_row FROM claims WHERE id = NEW.claim_id AND version = NEW.claim_version;
  IF NEW.trigger = 'SWEEP' THEN
    IF NEW.started_by IS NOT NULL THEN
      RAISE EXCEPTION 'A sweep policy check carries no user' USING ERRCODE = '23514';
    END IF;
    IF claim_row.id IS NULL OR NEW.organization_id IS DISTINCT FROM claim_row.organization_id THEN
      RAISE EXCEPTION 'A sweep policy check belongs to a claim of its organization' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM decision_modes WHERE decision_hash = NEW.decision_hash AND effective_mode IN ('ASSISTED', 'AUTOPILOT')) THEN
      RAISE EXCEPTION 'A sweep policy check needs a decision whose recorded mode is not Manual' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO starter_row FROM users WHERE id = NEW.started_by;
    IF starter_row.id IS NULL OR claim_row.id IS NULL OR starter_row.role IS DISTINCT FROM 'APPROVER' OR starter_row.organization_id IS DISTINCT FROM claim_row.organization_id OR starter_row.id = claim_row.claimant_id OR NEW.organization_id IS DISTINCT FROM claim_row.organization_id THEN
      RAISE EXCEPTION 'Policy checks are started by an approver of the claim organization who is not the claimant' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM allocation_decisions WHERE decision_hash = NEW.decision_hash AND claim_id = NEW.claim_id AND claim_version = NEW.claim_version AND organization_id = NEW.organization_id AND invalidated_at IS NULL) THEN
    RAISE EXCEPTION 'Policy checks need the current frozen decision of their claim version' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'MODEL' AND NOT EXISTS (SELECT 1 FROM policy_check_runs WHERE decision_hash = NEW.decision_hash AND kind = 'RULES') THEN
    RAISE EXCEPTION 'A model check follows the rule checks of the same frozen decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
