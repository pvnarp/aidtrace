import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_NOTE, FOOTER_PROMISE, PAYPAL_NOTE, PAYPAL_PAID_NOTE, STAGES, aiCard, claimStage, knownReviews, paypalCard, paypalParts, railLines, shellWording, suggestionKind, currentNote, type AiConfig, type AiInput, type PayPalInput } from "../src/app/shell-copy";
import { AiStatusCard, PayPalStatusCard } from "../src/app/workspace";
import { TraceStepper, traceSteps } from "../src/app/trace";

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
    ["not run, claude configured", {}, "Not run yet", "Not run yet", "Configured model: AI (Haiku 5.5)"],
    ["not run, no AI configured", { configured: null }, "A person chooses each category", "Person chooses", null],
    ["running", { suggestion: "RUNNING" }, "Reading the typed receipt text", "Reading receipt text", "Configured model: AI (Haiku 5.5)"],
    ["suggestion ready, saved audit names the model", { suggestion: "READY", savedModel: "Claude Haiku 5.5" }, "Suggestion awaiting confirmation", "Suggested, awaiting you", "Model: AI (Haiku 5.5)"],
    ["suggestion ready, saved by a retired model", { suggestion: "READY", savedModel: "Earlier AI model, since retired" }, "Suggestion awaiting confirmation", "Suggested, awaiting you", "Model: Earlier AI model, since retired"],
    ["unusable", { suggestion: "UNUSABLE" }, "No usable suggestion. A person chooses each category", "No usable suggestion", "Configured model: AI (Haiku 5.5)"],
    ["confirmed with an accepted suggestion", { confirmed: true, aiAccepted: true, suggestion: "READY", savedModel: "Claude Haiku 5.5" }, "Suggestion confirmed by a person", "Confirmed by a person", "Model: AI (Haiku 5.5)"],
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
    ["no claim yet", input(null, 0, null), "not-ready", "Not ready: needs two approvals", "Not ready"],
    ["draft", input("DRAFT", 0, null), "not-ready", "Not ready: needs two approvals", "Not ready"],
    ["awaiting, approvals loaded", input("AWAITING_APPROVAL", 1, null), "not-ready", "Not ready: needs two approvals", "Not ready"],
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
  // The old "defines the locked tokens" test became TV-01 (tests/trust-v2-tokens.test.ts), which compares :root with docs/DESIGN_LANGUAGE.md.
  it("states the 3fr and 2fr review grid and its single-column rule at 900 px and below", () => {
    const flat = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s*([:,{};])\s*/g, "$1").replace(/\s+/g, " ");
    const review = [...flat.matchAll(/\.hybrid-shell\.review\{([^{}]*)\}/g)].map(match => match[1]!);
    expect(review.some(body => body.includes("grid-template-columns:minmax(0,3fr) minmax(0,2fr)"))).toBe(true);
    const blocks = (query: string) => [...flat.matchAll(new RegExp(`@media ${query.replace(/[()]/g, "\\$&")}\\{`, "g"))].map(match => {
      let depth = 0;
      for (let i = match.index! + match[0].length - 1; i < flat.length; i++) { if (flat[i] === "{") depth++; if (flat[i] === "}" && --depth === 0) return flat.slice(match.index!, i); }
      return flat.slice(match.index!);
    });
    const narrow = blocks("(max-width:900px)"); expect(narrow.length).toBeGreaterThanOrEqual(1);
    expect(narrow.some(block => block.includes(".hybrid-shell.review{grid-template-columns:minmax(0,1fr);}"))).toBe(true);
  });
});

