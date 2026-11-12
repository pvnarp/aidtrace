import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { leafColumns } from "../src/app/grid/columns";
import { queueColumns } from "../src/app/approver-queue/columns";
import { ChecksCell } from "../src/app/assisted-queue/cells";
import { assistedColumns, type AssistedQueueRow } from "../src/app/assisted-queue/columns";
import { BULK_LIMIT, BULK_SAVED_TEXT, BULK_SKIP_REASONS, BULK_SKIP_TEXT } from "../src/fund-modes/bulk-reasons";
import { holdsLabel } from "../src/server/assisted-checks";

// IAC-405 step 2 PR A, AS-30 to AS-34: pure unit tests of the Assisted queue columns, the Checks cell and the closed reason list. No database, no browser.
const sample = (over: Partial<AssistedQueueRow> = {}): AssistedQueueRow => ({
  id: "R-0a1b2c3d-0000-4000-8000-000000000001", claimant: "Maria Alvarez", vendor: "Cedar Science Shop", fund: "Tallow Creek Robot Kit Initiative", amountCents: "30000", approvalCount: 0,
  approvals: "Approvals: 0 of 1", waitingSince: "2026-11-01T10:00:00.000Z", age: "2h", href: "/claims/R-0a1b2c3d-0000-4000-8000-000000000001", claimVersion: 1, checks: "No holds found", selectable: true, ...over,
});
const code = (path: string) => readFileSync(path, "utf8").split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");

describe("AS-30 the Assisted columns", () => {
  it("AS-30: are the queue's seven columns with Checks directly after Status, and the queue's own list is unchanged", () => {
    expect(leafColumns(queueColumns()).map(column => column.headerName)).toEqual(["Claimant", "Vendor", "Status", "Amount", "Progress", "Age", "Review"]);
    const leaves = leafColumns(assistedColumns());
    expect(leaves.map(column => column.headerName)).toEqual(["Claimant", "Vendor", "Status", "Checks", "Amount", "Progress", "Age", "Review"]);
    expect(leaves.map(column => column.field)).toEqual(["claimant", "vendor", "approvals", "checks", "amountCents", "approvalCount", "waitingSince", "href"]);
  });
  it("AS-30: edits nothing, filters Checks as text and reads a Manual row's missing checks as an empty cell", () => {
    const checks = leafColumns(assistedColumns()).find(column => column.field === "checks")!;
    expect(checks.editable).not.toBe(true); expect(checks.filter).toBe("agTextColumnFilter");
    const meta = checks.context as { kind: string; text: (row: AssistedQueueRow) => string };
    expect(meta.kind).toBe("text");
    expect(meta.text(sample())).toBe("No holds found");
    const { checks: _drop, selectable: _s, claimVersion: _v, ...manual } = sample();
    expect(meta.text(manual as AssistedQueueRow)).toBe("");
    expect((checks.valueGetter as (params: unknown) => unknown)({ data: manual })).toBe("");
  });
});

describe("AS-31 the Checks cell", () => {
  const html = (data?: AssistedQueueRow) => renderToStaticMarkup(createElement(ChecksCell, { data }));
  it("AS-31: shows each of the three words with its state, and nothing for a row with no checks", () => {
    expect(html(sample())).toBe('<span class="aq-check" data-state="none-found">No holds found</span>');
    expect(html(sample({ checks: "2 holds" }))).toBe('<span class="aq-check" data-state="holds">2 holds</span>');
    expect(html(sample({ checks: "1 hold" }))).toBe('<span class="aq-check" data-state="holds">1 hold</span>');
    expect(html(sample({ checks: "Not checked yet" }))).toBe('<span class="aq-check" data-state="not-yet">Not checked yet</span>');
    expect(html(sample({ checks: undefined }))).toBe("");
    expect(html(undefined)).toBe("");
  });
  it("AS-31: never calls a check state cleared, approved or passed (PC-12)", () => {
    for (const path of ["src/app/assisted-queue/cells.tsx", "src/app/assisted-queue/columns.ts", "src/app/assisted-queue/client.tsx", "src/server/assisted-checks.ts", "src/fund-modes/review-line.ts"]) {
      const text = code(path);
      expect(text, path).not.toMatch(/\b(cleared|passed)\b/i);
    }
    expect([holdsLabel(1), holdsLabel(3), "No holds found", "Not checked yet"].join(" ")).not.toMatch(/clear|approv|pass/i);
  });
});

describe("AS-32 the closed reason list", () => {
  it("AS-32: every reason has one plain sentence with no dash, no hash and no table of ledger words, and the limit is 25", () => {
    expect(BULK_LIMIT).toBe(25);
    expect(Object.keys(BULK_SKIP_TEXT).sort()).toEqual([...BULK_SKIP_REASONS].sort());
    for (const sentence of [...Object.values(BULK_SKIP_TEXT), BULK_SAVED_TEXT]) {
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence, sentence).not.toMatch(/[\u2013\u2014]/);
      expect(sentence, sentence).not.toMatch(/hash|decision|ledger|serializ|postgres|sandbox|fictional/i);
    }
    expect(BULK_SKIP_TEXT.HOLD_FOUND).toBe("a hold was found after this page loaded. Open the claim to review it.");
  });
  it("AS-32: the reason list file has no imports, so the browser and the server read the same sentences", () => {
    expect(readFileSync("src/fund-modes/bulk-reasons.ts", "utf8")).not.toMatch(/^\s*import\b/m);
  });
});

describe("AS-33 the Assisted client posts only claim ids and versions", () => {
  const client = code("src/app/assisted-queue/client.tsx");
  it("AS-33: the button reads Approve N selected, is disabled with none selected or more than the limit, and there is no send control", () => {
    expect(client).toContain("Approve {count} selected");
    expect(client).toContain("disabled={busy || count === 0 || tooMany}");
    expect(client).not.toMatch(/Send|PayPal payout|\/send|action="send"/);
    expect(client).toContain("body.append('claim', `${row.id}:${row.claimVersion}`)");
  });
  it("AS-33: the answer is read by shape and each sentence comes from the fixed table, never from the response text", () => {
    expect(client).toContain("BULK_SKIP_TEXT[entry.reason]");
    expect(client).toContain("text: BULK_SAVED_TEXT");
    expect(client).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});

describe("AS-34 the claim page line", () => {
  const page = code("src/app/claims/[claimId]/page.tsx");
  it("AS-34: reads n of 1, Assisted, no holds found only for the no holds mode and keeps n of 2 for the others", () => {
    expect(page).toContain('data-review-mode={view.reviewMode}');
    expect(page).toContain('{view.reviewMode === "ASSISTED_NO_HOLDS" ? <><strong>{approvals.length} of 1</strong>, Assisted, no holds found</> : <strong>{approvals.length} of 2</strong>}');
  });
});
