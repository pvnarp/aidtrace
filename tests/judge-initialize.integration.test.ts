import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, test } from "vitest";
import postgres from "postgres";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";
import { initializeJudgeSession } from "../src/server/judge-initialize";
import { createReceiptDraft } from "../src/receipt/service";
import * as s from "../db/schema";
let admin: ReturnType<typeof postgres>, connection: ReturnType<typeof connectDatabase>, name: string;
const env = { AIDTRACE_JUDGE_SESSION: "true", APP_ORIGIN: "http://127.0.0.1:3190", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_SANDBOX_PAYEE_EMAIL: "judge@example.invalid", PAYEE_ALLOWLIST: "judge@example.invalid", SEED_PASSWORD_MARIA: "synthetic-maria-secret", SEED_PASSWORD_TARA: "synthetic-tara-secret", SEED_PASSWORD_BEN: "synthetic-ben-secret" };
beforeEach(async () => { const url=new URL(process.env.DATABASE_URL!);url.pathname="/postgres";admin=postgres(url.toString(),{max:1});name="aidtrace_judge_init_"+randomBytes(6).toString("hex");await admin`create database ${admin(name)}`;url.pathname="/"+name;connection=connectDatabase(url.toString());await migrate(connection.db,{migrationsFolder:"db/migrations"}); });
afterEach(async () => { await connection?.client.end();if (/^aidtrace_judge_init_[a-f0-9]{12}$/.test(name)) await admin`drop database ${admin(name)} with (force)`;await admin?.end(); });
test("initialization binds a new database; restart preserves a later receipt and rejects another configuration", async () => {
  expect(await initializeJudgeSession(connection.db,env)).toBe("INITIALIZED");
  const id=await createReceiptDraft(connection.db,"maria",{vendor:"Fictional",program:"robotics",incurredOn:"2026-10-14",source:"Notebook",total:"2.00",lines:[{description:"Notebook",amount:"2.00"}]},env.PAYPAL_SANDBOX_PAYEE_EMAIL,true);
  const before=await connection.db.select().from(s.claims);const journal=await connection.db.select().from(s.journalEntries);
  expect(await initializeJudgeSession(connection.db,env)).toBe("RETAINED");expect(await connection.db.select().from(s.claims)).toEqual(before);expect(await connection.db.select().from(s.journalEntries)).toEqual(journal);expect(before.some(row=>row.id===id)).toBe(true);
  await expect(initializeJudgeSession(connection.db,{...env,SEED_PASSWORD_MARIA:"different-session-secret"})).rejects.toThrow("Session binding differs");
  expect(await connection.db.select().from(s.claims)).toEqual(before);
});
test("unbound existing work is refused rather than adopted or overwritten", async () => {
  await initializeJudgeSession(connection.db,env);
  await createReceiptDraft(connection.db,"maria",{vendor:"Keep me",program:"robotics",incurredOn:"2026-10-14",source:"Notebook",total:"2.00",lines:[{description:"Notebook",amount:"2.00"}]},env.PAYPAL_SANDBOX_PAYEE_EMAIL,true);
  await admin.unsafe(`comment on database "${name}" is null`);
  const before=await connection.db.select().from(s.claims);
  await expect(initializeJudgeSession(connection.db,env)).rejects.toThrow("Existing fixture differs");
  expect(await connection.db.select().from(s.claims)).toEqual(before);
});
