import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksStatus, firstName, handoffTarget, remainingApprovers, threadFor, validAs, type Person, type ThreadInput } from "../src/app/thread";

// TH-01 to TH-06 (November 10 judge thread). Pure logic and static source checks. The browser checks are e2e/judge-thread.spec.ts.
const tara: Person = { id: "tara", username: "tara", displayName: "Tara" };
const ben: Person = { id: "ben", username: "ben", displayName: "Ben Lee" };
const base: ThreadInput = { status: "AWAITING_APPROVAL", claimant: false, approver: true, approvedByMe: false, feasible: true, policyBlocked: false, viewerName: "Tara", remaining: [tara, ben] };
const read = (path: string) => readFileSync(path, "utf8");

describe("TH-01 the next approver comes from loaded data only", () => {
  const all = [tara, ben, { id: "maria", username: "maria", displayName: "Maria" }];
  it("drops the claimant and everyone who approved, keeping order", () => {
    expect(remainingApprovers([tara, ben], "maria", [])).toEqual([tara, ben]);
    expect(remainingApprovers([tara, ben], "maria", ["tara"])).toEqual([ben]);
    expect(remainingApprovers([tara, ben], "maria", ["tara", "ben"])).toEqual([]);
    expect(remainingApprovers(all, "tara", [])).toEqual([ben, all[2]]);
  });
  it("uses the first word of a display name", () => { expect(firstName("Ben Lee")).toBe("Ben"); expect(firstName("  Tara ")).toBe("Tara"); });
});

describe("TH-02 the actor line and handoff follow the states table", () => {
  it("names both approvers for the claimant after the freeze and hands off to the first", () => {
    expect(threadFor({ ...base, claimant: true, approver: false, viewerName: "Maria" })).toEqual({ actor: "Tara and Ben act next.", handoff: { username: "tara", label: "Sign out and continue as Tara" } });
  });
  it("names one remaining approver, or says another approver when the data names none or several, after the viewer approved", () => {
    expect(threadFor({ ...base, approvedByMe: true, remaining: [ben] })).toEqual({ actor: "Ben acts next.", handoff: { username: "ben", label: "Sign out and continue as Ben" } });
    expect(threadFor({ ...base, approvedByMe: true, remaining: [] })).toEqual({ actor: "Another approver acts next.", handoff: { username: null, label: "Sign out and continue as another approver" } });
    expect(threadFor({ ...base, approvedByMe: true, remaining: [tara, ben] })?.handoff).toEqual({ username: null, label: "Sign out and continue as another approver" });
  });
  it("gives an approver who has not approved a line and no handoff", () => {
    expect(threadFor(base)).toEqual({ actor: "Your move, Tara. Run the checks, then approve." });
  });
  it("gives the claimant a line on a draft, and an approver a line on someone else's draft, with no handoff", () => {
    expect(threadFor({ ...base, status: "DRAFT", claimant: true, approver: false, viewerName: "Maria" })).toEqual({ actor: "Your move, Maria. Rules computed this split." });
    expect(threadFor({ ...base, status: "DRAFT", claimant: true, approver: false, viewerName: "Maria", feasible: false })).toEqual({ actor: "Your move, Maria." });
    expect(threadFor({ ...base, status: "DRAFT" })).toEqual({ actor: "The claimant acts first." });
  });
  it("gives no line in payment states", () => { for (const status of ["APPROVED", "PAID", "PAYOUT_PROCESSING", "PAYOUT_ISSUE", "REJECTED"]) expect(threadFor({ ...base, status })).toBeNull(); });
  it("never builds a handoff for a claimant when no approver remains", () => { expect(threadFor({ ...base, claimant: true, approver: false, remaining: [] })).toEqual({ actor: "Approvers act next." }); });
});

