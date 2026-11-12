// IAC-440 Package B. Display words and formats for the rule drafting screens. Pure: no database, no clock, no environment.
// Money arrives as integer cents (a number or a decimal string) and is formatted by BigInt arithmetic through the application usd(). Nothing is converted to a float.
import { BUDGET_NAMES, CATEGORY_NAMES } from "../../ai/categories";
import { usd } from "../../analytics/model";
import { BUDGET_LINES, THRESHOLD_KEYS, type ThresholdKey } from "../../rules-draft/draft-validate";
import type { DraftState } from "../../rules-draft/drafts";

export const humanize = (id: string): string => { const spaced = id.replace(/_/g, " "); return spaced.charAt(0).toUpperCase() + spaced.slice(1); };
export const categoryLabel = (id: string): string => CATEGORY_NAMES[id] ?? humanize(id);
export const programLabel = (id: string): string => humanize(id);

export const THRESHOLD_LABELS: Record<ThresholdKey, string> = {
  suppliesLimitCents: "Largest supplies line",
  equipmentLimitCents: "Largest equipment line",
  claimLimitCents: "Largest whole claim",
  staleReceiptDays: "Oldest receipt accepted",
  duplicateWindowDays: "Duplicate check window",
  splitWindowDays: "Split claim check window",
};
export const isDayThreshold = (key: ThresholdKey): boolean => key.endsWith("Days");
export const capLabel = (line: string): string => `${BUDGET_NAMES[line] ?? humanize(line)} cap`;

// The label of a path in analysis.missing, analysis.carried and analysis.quoteUnsupported.
export function pathLabel(path: string): string {
  if (path === "programs") return "Programs";
  if (path === "allowedCategories") return "Categories";
  if (path === "periodStart") return "Period starts";
  if (path === "periodEnd") return "Period ends";
  if (path.startsWith("caps.")) return capLabel(path.slice(5));
  if (path.startsWith("thresholds.") && (THRESHOLD_KEYS as readonly string[]).includes(path.slice(11))) return THRESHOLD_LABELS[path.slice(11) as ThresholdKey];
  return humanize(path);
}

export const moneyText = (cents: number | string | bigint): string => { try { return usd(BigInt(cents)); } catch { return "Not set"; } };
export const daysText = (days: number | string): string => `${days} ${Number(days) === 1 ? "day" : "days"}`;
export const thresholdText = (key: ThresholdKey, value: number | string): string => (isDayThreshold(key) ? daysText(value) : moneyText(value));

export const STATE_LABELS: Record<DraftState, string> = { OPEN: "Open", STALE: "Out of date", REFUSED: "Refused", WITHDRAWN: "Withdrawn", BOUND: "In use" };
export const CAP_LINES = BUDGET_LINES;
export const MAX_APPROVALS = 2;
