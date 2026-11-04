// Shared, serializable presentation contract. No provider identifiers or payees.
export const QUESTIONS = {
  funding: 'What funding is available?',
  cash: 'How does book cash relate to recorded activity?',
  payable: 'What remains payable?',
  whyAuto: 'Why were some claims paid automatically?',
  whyPeople: 'Why did some claims go to people?',
} as const;
export type Question = keyof typeof QUESTIONS;
export type Fact = { id: string; text: string; source: string };
export type AnalyticsSnapshot = {
  digest: string; observedAt: string; source: 'LOCAL_APPLICATION_DATABASE';
  organization: string; fixture: boolean; matches: boolean; fixtureNotStarted?: boolean;
  funds: { name: string; restriction: 'RESTRICTED' | 'UNRESTRICTED'; bookCents: string; reservedCents: string; availableCents: string }[];
  cash: { openingCents: string; providerDeltaCents: string; bookCents: string; payableCents: string };
  facts: Fact[];
};
export const FACT_IDS: Record<Question, readonly string[]> = {
  funding: ['restricted', 'general', 'reserved', 'availability'],
  cash: ['cash', 'opening', 'activity', 'cash-limit'],
  payable: ['payable', 'tie-out', 'cash-limit'],
  whyAuto: ['auto-count', 'auto-rule', 'auto-versions', 'auto-sampled'],
  whyPeople: ['people-signed', 'people-held', 'people-refused', 'people-off'],
};
export const isQuestion = (value: unknown): value is Question => typeof value === 'string' && Object.hasOwn(QUESTIONS, value);
export function usd(cents: string | bigint) {
  const value = BigInt(cents); const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}$${(magnitude / 100n).toLocaleString('en-US')}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}
export function questionFacts(snapshot: AnalyticsSnapshot, question: Question) {
  return snapshot.facts.filter(fact => FACT_IDS[question].includes(fact.id));
}
