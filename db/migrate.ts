import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connectDatabase } from "../src/server/db";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const { db, client } = connectDatabase(url);
try {
  await migrate(db, { migrationsFolder: "db/migrations" });
  console.log("Database migrations applied. No fixture data or journal entries were created.");
} finally { await client.end(); }
