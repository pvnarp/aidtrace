import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { elapsedLabel } from "../src/app/ai-wait-time";
import { fundMeter, type SnapshotFund } from "../src/app/fund-meter";
import { GridSkeleton } from "../src/app/grid-skeleton";

// CL-01 to CL-06 (November 10 AI moments and books). Pure functions, static markup and static source checks. No database, no network, no browser.
const source = (path: string) => readFileSync(path, "utf8");

describe("CL-01 elapsedLabel", () => {
  it("reads whole seconds under a minute", () => {
    expect(elapsedLabel(0)).toBe("0 s"); expect(elapsedLabel(1)).toBe("1 s"); expect(elapsedLabel(12)).toBe("12 s"); expect(elapsedLabel(59)).toBe("59 s");
    expect(elapsedLabel(12.9)).toBe("12 s");
  });
  it("reads minutes and seconds from one minute on", () => {
    expect(elapsedLabel(60)).toBe("1 min 0 s"); expect(elapsedLabel(65)).toBe("1 min 5 s"); expect(elapsedLabel(125)).toBe("2 min 5 s");
  });
  it("reads a negative or non-finite value as 0 s", () => {
    for (const bad of [-3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(elapsedLabel(bad)).toBe("0 s");
  });
});

describe("CL-02 the fund bar shows the share still available", () => {
  const fund = (over: Partial<SnapshotFund> = {}): SnapshotFund => ({ name: "Fund", restriction: "RESTRICTED", bookCents: "100000", reservedCents: "25000", availableCents: "75000", ...over });
  it("is nearly full with little reserved and shrinks as more is reserved", () => {
    expect(fundMeter(fund({ reservedCents: "0", availableCents: "100000" })).availablePercent).toBe(100);
    expect(fundMeter(fund({ reservedCents: "100", availableCents: "99900" })).availablePercent).toBe(99);
    expect(fundMeter(fund()).availablePercent).toBe(75);
    expect(fundMeter(fund({ reservedCents: "90000", availableCents: "10000" })).availablePercent).toBe(10);
    expect(fundMeter(fund({ reservedCents: "100000", availableCents: "0" })).availablePercent).toBe(0);
  });
  it("rounds down with exact bigint division and clamps to 0 through 100", () => {
    expect(fundMeter(fund({ bookCents: "300", reservedCents: "100", availableCents: "200" })).availablePercent).toBe(66);
    expect(fundMeter(fund({ bookCents: "9007199254740993000", reservedCents: "4503599627370496500", availableCents: "4503599627370496500" })).availablePercent).toBe(50);
    expect(fundMeter(fund({ availableCents: "250000" })).availablePercent).toBe(100);
    expect(fundMeter(fund({ availableCents: "-5000" })).availablePercent).toBe(0);
    expect(fundMeter(fund({ bookCents: "0", availableCents: "5000" })).availablePercent).toBe(0);
    expect(fundMeter(fund({ bookCents: "-100", availableCents: "5000" })).availablePercent).toBe(0);
  });
  it("labels the bar for a screen reader with what it shows, and the reserved percent is still computed", () => {
    const meter = fundMeter(fund());
    expect(meter.ariaLabel).toBe("75 percent of book balance still available"); expect(meter.percent).toBe(25);
    expect(meter.ariaLabel).not.toMatch(/reserved/);
    expect(source("src/app/fund-row.tsx")).toContain("width: `${meter.availablePercent}%`");
  });
});

describe("CL-03 the grid skeleton", () => {
  const html = renderToStaticMarkup(createElement(GridSkeleton, { label: "Loading ledger table..." }));
  it("keeps the loading words as visually hidden status text and hides the bars from a screen reader", () => {
    expect(html).toContain('role="status"'); expect(html).toContain('<span class="vh">Loading ledger table...</span>');
    expect(html.match(/aria-hidden="true"/g)!.length).toBe(4); expect(html).toContain('<i class="sk-bar sk-caption" aria-hidden="true"></i>');
  });
  it("replaces the loading paragraph in the three grid pages", () => {
    for (const [file, words] of [["ledger", "ledger table"], ["donations", "donations table"], ["approver-queue", "approval queue"]] as const) {
      const client = source(`src/app/${file}/client.tsx`);
      expect(client, file).toContain(`<GridSkeleton label="Loading ${words}..." />`); expect(client, file).not.toContain(`<p role="status">Loading ${words}...</p>`);
    }
  });
  it("keeps the queue's row-count height variable and the grid's own frame height in the skeleton", () => {
    const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".sk-frame { height: min(70vh, 640px); min-height: 360px;"); expect(css).toContain(".aq-queue .sk-frame { height: calc(44px * (var(--aq-rows, 1) + 2) + 18px);");
  });
  it("reserves the AG Grid caption band: 41 px plus its 12 px margin, from the caption's own padding, font size and line height", () => {
    const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, ""), grid = source("src/app/grid/grid.css");
    expect(css).toContain(".sk-caption { height: 41px; margin: 0 0 12px;");
    expect(grid).toContain(".gx-caption { margin: 0 0 12px; padding: 10px 14px;"); expect(grid).toMatch(/\.gx-caption \{[^}]*font-size: 14px; line-height: 1\.5;/);
  });
});

