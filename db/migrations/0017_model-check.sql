CREATE TABLE "fund_policy_clauses" (
	"fund_id" text NOT NULL,
	"policy_version" integer NOT NULL,
	"clause_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fund_policy_clauses_fund_id_policy_version_clause_id_pk" PRIMARY KEY("fund_id","policy_version","clause_id"),
	CONSTRAINT "clause_id_shape" CHECK ("fund_policy_clauses"."clause_id" ~ '^[0-9]{1,2}[.][0-9]{1,2}$'),
	CONSTRAINT "clause_text_bounded" CHECK (char_length("fund_policy_clauses"."text") between 1 and 600 and "fund_policy_clauses"."text" = btrim("fund_policy_clauses"."text"))
);
--> statement-breakpoint
CREATE TABLE "policy_model_results" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"entry" text NOT NULL,
	"fund_id" text,
	"policy_version" integer,
	"line_id" text,
	"verdict" text,
	"clause_id" text,
	"model" text,
	"effort" text,
	"reason_code" text,
	"request_digest" text,
	"stop_reason" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_model_results_run_id_sequence_pk" PRIMARY KEY("run_id","sequence"),
	CONSTRAINT "model_result_sequence" CHECK ("policy_model_results"."sequence" > 0),
	CONSTRAINT "model_result_entry" CHECK ("policy_model_results"."entry" in ('CALL','LINE','NOT_CHECKED','SKIPPED','RUN_END')),
	CONSTRAINT "model_result_verdict" CHECK ("policy_model_results"."verdict" is null or "policy_model_results"."verdict" in ('OK','CONFLICT','UNSURE')),
	CONSTRAINT "model_result_reason" CHECK ("policy_model_results"."reason_code" is null or "policy_model_results"."reason_code" in ('TIMEOUT','UNAVAILABLE','INVALID','LIMIT','NO_CLAUSES','GENERAL_FUND')),
	CONSTRAINT "model_result_fund_version" CHECK (("policy_model_results"."fund_id" is null) = ("policy_model_results"."policy_version" is null)),
	CONSTRAINT "model_result_clause_scope" CHECK ("policy_model_results"."clause_id" is null or "policy_model_results"."fund_id" is not null),
	CONSTRAINT "model_result_model_effort" CHECK (("policy_model_results"."model" is null) = ("policy_model_results"."effort" is null)),
	CONSTRAINT "model_result_digest" CHECK ("policy_model_results"."request_digest" is null or "policy_model_results"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "model_result_counts" CHECK (("policy_model_results"."input_tokens" is null or "policy_model_results"."input_tokens" >= 0) and ("policy_model_results"."output_tokens" is null or "policy_model_results"."output_tokens" >= 0)),
	CONSTRAINT "model_result_shape" CHECK (("policy_model_results"."entry" = 'CALL' and "policy_model_results"."fund_id" is not null and "policy_model_results"."model" is not null and "policy_model_results"."request_digest" is not null and "policy_model_results"."line_id" is null and "policy_model_results"."verdict" is null and "policy_model_results"."clause_id" is null and ("policy_model_results"."reason_code" is null or "policy_model_results"."reason_code" in ('TIMEOUT','UNAVAILABLE','INVALID')))
    or ("policy_model_results"."entry" = 'LINE' and "policy_model_results"."fund_id" is not null and "policy_model_results"."model" is not null and "policy_model_results"."line_id" is not null and "policy_model_results"."verdict" is not null and "policy_model_results"."reason_code" is null and "policy_model_results"."request_digest" is null and "policy_model_results"."stop_reason" is null and "policy_model_results"."input_tokens" is null and "policy_model_results"."output_tokens" is null
      and (("policy_model_results"."verdict" = 'OK' and "policy_model_results"."clause_id" is null) or "policy_model_results"."verdict" = 'UNSURE' or ("policy_model_results"."verdict" = 'CONFLICT' and "policy_model_results"."clause_id" is not null)))
    or ("policy_model_results"."entry" = 'NOT_CHECKED' and "policy_model_results"."fund_id" is not null and "policy_model_results"."reason_code" in ('TIMEOUT','UNAVAILABLE','INVALID','LIMIT','NO_CLAUSES') and "policy_model_results"."line_id" is null and "policy_model_results"."verdict" is null and "policy_model_results"."clause_id" is null and "policy_model_results"."request_digest" is null and "policy_model_results"."stop_reason" is null and "policy_model_results"."input_tokens" is null and "policy_model_results"."output_tokens" is null and (("policy_model_results"."reason_code" = 'NO_CLAUSES') = ("policy_model_results"."model" is null)))
    or ("policy_model_results"."entry" = 'SKIPPED' and "policy_model_results"."fund_id" is not null and "policy_model_results"."reason_code" = 'GENERAL_FUND' and "policy_model_results"."model" is null and "policy_model_results"."line_id" is null and "policy_model_results"."verdict" is null and "policy_model_results"."clause_id" is null and "policy_model_results"."request_digest" is null and "policy_model_results"."stop_reason" is null and "policy_model_results"."input_tokens" is null and "policy_model_results"."output_tokens" is null)
    or ("policy_model_results"."entry" = 'RUN_END' and "policy_model_results"."fund_id" is null and "policy_model_results"."model" is null and "policy_model_results"."line_id" is null and "policy_model_results"."verdict" is null and "policy_model_results"."clause_id" is null and "policy_model_results"."reason_code" is null and "policy_model_results"."request_digest" is null and "policy_model_results"."stop_reason" is null and "policy_model_results"."input_tokens" is null and "policy_model_results"."output_tokens" is null))
);
--> statement-breakpoint
ALTER TABLE "fund_policy_clauses" ADD CONSTRAINT "fund_policy_clauses_fund_id_policy_version_fund_policy_versions_fund_id_version_fk" FOREIGN KEY ("fund_id","policy_version") REFERENCES "public"."fund_policy_versions"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_model_results" ADD CONSTRAINT "policy_model_results_run_id_policy_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."policy_check_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_model_results" ADD CONSTRAINT "policy_model_results_fund_id_policy_version_fund_policy_versions_fund_id_version_fk" FOREIGN KEY ("fund_id","policy_version") REFERENCES "public"."fund_policy_versions"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_model_results" ADD CONSTRAINT "policy_model_results_fund_id_policy_version_clause_id_fund_policy_clauses_fund_id_policy_version_clause_id_fk" FOREIGN KEY ("fund_id","policy_version","clause_id") REFERENCES "public"."fund_policy_clauses"("fund_id","policy_version","clause_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- IAC-405 step 1 piece G and N1. Hand-written guards,
-- appended after the generated DDL as migrations 0014, 0015 and 0016 did. Both new tables are immutable: no update, no delete, no
-- truncate. Migration 0015 is not edited: its run guard is replaced here with CREATE OR REPLACE so a MODEL run is accepted under the
-- same unique (decision_hash, kind) rule, and its result guard stays rules only because model rows live in policy_model_results.
-- Nothing here touches an existing table, and no guard reads or writes an approval, a reservation or a journal entry.
CREATE FUNCTION aidtrace_fund_policy_clause_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fund_policy_versions WHERE fund_id = NEW.fund_id AND version = NEW.policy_version) THEN
    RAISE EXCEPTION 'A clause belongs to an existing policy version of its fund' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER fund_policy_clause_insert_guard BEFORE INSERT ON fund_policy_clauses FOR EACH ROW EXECUTE FUNCTION aidtrace_fund_policy_clause_insert_guard();
