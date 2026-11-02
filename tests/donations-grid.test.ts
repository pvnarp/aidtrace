import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DONATIONS_ROW_CAP, NONE_YET, mapDonationRow, payoutLabel } from "../src/donation/donations-grid";
import { buildGiftTrail, type TrailApplication, type TrailInput } from "../src/donation/trail";
import type { PayoutNoteStatus } from "../src/donation/note";
import { donationsColumns, donationsTotalLabel, DONATIONS_PHONE_COLUMNS, DONATIONS_TOTAL_FIELDS } from "../src/app/donations/columns";
import { leafColumns } from "../src/app/grid/columns";
import { navLinksFor } from "../src/app/nav";

// IAC-413 PR B (docs/plans/DONOR_TRAIL_SCOPE.md section 4). The row mapper and the column set run as pure unit tests. The static section is GT-29
// (and GT-30 for the modules this package adds): source text only, no database, no browser.
const app = (over: Partial<TrailApplication> = {}): TrailApplication => ({ lineDescription: "Robot kit", vendor: "Maker Supply", appliedCents: 1000n, lineCents: 5000n, approvalCount: 2, payout: "NO_PAYMENT", batchId: null, ...over });
const gift = (applications: TrailApplication[], over: Partial<TrailInput> = {}): TrailInput => ({
  grossCents: applications.reduce((sum, row) => sum + row.appliedCents, 0n) + (over.unspentCents ?? 0n), unspentCents: 0n, fundName: "Tallow Creek Robot Kit Initiative", effectiveOn: "2026-10-22", applications, ...over,
});
const row = (applications: TrailApplication[], over: Partial<TrailInput> = {}, donor: string | null = null, captureId = "CAPTURE_ABC123XYZ") =>
  mapDonationRow(captureId, "2026-10-22", donor, buildGiftTrail(gift(applications, over)));
const paying = (...payouts: PayoutNoteStatus[]) => payouts.map((payout, index) => app({ payout, batchId: payout === "PAID" ? `B${index}_TAIL${index}${index}` : null, lineDescription: `Line ${index + 1}` }));

