import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_ROW_CAP, REQUIRED_APPROVALS, approvalsText, entryTypeOf, mapLedgerRow, sumSides, type AttemptLookup, type LedgerRow, type Lookups, type RawPosting } from "../src/ledger/view";
import { LEDGER_PHONE_COLUMNS, LEDGER_TOTAL_FIELDS, ledgerColumns, ledgerTotalLabel } from "../src/app/ledger/columns";
import { leafColumns } from "../src/app/grid/columns";

// IAC-380 step 2, the read-only /ledger view.
// LG-01 runs here as a pure unit test of the row mapper. The static source checks below back the read-only claim. No database, no browser.

const BIG = 9007199254740993n; // 2^53 + 1: the first integer a JavaScript number cannot hold
const AT = new Date("2026-10-30T12:34:56.789Z");
const posting = (over: Partial<RawPosting> = {}): RawPosting => ({
  id: "p1", accountCode: "1010", subKey: null, debitCents: 100n, creditCents: 0n, sourceType: "paypal_capture", sourceId: "CAP1", purpose: "donation", effectiveOn: "2026-10-30", recordedAt: AT, ...over,
});
const attempt = (over: Partial<AttemptLookup> = {}): AttemptLookup => ({ state: "SETTLED", itemStatus: "SUCCESS", payoutBatchId: "BATCH123", claimId: "claim-1", decisionHash: "hash-1", ...over });
const lookups = (over: Partial<Lookups> = {}): Lookups => ({
  decisions: new Map([["11111111-2222-4333-8444-555555555555", { claimId: "claim-9", decisionHash: "hash-9" }]]),
  approvals: new Map([["hash-9", 2], ["hash-1", 2]]),
  captures: new Set(["CAP1"]),
  attempts: new Map([["ITEM1", [attempt()]]]),
  funds: new Map([["fund_b", "Ashmere County Afterschool STEM Subgrant"]]),
  ...over,
});

