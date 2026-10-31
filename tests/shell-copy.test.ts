import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_NOTE, FOOTER_PROMISE, PAYPAL_NOTE, PAYPAL_PAID_NOTE, STAGES, aiCard, claimStage, knownReviews, paypalCard, paypalParts, railLines, shellWording, suggestionKind, currentNote, type AiConfig, type AiInput, type PayPalInput } from "../src/app/shell-copy";
import { AiStatusCard, PayPalStatusCard, StageRail } from "../src/app/workspace";

// SHELL-01 to SHELL-10 (IAC-373 app shell adoption, docs/GATE_REPORT.md section 34). Pure functions and static file checks.
// No database, no network, no clock. The browser checks are e2e/shell.spec.ts (SHELL-11).
const claude: AiConfig = { name: "Claude Haiku 5.5", shellName: "Claude Haiku" };
const sonnet: AiConfig = { name: "Claude Sonnet 5.5", shellName: "Claude Sonnet 5.5" };
const attempt = (state: string, itemStatus: string | null = null, payoutBatchId: string | null = null) => ({ state, itemStatus, payoutBatchId });
const SAFE = "SYNTHETIC_BATCH_141";

describe("SHELL-01 stage mapping from claim status and confirmation", () => {
  const table: [string, boolean, number][] = [
    ["DRAFT", false, 2], ["AWAITING_APPROVAL", false, 2], ["DRAFT", true, 3], ["AWAITING_APPROVAL", true, 4], ["REJECTED", true, 4],
    ["APPROVED", true, 5], ["PAYOUT_PROCESSING", true, 5], ["PAID", true, 5], ["PAYOUT_ISSUE", true, 5],
  ];
  it.each(table)("%s confirmed=%s is stage %i", (status, confirmed, stage) => expect(claimStage(status, confirmed)).toBe(stage));
  it("names five stages in the locked order", () => expect([...STAGES]).toEqual(["Receipt", "AI review", "Funding", "Approvals", "PayPal"]));
  it("knows approvals only where the page loads them", () => {
    expect(knownReviews("DRAFT")).toBe(0); expect(knownReviews("AWAITING_APPROVAL")).toBeNull(); expect(knownReviews("REJECTED")).toBeNull();
    for (const status of ["APPROVED", "PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"]) expect(knownReviews(status)).toBe(2);
  });
  it("derives the suggestion kind the way the receipt page reads it", () => {
    expect(suggestionKind(undefined, false, false)).toBe("NONE");
    expect(suggestionKind("RUNNING", true, false)).toBe("RUNNING"); expect(suggestionKind("RUNNING", false, false)).toBe("UNUSABLE");
    expect(suggestionKind("READY", false, true)).toBe("READY"); expect(suggestionKind("READY", false, false)).toBe("UNUSABLE");
    expect(suggestionKind("FAILED", false, false)).toBe("UNUSABLE");
  });
});

describe("SHELL-02 AI card wording for every receipt review state", () => {
  const base: AiInput = { applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: claude };
  const table: [string, Partial<AiInput>, string, string, string | null][] = [
    ["preclassified example", { applicable: false }, "Not used. Preclassified example", "Not used", null],
    ["not run, claude configured", {}, "Not run yet", "Not run yet", "Configured model: Claude Haiku 5.5 (Claude API)"],
    ["not run, AI off", { configured: null }, "AI is off in this session. A person chooses each category", "AI off", null],
    ["running", { suggestion: "RUNNING" }, "Reading the typed receipt text", "Reading receipt text", "Configured model: Claude Haiku 5.5 (Claude API)"],
    ["suggestion ready, saved audit names the model", { suggestion: "READY", savedModel: "Claude Haiku 5.5" }, "Suggestion awaiting confirmation", "Suggested, awaiting you", "Model: Claude Haiku 5.5"],
    ["suggestion ready, saved by a retired model", { suggestion: "READY", savedModel: "Earlier AI model, since retired" }, "Suggestion awaiting confirmation", "Suggested, awaiting you", "Model: Earlier AI model, since retired"],
    ["unusable", { suggestion: "UNUSABLE" }, "No usable suggestion. A person chooses each category", "No usable suggestion", "Configured model: Claude Haiku 5.5 (Claude API)"],
    ["confirmed with an accepted suggestion", { confirmed: true, aiAccepted: true, suggestion: "READY", savedModel: "Claude Haiku 5.5" }, "Suggestion confirmed by a person", "Confirmed by a person", "Model: Claude Haiku 5.5"],
    ["confirmed by manual choice", { confirmed: true }, "Categories chosen by a person", "Person chose", null],
  ];
  it.each(table)("%s", (_name, patch, state, rail, model) => {
    const card = aiCard({ ...base, ...patch });
    expect(card.state).toBe(state); expect(card.rail).toBe(rail); expect(card.model).toBe(model); expect(card.note).toBe(AI_NOTE);
  });
  it("always carries the boundary note and never names a model the page did not load", () => {
    expect(AI_NOTE).toBe("No financial tools. It cannot approve, choose funds or pay.");
    expect(aiCard({ ...base, configured: null }).model).toBeNull();
    expect(aiCard({ ...base, suggestion: "READY", savedModel: null, configured: claude }).model).toBeNull();
  });
});

