// IAC-440 Package B (docs/ASSUMPTIONS.md section 72). Which restricted funds of the signed-in approver's organization the home page may link to the rules screen.
// The home fund row knows only a fund's name (the pinned meter has no id), so the link is found by name. A name that two restricted funds share gets no link,
// which fails closed. Nothing is returned for a claimant or a signed-out visitor. The result is cached for one request.
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { funds, users } from "../../db/schema";
import { findSession, SESSION_COOKIE } from "./auth";
import { getDatabase } from "./db";

const restrictedFundIdsByName = cache(async (): Promise<Map<string, string[]> | null> => {
  const user = await findSession((await cookies()).get(SESSION_COOKIE)?.value);
  if (!user || user.role !== "APPROVER") return null;
  const rows = await getDatabase().select({ id: funds.id, name: funds.name }).from(funds).innerJoin(users, eq(users.organizationId, funds.organizationId))
    .where(and(eq(users.id, user.id), eq(funds.fundClass, "RESTRICTED")));
  const byName = new Map<string, string[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row.id]);
  return byName;
});

/** The rules page path for a restricted fund of the viewer's organization, or null (not an approver, not restricted, not found, or an ambiguous name). */
export async function fundRulesPath(name: string): Promise<string | null> {
  try {
    const ids = (await restrictedFundIdsByName())?.get(name);
    return ids && ids.length === 1 && /^[A-Za-z0-9_-]{1,64}$/.test(ids[0]!) ? `/funds/${ids[0]}/rules` : null;
  } catch { return null; }
}
