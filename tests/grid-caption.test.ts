import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPTION_PREFIX, gridCaption } from "../src/app/grid/caption";
import { GRID_SURFACES } from "../src/app/architecture/grid-surfaces";

// GV-01 to GV-04 (November 10, "make it really obvious where AG Grid is being used"): static and pure tests, no browser, no database.
// The browser checks are GV-05 to GV-08 inside e2e/ledger.spec.ts, e2e/donations.spec.ts, e2e/approver-queue.spec.ts and e2e/fund-modes-bulk.spec.ts.
const BOOLS = [false, true];

describe("GV-01 the caption names AG Grid and only the abilities the grid has", () => {
  for (const selection of BOOLS) for (const csv of BOOLS) for (const totals of BOOLS) {
    it(`selection ${selection}, csv ${csv}, totals ${totals}`, () => {
      const text = gridCaption({ selection, csv, totals });
      expect(text).toMatch(/^Table by AG Grid Community, read only: search, sort and filter any column/);
      expect(text.includes("select rows")).toBe(selection);
      expect(text.includes("export CSV")).toBe(csv);
      expect(text.includes("The total row follows the filter.")).toBe(totals);
      expect(text).toMatch(/Your column layout is kept for you\.$/);
      expect(text).not.toMatch(/sandbox|AI off|fictional/i);
      expect(text).not.toMatch(new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)));
    });
  }
  it("gives the exact line for the ledger and for the approver queue", () => {
    expect(gridCaption({ selection: false, csv: true, totals: true })).toBe("Table by AG Grid Community, read only: search, sort and filter any column, export CSV. The total row follows the filter. Your column layout is kept for you.");
    expect(gridCaption({ selection: false, csv: false, totals: false })).toBe("Table by AG Grid Community, read only: search, sort and filter any column. Your column layout is kept for you.");
  });
});

describe("GV-02 DataGrid renders the caption from its own props and nothing else", () => {
  const source = readFileSync("src/app/grid/grid.tsx", "utf8");
  it("passes only selection, csv and totals, with the test id", () => {
    expect(source).toContain('data-testid="gx-caption"');
    expect(source).toContain("gridCaption({ selection: Boolean(selection), csv: Boolean(csv), totals: Boolean(totals) })");
  });
  it("sets the library name in bold after the fixed prefix, so the visible text is the caption exactly", () => {
    expect(CAPTION_PREFIX).toBe("Table by AG Grid Community");
    expect(source).toContain('Table by <strong className="gx-caption-name">AG Grid Community</strong>{gridCaption(');
    expect(source).toContain(".slice(CAPTION_PREFIX.length)}</p>");
    for (const input of [{ selection: true, csv: true, totals: true }, { selection: false, csv: false, totals: false }]) expect(gridCaption(input).startsWith(CAPTION_PREFIX)).toBe(true);
  });
});

describe("GV-03 the How it works section lists the four surfaces", () => {
  it("names four surfaces on real routes, each with what it does and its value", () => {
    expect(GRID_SURFACES.length).toBe(4);
    expect(new Set(GRID_SURFACES.map(surface => surface.href))).toEqual(new Set(["/", "/ledger", "/donations"]));
    for (const surface of GRID_SURFACES) { expect(surface.does.length).toBeGreaterThan(20); expect(surface.value.length).toBeGreaterThan(20); }
  });
  it("is on the page, links only for approvers, and says the tables are read only", () => {
    const page = readFileSync("src/app/architecture/page.tsx", "utf8");
    expect(page).toContain("Where AG Grid works");
    expect(page).toContain('user.role === "APPROVER"');
    expect(page).toMatch(/read only: no editing, no write path, and they never approve or pay/);
  });
});

describe("GV-04 the README names all four surfaces", () => {
  it("lists them with the caption and the How it works section", () => {
    const readme = readFileSync("README.md", "utf8");
    const section = readme.slice(readme.indexOf("### AG Grid Community"), readme.indexOf("## 1. Identify this checkout"));
    for (const word of ["Approver queue", "Assisted queue", "Ledger (/ledger)", "Donations (/donations)", "Where AG Grid works", "four read-only approver tables"]) expect(section, word).toContain(word);
  });
});
