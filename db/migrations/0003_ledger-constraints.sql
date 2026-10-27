CREATE FUNCTION aidtrace_stamp_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_transaction_id := txid_current();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_transaction BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION aidtrace_stamp_transaction();
--> statement-breakpoint
CREATE TRIGGER decision_transaction BEFORE INSERT ON allocation_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_stamp_transaction();
--> statement-breakpoint
CREATE FUNCTION aidtrace_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable accounting or approval record' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON journal_entries FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER posting_immutable BEFORE UPDATE OR DELETE ON journal_postings FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER approval_immutable BEFORE UPDATE OR DELETE ON approvals FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER edge_immutable BEFORE UPDATE OR DELETE ON allocation_edges FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER journal_no_truncate BEFORE TRUNCATE ON journal_entries FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER posting_no_truncate BEFORE TRUNCATE ON journal_postings FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER decision_no_truncate BEFORE TRUNCATE ON allocation_decisions FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER edge_no_truncate BEFORE TRUNCATE ON allocation_edges FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER approval_no_truncate BEFORE TRUNCATE ON approvals FOR EACH STATEMENT EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER fund_policy_immutable BEFORE UPDATE OR DELETE ON fund_policy_versions FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE TRIGGER solver_policy_immutable BEFORE UPDATE OR DELETE ON solver_priority_versions FOR EACH ROW EXECUTE FUNCTION aidtrace_immutable();
--> statement-breakpoint
CREATE FUNCTION aidtrace_posting_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_xid bigint;
BEGIN
  SELECT created_transaction_id INTO owner_xid FROM journal_entries WHERE id = NEW.entry_id;
  IF owner_xid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'Cannot append to a committed journal entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER posting_insert_guard BEFORE INSERT ON journal_postings FOR EACH ROW EXECUTE FUNCTION aidtrace_posting_insert();
--> statement-breakpoint
CREATE FUNCTION aidtrace_check_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE entry uuid; difference numeric; posting_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN entry := NEW.id; ELSE entry := NEW.entry_id; END IF;
  SELECT count(*), coalesce(sum(debit_cents::numeric - credit_cents::numeric), 0)
    INTO posting_count, difference FROM journal_postings WHERE entry_id = entry;
  IF posting_count < 2 OR difference <> 0 THEN
    RAISE EXCEPTION 'Journal entry must contain balanced postings' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER entry_balance AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aidtrace_check_journal_balance();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER posting_balance AFTER INSERT ON journal_postings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION aidtrace_check_journal_balance();
--> statement-breakpoint
CREATE FUNCTION aidtrace_frozen_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Frozen decisions are preserved' USING ERRCODE = '23514'; END IF;
  IF OLD.recognized_at IS NOT NULL OR (to_jsonb(NEW) - 'invalidated_at' - 'recognized_at') IS DISTINCT FROM (to_jsonb(OLD) - 'invalidated_at' - 'recognized_at') OR (OLD.invalidated_at IS NOT NULL AND NEW.invalidated_at IS DISTINCT FROM OLD.invalidated_at) OR (NEW.recognized_at IS NOT NULL AND NEW.invalidated_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Frozen decision terms cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON allocation_decisions FOR EACH ROW EXECUTE FUNCTION aidtrace_frozen_decision();
--> statement-breakpoint
CREATE FUNCTION aidtrace_edge_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_xid bigint;
BEGIN
  SELECT created_transaction_id INTO owner_xid FROM allocation_decisions WHERE id = NEW.decision_id;
  IF owner_xid IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'Cannot append to a frozen decision' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER edge_insert_guard BEFORE INSERT ON allocation_edges FOR EACH ROW EXECUTE FUNCTION aidtrace_edge_insert();
--> statement-breakpoint
CREATE FUNCTION aidtrace_recognized_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP IN ('UPDATE','DELETE') AND EXISTS (SELECT 1 FROM allocation_decisions WHERE claim_id = OLD.id AND recognized_at IS NOT NULL)) OR (TG_OP IN ('INSERT','UPDATE') AND EXISTS (SELECT 1 FROM allocation_decisions WHERE claim_id = NEW.id AND recognized_at IS NOT NULL)) THEN
    IF TG_OP <> 'UPDATE' OR (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
      RAISE EXCEPTION 'Recognized claim terms are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recognized_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON claims FOR EACH ROW EXECUTE FUNCTION aidtrace_recognized_claim_guard();
--> statement-breakpoint
CREATE FUNCTION aidtrace_recognized_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    IF EXISTS (SELECT 1 FROM allocation_decisions WHERE claim_id = OLD.claim_id AND recognized_at IS NOT NULL) THEN RAISE EXCEPTION 'Recognized claim lines are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    IF EXISTS (SELECT 1 FROM allocation_decisions WHERE claim_id = NEW.claim_id AND recognized_at IS NOT NULL) THEN RAISE EXCEPTION 'Recognized claim lines are immutable' USING ERRCODE = '23514'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER recognized_line_guard BEFORE INSERT OR UPDATE OR DELETE ON claim_lines FOR EACH ROW EXECUTE FUNCTION aidtrace_recognized_line_guard();
