CREATE TABLE "automation_switch_events" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "automation_switch_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" text NOT NULL,
	"event" text NOT NULL,
	"reason" text,
	"actor_id" text,
	"proposal_seq" bigint,
	"decision_hash" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "switch_proposal_used_once" UNIQUE("proposal_seq"),
	CONSTRAINT "switch_event_kind" CHECK ("automation_switch_events"."event" in ('PROPOSE_ON','ON','OFF')),
	CONSTRAINT "switch_event_shape" CHECK (("automation_switch_events"."event" = 'PROPOSE_ON' and "automation_switch_events"."actor_id" is not null and "automation_switch_events"."reason" is null and "automation_switch_events"."proposal_seq" is null and "automation_switch_events"."decision_hash" is null)
    or ("automation_switch_events"."event" = 'ON' and "automation_switch_events"."actor_id" is not null and "automation_switch_events"."reason" is null and "automation_switch_events"."proposal_seq" is not null and "automation_switch_events"."decision_hash" is null)
    or ("automation_switch_events"."event" = 'OFF' and "automation_switch_events"."proposal_seq" is null and (("automation_switch_events"."reason" = 'DISAGREE' and "automation_switch_events"."actor_id" is not null and "automation_switch_events"."decision_hash" is not null)
      or ("automation_switch_events"."reason" = 'UNKNOWN_SEND' and "automation_switch_events"."actor_id" is null and "automation_switch_events"."decision_hash" is not null) or ("automation_switch_events"."reason" = 'APPROVER' and "automation_switch_events"."actor_id" is not null and "automation_switch_events"."decision_hash" is null))))
);
--> statement-breakpoint
CREATE TABLE "disbursement_origins" (
	"disbursement_id" uuid PRIMARY KEY NOT NULL,
	"signed_by" text,
	"automated_decision_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disbursement_origin_exactly_one" CHECK (num_nonnulls("disbursement_origins"."signed_by", "disbursement_origins"."automated_decision_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "payee_email_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"source" text DEFAULT 'CLAIM' NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payee_email_history_source" CHECK ("payee_email_history"."source" in ('CLAIM','FIXTURE')),
	CONSTRAINT "payee_email_history_email" CHECK (length("payee_email_history"."email") between 1 and 320)
);
--> statement-breakpoint
ALTER TABLE "automation_switch_events" ADD CONSTRAINT "automation_switch_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_switch_events" ADD CONSTRAINT "automation_switch_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_switch_events" ADD CONSTRAINT "automation_switch_events_decision_hash_allocation_decisions_decision_hash_fk" FOREIGN KEY ("decision_hash") REFERENCES "public"."allocation_decisions"("decision_hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_switch_events" ADD CONSTRAINT "automation_switch_events_proposal_seq_automation_switch_events_seq_fk" FOREIGN KEY ("proposal_seq") REFERENCES "public"."automation_switch_events"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_origins" ADD CONSTRAINT "disbursement_origins_disbursement_id_disbursements_id_fk" FOREIGN KEY ("disbursement_id") REFERENCES "public"."disbursements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_origins" ADD CONSTRAINT "disbursement_origins_signed_by_users_id_fk" FOREIGN KEY ("signed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disbursement_origins" ADD CONSTRAINT "disbursement_origins_automated_decision_id_automated_decisions_id_fk" FOREIGN KEY ("automated_decision_id") REFERENCES "public"."automated_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_email_history" ADD CONSTRAINT "payee_email_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- IAC-405 step 3 PR P (docs/plans/FUND_MODES_SCOPE.md section 5; docs/ASSUMPTIONS.md section 78). Hand-written guards, appended after the generated DDL as migrations 0014 to 0019 did.
-- The three new tables are immutable: no update, no delete, no truncate. Nothing here posts to the ledger, and no automated record is ever an approval.
CREATE FUNCTION aidtrace_claim_payee_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Only a claim creation can reach this function, and it always writes the normal source. The demo fixture source is written by the seed alone.
  INSERT INTO payee_email_history (user_id, email, source) VALUES (NEW.claimant_id, NEW.payee_email, 'CLAIM');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claim_payee_history AFTER INSERT ON claims FOR EACH ROW EXECUTE FUNCTION aidtrace_claim_payee_history();
--> statement-breakpoint
CREATE TRIGGER payee_email_history_immutable BEFORE UPDATE OR DELETE ON payee_email_history FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER payee_email_history_no_truncate BEFORE TRUNCATE ON payee_email_history FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_switch_event_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposal_row automation_switch_events%ROWTYPE;
  decision_row allocation_decisions%ROWTYPE;
  claimant text;
  last_change bigint;
BEGIN
  IF NEW.actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.actor_id AND role = 'APPROVER' AND organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'An automation switch event is recorded by an approver of its organization' USING ERRCODE = '23514';
  END IF;
  IF NEW.event = 'ON' THEN
    SELECT * INTO proposal_row FROM automation_switch_events WHERE seq = NEW.proposal_seq;
    IF proposal_row.seq IS NULL OR proposal_row.event <> 'PROPOSE_ON' OR proposal_row.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'Turning automation on confirms a proposal of the same organization' USING ERRCODE = '23514';
    END IF;
    IF proposal_row.actor_id IS NOT DISTINCT FROM NEW.actor_id THEN
      RAISE EXCEPTION 'Turning automation on takes two distinct approvers' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(max(seq), 0) INTO last_change FROM automation_switch_events WHERE organization_id = NEW.organization_id AND event IN ('ON', 'OFF');
    IF proposal_row.seq < last_change THEN
      RAISE EXCEPTION 'A proposal made before a later switch change cannot be confirmed' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event = 'OFF' AND NEW.reason IN ('DISAGREE', 'UNKNOWN_SEND') THEN
    SELECT * INTO decision_row FROM allocation_decisions WHERE decision_hash = NEW.decision_hash;
    IF decision_row.id IS NULL OR decision_row.organization_id IS DISTINCT FROM NEW.organization_id OR NOT EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_SENT') THEN
      RAISE EXCEPTION 'A trip names an automated payment of its own organization' USING ERRCODE = '23514';
    END IF;
    IF NEW.reason = 'DISAGREE' THEN
      SELECT claimant_id INTO claimant FROM claims WHERE id = decision_row.claim_id AND version = decision_row.claim_version;
      IF NEW.actor_id IS NOT DISTINCT FROM claimant THEN
        RAISE EXCEPTION 'The claimant cannot record a disagreement on their own payment' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER automation_switch_event_insert_guard BEFORE INSERT ON automation_switch_events FOR EACH ROW EXECUTE FUNCTION aidtrace_switch_event_insert_guard();
--> statement-breakpoint
CREATE TRIGGER automation_switch_event_immutable BEFORE UPDATE OR DELETE ON automation_switch_events FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER automation_switch_event_no_truncate BEFORE TRUNCATE ON automation_switch_events FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
-- Review item 8: AUTO_SEND_CONFIRMED is written in the transaction that records a known send result (SUBMITTED or FUNDING_REJECTED). An AUTO_SENT with no confirmation and no later OFF event blocks automation.
ALTER TABLE "automated_decisions" DROP CONSTRAINT "automated_decision_kind";
--> statement-breakpoint
ALTER TABLE "automated_decisions" ADD CONSTRAINT "automated_decision_kind" CHECK ("automated_decisions"."kind" in ('NO_HOLDS','HELD','AUDIT_SAMPLED','GUARDRAIL_REFUSED','AUTO_RECOGNIZED','AUTO_SENT','AUTO_SEND_CONFIRMED'));
--> statement-breakpoint
CREATE FUNCTION aidtrace_automated_kind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g text;
BEGIN
  IF NEW.kind = 'AUTO_RECOGNIZED' THEN
    IF NOT EXISTS (SELECT 1 FROM decision_modes WHERE decision_hash = NEW.decision_hash AND effective_mode = 'AUTOPILOT') THEN
      RAISE EXCEPTION 'An automated recognition needs a decision recorded as Autopilot' USING ERRCODE = '23514';
    END IF;
    IF NEW.rules_run_id IS NULL OR NEW.model_run_id IS NULL THEN
      RAISE EXCEPTION 'An automated recognition names its rules run and its model run' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind IN ('AUTO_RECOGNIZED', 'AUDIT_SAMPLED', 'GUARDRAIL_REFUSED')) THEN
      RAISE EXCEPTION 'A decision routed to people or already recognized automatically is not recognized automatically again' USING ERRCODE = '23514';
    END IF;
    FOREACH g IN ARRAY ARRAY['G1','G2','G3','G4','G5','G6','G7','G8'] LOOP
      IF coalesce(NEW.inputs #>> ARRAY['guardrails', g, 'pass'], 'false') <> 'true' THEN
        RAISE EXCEPTION 'An automated recognition stores a passing result for every guardrail' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  ELSIF NEW.kind IN ('AUDIT_SAMPLED', 'GUARDRAIL_REFUSED') THEN
    IF EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_RECOGNIZED') THEN
      RAISE EXCEPTION 'An automatically recognized decision is not routed to people afterwards' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'AUTO_SEND_CONFIRMED' THEN
    IF NOT EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_SENT')
       OR EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_SEND_CONFIRMED') THEN
      RAISE EXCEPTION 'A send confirmation names an automated send and is written once' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.kind = 'AUTO_SENT' THEN
    IF NOT EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_RECOGNIZED')
       OR NOT EXISTS (SELECT 1 FROM allocation_decisions WHERE decision_hash = NEW.decision_hash AND recognized_at IS NOT NULL AND invalidated_at IS NULL) THEN
      RAISE EXCEPTION 'An automated send needs a recognized decision with an automated recognition record' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_SENT') THEN
      RAISE EXCEPTION 'A decision is sent automatically once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER automated_decision_kind_guard BEFORE INSERT ON automated_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_automated_kind_guard();
--> statement-breakpoint
CREATE FUNCTION aidtrace_disbursement_origin_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  disbursement_row disbursements%ROWTYPE;
  claim_row claims%ROWTYPE;
BEGIN
  SELECT * INTO disbursement_row FROM disbursements WHERE id = NEW.disbursement_id;
  SELECT * INTO claim_row FROM claims WHERE id = disbursement_row.claim_id AND version = disbursement_row.claim_version;
  IF disbursement_row.id IS NULL OR claim_row.id IS NULL THEN
    RAISE EXCEPTION 'A disbursement origin names an existing disbursement' USING ERRCODE = '23514';
  END IF;
  IF NEW.signed_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.signed_by AND role = 'APPROVER' AND organization_id = claim_row.organization_id AND id <> claim_row.claimant_id) THEN
    RAISE EXCEPTION 'A payout is signed by an approver of the claim organization who is not the claimant' USING ERRCODE = '23514';
  END IF;
  IF NEW.automated_decision_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM automated_decisions WHERE id = NEW.automated_decision_id AND kind = 'AUTO_SENT' AND decision_hash = disbursement_row.decision_hash) THEN
    RAISE EXCEPTION 'An automated payout names the automated send record of its own decision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER disbursement_origin_insert_guard BEFORE INSERT ON disbursement_origins FOR EACH ROW EXECUTE FUNCTION aidtrace_disbursement_origin_insert_guard();
--> statement-breakpoint
CREATE TRIGGER disbursement_origin_immutable BEFORE UPDATE OR DELETE ON disbursement_origins FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER disbursement_origin_no_truncate BEFORE TRUNCATE ON disbursement_origins FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
-- PR F limit b. The database refuses recognized_at unless the decision holds two valid approvals (approvers of the organization other than the claimant), or one valid approval
-- and a NO_HOLDS record on a decision stored as ASSISTED that no Autopilot record routed to people (IAC-405 PR P review item 5), or a stored passing Autopilot record (AUTO_RECOGNIZED, itself refused unless every guardrail result is stored as passing).
CREATE FUNCTION aidtrace_recognition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE valid_approvals integer;
BEGIN
  IF NEW.recognized_at IS NULL OR OLD.recognized_at IS NOT NULL THEN RETURN NEW; END IF;
  SELECT count(DISTINCT a.approver_id) INTO valid_approvals FROM approvals a
    JOIN users u ON u.id = a.approver_id
    JOIN claims c ON c.id = NEW.claim_id AND c.version = NEW.claim_version
    WHERE a.decision_hash = NEW.decision_hash AND u.role = 'APPROVER' AND u.organization_id = NEW.organization_id AND u.id <> c.claimant_id;
  IF valid_approvals >= 2 THEN RETURN NEW; END IF;
  IF valid_approvals >= 1 AND EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'NO_HOLDS')
     AND EXISTS (SELECT 1 FROM decision_modes WHERE decision_hash = NEW.decision_hash AND effective_mode = 'ASSISTED')
     AND NOT EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind IN ('AUDIT_SAMPLED', 'GUARDRAIL_REFUSED')) THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_RECOGNIZED') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A decision is recognized only with two approvals, one approval and a no-holds record, or a passing automated record' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER decision_recognition_guard BEFORE UPDATE ON allocation_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_recognition_guard();