describe("GT-31 support: the row mapper words every trail state, payout state and edge case", () => {
  it("words the five trail states", () => {
    expect(row([], { unspentCents: 2500n, grossCents: 2500n }).state).toBe("Waiting for a receipt");
    expect(row([app({ approvalCount: 1 })]).state).toBe("Applied");
    expect(row([app()]).state).toBe("Approved");
    expect(row([app({ payout: "PROCESSING" })]).state).toBe("Payout in progress");
    expect(row([app({ payout: "PAID", batchId: "BATCH_ABC123" })]).state).toBe("Paid");
  });
  it("words each payout and carries the dot and the verify flag with it", () => {
    const cases: [PayoutNoteStatus, string, string, boolean][] = [
      ["NO_PAYMENT", "No payment", "gx-dot-idle", false], ["PROCESSING", "Processing", "gx-dot-idle", false], ["UNKNOWN", "Being verified", "gx-dot-hold", true],
      ["NEEDS_ATTENTION", "Needs attention", "gx-dot-stop", false], ["PAID", "Paid", "gx-dot-ok", false],
    ];
    for (const [status, label, dot, verify] of cases) {
      const result = row(paying(status));
      expect(result, status).toMatchObject({ payoutStatus: label, payoutDot: dot, verify });
    }
  });
  it("never lets an unverified outcome read as paid or failed, in words or in its tooltip", () => {
    const result = row(paying("UNKNOWN"));
    expect(result.payoutStatus).toBe("Being verified"); expect(result.payoutStatus).not.toMatch(/paid|fail|declin|error/i);
    expect(result.payoutTip).toBe("The outcome is not verified. It is not paid and it is not failed. It needs reconciliation.");
    expect(result.paypalReference).toBe(NONE_YET);
  });
  it("says Partly paid, and names an unverified or failed line instead of hiding it", () => {
    expect(row(paying("PAID", "NO_PAYMENT"))).toMatchObject({ payoutStatus: "Partly paid", payoutDot: "gx-dot-idle", verify: false });
    expect(row(paying("PAID", "UNKNOWN"))).toMatchObject({ payoutStatus: "Partly paid, 1 being verified", payoutDot: "gx-dot-hold", verify: true });
    expect(row(paying("PAID", "NEEDS_ATTENTION"))).toMatchObject({ payoutStatus: "Partly paid, 1 needs attention", payoutDot: "gx-dot-stop", verify: false });
    expect(row(paying("PAID", "UNKNOWN", "NEEDS_ATTENTION", "NEEDS_ATTENTION"))).toMatchObject({ payoutStatus: "Partly paid, 1 being verified, 2 need attention", payoutDot: "gx-dot-hold", verify: true });
    const trail = buildGiftTrail(gift(paying("PAID", "UNKNOWN")));
    expect(payoutLabel(trail)).toBe("Partly paid, 1 being verified");
  });
  it("shows a verified payout's last 6 batch characters only, and None yet otherwise", () => {
    expect(row([app({ payout: "PAID", batchId: "BATCH_ABC123" })]).paypalReference).toBe("ABC123");
    const two = row(paying("PAID", "PAID"));
    expect(two.paypalReference).toBe("2 batches"); expect(two.paypalTip).toContain("TAIL00, TAIL11"); expect(two.paypalTip).not.toContain("B0_TAIL00");
    expect(row(paying("PAID", "PROCESSING")).paypalReference).toBe("TAIL00");
    for (const status of ["NO_PAYMENT", "PROCESSING", "UNKNOWN", "NEEDS_ATTENTION"] as const) expect(row(paying(status)).paypalReference, status).toBe(NONE_YET);
    expect(row([], { grossCents: 100n, unspentCents: 100n }).paypalReference).toBe(NONE_YET);
  });
  it("summarizes lines and vendors with tooltips that list each one", () => {
    const one = row([app()]);
    expect(one.lines).toBe("1 line"); expect(one.linesTip).toBe("Robot kit: $10.00 of the $50.00 line"); expect(one.vendor).toBe("Maker Supply"); expect(one.vendorTip).toBe("Maker Supply");
    const many = row([app({ lineDescription: "Kit A", appliedCents: 1000n, lineCents: 5000n }), app({ lineDescription: "Kit B", vendor: "Gear Works", appliedCents: 250n, lineCents: 1000n })]);
    expect(many.lines).toBe("2 lines"); expect(many.linesTip).toBe("Kit A: $10.00 of the $50.00 line\nKit B: $2.50 of the $10.00 line");
    expect(many.vendor).toBe("2 vendors"); expect(many.vendorTip).toBe("Maker Supply\nGear Works");
    const same = row([app({ lineDescription: "Kit A" }), app({ lineDescription: "Kit B" })]);
    expect(same.lines).toBe("2 lines"); expect(same.vendor).toBe("Maker Supply");
    const none = row([], { unspentCents: 900n, grossCents: 900n });
    expect(none).toMatchObject({ lines: "0 lines", vendor: NONE_YET, matchedCents: "0", waitingCents: "900" });
    expect(none.linesTip).toBe("No receipt line has matched this gift yet.");
  });
  it("keeps matched plus waiting equal to the amount, as strings, past 2^53", () => {
    const big = 9007199254740993n;
    const result = row([app({ appliedCents: 5n, lineCents: 10n })], { unspentCents: big - 5n, grossCents: big });
    expect(result).toMatchObject({ amountCents: "9007199254740993", matchedCents: "5", waitingCents: "9007199254740988" });
    for (const field of ["amountCents", "matchedCents", "waitingCents"] as const) expect(typeof result[field]).toBe("string");
    expect(BigInt(result.matchedCents) + BigInt(result.waitingCents)).toBe(BigInt(result.amountCents));
  });
  it("cleans the donor name, defaults it, and leaves formula text for the CSV layer to escape", () => {
    expect(row([app()], {}, null).donor).toBe("A donor"); expect(row([app()], {}, " \u0007 ").donor).toBe("A donor");
    expect(row([app()], {}, "Ada\u0007\u202eLovelace").donor).toBe("Ada Lovelace");
    expect(row([app()], {}, "=HYPERLINK(\"x\")").donor).toBe("=HYPERLINK(\"x\")");
  });
  it("gives each gift an opaque stable id and shows only the last 6 characters of the capture id", () => {
    const first = row([app()], {}, null, "CAPTURE_ONE_111111"); const again = row([app()], {}, null, "CAPTURE_ONE_111111"); const other = row([app()], {}, null, "CAPTURE_TWO_222222");
    expect(first.id).toMatch(/^gift-[0-9a-f]{16}$/); expect(again.id).toBe(first.id); expect(other.id).not.toBe(first.id);
    expect(first.capture).toBe("111111"); expect(JSON.stringify(first)).not.toContain("CAPTURE_ONE"); expect(first.id).not.toContain("111111");
  });
  it("caps the grid at 2000 rows", () => { expect(DONATIONS_ROW_CAP).toBe(2000); });
});

