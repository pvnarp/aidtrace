"use client";
// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 7, docs/decisions.md "Take the grant as pasted text or a PDF: November 1 IAC-440 D2").
// The "Draft rules from a grant" form. The approver pastes the grant text or picks a PDF. A PDF is sent only to this app's own text route, and the text it holds
// fills the box so the approver can read and edit it. Nothing goes to the model until the approver presses Draft rules, and the button cannot be pressed twice.
// The counter counts code points the way the server does ([...text].length), and the box has no maxLength because a paste would be silently cut.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AiWait } from "../ai-wait";

type Props = { fundId: string; disclosure: string; maxChars: number; maxPdfBytes: number; sample?: string | null };
type Status = { tone: "info" | "warning"; text: string } | null;

const codePoints = (text: string): number => { let count = 0; for (const _ of text) count++; return count; };

export function RulesDraftForm({ fundId, disclosure, maxChars, maxPdfBytes, sample = null }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [reading, setReading] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [ready, setReady] = useState(false);
  const submitting = useRef(false);
  const picker = useRef<HTMLInputElement>(null);

  // The page can come back from the browser's back-forward cache with a stuck pending state. Reset it then.
  useEffect(() => {
    setReady(true);
    const reset = (event: PageTransitionEvent) => { if (event.persisted) { submitting.current = false; setPending(false); } };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  const count = codePoints(text);
  const over = count > maxChars;
  const empty = text.trim().length === 0;

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > maxPdfBytes) { setStatus({ tone: "warning", text: `That file is over ${Math.floor(maxPdfBytes / (1024 * 1024))} MB. Paste the text instead.` }); if (picker.current) picker.current.value = ""; return; }
    setReading(true); setStatus({ tone: "info", text: "Reading the PDF. Nothing is sent to the AI." });
    try {
      const response = await fetch(`/api/funds/${fundId}/rules/pdf-text`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: file, credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      const found = body && typeof body === "object" ? body as { ok?: unknown; text?: unknown; pages?: unknown; message?: unknown } : {};
      if (found.ok === true && typeof found.text === "string") {
        setText(found.text);
        const pages = typeof found.pages === "number" ? found.pages : 0;
        setStatus({ tone: "info", text: `Read ${pages} ${pages === 1 ? "page" : "pages"}. Check the text below and edit it if needed. Nothing was sent to the AI.` });
      } else setStatus({ tone: "warning", text: typeof found.message === "string" ? found.message : "That PDF could not be read. Paste the grant text instead." });
    } catch { setStatus({ tone: "warning", text: "That PDF could not be read. Paste the grant text instead." }); }
    finally { setReading(false); if (picker.current) picker.current.value = ""; }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    // The ref guards a second press before the disabled button has re-rendered.
    if (submitting.current || over || empty || reading) { event.preventDefault(); return; }
    submitting.current = true; setPending(true);
  }

  return <form className="rules-draft-form" method="post" action={`/api/funds/${fundId}/rules/drafts`} onSubmit={submit} data-ready={ready ? "true" : "false"} data-testid="rules-draft-form">
    <div className="rules-sources">
      <input id="rules-grant-pdf" className="rules-file-input" ref={picker} type="file" accept="application/pdf,.pdf" onChange={choose} disabled={pending || reading} aria-describedby="rules-pdf-hint" />
      <label htmlFor="rules-grant-pdf" className="button-link secondary rules-file-label" data-disabled={pending || reading ? "true" : "false"}>Choose a PDF</label>
      {sample !== null && <button type="button" className="secondary" onClick={() => { setText(sample); setStatus({ tone: "info", text: "The sample grant is in the box. Nothing was sent to the AI." }); }} disabled={pending || reading} data-testid="rules-sample">Use the sample grant</button>}
      <p className="muted rules-sources-hint" id="rules-pdf-hint">PDF up to {Math.floor(maxPdfBytes / (1024 * 1024))} MB and 30 pages, with text in it. A scan of paper has no text to read.</p>
    </div>
    {status && <p className={status.tone === "warning" ? "notice warning" : "notice"} role="status" data-testid="rules-pdf-status">{status.text}</p>}
    <div className="rules-field">
      <label htmlFor="rules-grant-text">Grant text</label>
      <p className="muted" id="rules-grant-hint">Paste the part of the grant agreement that sets the rules, or fill this box from a PDF{sample !== null ? " or the sample" : ""}.</p>
      <textarea id="rules-grant-text" name="text" rows={7} value={text} onChange={event => setText(event.target.value)} required aria-describedby="rules-grant-hint rules-grant-count" readOnly={pending} />
      <p className={over ? "rules-count over" : "rules-count"} id="rules-grant-count" aria-live="polite" data-testid="rules-count">{count.toLocaleString("en-US")} of {maxChars.toLocaleString("en-US")} characters{over ? ". That is too long. Paste a shorter part of the grant." : ""}</p>
    </div>
    <div className="rules-submit-row">
      <p className="rules-disclosure" data-testid="rules-form-disclosure">{disclosure}</p>
      <button type="submit" disabled={pending || reading || empty || over} aria-busy={pending} data-testid="rules-draft-submit">{pending ? "Drafting. Keep this page open." : "Draft rules"}</button>
    </div>
    {pending && <><p className="muted" role="status">Drafting can take a minute or more. When it finishes, you will see the draft to review.</p><AiWait /></>}
  </form>;
}
