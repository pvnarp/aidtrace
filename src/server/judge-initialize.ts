import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { readSeedConfig, seedFixture } from "../../db/fixture";
import { ensureFixtureOpening } from "../ledger/opening";
import type { AppDatabase } from "./db";
import { judgeSession } from "./judge-mode";

/** CLI-only lifecycle metadata. Never invoked by a request or payment workflow. */
export async function initializeJudgeSession(db: AppDatabase, env: Readonly<Record<string, string | undefined>>) {
  if (!judgeSession(env) || env.PAYPAL_CLIENT_ID || env.PAYPAL_CLIENT_SECRET) throw Error("Non-payable judge configuration required");
  const config = readSeedConfig(env);
  if (!config.payeeEmail.endsWith(".invalid")) throw Error("Non-payable judge recipient required");
  const marker = "aidtrace-judge-v1:" + createHash("sha256").update(JSON.stringify({ origin: env.APP_ORIGIN, payee: config.payeeEmail, passwords: config.passwords })).digest("hex");
  const rows = await db.execute(sql`select current_database() as name, shobj_description(oid, 'pg_database') as marker from pg_database where datname=current_database()`);
  const row = rows[0];
  if (row?.marker) {
    if (row.marker !== marker) throw Error("Session binding differs; preserve the database and use its original configuration");
    return "RETAINED" as const;
  }
  // Unmarked nonempty databases must pass the original strict seed guard. Never reset them.
  await seedFixture(db, config);
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  if (typeof row?.name !== "string" || !/^[a-z][a-z0-9_]{1,62}$/.test(row.name)) throw Error("Expected isolated database name");
  // COMMENT accepts literals, not bind parameters. Both inputs above are narrowly validated.
  await db.execute(sql.raw(`comment on database "${row.name}" is '${marker}'`));
  return "INITIALIZED" as const;
}
