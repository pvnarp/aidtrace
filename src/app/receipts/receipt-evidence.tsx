import type { QuoteEvidence } from "./quote-evidence";

// modelLabel is null before any suggestion, "" when another line on the page already names the model, otherwise a whole sentence from the stored suggestion audit (src/ai/audit.ts), never from the environment: "Powered by <model>." for a named model. photoPoweredBy is the same
// kind of line for the photo read row, and is empty when the draft was typed.
export function ReceiptEvidence({ evidence, modelLabel, photoLine = null, photoPoweredBy = "" }: { evidence: QuoteEvidence; modelLabel: string | null; photoLine?: string | null; photoPoweredBy?: string }) {
  return <aside className="receipt-evidence" aria-labelledby="receipt-evidence-title">
    <p className="eyebrow">Saved receipt text</p><h2 id="receipt-evidence-title">Your saved receipt.</h2>
    {photoLine && <p className="photo-evidence" data-testid="photo-evidence">{photoLine}</p>}
    {photoLine && photoPoweredBy && <p className="muted" data-testid="photo-powered-by">{photoPoweredBy}</p>}
    <pre className="receipt-source">{evidence.segments.map((segment, index) => segment.lineId ?
      <mark id={`receipt-source-${segment.lineId}`} tabIndex={-1} key={index} aria-label={`Source quote for ${segment.lineId}`}>{segment.text}</mark> : segment.text)}</pre>
    <p>{evidence.grounded ? "Highlighted quotes match this saved receipt. Check whether each suggested category is right." : "No current validated highlights. Read the saved text and choose categories manually when needed."}</p>
    <p className="muted">{modelLabel === null ? "No AI suggestion is saved yet. A saved suggestion names its model here. " : modelLabel ? `${modelLabel} ` : ""}Text in, category suggestions out. No PayPal tools or approval access.</p>
  </aside>;
}
