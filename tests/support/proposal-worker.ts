import { connectDatabase } from "../../src/server/db";
import { prepareExpenseProposal, type PreparationTerms } from "../../src/proposal/service";
import { cannedCategorizer } from "./claude-stub";
const connection = connectDatabase(process.env.DATABASE_URL!);
const classify = cannedCategorizer(() => [{ lineId: "L1", category: "robot_kits_parts", quote: "Science experiment kit" }]);
process.once("message", async (message: { id: string; terms: PreparationTerms; hold: boolean }) => {
  try {
    const result = await prepareExpenseProposal(connection.db, message.id, "maria", message.terms, async input => {
      process.send?.({ started: true });
      if (message.hold) await new Promise<void>(resolve => process.once("message", () => resolve()));
      return classify(input);
    });
    process.send?.({ result });
  } catch { process.send?.({ error: true }); process.exitCode = 1; }
  finally { await connection.client.end(); process.disconnect(); }
});
