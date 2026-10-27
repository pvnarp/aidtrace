import postgres from "postgres";

export const dynamic = "force-dynamic";
export async function GET() {
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://aidtrace@db:5432/aidtrace", { max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    return Response.json({ service: "aidtrace", database: "reachable", scope: "infrastructure-only" });
  } catch {
    return Response.json({ service: "aidtrace", database: "unavailable" }, { status: 503 });
  } finally {
    await sql.end();
  }
}