describe("the donations column set", () => {
  const columns = donationsColumns(); const leaves = leafColumns(columns);
  it("has the three groups, the twelve headers and the filter types the scope lists", () => {
    expect(columns.map(group => (group as { headerName: string }).headerName)).toEqual(["Gift", "Trail", "Payout"]);
    expect(leaves.map(leaf => leaf.headerName)).toEqual(["Received", "Donor", "Amount", "Fund", "Capture", "State", "Matched", "Waiting", "Lines", "Vendor", "Status", "PayPal reference"]);
    expect(leaves.map(leaf => leaf.field)).toEqual(["received", "donor", "amountCents", "fund", "capture", "state", "matchedCents", "waitingCents", "lines", "vendor", "payoutStatus", "paypalReference"]);
    const filters = Object.fromEntries(leaves.map(leaf => [leaf.field, leaf.filter]));
    expect(filters).toMatchObject({ received: "agDateColumnFilter", amountCents: "agBigIntColumnFilter", matchedCents: "agBigIntColumnFilter", waitingCents: "agBigIntColumnFilter" });
    for (const name of ["donor", "fund", "capture", "state", "lines", "vendor", "payoutStatus", "paypalReference"]) expect(filters[name], name).toBe("agTextColumnFilter");
  });
  it("sorts newest first by default, edits nothing, and names the phone and total fields it holds", () => {
    expect(leaves.find(leaf => leaf.field === "received")?.sort).toBe("desc");
    for (const leaf of leaves) expect(leaf.editable).not.toBe(true);
    const fields = leaves.map(leaf => leaf.field);
    for (const name of [...DONATIONS_PHONE_COLUMNS, ...DONATIONS_TOTAL_FIELDS]) expect(fields).toContain(name);
    expect([...DONATIONS_TOTAL_FIELDS]).toEqual(["amountCents", "matchedCents", "waitingCents"]);
    expect(donationsTotalLabel(7)).toBe("Total of 7 gifts shown"); expect(donationsTotalLabel(1)).toBe("Total of 1 gift shown");
  });
  it("aligns money right and gives every summary cell a tooltip that carries its detail", () => {
    for (const name of ["amountCents", "matchedCents", "waitingCents"]) {
      const money = leaves.find(leaf => leaf.field === name)!;
      expect(money.type).toBe("rightAligned"); expect(money.cellClass).toEqual(expect.arrayContaining(["gx-cell-num", "ag-right-aligned-cell"]));
    }
    const sample = row([app({ lineDescription: "Kit A" }), app({ lineDescription: "Kit B", vendor: "Gear Works" })], {}, "Ada");
    const tip = (field: string) => (leaves.find(leaf => leaf.field === field)!.tooltipValueGetter as (params: unknown) => unknown)({ data: sample, node: {} });
    expect(tip("lines")).toBe(sample.linesTip); expect(tip("vendor")).toBe(sample.vendorTip); expect(tip("payoutStatus")).toBe(sample.payoutTip); expect(tip("paypalReference")).toBe(sample.paypalTip);
    expect(tip("capture")).toBe("Only the last 6 characters of the capture ID are shown.");
    const pinned = (field: string) => (leaves.find(leaf => leaf.field === field)!.tooltipValueGetter as (params: unknown) => unknown)({ data: sample, node: { rowPinned: "bottom" } });
    expect(pinned("lines")).toBeUndefined();
  });
  it("makes the quick filter search the line and vendor summaries as well as their cells", () => {
    const sample = row([app({ lineDescription: "Soldering station" }), app({ lineDescription: "Kit B", vendor: "Gear Works" })]);
    for (const [field, needle] of [["lines", "Soldering station"], ["vendor", "Gear Works"]] as const) {
      const quick = leaves.find(leaf => leaf.field === field)!.getQuickFilterText as (params: unknown) => string;
      expect(quick({ value: sample[field], data: sample })).toContain(needle);
    }
  });
  it("marks the payout cell with its dot class and leaves the pinned row plain", () => {
    const status = leaves.find(leaf => leaf.field === "payoutStatus")!; const cellClass = status.cellClass as (params: unknown) => string[] | undefined;
    const unknown = row(paying("UNKNOWN"));
    expect(cellClass({ data: unknown, node: {} })).toEqual(["gx-status", "gx-dot-hold"]);
    expect(cellClass({ data: unknown, node: { rowPinned: "bottom" } })).toBeUndefined();
  });
  it("keeps Received wide enough for the pinned total label", () => {
    expect(leaves.find(leaf => leaf.field === "received")!.width).toBeGreaterThanOrEqual(180);
  });
});

