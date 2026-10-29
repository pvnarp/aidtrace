import { connectDatabase } from "/workspace/src/server/db.ts";
import { initializeJudgeSession } from "/workspace/src/server/judge-initialize.ts";
const {db,client}=connectDatabase(process.env.DATABASE_URL);
try {
  const state=await initializeJudgeSession(db,process.env);
  console.log(`Judging session ${state}. Existing financial records preserved. No provider request.`);
} catch {
  console.error("Judging initialization refused. Preserve this database/configuration for review; do not reset or reseed it.");
  process.exitCode=1;
} finally { await client.end(); }
