import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// RS-01 and RS-02 (November 10 analytics and landing restyle, docs/GATE_REPORT.md section 121). Static checks of source text. No database, no network, no browser.
// RS-03 is the computed-style check in e2e/analytics.spec.ts.
const source = (path: string) => readFileSync(path, "utf8");
const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("RS-01 figures and the analytics page", () => {
  it("keeps tabular figures on :root and turns them off only for running text, with amounts named back on", () => {
    expect(css).toMatch(/:root \{[^}]*font-variant-numeric: tabular-nums;/);
    expect(css).toContain(":where(p, li, dt, label, summary, legend, blockquote, figcaption, h1, h2, h3, h4, h5, h6, th, a, button) { font-variant-numeric: normal; }");
    expect(css).toContain(":where(dd, td, strong, b, output, time, .amount, .big-amount, .case-amount, .meter) { font-variant-numeric: tabular-nums; }");
    expect(css.indexOf("font-variant-numeric: normal; }")).toBeLessThan(css.indexOf(".meter) { font-variant-numeric: tabular-nums; }"));
    expect(source("docs/DESIGN_LANGUAGE.md").replace(/\s+/g, " ")).toContain("running text (paragraphs, list items, labels, headings, links and buttons) uses normal figures");
  });
  it("aligns analytics amounts right, draws the home page bar on each fund and rules off the bridge total", () => {
    expect(css).toContain(".analytics-widget dd { text-align:right; font-variant-numeric:tabular-nums; }");
    expect(css).toContain(".analytics-cash .bridge-total { border-top:1px solid var(--line);");
    const dashboard = source("src/app/analytics/dashboard.tsx");
    // A regex, not the literal line: the export import guard (JX-08) reads a quoted relative specifier after "from" as an import of this file.
    expect(dashboard).toMatch(/^import \{ fundMeter \} from '\.\.\/fund-meter';$/m);
    expect(dashboard).toContain('<span className="meter analytics-meter" role="img" aria-label={meter.ariaLabel}><i style={{ width: `${meter.availablePercent}%` }} /></span>');
    expect(dashboard).toContain("</div><FundBar fund={fund}/><dl><dt>Book balance</dt>");
    expect(dashboard).toContain('<dt className="bridge-total">Book cash</dt><dd className="bridge-total">');
  });
});

