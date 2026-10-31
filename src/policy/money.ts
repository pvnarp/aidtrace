// Money for policy checks is integer cents held as bigint. There is no floating point anywhere in this package.
export function assertCents(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new TypeError(`${label} must be a non-negative bigint of cents`);
  return value;
}
export function assertPositiveCents(value: unknown, label: string): bigint {
  const cents = assertCents(value, label);
  if (cents === 0n) throw new TypeError(`${label} must be positive`);
  return cents;
}
export function assertDays(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 3650) throw new TypeError(`${label} must be a whole number of days from 1 to 3650`);
  return value;
}
// USD 1,250.00 from 125000n. Whole dollars get thousands separators; cents are always two digits.
export function formatUsd(cents: bigint): string {
  assertCents(cents, "amount");
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `USD ${dollars}.${(cents % 100n).toString().padStart(2, "0")}`;
}
export const sumCents = (values: readonly bigint[]) => values.reduce((total, value) => total + value, 0n);
