import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UNKNOWN_AGE, formatAge, type ApproverQueueRow } from "../src/server/approver-queue";
import { ProgressCell, ReviewCell, VendorCell } from "../src/app/approver-queue/cells";
import { QUEUE_PHONE_COLUMNS, queueColumns } from "../src/app/approver-queue/columns";
import { progressLabel, progressText, queueSteps } from "../src/app/approver-queue/progress";
import { TRACE_NAMES } from "../src/app/trace";
import { leafColumns } from "../src/app/grid/columns";
import { PhoneExtras } from "../src/app/grid/phone";
import { frameRows } from "../src/app/approver-queue/client";

// IAC-414 Q1, tests AQ-11 to AQ-20. Pure unit tests and source text checks: no database, no browser.
const sample = (over: Partial<ApproverQueueRow> = {}): ApproverQueueRow => ({
  id: "R-0a1b2c3d-0000-4000-8000-000000000001", claimant: "Maria Alvarez", vendor: "Cedar Science Shop", fund: "Tallow Creek Robot Kit Initiative, General Operating", amountCents: "30000",
  approvalCount: 1, approvals: "Approvals: 1 of 2", waitingSince: "2026-11-01T10:00:00.000Z", age: "2h", href: "/claims/R-0a1b2c3d-0000-4000-8000-000000000001", ...over,
});
const leaves = leafColumns(queueColumns());
const leaf = (field: string) => leaves.find(column => column.field === field)!;
type Fn = (params: unknown) => unknown;

describe("AQ-11 the column set", () => {
  it("is seven flat columns in the order the scope lists, with no group", () => {
    const columns = queueColumns();
    expect(columns.every(column => !("children" in column))).toBe(true);
    expect(leaves.map(column => column.headerName)).toEqual(["Claimant", "Vendor", "Status", "Amount", "Progress", "Age", "Review"]);
    expect(leaves.map(column => column.field)).toEqual(["claimant", "vendor", "approvals", "amountCents", "approvalCount", "waitingSince", "href"]);
  });
  it("filters text on the three text columns, BigInt on Amount, and offers no filter on the three display columns", () => {
    for (const field of ["claimant", "vendor", "approvals"]) expect(leaf(field).filter, field).toBe("agTextColumnFilter");
    expect(leaf("amountCents").filter).toBe("agBigIntColumnFilter");
    for (const field of ["approvalCount", "waitingSince", "href"]) { expect(leaf(field).filter, field).toBe(false); expect(leaf(field).floatingFilter, field).toBe(false); }
  });
  it("edits nothing: no column is editable and none selects", () => {
    for (const column of leaves) { expect(column.editable, String(column.field)).not.toBe(true); expect(column.checkboxSelection, String(column.field)).toBeFalsy(); expect(column.rowDrag, String(column.field)).toBeFalsy(); }
    expect(JSON.stringify(leaves.map(column => Object.keys(column).sort()))).not.toMatch(/editable|cellEditor|valueSetter|onCellValueChanged|checkbox|headerCheckbox/);
  });
  it("holds every phone field, keeps the Review link on a phone and leaves the other four for the details list", () => {
    const fields = leaves.map(column => column.field);
    for (const name of QUEUE_PHONE_COLUMNS) expect(fields).toContain(name);
    expect([...QUEUE_PHONE_COLUMNS]).toEqual(["vendor", "amountCents", "href"]);
    expect(fields.filter(field => !(QUEUE_PHONE_COLUMNS as readonly string[]).includes(field as string))).toEqual(["claimant", "approvals", "approvalCount", "waitingSince"]);
  });
  it("aligns Amount right, reads string cents as bigint and compares exactly past 2 to the 53rd", () => {
    const amount = leaf("amountCents");
    expect(amount.type).toBe("rightAligned"); expect(amount.cellClass).toEqual(expect.arrayContaining(["gx-cell-num", "ag-right-aligned-cell"]));
    expect((amount.valueGetter as Fn)({ data: sample({ amountCents: "9007199254740993" }) })).toBe(9007199254740993n);
    expect((amount.valueFormatter as Fn)({ value: 30000n })).toBe("$300.00");
    const compare = amount.comparator as (a: string, b: string) => number;
    expect(compare("9007199254740993", "9007199254740992")).toBeGreaterThan(0); expect(compare("9007199254740992", "9007199254740993")).toBeLessThan(0);
    expect(compare("2", "10")).toBeLessThan(0);
  });
  it("shows the approval count in the Status column as the words of the loader", () => {
    expect((leaf("approvals").valueGetter as Fn)({ data: sample() })).toBe("Approvals: 1 of 2");
  });
  it("sorts Age on the frozen time, shows the elapsed text and searches that text", () => {
    const age = leaf("waitingSince");
    expect((age.valueGetter as Fn)({ data: sample() })).toBe("2026-11-01T10:00:00.000Z");
    expect((age.valueGetter as Fn)({ data: sample({ waitingSince: "", age: UNKNOWN_AGE }) })).toBeNull();
    expect((age.valueFormatter as Fn)({ value: "2026-11-01T10:00:00.000Z", data: sample() })).toBe("2h");
    expect((age.valueFormatter as Fn)({ value: null, data: sample({ waitingSince: "", age: UNKNOWN_AGE }) })).toBe("Unknown");
    expect((age.getQuickFilterText as Fn)({ value: "x", data: sample() })).toBe("2h");
  });
  it("makes the quick filter search the fund under the vendor, and keeps the two display columns out of it", () => {
    expect((leaf("vendor").getQuickFilterText as Fn)({ value: "Cedar Science Shop", data: sample() })).toContain("Tallow Creek Robot Kit Initiative");
    for (const field of ["approvalCount", "href"]) expect((leaf(field).getQuickFilterText as Fn)({ value: 1, data: sample() })).toBe("");
    expect((leaf("vendor").tooltipValueGetter as Fn)({ data: sample(), node: {} })).toBe("Cedar Science Shop\nTallow Creek Robot Kit Initiative, General Operating");
    expect((leaf("vendor").tooltipValueGetter as Fn)({ data: sample(), node: { rowPinned: "bottom" } })).toBeUndefined();
  });
});

