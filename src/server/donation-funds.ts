import { and, eq } from "drizzle-orm";
import { funds, users } from "../../db/schema";
import { DONATION_RECORDING_ACTOR_ID } from "../donation/orders";
import type { AppDatabase } from "./db";

// The same eligibility rule createDonationOrder enforces: a restricted fund in the recording approver's organization.
export async function eligibleDonationFunds(db: AppDatabase): Promise<{ id: string; name: string }[]> {
  const [actor] = await db.select().from(users).where(eq(users.id, DONATION_RECORDING_ACTOR_ID));
  if (!actor || actor.role !== "APPROVER") return [];
  return db.select({ id: funds.id, name: funds.name }).from(funds).where(and(eq(funds.organizationId, actor.organizationId), eq(funds.fundClass, "RESTRICTED"))).orderBy(funds.name);
}
