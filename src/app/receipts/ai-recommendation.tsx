import { CLAUDE_NAMES, RETIRED_MODEL_LABEL, type ReceiptAudit } from "../../ai/audit";
import { CATEGORY_NAMES } from "../../ai/categories";

type Line = { id: string; description: string; amount: string; proposal: { category: string; quote: string } | null };

/**
 * Presentation only. Shows what the saved AI suggestion already says, in one place, before the
 * person decides. It reads stored data, adds no model call and grants no authority.
 * Before any suggestion exists it is a compact strip with a plain in-page link to the Prepare card.
 * A saved suggestion is named from its validated stored audit (readReceiptAudit), never from the
 * environment; the idle strip names the configured Claude model (configuredReceiptAiName), or says AI is off (aiOff).
 */
export function AiRecommendation({ lines, ready, audit, configured, aiOff = null, running, prepareHref = null }: {
  lines: Line[]; ready: boolean; audit: ReceiptAudit | null; configured: { name: string } | null; aiOff?: string | null; running: boolean; prepareHref?: string | null;
}) {
  if (!ready) {
    return <section className="ai-recommendation ai-strip" aria-labelledby="ai-recommendation-title" data-state={running ? "RUNNING" : "NONE"}>
      <p className="eyebrow" id="ai-recommendation-title">AI recommendation</p><span className="ai-tag idle">{running ? "Running" : aiOff ? "AI off" : "Not run yet"}</span>
      <p className="ai-model-line">{aiOff ? `${aiOff} ` : configured ? `${configured.name} through the Claude API: the receipt text goes to Anthropic. ` : ""}<strong>A person confirms each category.</strong></p>
      {prepareHref && !running && !aiOff && <a className="ai-strip-link" href={prepareHref}>Prepare with AI<span aria-hidden="true"> →</span></a>}
    </section>;
  }
  const record = audit?.provider === "local" ? `earlier model revision ${audit.modelRevision.slice(0, 8)}, prompt ${audit.promptVersion}`
    : audit ? `model ${audit.model}, prompt ${audit.promptVersion}` : null;
  return <section className="ai-recommendation" aria-labelledby="ai-recommendation-title" data-state="READY">
    <div className="ai-recommendation-head"><p className="eyebrow">AI recommendation</p><span className="ai-tag">AI suggested</span></div>
    <h2 id="ai-recommendation-title">{audit?.provider === "local" ? "An earlier AI model suggested a category for each line." : audit ? "Claude suggested a category for each line." : "An AI model suggested a category for each line."}</h2>
    <p className="ai-model-line">{audit?.provider === "local" ? `Model: ${RETIRED_MODEL_LABEL.model}. This suggestion was saved before AidTrace moved to Claude.`
      : audit ? `Model: ${CLAUDE_NAMES[audit.model]} through the Claude API. The receipt text was sent to Anthropic for these suggestions.`
      : "Model: the saved AI record is not recognized, so no provider is named."}</p>
    <ul className="ai-suggestions" aria-label="AI suggested categories">{lines.map(line => {
      const proposal = line.proposal && line.proposal.category !== "UNKNOWN" ? line.proposal : null;
      return <li key={line.id}><span className="ai-line">{line.description} <b>{line.amount}</b></span>
        {proposal ? <><span className="ai-category">{CATEGORY_NAMES[proposal.category] ?? proposal.category}</span><q className="ai-quote"><mark>{proposal.quote}</mark></q></> : <span className="ai-category none">No supported category. Choose one yourself.</span>}
      </li>;
    })}</ul>
    <p className="ai-limits"><strong>A person confirms each category.</strong> The AI cannot pick funds, approve or pay.</p>
    {record && <p className="ai-audit">Saved record: {record}.</p>}
  </section>;
}