--> statement-breakpoint
CREATE TRIGGER fund_policy_clause_immutable BEFORE UPDATE OR DELETE ON fund_policy_clauses FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER fund_policy_clause_no_truncate BEFORE TRUNCATE ON fund_policy_clauses FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION aidtrace_policy_run_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  starter_row users%ROWTYPE;
  claim_row claims%ROWTYPE;
BEGIN
  IF NEW.kind IS NULL OR NEW.kind NOT IN ('RULES', 'MODEL') THEN
    RAISE EXCEPTION 'Policy check runs are rule checks or model checks' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO starter_row FROM users WHERE id = NEW.started_by;
  SELECT * INTO claim_row FROM claims WHERE id = NEW.claim_id AND version = NEW.claim_version;
  IF starter_row.id IS NULL OR claim_row.id IS NULL OR starter_row.role IS DISTINCT FROM 'APPROVER' OR starter_row.organization_id IS DISTINCT FROM claim_row.organization_id OR starter_row.id = claim_row.claimant_id OR NEW.organization_id IS DISTINCT FROM claim_row.organization_id THEN
    RAISE EXCEPTION 'Policy checks are started by an approver of the claim organization who is not the claimant' USING ERRCODE = '23514';
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
--> statement-breakpoint
CREATE FUNCTION aidtrace_policy_model_result_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_sequence integer;
  ended boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policy_check_runs WHERE id = NEW.run_id AND kind = 'MODEL') THEN
    RAISE EXCEPTION 'Model check rows belong to a model run' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(max(sequence), 0), coalesce(bool_or(entry = 'RUN_END'), false) INTO last_sequence, ended FROM policy_model_results WHERE run_id = NEW.run_id;
  IF ended THEN
    RAISE EXCEPTION 'A finished model check run accepts no more rows' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence <> last_sequence + 1 THEN
    RAISE EXCEPTION 'Model check rows are numbered in order' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER policy_model_result_insert_guard BEFORE INSERT ON policy_model_results FOR EACH ROW EXECUTE FUNCTION aidtrace_policy_model_result_insert_guard();
--> statement-breakpoint
CREATE TRIGGER policy_model_result_immutable BEFORE UPDATE OR DELETE ON policy_model_results FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER policy_model_result_no_truncate BEFORE TRUNCATE ON policy_model_results FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
