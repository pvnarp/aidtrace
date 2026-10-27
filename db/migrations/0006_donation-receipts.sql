CREATE TABLE "donation_receipts" (
	"order_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"fund_id" text NOT NULL,
	"expected_amount_cents" bigint NOT NULL,
	"capture_id" text,
	"status" text NOT NULL,
	"provider_status" text NOT NULL,
	"gross_cents" bigint,
	"fee_cents" bigint,
	"net_cents" bigint,
	"effective_on" date,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_receipts_capture_id_unique" UNIQUE("capture_id"),
	CONSTRAINT "donation_expected_positive" CHECK ("donation_receipts"."expected_amount_cents" > 0),
	CONSTRAINT "donation_status" CHECK ("donation_receipts"."status" in ('PENDING','COMPLETED')),
	CONSTRAINT "donation_completed_amounts" CHECK ("donation_receipts"."status" <> 'COMPLETED' or ("donation_receipts"."capture_id" is not null and "donation_receipts"."effective_on" is not null and "donation_receipts"."gross_cents" is not null and "donation_receipts"."fee_cents" is not null and "donation_receipts"."net_cents" is not null and "donation_receipts"."gross_cents" = "donation_receipts"."expected_amount_cents" and "donation_receipts"."fee_cents" >= 0 and "donation_receipts"."net_cents" >= 0 and "donation_receipts"."gross_cents" - "donation_receipts"."fee_cents" = "donation_receipts"."net_cents"))
);
--> statement-breakpoint
ALTER TABLE "donation_receipts" ADD CONSTRAINT "donation_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_receipts" ADD CONSTRAINT "donation_receipts_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_receipts" ADD CONSTRAINT "donation_receipts_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION aidtrace_donation_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Donation evidence is preserved' USING ERRCODE='23514'; END IF;
  IF OLD.status='COMPLETED' OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.fund_id IS DISTINCT FROM OLD.fund_id OR NEW.expected_amount_cents IS DISTINCT FROM OLD.expected_amount_cents OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR (OLD.capture_id IS NOT NULL AND NEW.capture_id IS DISTINCT FROM OLD.capture_id) THEN
    RAISE EXCEPTION 'Donation identity and completed evidence are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER donation_receipt_guard BEFORE UPDATE OR DELETE ON donation_receipts FOR EACH ROW EXECUTE FUNCTION aidtrace_donation_receipt_guard();
--> statement-breakpoint
CREATE TRIGGER donation_receipt_no_truncate BEFORE TRUNCATE ON donation_receipts FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
