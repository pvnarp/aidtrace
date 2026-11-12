import { GIVE_PRESET_CENTS, formatUsd, requestShape } from "./display";

// IAC-379 step 3a: the read-only panel a keyless session shows instead of Checkout.
// The model carries no order, no capture and no paid state, and no field that could hold one.
export interface GiveFund { id: string; name: string }
export const KEYLESS_HEADLINE = "No order created, nothing captured";
export function keylessPanelModel(funds: readonly GiveFund[]) {
  const example = funds[0];
  return {
    headline: KEYLESS_HEADLINE,
    state: "Not started" as const,
    funds: funds.map(fund => ({ id: fund.id, name: fund.name })),
    amounts: [...GIVE_PRESET_CENTS.map(cents => formatUsd(cents)), "Other amount"],
    exampleLabel: example ? `${example.name}, ${formatUsd(2500n)}` : null,
    requestShape: example ? requestShape(example.id, 2500n) : null,
    // Unassigned by construction: this session never creates an order, so no provider ID exists.
    ids: { paypalOrderId: "Unassigned", captureId: "Unassigned" },
  };
}
export type KeylessPanelModel = ReturnType<typeof keylessPanelModel>;
