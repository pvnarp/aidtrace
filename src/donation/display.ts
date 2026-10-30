// IAC-379 step 3a: pure display helpers shared by the /give page, the donation routes and the sweep log.
// Nothing here touches the database, PayPal or process.env, so a client component may import it.
// Money is bigint integer cents. Decimal text is parsed by digits and never through floating point.

export const GIVE_PRESET_CENTS: readonly bigint[] = [500n, 1000n, 2500n];

// Accepts "5", "5.5", "5.50" and "$5.50" with at most two decimals. Zero, negatives, exponents, commas and anything
// else give null. Eleven whole digits keep the result within the technical bound of 9_999_999_999_999 cents; the
// server applies its own bound again.
export function parseUsdAmount(text: string): bigint | null {
  const match = /^\$?([0-9]{1,11})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const cents = BigInt(match[1]!) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0");
  return cents > 0n ? cents : null;
}
export function formatUsd(cents: bigint): string {
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}
// The decimal string PayPal receives, built from integer cents only.
export function decimalFromCents(cents: bigint): string {
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
// Last six characters only. Shorter values are returned whole, so a short test value never grows.
export function maskTail(value: string | null | undefined, length = 6): string | null {
  if (!value) return null;
  return value.length <= length ? value : value.slice(-length);
}
// Display copy of the create request the server would send. The real request is built only in src/paypal/adapter.ts.
export function requestShape(fundId: string, cents: bigint) {
  return { intent: "CAPTURE", purchase_units: [{ custom_id: fundId, amount: { currency_code: "USD", value: decimalFromCents(cents) } }] };
}
