// IAC-384 (docs/ASSUMPTIONS.md section 83): at most 10 photo reads per user in a rolling hour, counted in memory.
// Cost, named: the count is per server process and a restart forgets it, so it is a brake on a loop or a script, not an account quota. The process-wide Claude
// request cap in src/ai/budget.ts stays the hard limit. Every request that passes the role check takes a slot, including one later refused for size or type.
export const PHOTO_READS_PER_HOUR = 10;
export const PHOTO_WINDOW_MS = 60 * 60 * 1000;
export type PhotoRateLimiter = { take(userId: string, now?: number): boolean };
export function createPhotoRateLimiter(limit: number = PHOTO_READS_PER_HOUR, windowMs: number = PHOTO_WINDOW_MS): PhotoRateLimiter {
  const taken = new Map<string, number[]>();
  return { take(userId, now = Date.now()) {
    const recent = (taken.get(userId) ?? []).filter(at => now - at < windowMs);
    if (recent.length >= limit) { taken.set(userId, recent); return false; }
    recent.push(now); taken.set(userId, recent); return true;
  } };
}
export const processPhotoRateLimiter: PhotoRateLimiter = createPhotoRateLimiter();