describe("TH-03 ?as= is a plain username or nothing", () => {
  it.each(["tara", "ben", "maria", "a", "user_2", "a".repeat(32)])("accepts %s", value => expect(validAs(value)).toBe(value));
  it.each(["", "Tara", "1tara", "ta ra", "tara/../x", "<script>", "tara\n", "tara%00", "a".repeat(33), "-tara", "tara;"])("ignores %j", value => expect(validAs(value)).toBeNull());
  it("ignores a repeated or missing parameter", () => { expect(validAs(["tara", "ben"])).toBeNull(); expect(validAs(undefined)).toBeNull(); });
  it("only ever builds /login or /login?as=<valid username>", () => {
    expect(handoffTarget("tara")).toBe("/login?as=tara"); expect(handoffTarget(null)).toBe("/login"); expect(handoffTarget("Tara x")).toBe("/login"); expect(handoffTarget("../x")).toBe("/login");
  });
});

describe("TH-04 the checks status line reads stored data and never gates approval", () => {
  it("says not run, no flags, or the count", () => {
    expect(checksStatus(null)).toBe("Checks not run yet."); expect(checksStatus({ flags: [] })).toBe("Checks run: no flags.");
    expect(checksStatus({ flags: [1] })).toBe("Checks run: 1 flag."); expect(checksStatus({ flags: [1, 2] })).toBe("Checks run: 2 flags.");
    for (const text of [checksStatus(null), checksStatus({ flags: [] }), checksStatus({ flags: [1] })]) expect(text).not.toMatch(/approved|passed|cleared/i);
  });
  it("renders the line above Approve with a link to #policy-checks and leaves the Approve form's condition alone", () => {
    const page = read("src/app/claims/[claimId]/page.tsx");
    expect(page).toContain('<a href="#policy-checks">{view.policyChecks.run ? "See the checks" : "Run the checks"}</a>');
    expect(page.indexOf("checks-status")).toBeLessThan(page.indexOf('button="Approve these terms"'));
    expect(page).toContain('{approver && decision && claim.status === "AWAITING_APPROVAL" && !approvedByMe && <ActionForm claimId={claimId} action="approve"');
  });
});

describe("TH-05 the thread keeps the existing titles and adds one kicker", () => {
  const journey = read("src/app/journey.tsx"), page = read("src/app/claims/[claimId]/page.tsx");
  it("keeps the Next decision kicker and every claim title", () => {
    expect(journey).toContain('<p className="kicker">Next decision</p><h2>{title}</h2>');
    for (const title of ["Waiting for two approvers.", "Hand this claim to a different approver.", "Review the frozen terms.", "Check the split, then freeze these terms."]) expect(page).toContain(`"${title}"`);
  });
  it("adds the Trace complete kicker only on a separate card that is not labeled as the journey", () => {
    expect(journey).toContain('kicker = "Trace complete"'); expect(journey).toContain('aria-label={kicker}'); expect(journey).toContain('<p className="kicker">{kicker}</p>');
    expect(page).toContain('kicker={claim.status === "PAID" ? "Trace complete" : "Approved, unpaid"}'); expect(page).toContain('"Approval is complete. Payout is a separate step."');
    expect(page).toContain('claim.status === "PAID" || (claim.status === "APPROVED" && !autoWaiting)');
    expect(page).toContain('href: "/ledger"'); expect(page).toContain('href: "/analytics/report"');
    expect(page).toContain('user.role === "APPROVER" ? [');
  });
  it("posts to the existing logout endpoint and edits no API route", () => {
    const button = read("src/app/handoff-button.tsx");
    expect(button).toContain('fetch("/api/auth/logout", { method: "POST"'); expect(button).toContain("handoffTarget(username)");
    expect(button.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/password|cookie|localStorage|sessionStorage/i);
  });
});

describe("TH-06 the login page", () => {
  const login = read("src/app/login/page.tsx");
  it("prefills only the validated username, focuses Password, and never fills a password", () => {
    expect(login).toContain("validAs(params.as)"); expect(login).toContain("{...(asUser ? { defaultValue: asUser } : {})}"); expect(login).toContain("{...(asUser ? { autoFocus: true } : {})}");
    expect(login).not.toMatch(/name="password"[^>]*defaultValue|name="password"[^>]*value=/);
  });
  it("renders the trace legend and the order hint, and no duplicate footer", () => {
    expect(login).toContain("<TraceLegend />"); expect(login).toContain("Start as maria."); expect(login).not.toContain("<footer>");
    expect(login).toContain("Each account has its own generated password, supplied with your setup. Sign in separately for each role.");
  });
});
