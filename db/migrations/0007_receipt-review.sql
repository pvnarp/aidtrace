CREATE TABLE "receipt_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"suggestion_id" uuid,
	"confirmed_by" text NOT NULL,
	"terms_hash" text NOT NULL,
	"selections" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_confirmations_review_id_unique" UNIQUE("review_id"),
	CONSTRAINT "receipt_confirmation_hash" CHECK ("receipt_confirmations"."terms_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "receipt_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"revision" integer NOT NULL,
	"source" text NOT NULL,
	"source_hash" text NOT NULL,
	"draft_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_reviews_claim_id_claim_version_revision_unique" UNIQUE("claim_id","claim_version","revision"),
	CONSTRAINT "receipt_claim_namespace" CHECK ("receipt_reviews"."claim_id" ~ '^R-[a-f0-9-]{36}$'),
	CONSTRAINT "receipt_revision_positive" CHECK ("receipt_reviews"."revision" > 0),
	CONSTRAINT "receipt_source_bounded" CHECK (octet_length("receipt_reviews"."source") between 1 and 16384),
	CONSTRAINT "receipt_hashes" CHECK ("receipt_reviews"."source_hash" ~ '^[a-f0-9]{64}$' and "receipt_reviews"."draft_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "receipt_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"proposals" jsonb,
	"audit" jsonb,
	"error_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_suggestions_review_id_attempt_unique" UNIQUE("review_id","attempt"),
	CONSTRAINT "receipt_attempt_positive" CHECK ("receipt_suggestions"."attempt" > 0),
	CONSTRAINT "receipt_suggestion_status" CHECK ("receipt_suggestions"."status" in ('RUNNING','READY','FAILED')),
	CONSTRAINT "receipt_ready_evidence" CHECK ("receipt_suggestions"."status" <> 'READY' or ("receipt_suggestions"."proposals" is not null and "receipt_suggestions"."audit" is not null))
);
--> statement-breakpoint
ALTER TABLE "receipt_confirmations" ADD CONSTRAINT "receipt_confirmations_review_id_receipt_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."receipt_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_confirmations" ADD CONSTRAINT "receipt_confirmations_suggestion_id_receipt_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."receipt_suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_confirmations" ADD CONSTRAINT "receipt_confirmations_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_suggestions" ADD CONSTRAINT "receipt_suggestions_review_id_receipt_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."receipt_reviews"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Immutable receipt history is separate from editable, unpaid claim terms.
CREATE TRIGGER receipt_review_immutable BEFORE UPDATE OR DELETE ON receipt_reviews FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER receipt_confirmation_immutable BEFORE UPDATE OR DELETE ON receipt_confirmations FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_receipt_suggestion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Receipt suggestion history is immutable'; END IF;
  IF OLD.status <> 'RUNNING' OR NEW.status NOT IN ('READY','FAILED') OR
     NEW.id <> OLD.id OR NEW.review_id <> OLD.review_id OR NEW.attempt <> OLD.attempt OR NEW.recorded_at <> OLD.recorded_at THEN
    RAISE EXCEPTION 'Only completion of an existing receipt suggestion is permitted';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER receipt_suggestion_transition BEFORE UPDATE OR DELETE ON receipt_suggestions FOR EACH ROW EXECUTE FUNCTION aidtrace_receipt_suggestion_transition();
--> statement-breakpoint
CREATE FUNCTION aidtrace_receipt_confirmation_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.suggestion_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipt_suggestions WHERE id = NEW.suggestion_id AND review_id = NEW.review_id) THEN
    RAISE EXCEPTION 'Suggestion does not belong to this review';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER receipt_confirmation_review BEFORE INSERT ON receipt_confirmations FOR EACH ROW EXECUTE FUNCTION aidtrace_receipt_confirmation_review();
--> statement-breakpoint
CREATE TRIGGER receipt_review_no_truncate BEFORE TRUNCATE ON receipt_reviews FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER receipt_suggestion_no_truncate BEFORE TRUNCATE ON receipt_suggestions FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER receipt_confirmation_no_truncate BEFORE TRUNCATE ON receipt_confirmations FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
