CREATE TABLE "policy_draft_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"bound_policy_version" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_event_kind" CHECK ("policy_draft_events"."kind" in ('APPROVED','BOUND','WITHDRAWN')),
	CONSTRAINT "draft_event_bound_version" CHECK (("policy_draft_events"."kind" = 'BOUND') = ("policy_draft_events"."bound_policy_version" is not null) and ("policy_draft_events"."bound_policy_version" is null or "policy_draft_events"."bound_policy_version" > 1))
);
--> statement-breakpoint
CREATE TABLE "policy_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fund_id" text NOT NULL,
	"base_policy_version" integer NOT NULL,
	"parent_draft_id" uuid,
	"input_sha256" text NOT NULL,
	"input_text" text NOT NULL,
	"outcome" text NOT NULL,
	"draft" jsonb,
	"refusal_reason" text,
	"refusal_path" text,
	"changed_fields" jsonb,
	"model" text,
	"effort" text,
	"prompt_version" text,
	"schema_version" text,
	"request_digest" text,
	"stop_reason" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"drafted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_input_bounded" CHECK (char_length("policy_drafts"."input_text") between 1 and 20000 and btrim("policy_drafts"."input_text", E' \n\r\t') <> ''),
	CONSTRAINT "draft_input_hash" CHECK ("policy_drafts"."input_sha256" = encode(sha256(convert_to("policy_drafts"."input_text", 'UTF8')), 'hex')),
	CONSTRAINT "draft_outcome" CHECK ("policy_drafts"."outcome" in ('DRAFTED','REFUSED')),
	CONSTRAINT "draft_outcome_shape" CHECK (("policy_drafts"."outcome" = 'DRAFTED' and "policy_drafts"."draft" is not null and jsonb_typeof("policy_drafts"."draft") = 'object' and "policy_drafts"."refusal_reason" is null and "policy_drafts"."refusal_path" is null)
    or ("policy_drafts"."outcome" = 'REFUSED' and "policy_drafts"."draft" is null and "policy_drafts"."refusal_reason" ~ '^[A-Z_]{1,40}$' and "policy_drafts"."refusal_path" ~ '^[A-Za-z0-9_.]{1,80}$' and "policy_drafts"."parent_draft_id" is null and "policy_drafts"."changed_fields" is null)),
	CONSTRAINT "draft_edit_shape" CHECK (("policy_drafts"."parent_draft_id" is null and "policy_drafts"."changed_fields" is null
      and "policy_drafts"."model" is not null and "policy_drafts"."effort" is not null and "policy_drafts"."prompt_version" is not null and "policy_drafts"."schema_version" is not null and "policy_drafts"."request_digest" is not null)
    or ("policy_drafts"."parent_draft_id" is not null and "policy_drafts"."outcome" = 'DRAFTED' and "policy_drafts"."changed_fields" is not null and jsonb_typeof("policy_drafts"."changed_fields") = 'array' and jsonb_array_length("policy_drafts"."changed_fields") > 0
      and "policy_drafts"."model" is null and "policy_drafts"."effort" is null and "policy_drafts"."prompt_version" is null and "policy_drafts"."schema_version" is null and "policy_drafts"."request_digest" is null and "policy_drafts"."stop_reason" is null and "policy_drafts"."input_tokens" is null and "policy_drafts"."output_tokens" is null)),
	CONSTRAINT "draft_digest" CHECK ("policy_drafts"."request_digest" is null or "policy_drafts"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "draft_stop_reason" CHECK ("policy_drafts"."stop_reason" is null or "policy_drafts"."stop_reason" ~ '^[a-z_]{1,40}$'),
	CONSTRAINT "draft_counts" CHECK (("policy_drafts"."input_tokens" is null or "policy_drafts"."input_tokens" >= 0) and ("policy_drafts"."output_tokens" is null or "policy_drafts"."output_tokens" >= 0))
);
--> statement-breakpoint
ALTER TABLE "policy_draft_events" ADD CONSTRAINT "policy_draft_events_draft_id_policy_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."policy_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_draft_events" ADD CONSTRAINT "policy_draft_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_drafted_by_users_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_fund_id_base_policy_version_fund_policy_versions_fund_id_version_fk" FOREIGN KEY ("fund_id","base_policy_version") REFERENCES "public"."fund_policy_versions"("fund_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_drafts" ADD CONSTRAINT "policy_drafts_parent_draft_id_policy_drafts_id_fk" FOREIGN KEY ("parent_draft_id") REFERENCES "public"."policy_drafts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "draft_event_one_approval_per_person" ON "policy_draft_events" USING btree ("draft_id","actor_id") WHERE "policy_draft_events"."kind" = 'APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX "draft_event_one_bound" ON "policy_draft_events" USING btree ("draft_id") WHERE "policy_draft_events"."kind" = 'BOUND';--> statement-breakpoint
CREATE UNIQUE INDEX "draft_event_one_withdrawn" ON "policy_draft_events" USING btree ("draft_id") WHERE "policy_draft_events"."kind" = 'WITHDRAWN';
--> statement-breakpoint
-- IAC-440 Package A. Hand-written guards, appended after the
-- generated DDL as migrations 0014 to 0017 did. Both new tables are immutable: no update, no delete, no truncate. Status is derived from the event
-- rows. Nothing here touches an existing table, and no guard reads or writes an approval, a reservation, a claim or a journal entry. No guard
-- of an existing table is changed: binding a draft writes fund_policy_versions, fund_budget_lines, fund_check_settings and fund_policy_clauses
-- through their own existing guards (the approver of the fund organization, versions in order, an existing policy version).
CREATE FUNCTION aidtrace_policy_draft_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  drafter users%ROWTYPE;
  fund_row funds%ROWTYPE;
  parent_row policy_drafts%ROWTYPE;
