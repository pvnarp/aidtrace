// IAC-405 step 1: deterministic policy rules P1 to P7 (docs/plans/POLICY_CHECK_SCOPE.md section 2.1).
// evaluatePolicy is a pure function of stored facts. It reads no database, no clock, no network and no model.
// It returns flags and "not checked" rows. It never approves, clears or blocks anything, and it moves no money.
// Which fund's thresholds apply is the strictest-fund rule in docs/ASSUMPTIONS.md: a per-line threshold uses the strictest
// limit among the funds that pay that line, and a claim-level threshold uses the strictest among all funds that pay the claim.
import { assertCents, assertDays, assertPositiveCents, formatUsd, sumCents } from "./money";
import { NOT_CHECKED_TEXT } from "./copy";
import { boundedText, dayNumber, normalizeVendor, plural } from "./text";
import { THRESHOLD_RULES, type PolicyEntry, type PolicyFacts, type PolicyFlag, type PolicyOutcome, type PolicyPeer, type PolicyThresholds, type ThresholdRuleId } from "./types";

export const RULE_SET_VERSION = "policy-rules-v1";
// Claims that count as earlier activity for P1 and P2. A DRAFT or REJECTED claim never does (docs/plans/POLICY_CHECK_SCOPE.md P1).
export const COUNTED_STATUSES: readonly string[] = ["AWAITING_APPROVAL", "APPROVED", "PAYOUT_PROCESSING", "PAID", "PAYOUT_ISSUE"];
// Local copies of the category sets (decision 5). tests/policy-rules.test.ts checks them against BUDGET_LINE in src/ai/categories.ts,
// so src/policy does not import src/ai. food_for_distribution and transit_passes are not meals or travel.
export const MEAL_CATEGORIES: readonly string[] = ["participant_meals", "volunteer_meals"];
export const TRAVEL_CATEGORIES: readonly string[] = ["group_transport", "mileage", "vehicle_rental"];
export const PROHIBITED_LINE_CATEGORIES: readonly string[] = ["alcohol", "gift_cards"];
const MAX_LISTED = 5;
const collator = new Intl.Collator("en", { numeric: true });

type Source = { fundId: string; version: number };
const source = (t: PolicyThresholds): Source => ({ fundId: t.fundId, version: t.version });

// The strictest threshold among candidates. Ties go to the lowest fund id so the result is deterministic.
function strictest<T extends PolicyThresholds>(candidates: readonly T[], value: (t: T) => bigint | number, direction: "min" | "max"): T {
  const sorted = [...candidates].sort((a, b) => collator.compare(a.fundId, b.fundId));
  let best = sorted[0]!;
  for (const row of sorted.slice(1)) if (direction === "min" ? value(row) < value(best) : value(row) > value(best)) best = row;
  return best;
}

function validate(facts: PolicyFacts) {
  dayNumber(facts.claim.incurredOn); dayNumber(facts.frozenOn);
  for (const line of facts.lines) assertPositiveCents(line.amountCents, `line ${line.id} amount`);
  for (const peer of facts.peers) { dayNumber(peer.incurredOn); for (const line of peer.lines) assertPositiveCents(line.amountCents, `claim ${peer.claimId} line amount`); }
  const seen = new Set<string>();
  for (const t of facts.thresholds) {
    if (seen.has(t.fundId)) throw new TypeError("One settings row per fund");
    seen.add(t.fundId);
    if (!Number.isSafeInteger(t.version) || t.version < 1) throw new TypeError("Settings version must be a positive integer");
    assertPositiveCents(t.suppliesLimitCents, "supplies limit"); assertPositiveCents(t.equipmentLimitCents, "equipment limit"); assertPositiveCents(t.claimLimitCents, "claim limit");
    assertDays(t.staleReceiptDays, "stale receipt days"); assertDays(t.duplicateWindowDays, "duplicate window days"); assertDays(t.splitWindowDays, "split window days");
  }
}