describe("navigation", () => {
  it("shows the Donations link to approvers only", () => {
    expect(navLinksFor("APPROVER")).toContainEqual({ label: "Donations", href: "/donations" });
    expect(navLinksFor("CLAIMANT").some(link => link.href === "/donations")).toBe(false);
    expect(navLinksFor(undefined)).toEqual([]);
  });
});

// ---- GT-29 and GT-30 for this package: source text only ----
const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*(\/\/|\*|\/\*).*$/, "")).join("\n");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => { const path = join(root, entry.name); return entry.isDirectory() ? walk(path) : [path]; });
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|ai|donation\/orders|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const LOADER = "src/donation/donations-grid.ts";
const PAGE_DIR = join("src", "app", "donations");
const PAGE_FILES = walk(PAGE_DIR);
const GRID_FILES = [LOADER, ...PAGE_FILES];
function closure(entries: string[]) {
  const seen = new Set<string>(); const queue = [...entries]; const edges: string[] = [];
  while (queue.length) {
    const file = queue.pop()!; if (seen.has(file)) continue; seen.add(file);
    for (const target of imports(source(file))) {
      if (!target.startsWith(".")) { edges.push(`${file} -> ${target}`); continue; }
      const resolved = join(file, "..", target).replace(/\\/g, "/");
      edges.push(`${file} -> ${resolved}`);
      const path = [`${resolved}.ts`, `${resolved}.tsx`, join(resolved, "index.ts"), join(resolved, "index.tsx")].find(candidate => { try { return statSync(candidate).isFile(); } catch { return false; } });
      if (path) queue.push(path);
    }
  }
  return { files: [...seen].sort(), edges };
}

