import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordPhotoRead } from "../src/receipt/photo-reads";
import { createPolicyDatabase, type PolicyDatabase } from "./support/policy-db";

// IAC-384 prompt v2, PH-76 (docs/GATE_REPORT.md section 75): migration 0022 widens photo_read_versions to v1 and v2 only, on real Postgres. No network, no key, no model.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let ctx: PolicyDatabase; const open: PolicyDatabase[] = [];
beforeEach(async () => { ctx = await createPolicyDatabase("aidtrace_photo_v2"); open.push(ctx); }, 60_000);
afterEach(async () => { while (open.length) await open.pop()!.close(); }, 60_000);

const maria = { id: "maria", organizationId: "cedar-hollow" };
const facts = (promptVersion: string, schemaVersion = "receipt-transcript-v1") => ({ model: "claude-haiku-5-5" as const, promptVersion, schemaVersion, photoSha256: "d".repeat(64), stopReason: "end_turn", inputTokens: 1, outputTokens: 1 });
const rawInsert = (promptVersion: string, schemaVersion: string) => ctx.client.unsafe(`insert into receipt_photo_reads (organization_id, user_id, photo_sha256, model, prompt_version, schema_version, outcome, input_tokens, output_tokens) values ('cedar-hollow','maria','${"e".repeat(64)}','claude-haiku-5-5','${promptVersion}','${schemaVersion}','FAILED',0,0)`);
const count = async () => (await ctx.client.unsafe("select count(*)::int as n from receipt_photo_reads"))[0]!.n as number;

describe("PH-76 photo_read_versions after migration 0022", () => {
  it("accepts a v1 row and a v2 row", async () => {
    await recordPhotoRead(ctx.db, maria, facts("receipt-photo-v1"), "READ", true, "f".repeat(64));
    await recordPhotoRead(ctx.db, maria, facts("receipt-photo-v2"), "READ", true, "f".repeat(64));
    expect(await count()).toBe(2);
    expect((await ctx.client.unsafe("select prompt_version from receipt_photo_reads order by prompt_version")).map(row => row.prompt_version)).toEqual(["receipt-photo-v1", "receipt-photo-v2"]);
  });
  it("rejects receipt-photo-v3 and other prompt versions by photo_read_versions, with the same row accepted at v2", async () => {
    await expect(rawInsert("receipt-photo-v3", "receipt-transcript-v1")).rejects.toThrow(/photo_read_versions/);
    await expect(rawInsert("receipt-photo-v0", "receipt-transcript-v1")).rejects.toThrow(/photo_read_versions/);
    await expect(rawInsert("", "receipt-transcript-v1")).rejects.toThrow(/photo_read_versions/);
    expect(await count()).toBe(0);
    await rawInsert("receipt-photo-v2", "receipt-transcript-v1");
    expect(await count()).toBe(1);
  });
  it("rejects a schema version other than receipt-transcript-v1 by photo_read_versions", async () => {
    await expect(rawInsert("receipt-photo-v2", "receipt-transcript-v2")).rejects.toThrow(/photo_read_versions/);
    await expect(rawInsert("receipt-photo-v1", "receipt-transcript-v2")).rejects.toThrow(/photo_read_versions/);
    expect(await count()).toBe(0);
  });
  it("keeps the table append-only for a v2 row", async () => {
    const id = await recordPhotoRead(ctx.db, maria, facts("receipt-photo-v2"), "READ", true, "f".repeat(64));
    await expect(ctx.client.unsafe(`update receipt_photo_reads set prompt_version = 'receipt-photo-v1' where id = '${id}'`)).rejects.toThrow(/Immutable/);
    await expect(ctx.client.unsafe(`delete from receipt_photo_reads where id = '${id}'`)).rejects.toThrow(/Immutable/);
  });
});
