import { CLAUDE_NAMES, RETIRED_MODEL_LABEL, type ReceiptAudit } from "../../ai/audit";
import { aiModelLabel } from "../shell-copy";

type Line = { id: string; description: string; amount: string; proposal: { category: string; quote: string } | null };

/**
 * The one model line of a saved suggestion. It names the model from the stored audit (readReceiptAudit), never from the environment, and for a
 * hosted-model record it says the receipt text went to Anthropic. The receipt page shows it once: in the READY header before confirmation and in the
 * "Human confirmation recorded" section after it (IAC-415 PR 4). IAC-416 PR 2: this line and the idle strip below are the provider disclosure for
 * receipt text; every other receipt-page label says "AI" (docs/ASSUMPTIONS.md section 69).
 */
export function aiModelLine(audit: ReceiptAudit | null): string {
  return audit?.provider === "local" ? `Model: ${RETIRED_MODEL_LABEL.model}. This suggestion was saved before AidTrace changed AI models.`
    : audit ? `Model: ${CLAUDE_NAMES[audit.model]}. The receipt text was sent to Anthropic for these suggestions.`
    : "Model: the saved AI record is not recognized, so no provider is named.";
}

/**
 * Presentation only. Names the saved AI suggestion (model, record, count) before the person decides. The per-line suggestions and quotes live once,
 * beside each category choice. It reads stored data, adds no model call and grants no authority.
 * Before any suggestion exists it is a compact strip with a plain in-page link to the Prepare card.
 * A saved suggestion is named from its validated stored audit (readReceiptAudit), never from the
 * environment; the idle strip names the configured model and Anthropic (configuredReceiptAiName), or says AI is off (aiOff).
 * The READY header also carries the one instruction for a new review, "Edit the receipt to request a new review.", after the saved record line and
 * only while the receipt is editable (the editable prop, read from the page's own view, never the environment). The receipt page does not repeat it
 * in the review column (IAC-415 PR 5).
 */
export function AiRecommendation({ lines, ready, audit, configured, aiOff = null, running, prepareHref = null, editable = false }: {
  lines: Line[]; ready: boolean; audit: ReceiptAudit | null; configured: { name: string } | null; aiOff?: string | null; running: boolean; prepareHref?: string | null; editable?: boolean;
}) {
  if (!ready) {
    return <section className="ai-recommendation ai-strip" aria-labelledby="ai-recommendation-title" data-state={running ? "RUNNING" : "NONE"}>
      <p className="eyebrow" id="ai-recommendation-title">AI recommendation</p><span className="ai-tag idle">{running ? "Running" : aiOff ? "AI off" : "Not run yet"}</span>
      <p className="ai-model-line">{aiOff ? `${aiOff} ` : configured ? `Model: ${configured.name}. The receipt text goes to Anthropic. ` : ""}<strong>A person confirms each category.</strong></p>
      {prepareHref && !running && !aiOff && <a className="ai-strip-link" href={prepareHref}>Prepare with AI<span aria-hidden="true"> →</span></a>}
    </section>;
  }
  // Each suggestion and its quote appear once, beside the category choice (ProposalReview or the plain form). This header only counts them.
  const suggested = lines.filter(line => line.proposal && line.proposal.category !== "UNKNOWN").length;
  const record = audit?.provider === "local" ? `earlier model revision ${audit.modelRevision.slice(0, 8)}, prompt ${audit.promptVersion}`
    : audit ? `model ${aiModelLabel(CLAUDE_NAMES[audit.model])}, schema ${audit.schemaVersion}` : null;
  return <section className="ai-recommendation" aria-labelledby="ai-recommendation-title" data-state="READY">
    <div className="ai-recommendation-head"><p className="eyebrow">AI recommendation</p><span className="ai-tag">AI suggested</span></div>
    <h2 id="ai-recommendation-title">{audit?.provider === "local" ? "An earlier AI model suggested categories for this receipt." : audit ? "AI suggested categories for this receipt." : "An AI model suggested categories for this receipt."}</h2>
    <p className="ai-model-line">{aiModelLine(audit)}</p>
    <p className="ai-count">{`Suggested a category for ${suggested} of ${lines.length} ${lines.length === 1 ? "line" : "lines"}.`}</p>
    <p className="ai-limits"><strong>A person confirms each category.</strong> The AI cannot pick funds, approve or pay.</p>
    {record && <p className="ai-audit">Saved record: {record}.</p>}
    {editable && <p className="ai-audit">Edit the receipt to request a new review.</p>}
  </section>;
}
