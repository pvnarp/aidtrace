import { readSeedConfig, seedFixture } from "./fixture";
import { connectDatabase } from "../src/server/db";
import { ensureFixtureOpening } from "../src/ledger/opening";

const config = readSeedConfig(process.env);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { db, client } = connectDatabase(process.env.DATABASE_URL);
try {
  const result = await seedFixture(db, config);
  await db.transaction(tx => ensureFixtureOpening(tx, "cedar-hollow"));
  console.log(`Section 3 fixture ${result}. Users: maria, tara, ben. No passwords or payee details printed.`);
  console.log("Section 7.2 fixture opening journal confirmed. No claim approval or provider request made.");
  if (config.payeeEmail.endsWith(".invalid")) console.log("Fixture-only recipient: PayPal integration remains blocked until a real sandbox recipient is configured.");
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Existing fixture differs") || message.startsWith("Existing credentials differ")) console.error(message);
  else console.error("Fixture seed failed and rolled back. Database parameters and private values withheld.");
  process.exitCode = 1;
} finally { await client.end(); }
