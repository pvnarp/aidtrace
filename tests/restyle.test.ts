import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// RS-01 (November 10 analytics restyle, docs/GATE_REPORT.md section 121). Static checks of source text. No database, no network, no browser. The RS-01 design language line and RS-02 (the hosted landing) are in the owner-only tests/restyle-owner.test.ts.
// RS-03 is the computed-style check in e2e/analytics.spec.ts.
const source = (path: string) => readFileSync(path, "utf8");
const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, "");

describe("RS-01 figures and the analytics page", () => {
  it("keeps tabular figures on :root and turns them off only for running text, with amounts named back on", () => {
    expect(css).toMatch(/:root \{[^}]*font-variant-numeric: tabular-nums;/);
    expect(css).toContain(":where(p, li, dt, label, summary, legend, blockquote, figcaption, h1, h2, h3, h4, h5, h6, th, a, button) { font-variant-numeric: normal; }");
    expect(css).toContain(":where(dd, td, strong, b, output, time, .amount, .big-amount, .case-amount, .meter) { font-variant-numeric: tabular-nums; }");
    expect(css.indexOf("font-variant-numeric: normal; }")).toBeLessThan(css.indexOf(".meter) { font-variant-numeric: tabular-nums; }"));
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

// EF-01 (November 11 eye-flow pass, docs/GATE_REPORT.md section 127): the viewer's one decision leads the Decision panel, the approver home
// has one filled way in, a Hold reads as a Hold, and the tint and accent fill are kept for the next decision and the primary button.
describe("EF-01 the eye-flow pass", () => {
  it("puts the lead forms first in the Decision panel and the payout first once approved", () => {
    const panel = source("src/app/workspace.tsx");
    const body = panel.slice(panel.indexOf('<h2 id="decision-title">Decision</h2>'));
    expect(body.indexOf('{lead && <div className="actions lead">{lead}</div>}')).toBeLessThan(body.indexOf("{split}"));
    expect(body.indexOf("{payoutFirst && payout}")).toBeLessThan(body.indexOf("{split}"));
    expect(body.indexOf("{!payoutFirst && payout}")).toBeGreaterThan(body.indexOf("{approvals}"));
    const page = source("src/app/claims/[claimId]/page.tsx");
    const lead = page.slice(page.indexOf("const leadForms = <>"), page.indexOf("const claimForms = <>"));
    expect(lead).toContain('action="freeze" button={decision ? "Confirm current allocation" : "Freeze allocation for approval"}');
    expect(lead.indexOf('data-testid="checks-status"')).toBeLessThan(lead.indexOf('action="approve"'));
    expect(page.slice(page.indexOf("const claimForms = <>"))).not.toContain('action="approve"');
    expect(page).toContain('payoutFirst={["APPROVED", "PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"].includes(claim.status)}');
  });
  it("adds one filled link on the approver home, marks holds and moves the give page's way out below the content", () => {
    expect(source("src/app/page.tsx")).toContain('<Link className="button-link" href={queue.rows[0]!.href} prefetch={false} data-testid="home-primary">Open {queue.rows[0]!.vendor}</Link>');
    const checks = source("src/app/claims/[claimId]/policy-checks.tsx");
    expect(checks).toContain("<li key={flag.sequence} data-severity={flag.severity}>"); expect(checks).toContain("<li key={line.lineId} data-verdict={line.verdict}>");
    const give = source("src/app/give/page.tsx");
    expect(give.indexOf('data-testid="give-back"')).toBeGreaterThan(give.indexOf("No real money moves."));
    expect(css).toContain(".dec .actions.lead { margin: 4px 0 16px; padding: 0; border-top: 0; }");
    expect(css).toContain(".ai-tag.confirmed { background: var(--bg); color: var(--navy); box-shadow: none; }");
    expect(css).toContain('.reasons li[data-severity="HOLD"], .reasons li[data-verdict="CONFLICT"] { background: var(--warm);');
  });
});
