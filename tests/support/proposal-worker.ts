import { connectDatabase } from "../../src/server/db";
import { prepareExpenseProposal, type PreparationTerms } from "../../src/proposal/service";
import { validateProposals, PROMPT_VERSION } from "../../src/ai/receipt";
import { digest } from "../../src/receipt/terms";
import lock from "../../ai/model-lock.json";
const connection = connectDatabase(process.env.DATABASE_URL!);
process.once("message", async (message: { id: string; terms: PreparationTerms; hold: boolean }) => {
  try {
    const result = await prepareExpenseProposal(connection.db, message.id, "maria", message.terms, async input => {
      process.send?.({ started: true });
      if (message.hold) await new Promise<void>(resolve => process.once("message", () => resolve()));
      return { proposals: validateProposals(input, { proposals: [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit" }] }),
        audit: { sourceSha256: digest(input.source), requestSha256: "a".repeat(64), responseSha256: "b".repeat(64), promptVersion: PROMPT_VERSION, modelSha256: lock.modelSha256, modelRevision: lock.modelRevision, latencyMs: 1 } };
    });
    process.send?.({ result });
  } catch { process.send?.({ error: true }); process.exitCode = 1; }
  finally { await connection.client.end(); process.disconnect(); }
});
