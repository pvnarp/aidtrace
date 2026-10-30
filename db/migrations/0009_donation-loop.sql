CREATE TABLE "donation_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" text,
	"fund_id" text NOT NULL,
	"expected_amount_cents" bigint NOT NULL,
	"create_request_id" uuid NOT NULL,
	"capture_request_id" uuid NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"capture_attempts" integer DEFAULT 0 NOT NULL,
	"display_name" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "donation_orders_order_id_unique" UNIQUE("order_id"),
	CONSTRAINT "donation_orders_create_request_id_unique" UNIQUE("create_request_id"),
	CONSTRAINT "donation_orders_capture_request_id_unique" UNIQUE("capture_request_id"),
	CONSTRAINT "donation_order_expected_positive" CHECK ("donation_orders"."expected_amount_cents" > 0),
	CONSTRAINT "donation_order_id_format" CHECK ("donation_orders"."order_id" is null or "donation_orders"."order_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "donation_order_request_ids_differ" CHECK ("donation_orders"."create_request_id" <> "donation_orders"."capture_request_id"),
	CONSTRAINT "donation_order_status" CHECK ("donation_orders"."status" in ('CREATED','APPROVED','CAPTURING','CAPTURE_UNKNOWN','PENDING','COMPLETED','FAILED','MISMATCH')),
	CONSTRAINT "donation_order_id_required" CHECK ("donation_orders"."status" in ('CREATED','FAILED') or "donation_orders"."order_id" is not null),
	CONSTRAINT "donation_order_attempts" CHECK ("donation_orders"."capture_attempts" between 0 and 2),
	CONSTRAINT "donation_order_attempts_by_status" CHECK ("donation_orders"."capture_attempts" > 0 or "donation_orders"."status" in ('CREATED','APPROVED','FAILED','MISMATCH')),
	CONSTRAINT "donation_order_display_name" CHECK ("donation_orders"."display_name" is null or (char_length("donation_orders"."display_name") between 1 and 40 and "donation_orders"."display_name" = btrim("donation_orders"."display_name"))),
	CONSTRAINT "donation_order_lease_pair" CHECK (("donation_orders"."lease_token" is null) = ("donation_orders"."lease_expires_at" is null)),
	CONSTRAINT "donation_order_final_has_no_lease" CHECK ("donation_orders"."status" not in ('COMPLETED','FAILED','MISMATCH') or "donation_orders"."lease_token" is null)
);
--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_orders_fund_id_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."funds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION aidtrace_donation_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Donation order history is preserved' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' OR NEW.order_id IS NOT NULL OR NEW.capture_attempts <> 0 OR NEW.lease_token IS NOT NULL THEN
      RAISE EXCEPTION 'A donation order starts as CREATED with no provider ID, capture attempt or lease' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM funds WHERE id = NEW.fund_id AND fund_class = 'RESTRICTED') THEN
      RAISE EXCEPTION 'Donations are accepted for restricted funds only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.fund_id IS DISTINCT FROM OLD.fund_id OR NEW.expected_amount_cents IS DISTINCT FROM OLD.expected_amount_cents
     OR NEW.create_request_id IS DISTINCT FROM OLD.create_request_id OR NEW.capture_request_id IS DISTINCT FROM OLD.capture_request_id
     OR NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    RAISE EXCEPTION 'Donation order identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.order_id IS NULL AND NEW.order_id IS NOT NULL AND OLD.status <> 'CREATED' THEN
    RAISE EXCEPTION 'The provider order ID can be set only while the order is CREATED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('COMPLETED', 'FAILED', 'MISMATCH') THEN
    RAISE EXCEPTION 'Final donation order states are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'CREATED' AND NEW.status IN ('APPROVED', 'MISMATCH', 'FAILED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('CAPTURING', 'MISMATCH'))
    OR (OLD.status = 'CAPTURING' AND NEW.status IN ('COMPLETED', 'PENDING', 'FAILED', 'CAPTURE_UNKNOWN', 'MISMATCH'))
    OR (OLD.status = 'CAPTURE_UNKNOWN' AND NEW.status IN ('CAPTURING', 'COMPLETED', 'PENDING', 'FAILED', 'MISMATCH'))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('COMPLETED', 'FAILED', 'MISMATCH'))
  ) THEN
    RAISE EXCEPTION 'Illegal donation order status transition' USING ERRCODE = '23514';
  END IF;
  -- Every send is counted: entering CAPTURING adds exactly one attempt, and nothing else may change the counter.
  IF NEW.status = 'CAPTURING' AND OLD.status IN ('APPROVED', 'CAPTURE_UNKNOWN') THEN
    IF NEW.capture_attempts <> OLD.capture_attempts + 1 THEN RAISE EXCEPTION 'Entering CAPTURING counts exactly one capture attempt' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.capture_attempts IS DISTINCT FROM OLD.capture_attempts THEN
    RAISE EXCEPTION 'The capture attempt counter changes only when a capture is sent' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER donation_order_guard BEFORE INSERT OR UPDATE OR DELETE ON donation_orders FOR EACH ROW EXECUTE FUNCTION aidtrace_donation_order_guard();
--> statement-breakpoint
CREATE TRIGGER donation_order_no_truncate BEFORE TRUNCATE ON donation_orders FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