describe("LG-01 row mapping keeps cents exact and joins honest", () => {
  it("returns every cent value as a decimal string, including a value a JavaScript number cannot hold", () => {
    const row = mapLedgerRow(posting({ debitCents: BIG }), lookups());
    expect(row.debitCents).toBe("9007199254740993");
    expect(typeof row.debitCents).toBe("string");
    expect(row.creditCents).toBe("");
    expect(Number(BIG).toString()).not.toBe("9007199254740993"); // the failure this mapping avoids
    const credit = mapLedgerRow(posting({ accountCode: "4100", subKey: "fund_b", debitCents: 0n, creditCents: BIG }), lookups());
    expect(credit.creditCents).toBe("9007199254740993");
    expect(credit.debitCents).toBe("");
    for (const value of Object.values(row)) expect(typeof value).not.toBe("bigint");
  });
  it("is JSON serializable, which a bigint field is not", () => {
    expect(() => JSON.stringify(mapLedgerRow(posting({ debitCents: BIG }), lookups()))).not.toThrow();
  });
  it("enforces exactly one positive side", () => {
    expect(() => mapLedgerRow(posting({ debitCents: 0n, creditCents: 0n }), lookups())).toThrow(/exactly one positive side/);
    expect(() => mapLedgerRow(posting({ debitCents: 5n, creditCents: 5n }), lookups())).toThrow(/exactly one positive side/);
  });
  it("formats the recorded time as ISO and keeps the effective date as stored", () => {
    const row = mapLedgerRow(posting(), lookups());
    expect(row.recordedAt).toBe("2026-10-30T12:34:56.789Z");
    expect(row.effectiveOn).toBe("2026-10-30");
    expect(row.account).toBe("1010 Cash");
    expect(row.accountCode).toBe("1010");
  });
  it("names the entry type and falls back to the raw type for an unknown pair", () => {
    expect(entryTypeOf("paypal_capture", "donation").label).toBe("Donation");
    expect(entryTypeOf("paypal_capture", "donation_fee").label).toBe("Donation fee");
    expect(entryTypeOf("paypal_payout_item", "settlement").label).toBe("Payout settlement");
    expect(entryTypeOf("paypal_payout_item", "payout_fee").label).toBe("Payout fee");
    expect(entryTypeOf("fixture_opening_balance", "opening").label).toBe("Opening balance");
    expect(entryTypeOf("claim_recognition", "recognition").label).toBe("Claim recognition");
    expect(entryTypeOf("claim_recognition", "restriction_release").label).toBe("Restriction release");
    const unknown = entryTypeOf("mystery", "thing");
    expect(unknown.label).toBe("mystery / thing");
    expect(unknown.tip).toContain("Unrecognized entry type");
    expect(mapLedgerRow(posting({ accountCode: "9999" }), lookups()).account).toBe("9999 Unrecognized account");
  });

  it("resolves a fund name for 3100 and 4100, shows General for 3200 and leaves other accounts blank", () => {
    const named = mapLedgerRow(posting({ accountCode: "4100", subKey: "fund_b", debitCents: 0n, creditCents: 100n }), lookups());
    expect(named.fund).toBe("Ashmere County Afterschool STEM Subgrant");
    expect(named.fundTip).toBe("Fund id fund_b.");
    const restricted = mapLedgerRow(posting({ accountCode: "3100", subKey: "fund_b", debitCents: 0n, creditCents: 100n }), lookups());
    expect(restricted.fund).toBe("Ashmere County Afterschool STEM Subgrant");
    const missing = mapLedgerRow(posting({ accountCode: "3100", subKey: "fund_zzz", debitCents: 0n, creditCents: 100n }), lookups());
    expect(missing.fund).toBe("fund_zzz");
    expect(missing.fundTip).toContain("No fund record matches");
    const general = mapLedgerRow(posting({ accountCode: "3200", subKey: null, debitCents: 0n, creditCents: 100n }), lookups());
    expect(general.fund).toBe("General");
    expect(mapLedgerRow(posting({ accountCode: "1010" }), lookups()).fund).toBe("");
    expect(mapLedgerRow(posting({ accountCode: "5900", subKey: "CAP1" }), lookups()).fund).toBe("");
  });

  it("shows No claim, Not applicable and No PayPal reference for an opening balance", () => {
    const row = mapLedgerRow(posting({ sourceType: "fixture_opening_balance", sourceId: "cedar-hollow", purpose: "opening" }), lookups());
    expect(row.claim).toBe("No claim");
    expect(row.approvals).toBe("Not applicable");
    expect(row.paypalReference).toBe("No PayPal reference");
    expect(row.verify).toBe(false);
  });

  it("joins a recognition entry to its claim and counts approvals as n of 2", () => {
    const row = mapLedgerRow(posting({ sourceType: "claim_recognition", sourceId: "11111111-2222-4333-8444-555555555555", purpose: "recognition", accountCode: "5100" }), lookups());
    expect(row.claim).toBe("claim-9");
    expect(row.approvals).toBe("2 of 2");
    expect(row.paypalReference).toBe("No PayPal reference");
    const none = mapLedgerRow(posting({ sourceType: "claim_recognition", sourceId: "11111111-2222-4333-8444-555555555555", purpose: "recognition", accountCode: "5100" }), lookups({ approvals: new Map() }));
    expect(none.approvals).toBe("0 of 2");
  });

  it("shows the raw source for a recognition entry whose decision does not resolve", () => {
    const row = mapLedgerRow(posting({ sourceType: "claim_recognition", sourceId: "not-a-decision", purpose: "recognition", accountCode: "5100" }), lookups());
    expect(row.claim).toBe("Unresolved: claim_recognition not-a-decision (no allocation decision matches this source id)");
    expect(row.approvals).toBe(row.claim);
  });

  it("shows the capture id only when a stored donation receipt matches it", () => {
    const resolved = mapLedgerRow(posting(), lookups());
    expect(resolved.paypalReference).toBe("CAP1");
    expect(resolved.claim).toBe("No claim");
    const raw = mapLedgerRow(posting({ sourceId: "CAP_UNKNOWN" }), lookups());
    expect(raw.paypalReference).toBe("Unresolved: paypal_capture CAP_UNKNOWN (no donation receipt matches this capture id)");
    expect(raw.verify).toBe(false);
  });

  it("maps a settled payout to the payout item id and its claim", () => {
    const row = mapLedgerRow(posting({ sourceType: "paypal_payout_item", sourceId: "ITEM1", purpose: "settlement", accountCode: "2010" }), lookups());
    expect(row.paypalReference).toBe("ITEM1");
    expect(row.claim).toBe("claim-1");
    expect(row.approvals).toBe("2 of 2");
    expect(row.verify).toBe(false);
  });

  it("passes an UNKNOWN payout outcome through as UNKNOWN and flags the row, never as paid", () => {
    for (const unknown of [attempt({ itemStatus: "PENDING" }), attempt({ payoutBatchId: null }), attempt({ payoutBatchId: "bad id!" }), attempt({ state: "MYSTERY" })]) {
      const row = mapLedgerRow(posting({ sourceType: "paypal_payout_item", sourceId: "ITEM1", purpose: "settlement", accountCode: "2010" }), lookups({ attempts: new Map([["ITEM1", [unknown]]]) }));
      expect(row.paypalReference).toBe("UNKNOWN");
      expect(row.verify).toBe(true);
      expect(row.claim).toBe("claim-1");
    }
  });

  it("shows the raw source when no attempt, or more than one attempt, matches a payout item", () => {
    const base = posting({ sourceType: "paypal_payout_item", sourceId: "ITEM1", purpose: "settlement", accountCode: "2010" });
    const none = mapLedgerRow(base, lookups({ attempts: new Map() }));
    expect(none.paypalReference).toBe("Unresolved: paypal_payout_item ITEM1 (no disbursement attempt matches this payout item id)");
    expect(none.claim).toBe(none.paypalReference);
    expect(none.verify).toBe(false);
    const two = mapLedgerRow(base, lookups({ attempts: new Map([["ITEM1", [attempt(), attempt({ claimId: "claim-2" })]]]) }));
    expect(two.paypalReference).toBe("Unresolved: paypal_payout_item ITEM1 (more than one disbursement attempt matches this payout item id)");
    expect(two.claim).toBe(two.paypalReference);
  });

  it("reads approvals as the count with the requirement beside it when above 2", () => {
    expect(REQUIRED_APPROVALS).toBe(2);
    expect(approvalsText(0)).toBe("0 of 2");
    expect(approvalsText(1)).toBe("1 of 2");
    expect(approvalsText(2)).toBe("2 of 2");
    expect(approvalsText(3)).toBe("3 (2 required)");
  });
});

