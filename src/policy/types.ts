import type { PolicyRuleId } from "../../db/schema";

export type { PolicyRuleId };
export type ThresholdRuleId = "P1" | "P2" | "P3" | "P5" | "P6";
export const THRESHOLD_RULES: readonly ThresholdRuleId[] = ["P1", "P2", "P3", "P5", "P6"];

// One fund_check_settings row, the latest version for a fund that funds this claim. Cents and day counts only.
export type PolicyThresholds = {
  fundId: string; version: number;
  suppliesLimitCents: bigint; equipmentLimitCents: bigint; claimLimitCents: bigint;
  staleReceiptDays: number; duplicateWindowDays: number; splitWindowDays: number;
};
export type PolicyLine = { id: string; description: string; category: string; budgetLine: string; amountCents: bigint };
// An earlier or neighboring claim with the same normalized vendor, newest version per claim id.
export type PolicyPeer = {
  claimId: string; version: number; vendor: string; incurredOn: string; claimantId: string; status: string;
  lines: { budgetLine: string; amountCents: bigint }[];
};
export type PolicyFacts = {
  claim: { id: string; version: number; vendor: string; incurredOn: string; claimantId: string; organizationId: string };
  // UTC calendar date of allocation_decisions.frozenAt. Claims carry no submission time (decision 8).
  frozenOn: string;
  lines: PolicyLine[];
  // allocation_edges of the frozen decision: which fund pays which line.
  funding: { lineId: string; fundId: string }[];
  // Latest settings for the funds that fund this claim. Funds with no settings row are absent.
  thresholds: PolicyThresholds[];
  peers: PolicyPeer[];
  // The stored receipt_confirmations.prohibitedScreen.matches, or null when no confirmation exists. Never recomputed.
  receiptScreen: { category: string; term: string }[] | null;
};

export type PolicyFlag = {
  entry: "FLAG"; ruleId: PolicyRuleId; severity: "HOLD" | "NOTE"; lineId: string | null;
  fundId: string | null; settingsVersion: number | null; flagText: string; inputs: Record<string, unknown>;
};
export type PolicyNotChecked = { entry: "NOT_CHECKED"; ruleId: ThresholdRuleId; reasonCode: "NO_THRESHOLDS"; flagText: string; inputs: Record<string, unknown> };
export type PolicyEntry = PolicyFlag | PolicyNotChecked;
export type PolicyOutcome = {
  ruleSetVersion: string;
  // Fund id to the settings version the rules read. Empty when no funding fund had thresholds.
  settingsVersions: Record<string, number>;
  entries: PolicyEntry[];
};
