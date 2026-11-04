import { usd, type Fact } from './model';

// IAC-405 step 5 (docs/plans/FUNDER_REPORT_SCOPE.md section 2). The server-written facts for the two "why" questions, built from rows by a pure function.
// No database, server or React import. Facts are counts, amounts and closed words only: no name, email, claim id, provider id or free text.
// A version string reaches the model only when it matches VERSION_PATTERN. The stored model is a ">" joined chain such as "claude-haiku-5-5>claude-sonnet-5-5",
// so each part is checked against the same pattern (docs/ASSUMPTIONS.md section 86).
export const VERSION_PATTERN = /^[a-z0-9.-]{1,64}$/;
export const UNRECOGNIZED_VERSION = 'an unrecognized version';
export type WhyRecognized = { cents: bigint; ruleSetVersion: string | null; model: string | null; promptVersion: string | null; recordedAtMs: number };
export type WhyDecision = { kinds: readonly string[]; recognized: WhyRecognized | null };
export type WhyRows = {
  // One entry per allocation decision that has any automated_decisions row. recognized is set only when an AUTO_RECOGNIZED row exists.
  decisions: readonly WhyDecision[];
  // Payouts a person signed (disbursement_origins.signed_by set).
  signedPayouts: readonly { amountCents: bigint }[];
  // automation_switch_events rows with event OFF.
  switchOff: readonly { reason: string | null }[];
};

const MAX_MODEL_PARTS = 3;
export function versionText(value: string | null, chain = false): string {
  if (value === null) return 'not recorded';
  const parts = chain ? value.split('>') : [value];
  if (parts.length > MAX_MODEL_PARTS || !parts.every(part => VERSION_PATTERN.test(part))) return UNRECOGNIZED_VERSION;
  return parts.join(' then ');
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const has = (rows: WhyRows, kind: string) => rows.decisions.filter(decision => decision.kinds.includes(kind)).length;

export function whyFacts(rows: WhyRows): Fact[] {
  const autos = rows.decisions.filter((decision): decision is WhyDecision & { recognized: WhyRecognized } => decision.recognized !== null);
  const autoCents = autos.reduce((sum, decision) => sum + decision.recognized.cents, 0n);
  const latest = autos.reduce<WhyRecognized | null>((best, decision) => (best === null || decision.recognized.recordedAtMs > best.recordedAtMs ? decision.recognized : best), null);
  const signedCents = rows.signedPayouts.reduce((sum, payout) => sum + payout.amountCents, 0n);
  const off = (reason: string) => rows.switchOff.filter(event => event.reason === reason).length;
  return [
    { id: 'auto-count', text: `Autopilot approved ${plural(autos.length, 'claim', 'claims')} automatically, totaling ${usd(autoCents)}. Each payment is recorded separately and is not assumed to be paid.`, source: 'Automated decision records and recognized fund debits' },
    { id: 'auto-rule', text: 'An automatic payment needed every rule to pass and zero compliance flags, under the fund cap.', source: 'Autopilot guardrail rules' },
    { id: 'auto-versions', text: latest === null
      ? 'No automatic approval is recorded yet, so no rule set, model or prompt version is shown.'
      : `The most recent automatic approval recorded these versions. Rule set: ${versionText(latest.ruleSetVersion)}. Model: ${versionText(latest.model, true)}. Prompt: ${versionText(latest.promptVersion)}.`, source: 'Stored versions on the most recent automatic approval record' },
    { id: 'auto-sampled', text: `${plural(has(rows, 'AUDIT_SAMPLED'), 'claim was', 'claims were')} drawn for the random audit and went to two people.`, source: 'Automated decision records, audit sampled' },
    { id: 'people-signed', text: `People signed ${plural(rows.signedPayouts.length, 'payout', 'payouts')}, totaling ${usd(signedCents)}.`, source: 'Disbursements with a human signer' },
    { id: 'people-held', text: `${plural(has(rows, 'HELD'), 'claim was', 'claims were')} held for people after AI checks.`, source: 'Automated decision records, held' },
    { id: 'people-refused', text: `${plural(has(rows, 'GUARDRAIL_REFUSED'), 'claim was', 'claims were')} refused by a guardrail and went to two people.`, source: 'Automated decision records, guardrail refused' },
    { id: 'people-off', text: `The automation switch was turned off ${plural(rows.switchOff.length, 'time', 'times')}: ${off('DISAGREE')} after an approver disagreed with an automatic payment, ${off('UNKNOWN_SEND')} after an automatic payment had an unknown outcome, ${off('APPROVER')} by an approver.`, source: 'Automation switch events, OFF' },
  ];
}
