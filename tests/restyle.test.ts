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
