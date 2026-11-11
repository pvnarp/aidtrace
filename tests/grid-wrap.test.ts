import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALLOWED_MODULE_NAMES, BASE_MODULES, WRAP_MODULES } from "../src/app/grid/modules";
import { textColumn, leafColumns, WRAP_CELL_CLASS } from "../src/app/grid/columns";
import { ledgerColumns } from "../src/app/ledger/columns";
import { donationsColumns } from "../src/app/donations/columns";
import { queueColumns } from "../src/app/approver-queue/columns";

// IAC-232, long names in the AG Grid views wrap instead of truncating. Pure column definitions: no browser, no database.
const WRAPPED_LEDGER = ["account", "fund"];
const WRAPPED_DONATIONS = ["donor", "fund", "vendor"];
const wrapped = (column: { wrapText?: boolean; autoHeight?: boolean }) => column.wrapText === true && column.autoHeight === true;
const unwrapped = (column: { wrapText?: boolean; autoHeight?: boolean }) => !column.wrapText && !column.autoHeight;
const pinnedClass = (column: { cellClass?: unknown }) => (column.cellClass as (p: unknown) => unknown)({ node: { rowPinned: "bottom" } });
const dataClass = (column: { cellClass?: unknown }) => (column.cellClass as (p: unknown) => unknown)({ node: { rowPinned: undefined } });

describe("WR-01 to WR-08 wrapped name columns", () => {
  it("WR-01: ledger account and fund wrap and grow the row", () => {
    const leaves = leafColumns(ledgerColumns());
    for (const field of WRAPPED_LEDGER) expect(wrapped(leaves.find(leaf => leaf.field === field)!), field).toBe(true);
  });
  it("WR-02: every other ledger leaf does not wrap", () => {
    for (const leaf of leafColumns(ledgerColumns()).filter(leaf => !WRAPPED_LEDGER.includes(leaf.field!))) expect(unwrapped(leaf), leaf.field).toBe(true);
  });
  it("WR-03: donations donor, fund and vendor wrap and grow the row", () => {
    const leaves = leafColumns(donationsColumns());
    for (const field of WRAPPED_DONATIONS) expect(wrapped(leaves.find(leaf => leaf.field === field)!), field).toBe(true);
  });
  it("WR-04: every other donations leaf does not wrap", () => {
    for (const leaf of leafColumns(donationsColumns()).filter(leaf => !WRAPPED_DONATIONS.includes(leaf.field!))) expect(unwrapped(leaf), leaf.field).toBe(true);
  });
  it("WR-05: the approver queue does not wrap anywhere", () => {
    for (const leaf of leafColumns(queueColumns())) expect(unwrapped(leaf), leaf.field).toBe(true);
  });
  it("WR-06: a wrapped column puts the gx-wrap class on data cells and never on the pinned totals row", () => {
    const fund = leafColumns(ledgerColumns()).find(leaf => leaf.field === "fund")!;
    expect(WRAP_CELL_CLASS).toBe("gx-wrap");
    expect(dataClass(fund)).toBe("gx-wrap");
    expect(pinnedClass(fund)).toBeUndefined();
  });
  it("WR-07: wrap is off by default, and widths stay as tuned", () => {
    const plain = textColumn<{ name: string }>({ field: "name", headerName: "Name" });
    expect(unwrapped(plain)).toBe(true); expect(plain.cellClass).toBeUndefined();
    const widths = (leaves: { field?: string; width?: number }[], fields: string[]) => fields.map(field => leaves.find(leaf => leaf.field === field)!.width);
    expect(widths(leafColumns(ledgerColumns()), ["account", "fund"])).toEqual([164, 122]); // Nov 10: 14 px moved to Recorded (UTC) so a two-digit day and hour fit.
    expect(widths(leafColumns(donationsColumns()), ["donor", "fund", "vendor"])).toEqual([112, 170, 170]);
  });
  it("WR-08: RowAutoHeight is an extra, not a base module, and exactly the two wrapping grids pass it", () => {
    const names = (modules: readonly unknown[]) => modules.map(module => (module as { moduleName?: string }).moduleName);
    expect(names(WRAP_MODULES)).toEqual(["RowAutoHeight"]);
    expect(ALLOWED_MODULE_NAMES).toContain("RowAutoHeight");
    expect(names(BASE_MODULES)).not.toContain("RowAutoHeight");
    for (const path of ["src/app/ledger/client.tsx", "src/app/donations/client.tsx"]) expect(readFileSync(path, "utf8"), path).toContain("extraModules={WRAP_MODULES}");
    expect(readFileSync("src/app/approver-queue/client.tsx", "utf8")).not.toContain("WRAP_MODULES");
    expect(readFileSync("src/app/assisted-queue/client.tsx", "utf8")).not.toContain("WRAP_MODULES");
  });
});
