import type { QuoteEvidence } from "./quote-evidence";

// modelLabel comes from the stored suggestion audit (src/ai/audit.ts), never from the environment.
export function ReceiptEvidence({ evidence, modelLabel }: { evidence: QuoteEvidence; modelLabel: string | null }) {
  return <aside className="receipt-evidence" aria-labelledby="receipt-evidence-title">
    <p className="eyebrow">Saved receipt text</p><h2 id="receipt-evidence-title">Your saved receipt.</h2>
    <pre className="receipt-source">{evidence.segments.map((segment, index) => segment.lineId ?
      <mark id={`receipt-source-${segment.lineId}`} tabIndex={-1} key={index} aria-label={`Source quote for ${segment.lineId}`}>{segment.text}</mark> : segment.text)}</pre>
    <p>{evidence.grounded ? "Highlighted quotes match this saved receipt. Check whether each suggested category is right." : "No current validated highlights. Read the saved text and choose categories manually when needed."}</p>
    <p className="muted">{modelLabel ? `${modelLabel}. ` : "No AI suggestion is saved yet. A saved suggestion names its model here. "}Text in, category suggestions out. No PayPal tools or approval access.</p>
  </aside>;
}