describe("SHELL-03 PayPal card wording for every claim and payout state", () => {
  const input = (claimStatus: string | null, approvals: number | null, payout: PayPalInput["payout"], amount = "$500.00"): PayPalInput => ({ claimStatus, approvals, payout, amount });
  const table: [string, PayPalInput, string, string, string][] = [
    ["no claim yet", input(null, 0, null), "not-ready", "Not ready: 0 of 2 approvals", "Not ready"],
    ["draft", input("DRAFT", 0, null), "not-ready", "Not ready: 0 of 2 approvals", "Not ready"],
    ["awaiting, approvals loaded", input("AWAITING_APPROVAL", 1, null), "not-ready", "Not ready: 1 of 2 approvals", "Not ready"],
    ["awaiting, approvals not loaded", input("AWAITING_APPROVAL", null, null), "see-claim", "See the claim for approvals and payment status", "See the claim"],
    ["rejected", input("REJECTED", 1, null), "rejected", "Rejected. Nothing will be sent", "Rejected"],
    ["approved, keyless, no attempt", input("APPROVED", 2, { attempt: null, keyless: true }), "ready-keyless", "Ready: $500.00. Unpaid in this keyless session, no request is made", "Ready, unpaid"],
    ["approved, payment configured, no attempt", input("APPROVED", 2, { attempt: null, keyless: false }), "ready", "Approved: $500.00. No payment has been sent yet", "Ready, not sent"],
    ["approved, payment facts not loaded", input("APPROVED", 2, null), "see-claim", "See the claim for payment status", "See the claim"],
    ["submitted attempt", input("PAYOUT_PROCESSING", 2, { attempt: attempt("SUBMITTED"), keyless: false }), "processing", "PayPal payout processing. Not yet verified as paid", "Processing"],
    ["pending attempt", input("PAYOUT_PROCESSING", 2, { attempt: attempt("PENDING"), keyless: false }), "processing", "PayPal payout processing. Not yet verified as paid", "Processing"],
    ["held attempt", input("PAYOUT_PROCESSING", 2, { attempt: attempt("HELD"), keyless: false }), "processing", "PayPal payout processing. Not yet verified as paid", "Processing"],
    ["unknown attempt state", input("PAYOUT_ISSUE", 2, { attempt: attempt("UNKNOWN"), keyless: false }), "verifying", "PayPal payout outcome being verified", "Verifying outcome"],
    ["payout past approval with no attempt row", input("PAYOUT_PROCESSING", 2, { attempt: null, keyless: false }), "verifying", "PayPal payout outcome being verified", "Verifying outcome"],
    ["failed attempt", input("PAYOUT_ISSUE", 2, { attempt: attempt("FAILED", null, "SYNTHETIC_DENIED_BATCH"), keyless: false }), "needs-attention", "Payout needs attention", "Needs attention"],
    ["manual review attempt", input("PAYOUT_ISSUE", 2, { attempt: attempt("MANUAL_REVIEW"), keyless: false }), "needs-attention", "Payout needs attention", "Needs attention"],
    ["funding rejected attempt", input("PAYOUT_ISSUE", 2, { attempt: attempt("FUNDING_REJECTED"), keyless: false }), "needs-attention", "Payout needs attention", "Needs attention"],
    ["settled, item SUCCESS, safe batch id", input("PAID", 2, { attempt: attempt("SETTLED", "SUCCESS", SAFE), keyless: false }), "paid", `Paid, verified by PayPal. Batch ${SAFE}`, "Paid, verified"],
  ];
  it.each(table)("%s", (_name, given, key, state, rail) => {
    const card = paypalCard(given);
    expect(card.key).toBe(key); expect(card.state).toBe(state); expect(card.rail).toBe(rail);
    expect(card.note).toBe(key === "paid" ? PAYPAL_PAID_NOTE : PAYPAL_NOTE);
    expect(card.batchId).toBe(key === "paid" ? SAFE : null);
  });
  it("keeps the boundary note wording", () => { expect(PAYPAL_NOTE).toBe("Approved does not mean paid."); });
  it("never prints a failed or denied batch id", () => {
    const card = paypalCard(input("PAYOUT_ISSUE", 2, { attempt: attempt("FAILED", "DENIED", "SYNTHETIC_DENIED_BATCH"), keyless: false }));
    expect(JSON.stringify(card)).not.toContain("SYNTHETIC_DENIED_BATCH");
  });
});

