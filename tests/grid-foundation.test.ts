import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ALLOWED_MODULE_NAMES, BASE_MODULES, BASE_MODULE_NAMES, CORE_INCLUDED_MODULE_NAMES, assertAllowedModules, gridModules } from "../src/app/grid/modules";
import { GRID_ALIASES, buildGridTheme } from "../src/app/grid/theme";
import { InvalidCentsError, compareCents, decimalCents, formatCents, parseCentsInput, sumCents, toCents } from "../src/app/grid/money";
import { csvCell, csvExportParams, csvFileName, escapeCsvText } from "../src/app/grid/csv";
import { centsColumn, dateColumn, dateOnlyComparator, statusColumn, textColumn } from "../src/app/grid/columns";
import { COLUMN_FILTER_DEBOUNCE_MS, SEARCH_DELAY_MS } from "../src/app/grid/timing";
import { GRID_STATE_MAX_CHARACTERS, GRID_STATE_VERSION, clearGridState, gridStateKey, loadGridState, saveGridState } from "../src/app/grid/state";
import { statusInfo } from "../src/app/grid/status";
import { formatUsd } from "../src/donation/note";

// IAC-380 step 2, the shared grid foundation (docs/plans/GRID_SURFACES_SCOPE.md sections 2 and 5). GS-01 to GS-12 run here as unit and static
// tests with no database and no browser. GS-13 to GS-17 run in e2e/ledger.spec.ts. The e2e suite also reads the real computed theme values,
// because GS-03 and GS-04 model the browser's var() fallback chain in code and do not run a browser.

const walk = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name); return entry.isDirectory() ? walk(path) : [path];
});
const sourceFiles = walk("src").filter(path => /\.[cm]?[jt]sx?$|\.css$/.test(path));
const read = (path: string) => readFileSync(path, "utf8");
// Code with comments removed. Regex literals and strings stay, so the static checks below name what they accept.
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