describe("LG-02 exact sums", () => {
  it("sums both sides in bigint and returns decimal strings", () => {
    expect(sumSides([])).toEqual({ debitCents: "0", creditCents: "0" });
    expect(sumSides([{ debitCents: BIG, creditCents: 0n }, { debitCents: 0n, creditCents: BIG }])).toEqual({ debitCents: "9007199254740993", creditCents: "9007199254740993" });
    expect(sumSides([{ debitCents: BIG, creditCents: 0n }, { debitCents: 1n, creditCents: 0n }]).debitCents).toBe("9007199254740994");
  });
  it("caps the grid at 2000 rows", () => { expect(LEDGER_ROW_CAP).toBe(2000); });
});

describe("ledger column set", () => {
  const leaves = leafColumns(ledgerColumns());
  it("has separate Debit and Credit columns with BigInt filters and exactly the phone and total fields it names", () => {
    const fields = leaves.map(leaf => leaf.field);
    expect(fields).toEqual(["recordedAt", "effectiveOn", "entryType", "account", "fund", "debitCents", "creditCents", "claim", "approvals", "paypalReference"]);
    for (const name of ["debitCents", "creditCents"]) expect(leaves.find(leaf => leaf.field === name)?.filter).toBe("agBigIntColumnFilter");
    for (const name of [...LEDGER_PHONE_COLUMNS, ...LEDGER_TOTAL_FIELDS]) expect(fields).toContain(name);
    expect([...LEDGER_PHONE_COLUMNS]).toEqual(["recordedAt", "entryType", "debitCents", "creditCents"]);
    expect([...LEDGER_TOTAL_FIELDS]).toEqual(["debitCents", "creditCents"]);
    expect(ledgerTotalLabel(3)).toBe("Total of 3 shown");
  });
  it("sets no editable column", () => { for (const leaf of leaves) expect(leaf.editable).not.toBe(true); });
  // Orchestrator addition at the merge, after the 1440 still showed amounts left-aligned under right-aligned headers.
  it("aligns money right, ends Credit on the frame edge (1170 px), and gives truncated account and fund names a full-text tooltip", () => {
    for (const name of ["debitCents", "creditCents"]) {
      const money = leaves.find(leaf => leaf.field === name)!;
      expect(money.type).toBe("rightAligned");
      expect(money.cellClass).toEqual(expect.arrayContaining(["gx-cell-num", "ag-right-aligned-cell"]));
    }
    const upToCredit = leaves.slice(0, leaves.findIndex(leaf => leaf.field === "creditCents") + 1);
    const entryAndMoney = upToCredit.reduce((sum, leaf) => sum + (leaf.width ?? 0), 0);
    expect(entryAndMoney).toBeLessThanOrEqual(1170); expect(entryAndMoney).toBeGreaterThanOrEqual(1168);
    const tip = (field: string, row: Partial<LedgerRow>) => (leaves.find(leaf => leaf.field === field)!.tooltipValueGetter as (params: unknown) => unknown)({ data: row, node: {} });
    expect(tip("account", { account: "3100 Net assets with donor restrictions" })).toBe("3100 Net assets with donor restrictions");
    expect(tip("fund", { fund: "Tallow Creek Robot Kit Initiative", fundTip: "Fund id fund_b." })).toBe("Tallow Creek Robot Kit Initiative. Fund id fund_b.");
    expect(tip("fund", { fund: "", fundTip: "This account is not kept by fund." })).toBe("This account is not kept by fund.");
  });
});