describe("SHELL-04 a card never says paid without a SETTLED attempt, item SUCCESS, a safe batch id and a PAID claim", () => {
  const statuses = [null, "DRAFT", "AWAITING_APPROVAL", "APPROVED", "PAYOUT_PROCESSING", "PAID", "REJECTED", "PAYOUT_ISSUE"];
  const states = ["SETTLED", "SUBMITTED", "PENDING", "HELD", "FAILED", "MANUAL_REVIEW", "FUNDING_REJECTED", "SOMETHING_NEW", "PENDING_SEND"];
  const items = [null, "SUCCESS", "PENDING", "FAILED", "DENIED", "UNCLAIMED"];
  const batches = [null, SAFE, "has space", "bad/char", "x".repeat(65), ""];
  // Lowercase "paid" may appear only inside these fixed negations.
  const negations = [/not yet verified as paid/gi, /does not mean paid/gi, /unpaid/gi];
  const claimsPaid = (text: string) => /\bPaid\b/.test(text) || negations.reduce((rest, pattern) => rest.replace(pattern, ""), text).toLowerCase().includes("paid");
  it("sweeps every claim status, attempt state, item status and batch id", () => {
    let paid = 0, total = 0;
    for (const claimStatus of statuses) for (const approvals of [0, 1, 2, null]) for (const keyless of [true, false]) {
      const payouts: PayPalInput["payout"][] = [null, { attempt: null, keyless }];
      for (const state of states) for (const itemStatus of items) for (const batch of batches) payouts.push({ attempt: attempt(state, itemStatus, batch), keyless });
      for (const payout of payouts) {
        const card = paypalCard({ claimStatus, approvals, payout, amount: "$6.00" }); total++;
        const verified = claimStatus === "PAID" && payout?.attempt?.state === "SETTLED" && payout.attempt.itemStatus === "SUCCESS" && payout.attempt.payoutBatchId !== null && /^[A-Za-z0-9_-]{1,64}$/.test(payout.attempt.payoutBatchId);
        if (verified) { paid++; expect(card.key).toBe("paid"); expect(claimsPaid(`${card.state} ${card.rail}`)).toBe(true); }
        else { expect(card.key).not.toBe("paid"); expect(card.batchId).toBeNull(); expect(claimsPaid(`${card.state} ${card.rail} ${card.note}`), JSON.stringify({ claimStatus, payout, card })).toBe(false); }
      }
    }
    expect(paid).toBeGreaterThan(0); expect(total).toBeGreaterThan(1000);
  });
  it("renders no Paid wording in the card markup for an approved, unpaid claim", () => {
    const html = renderToStaticMarkup(createElement(PayPalStatusCard, { card: paypalCard({ claimStatus: "APPROVED", approvals: 2, amount: "$500.00", payout: { attempt: null, keyless: true } }) }));
    expect(html).toContain("data-paypal-state=\"ready-keyless\""); expect(html).toContain("Approved does not mean paid."); expect(/\bPaid\b/.test(html)).toBe(false);
  });
  it("current step note stays cautious for every status", () => {
    expect(currentNote("APPROVED")).toBe("Approved does not mean paid"); expect(currentNote("PAYOUT_PROCESSING")).toContain("not yet verified as paid");
    expect(currentNote(null)).toBe("No payment has been submitted");
  });
});

const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });

describe("SHELL-05 the product name stays AidTrace", () => {
  it("has no Pledgeline string anywhere under src/", () => {
    const text = walk("src").filter(path => !/\.(woff2?|png|ico|jpg)$/.test(path));
    expect(text.length).toBeGreaterThan(20);
    expect(text.filter(path => /pledgeline/i.test(readFileSync(path, "utf8")))).toEqual([]);
  });
});

