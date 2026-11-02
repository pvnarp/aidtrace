CREATE TABLE "gift_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"capture_id" text NOT NULL,
	"policy_version" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gift_links_capture_id_unique" UNIQUE("capture_id"),
	CONSTRAINT "gift_link_hash" CHECK ("gift_links"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "gift_link_policy" CHECK ("gift_links"."policy_version" = 'GIFT_LINK_V1')
);
--> statement-breakpoint
ALTER TABLE "gift_links" ADD CONSTRAINT "gift_links_capture_id_donation_receipts_capture_id_fk" FOREIGN KEY ("capture_id") REFERENCES "public"."donation_receipts"("capture_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 2.4). Hand-written guard and immutability triggers, appended after the
-- generated DDL as migrations 0014 and 0015 did. A gift link is append-only: no update, no delete, no truncate. The insert guard
-- restates in the database that a link names a COMPLETED gift. It adds no column to any existing table and moves no money.
CREATE FUNCTION aidtrace_gift_link_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM donation_receipts WHERE capture_id = NEW.capture_id AND status = 'COMPLETED') THEN
    RAISE EXCEPTION 'A gift link names a completed gift' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER gift_link_insert_guard BEFORE INSERT ON gift_links FOR EACH ROW EXECUTE FUNCTION aidtrace_gift_link_insert_guard();
--> statement-breakpoint
CREATE TRIGGER gift_link_immutable BEFORE UPDATE OR DELETE ON gift_links FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER gift_link_no_truncate BEFORE TRUNCATE ON gift_links FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
