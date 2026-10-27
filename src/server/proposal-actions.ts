import { findSession, isSameOrigin, sessionToken } from "./auth";
import type { AppDatabase } from "./db";
import { localReceiptCategorizer, ReceiptAiError, type createReceiptCategorizer } from "../ai/receipt";
import { prepareExpenseProposal, readExpenseProposal } from "../proposal/service";

export async function handleExpenseProposal(request: Request, id: string, deps: { db: AppDatabase; categorize?: ReturnType<typeof createReceiptCategorizer>; env?: Record<string, string | undefined> }) {
  const headers = { "Cache-Control": "no-store" };
  if ((deps.env ?? process.env).AI_EXPENSE_PROPOSALS_ENABLED !== "true") return new Response("Expense preparation is not enabled", { status: 404, headers });
  if (!["GET", "POST"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers });
  if (request.method === "POST" && !isSameOrigin(request)) return new Response("Request origin rejected", { status: 403, headers });
  const actor = await findSession(sessionToken(request), deps.db);
  if (!actor) return new Response("Sign in first", { status: 401, headers });
  if (actor.role !== "CLAIMANT") return new Response("Claimant access required", { status: 403, headers });
  try { await readExpenseProposal(deps.db, id, actor.id); } catch { return new Response("Receipt not found", { status: 404, headers }); }
  if (request.method === "GET") return Response.json(await readExpenseProposal(deps.db, id, actor.id), { headers });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("Form submission required", { status: 415, headers });
  const reader = request.body?.getReader(); if (!reader) return new Response("Missing form", { status: 400, headers });
  const chunks: Uint8Array[] = []; let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 4096) { await reader.cancel(); return new Response("Form too large", { status: 413, headers }); } chunks.push(value); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const fields = ["action", "reviewId", "draftHash", "suggestionHash", "runHash"];
  if (form.get("action") !== "prepare" || fields.some(key => form.getAll(key).length !== 1) || [...form.keys()].some(key => !fields.includes(key))) return new Response("Invalid preparation fields", { status: 400, headers });
  const categorize = deps.categorize ?? ((deps.env ?? process.env).AI_RECEIPT_ENABLED === "true" ? localReceiptCategorizer : async () => { throw new ReceiptAiError("UNAVAILABLE"); });
  try {
    const result = await prepareExpenseProposal(deps.db, id, actor.id, { reviewId: form.get("reviewId")!, draftHash: form.get("draftHash")!, suggestionHash: form.get("suggestionHash")!, runHash: form.get("runHash")! }, categorize);
    return Response.json(result, { status: result.run?.state === "RUNNING" ? 202 : 200, headers });
  } catch { return Response.json({ error: "Review changed. Reload the receipt and review again.", financialAction: false }, { status: 409, headers }); }
}