describe("GS-01 named Community modules only", () => {
  const gridFiles = [...walk(join("src", "app", "grid")), ...readdirSync(join("src", "app"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join("src", "app", entry.name, "grid.tsx")).filter(path => { try { readFileSync(path); return true; } catch { return false; } })];
  const importsOf = (text: string) => [...text.matchAll(/import\s+(?:type\s+)?(?:([^'";]*?)\s+from\s+)?["']([^"']+)["']/g)].map(match => ({ names: match[1] ?? "", from: match[2]! }));

  it("every import of an AG package names ag-grid-community or ag-grid-react, and no module name is outside the allowed list", () => {
    expect(gridFiles.filter(path => /\.tsx?$/.test(path)).length).toBeGreaterThanOrEqual(9);
    for (const path of sourceFiles) {
      const text = read(path);
      for (const specifier of [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](ag-[^"']*)["']/g)].map(match => match[1]!)) {
        expect(["ag-grid-community", "ag-grid-react"], `${path} imports ${specifier}`).toContain(specifier);
      }
    }
    const named = new Set<string>();
    for (const path of gridFiles.filter(file => /\.tsx?$/.test(file))) for (const found of importsOf(read(path))) {
      if (found.from !== "ag-grid-community") continue;
      for (const name of found.names.replace(/[{}]/g, "").split(",").map(part => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean)) if (name !== "Module" && /Module$/.test(name)) named.add(name);
    }
    expect([...named]).not.toContain("AllCommunityModule");
    expect(named.size).toBeGreaterThan(10);
    for (const name of named) expect(ALLOWED_MODULE_NAMES, `${name} is not on the allowed list`).toContain(name.replace(/^_/, "").replace(/Module$/, ""));
    for (const path of sourceFiles) expect(read(path), path).not.toMatch(/AllCommunityModule|AllEnterpriseModule|ag-grid-enterprise/);
  });

  it("BASE_MODULES is the scope list: 16 public modules plus ColumnGroup and KeyboardNavigation that the grid core registers", () => {
    const registered = BASE_MODULES.map(module => (module as { moduleName?: string }).moduleName);
    expect(registered.every(Boolean)).toBe(true);
    expect([...registered, ...CORE_INCLUDED_MODULE_NAMES].sort()).toEqual([...BASE_MODULE_NAMES].sort());
    expect(BASE_MODULE_NAMES).toHaveLength(18);
    expect(BASE_MODULE_NAMES).toEqual(expect.arrayContaining(["ClientSideRowModel", "TextFilter", "BigIntFilter", "DateFilter", "QuickFilter", "CsvExport", "PinnedRow", "Tooltip", "ColumnGroup", "ColumnAutoSize", "CellStyle", "RowStyle", "KeyboardNavigation", "GridState", "RenderApi", "ScrollApi", "RowApi", "CellApi"]));
    for (const name of registered) expect(ALLOWED_MODULE_NAMES).toContain(name);
  });

  it("an Enterprise-style module is refused, and the allowed list names no Enterprise module", () => {
    expect(() => assertAllowedModules([{ moduleName: "SetFilter" } as never])).toThrow(/allowed list/);
    expect(() => assertAllowedModules([{ moduleName: "RowGrouping" } as never])).toThrow(/allowed list/);
    expect(() => assertAllowedModules([{} as never])).toThrow(/unnamed/);
    for (const banned of ["RowGrouping", "Pivot", "MasterDetail", "TreeData", "IntegratedCharts", "Sparklines", "StatusBar", "SideBar", "SetFilter", "MultiFilter", "ExcelExport", "Clipboard", "CellSelection", "RangeSelection", "RichSelect", "ContextMenu", "ColumnMenu", "ServerSideRowModel"]) expect(ALLOWED_MODULE_NAMES).not.toContain(banned);
    expect(gridModules().length).toBeGreaterThanOrEqual(BASE_MODULES.length);
  });
});

describe("GS-02 the guard passes the real tree and fails on each banned specifier", () => {
  const guardUrl = pathToFileURL(resolve("scripts", "assert-studio-free.mjs")).href;
  const loadGuard = async () => (await import(/* @vite-ignore */ guardUrl)).assertStudioFree as (root: string, options?: Record<string, string>) => { result: string; variant: string; sourceFiles: number };

  it("passes the working tree for the community grid variant, source files included", async () => {
    const result = (await loadGuard())(resolve("."));
    expect(result.result).toBe("PASS");
    expect(result.variant).toBe("STUDIO_FREE_COMMUNITY_GRID");
    expect(result.sourceFiles).toBeGreaterThan(100);
  });

  // The temporary root copies the real release metadata and holds one source file. The clean file passes, so a failure below is the banned text.
  const tempRoot = (srcPath: string, text: string) => {
    const root = mkdtempSync(join(tmpdir(), "aidtrace-gs02-"));
    for (const file of ["release/variant.json", "package.json", "pnpm-lock.yaml", "DEPENDENCY_LICENSES.json"]) { mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(file, join(root, file)); }
    mkdirSync(dirname(join(root, "src", srcPath)), { recursive: true }); writeFileSync(join(root, "src", srcPath), text);
    return root;
  };
  const cases: [string, string, string][] = [
    ["ag-grid-enterprise", "enterprise.ts", `import { SetFilterModule } from "ag-grid-enterprise";\nexport const x = SetFilterModule;\n`],
    ["ag-charts-community", "charts.ts", `import { AgCharts } from "ag-charts-community";\nexport const x = AgCharts;\n`],
    ["ag-studio", "studio.ts", `import { start } from "ag-studio";\nexport const x = start;\n`],
    ["a CSS class containing ag-grid", "banned.css", `.ag-grid-wrap { display: block; }\n`],
    ["a CSS class prefixed onto the banned token", "prefixed.css", `.gx-ag-grid-fix { display: block; }\n`],
    ["a custom property containing ag-charts", "property.css", `.gx-root { --ag-charts-gap: 4px; }\n`],
    ["a comment naming ag-stack", "comment.ts", `// uses ag-stack internals\nexport const x = 1;\n`],
  ];
  it("a clean temporary root passes", async () => {
    const root = tempRoot("clean.ts", `import { themeQuartz } from "ag-grid-community";\nexport const x = themeQuartz;\n`);
    try { expect((await loadGuard())(root).result).toBe("PASS"); } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const [label, file, text] of cases) {
    it(`fails on ${label}`, async () => {
      const root = tempRoot(file, text);
      const guard = await loadGuard();
      try { expect(() => guard(root)).toThrow(/AG runtime reference remains/); }
      finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

// Models the browser's var() fallback chain. A real browser computes the same values: the e2e suite reads them from the page.
const rootBlocks = (css: string) => [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1]!);
const declarations = (blocks: string[]) => {
  const map = new Map<string, string>();
  for (const block of blocks) for (const part of block.split(";")) { const at = part.indexOf(":"); if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim()); }
  return map;
};
function evaluate(value: string, vars: Map<string, string>): string {
  const call = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(value.trim());
  if (!call) return value.trim();
  const found = vars.get(call[1]!);
  if (found !== undefined && found !== "") return evaluate(found, vars);
  return call[2] === undefined ? "" : evaluate(call[2], vars);
}
const aliasBlock = (() => { const css = read(join("src", "app", "grid", "grid.css")); return declarations([/\.gx-root\s*\{([^}]*)\}/.exec(css)![1]!]); })();
const resolverFor = (css: string, font: string) => {
  const vars = declarations(rootBlocks(css));
  for (const [name, value] of aliasBlock) vars.set(name, evaluate(value, vars));
  return (name: string) => (name === "font-family" ? font : vars.get(name));
};

describe("GS-03 the theme resolves against the current stylesheet", () => {
  const css = read(join("src", "app", "style.css"));
  it("style.css has two :root blocks and every alias resolves", () => {
    expect(rootBlocks(css)).toHaveLength(2);
    const resolve = resolverFor(css, "Inter, Arial, sans-serif");
    const { theme, missing } = buildGridTheme(resolve);
    expect(missing).toEqual([]);
    expect(theme).toBeTruthy();
    // Trust v2 (PR #74) replaced the teal palette; these are the Trust v2 column of docs/DESIGN_LANGUAGE.md section 2, the same as GS-04.
    expect(Object.fromEntries(GRID_ALIASES.map(name => [name, resolve(name)]))).toEqual({
      "--gx-ink": "#0b1f3a", "--gx-muted": "#5b6b80", "--gx-paper": "#ffffff", "--gx-soft": "#f4f6fa", "--gx-line": "#e6eaf0", "--gx-accent": "#0a66ff",
      "--gx-tint": "#f0f5ff", "--gx-hold": "#8a4b08", "--gx-stop": "#b42318", "--gx-ok": "#05603a",
    });
  });
  it("every alias in grid.css names a candidate or a literal fallback", () => {
    expect([...aliasBlock.keys()].sort()).toEqual([...GRID_ALIASES].sort());
    for (const [name, value] of aliasBlock) expect(value, name).toMatch(/#[0-9a-f]{3,8}\)*$/i);
  });
  it("a missing value is reported and left to the vendor default", () => {
    const { missing } = buildGridTheme(name => (name === "--gx-line" ? "" : "#123456"));
    expect(missing).toEqual(["--gx-line"]);
  });
});

describe("GS-04 the theme resolves against the Trust mock tokens", () => {
  const html = read(join("design", "fintech-mocks", "c2-trust.html"));
  const css = html.slice(html.indexOf("<style"), html.indexOf("</style>"));
  it("the mock :root block resolves every alias to the mock palette", () => {
    expect(rootBlocks(css).length).toBeGreaterThanOrEqual(1);
    const resolve = resolverFor(css, "Inter, Arial, sans-serif");
    expect(buildGridTheme(resolve).missing).toEqual([]);
    expect(Object.fromEntries(GRID_ALIASES.map(name => [name, resolve(name)]))).toEqual({
      "--gx-ink": "#0b1f3a", "--gx-muted": "#5b6b80", "--gx-paper": "#ffffff", "--gx-soft": "#f4f6fa", "--gx-line": "#e6eaf0", "--gx-accent": "#0a66ff",
      "--gx-tint": "#f0f5ff", "--gx-hold": "#8a4b08", "--gx-stop": "#b42318", "--gx-ok": "#05603a",
    });
  });
});

describe("GS-05 the gx prefix and no vendor token under src", () => {
  it("every class and custom property declared in grid.css starts with gx-", () => {
    const css = read(join("src", "app", "grid", "grid.css")).replace(/\/\*[\s\S]*?\*\//g, "");
    const preludes = [...css.matchAll(/([^{}]+)\{/g)].map(match => match[1]!);
    const classes = preludes.flatMap(prelude => [...prelude.matchAll(/\.([A-Za-z_][\w-]*)/g)].map(match => match[1]!));
    expect(classes.length).toBeGreaterThan(15);
    for (const name of classes) expect(name, `class ${name}`).toMatch(/^gx-/);
    const properties = [...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]!);
    expect(properties.length).toBeGreaterThanOrEqual(10);
    for (const name of properties) expect(name, `custom property ${name}`).toMatch(/^--gx-/);
  });
  it("no identifier, comment or string under src holds ag-grid, ag-charts, ag-stack or ag-studio beyond the two import specifiers", () => {
    expect(sourceFiles.length).toBeGreaterThan(100);
    for (const path of sourceFiles) {
      const stripped = read(path).replace(/(["'])ag-grid-(?:community|react)\1/g, "");
      expect(stripped, path).not.toMatch(/ag-(?:grid|charts|stack|studio)/i);
    }
  });
  it("the statuses read in words, and an unknown key reads as UNKNOWN, never as paid", () => {
    expect(statusInfo("UNKNOWN").label).toBe("UNKNOWN");
    expect(statusInfo("NEEDS_ATTENTION").label).toBe("NEEDS_ATTENTION");
    expect(statusInfo("something-new").label).toBe("UNKNOWN");
    expect(statusInfo(null).label).toBe("UNKNOWN");
    expect(statusInfo("PAID").dot).toBe("gx-dot-ok");
  });
});

describe("GS-06 compareCents", () => {
  const sign = (n: number) => Math.sign(n);
  it("orders exactly, including past 2^53 and thirty-digit strings", () => {
    const table: [string, string, number][] = [
      ["5", "5", 0], ["4", "5", -1], ["5", "4", 1], ["-5", "3", -1], ["0", "-0", 0], ["-1", "-2", 1],
      ["9007199254740992", "9007199254740993", -1], ["9007199254740993", "9007199254740992", 1], ["9007199254740993", "9007199254740993", 0],
      ["900719925474099300000000000000", "900719925474099300000000000001", -1], ["123456789012345678901234567890", "123456789012345678901234567890", 0],
    ];
    for (const [a, b, expected] of table) expect(sign(compareCents(a, b)), `${a} vs ${b}`).toBe(expected);
    expect(compareCents(5n, "5")).toBe(0);
  });
  it("blank values sort last ascending and descending", () => {
    for (const blank of [null, undefined, ""]) {
      expect(compareCents(blank, "5", undefined, undefined, false)).toBeGreaterThan(0);
      expect(compareCents("5", blank, undefined, undefined, false)).toBeLessThan(0);
      // The grid negates a descending comparison, so the blank still lands last.
      expect(-compareCents(blank, "5", undefined, undefined, true)).toBeGreaterThan(0);
      expect(-compareCents("5", blank, undefined, undefined, true)).toBeLessThan(0);
    }
    expect(compareCents(null, "", undefined, undefined, false)).toBe(0);
  });
  it("a non-canonical string throws", () => {
    for (const bad of ["007", "1.5", "1e3", "+5", " 5", "5 ", "abc", "--5", "-", "0x10"]) expect(() => compareCents(bad, "1"), bad).toThrow(InvalidCentsError);
    expect(() => toCents("007")).toThrow(InvalidCentsError);
  });
});

describe("GS-07 parseCentsInput", () => {
  it("reads typed dollars to exact cents", () => {
    const table: [string, bigint][] = [["25", 2500n], ["25.5", 2550n], ["25.50", 2550n], ["$1,234.56", 123456n], [".5", 50n], [" 12 ", 1200n], ["0", 0n], ["$0.07", 7n], ["1,000", 100000n]];
    for (const [text, cents] of table) expect(parseCentsInput(text), text).toBe(cents);
  });
  it("refuses everything else with null", () => {
    for (const text of ["25.555", "1e3", "-5", "abc", "", "1.", "   ", ".", "$", "1,23", "12,34,567", "1.2.3", "0x10", "5 0"]) expect(parseCentsInput(text), JSON.stringify(text)).toBeNull();
  });
  it("a 40-digit input is exact", () => {
    const digits = "1234567890123456789012345678901234567890";
    expect(parseCentsInput(digits)).toBe(BigInt(`${digits}00`));
    expect(parseCentsInput(`${digits}.99`)).toBe(BigInt(`${digits}99`));
  });
});

describe("GS-08 formatCents", () => {
  it("equals formatUsd for twenty values, as a string and as a bigint", () => {
    const values = [0n, 5n, 99n, 100n, 101n, 999n, 1000n, 12345n, 99999n, 100000n, 123456n, 100000000n, 999999999n, 1234567890n, 9007199254740991n, 9007199254740992n, 9007199254740993n, 9007199254740994n, 123456789012345678901234567890n, -250n];
    expect(values).toHaveLength(20);
    for (const value of values) { expect(formatCents(value.toString()), value.toString()).toBe(formatUsd(value)); expect(formatCents(value)).toBe(formatUsd(value)); }
    expect(formatCents(9007199254740993n)).toBe("$90,071,992,547,409.93");
    expect(formatCents(null)).toBe(""); expect(formatCents("")).toBe("");
  });
  it("decimalCents writes plain decimals past 2^53", () => {
    expect(decimalCents("9007199254740993")).toBe("90071992547409.93"); expect(decimalCents("5")).toBe("0.05"); expect(decimalCents("-1234")).toBe("-12.34"); expect(decimalCents(null)).toBe("");
  });
  it("money.ts holds no Number, parseFloat, parseInt, unary plus or toFixed", () => {
    const code = withoutComments(read(join("src", "app", "grid", "money.ts")));
    expect(code).not.toMatch(/\bNumber\s*\(/); expect(code).not.toMatch(/\bparseFloat\b/); expect(code).not.toMatch(/\bparseInt\b/); expect(code).not.toMatch(/\.toFixed\b/);
    expect(code).not.toMatch(/[=(,:?&|!]\s*\+\s*[A-Za-z_$(]/); expect(code).not.toMatch(/^\s*\+[A-Za-z_$(]/m); expect(code).not.toMatch(/\breturn\s+\+/);
    expect(code).not.toMatch(/\bMath\./);
  });
});

describe("GS-09 sumCents", () => {
  it("sums 10,000 values near 2^53 exactly", () => {
    const base = 9007199254740000n;
    const values = Array.from({ length: 10000 }, (_, index) => (base + BigInt(index * 7 + 3)).toString());
    let expected = 0n; for (const value of values) expected += BigInt(value);
    expect(sumCents(values)).toBe(expected);
    expect(expected > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
  it("an empty list and blanks give 0n", () => {
    expect(sumCents([])).toBe(0n); expect(sumCents([null, undefined, ""])).toBe(0n); expect(sumCents(["5", null, 7n])).toBe(12n);
  });
});

describe("GS-10 escapeCsvText and the export parameters", () => {
  it("prefixes a quote for a formula start, after any leading spaces", () => {
    for (const start of ["=", "+", "-", "@", "\t", "\r"]) { expect(escapeCsvText(`${start}SUM(A1)`)).toBe(`'${start}SUM(A1)`); expect(escapeCsvText(`  ${start}x`)).toBe(`'  ${start}x`); }
  });
  it("leaves plain text alone", () => {
    for (const plain of ["", "plain", "a=b", "x+y", "Claim 12", "5 - 3", "email@example.com", "$12.00"]) expect(escapeCsvText(plain), plain).toBe(plain);
  });
  it("a cents cell never gets a quote, a date cell is YYYY-MM-DD, other cells are escaped", () => {
    expect(csvCell("cents", "-1234", "-$12.34")).toBe("-12.34");
    expect(csvCell("cents", "9007199254740993", "$90,071,992,547,409.93")).toBe("90071992547409.93");
    expect(csvCell("cents", "", "")).toBe("");
    expect(csvCell("date", "2026-03-08T23:30:00.000Z", "Mar 8, 2026, 11:30 PM UTC")).toBe("2026-03-08");
    expect(csvCell("text", "=1+1", "=1+1")).toBe("'=1+1");
    expect(csvCell(undefined, "-x", "-x")).toBe("'-x");
  });
  it("the export is dated from the server observation, skips pinned rows and exports the filtered and sorted view", () => {
    expect(csvFileName("ledger", "2026-10-31T12:00:00.000Z")).toBe("aidtrace-ledger-2026-10-31.csv");
    const params = csvExportParams({ fileBase: "ledger", observedAt: "2026-10-31T12:00:00.000Z" });
    expect(params).toMatchObject({ fileName: "aidtrace-ledger-2026-10-31.csv", exportedRows: "filteredAndSorted", skipPinnedTop: true, skipPinnedBottom: true, onlySelected: false });
    expect(typeof params.processCellCallback).toBe("function");
  });
  it("csv.ts makes no network or clipboard call", () => {
    const code = withoutComments(read(join("src", "app", "grid", "csv.ts")));
    expect(code).not.toMatch(/\bfetch\b|navigator\.clipboard|XMLHttpRequest|sendBeacon|WebSocket/);
  });
});

describe("GS-11 dateOnlyComparator by calendar day in three zones", () => {
  const zones: [string, number][] = [["UTC", 0], ["America/Chicago", 360], ["Pacific/Kiritimati", -840]];
  const filterDay = (iso: string) => { const [y, m, d] = iso.split("-").map(part => Number.parseInt(part, 10)); return new Date(y!, m! - 1, d!); };
  // What a UTC-based comparison does with the same inputs, to show the zone really changed the local day.
  const naive = (filter: Date, cell: string) => (filter.toISOString().slice(0, 10) === cell.slice(0, 10) ? 0 : 1);
  const days = ["2026-03-08", "2026-11-01", "2026-12-31", "2026-06-15"];
  const previous = { "2026-03-08": "2026-03-07", "2026-11-01": "2026-10-31", "2026-12-31": "2026-12-30", "2026-06-15": "2026-06-14" } as Record<string, string>;
  const next = { "2026-03-08": "2026-03-09", "2026-11-01": "2026-11-02", "2026-12-31": "2027-01-01", "2026-06-15": "2026-06-16" } as Record<string, string>;
  const original = process.env.TZ;
  for (const [zone, januaryOffset] of zones) {
    it(`compares year, month and day only under ${zone}`, () => {
      process.env.TZ = zone;
      try {
        expect(new Date(2026, 0, 1).getTimezoneOffset(), "the zone took effect").toBe(januaryOffset);
        for (const day of days) {
          const filter = filterDay(day);
          expect(dateOnlyComparator(filter, day), `same day ${day}`).toBe(0);
          expect(dateOnlyComparator(filter, previous[day]!)).toBe(-1);
          expect(dateOnlyComparator(filter, next[day]!)).toBe(1);
          expect(dateOnlyComparator(filter, `${day}T23:59:59.999Z`), `timestamp on ${day}`).toBe(0);
          expect(dateOnlyComparator(filter, `${day}T00:00:00.000Z`)).toBe(0);
        }
        expect(dateOnlyComparator(filterDay("2026-03-08"), "")).toBe(-1); expect(dateOnlyComparator(filterDay("2026-03-08"), null)).toBe(-1); expect(dateOnlyComparator(filterDay("2026-03-08"), "March 8")).toBe(-1);
        if (zone === "Pacific/Kiritimati") expect(naive(filterDay("2026-03-08"), "2026-03-08"), "a UTC comparison would shift this day").not.toBe(0);
      } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
    });
  }
});

describe("GS-12 saved grid state", () => {
  const memory = () => { const data = new Map<string, string>(); return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } }; };
  it("round trips order, sizing, sort and filter, and nothing else", () => {
    const store = memory();
    const state = { columnOrder: { orderedColIds: ["a", "b"] }, columnSizing: { columnSizingModel: [{ colId: "a", width: 120 }] }, sort: { sortModel: [{ colId: "a", sort: "desc" }] }, filter: { filterModel: { a: { type: "equals", filter: "2500" } } }, rowData: [{ secret: "ROW-DATA-MARKER" }], focusedCell: { colId: "a", rowIndex: 3 }, rowSelection: ["x"] };
    expect(saveGridState("tara", "ledger", state, store)).toBe(true);
    const stored = store.getItem(gridStateKey("tara", "ledger"))!;
    expect(stored).not.toMatch(/ROW-DATA-MARKER|rowData|focusedCell|rowSelection/);
    expect(JSON.parse(stored).version).toBe(GRID_STATE_VERSION);
    expect(loadGridState("tara", "ledger", store)).toEqual({ columnOrder: state.columnOrder, columnSizing: state.columnSizing, sort: state.sort, filter: state.filter });
  });
  it("a missing key, bad JSON, a wrong version and an oversize value give null", () => {
    const store = memory(); const key = gridStateKey("tara", "ledger");
    expect(loadGridState("tara", "ledger", store)).toBeNull();
    store.setItem(key, "{not json"); expect(loadGridState("tara", "ledger", store)).toBeNull();
    store.setItem(key, JSON.stringify({ version: 2, state: { sort: {} } })); expect(loadGridState("tara", "ledger", store)).toBeNull();
    store.setItem(key, JSON.stringify({ state: { sort: {} } })); expect(loadGridState("tara", "ledger", store)).toBeNull();
    store.setItem(key, JSON.stringify({ version: 1, state: { sort: "x".repeat(GRID_STATE_MAX_CHARACTERS) } })); expect(loadGridState("tara", "ledger", store)).toBeNull();
    store.setItem(key, JSON.stringify({ version: 1, state: "text" })); expect(loadGridState("tara", "ledger", store)).toBeNull();
    expect(loadGridState("tara", "ledger", null)).toBeNull();
  });
  it("refuses to store an oversize value and keeps the earlier one", () => {
    const store = memory();
    expect(saveGridState("tara", "ledger", { sort: { a: 1 } }, store)).toBe(true);
    expect(saveGridState("tara", "ledger", { sort: "x".repeat(GRID_STATE_MAX_CHARACTERS) }, store)).toBe(false);
    expect(loadGridState("tara", "ledger", store)).toEqual({ sort: { a: 1 } });
  });
  it("keys carry the user id and the grid id, and reset clears only that key", () => {
    expect(gridStateKey("tara", "ledger")).toBe("aidtrace.grid.v1.tara.ledger");
    const store = memory();
    saveGridState("tara", "ledger", { sort: 1 }, store); saveGridState("ben", "ledger", { sort: 2 }, store); saveGridState("tara", "queue", { sort: 3 }, store);
    expect(loadGridState("ben", "ledger", store)).toEqual({ sort: 2 });
    clearGridState("tara", "ledger", store);
    expect(loadGridState("tara", "ledger", store)).toBeNull(); expect(loadGridState("ben", "ledger", store)).toEqual({ sort: 2 }); expect(loadGridState("tara", "queue", store)).toEqual({ sort: 3 });
  });
});

describe("GS-17 static: the grid foundation has no write path", () => {
  const specifiers = (text: string) => [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g)].map(match => match[1]!);
  it("no file under src/app/grid imports a ledger module, the PayPal adapter, the schema or the database and session modules", () => {
    const files = walk(join("src", "app", "grid")).filter(path => /\.tsx?$/.test(path));
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const path of files) {
      for (const specifier of specifiers(read(path))) {
        if (!specifier.startsWith(".")) continue;
        expect(/(?:^|\/)(?:ledger|paypal|db)(?:\/|$)|server\/(?:db|auth)$/.test(specifier), `${path} imports ${specifier}`).toBe(false);
      }
    }
  });
  it("the foundation exposes no editing prop and marks every column read-only", () => {
    const text = withoutComments(read(join("src", "app", "grid", "grid.tsx")));
    expect(text).toContain("editable: false");
    expect(text).not.toMatch(/\b(?:onCellValueChanged|onCellEditingStarted|singleClickEdit|stopEditingWhenCellsLoseFocus|cellEditor|readOnlyEdit)\b/);
    expect(text).not.toMatch(/\beditable:\s*(?:true|\()/);
  });
});

describe("LG-05b filter timing: a column filter edit always applies before a search change", () => {
  type Probe = { a: string; d: string; s: string; c: string };
  it("every filtering column builder applies at once and the search waits longer than that", () => {
    const built = [textColumn<Probe>({ field: "a", headerName: "A" }), dateColumn<Probe>({ field: "d", headerName: "D" }), statusColumn<Probe>({ field: "s", headerName: "S" }), centsColumn<Probe>({ field: "c", headerName: "C" })];
    for (const column of built) expect((column.filterParams as { debounceMs?: number }).debounceMs, String(column.field)).toBe(COLUMN_FILTER_DEBOUNCE_MS);
    expect(COLUMN_FILTER_DEBOUNCE_MS).toBe(0);
    expect(SEARCH_DELAY_MS).toBeGreaterThan(COLUMN_FILTER_DEBOUNCE_MS);
  });
  it("the grid takes its quick filter from the delayed value, and Reset view clears both", () => {
    const text = withoutComments(read(join("src", "app", "grid", "grid.tsx")));
    expect(text).toContain("quickFilterText={appliedSearch}");
    expect(text).not.toContain("quickFilterText={search}");
    expect(text).toMatch(/setTimeout\(\(\) => setAppliedSearch\(search\), SEARCH_DELAY_MS\)/);
    expect(text).toMatch(/resetView = \(\) => \{[^}]*setSearch\(''\); setAppliedSearch\(''\);/);
  });
});