const flag = (f: Omit<PolicyFlag, "entry" | "severity"> & { severity?: PolicyFlag["severity"] }): PolicyFlag => ({ entry: "FLAG", severity: "HOLD", ...f });
const notChecked = (ruleId: ThresholdRuleId): PolicyEntry => ({ entry: "NOT_CHECKED", ruleId, reasonCode: "NO_THRESHOLDS", flagText: NOT_CHECKED_TEXT, inputs: {} });
const peerTotal = (peer: PolicyPeer) => sumCents(peer.lines.map(line => line.amountCents));
const subtotal = (lines: readonly { budgetLine: string; amountCents: bigint }[], budgetLine: string) => sumCents(lines.filter(line => line.budgetLine === budgetLine).map(line => line.amountCents));
const daysBetween = (a: string, b: string) => Math.abs(dayNumber(a) - dayNumber(b));
const byNearest = (facts: PolicyFacts) => (a: PolicyPeer, b: PolicyPeer) =>
  daysBetween(a.incurredOn, facts.claim.incurredOn) - daysBetween(b.incurredOn, facts.claim.incurredOn) || collator.compare(a.claimId, b.claimId);
const countedPeers = (facts: PolicyFacts) => facts.peers.filter(peer => peer.claimId !== facts.claim.id && COUNTED_STATUSES.includes(peer.status));

// P1: same vendor and same claim total, dated within the longest duplicate window of the funds on the claim.
function p1(facts: PolicyFacts, settings: readonly PolicyThresholds[], total: bigint): PolicyEntry[] {
  const key = normalizeVendor(facts.claim.vendor);
  if (!key || total === 0n) return [];
  const window = strictest(settings, t => t.duplicateWindowDays, "max");
  const all = countedPeers(facts)
    .filter(peer => normalizeVendor(peer.vendor) === key && peerTotal(peer) === total && daysBetween(peer.incurredOn, facts.claim.incurredOn) <= window.duplicateWindowDays)
    .sort(byNearest(facts));
  return all.slice(0, MAX_LISTED).map(peer => {
    const apart = daysBetween(peer.incurredOn, facts.claim.incurredOn);
    const gap = apart === 0 ? "same date" : `${plural(apart, "day")} apart`;
    return flag({ ruleId: "P1", lineId: null, fundId: window.fundId, settingsVersion: window.version,
      flagText: `Possible duplicate of claim ${boundedText(peer.claimId, 64)} from ${boundedText(peer.vendor, 60)} dated ${peer.incurredOn} for ${formatUsd(total)}: same vendor and total, ${gap}.`,
      inputs: { peerClaimId: peer.claimId, peerClaimVersion: peer.version, peerIncurredOn: peer.incurredOn, peerStatus: peer.status, totalCents: total.toString(),
        daysApart: apart, windowDays: window.duplicateWindowDays, matchCount: all.length, source: source(window) } });
  });
}

// P2: this claim and nearby claims from the same claimant and vendor are each at or under a limit, and together are over it.
function p2(facts: PolicyFacts, settings: readonly PolicyThresholds[]): PolicyEntry[] {
  const key = normalizeVendor(facts.claim.vendor);
  if (!key) return [];
  const window = strictest(settings, t => t.splitWindowDays, "max");
  const group = countedPeers(facts)
    .filter(peer => peer.claimantId === facts.claim.claimantId && normalizeVendor(peer.vendor) === key && daysBetween(peer.incurredOn, facts.claim.incurredOn) <= window.splitWindowDays)
    .sort(byNearest(facts));
  if (!group.length) return [];
  const checks: { category: "supplies" | "equipment" | "claim"; label: string; limit: PolicyThresholds; limitCents: bigint; value: (lines: readonly { budgetLine: string; amountCents: bigint }[]) => bigint }[] = [];
  const supplies = strictest(settings, t => t.suppliesLimitCents, "min");
  const equipment = strictest(settings, t => t.equipmentLimitCents, "min");
  const claim = strictest(settings, t => t.claimLimitCents, "min");
  checks.push({ category: "supplies", label: "supplies", limit: supplies, limitCents: supplies.suppliesLimitCents, value: lines => subtotal(lines, "supplies") });
  checks.push({ category: "equipment", label: "equipment", limit: equipment, limitCents: equipment.equipmentLimitCents, value: lines => subtotal(lines, "equipment") });
  checks.push({ category: "claim", label: "claim", limit: claim, limitCents: claim.claimLimitCents, value: lines => sumCents(lines.map(line => line.amountCents)) });
  const out: PolicyEntry[] = [];
  for (const check of checks) {
    const mine = check.value(facts.lines);
    const parts = group.map(peer => ({ peer, cents: check.value(peer.lines) })).filter(part => part.cents > 0n);
    if (mine === 0n || !parts.length) continue;
    const together = mine + sumCents(parts.map(part => part.cents));
    if (mine > check.limitCents || parts.some(part => part.cents > check.limitCents) || together <= check.limitCents) continue;
    const listed = parts.slice(0, MAX_LISTED).map(part => boundedText(part.peer.claimId, 64));
    const more = parts.length > MAX_LISTED ? ` and ${parts.length - MAX_LISTED} more` : "";
    out.push(flag({ ruleId: "P2", lineId: null, fundId: check.limit.fundId, settingsVersion: check.limit.version,
      flagText: `Possible split: this claim and ${listed.join(", ")}${more} are from the same claimant and vendor within ${plural(window.splitWindowDays, "day")}. Together they total ${formatUsd(together)}, over the ${formatUsd(check.limitCents)} ${check.label} limit.`,
      inputs: { category: check.category, thisClaimCents: mine.toString(), parts: parts.slice(0, MAX_LISTED).map(part => ({ claimId: part.peer.claimId, claimVersion: part.peer.version, incurredOn: part.peer.incurredOn, cents: part.cents.toString() })),
        partCount: parts.length, togetherCents: together.toString(), limitCents: check.limitCents.toString(), limitSource: source(check.limit), windowDays: window.splitWindowDays, windowSource: source(window) } }));
  }
  return out;
}

