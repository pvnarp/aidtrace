import { sql } from "drizzle-orm";
import { loginWindows } from "../../db/schema";
import type { AppDatabase } from "./db";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 3.4): one shared request window for the public gift page.
// It reuses the login_windows table and the same atomic upsert shape as authenticate() in auth.ts, with the fixed key "gift-page".
// A hyphen cannot occur in a valid username (^[a-z][a-z0-9_]{0,31}$), so the key cannot collide with a login.
// Cost: this is a global bound, not a per-client control. No trustworthy client address exists behind the loopback proxy, and
// X-Forwarded-For is spoofable. A flood makes the page answer 429 for everyone for up to a minute. It cannot reveal any gift.
export const GIFT_PAGE_LIMIT_KEY = "gift-page";
export const GIFT_PAGE_LIMIT = 120;
export const GIFT_PAGE_WINDOW_SECONDS = 60;
export async function takeGiftPageSlot(db: AppDatabase): Promise<boolean> {
  const now = new Date();
  const [window] = await db.insert(loginWindows).values({ username: GIFT_PAGE_LIMIT_KEY, attempts: 1, resetsAt: new Date(now.getTime() + GIFT_PAGE_WINDOW_SECONDS * 1000) })
    .onConflictDoUpdate({ target: loginWindows.username, set: {
      attempts: sql`case when ${loginWindows.resetsAt} <= now() then 1 else ${loginWindows.attempts} + 1 end`,
      resetsAt: sql`case when ${loginWindows.resetsAt} <= now() then now() + interval '60 seconds' else ${loginWindows.resetsAt} end`,
    } }).returning();
  return !!window && window.attempts <= GIFT_PAGE_LIMIT;
}