describe("RS-02 the hosted landing page", () => {
  const gen = source("release/hosted/gen.sh");
  const page = gen.slice(gen.indexOf('l="$out/landing/index.html"'), gen.indexOf('} > "$l"'));
  it("uses the app's tokens and trace mark, with no script and no external resource", () => {
    for (const token of ["--navy:#0b1f3a", "--accent:#0a66ff", "--bg:#f4f6fa", "--paypal:#003087", "--radius-panel:14px"]) expect(page).toContain(token);
    const root = source("src/app/style.css");
    for (const token of ["--navy: #0b1f3a", "--accent: #0a66ff", "--bg: #f4f6fa", "--paypal: #003087", "--radius-panel: 14px"]) expect(root).toContain(token);
    expect(page).toContain('<path class="mark-line" d="M7.2 6h13.6"/><circle class="mark-start" cx="4" cy="6" r="3"/><circle class="mark-end" cx="24" cy="6" r="3"/>');
    expect(page).not.toMatch(/<script|https?:\/\/|<link |@import|url\(/);
  });
  it("shows the six trace steps in the login legend's words and three short lines, the first naming maria", () => {
    expect(page.match(/<li>[^<]*(<span class="pp">PayPal<\/span>)?[^<]*<small>/g)?.length).toBe(6);
    for (const words of ["Typed text and amounts", "Suggests categories with quotes", "Rules, not AI", "Computed from fund policy", "Two different people", "Separate decision"]) {
      expect(page).toContain(`<small>${words}</small>`); expect(source("src/app/trace.tsx")).toContain(`"${words}"`);
    }
    expect(page).toContain("<b>1. Pick a workspace</b>"); expect(page).toContain("<b>2. Start as maria</b>"); expect(page).toContain("<b>3. Follow the money</b>");
    expect(page).toContain("@media (prefers-reduced-motion:reduce){a.open{transition:none}a.open:hover{transform:none}}");
  });
});

// CP-01 (November 11 calm pass, docs/GATE_REPORT.md sections 123 and 125): one unbroken bridge rule, tight date hyphens, a single line for a
// funding comparison that matches, and the keyless give panel's unassigned PayPal IDs folded into its existing disclosure.
describe("CP-01 the calm pass", () => {
  it("draws the bridge rule across the column gap and keeps date ranges in normal figures", () => {
    expect(css).toContain(".analytics-cash dd.bridge-total { margin-left:-12px; padding-left:12px; }");
    expect(css).toMatch(/\.analytics-widget dl \{[^}]*gap: 6px 12px;/);
    expect(css).toContain(".plain-figures { font-variant-numeric: normal; }");
    expect(source("src/app/rules-ui/current-rules.tsx")).toContain('<dt>Grant period</dt><dd className="plain-figures">');
    expect(css).toContain(".gx-root .ag-cell, .gx-root .ag-header-cell-text, .gx-root .ag-floating-filter input { font-variant-numeric: normal; }");
    expect(css.indexOf(".gx-root .ag-cell.gx-cell-num { font-variant-numeric: tabular-nums; }")).toBeGreaterThan(css.indexOf(".gx-root .ag-cell, "));
    expect(css).toContain(".comparison-same { margin: 12px 0 16px; padding: 14px 16px; background: var(--tint);");
    expect(css).toContain(".comparison-same > details { margin: 0; }");
    expect(source("src/app/grid/money.ts")).toContain("cellClass: ['gx-cell-num', 'ag-right-aligned-cell']");
  });
  it("shows one line when the comparison matches and two cards only when they differ", () => {
    const page = source("src/app/claims/[claimId]/page.tsx");
    expect(page).toContain("view.feasible && baselineGeneral !== undefined && baselineGeneral === view.generalCents ? <div className=\"comparison-same\" data-testid=\"comparison-same\">");
    expect(page).toContain("Paying each line from the first fund that allows it gives the same split.");
    expect(page).toContain(': <div className="comparison-grid">');
  });
  it("keeps state, funds and amounts in view and puts the unassigned IDs inside the request-shape disclosure", () => {
    const panel = source("src/app/give/keyless-panel.tsx");
    const open = panel.indexOf("<details><summary>Request shape the server would send</summary>");
    expect(open).toBeGreaterThan(panel.indexOf("<dt>Amounts you could choose</dt>"));
    expect(panel.indexOf("<dt>PayPal order ID</dt>")).toBeGreaterThan(open); expect(panel.indexOf("<dt>Capture ID</dt>")).toBeGreaterThan(open);
  });
  it("says a shared claimant reason once, quiets the suggestion notice and ends the give panel on its disclosure", () => {
    const page = source("src/app/claims/[claimId]/page.tsx");
    expect(page).toContain("const sharedReason = view.lines.length > 1 && lineReasons.every(reason => reason && reason === lineReasons[0]) ? lineReasons[0] : undefined;");
    expect(page).toContain("{review.reason && !sharedReason && <p>Claimant's reason: {review.reason}</p>}");
    expect(page).toContain("<p className=\"shared-reason\" data-testid=\"shared-reason\">Claimant's reason for all {view.lines.length} lines: {sharedReason}</p>");
    expect(source("src/app/claims/[claimId]/receipt/page.tsx")).toContain('className={notice === "suggested" ? "notice notice-quiet" : "notice"}');
    expect(css).toContain(".notice.notice-quiet { padding: 0; border: 0; border-radius: 0; background: none; color: var(--muted); font-size: 14px; }");
    expect(css).toContain(".give-panel > details:last-child { margin-bottom: 0; }");
  });
});
