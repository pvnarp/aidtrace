ALTER TABLE "receipt_suggestions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "receipt_suggestions" ADD COLUMN "model" text;--> statement-breakpoint
-- IAC-392 (docs/plans/PROVIDER_COLUMNS.md section 2): the one sanctioned rewrite of frozen rows. READY rows are frozen by
-- receipt_suggestion_transition, so the trigger is disabled only for this backfill, inside the migration transaction. The
-- columns are derived from each row's own stored audit. The audit jsonb, the proposals and every hash are unchanged.
ALTER TABLE "receipt_suggestions" DISABLE TRIGGER receipt_suggestion_transition;--> statement-breakpoint
UPDATE "receipt_suggestions" SET
  "provider" = CASE WHEN "audit" ? 'provider' THEN 'claude' ELSE 'local' END,
  "model" = CASE WHEN "audit" ? 'provider' THEN "audit"->>'model' ELSE "audit"->>'modelRevision' END
WHERE "status" = 'READY';--> statement-breakpoint
ALTER TABLE "receipt_suggestions" ENABLE TRIGGER receipt_suggestion_transition;--> statement-breakpoint
ALTER TABLE "receipt_suggestions" ADD CONSTRAINT "receipt_suggestion_provider" CHECK (("receipt_suggestions"."status" = 'READY') = ("receipt_suggestions"."provider" is not null) and ("receipt_suggestions"."provider" is null) = ("receipt_suggestions"."model" is null) and ("receipt_suggestions"."provider" is null or "receipt_suggestions"."provider" in ('local','claude')) and ("receipt_suggestions"."provider" is distinct from 'local' or (not ("receipt_suggestions"."audit" ? 'provider') and "receipt_suggestions"."model" = "receipt_suggestions"."audit"->>'modelRevision' and "receipt_suggestions"."model" ~ '^[a-f0-9]{40}$') is true) and ("receipt_suggestions"."provider" is distinct from 'claude' or ("receipt_suggestions"."audit"->>'provider' = 'claude' and "receipt_suggestions"."model" = "receipt_suggestions"."audit"->>'model' and "receipt_suggestions"."model" in ('claude-haiku-5-5','claude-sonnet-5-5')) is true));