describe("SHELL-06 PayPal blue appears only in PayPal-scoped stylesheet rules", () => {
  const css = readFileSync("src/app/style.css", "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim(), body: match[2]! }));
  const blue = /#003087|#edf3fb|#c9d9ee|#bfd0ea|var\(--paypal(?:-bg|-line)?\)/i;
  it("parses the stylesheet", () => expect(rules.length).toBeGreaterThan(300));
  it("scopes every blue use to a selector that says paypal, apart from the token definitions", () => {
    const loose = rules.filter(rule => blue.test(rule.body) && rule.selector !== ":root" && !rule.selector.split(",").every(part => /paypal/i.test(part)));
    expect(loose.map(rule => rule.selector)).toEqual([]);
  });
  it("never puts blue on a button or an action link", () => {
    const actions = rules.filter(rule => blue.test(rule.body) && rule.selector.split(",").some(part => /(^|[\s>])button\b|button-link|journey-action|story-primary|\.secondary/.test(part)));
    expect(actions.map(rule => rule.selector)).toEqual([]);
  });
  it("defines the locked tokens", () => {
    for (const token of ["--ink:#142b3d", "--muted:#506579", "--line:#d6e1eb", "--soft:#f3f6fa", "--accent:#076d65", "--tint:#e9f5f2", "--warm:#fff3da", "--paypal:#003087", "--paypal-bg:#edf3fb", "--rail-current:#23495d", "--rail-border:#7296af", "--rail-text:#e8f0f6", "--rail-locked:#a3b8c9", "--rail-kicker:#b4c7d6", "--mark:#f9dba2", "--stop:#783329", "--stop-bg:#fff6f3", "--stop-line:#d4a29a"]) expect(css).toContain(token);
  });
  it("states the amendment 5 breakpoints and the three-column grid", () => {
    expect(css).toContain("grid-template-columns:180px minmax(0,1fr) 232px"); expect(css).toContain("@media(max-width:1100px)");
    expect(css).toMatch(/@media\(max-width:1100px\)[\s\S]*\.stage-rail \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}/);
  });
});

describe("SHELL-07 rail lines carry tags, live state and the Locked prefix", () => {
  const ai = aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: claude });
  const lines = (stage: 1 | 2 | 3 | 4 | 5, approvals: number | null = 0) => railLines({ stage, typedReceipt: true, ai, approvals, paypal: paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }) });
  it("tags only AI review and PayPal and states Rules, not AI for funding", () => {
    const rail = lines(2);
    expect(rail.map(line => line.tag)).toEqual([undefined, "AI", undefined, undefined, "PayPal"]);
    expect(rail[0]!.state).toBe("Typed text and amounts"); expect(rail[1]!.state).toBe("Suggested, awaiting you");
    expect(rail[2]!.state).toBe("Locked. Rules, not AI"); expect(rail[3]!.state).toBe("Locked. People: 0 of 2"); expect(rail[4]!.state).toBe("Locked. Not ready");
  });
  it("prefixes Locked. only on future stages", () => {
    for (const stage of [1, 2, 3, 4, 5] as const) lines(stage).forEach((line, index) => expect(line.state.startsWith("Locked. ")).toBe(index + 1 > stage));
  });
  it("shows the approvals the page loaded or sends the reader to the claim", () => {
    expect(lines(4, 1)[3]!.state).toBe("People: 1 of 2"); expect(lines(4, null)[3]!.state).toBe("People: see the claim");
  });
  it("renders one current step, check marks for done stages and read-only links only where the page supplies them", () => {
    const state = { ai, paypal: paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }), typedReceipt: true };
    const html = renderToStaticMarkup(createElement(StageRail, { stage: 3, state, reviews: 0, links: { 1: "/r", 2: "/r" } }));
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html.match(/<a class="stage-item"/g)).toHaveLength(2); expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).toContain("Locked. People: 0 of 2"); expect(html).toContain(">AI</span>"); expect(html).toContain(">PayPal</span>");
    expect(html.match(/<path d="M4.5 10.5/g)).toHaveLength(2);
  });
  it("renders the AI card in teal markup with its boundary note and no role=status", () => {
    const html = renderToStaticMarkup(createElement(AiStatusCard, { card: ai }));
    expect(html).toContain("status-card ai-card"); expect(html).toContain(AI_NOTE); expect(html).not.toContain("role="); expect(html).not.toContain("paypal");
  });
});