--> statement-breakpoint
-- PR P item 10 (two people finish a claim whose automatic payment was blocked). An approval on a decision that is already recognized is accepted only when the decision carries an
-- AUTO_RECOGNIZED record, no payout exists yet for that claim version, and fewer than two approvals are stored. A Manual or Assisted recognized decision, a paid claim, a third approval
-- and a duplicate approver (also the approval_per_hash_user unique) are refused. An approval on a decision not yet recognized is unchanged.
CREATE FUNCTION aidtrace_approval_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision_row allocation_decisions%ROWTYPE;
BEGIN
  SELECT * INTO decision_row FROM allocation_decisions WHERE decision_hash = NEW.decision_hash;
  IF NOT FOUND OR decision_row.recognized_at IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM automated_decisions WHERE decision_hash = NEW.decision_hash AND kind = 'AUTO_RECOGNIZED') THEN
    RAISE EXCEPTION 'A recognized decision takes a further approval only when Autopilot recognized it' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM disbursements WHERE claim_id = decision_row.claim_id AND claim_version = decision_row.claim_version) THEN
    RAISE EXCEPTION 'A claim with a payout takes no further approval' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM approvals WHERE decision_hash = NEW.decision_hash) >= 2 THEN
    RAISE EXCEPTION 'A decision takes at most two approvals' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER approval_insert_guard BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION aidtrace_approval_insert_guard();
