import { usd, type AnalyticsSnapshot } from "../analytics/model";

// Trust v2 PR 2 (IAC-415): the approver home fund meter. Pure and presentation only. It reads one analytics snapshot fund
// (decimal-string cents), computes an integer percent with bigint division and formats amounts with the analytics usd().
// It states what the snapshot holds: book balance, reserved and available. It says nothing about modes, awards or cash.

export type SnapshotFund = AnalyticsSnapshot["funds"][number];
export type FundMeter = {
  name: string; label: "Restricted" | "Unrestricted";
  /** Reserved over book balance as an integer percent, clamped to 0 through 100, and 0 when the book balance is zero or negative. */
  percent: number;
  available: string; book: string; reserved: string; ariaLabel: string;
};

export function fundMeter(fund: SnapshotFund): FundMeter {
  const book = BigInt(fund.bookCents), reserved = BigInt(fund.reservedCents);
  const raw = book <= 0n ? 0n : (reserved * 100n) / book;
  const percent = Number(raw < 0n ? 0n : raw > 100n ? 100n : raw);
  return {
    name: fund.name, label: fund.restriction === "RESTRICTED" ? "Restricted" : "Unrestricted", percent,
    available: usd(fund.availableCents), book: usd(book), reserved: usd(reserved), ariaLabel: `${percent} percent of book balance reserved`,
  };
}
