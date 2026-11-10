import { usd, type AnalyticsSnapshot } from "../analytics/model";

// Trust v2 PR 2 (IAC-415): the approver home fund meter. Pure and presentation only. It reads one analytics snapshot fund
// (decimal-string cents), computes integer percents with bigint division and formats amounts with the analytics usd().
// It states what the snapshot holds: book balance, reserved and available. It says nothing about modes, awards or cash.
// November 10 (Pavan, "Show money still available"): the bar now shows the share still available, nearly full and shrinking as claims reserve money.
// The reserved share is still computed (percent) so its figures stay checkable; only the bar and its accessible label moved to the available share.

export type SnapshotFund = AnalyticsSnapshot["funds"][number];
export type FundMeter = {
  name: string; label: "Restricted" | "Unrestricted";
  /** Reserved over book balance as an integer percent, clamped to 0 through 100, and 0 when the book balance is zero or negative. */
  percent: number;
  /** Available over book balance as an integer percent (rounded down), clamped to 0 through 100, and 0 when the book balance is zero or negative. This is the bar width. */
  availablePercent: number;
  available: string; book: string; reserved: string; ariaLabel: string;
};

const clampPercent = (raw: bigint) => Number(raw < 0n ? 0n : raw > 100n ? 100n : raw);

export function fundMeter(fund: SnapshotFund): FundMeter {
  const book = BigInt(fund.bookCents), reserved = BigInt(fund.reservedCents), available = BigInt(fund.availableCents);
  const percent = clampPercent(book <= 0n ? 0n : (reserved * 100n) / book);
  const availablePercent = clampPercent(book <= 0n ? 0n : (available * 100n) / book);
  return {
    name: fund.name, label: fund.restriction === "RESTRICTED" ? "Restricted" : "Unrestricted", percent, availablePercent,
    available: usd(fund.availableCents), book: usd(book), reserved: usd(reserved), ariaLabel: `${availablePercent} percent of book balance still available`,
  };
}