describe("GT-29 static: the donations grid never reads the gift link table and never writes", () => {
  it("covers the loader, the page, the client, the columns and the stylesheet", () => {
    expect(PAGE_FILES).toEqual(expect.arrayContaining([join(PAGE_DIR, "page.tsx"), join(PAGE_DIR, "client.tsx"), join(PAGE_DIR, "columns.ts"), join(PAGE_DIR, "donations.css")]));
  });
  it("names neither gift_links nor giftLinks in the loader, the page or any of their files, comments included", () => {
    for (const path of GRID_FILES) expect(source(path), path).not.toMatch(/gift_links|giftLinks|gift-link|GIFT_LINK|giftLink/);
  });
  it("has no insert, update or delete call in trail.ts or the loader, and no such word in the loader, the page or the columns", () => {
    for (const path of ["src/donation/trail.ts", LOADER]) expect(code(path), path).not.toMatch(/\.(insert|update|delete|truncate)\s*\(/);
    for (const path of GRID_FILES.filter(file => /\.(ts|tsx)$/.test(file))) {
      const text = source(path);
      expect(text, `${path} has an insert, update or delete word`).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(withoutComments(text), `${path} calls a write method`).not.toMatch(/\.(insert|update|delete|truncate)\s*\(/);
      expect(withoutComments(text), `${path} runs write SQL`).not.toMatch(/\bexecute\(\s*sql`\s*(insert|update|delete|truncate|alter|drop|create)/i);
    }
  });
  it("starts the read transaction read only before any select, at repeatable read", () => {
    const text = source(LOADER);
    const readOnly = text.indexOf("set transaction read only"); const firstSelect = text.indexOf(".select(");
    expect(readOnly).toBeGreaterThan(0); expect(firstSelect).toBeGreaterThan(readOnly);
    expect(text).toMatch(/isolationLevel:\s*["']repeatable read["']/);
    expect(text).toMatch(/role !== "APPROVER"/); expect(text).toMatch(/throw new DonationsAccessError\(403\)/);
  });
  it("never converts money to a floating point value", () => {
    for (const path of [LOADER, join(PAGE_DIR, "columns.ts")]) { const text = code(path); for (const banned of ["Number(", "parseFloat", "toFixed", "Math."]) expect(text.includes(banned), `${path} ${banned}`).toBe(false); }
  });
  it("exposes no API route and no server action for the grid", () => {
    for (const path of walk(join("src", "app", "api"))) expect(source(path), path).not.toMatch(/donations-grid|loadDonationsGrid/);
    for (const path of GRID_FILES.filter(file => /\.(ts|tsx)$/.test(file))) expect(source(path), path).not.toMatch(/['"]use server['"]/);
    for (const path of PAGE_FILES.filter(file => /\.tsx$/.test(file))) expect(code(path), path).not.toMatch(/<form\b|\bfetch\(|XMLHttpRequest|method=|action=/);
  });
  it("is the only importer of the loader besides the page and the tests", () => {
    const importers = walk("src").filter(path => path !== LOADER && /\.(ts|tsx)$/.test(path) && /donations-grid/.test(source(path))).sort();
    expect(importers).toEqual([join(PAGE_DIR, "client.tsx"), join(PAGE_DIR, "columns.ts"), join(PAGE_DIR, "page.tsx")].sort());
  });
});

describe("GT-30 for this package: no reach into the ledger writers, the PayPal adapter or the order code", () => {
  it("has no direct import of a banned module in the loader, the page, the client or the columns", () => {
    for (const file of GRID_FILES.filter(path => /\.(ts|tsx)$/.test(path))) for (const target of imports(source(file))) expect(`${file} -> ${target}`, `${file} -> ${target}`).not.toMatch(BANNED);
  });
  it("closes over no banned module from the loader (the page and columns close over the shared shell, so only their direct imports are checked)", () => {
    const { files, edges } = closure([LOADER]);
    for (const edge of edges) expect(edge, edge).not.toMatch(BANNED);
    for (const file of files) expect(file, file).not.toMatch(BANNED);
    expect(files).toContain("src/donation/trail.ts");
  });
  it("the loader reads facts through trail.ts and calls no network, key or console", () => {
    expect(code(LOADER)).toMatch(/loadGiftTrailFacts\(/); expect(code(LOADER)).toMatch(/buildGiftTrail\(/);
    for (const file of GRID_FILES.filter(path => /\.(ts|tsx)$/.test(path))) expect(code(file), file).not.toMatch(/fetch\(|XMLHttpRequest|process\.env|ANTHROPIC_|PAYPAL_|console\./);
  });
  it("leaves the order code untouched by this feature", () => {
    expect(source("src/donation/orders.ts")).not.toMatch(/donations-grid|loadDonationsGrid/);
  });
});

describe("the page keeps its promises in words", () => {
  it("shows the access refusal, the observed time, the read-only line and no forbidden word", () => {
    const page = source(join(PAGE_DIR, "page.tsx"));
    expect(page).toContain("Approver access required.");
    expect(page).toContain("redirect('/login')");
    expect(page).toContain("View observed");
    expect(page).toMatch(/This page makes no payment, approval or donor link request\./);
    expect(page).toContain("AG Grid Community (MIT)");
    for (const path of PAGE_FILES.filter(file => /\.(tsx|ts)$/.test(file))) expect(source(path), path).not.toMatch(/\b(claude|sandbox|fictional)\b/i);
  });
  it("closes every stylesheet comment and keeps its rules", () => {
    const text = source(join(PAGE_DIR, "donations.css"));
    expect(text.split("/*").length).toBe(text.split("*/").length);
    const rules = text.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toContain("/*");
    for (const selector of [".donations-totals", ".donations-totals dt", ".donations-totals dd", ".donations-cap"]) expect(rules, selector).toContain(selector);
  });
});
