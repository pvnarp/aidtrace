import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { columnsBeyondEdge, overlayParamsFor, type EdgeApi, type EdgeState } from "../src/app/grid/edge";
import { centsColumn, dateColumn, leafColumns, statusColumn, textColumn } from "../src/app/grid/columns";
import { ledgerColumns } from "../src/app/ledger/columns";
import { donationsColumns } from "../src/app/donations/columns";
import { queueColumns } from "../src/app/approver-queue/columns";

// IAC-440 grid report polish (docs/ASSUMPTIONS.md section 75). GE-11 to GE-16 are pure unit and static tests: no browser, no database. The browser
// checks are GE-01 to GE-10 in e2e/ledger.spec.ts, e2e/donations.spec.ts and e2e/approver-queue.spec.ts.

const stateOf = (columns: { id: string; width: number; hidden?: boolean }[]): EdgeState => ({
  columnOrder: { orderedColIds: columns.map(column => column.id) },
  columnVisibility: columns.some(column => column.hidden) ? { hiddenColIds: columns.filter(column => column.hidden).map(column => column.id) } : undefined,
  columnSizing: { columnSizingModel: columns.map(column => ({ colId: column.id, width: column.width })) },
});
const gridOf = (viewport: { left: number; right: number }, state: EdgeState): EdgeApi => ({ getHorizontalPixelRange: () => viewport, getState: () => state });
const NAMES = { a: "Alpha", b: "Beta", c: "Gamma" };

describe("GE-11 the empty copy reaches the grid's own overlays and nothing else", () => {
  it("passes no parameters when a grid gives no copy, so AG Grid keeps its default text", () => {
    expect(overlayParamsFor(undefined)).toBeUndefined();
    expect(overlayParamsFor({})).toBeUndefined();
    expect(overlayParamsFor({ none: "", filtered: "" })).toBeUndefined();
  });
  it("maps none to the no rows overlay and filtered to the no matching rows overlay", () => {
    expect(overlayParamsFor({ none: "No gifts yet.", filtered: "No gifts match." })).toEqual({ noRows: { overlayText: "No gifts yet." }, noMatchingRows: { overlayText: "No gifts match." } });
  });
  it("leaves the half that is not given at its default", () => {
    expect(overlayParamsFor({ filtered: "No queued claims match this search or filter." })).toEqual({ noMatchingRows: { overlayText: "No queued claims match this search or filter." } });
    expect(overlayParamsFor({ none: "No postings yet." })).toEqual({ noRows: { overlayText: "No postings yet." } });
  });
});

describe("GE-12 the overflow reading names the columns past the right edge", () => {
  const state = stateOf([{ id: "a", width: 400 }, { id: "b", width: 400 }, { id: "c", width: 300 }, { id: "d", width: 100 }]);
  it("is empty when every column fits, including a total exactly as wide as the viewport", () => {
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 1200 }, state), NAMES)).toEqual([]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 1300 }, state), NAMES)).toEqual([]);
  });
  it("names, in order, each column that does not end inside the viewport, and falls back to the column id with no header name", () => {
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 1170 }, state), NAMES)).toEqual(["d"]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 1000 }, state), NAMES)).toEqual(["Gamma", "d"]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 500 }, state), NAMES)).toEqual(["Beta", "Gamma", "d"]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 500 }, state))).toEqual(["b", "c", "d"]);
  });
  it("leaves out hidden columns, which the phone layout and a saved state both use", () => {
    const hiddenC = stateOf([{ id: "a", width: 400 }, { id: "b", width: 400 }, { id: "c", width: 300, hidden: true }, { id: "d", width: 100 }]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 850 }, hiddenC), NAMES)).toEqual(["d"]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 900 }, stateOf([{ id: "a", width: 400 }, { id: "b", width: 400, hidden: true }])), NAMES)).toEqual([]);
  });
  it("does not change with the scroll position, because the viewport width is the range, not its right end", () => {
    expect(columnsBeyondEdge(gridOf({ left: 230, right: 1400 }, state), NAMES)).toEqual(["d"]);
  });
  it("is empty before the grid has a width or any column", () => {
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 0 }, state), NAMES)).toEqual([]);
    expect(columnsBeyondEdge(gridOf({ left: 0, right: 1170 }, {}), NAMES)).toEqual([]);
  });
});