// The view reads. These static checks fail if a write path or a payment path is added to the view or its page.
const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name); return entry.isDirectory() ? walk(path) : [path];
});
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const viewFiles = ["src/ledger/view.ts", ...walk(join("src", "app", "ledger"))];
const importSpecifiers = (text: string) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map(match => match[1]!);

describe("LG-02 static: the view and its page never write or call a provider", () => {
  it("covers the view loader, the page, the client and the columns", () => {
    expect(viewFiles).toEqual(expect.arrayContaining(["src/ledger/view.ts", join("src", "app", "ledger", "page.tsx"), join("src", "app", "ledger", "client.tsx"), join("src", "app", "ledger", "columns.ts")]));
  });
  it("contains no insert, update or delete in code or comments", () => {
    for (const path of viewFiles) {
      const text = readFileSync(path, "utf8");
      expect(text, `${path} has an insert, update or delete word`).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(withoutComments(text), `${path} calls a write method`).not.toMatch(/\.(insert|update|delete|truncate)\s*\(/);
    }
  });
  it("imports neither the PayPal adapter nor a ledger writer module", () => {
    const banned = /(?:^|\/)(?:paypal(?:\/|$)|adapter$|journal$|donation$|payout$|service$|retry$|webhooks$|opening$)/;
    for (const path of viewFiles) {
      for (const specifier of importSpecifiers(readFileSync(path, "utf8"))) {
        if (!specifier.startsWith(".")) continue;
        expect(banned.test(specifier) && !specifier.endsWith("donation/note"), `${path} imports ${specifier}`).toBe(false);
      }
    }
  });
  it("starts the read transaction read only before any select", () => {
    const text = readFileSync("src/ledger/view.ts", "utf8");
    const readOnly = text.indexOf("set transaction read only");
    const firstSelect = text.indexOf(".select(");
    expect(readOnly).toBeGreaterThan(0);
    expect(firstSelect).toBeGreaterThan(readOnly);
    expect(text).toMatch(/isolationLevel:\s*['"]repeatable read['"]/);
  });
  it("exposes no API route for the ledger and has no server action", () => {
    expect(walk(join("src", "app", "api")).filter(path => /ledger/i.test(path))).toEqual([]);
    for (const path of viewFiles) expect(readFileSync(path, "utf8")).not.toMatch(/['"]use server['"]/);
  });
});
