import type { AppDatabase } from "./db";
import { findSession, isSameOrigin, sessionToken } from "./auth";
import { defaultReceiptCategorizer } from "../ai/provider";
import type { AnyReceiptCategorizer } from "../ai/audit";
import { configuredReceiptPayee, createReceiptDraft, editReceiptDraft, readReceiptView, suggestReceipt, confirmReceipt } from "../receipt/service";
import type { DraftInput } from "../receipt/terms";
import { judgeSession } from "./judge-mode";
export async function handleReceiptAction(request: Request, id: string | null, deps: { db: AppDatabase; categorize?: AnyReceiptCategorizer; env?: Record<string, string | undefined> }) {
  const headers = { "Cache-Control": "no-store" };
  if (!isSameOrigin(request)) return new Response("Request origin rejected", { status: 403, headers });
  const user = await findSession(sessionToken(request), deps.db);
  if (!user) return new Response("Sign in first", { status: 401, headers });
  if (user.role !== "CLAIMANT") return new Response("Claimant access required", { status: 403, headers });
  if (id) { try { await readReceiptView(deps.db, id, user.id); } catch { return new Response("Receipt not found", { status: 404, headers }); } }
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return new Response("Form submission required", { status: 415, headers });
  const reader = request.body?.getReader(); if (!reader) return new Response("Missing form", { status: 400, headers });
  let length = 0; const chunks: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 131072) { await reader.cancel(); return new Response("Form too large", { status: 413, headers }); } chunks.push(value); }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const action = form.get("action");
  const fields = action === "create" || action === "edit" ? ["vendor", "program", "incurredOn", "source", "total", "syntheticReceipt", ...Array.from({ length: 12 }, (_, i) => [`description${i + 1}`, `amount${i + 1}`]).flat()] : action === "confirm" ? ["suggestionId", "suggestionHash", "confirm", ...Array.from({ length: 12 }, (_, i) => [`categoryL${i + 1}`, `reasonL${i + 1}`]).flat()] : action === "suggest" ? ["suggestionHash"] : [];
  const allowed = new Set(["action", "reviewId", "draftHash", ...fields]);
  if ([...form.keys()].some(key => !allowed.has(key) || form.getAll(key).length !== 1)) return new Response("Unexpected or repeated field", { status: 400, headers });
  const destination = (claimId: string, notice: string) => new Response(null, { status: 303, headers: { ...headers, Location: `/claims/${claimId}/receipt?notice=${notice}` } });
  try {
    if (action === "create" || action === "edit") {
      if (form.get("syntheticReceipt") !== "yes") throw new Error("Synthetic receipt confirmation required");
      const input: DraftInput = { vendor: form.get("vendor") ?? "", program: form.get("program") ?? "", incurredOn: form.get("incurredOn") ?? "", source: form.get("source") ?? "", total: form.get("total") ?? "", lines: [] };
      for (let i = 1; i <= 12; i++) { const description = form.get(`description${i}`) ?? ""; const amount = form.get(`amount${i}`) ?? ""; if (description || amount) input.lines.push({ description, amount }); }
      if (!id && action === "create") return destination(await createReceiptDraft(deps.db, user.id, input, configuredReceiptPayee(deps.env ?? process.env), judgeSession(deps.env ?? process.env)), "created");
      if (id && action === "edit") { await editReceiptDraft(deps.db, id, user.id, form.get("reviewId") ?? "", form.get("draftHash") ?? "", input); return destination(id, "edited"); }
      throw new Error("Wrong action");
    }
    if (!id) throw new Error("Receipt required");
    const reviewId = form.get("reviewId") ?? ""; const hash = form.get("draftHash") ?? "";
    if (action === "suggest") {
      const categorize = deps.categorize ?? defaultReceiptCategorizer(deps.env ?? process.env);
      const result = await suggestReceipt(deps.db, id, user.id, reviewId, hash, categorize, form.get("suggestionHash") ?? "");
      return destination(id, result === null ? "running" : result ? "suggested" : "manual");
    }
    if (action === "confirm") {
      if (form.get("confirm") !== "yes") throw new Error("Explicit confirmation required");
      const view = await readReceiptView(deps.db, id, user.id);
      await confirmReceipt(deps.db, id, user.id, reviewId, hash, form.get("suggestionId") || null, form.get("suggestionHash") ?? "",
        view.lines.map(line => ({ lineId: line.id, category: form.get(`category${line.id}`) ?? "", reason: form.get(`reason${line.id}`) ?? "" })));
      return destination(id, "confirmed");
    }
    throw new Error("Unknown action");
  } catch {
    if (id) return destination(id, "review-changed");
    return new Response("This form is invalid. Check the receipt fields and total. No draft or payment was requested.", { status: 409, headers });
  }
}