// P3: the receipt date is more than the shortest stale limit before the UTC date the decision was frozen. Day 60 is silent, day 61 flags.
function p3(facts: PolicyFacts, settings: readonly PolicyThresholds[]): PolicyEntry[] {
  const limit = strictest(settings, t => t.staleReceiptDays, "min");
  const age = dayNumber(facts.frozenOn) - dayNumber(facts.claim.incurredOn);
  if (age <= limit.staleReceiptDays) return [];
  return [flag({ ruleId: "P3", lineId: null, fundId: limit.fundId, settingsVersion: limit.version,
    flagText: `Receipt dated ${facts.claim.incurredOn} was ${plural(age, "day")} old when the decision was frozen. The limit is ${plural(limit.staleReceiptDays, "day")}.`,
    inputs: { incurredOn: facts.claim.incurredOn, frozenOn: facts.frozenOn, ageDays: age, limitDays: limit.staleReceiptDays, source: source(limit) } })];
}

// P4: meals and travel always go to a person. Needs no threshold.
function p4(lines: readonly PolicyFacts["lines"][number][]): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const line of lines) {
    const kind = MEAL_CATEGORIES.includes(line.category) ? "meal" : TRAVEL_CATEGORIES.includes(line.category) ? "travel" : null;
    if (!kind) continue;
    out.push(flag({ ruleId: "P4", lineId: line.id, fundId: null, settingsVersion: null,
      flagText: kind === "meal" ? `Line ${boundedText(line.id, 32)} is a meal. Meals always go to a person.` : `Line ${boundedText(line.id, 32)} is travel. Travel always goes to a person.`,
      inputs: { lineId: line.id, category: line.category, kind, amountCents: line.amountCents.toString() } }));
  }
  return out;
}

// P5: a supplies or equipment line over the strictest limit among the funds that pay that line. A line whose own funds have no
// settings falls back to the strictest limit among all funds on the claim that have settings (docs/ASSUMPTIONS.md).
function p5(facts: PolicyFacts, settings: readonly PolicyThresholds[], lines: readonly PolicyFacts["lines"][number][]): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const line of lines) {
    if (line.budgetLine !== "supplies" && line.budgetLine !== "equipment") continue;
    const payers = new Set(facts.funding.filter(edge => edge.lineId === line.id).map(edge => edge.fundId));
    const own = settings.filter(t => payers.has(t.fundId));
    const candidates = own.length ? own : settings;
    const isSupplies = line.budgetLine === "supplies";
    const best = strictest(candidates, t => isSupplies ? t.suppliesLimitCents : t.equipmentLimitCents, "min");
    const limit = isSupplies ? best.suppliesLimitCents : best.equipmentLimitCents;
    if (line.amountCents <= limit) continue;
    const id = boundedText(line.id, 32);
    out.push(flag({ ruleId: "P5", lineId: line.id, fundId: best.fundId, settingsVersion: best.version,
      flagText: isSupplies ? `Line ${id} is ${formatUsd(line.amountCents)} of supplies. Supplies over ${formatUsd(limit)} go to a person.` : `Line ${id} is ${formatUsd(line.amountCents)} of equipment. Equipment over ${formatUsd(limit)} goes to a person.`,
      inputs: { lineId: line.id, budgetLine: line.budgetLine, amountCents: line.amountCents.toString(), limitCents: limit.toString(),
        fundsConsidered: candidates.map(t => ({ fundId: t.fundId, version: t.version })), usedClaimFallback: own.length === 0, source: source(best) } }));
  }
  return out;
}