describe("SHELL-07 rail lines carry tags, live state and the Locked prefix", () => {
  const ai = aiCard({ applicable: true, suggestion: "READY", confirmed: false, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: claude });
  const lines = (stage: 1 | 2 | 3 | 4 | 5, approvals: number | null = 0) => railLines({ stage, typedReceipt: true, ai, approvals, paypal: paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }) });
  it("tags only AI review and PayPal and states Rules, not AI for funding", () => {
    const rail = lines(2);
    expect(rail.map(line => line.tag)).toEqual([undefined, "AI", undefined, undefined, "PayPal"]);
    expect(rail[0]!.state).toBe("Typed text and amounts"); expect(rail[1]!.state).toBe("Suggested, awaiting you");
    // IAC-415 PR 5: before the freeze no approval can exist, so the locked Approvals line says who, not how many (FT-01 below).
    expect(rail[2]!.state).toBe("Locked. Rules, not AI"); expect(rail[3]!.state).toBe("Locked. Two approvers"); expect(rail[4]!.state).toBe("Locked. Not ready");
  });
  it("prefixes Locked. only on future stages", () => {
    for (const stage of [1, 2, 3, 4, 5] as const) lines(stage).forEach((line, index) => expect(line.state.startsWith("Locked. ")).toBe(index + 1 > stage));
  });
  it("shows the approvals the page loaded or sends the reader to the claim", () => {
    // IAC-415 PR 4: stage 4 is the awaiting claim, whose title and approvals section carry the count (see FO-08 below), so the loaded count is asserted
    // at stage 5 (approved). IAC-415 PR 5: stage 3 and earlier is before the freeze, so a loaded count there reads "Locked. Two approvers" (FT-01 below).
    // "People: see the claim" is unchanged, at every stage.
    expect(lines(5, 2)[3]!.state).toBe("People: 2 of 2"); expect(lines(3, 1)[3]!.state).toBe("Locked. Two approvers"); expect(lines(4, null)[3]!.state).toBe("People: see the claim");
    expect(lines(3, null)[3]!.state).toBe("Locked. People: see the claim");
  });
  it("FT-01 before the freeze the rail and the trace say 'Locked. Two approvers' with no approval count, and every other state keeps its words", () => {
    const draft = paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null });
    const awaiting = paypalCard({ claimStatus: "AWAITING_APPROVAL", approvals: 1, payout: null });
    const rejected = paypalCard({ claimStatus: "REJECTED", approvals: 1, payout: null });
    const none = paypalCard({ claimStatus: null, approvals: 0, payout: null });
    expect([draft.key, awaiting.key, rejected.key, none.key]).toEqual(["not-ready", "not-ready", "rejected", "not-ready"]);
    const approvalsLine = (stage: 1 | 2 | 3 | 4 | 5, approvals: number | null, paypal: typeof draft) => railLines({ stage, typedReceipt: true, ai, approvals, paypal })[3]!.state;
    // Stages 1 to 3 (receipt pages and a DRAFT claim): locked, and no digit, whatever count the page loaded.
    for (const card of [draft, none]) for (const stage of [1, 2, 3] as const) for (const approvals of [0, 1, 2]) {
      expect(approvalsLine(stage, approvals, card), `stage ${stage} approvals ${approvals} card ${card.key}`).toBe("Locked. Two approvers");
    }
    // Stage 4 awaiting reads "Two different people", unlocked (the PR 4 rule). REJECTED keeps its count. Stage 5 keeps the count.
    for (const approvals of [0, 1]) expect(approvalsLine(4, approvals, awaiting)).toBe("Two different people");
    expect(approvalsLine(4, 1, rejected)).toBe("People: 1 of 2"); expect(approvalsLine(5, 2, draft)).toBe("People: 2 of 2");
    // A page that did not load approvals still says "see the claim", before the freeze too.
    expect(approvalsLine(2, null, draft)).toBe("Locked. People: see the claim"); expect(approvalsLine(4, null, awaiting)).toBe("People: see the claim");
    // The visible trace (the receipt pages and the DRAFT claim page render TraceStepper with these inputs) carries the new words and no count.
    const state = { ai, paypal: draft, typedReceipt: true };
    for (const stage of [2, 3] as const) {
      const html = renderToStaticMarkup(createElement(TraceStepper, { stage, state, reviews: 0 }));
      expect(html).toContain("Locked. Two approvers"); expect(html).not.toMatch(/People: \d of 2/); expect(html).not.toContain("0 of 2");
    }
    expect(traceSteps({ stage: 2, typedReceipt: true, ai, approvals: 0, paypal: draft })[4]!.detail).toBe("Locked. Two approvers");
  });
  it("FO-08 every not-ready PayPal card (no claim, DRAFT, awaiting) reads the same words with no count, an awaiting rail repeats none, and a rejected claim keeps its count", () => {
    const awaiting = paypalCard({ claimStatus: "AWAITING_APPROVAL", approvals: 1, payout: null });
    expect(awaiting.state).toBe("Not ready: needs two approvals"); expect(awaiting.state).not.toMatch(/\d/); expect(awaiting.key).toBe("not-ready"); expect(awaiting.note).toBe(PAYPAL_NOTE);
    for (const approvals of [0, 1]) expect(railLines({ stage: 4, typedReceipt: true, ai, approvals, paypal: awaiting })[3]!.state).toBe("Two different people");
    // IAC-415 PR 6: the DRAFT card and the no-claim-yet card read the awaiting words too, because no approval count exists before the freeze and the page says it once.
    expect(paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }).state).toBe("Not ready: needs two approvals");
    expect(paypalCard({ claimStatus: null, approvals: 0, payout: null }).state).toBe("Not ready: needs two approvals");
    for (const status of [null, "DRAFT", "AWAITING_APPROVAL"] as const) for (const approvals of [0, 1, 2]) expect(paypalCard({ claimStatus: status, approvals, payout: null }).state, `${status} with ${approvals}`).toBe("Not ready: needs two approvals");
    // A rejected claim sits at stage 4 too, with a rejected card: it keeps the loaded count.
    expect(railLines({ stage: 4, typedReceipt: true, ai, approvals: 1, paypal: paypalCard({ claimStatus: "REJECTED", approvals: 1, payout: null }) })[3]!.state).toBe("People: 1 of 2");
  });
  it("renders six trace steps with one current step and links only where the page supplies them", () => {
    const state = { ai, paypal: paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }), typedReceipt: true };
    const html = renderToStaticMarkup(createElement(TraceStepper, { stage: 3, state, reviews: 0, links: { 1: "/r", 2: "/r" } }));
    expect(html).toContain('<nav aria-label="Expense trace"');
    expect(html.match(/<li /g)).toHaveLength(6); expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html.match(/<a class="trace-body"/g)).toHaveLength(2);
    expect(html.match(/Done: /g)).toHaveLength(3); expect(html.match(/Current step: /g)).toHaveLength(1); expect(html.match(/Not reached: /g)).toHaveLength(2);
    expect(html).toContain("Locked. Two approvers"); expect(html).toContain("Check, then freeze");
    expect(html).toContain("Step 4 of 6, Fund split");
    expect(html).not.toContain("Blocked: ");
  });
  it("marks Rule checks blocked only at stage 3 with the policy flag, and no other step", () => {
    const state = { ai, paypal: paypalCard({ claimStatus: "DRAFT", approvals: 0, payout: null }), typedReceipt: true };
    const input = (stage: 1 | 2 | 3 | 4 | 5, policyBlocked: boolean) => traceSteps({ stage, typedReceipt: true, ai, approvals: 0, paypal: state.paypal, policyBlocked });
    const blocked = input(3, true);
    expect(blocked.map(step => step.name)).toEqual(["Receipt", "AI review", "Rule checks", "Fund split", "Approvals", "PayPal payout"]);
    expect(blocked.map(step => step.state)).toEqual(["done", "done", "blocked", "future", "future", "future"]);
    expect(blocked[2]!.detail).toBe("Stopped by organization policy");
    for (const stage of [1, 2, 4, 5] as const) expect(input(stage, true).some(step => step.state === "blocked")).toBe(false);
    expect(input(3, false).map(step => step.state)).toEqual(["done", "done", "done", "current", "future", "future"]);
    const html = renderToStaticMarkup(createElement(TraceStepper, { stage: 3, state, reviews: 0, policyBlocked: true }));
    expect(html).toContain("Blocked: "); expect(html).not.toContain('aria-current="step"');
  });
  it("renders the AI card in teal markup with its boundary note and no role=status", () => {
    const html = renderToStaticMarkup(createElement(AiStatusCard, { card: ai }));
    expect(html).toContain("status-card ai-card"); expect(html).toContain(AI_NOTE); expect(html).not.toContain("role="); expect(html).not.toContain("paypal");
  });
});

