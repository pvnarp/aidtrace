CREATE TABLE "expense_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"claim_id" text NOT NULL,
	"claim_version" integer NOT NULL,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_key" text NOT NULL,
	"draft_hash" text NOT NULL,
	"source_hash" text NOT NULL,
	"payee_hash" text NOT NULL,
	"state" text NOT NULL,
	"suggestion_id" uuid,
	"suggestion_digest" text,
	"snapshot_digest" text,
	"result" jsonb,
	"error_code" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "expense_proposals_request_key_unique" UNIQUE("request_key"),
	CONSTRAINT "expense_proposal_state" CHECK ("expense_proposals"."state" in ('RUNNING','READY_FOR_REVIEW','NEEDS_REVIEW','POLICY_BLOCKED','UNAVAILABLE','STALE')),
	CONSTRAINT "expense_proposal_deadline" CHECK ("expense_proposals"."deadline_at" > "expense_proposals"."recorded_at" and "expense_proposals"."deadline_at" <= "expense_proposals"."recorded_at" + interval '65 seconds'),
	CONSTRAINT "expense_proposal_hashes" CHECK ("expense_proposals"."request_key" ~ '^[a-f0-9]{64}$' and "expense_proposals"."draft_hash" ~ '^[a-f0-9]{64}$' and "expense_proposals"."source_hash" ~ '^[a-f0-9]{64}$' and "expense_proposals"."payee_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "expense_proposal_completion" CHECK (("expense_proposals"."state" = 'RUNNING' and "expense_proposals"."completed_at" is null and "expense_proposals"."result" is null) or ("expense_proposals"."state" <> 'RUNNING' and "expense_proposals"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "expense_proposals" ADD CONSTRAINT "expense_proposals_review_id_receipt_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."receipt_reviews"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_proposals" ADD CONSTRAINT "expense_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_proposals" ADD CONSTRAINT "expense_proposals_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_proposals" ADD CONSTRAINT "expense_proposals_suggestion_id_receipt_suggestions_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."receipt_suggestions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_proposals" ADD CONSTRAINT "expense_proposals_claim_id_claim_version_claims_id_version_fk" FOREIGN KEY ("claim_id","claim_version") REFERENCES "public"."claims"("id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_proposal_active_review" ON "expense_proposals" USING btree ("review_id") WHERE "expense_proposals"."state" = 'RUNNING';--> statement-breakpoint
CREATE UNIQUE INDEX "expense_proposal_active_slot" ON "expense_proposals" USING btree ((true)) WHERE "expense_proposals"."state" = 'RUNNING';
--> statement-breakpoint
CREATE FUNCTION aidtrace_expense_proposal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Preparation history is immutable'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.state <> 'RUNNING' OR NEW.state = 'RUNNING' OR
       (to_jsonb(NEW) - ARRAY['state','suggestion_id','suggestion_digest','snapshot_digest','result','error_code','completed_at'])
       IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['state','suggestion_id','suggestion_digest','snapshot_digest','result','error_code','completed_at']) THEN
      RAISE EXCEPTION 'Only completion of an existing preparation is permitted';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM receipt_reviews r JOIN claims c ON c.id = r.claim_id AND c.version = r.claim_version
    WHERE r.id = NEW.review_id AND r.claim_id = NEW.claim_id AND r.claim_version = NEW.claim_version
      AND c.organization_id = NEW.organization_id AND c.claimant_id = NEW.actor_id
      AND r.source_hash = NEW.source_hash AND r.draft_hash = NEW.draft_hash
  ) OR (NEW.suggestion_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM receipt_suggestions WHERE id = NEW.suggestion_id AND review_id = NEW.review_id
  )) THEN RAISE EXCEPTION 'Preparation context mismatch'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_proposal_transition BEFORE INSERT OR UPDATE OR DELETE ON expense_proposals FOR EACH ROW EXECUTE FUNCTION aidtrace_expense_proposal_transition();
--> statement-breakpoint
CREATE TRIGGER expense_proposal_no_truncate BEFORE TRUNCATE ON expense_proposals FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
