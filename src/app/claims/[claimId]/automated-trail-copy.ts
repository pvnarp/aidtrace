import { usd } from "../../../analytics/model";

// IAC-405 trail plurals. Pure wording for the guardrail trail: no database, server or React import.
// It formats stored values and checks nothing. Only the counts in the first three sentences change with their number; every other sentence is fixed text.
export type Result = { pass?: boolean } & Record<string, unknown>;
export const str = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "none");
export const money = (value: unknown): string => (typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? usd(value) : "unknown");
export const day = (value: unknown): string => (typeof value === "string" ? value.slice(0, 10) : "none");

// The number 1 or the string "1" reads singular. Any other number or decimal-digit string reads plural. Anything else reads "none <plural>", as str does.
export function count(value: unknown, singular: string, plural: string): string {
  if (value === 1 || value === "1") return `1 ${singular}`;
  if (typeof value === "number" || (typeof value === "string" && /^[0-9]+$/.test(value))) return `${value} ${plural}`;
  return `none ${plural}`;
}

export function lineOf(id: string, r: Result): string {
  switch (id) {
    case "G1": return `Rules and AI agreed on every line (${count(r.okLines, "line", "lines")}, ${count(r.checkedPairs, "check", "checks")}).`;
    case "G2": return `${r.lines === 1 || r.lines === "1" ? `${count(r.lines, "line", "lines")}, within its cap` : `${count(r.lines, "line", "lines")}, each within its cap`}: supplies up to ${money(r.suppliesCapCents)}, equipment up to ${money(r.equipmentCapCents)}.`;
    case "G3": return `Fund total for the UTC day stays within ${money(r.capCents)} (${count(Array.isArray(r.funds) ? r.funds.length : 0, "paying fund", "paying funds")}).`;
    case "G4": return `This claimant's automated total over 7 days was ${money(r.usedCents)} before this claim of ${money(r.claimCents)}; the limit is ${money(r.capCents)}.`;
    case "G5": return `Earlier claim by the same claimant, paid after two human approvals: ${str(r.priorClaim)}.`;
    case "G6": return r.demoHistory === true
      ? `Payout email unchanged for ${str(r.days)} days, from demo history first seen ${day(r.anchorSeenAt)}.`
      : `Payout email unchanged for ${str(r.days)} days, first seen ${day(r.anchorSeenAt)}.`;
    case "G7": return `Audit draw ${str(r.draw)} of 0 to 99; a draw below ${str(r.samplePercent)} goes to two approvers, so this claim was not sampled.`;
    default: return "The automation switch was on and no automated payment was unresolved.";
  }
}
