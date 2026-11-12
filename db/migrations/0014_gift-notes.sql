CREATE TABLE "gift_applications" (
	"note_id" uuid NOT NULL,
	"capture_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"line_id" text NOT NULL,
	"fund_id" text NOT NULL,
	"applied_cents" bigint NOT NULL,
	"policy_version" text NOT NULL,
	CONSTRAINT "gift_applications_note_id_line_id_fund_id_pk" PRIMARY KEY("note_id","line_id","fund_id"),
	CONSTRAINT "gift_application_positive" CHECK ("gift_applications"."applied_cents" > 0),
	CONSTRAINT "gift_application_policy" CHECK ("gift_applications"."policy_version" = 'GIFT_ATTRIBUTION_V1')
);
--> statement-breakpoint
CREATE TABLE "gift_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"decision_hash" text NOT NULL,
	"fact_set_version" text NOT NULL,
	"fact_digest" text NOT NULL,
	"template_id" text NOT NULL,
	"optional_fact_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"rendered_text" text NOT NULL,
	"text_hash" text NOT NULL,
	"mode" text NOT NULL,
	"model_metadata" jsonb,
	"approver_id" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payout_status" text NOT NULL,
	"policy_version" text NOT NULL,
	CONSTRAINT "gift_note_identity" UNIQUE("id","capture_id","claim_id","claim_version"),
	CONSTRAINT "gift_note_facts_unique" UNIQUE("capture_id","claim_id","claim_version","fact_digest"),
	CONSTRAINT "gift_note_fact_set" CHECK ("gift_notes"."fact_set_version" = 'donor-note-facts-v1'),
	CONSTRAINT "gift_note_policy" CHECK ("gift_notes"."policy_version" = 'GIFT_ATTRIBUTION_V1'),
	CONSTRAINT "gift_note_mode" CHECK ("gift_notes"."mode" in ('TEMPLATE','AI')),
	CONSTRAINT "gift_note_model_metadata" CHECK (("gift_notes"."mode" = 'AI') or ("gift_notes"."model_metadata" is null)),
	CONSTRAINT "gift_note_hashes" CHECK ("gift_notes"."fact_digest" ~ '^[a-f0-9]{64}$' and "gift_notes"."text_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gift_note_payout_status" CHECK ("gift_notes"."payout_status" in ('NO_PAYMENT','PROCESSING','UNKNOWN','NEEDS_ATTENTION','PAID')),
	CONSTRAINT "gift_note_text_bounded" CHECK (char_length("gift_notes"."rendered_text") between 1 and 8000)
);
--> statement-breakpoint
ALTER TABLE "gift_applications" ADD CONSTRAINT "gift_applications_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_applications" ADD CONSTRAINT "gift_applications_note_id_capture_id_claim_id_claim_version_gift_notes_id_capture_id_claim_id_claim_version_fk" FOREIGN KEY ("note_id","capture_id","claim_id","claim_version") REFERENCES "public"."gift_notes"("id","capture_id","claim_id","claim_version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_applications" ADD CONSTRAINT "gift_applications_claim_id_claim_version_line_id_claim_lines_claim_id_claim_version_id_fk" FOREIGN KEY ("claim_id","claim_version","line_id") REFERENCES "public"."claim_lines"("claim_id","claim_version","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_notes" ADD CONSTRAINT "gift_notes_capture_id_donation_receipts_capture_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."donation_receipts"("capture_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_notes" ADD CONSTRAINT "gift_notes_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_notes" ADD CONSTRAINT "gift_notes_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_notes" ADD CONSTRAINT "gift_notes_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- IAC-379 step 3b. Hand-written guards, appended after the generated DDL as
-- migrations 0006, 0009 and 0010 did. Both tables are immutable: no update, no delete, no truncate. Staleness is computed when
-- a note is read, so no row ever needs to change. The insert guards restate the approval rule in the database: the approver
-- is an APPROVER of the claim's organization and not its claimant, the gift is a COMPLETED capture of the same organization,
-- the decision is recognized and current, and each application stays inside its allocation edge and the gift amount.
CREATE FUNCTION aidtrace_gift_note_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  approver_row users%ROWTYPE;
  claim_row claims%ROWTYPE;
  receipt_row donation_receipts%ROWTYPE;
BEGIN
  SELECT * INTO approver_row FROM users WHERE id = NEW.approver_id;
  SELECT * INTO claim_row FROM claims WHERE id = NEW.claim_id AND version = NEW.claim_version;
  SELECT * INTO receipt_row FROM donation_receipts WHERE capture_id = NEW.capture_id;
  IF approver_row.id IS NULL OR claim_row.id IS NULL OR approver_row.role IS DISTINCT FROM 'APPROVER' OR approver_row.organization_id IS DISTINCT FROM claim_row.organization_id OR approver_row.id = claim_row.claimant_id THEN
    RAISE EXCEPTION 'A donor note is approved by an approver of the claim organization who is not the claimant' USING ERRCODE = '23514';
  END IF;
  IF receipt_row.capture_id IS NULL OR receipt_row.status IS DISTINCT FROM 'COMPLETED' OR receipt_row.organization_id IS DISTINCT FROM claim_row.organization_id THEN
    RAISE EXCEPTION 'A donor note names a completed gift of the claim organization' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM allocation_decisions WHERE decision_hash = NEW.decision_hash AND claim_id = NEW.claim_id AND claim_version = NEW.claim_version AND recognized_at IS NOT NULL AND invalidated_at IS NULL) THEN
    RAISE EXCEPTION 'A donor note needs the recognized decision of its claim version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gift_note_insert_guard BEFORE INSERT ON gift_notes FOR EACH ROW EXECUTE FUNCTION aidtrace_gift_note_insert_guard();
--> statement-breakpoint
CREATE TRIGGER gift_note_immutable BEFORE UPDATE OR DELETE ON gift_notes FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER gift_note_no_truncate BEFORE TRUNCATE ON gift_notes FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_gift_application_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  gross bigint;
BEGIN
  SELECT gross_cents INTO gross FROM donation_receipts WHERE capture_id = NEW.capture_id AND fund_id = NEW.fund_id AND status = 'COMPLETED';
  IF gross IS NULL THEN
    RAISE EXCEPTION 'A gift application names a completed gift to the same fund' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM gift_notes n JOIN allocation_decisions d ON d.decision_hash = n.decision_hash JOIN allocation_edges e ON e.decision_id = d.id WHERE n.id = NEW.note_id AND e.line_id = NEW.line_id AND e.fund_id = NEW.fund_id AND e.amount_cents >= NEW.applied_cents) THEN
    RAISE EXCEPTION 'A gift application stays inside its allocation edge' USING ERRCODE = '23514';
  END IF;
  IF (SELECT coalesce(sum(applied_cents), 0) FROM gift_applications WHERE note_id = NEW.note_id) + NEW.applied_cents > gross THEN
    RAISE EXCEPTION 'Gift applications cannot exceed the gift amount' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gift_application_insert_guard BEFORE INSERT ON gift_applications FOR EACH ROW EXECUTE FUNCTION aidtrace_gift_application_insert_guard();
--> statement-breakpoint
CREATE TRIGGER gift_application_immutable BEFORE UPDATE OR DELETE ON gift_applications FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER gift_application_no_truncate BEFORE TRUNCATE ON gift_applications FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