describe("AQ-12 the six-step mini trace reuses the Trust v2 trace", () => {
  it("is done four times, current at Approvals and not reached at PayPal payout, for none or one approval", () => {
    for (const count of [0, 1]) {
      const steps = queueSteps(count);
      expect(steps.map(step => step.name)).toEqual([...TRACE_NAMES]);
      expect(steps.map(step => step.state)).toEqual(["done", "done", "done", "done", "current", "future"]);
    }
  });
  it("reads Step 5 of 6, Approvals and says every step in words", () => {
    expect(progressText(queueSteps(1))).toBe("Step 5 of 6, Approvals");
    const label = progressLabel(queueSteps(1));
    expect(label).toBe("Step 5 of 6, Approvals. Receipt done, AI review done, Rule checks done, Fund split done, Approvals current, PayPal payout not reached.");
  });
  it("renders six dots with a state each, an image role and the words as its label", () => {
    const html = renderToStaticMarkup(createElement(ProgressCell, { data: sample() }));
    expect(html).toContain('role="img"'); expect(html).toContain("Step 5 of 6, Approvals. Receipt done");
    expect([...html.matchAll(/<i data-state="(\w+)">/g)].map(match => match[1])).toEqual(["done", "done", "done", "done", "current", "future"]);
  });
});

describe("AQ-13 the cells", () => {
  it("shows the vendor with its fund beneath it", () => {
    const html = renderToStaticMarkup(createElement(VendorCell, { data: sample() }));
    expect(html).toMatch(/<span class="aq-vendor-name">Cedar Science Shop<\/span><small>Tallow Creek Robot Kit Initiative, General Operating<\/small>/);
  });
  it("shows Review as a plain link to the claim, named by vendor and amount, and nothing that submits", () => {
    const html = renderToStaticMarkup(createElement(ReviewCell, { data: sample() }));
    expect(html).toContain('href="/claims/R-0a1b2c3d-0000-4000-8000-000000000001"'); expect(html).toContain('aria-label="Review Cedar Science Shop, $300.00"'); expect(html).toContain(">Review</a>");
    expect(html).not.toMatch(/<(form|button|input)\b|onclick|method=/i);
  });
  it("renders nothing for a row the grid has not loaded, such as a pinned row", () => {
    for (const cell of [VendorCell, ProgressCell, ReviewCell]) expect(renderToStaticMarkup(createElement(cell, {}))).toBe("");
  });
});

describe("AQ-14 the phone layout", () => {
  it("lists claimant, status, progress and age under each row, and leads each row with the vendor and the amount", () => {
    const html = renderToStaticMarkup(createElement(PhoneExtras<ApproverQueueRow>, { rows: [sample()], columns: queueColumns(), phoneColumns: QUEUE_PHONE_COLUMNS }));
    expect(html).toContain("<summary>Cedar Science Shop, Amount $300.00</summary>");
    for (const [name, value] of [["Claimant", "Maria Alvarez"], ["Status", "Approvals: 1 of 2"], ["Progress", "Step 5 of 6, Approvals"], ["Age", "2h"]]) expect(html, name).toContain(`<dt>${name}</dt><dd>${value}</dd>`);
    expect(html).not.toContain("<dt>Review</dt>"); expect(html).not.toContain("<dt>Vendor</dt>"); expect(html).not.toContain("<dt>Amount</dt>");
  });
});