describe("SHELL-08 header tag and footer follow whether AI is configured", () => {
  it("says AI and no model name when AI is configured (IAC-416 PR 2)", () => {
    expect(shellWording(claude)).toEqual({ tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" });
    expect(shellWording(sonnet)).toEqual({ tag: "AI + PayPal", line: "Built with PayPal Payouts and AI" });
    expect(FOOTER_PROMISE).toBe("AI suggests. People decide. PayPal pays.");
  });
  it("shows no tag and a plain PayPal Payouts line when no AI is configured (IAC-416), and never names a local model", () => {
    expect(shellWording(null)).toEqual({ tag: "", line: "Built with PayPal Payouts." });
    const none = shellWording(null); expect(none.tag + none.line).not.toMatch(/local|qwen|llama/i);
    const on = shellWording(claude); expect(on.tag + on.line).not.toMatch(/local|qwen|llama/i);
  });
  it("splits the word PayPal for coloring and nothing else", () => {
    expect(paypalParts("AI + PayPal payout")).toEqual([{ text: "AI + ", paypal: false }, { text: "PayPal", paypal: true }, { text: " payout", paypal: false }]);
    expect(paypalParts("no mention")).toEqual([{ text: "no mention", paypal: false }]);
  });
});

describe("SHELL-09 every screen has the shell header and footer", () => {
  const pages = walk("src/app").filter(path => /\/page\.tsx$/.test(path));
  const PUBLIC_TRAIL_PAGE = "src/app/gift/[token]/page.tsx";
  it("renders the footer once from the root layout", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8"); expect(layout).toContain("<AppFooter />");
    expect(readFileSync("src/app/app-footer.tsx", "utf8")).toContain("FOOTER_PROMISE");
  });
  it("gives every page the header, directly or through the workspace", () => {
    expect(pages.length).toBeGreaterThanOrEqual(9);
    // IAC-413: the public donor trail has no session and its imports may not reach the AI status that AppHeader reads (GT-30), so it carries its own brand-only header.
    expect(pages.filter(path => { const text = readFileSync(path, "utf8"); return path !== PUBLIC_TRAIL_PAGE && !/<AppHeader|<Workspace/.test(text); })).toEqual([]);
    expect(readFileSync("src/app/gift/[token]/trail-view.tsx", "utf8")).toContain("<GiftBrand />");
  });
  it("keeps the trace and summary on the claim workspace pages only", () => {
    const workspace = pages.filter(path => /<Workspace/.test(readFileSync(path, "utf8"))).sort();
    expect(workspace).toEqual(["src/app/claims/[claimId]/page.tsx", "src/app/claims/[claimId]/receipt/page.tsx", "src/app/receipts/new/page.tsx"]);
  });
});

describe("SHELL-10 computed contrast of the Trust v2 text colors is at least 4.5:1", () => {
  // Literal pairs from docs/plans/TRUST_V2_PORT_SCOPE.md section 2.3. TV-03 (tests/trust-v2-tokens.test.ts) reads the same pairs from the stylesheet.
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = (hex: string) => { const n = parseInt(hex.slice(1), 16); return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255); };
  const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05); };
  const pairs: [string, string, string][] = [
    ["white on PayPal blue", "#ffffff", "#003087"], ["PayPal blue on PayPal tint", "#003087", "#edf3fb"], ["PayPal blue on white", "#003087", "#ffffff"], ["PayPal blue on bg", "#003087", "#f4f6fa"],
    ["navy on white", "#0b1f3a", "#ffffff"], ["navy on bg", "#0b1f3a", "#f4f6fa"], ["navy on tint", "#0b1f3a", "#f0f5ff"], ["navy on mark", "#0b1f3a", "#f9dba2"], ["navy on warm", "#0b1f3a", "#fff3da"],
    ["muted on white", "#5b6b80", "#ffffff"], ["muted on bg", "#5b6b80", "#f4f6fa"], ["muted on tint", "#5b6b80", "#f0f5ff"], ["muted on PayPal tint", "#5b6b80", "#edf3fb"], ["muted on block tint", "#5b6b80", "#fff6f3"],
    ["cents on white", "#5f6e83", "#ffffff"], ["cents on bg", "#5f6e83", "#f4f6fa"],
    ["accent ink on white", "#0850cc", "#ffffff"], ["accent ink on bg", "#0850cc", "#f4f6fa"], ["accent ink on tint", "#0850cc", "#f0f5ff"], ["accent ink on PayPal tint", "#0850cc", "#edf3fb"],
    ["white on accent", "#ffffff", "#0a66ff"], ["white on accent ink", "#ffffff", "#0850cc"], ["accent on white", "#0a66ff", "#ffffff"],
    ["ok on white", "#05603a", "#ffffff"], ["ok on bg", "#05603a", "#f4f6fa"], ["hold on white", "#8a4b08", "#ffffff"], ["hold on bg", "#8a4b08", "#f4f6fa"], ["hold on warm", "#8a4b08", "#fff3da"],
    ["block on white", "#b42318", "#ffffff"], ["block on bg", "#b42318", "#f4f6fa"], ["block on block tint", "#b42318", "#fff6f3"],
  ];
  it.each(pairs)("%s", (_name, fg, bg) => expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5));
  it("shows why --accent is a fill and large-text color: below 4.5 on the page background, above 3", () => {
    expect(ratio("#0a66ff", "#f4f6fa")).toBeLessThan(4.5); expect(ratio("#0a66ff", "#f4f6fa")).toBeGreaterThanOrEqual(3);
  });
});
