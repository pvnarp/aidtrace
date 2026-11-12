CREATE TABLE "receipt_photo_reads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"photo_sha256" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"outcome" text NOT NULL,
	"stop_reason" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"arithmetic_ok" boolean,
	"prefill_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_read_sha256" CHECK ("receipt_photo_reads"."photo_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "photo_read_model" CHECK ("receipt_photo_reads"."model" in ('claude-haiku-5-5','claude-sonnet-5-5')),
	CONSTRAINT "photo_read_versions" CHECK ("receipt_photo_reads"."prompt_version" = 'receipt-photo-v1' and "receipt_photo_reads"."schema_version" = 'receipt-transcript-v1'),
	CONSTRAINT "photo_read_outcome" CHECK ("receipt_photo_reads"."outcome" in ('READ','UNREADABLE','REFUSED','FAILED')),
	CONSTRAINT "photo_read_stop_reason" CHECK ("receipt_photo_reads"."stop_reason" is null or "receipt_photo_reads"."stop_reason" ~ '^[a-z_]{1,32}$'),
	CONSTRAINT "photo_read_tokens" CHECK ("receipt_photo_reads"."input_tokens" between 0 and 10000000 and "receipt_photo_reads"."output_tokens" between 0 and 10000000),
	CONSTRAINT "photo_read_arithmetic" CHECK (("receipt_photo_reads"."outcome" = 'READ') = ("receipt_photo_reads"."arithmetic_ok" is not null)),
	CONSTRAINT "photo_read_prefill" CHECK (("receipt_photo_reads"."outcome" = 'READ') = ("receipt_photo_reads"."prefill_sha256" is not null) and ("receipt_photo_reads"."prefill_sha256" is null or "receipt_photo_reads"."prefill_sha256" ~ '^[a-f0-9]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD COLUMN IF NOT EXISTS "photo_read_id" uuid;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD COLUMN IF NOT EXISTS "photo_unchanged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "receipt_photo_reads" ADD CONSTRAINT "receipt_photo_reads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_photo_reads" ADD CONSTRAINT "receipt_photo_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_reviews_photo_read_id_receipt_photo_reads_id_fk" FOREIGN KEY ("photo_read_id") REFERENCES "public"."receipt_photo_reads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "receipt_review_photo_read_first" ON "receipt_reviews" USING btree ("photo_read_id") WHERE "receipt_reviews"."revision" = 1;--> statement-breakpoint
ALTER TABLE "receipt_reviews" ADD CONSTRAINT "receipt_photo_unchanged_needs_link" CHECK (not "receipt_reviews"."photo_unchanged" or "receipt_reviews"."photo_read_id" is not null);
--> statement-breakpoint
-- IAC-384. Hand-written guards, appended after the generated DDL as migrations 0014 to 0020 did.
-- receipt_photo_reads is append-only: no update, no delete, no truncate. A read row names a user of its own organization. Nothing here posts to the ledger, approves or pays.
CREATE FUNCTION aidtrace_photo_read_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND organization_id = NEW.organization_id AND role = 'CLAIMANT') THEN
    RAISE EXCEPTION 'A photo read is recorded for a claimant of its organization' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER photo_read_insert_guard BEFORE INSERT ON receipt_photo_reads FOR EACH ROW EXECUTE FUNCTION aidtrace_photo_read_insert_guard();
--> statement-breakpoint
CREATE TRIGGER photo_read_immutable BEFORE UPDATE OR DELETE ON receipt_photo_reads FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER photo_read_no_truncate BEFORE TRUNCATE ON receipt_photo_reads FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
-- The link from a receipt to its photo read, guarded in the database as well as in the service. On revision 1 a link must name a READ row of the review's creator
-- (a partial unique index already allows one first revision per read). On a later revision the link must equal the previous revision's link, so an edit can neither add, change nor drop it.
CREATE FUNCTION aidtrace_review_photo_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous uuid;
BEGIN
  IF NEW.revision = 1 THEN
    IF NEW.photo_read_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM receipt_photo_reads WHERE id = NEW.photo_read_id AND outcome = 'READ' AND user_id = NEW.created_by) THEN
      RAISE EXCEPTION 'A receipt links only to a READ photo read of its creator' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT photo_read_id INTO previous FROM receipt_reviews WHERE claim_id = NEW.claim_id AND revision = NEW.revision - 1;
    IF NEW.photo_read_id IS DISTINCT FROM previous THEN
      RAISE EXCEPTION 'A later revision keeps the photo read link of the revision before it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER review_photo_link_guard BEFORE INSERT ON receipt_reviews FOR EACH ROW EXECUTE FUNCTION aidtrace_review_photo_link_guard();