describe("CL-04 the AI wait indicator", () => {
  it("is mounted only while the page's own request is pending, in the four AI waits, and the pending texts are unchanged", () => {
    const suggest = source("src/app/receipts/suggest-form.tsx"), proposal = source("src/app/receipts/proposal-review.tsx"), draft = source("src/app/rules-ui/draft-form.tsx"), dashboard = source("src/app/analytics/dashboard.tsx");
    expect(suggest).toContain("{pending && <><p role=\"status\">Checking your receipt. This may take up to a minute. You only need to submit once.</p><AiWait /></>}");
    expect(proposal).toContain("{pending && <AiWait />}"); expect(proposal).toContain("Preparing category suggestions, then checking funding rules. This can take about a minute. Submit once; manual review stays available after this request finishes.");
    expect(draft).toContain("Drafting can take a minute or more. When it finishes, you will see the draft to review.</p><AiWait /></>}");
    expect(dashboard).toContain("'Checking snapshot facts...'"); expect(dashboard).toContain("{busy && <AiWait />}");
  });
  it("names no stage and owns no request", () => {
    const wait = source("src/app/ai-wait.tsx"); expect(wait).not.toMatch(/fetch\(|setTimeout|AbortController/); expect(wait).toContain("elapsedLabel(seconds)");
  });
  it("starts the dot only inside the motion block and moves it with a transform", () => {
    const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, ""); const open = css.indexOf("@media (prefers-reduced-motion: no-preference) {"); const close = css.indexOf("@keyframes at-page-in");
    const inside = css.slice(open, close);
    expect(inside).toContain(".ai-wait-line i { animation: at-wait 1.1s ease-in-out infinite alternate; }"); expect(css.slice(0, open) + css.slice(close)).not.toMatch(/animation:\s*at-wait/);
    expect(css).toMatch(/@keyframes at-wait \{ to \{ transform: translateX\(48px\); \} \}/);
  });
});

describe("CL-05 the suggestion rows rise one by one", () => {
  it("staggers only rows that carry an AI suggestion, with the delay capped", () => {
    const proposal = source("src/app/receipts/proposal-review.tsx");
    expect(proposal).toContain('className={line.proposal && line.proposal.category !== "UNKNOWN" ? "ai-row" : undefined}'); expect(proposal).toContain('"--i": index');
    const css = source("src/app/style.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).toContain(".ai-row { animation: at-row-in .24s cubic-bezier(.2, .7, .2, 1) both; animation-delay: calc(min(var(--i, 0), 5) * 70ms); }");
    expect(proposal).toContain("<blockquote>{line.proposal.quote}</blockquote>"); // the quote stays beside its value
  });
});

describe("CL-06 the November 10 cuts", () => {
  it("leaves the footer line about PayPal cash on the analytics page and drops the repeats", () => {
    const dashboard = source("src/app/analytics/dashboard.tsx"), page = source("src/app/analytics/page.tsx");
    expect(page).toContain("This dashboard uses local journal facts and does not verify current PayPal available funds.");
    expect(dashboard).not.toMatch(/not PayPal available cash|No current PayPal balance was fetched/); expect(page).not.toContain("makes no payment, approval or balance request");
  });
  it("says components highlight, not live traffic, once on the architecture page", () => {
    const page = source("src/app/architecture/page.tsx"), explorer = source("src/app/architecture/explorer.tsx");
    expect(page).not.toContain("Components highlight"); expect(explorer).not.toMatch(/live traffic/); expect(page).toContain("This page is an illustration, not live telemetry.");
  });
  it("hides the drafts section of a fund with no drafts, and collapses the keyless request shape", () => {
    expect(source("src/app/funds/[fundId]/rules/page.tsx")).toContain("{view.drafts.length > 0 && <section");
    expect(source("src/app/give/keyless-panel.tsx")).toContain("<details><summary>Request shape the server would send</summary>");
    expect(source("src/app/give/page.tsx")).toContain("Back to your workspace");
  });
  it("drops the duplicate Next line and the Prepare with AI link from the receipt page", () => {
    expect(source("src/app/receipts/proposal-review.tsx")).not.toContain("Next: confirm the categories below.");
    expect(source("src/app/receipts/ai-recommendation.tsx")).not.toContain("Prepare with AI");
  });
});
