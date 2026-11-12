ALTER TABLE "donation_orders" DROP CONSTRAINT "donation_order_status";--> statement-breakpoint
ALTER TABLE "donation_orders" DROP CONSTRAINT "donation_order_id_required";--> statement-breakpoint
ALTER TABLE "donation_orders" DROP CONSTRAINT "donation_order_attempts_by_status";--> statement-breakpoint
ALTER TABLE "donation_orders" DROP CONSTRAINT "donation_order_final_has_no_lease";--> statement-breakpoint
ALTER TABLE "donation_orders" ADD COLUMN "create_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "donation_orders" ADD COLUMN "declined_capture_request_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_expected_bound" CHECK ("donation_orders"."expected_amount_cents" <= 9999999999999);--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_attempts_before_capture" CHECK ("donation_orders"."status" not in ('CREATED','APPROVED') or "donation_orders"."capture_attempts" = 0);--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_create_attempts" CHECK ("donation_orders"."create_attempts" between 1 and 3);--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_history_bound" CHECK (cardinality("donation_orders"."declined_capture_request_ids") <= 2);--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_history_distinct" CHECK (not ("donation_orders"."capture_request_id" = any("donation_orders"."declined_capture_request_ids")) and not ("donation_orders"."create_request_id" = any("donation_orders"."declined_capture_request_ids")));--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_status" CHECK ("donation_orders"."status" in ('CREATED','APPROVED','CAPTURING','CAPTURE_UNKNOWN','PENDING','DECLINED','COMPLETED','FAILED','MISMATCH','EXPIRED'));--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_id_required" CHECK ("donation_orders"."status" in ('CREATED','FAILED','EXPIRED') or "donation_orders"."order_id" is not null);--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_attempts_by_status" CHECK ("donation_orders"."capture_attempts" > 0 or "donation_orders"."status" in ('CREATED','APPROVED','FAILED','MISMATCH','EXPIRED'));--> statement-breakpoint
ALTER TABLE "donation_orders" ADD CONSTRAINT "donation_order_final_has_no_lease" CHECK ("donation_orders"."status" not in ('COMPLETED','FAILED','MISMATCH','EXPIRED') or "donation_orders"."lease_token" is null);
--> statement-breakpoint
-- IAC-391: the guard keeps every rule from migration 0009 and adds the
-- DECLINED and EXPIRED states, the capture round rotation, the decline history and the create attempt counter.
CREATE OR REPLACE FUNCTION aidtrace_donation_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rotating boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Donation order history is preserved' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' OR NEW.order_id IS NOT NULL OR NEW.capture_attempts <> 0 OR NEW.lease_token IS NOT NULL
       OR NEW.create_attempts IS DISTINCT FROM 1 OR NEW.declined_capture_request_ids IS DISTINCT FROM '{}'::uuid[] THEN
      RAISE EXCEPTION 'A donation order starts as CREATED with no provider ID, capture attempt, lease or decline history, and one create attempt' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM funds WHERE id = NEW.fund_id AND fund_class = 'RESTRICTED') THEN
      RAISE EXCEPTION 'Donations are accepted for restricted funds only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.fund_id IS DISTINCT FROM OLD.fund_id OR NEW.expected_amount_cents IS DISTINCT FROM OLD.expected_amount_cents
     OR NEW.create_request_id IS DISTINCT FROM OLD.create_request_id
     OR NEW.display_name IS DISTINCT FROM OLD.display_name OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id) THEN
    RAISE EXCEPTION 'Donation order identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.order_id IS NULL AND NEW.order_id IS NOT NULL AND OLD.status <> 'CREATED' THEN
    RAISE EXCEPTION 'The provider order ID can be set only while the order is CREATED' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('COMPLETED', 'FAILED', 'MISMATCH', 'EXPIRED') THEN
    RAISE EXCEPTION 'Final donation order states are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'CREATED' AND NEW.status IN ('APPROVED', 'MISMATCH', 'FAILED', 'EXPIRED'))
    OR (OLD.status = 'APPROVED' AND NEW.status IN ('CAPTURING', 'MISMATCH', 'EXPIRED'))
    OR (OLD.status = 'CAPTURING' AND NEW.status IN ('COMPLETED', 'PENDING', 'FAILED', 'CAPTURE_UNKNOWN', 'MISMATCH', 'DECLINED'))
    OR (OLD.status = 'CAPTURE_UNKNOWN' AND NEW.status IN ('CAPTURING', 'COMPLETED', 'PENDING', 'FAILED', 'MISMATCH'))
    OR (OLD.status = 'PENDING' AND NEW.status IN ('COMPLETED', 'FAILED', 'MISMATCH'))
    OR (OLD.status = 'DECLINED' AND NEW.status IN ('APPROVED', 'MISMATCH', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'Illegal donation order status transition' USING ERRCODE = '23514';
  END IF;
  -- A new capture round starts only when a declined order is approved again: a fresh capture request ID, the old one
  -- appended to the decline history, and no capture attempts. The CHECK constraints bound the history to two IDs and
  -- keep the current capture ID and the create ID out of it. No other update may touch either column.
  rotating := OLD.status = 'DECLINED' AND NEW.status = 'APPROVED';
  IF rotating THEN
    IF NEW.capture_request_id IS NOT DISTINCT FROM OLD.capture_request_id
       OR NEW.declined_capture_request_ids IS DISTINCT FROM (OLD.declined_capture_request_ids || OLD.capture_request_id)
       OR NEW.capture_attempts <> 0 THEN
      RAISE EXCEPTION 'A declined order is approved again with a fresh capture request ID, the old ID appended to the decline history and zero capture attempts' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.capture_request_id IS DISTINCT FROM OLD.capture_request_id THEN
      RAISE EXCEPTION 'Donation order identity is immutable: the capture request ID changes only when a declined order is approved again' USING ERRCODE = '23514';
    END IF;
    IF NEW.declined_capture_request_ids IS DISTINCT FROM OLD.declined_capture_request_ids THEN
      RAISE EXCEPTION 'The decline history changes only when a declined order is approved again' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Create sends are counted: the counter moves only while CREATED with no provider ID, by exactly one, status unchanged.
  IF NEW.create_attempts IS DISTINCT FROM OLD.create_attempts THEN
    IF NOT (OLD.status = 'CREATED' AND NEW.status = 'CREATED' AND OLD.order_id IS NULL AND NEW.order_id IS NULL AND NEW.create_attempts = OLD.create_attempts + 1) THEN
      RAISE EXCEPTION 'The create attempt counter changes only while CREATED with no provider ID, by exactly one' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Every send is counted: entering CAPTURING adds exactly one attempt, a new round resets the counter, and nothing else may change it.
  IF NEW.status = 'CAPTURING' AND OLD.status IN ('APPROVED', 'CAPTURE_UNKNOWN') THEN
    IF NEW.capture_attempts <> OLD.capture_attempts + 1 THEN RAISE EXCEPTION 'Entering CAPTURING counts exactly one capture attempt' USING ERRCODE = '23514'; END IF;
  ELSIF rotating THEN
    NULL;
  ELSIF NEW.capture_attempts IS DISTINCT FROM OLD.capture_attempts THEN
    RAISE EXCEPTION 'The capture attempt counter changes only when a capture is sent' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
