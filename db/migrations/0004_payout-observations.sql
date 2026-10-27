CREATE TABLE "claim_rejections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"rejected_by" text NOT NULL,
	"reason" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rejection_per_claim_version" UNIQUE("claim_id","claim_version"),
	CONSTRAINT "rejection_reason_length" CHECK (length(trim("claim_rejections"."reason")) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "allocation_decisions" ADD COLUMN "comparison" jsonb;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "last_http_status" integer;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "last_polled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "provider_balance_cents" bigint;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "provider_balance_as_of" text;--> statement-breakpoint
ALTER TABLE "disbursement_attempts" ADD COLUMN "settled_on" date;--> statement-breakpoint
ALTER TABLE "claim_rejections" ADD CONSTRAINT "claim_rejections_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_rejections" ADD CONSTRAINT "claim_rejections_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TRIGGER rejection_immutable BEFORE UPDATE OR DELETE ON claim_rejections FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER rejection_no_truncate BEFORE TRUNCATE ON claim_rejections FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER disbursement_immutable BEFORE UPDATE OR DELETE ON disbursements FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_attempt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.disbursement_id IS DISTINCT FROM OLD.disbursement_id OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number OR NEW.sender_batch_id IS DISTINCT FROM OLD.sender_batch_id OR NEW.sender_item_id IS DISTINCT FROM OLD.sender_item_id OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.payee_email IS DISTINCT FROM OLD.payee_email OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'Persisted payout identity and terms are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.payout_batch_id IS NOT NULL AND NEW.payout_batch_id IS DISTINCT FROM OLD.payout_batch_id THEN RAISE EXCEPTION 'Known payout batch ID is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.payout_item_id IS NOT NULL AND NEW.payout_item_id IS DISTINCT FROM OLD.payout_item_id THEN RAISE EXCEPTION 'Known payout item ID is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.settled_on IS NOT NULL AND NEW.settled_on IS DISTINCT FROM OLD.settled_on THEN RAISE EXCEPTION 'Settlement date is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.fee_cents IS NOT NULL AND NEW.fee_cents IS DISTINCT FROM OLD.fee_cents THEN RAISE EXCEPTION 'Recorded fee changes require manual review' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_identity_guard BEFORE UPDATE ON disbursement_attempts FOR EACH ROW EXECUTE FUNCTION aidtrace_attempt_identity_guard();
--> statement-breakpoint
CREATE TRIGGER attempt_delete_guard BEFORE DELETE ON disbursement_attempts FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER attempt_no_truncate BEFORE TRUNCATE ON disbursement_attempts FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER disbursement_no_truncate BEFORE TRUNCATE ON disbursements FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