BEGIN
  SELECT * INTO drafter FROM users WHERE id = NEW.drafted_by;
  SELECT * INTO fund_row FROM funds WHERE id = NEW.fund_id;
  IF drafter.id IS NULL OR fund_row.id IS NULL OR drafter.role IS DISTINCT FROM 'APPROVER' OR drafter.organization_id IS DISTINCT FROM fund_row.organization_id THEN
    RAISE EXCEPTION 'Rule drafts are made by an approver of the fund organization' USING ERRCODE = '23514';
  END IF;
  IF fund_row.fund_class IS DISTINCT FROM 'RESTRICTED' THEN
    RAISE EXCEPTION 'Rule drafts are for restricted funds' USING ERRCODE = '23514';
  END IF;
  IF NEW.base_policy_version IS DISTINCT FROM fund_row.current_policy_version THEN
    RAISE EXCEPTION 'A rule draft is made against the current policy version of its fund' USING ERRCODE = '23514';
  END IF;
  IF NEW.parent_draft_id IS NOT NULL THEN
    SELECT * INTO parent_row FROM policy_drafts WHERE id = NEW.parent_draft_id;
    IF parent_row.id IS NULL OR parent_row.outcome IS DISTINCT FROM 'DRAFTED' OR parent_row.fund_id IS DISTINCT FROM NEW.fund_id
      OR parent_row.base_policy_version IS DISTINCT FROM NEW.base_policy_version OR parent_row.input_sha256 IS DISTINCT FROM NEW.input_sha256 THEN
      RAISE EXCEPTION 'An edit changes a drafted rule set of the same fund, base version and grant text' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER policy_draft_insert_guard BEFORE INSERT ON policy_drafts FOR EACH ROW EXECUTE FUNCTION aidtrace_policy_draft_insert_guard();
--> statement-breakpoint
CREATE TRIGGER policy_draft_immutable BEFORE UPDATE OR DELETE ON policy_drafts FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER policy_draft_no_truncate BEFORE TRUNCATE ON policy_drafts FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_policy_draft_event_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actor_row users%ROWTYPE;
  draft_row policy_drafts%ROWTYPE;
  fund_row funds%ROWTYPE;
  approvers integer;
BEGIN
  SELECT * INTO draft_row FROM policy_drafts WHERE id = NEW.draft_id;
  SELECT * INTO fund_row FROM funds WHERE id = draft_row.fund_id;
  SELECT * INTO actor_row FROM users WHERE id = NEW.actor_id;
  IF draft_row.id IS NULL OR fund_row.id IS NULL OR actor_row.id IS NULL OR actor_row.role IS DISTINCT FROM 'APPROVER' OR actor_row.organization_id IS DISTINCT FROM fund_row.organization_id THEN
    RAISE EXCEPTION 'Draft events are recorded by an approver of the fund organization' USING ERRCODE = '23514';
  END IF;
  IF draft_row.outcome IS DISTINCT FROM 'DRAFTED' THEN
    RAISE EXCEPTION 'Only a drafted rule set takes events' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM policy_draft_events WHERE draft_id = NEW.draft_id AND kind IN ('BOUND', 'WITHDRAWN')) THEN
    RAISE EXCEPTION 'A bound or withdrawn draft takes no more events' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'APPROVED' AND draft_row.base_policy_version IS DISTINCT FROM fund_row.current_policy_version THEN
    RAISE EXCEPTION 'A stale draft takes no approvals' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'BOUND' THEN
    SELECT count(DISTINCT actor_id) INTO approvers FROM policy_draft_events WHERE draft_id = NEW.draft_id AND kind = 'APPROVED';
    IF approvers < 2 OR NOT EXISTS (SELECT 1 FROM policy_draft_events WHERE draft_id = NEW.draft_id AND kind = 'APPROVED' AND actor_id = NEW.actor_id)
      OR NEW.bound_policy_version IS DISTINCT FROM draft_row.base_policy_version + 1 OR fund_row.current_policy_version IS DISTINCT FROM NEW.bound_policy_version
      OR NOT EXISTS (SELECT 1 FROM fund_policy_versions WHERE fund_id = draft_row.fund_id AND version = NEW.bound_policy_version AND approved_by = NEW.actor_id) THEN
      RAISE EXCEPTION 'A draft binds after two distinct approvals, as the next version, and only the binding approver is recorded' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER policy_draft_event_insert_guard BEFORE INSERT ON policy_draft_events FOR EACH ROW EXECUTE FUNCTION aidtrace_policy_draft_event_insert_guard();
--> statement-breakpoint
CREATE TRIGGER policy_draft_event_immutable BEFORE UPDATE OR DELETE ON policy_draft_events FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER policy_draft_event_no_truncate BEFORE TRUNCATE ON policy_draft_events FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
