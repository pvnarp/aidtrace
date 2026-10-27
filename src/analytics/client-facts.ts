import { questionFacts, type AnalyticsSnapshot, type Question } from './model';

// Render only canonical snapshot facts. This browser check supplements the server boundary.
export function snapshotAnswer(snapshot: AnalyticsSnapshot, question: Question, value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid snapshot response');
  const body = value as Record<string, unknown>;
  if (body.snapshotDigest !== snapshot.digest || body.toolsOffered !== 0 || !Array.isArray(body.facts) || body.facts.length < 1 || body.facts.length > 3) throw Error('Invalid snapshot response');
  const allowed = questionFacts(snapshot, question); const seen = new Set<string>();
  return body.facts.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'id,source,text') throw Error('Invalid snapshot fact');
    const fact = item as Record<string, unknown>;
    const known = allowed.find(candidate => candidate.id === fact.id && candidate.text === fact.text && candidate.source === fact.source);
    if (!known || seen.has(known.id)) throw Error('Invalid snapshot fact');
    seen.add(known.id); return known.text;
  }).join('\n\n');
}
