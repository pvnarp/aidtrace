import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { payoutWords, type PayoutAttemptFacts, type PayoutWordsInput } from "../src/app/payout-copy";

// PE-01 (IAC-415 PR 8, "payout end states say what is true"). Pure function and static source checks: no database, no network, no clock.
// The browser checks are e2e/payout-end.spec.ts (PE-02 to PE-04). Every expected sentence is a literal here, so a change to the module cannot move the expectation with it.
const usd = (cents: bigint) => `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
const attempt = (state: string, providerBalanceCents: bigint | null = null): PayoutAttemptFacts => ({ state, providerBalanceCents });
const words = (over: Partial<PayoutWordsInput> & Pick<PayoutWordsInput, "claimStatus">) => payoutWords({ attempt: null, canPay: true, refreshForm: false, usd, ...over });

const UNKNOWN_TITLE = "Send outcome unknown. Do not send again.";
const UNKNOWN_DETAIL = "PayPal did not confirm this send. It is neither paid nor failed. Reconcile it in PayPal; the saved sender IDs identify it.";
const UNKNOWN_REFRESH_DETAIL = "PayPal did not confirm this send, but it returned a batch ID. It is neither paid nor failed. An approver can use Refresh status below.";
const UNKNOWN_NOTE = "Send outcome unknown: do not send again";
const SUBMITTED_TITLE = "Payment submitted. Not yet verified as paid.";
const REFRESH_DETAIL = "An approver can use Refresh status below. A batch acceptance or pending item is not proof of payment.";
const CHECK_DETAIL = "An approver checks the result with PayPal. A batch acceptance or pending item is not proof of payment.";
const BOOK = "Book balances in this app are not proof of PayPal cash.";
const STATUSES = ["DRAFT", "AWAITING_APPROVAL", "APPROVED", "PAYOUT_PROCESSING", "PAID", "REJECTED", "PAYOUT_ISSUE"];

describe("PE-01a an UNKNOWN send says the outcome is unknown and never promises a refresh", () => {
  // The refresh form needs a recorded PayPal batch id, and a send that failed before PayPal answered has none, so the page passes refreshForm false for every role here.
  const rows: [string, Partial<PayoutWordsInput>][] = [
    ["approver with payment configured", { canPay: true, refreshForm: false }],
    ["claimant with payment configured", { canPay: true, refreshForm: false }],
    ["keyless session", { canPay: false, refreshForm: false }],
  ];
  it.each(rows)("%s", (_name, over) => {
    const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt("UNKNOWN"), ...over });
    expect(result.title).toBe(UNKNOWN_TITLE); expect(result.detail).toBe(UNKNOWN_DETAIL);
    for (const text of [result.title, result.detail]) { expect(text).not.toContain("Refresh status"); expect(text).not.toContain("Payment submitted"); }
  });
  it("UNKNOWN with the refresh form (an ambiguous HTTP answer stored a batch id): same title, and the detail says a batch ID came back and points at the button", () => {
    const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt("UNKNOWN"), refreshForm: true });
    expect(result.title).toBe(UNKNOWN_TITLE); expect(result.detail).toBe(UNKNOWN_REFRESH_DETAIL);
    expect(result.detail).toContain("returned a batch ID"); expect(result.detail).toContain("An approver can use Refresh status below."); expect(result.title).not.toContain("Payment submitted");
  });
  it("UNKNOWN without the refresh form keeps the detail with no button, whatever canPay says", () => {
    for (const canPay of [true, false]) {
      const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt("UNKNOWN"), canPay, refreshForm: false });
      expect(result.detail).toBe(UNKNOWN_DETAIL); expect(result.detail).not.toContain("Refresh status"); expect(result.detail).not.toContain("batch ID");
    }
  });
});

describe("PE-01b a submitted payment keeps its title and tells the truth about the refresh button", () => {
  for (const state of ["SUBMITTED", "PENDING", "UNKNOWN_STATUS"]) {
    it(`${state} with the refresh form: unchanged title, refresh detail`, () => {
      const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt(state), refreshForm: true });
      expect(result.title).toBe(SUBMITTED_TITLE); expect(result.detail).toBe(REFRESH_DETAIL);
    });
    it(`${state} without the refresh form (claimant or keyless): unchanged title, no promise of a button`, () => {
      for (const canPay of [true, false]) {
        const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt(state), canPay, refreshForm: false });
        expect(result.title).toBe(SUBMITTED_TITLE); expect(result.detail).toBe(CHECK_DETAIL); expect(result.detail).not.toContain("Refresh status");
      }
    });
  }
  it("a PAYOUT_PROCESSING fixture with no attempt keeps 'not proof of payment' and never promises a button", () => {
    for (const canPay of [true, false]) {
      const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: null, canPay, refreshForm: false });
      expect(result.title).toBe(SUBMITTED_TITLE); expect(result.detail).toBe(CHECK_DETAIL);
      expect(result.detail).toContain("not proof of payment"); expect(result.detail).not.toContain("Refresh status");
    }
  });
  it("every PAYOUT_PROCESSING detail except the UNKNOWN one says 'not proof of payment'", () => {
    for (const state of [null, "SUBMITTED", "PENDING", "HELD", "UNKNOWN_STATUS", "SETTLED", "SOMETHING_NEW"]) for (const refreshForm of [true, false]) for (const canPay of [true, false]) {
      const result = words({ claimStatus: "PAYOUT_PROCESSING", attempt: state ? attempt(state) : null, canPay, refreshForm });
      expect(result.detail, `${state} refresh=${refreshForm} pay=${canPay}`).toContain("not proof of payment");
    }
  });
});

describe("PE-01c the title and detail belong to PAYOUT_PROCESSING only", () => {
  it("returns null for every other claim status, whatever the attempt", () => {
    for (const claimStatus of STATUSES.filter(status => status !== "PAYOUT_PROCESSING")) for (const state of [null, "UNKNOWN", "SUBMITTED", "SETTLED", "FAILED", "MANUAL_REVIEW"]) for (const refreshForm of [true, false]) {
      const result = words({ claimStatus, attempt: state ? attempt(state) : null, refreshForm });
      expect(result.title, `${claimStatus} ${state}`).toBeNull(); expect(result.detail, `${claimStatus} ${state}`).toBeNull();
    }
  });
});

describe("PE-01d the balance sentence", () => {
  it("before a send with payment configured: unchanged warning", () => {
    expect(words({ claimStatus: "APPROVED", attempt: null, canPay: true }).balance).toBe(`${BOOK} Provider balance is unavailable. PayPal may reject the request for insufficient funds.`);
  });
  it("before a send in a keyless session: no balance line at all, as before", () => {
    for (const claimStatus of STATUSES) expect(words({ claimStatus, attempt: null, canPay: false }).balance, claimStatus).toBeNull();
  });
  it("after a send with a recorded balance: unchanged sentence with the formatted amount, zero included", () => {
    expect(words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt("SUBMITTED", 123456n) }).balance).toBe(`${BOOK} Provider available balance at submission: $1234.56. Reporting may lag up to three hours.`);
    expect(words({ claimStatus: "PAID", attempt: attempt("SETTLED", 0n) }).balance).toBe(`${BOOK} Provider available balance at submission: $0.00. Reporting may lag up to three hours.`);
  });
  it("after a send with no recorded balance (also when the field is undefined): says none was recorded", () => {
    for (const claimStatus of ["PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"]) for (const canPay of [true, false]) {
      expect(words({ claimStatus, attempt: attempt("SUBMITTED", null), canPay }).balance, claimStatus).toBe(`${BOOK} No provider balance was recorded at submission.`);
    }
    expect(words({ claimStatus: "PAID", attempt: { state: "SETTLED", providerBalanceCents: undefined } }).balance).toBe(`${BOOK} No provider balance was recorded at submission.`);
  });
  it("on a PAID claim the sentence never contains the pre-send warning", () => {
    for (const balance of [null, 0n, 50000n]) for (const canPay of [true, false]) {
      const line = words({ claimStatus: "PAID", attempt: attempt("SETTLED", balance), canPay }).balance;
      expect(line).not.toBeNull(); expect(line).not.toContain("may reject"); expect(line).not.toContain("insufficient funds"); expect(line).not.toContain("unavailable");
    }
  });
  it("once any attempt exists, no status, state or role gets the insufficient-funds warning, and the book-balance note stays", () => {
    for (const claimStatus of STATUSES) for (const state of ["UNKNOWN", "SUBMITTED", "PENDING", "SETTLED", "FAILED", "MANUAL_REVIEW", "FUNDING_REJECTED"]) for (const balance of [null, 100n]) for (const canPay of [true, false]) {
      const line = words({ claimStatus, attempt: attempt(state, balance), canPay }).balance;
      expect(line, `${claimStatus} ${state}`).toContain(BOOK); expect(line, `${claimStatus} ${state}`).not.toMatch(/may reject|insufficient funds|unavailable/);
    }
  });
});

describe("PE-01f the one-line note belongs to an UNKNOWN send only", () => {
  it("is the unknown-send wording for a PAYOUT_PROCESSING claim whose attempt is UNKNOWN, for every role and form", () => {
    for (const canPay of [true, false]) for (const refreshForm of [true, false]) {
      expect(words({ claimStatus: "PAYOUT_PROCESSING", attempt: attempt("UNKNOWN"), canPay, refreshForm }).note, `pay=${canPay} refresh=${refreshForm}`).toBe(UNKNOWN_NOTE);
    }
  });
  it("is null for every other attempt state and for no attempt, so the page keeps its own current-step note", () => {
    for (const state of [null, "SUBMITTED", "PENDING", "HELD", "UNKNOWN_STATUS", "SETTLED", "FAILED", "SOMETHING_NEW"]) for (const refreshForm of [true, false]) {
      expect(words({ claimStatus: "PAYOUT_PROCESSING", attempt: state ? attempt(state) : null, refreshForm }).note, `${state} refresh=${refreshForm}`).toBeNull();
    }
  });
  it("is null for every other claim status even with an UNKNOWN attempt", () => {
    for (const claimStatus of STATUSES.filter(status => status !== "PAYOUT_PROCESSING")) for (const refreshForm of [true, false]) {
      expect(words({ claimStatus, attempt: attempt("UNKNOWN"), refreshForm }).note, claimStatus).toBeNull();
    }
  });
});

describe("PE-01e the page reads the words and keeps one refresh condition", () => {
  const page = readFileSync("src/app/claims/[claimId]/page.tsx", "utf8");
  const lines = page.split("\n");
  it("computes the refresh condition once, passes it to the words and to the form, and keeps the old sentences out of the page", () => {
    expect(lines.filter(line => line.includes("const showRefresh = canPay && approver && Boolean(attempt?.payoutBatchId);"))).toHaveLength(1);
    expect(page.match(/showRefresh/g)).toHaveLength(3);
    expect(page).toContain("refreshForm: showRefresh");
    const form = lines.filter(line => line.includes('action="refresh"'));
    expect(form).toHaveLength(1); expect(form[0]!.trim()).toBe('{showRefresh && <ActionForm claimId={claimId} action="refresh" button="Refresh status" />}');
    for (const stale of ["Payment submitted. Not yet verified as paid.", "An approver can use Refresh status below", "Provider balance is unavailable", "may reject the request"]) expect(page, stale).not.toContain(stale);
    expect(page).toContain("words.title ??"); expect(page).toContain("words.detail ??"); expect(page).toContain("{words.balance && <p>{words.balance}</p>}");
    // The summary note falls back to the shell-copy wording for every state except an UNKNOWN send; currentNote itself is not changed by this package.
    expect(lines.filter(line => line.includes("note: words.note ?? currentNote(claim.status)"))).toHaveLength(1);
  });
});
