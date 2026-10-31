CREATE TABLE "fund_check_settings" (
	"fund_id" text NOT NULL,
	"version" integer NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supplies_limit_cents" bigint NOT NULL,
	"equipment_limit_cents" bigint NOT NULL,
	"claim_limit_cents" bigint NOT NULL,
	"stale_receipt_days" integer NOT NULL,
	"duplicate_window_days" integer NOT NULL,
	"split_window_days" integer NOT NULL,
	CONSTRAINT "fund_check_settings_fund_id_version_pk" PRIMARY KEY("fund_id","version"),
	CONSTRAINT "check_settings_version_positive" CHECK ("fund_check_settings"."version" > 0),
	CONSTRAINT "check_settings_limits_positive" CHECK ("fund_check_settings"."supplies_limit_cents" > 0 and "fund_check_settings"."equipment_limit_cents" > 0 and "fund_check_settings"."claim_limit_cents" > 0),
	CONSTRAINT "check_settings_days" CHECK ("fund_check_settings"."stale_receipt_days" between 1 and 3650 and "fund_check_settings"."duplicate_window_days" between 1 and 3650 and "fund_check_settings"."split_window_days" between 1 and 3650)
);
--> statement-breakpoint
CREATE TABLE "policy_check_results" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"entry" text NOT NULL,
	"rule_id" text,
	"severity" text,
	"line_id" text,
	"fund_id" text,
	"settings_version" integer,
	"reason_code" text,
	"flag_text" text,
	"inputs" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_check_results_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "policy_result_sequence" CHECK ("policy_check_results"."sequence" > 0),
	CONSTRAINT "policy_result_entry" CHECK ("policy_check_results"."entry" in ('FLAG','NOT_CHECKED','RUN_END')),
	CONSTRAINT "policy_result_fund_version" CHECK (("policy_check_results"."fund_id" is null) = ("policy_check_results"."settings_version" is null)),
	CONSTRAINT "policy_result_text_bounded" CHECK ("policy_check_results"."flag_text" is null or char_length("policy_check_results"."flag_text") between 1 and 600),
	CONSTRAINT "policy_result_inputs" CHECK (jsonb_typeof("policy_check_results"."inputs") = 'object' and octet_length("policy_check_results"."inputs"::text) <= 8000),
	CONSTRAINT "policy_result_shape" CHECK (("policy_check_results"."entry" = 'FLAG' and "policy_check_results"."rule_id" in ('P1','P2','P3','P4','P5','P6','P7') and "policy_check_results"."severity" in ('HOLD','NOTE') and "policy_check_results"."flag_text" is not null and "policy_check_results"."reason_code" is null)
    or ("policy_check_results"."entry" = 'NOT_CHECKED' and "policy_check_results"."rule_id" in ('P1','P2','P3','P5','P6') and "policy_check_results"."severity" is null and "policy_check_results"."reason_code" = 'NO_THRESHOLDS' and "policy_check_results"."flag_text" is not null and "policy_check_results"."fund_id" is null and "policy_check_results"."line_id" is null)
    or ("policy_check_results"."entry" = 'RUN_END' and "policy_check_results"."rule_id" is null and "policy_check_results"."severity" is null and "policy_check_results"."reason_code" is null and "policy_check_results"."flag_text" is null and "policy_check_results"."line_id" is null and "policy_check_results"."fund_id" is null))
);
--> statement-breakpoint
CREATE TABLE "policy_check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_hash" text NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"started_by" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settings_versions" jsonb NOT NULL,
	"rule_set_version" text NOT NULL,
	"facts_digest" text NOT NULL,
	"model" text,
	"effort" text,
	"prompt_version" text,
	"schema_version" text,
	"clause_set_hash" text,
	"request_digest" text,
	CONSTRAINT "policy_run_per_decision_kind" UNIQUE("decision_hash","kind"),
	CONSTRAINT "policy_run_kind" CHECK ("policy_check_runs"."kind" in ('RULES','MODEL')),
	CONSTRAINT "policy_run_settings_object" CHECK (jsonb_typeof("policy_check_runs"."settings_versions") = 'object'),
	CONSTRAINT "policy_run_facts_digest" CHECK ("policy_check_runs"."facts_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "policy_run_model_columns" CHECK (("policy_check_runs"."kind" = 'RULES' and "policy_check_runs"."model" is null and "policy_check_runs"."effort" is null and "policy_check_runs"."prompt_version" is null and "policy_check_runs"."schema_version" is null and "policy_check_runs"."clause_set_hash" is null and "policy_check_runs"."request_digest" is null) or ("policy_check_runs"."kind" = 'MODEL' and "policy_check_runs"."model" is not null and "policy_check_runs"."effort" is not null and "policy_check_runs"."prompt_version" is not null and "policy_check_runs"."schema_version" is not null and "policy_check_runs"."clause_set_hash" is not null and "policy_check_runs"."request_digest" is not null))
);
--> statement-breakpoint
ALTER TABLE "fund_check_settings" ADD CONSTRAINT "fund_check_settings_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_check_settings" ADD CONSTRAINT "fund_check_settings_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_results" ADD CONSTRAINT "policy_check_results_run_id_policy_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."policy_check_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_results" ADD CONSTRAINT "policy_check_results_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_results" ADD CONSTRAINT "policy_check_results_fund_id_settings_version_fund_check_settings_fund_id_version_fk" FOREIGN KEY ("fund_id","settings_version") REFERENCES "public"."fund_check_settings"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_check_runs_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_check_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_check_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_check_runs" ADD CONSTRAINT "policy_check_runs_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- IAC-405 step 1 (docs/plans/POLICY_CHECK_SCOPE.md section 4). Hand-written guards, appended after the generated DDL as migrations
-- 0006, 0009, 0010 and 0014 did. All three tables are immutable: no update, no delete, no truncate. A run is written once and its
-- outcome is a later result row, so no row ever needs to change. Only RULES runs are accepted in this release: the MODEL kind
-- stays in the CHECK constraint as the seam for the later model check, and a later migration replaces these guard functions.
-- Nothing here touches an existing table, and no guard reads or writes an approval, a reservation or a journal entry.
CREATE FUNCTION aidtrace_fund_check_settings_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approver_row users%ROWTYPE;
  fund_row funds%ROWTYPE;
  latest integer;