describe("SHELL-08 header tag and footer follow whether Claude is configured", () => {
  it("says what the brief asks for when a Claude key is configured", () => {
    expect(shellWording(claude)).toEqual({ tag: "Claude AI + PayPal sandbox", line: "Built with PayPal Payouts (sandbox) and Claude Haiku" });
    expect(shellWording(sonnet)).toEqual({ tag: "Claude AI + PayPal sandbox", line: "Built with PayPal Payouts (sandbox) and Claude Sonnet 5.5" });
    expect(FOOTER_PROMISE).toBe("AI suggests. People decide. PayPal pays.");
  });
  it("says AI is off, and why, when no key is configured, the limit is reached or AI is switched off", () => {
    expect(shellWording(null)).toEqual({ tag: "PayPal sandbox, AI off", line: "Built with PayPal Payouts (sandbox). AI suggestions are off: no Claude key is configured." });
    expect(shellWording(null, "NO_KEY")).toEqual(shellWording(null));
    expect(shellWording(null, "LIMIT").line).toContain("the Claude request limit for this process was reached");
    expect(shellWording(null, "SWITCHED_OFF").line).toContain("switched off");
    for (const off of ["NO_KEY", "LIMIT", "SWITCHED_OFF"] as const) { const wording = shellWording(null, off); expect(wording.tag).toBe("PayPal sandbox, AI off"); expect(wording.tag + wording.line).not.toMatch(/local|qwen|llama/i); }
    const on = shellWording(claude); expect(on.tag + on.line).not.toMatch(/local|qwen|llama/i);
  });
  it("splits the word PayPal for coloring and nothing else", () => {
    expect(paypalParts("Claude AI + PayPal sandbox")).toEqual([{ text: "Claude AI + ", paypal: false }, { text: "PayPal", paypal: true }, { text: " sandbox", paypal: false }]);
    expect(paypalParts("no mention")).toEqual([{ text: "no mention", paypal: false }]);
  });
});

describe("SHELL-09 every screen has the shell header and footer", () => {
  const pages = walk("src/app").filter(path => /\/page\.tsx$/.test(path));
  it("renders the footer once from the root layout", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8"); expect(layout).toContain("<AppFooter />");
    expect(readFileSync("src/app/app-footer.tsx", "utf8")).toContain("FOOTER_PROMISE");
  });
  it("gives every page the header, directly or through the workspace", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
    expect(pages.filter(path => { const text = readFileSync(path, "utf8"); return !/<AppHeader|<Workspace/.test(text); })).toEqual([]);
  });
  it("keeps the rail and summary on the claim workspace pages only", () => {
    const workspace = pages.filter(path => /<Workspace/.test(readFileSync(path, "utf8"))).sort();
    expect(workspace).toEqual(["src/app/claims/[claimId]/page.tsx", "src/app/claims/[claimId]/receipt/page.tsx", "src/app/receipts/new/page.tsx"]);
  });
});

describe("SHELL-10 computed contrast of the locked and shell colors is at least 4.5:1", () => {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
  const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const pairs: [string, string, string][] = [
    ["white on PayPal blue", "#ffffff", "#003087"], ["PayPal blue on PayPal tint", "#003087", "#edf3fb"], ["PayPal blue on white", "#003087", "#ffffff"], ["PayPal blue on soft", "#003087", "#f3f6fa"],
    ["ink on PayPal tint", "#142b3d", "#edf3fb"], ["muted on PayPal tint", "#506579", "#edf3fb"], ["muted on tint", "#506579", "#e9f5f2"], ["muted on soft", "#506579", "#f3f6fa"], ["muted on white", "#506579", "#ffffff"],
    ["accent on tint", "#076d65", "#e9f5f2"], ["accent on white", "#076d65", "#ffffff"], ["white on accent", "#ffffff", "#076d65"], ["ink on warm", "#142b3d", "#fff3da"],
    ["rail text on rail", "#e8f0f6", "#142b3d"], ["rail locked on rail", "#a3b8c9", "#142b3d"], ["rail kicker on rail", "#b4c7d6", "#142b3d"], ["white on rail current", "#ffffff", "#23495d"],
    ["rail text on rail current", "#e8f0f6", "#23495d"], ["stop on stop tint", "#783329", "#fff6f3"], ["ink on mark", "#142b3d", "#f9dba2"],
  ];
  it.each(pairs)("%s", (_name, fg, bg) => expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5));
});