// P6: the claim total is over the lowest claim limit among the funds on the claim.
function p6(settings: readonly PolicyThresholds[], total: bigint): PolicyEntry[] {
  const best = strictest(settings, t => t.claimLimitCents, "min");
  if (total <= best.claimLimitCents) return [];
  return [flag({ ruleId: "P6", lineId: null, fundId: best.fundId, settingsVersion: best.version,
    flagText: `Claim total is ${formatUsd(total)}, over the ${formatUsd(best.claimLimitCents)} limit. Two people must approve. Manual funds already require two approvers.`,
    inputs: { totalCents: total.toString(), limitCents: best.claimLimitCents.toString(), source: source(best) } })];
}

const CATEGORY_WORDS: Record<string, string> = { alcohol: "alcohol", gift_cards: "gift cards" };
// P7: a prohibited category on a line, and the receipt screen as it was stored at confirmation. Never rescreened here.
function p7(facts: PolicyFacts, lines: readonly PolicyFacts["lines"][number][]): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (const line of lines) {
    if (!PROHIBITED_LINE_CATEGORIES.includes(line.category)) continue;
    out.push(flag({ ruleId: "P7", lineId: line.id, fundId: null, settingsVersion: null,
      flagText: `Line ${boundedText(line.id, 32)} is categorized as ${CATEGORY_WORDS[line.category]}, which is prohibited.`,
      inputs: { lineId: line.id, category: line.category, amountCents: line.amountCents.toString() } }));
  }
  const matches = (facts.receiptScreen ?? []).filter(match => Object.hasOwn(CATEGORY_WORDS, match.category));
  if (matches.length) {
    const listed = matches.slice(0, MAX_LISTED).map(match => `${CATEGORY_WORDS[match.category]}: ${boundedText(match.term, 40)}`);
    const more = matches.length > MAX_LISTED ? `; and ${matches.length - MAX_LISTED} more` : "";
    out.push(flag({ ruleId: "P7", lineId: null, fundId: null, settingsVersion: null,
      flagText: `Receipt text matched the prohibited list as recorded at confirmation (${listed.join("; ")}${more}).`,
      inputs: { matches: matches.slice(0, MAX_LISTED).map(match => ({ category: match.category, term: boundedText(match.term, 40) })), matchCount: matches.length } }));
  }
  return out;
}

export function evaluatePolicy(facts: PolicyFacts): PolicyOutcome {
  validate(facts);
  const lines = [...facts.lines].sort((a, b) => collator.compare(a.id, b.id));
  const total = sumCents(lines.map(line => assertCents(line.amountCents, "line amount")));
  const settings = [...facts.thresholds].sort((a, b) => collator.compare(a.fundId, b.fundId));
  const checked = settings.length > 0;
  const entries: PolicyEntry[] = [];
  const rule = (id: ThresholdRuleId, run: () => PolicyEntry[]) => entries.push(...(checked ? run() : [notChecked(id)]));
  rule("P1", () => p1(facts, settings, total));
  rule("P2", () => p2(facts, settings));
  rule("P3", () => p3(facts, settings));
  entries.push(...p4(lines));
  rule("P5", () => p5(facts, settings, lines));
  rule("P6", () => p6(settings, total));
  entries.push(...p7(facts, lines));
  // THRESHOLD_RULES is the list of rules that depend on settings. Every one is either evaluated or marked not checked.
  if (!checked && entries.filter(entry => entry.entry === "NOT_CHECKED").length !== THRESHOLD_RULES.length) throw new Error("Every threshold rule is marked not checked");
  return { ruleSetVersion: RULE_SET_VERSION, settingsVersions: Object.fromEntries(settings.map(t => [t.fundId, t.version])), entries };
}