describe("AQ-15 formatAge", () => {
  it("names the whole unit below the next one", () => {
    const cases: [number, string][] = [[0, "Just now"], [59_999, "Just now"], [60_000, "1m"], [3_599_999, "59m"], [3_600_000, "1h"], [86_399_999, "23h"], [86_400_000, "1d"], [2.5 * 86_400_000, "2d"], [400 * 86_400_000, "400d"]];
    for (const [ms, text] of cases) expect(formatAge(ms), String(ms)).toBe(text);
  });
  it("reads a time in the future or a value that is not a number as just now", () => {
    for (const ms of [-1, -86_400_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(formatAge(ms), String(ms)).toBe("Just now");
  });
});

// ---- source text only ----
const source = (path: string) => readFileSync(path, "utf8");
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => { const path = join(root, entry.name); return entry.isDirectory() ? walk(path) : [path]; });
const imports = (text: string) => [...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!)
  .concat([...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(match => match[1]!));
const BANNED = /(^|\/)(ledger\/(service|payout|retry|journal|donation|opening|reconcile|snapshot|webhooks)|paypal|ai|donation\/orders|server\/claim-actions|server\/payments|server\/webhook-[a-z]+)(\/|$)/;
const LOADER = "src/server/approver-queue.ts";
const DIR = join("src", "app", "approver-queue");
const DIR_FILES = walk(DIR);
const CODE_FILES = DIR_FILES.filter(file => /\.(ts|tsx)$/.test(file));
const ALL = [LOADER, ...DIR_FILES];
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

describe("AQ-16 static: the queue never writes", () => {
  it("covers the loader, the client, the columns, the cells, the progress helper and the stylesheet", () => {
    expect(DIR_FILES).toEqual(expect.arrayContaining([join(DIR, "client.tsx"), join(DIR, "columns.ts"), join(DIR, "cells.tsx"), join(DIR, "progress.ts"), join(DIR, "approver-queue.css")]));
  });
  it("has no insert, update or delete word or call in the loader or any grid file, and no write SQL", () => {
    for (const path of ALL.filter(file => /\.(ts|tsx)$/.test(file))) {
      const text = source(path);
      expect(text, `${path} has an insert, update or delete word`).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(withoutComments(text), `${path} calls a write method`).not.toMatch(/\.(insert|update|delete|truncate)\s*\(/);
      expect(withoutComments(text), `${path} runs write SQL`).not.toMatch(/\bexecute\(\s*sql`\s*(insert|update|delete|truncate|alter|drop|create)/i);
    }
  });
  it("starts the read transaction read only before any select, at repeatable read, and refuses anyone who is not an approver with a 403", () => {
    const text = source(LOADER);
    const readOnly = text.indexOf("set transaction read only"); const firstSelect = text.indexOf(".select(");
    expect(readOnly).toBeGreaterThan(0); expect(firstSelect).toBeGreaterThan(readOnly);
    expect(text).toMatch(/isolationLevel:\s*["']repeatable read["']/);
    expect(text).toMatch(/role !== "APPROVER"/); expect(text).toMatch(/throw new ApproverQueueAccessError\(403\)/);
  });
  it("scopes every table read to the approver's organization", () => {
    const text = withoutComments(source(LOADER));
    for (const table of ["s.claims", "s.allocationDecisions", "s.funds", "s.users"]) expect(text, table).toMatch(new RegExp(`eq\\(${table.replace(".", "\\.")}\\.organizationId, actor\\.organizationId\\)`));
  });
  it("never converts money to a floating point value", () => {
    for (const path of [LOADER, join(DIR, "columns.ts"), join(DIR, "cells.tsx"), join(DIR, "progress.ts")]) {
      const text = withoutComments(source(path));
      for (const banned of ["Number(", "parseFloat", "toFixed", "Math.round", "Math.trunc"]) expect(text.includes(banned), `${path} ${banned}`).toBe(false);
      for (const found of text.matchAll(/Math\.\w+/g)) expect(found[0], path).toBe("Math.floor");
    }
    expect(withoutComments(source(LOADER))).toMatch(/amountCents: \(totals\.get\(claimKey\(claim\.id, claim\.version\)\) \?\? 0n\)\.toString\(\)/);
  });
  it("exposes no API route and no server action for the queue", () => {
    for (const path of walk(join("src", "app", "api"))) expect(source(path), path).not.toMatch(/approver-queue|loadApproverQueue/);
    for (const path of ALL.filter(file => /\.(ts|tsx)$/.test(file))) expect(source(path), path).not.toMatch(/['"]use server['"]/);
    for (const path of DIR_FILES.filter(file => /\.tsx$/.test(file))) expect(withoutComments(source(path)), path).not.toMatch(/<form\b|<button\b|<input\b|\bfetch\(|XMLHttpRequest|method=|action=|onClick|onSubmit/);
  });
  it("is imported by the home page and the grid files only", () => {
    const importers = walk("src").filter(path => path !== LOADER && /\.(ts|tsx)$/.test(path) && /server\/approver-queue|\.\.\/approver-queue|\.\/approver-queue/.test(source(path))).sort();
    // IAC-405 PR A adds the two files of the Assisted queue that reuse the queue columns and the row type.
    expect(importers).toEqual([join(DIR, "cells.tsx"), join(DIR, "client.tsx"), join(DIR, "columns.ts"), join("src", "app", "page.tsx"), join("src", "app", "assisted-queue", "client.tsx"), join("src", "app", "assisted-queue", "columns.ts")].sort());
  });
});

describe("AQ-17 static: no reach into the ledger writers, the PayPal adapter, the payout code or the approval code", () => {
  it("has no direct import of a banned module in the loader or any grid file", () => {
    for (const file of CODE_FILES.concat(LOADER)) for (const target of imports(source(file))) expect(`${file} -> ${target}`).not.toMatch(BANNED);
  });
  it("closes over no banned module from the loader", () => {
    const { files, edges } = closure([LOADER]);
    for (const edge of edges) expect(edge, edge).not.toMatch(BANNED);
    for (const file of files) expect(file, file).not.toMatch(BANNED);
    expect(files).toContain("src/ledger/view.ts");
  });
  it("calls no network, key or console and imports the approval code nowhere", () => {
    for (const file of ALL.filter(path => /\.(ts|tsx)$/.test(path))) {
      expect(withoutComments(source(file)), file).not.toMatch(/fetch\(|XMLHttpRequest|process\.env|ANTHROPIC_|PAYPAL_|console\.|approveDecision|rejectClaim|freezeDecision/);
    }
  });
});

describe("AQ-18 static: Community grid only, read only, one foundation", () => {
  const client = source(join(DIR, "client.tsx"));
  it("mounts the shared grid through next/dynamic with no extra module, no selection, no export and no totals row", () => {
    expect(client).toMatch(/dynamic\(\(\) => import\('\.\.\/grid\/grid'\), \{ ssr: false/);
    for (const prop of ["extraModules", "selection=", "csv=", "totals=", "rowSelection", "editable", "Module"]) expect(withoutComments(client), prop).not.toContain(prop);
    expect(client).toContain('gridId="approver-queue"');
  });
  it("names no AG package in any grid file but the shared foundation's own files", () => {
    for (const file of ALL) expect(withoutComments(source(file)), file).not.toMatch(/["']ag-grid-(community|react)["']|AllCommunityModule|ag-grid-enterprise/);
  });
  it("shows the heading and the line that explains the missing claims", () => {
    expect(client).toContain("Awaiting your approval");
    expect(client).toContain("A claim you approved waits for the second approver and is not listed.");
    for (const file of CODE_FILES) expect(source(file), file).not.toMatch(/\b(claude|sandbox|fictional|qwen)\b/i);
  });
});

describe("AQ-19 static: the stylesheet", () => {
  const css = source(join(DIR, "approver-queue.css")); const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  it("closes every comment and keeps its rules", () => {
    expect(css.split("/*").length).toBe(css.split("*/").length); expect(rules).not.toContain("/*");
    for (const selector of [".aq-queue", ".aq-mini", ".aq-vendor", ".aq-review", ".aq-cell"]) expect(rules, selector).toContain(selector);
  });
  it("declares only aq- classes of its own and no hex color, no vendor class and no new custom property", () => {
    const own = new Set([...rules.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(match => match[1]!));
    const reused = new Set(["reference-screen", "home-grid", "home-main", "home-head-text", "funds", "gx-frame"]);
    for (const name of own) expect(name.startsWith("aq-") || reused.has(name), `class ${name}`).toBe(true);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/\.ag-|--ag-/);
    for (const found of rules.matchAll(/(--[\w-]+)\s*:/g)) expect(found[1], "custom property").toMatch(/^--aq-/);
    expect(rules).toContain("var(--aq-rows");
  });
  it("lays the queue out full width only above the 900 px phone and tablet break", () => {
    const media = /@media \(min-width: 901px\)\s*\{([\s\S]*)\}\s*$/.exec(rules);
    expect(media).not.toBeNull(); expect(media![1]).toContain(".aq-home"); expect(media![1]).toContain("grid-column: 1 / -1");
  });
});

describe("AQ-20 static: the home page", () => {
  const page = source(join("src", "app", "page.tsx"));
  const approver = page.slice(page.indexOf('if (user.role === "APPROVER")'), page.indexOf("const cards: ExpenseCardData[] = drafts.map"));
  it("builds the approver's awaiting list from the loader and renders the grid only when it has rows", () => {
    expect(approver).toContain("loadApproverQueue(db, user.id)");
    expect(approver).toContain("queue.rows.length > 0 && <ApproverQueueClient");
    expect(approver).toContain("approverHeading(queue.rows.length)");
  });
  it("no longer builds the approver's awaiting cards, so a claim shows once", () => {
    expect(approver).not.toMatch(/ExpenseCard|loadClaimView|frozenSplit|approverReviewLine|cards\b/);
    expect(approver).toContain("!queued.has(claim.id)");
  });
  it("leaves the claimant home on its cards", () => {
    const claimant = page.slice(page.indexOf("const cards: ExpenseCardData[] = drafts.map"));
    expect(claimant).toContain("<ExpenseCard"); expect(claimant).not.toMatch(/ApproverQueueClient|loadApproverQueue/);
  });
  it("keeps the empty-state heading and the lede for an empty queue", () => {
    expect(approver).toContain("approverHeading(0)"); expect(approver).toContain("approverLede(queue.rows.length, assisted !== undefined)");
  });
});

// Desktop polish, HP-08 and HP-09. The browser geometry is HP-01 to HP-03 and HP-10 in e2e/approver-queue.spec.ts.
describe("HP-08 the queue frame follows the row count", () => {
  const rules = source(join(DIR, "approver-queue.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  it("is one row for one claim, never fewer than one row and never more than twelve", () => {
    expect([0, 1, 2, 5, 12, 13, 400].map(frameRows)).toEqual([1, 1, 2, 5, 12, 12, 12]);
  });
  it("is sized from the row count plus the header, the filter row and 18 px, defaults to one row and keeps its maximum height", () => {
    expect(rules).toContain("height: calc(44px * (var(--aq-rows, 1) + 2) + 18px)");
    expect(rules).toContain("max-height: min(70vh, 640px)");
    expect(rules).not.toMatch(/--aq-rows, 2/);
  });
});

describe("HP-09 static: the approver home lays its head text, fund meters and queue out as full-width rows above the phone break", () => {
  const css = source(join(DIR, "approver-queue.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  const wide = /@media \(min-width: 901px\)\s*\{([\s\S]*)\}\s*$/.exec(css)![1]!;
  const line = (selector: string) => wide.split("\n").find(text => text.includes(selector))!;
  it("puts the head text in row 1 and the fund meters in row 2, both across the whole column", () => {
    expect(line(".home-head-text")).toMatch(/grid-column: 1 \/ -1; grid-row: 1;/);
    expect(line("> .funds {")).toMatch(/grid-column: 1 \/ -1; grid-row: 2;/);
    expect(line("aq-home { grid-template-columns")).toContain("grid-template-columns: minmax(0, 1fr)");
  });
  it("lays the meters in one auto-fit row of panels that read the Trust v2 tokens", () => {
    expect(line("> .funds {")).toContain("grid-template-columns: repeat(auto-fit, minmax(240px, 1fr))");
    const panel = line("> .funds > *");
    for (const token of ["var(--paper)", "var(--radius-panel)", "var(--shadow)"]) expect(panel, token).toContain(token);
  });
  it("drops the queue's own top margin, so the row gap is the only space between the meters and the queue", () => {
    expect(line(".aq-queue {")).toContain("margin-top: 0");
  });
  it("no longer keeps the fund rail in a second column beside the head text", () => {
    expect(wide).not.toMatch(/grid-column: 2/);
  });
  it("leaves the phone and tablet order to style.css: no max-width rule here, and style.css still orders funds, then the rest", () => {
    expect(css).not.toContain("max-width");
    const style = source(join("src", "app", "style.css"));
    expect(style).toContain(".home-grid > .funds { order: 1; }");
    expect(style).toContain(".home-grid .home-main > :not(.home-head-text) { order: 2; }");
  });
});
