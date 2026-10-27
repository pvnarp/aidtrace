-- A workspace selects exactly one opening source. New donations are not opening credits.
CREATE FUNCTION enforce_opening_credit_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_source source_type;
BEGIN
  IF NEW.is_opening THEN
    SELECT o.opening_source_type INTO expected_source FROM organizations o
      JOIN funds f ON f.organization_id = o.id WHERE f.id = NEW.fund_id
      FOR UPDATE OF o;
    IF NEW.source_type NOT IN ('fixture_opening_balance', 'paypal_capture') OR NEW.source_type <> expected_source THEN
      RAISE EXCEPTION 'Opening source must match the workspace opening source' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.source_type = 'fixture_opening_balance' THEN
    RAISE EXCEPTION 'Fixture credits must be labeled as opening balances' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER opening_credit_source BEFORE INSERT OR UPDATE ON fund_credits
  FOR EACH ROW EXECUTE FUNCTION enforce_opening_credit_source();
--> statement-breakpoint
CREATE FUNCTION preserve_workspace_opening_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.opening_source_type <> OLD.opening_source_type AND EXISTS (
    SELECT 1 FROM fund_credits c JOIN funds f ON c.fund_id = f.id
    WHERE f.organization_id = OLD.id AND c.is_opening AND c.source_type <> NEW.opening_source_type
  ) THEN
    RAISE EXCEPTION 'Cannot change opening source over existing opening balances' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workspace_opening_source BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION preserve_workspace_opening_source();
