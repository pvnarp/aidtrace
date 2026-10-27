import type { AppDatabase } from './db';
import { findSession, isSameOrigin, sessionToken } from './auth';
import { loadAnalyticsSnapshot, AnalyticsAccessError } from '../analytics/snapshot';
import { isQuestion, questionFacts } from '../analytics/model';
import { createAnalyticsSelector, AnalyticsModelError, type AnalyticsSelector } from '../analytics/explain';
const select = createAnalyticsSelector();
export const analyticsHeaders = { 'Cache-Control': 'no-store, private', Vary: 'Cookie' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: analyticsHeaders });
export async function handleAnalytics(request: Request, deps: { db: AppDatabase; selector?: AnalyticsSelector; enabled?: boolean }) {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (new URL(request.url).search) return json({ error: 'Unexpected query parameters' }, 400);
  if (request.method === 'POST' && !isSameOrigin(request)) return json({ error: 'Request origin rejected' }, 403);
  const user = await findSession(sessionToken(request), deps.db);
  if (!user) return json({ error: 'Sign in first' }, 401);
  if (user.role !== 'APPROVER') return json({ error: 'Approver access required' }, 403);
  try {
    const snapshot = await loadAnalyticsSnapshot(deps.db, user.id);
    if (request.method === 'GET') return json(snapshot);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'JSON request required' }, 415);
    const reader = request.body?.getReader(); if (!reader) return json({ error: 'Missing request' }, 400);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024) { await reader.cancel(); return json({ error: 'Request too large' }, 413); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json({ error: 'Invalid request' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'question,snapshotDigest' || !isQuestion(body.question) || typeof body.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(body.snapshotDigest)) return json({ error: 'Choose one of the listed snapshot questions' }, 400);
    if (body.snapshotDigest !== snapshot.digest) return json({ error: 'Snapshot changed. Reload the dashboard before requesting an explanation.' }, 409);
    if (!(deps.enabled ?? process.env.AI_ANALYTICS_ENABLED === 'true')) return json({ error: 'AI unavailable. Read the snapshot facts below.', code: 'UNAVAILABLE' }, 503);
    const result = await (deps.selector ?? select)(snapshot, body.question, request.signal);
    // Revalidate at the request boundary, including any future selector implementation.
    const allowed = questionFacts(snapshot, body.question);
    if (!result.facts.length || result.facts.length > 3 || new Set(result.facts.map(f => f.id)).size !== result.facts.length || result.facts.some(f => !allowed.some(a => a.id === f.id && a.text === f.text && a.source === f.source))) throw new AnalyticsModelError('VALIDATION');
    return json({ snapshotDigest: snapshot.digest, observedAt: snapshot.observedAt, facts: result.facts, model: result.model, toolsOffered: 0 });
  } catch (error) {
    if (error instanceof AnalyticsAccessError) return json({ error: error.message }, error.status);
    if (error instanceof AnalyticsModelError) return json({ error: 'No verified AI explanation is available. Read the snapshot facts below.', code: error.code }, error.code === 'BUSY' ? 429 : 503);
    return json({ error: 'Snapshot unavailable. No financial action was requested.' }, 503);
  }
}