BEGIN
  SELECT * INTO approver_row FROM users WHERE id = NEW.approved_by;
  SELECT * INTO fund_row FROM funds WHERE id = NEW.fund_id;
  IF approver_row.id IS NULL OR fund_row.id IS NULL OR approver_row.role IS DISTINCT FROM 'APPROVER' OR approver_row.organization_id IS DISTINCT FROM fund_row.organization_id THEN
    RAISE EXCEPTION 'Fund check settings are approved by an approver of the fund organization' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(version), 0) INTO latest FROM fund_check_settings WHERE fund_id = NEW.fund_id;
  IF NEW.version <> latest + 1 THEN
    RAISE EXCEPTION 'Fund check settings are versioned in order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fund_check_settings_insert_guard BEFORE INSERT ON fund_check_settings FOR EACH ROW EXECUTE FUNCTION aidtrace_fund_check_settings_insert_guard();
--> statement-breakpoint
CREATE TRIGGER fund_check_settings_immutable BEFORE UPDATE OR DELETE ON fund_check_settings FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER fund_check_settings_no_truncate BEFORE TRUNCATE ON fund_check_settings FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_policy_run_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  starter_row users%ROWTYPE;
  claim_row claims%ROWTYPE;
BEGIN
  IF NEW.kind IS DISTINCT FROM 'RULES' THEN
    RAISE EXCEPTION 'Only rule checks are recorded in this release' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO starter_row FROM users WHERE id = NEW.started_by;
  SELECT * INTO claim_row FROM claims WHERE id = NEW.claim_id AND version = NEW.claim_version;
  IF starter_row.id IS NULL OR claim_row.id IS NULL OR starter_row.role IS DISTINCT FROM 'APPROVER' OR starter_row.organization_id IS DISTINCT FROM claim_row.organization_id OR starter_row.id = claim_row.claimant_id OR NEW.organization_id IS DISTINCT FROM claim_row.organization_id THEN
    RAISE EXCEPTION 'Policy checks are started by an approver of the claim organization who is not the claimant' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM allocation_decisions WHERE decision_hash = NEW.decision_hash AND claim_id = NEW.claim_id AND claim_version = NEW.claim_version AND organization_id = NEW.organization_id AND invalidated_at IS NULL) THEN
    RAISE EXCEPTION 'Policy checks need the current frozen decision of their claim version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER policy_run_insert_guard BEFORE INSERT ON policy_check_runs FOR EACH ROW EXECUTE FUNCTION aidtrace_policy_run_insert_guard();
--> statement-breakpoint
CREATE TRIGGER policy_run_immutable BEFORE UPDATE OR DELETE ON policy_check_runs FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER policy_run_no_truncate BEFORE TRUNCATE ON policy_check_runs FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_policy_result_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_sequence integer;
  ended boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policy_check_runs WHERE id = NEW.run_id AND kind = 'RULES') THEN
    RAISE EXCEPTION 'Policy check rows belong to a rules run' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(sequence), 0), coalesce(bool_or(entry = 'RUN_END'), false) INTO last_sequence, ended FROM policy_check_results WHERE run_id = NEW.run_id;
  IF ended THEN
    RAISE EXCEPTION 'A finished policy check run accepts no more rows' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence <> last_sequence + 1 THEN
    RAISE EXCEPTION 'Policy check rows are numbered in order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER policy_result_insert_guard BEFORE INSERT ON policy_check_results FOR EACH ROW EXECUTE FUNCTION aidtrace_policy_result_insert_guard();
--> statement-breakpoint
CREATE TRIGGER policy_result_immutable BEFORE UPDATE OR DELETE ON policy_check_results FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER policy_result_no_truncate BEFORE TRUNCATE ON policy_check_results FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
