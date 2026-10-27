CREATE TRIGGER retry_authorization_immutable BEFORE UPDATE OR DELETE ON retry_authorizations FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER retry_authorization_no_truncate BEFORE TRUNCATE ON retry_authorizations FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER provider_event_immutable BEFORE UPDATE OR DELETE ON provider_events FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER provider_event_no_truncate BEFORE TRUNCATE ON provider_events FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_retry_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.attempt_number > 1 AND NOT EXISTS (
    SELECT 1 FROM disbursements d JOIN retry_authorizations a
      ON a.claim_id=d.claim_id AND a.claim_version=d.claim_version
      AND a.decision_hash=d.decision_hash AND a.attempt_number=NEW.attempt_number
      AND a.payee_email=d.payee_email AND a.amount_cents=d.amount_cents
    JOIN users u ON u.id=a.authorized_by
    JOIN claims c ON c.id=d.claim_id AND c.version=d.claim_version
    WHERE d.id=NEW.disbursement_id AND NEW.payee_email=d.payee_email
      AND NEW.amount_cents=d.amount_cents AND u.role='APPROVER'
      AND u.id<>c.claimant_id AND u.organization_id=c.organization_id
  ) THEN RAISE EXCEPTION 'Bound retry authorization required before new attempt' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER retry_attempt_guard BEFORE INSERT ON disbursement_attempts FOR EACH ROW EXECUTE FUNCTION aidtrace_retry_attempt_guard();