describe("GE-13 the report grids end their first screen on a column boundary", () => {
  // The grid frame is 1172 px wide at 1280 and 1440 px viewports, so 1170 px inside its border. A boundary within 2 px of that edge cuts no column.
  const FRAME_INNER = 1170;
  const upTo = (field: string, leaves: readonly { field?: unknown; width?: number }[]) => leaves.slice(0, leaves.findIndex(leaf => leaf.field === field) + 1).reduce((sum, leaf) => sum + (leaf.width ?? 0), 0);
  it("ledger: Credit ends within 2 px of the edge, and each field has the room its cell and filter need", () => {
    const leaves = leafColumns(ledgerColumns());
    expect(Math.abs(upTo("creditCents", leaves) - FRAME_INNER)).toBeLessThanOrEqual(2);
    const width = (field: string) => leaves.find(leaf => leaf.field === field)!.width!;
    // A date floating filter without its menu button needs about 184 px of input plus 32 px of cell padding.
    expect(width("effectiveOn")).toBeGreaterThanOrEqual(216); expect(width("recordedAt")).toBeGreaterThanOrEqual(216);
    // Every entry type label is 19 characters or fewer, about 8 px each, plus 32 px of cell padding.
    expect(width("entryType")).toBeGreaterThanOrEqual(184);
    for (const field of ["debitCents", "creditCents"]) expect(width(field), field).toBeGreaterThanOrEqual(120);
  });
  it("donations: Waiting ends within 2 px of the edge, Received holds a date filter, and the money columns keep 120 px", () => {
    const leaves = leafColumns(donationsColumns());
    expect(Math.abs(upTo("waitingCents", leaves) - FRAME_INNER)).toBeLessThanOrEqual(2);
    const width = (field: string) => leaves.find(leaf => leaf.field === field)!.width!;
    expect(width("received")).toBeGreaterThanOrEqual(216);
    for (const field of ["amountCents", "matchedCents", "waitingCents"]) expect(width(field), field).toBeGreaterThanOrEqual(120);
  });
});

describe("GE-14 the shared column builders drop the floating filter's menu button and keep the header's", () => {
  it("sets suppressFloatingFilterButton on the text, date, status and money builders, and never turns the filter itself off", () => {
    const built = [
      textColumn<{ a: string }>({ field: "a", headerName: "A" }), dateColumn<{ a: string }>({ field: "a", headerName: "A" }),
      statusColumn<{ a: string }>({ field: "a", headerName: "A" }), centsColumn<{ a: string }>({ field: "a", headerName: "A" }),
    ];
    for (const leaf of built) { expect(leaf.suppressFloatingFilterButton, String(leaf.filter)).toBe(true); expect(leaf.floatingFilter).toBe(true); expect(leaf.filter).toBeTruthy(); expect(leaf.suppressHeaderFilterButton).not.toBe(true); }
  });
  it("lets a column opt out of the floating filter entirely, as the approver queue does for its link and count columns", () => {
    const leaves = leafColumns(queueColumns());
    expect(leaves.some(leaf => leaf.floatingFilter === false)).toBe(true);
    for (const leaf of leaves.filter(item => item.floatingFilter !== false)) expect(leaf.suppressFloatingFilterButton, String(leaf.field)).toBe(true);
  });
});

describe("GE-16 each report page hands the grid its house copy, and only the words the brief names", () => {
  const client = (name: string) => readFileSync(`src/app/${name}/client.tsx`, "utf8");
  it("ledger: both messages, wired through the grid's prop", () => {
    const source = client("ledger");
    expect(source).toContain("{ none: 'No postings yet.', filtered: 'No postings match this search or filter.' }"); expect(source).toContain("emptyMessages={EMPTY}");
  });
  it("donations: both messages, wired through the grid's prop", () => {
    const source = client("donations");
    expect(source).toContain("none: 'No gifts yet. A completed PayPal gift shows here with its receipt match.'"); expect(source).toContain("filtered: 'No gifts match this search or filter.'"); expect(source).toContain("emptyMessages={EMPTY}");
  });
  it("approver queue: only the filtered message, so its empty-queue home is untouched", () => {
    const source = client("approver-queue");
    expect(source).toContain("{ filtered: 'No queued claims match this search or filter.' }"); expect(source).not.toContain("none:"); expect(source).toContain("emptyMessages={EMPTY}");
  });
});
