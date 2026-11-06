CREATE TABLE "historical_event_review_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"resolved_by" text NOT NULL,
	"note" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_event_review_resolutions_review_id_unique" UNIQUE("review_id"),
	CONSTRAINT "historical_resolution_note_length" CHECK (char_length(btrim("historical_event_review_resolutions"."note")) between 10 and 1000)
);
--> statement-breakpoint
CREATE TABLE "historical_event_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" uuid NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"disbursement_id" uuid NOT NULL,
	"event_attempt_id" uuid NOT NULL,
	"latest_attempt_id" uuid NOT NULL,
	"latest_state_at_event" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "historical_event_reviews_provider_event_id_unique" UNIQUE("provider_event_id"),
	CONSTRAINT "historical_review_distinct_attempts" CHECK ("historical_event_reviews"."event_attempt_id" <> "historical_event_reviews"."latest_attempt_id")
);
--> statement-breakpoint
ALTER TABLE "historical_event_review_resolutions" ADD CONSTRAINT "historical_event_review_resolutions_review_id_historical_event_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."historical_event_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_review_resolutions" ADD CONSTRAINT "historical_event_review_resolutions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_reviews" ADD CONSTRAINT "historical_event_reviews_provider_event_id_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_reviews" ADD CONSTRAINT "historical_event_reviews_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_reviews" ADD CONSTRAINT "historical_event_reviews_event_attempt_id_disbursement_attempts_id_fk" FOREIGN KEY ("event_attempt_id") REFERENCES "public"."disbursement_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_reviews" ADD CONSTRAINT "historical_event_reviews_latest_attempt_id_disbursement_attempts_id_fk" FOREIGN KEY ("latest_attempt_id") REFERENCES "public"."disbursement_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_event_reviews" ADD CONSTRAINT "historical_event_reviews_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Option A, November 5 (historical PayPal event review). Hand-written guards appended after the generated DDL, as 0020 does. Both tables are immutable: no update, no delete, no truncate.
-- Nothing here posts to the ledger, changes an attempt or approves anything.
CREATE TRIGGER historical_event_reviews_immutable BEFORE UPDATE OR DELETE ON historical_event_reviews FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER historical_event_reviews_no_truncate BEFORE TRUNCATE ON historical_event_reviews FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER historical_event_review_resolutions_immutable BEFORE UPDATE OR DELETE ON historical_event_review_resolutions FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER historical_event_review_resolutions_no_truncate BEFORE TRUNCATE ON historical_event_review_resolutions FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
