import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../db/schema";

export function connectDatabase(url: string) {
  const client = postgres(url, { max: 5 });
  return { db: drizzle(client, { schema }), client };
}
export type AppDatabase = ReturnType<typeof connectDatabase>["db"];
let connection: ReturnType<typeof connectDatabase> | undefined;
export function getDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return (connection ??= connectDatabase(url)).db;
}
export async function closeDatabase() { if (connection) { await connection.client.end(); connection = undefined; } }
