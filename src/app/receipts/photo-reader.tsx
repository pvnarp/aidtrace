"use client";
// IAC-384 (docs/ASSUMPTIONS.md section 83). The receipt photo control. The chosen photo goes to this app's own photo route once, and the transcript that comes back
// fills the draft form beside it. The preview is the browser's own copy of the file (an object URL): the server never sends the image back. Program and the
// sample-data checkbox stay for the person, and nothing is submitted until the person presses Create receipt draft.
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { PHOTO_CONTROL_LABEL, PHOTO_FAILED, PHOTO_HINT, PHOTO_PREVIEW_ALT, PHOTO_SOURCE_LABEL, PHOTO_SOURCE_LABEL_TYPED, photoPrintedDate } from "./photo-copy";

type Prefill = { vendor: string; incurredOn: string | null; lines: { description: string; amount: string }[]; total: string; source: string };
type Status = { tone: "info" | "warning"; text: string; extra?: string; note?: string; poweredBy?: string } | null;
const MAX_BYTES = 3_750_000;
const TYPES = ["image/jpeg", "image/png", "image/webp"];

// Setting a value on an uncontrolled input is enough: the form posts what the inputs hold.
const put = (id: string, value: string) => { const field = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null; if (field) field.value = value; };

// Text only, through textContent: a printed date is the model's text and is never markup. The label and the printed-date note live in the server-rendered form.
const words = (id: string, text: string | null) => { const node = document.getElementById(id); if (node) { node.textContent = text ?? ""; node.hidden = text === null; } };

// poweredBy is the "Powered by" line for the model a read will use (built on the server from the configured model id). After a read, the line the server returns for the model that read the photo replaces it.
export function PhotoReader({ poweredBy = "" }: { poweredBy?: string }) {
  const [status, setStatus] = useState<Status>(null);
  const [reading, setReading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function fill(prefill: Prefill, readId: string, datePrinted: string) {
    put("vendor", prefill.vendor);
    // A printed date the form cannot hold is cleared, not left at the example date: the field is required, so a person has to enter it. The printed text stays beside it.
    put("incurredOn", prefill.incurredOn ?? ""); words("printedDate", prefill.incurredOn ? null : photoPrintedDate(datePrinted));
    for (let index = 1; index <= 12; index++) {
      const line = prefill.lines[index - 1];
      put(`description${index}`, line?.description ?? ""); put(`amount${index}`, line?.amount ?? "");
      const group = document.getElementById(`description${index}`)?.closest("fieldset");
      if (group && group.hasAttribute("data-extra-line")) group.hidden = !line;
    }
    put("total", prefill.total); put("source", prefill.source); put("photoReadId", readId); words("sourceLabel", PHOTO_SOURCE_LABEL);
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    put("photoReadId", ""); words("sourceLabel", PHOTO_SOURCE_LABEL_TYPED);
    if (!TYPES.includes(file.type) || file.size > MAX_BYTES) { setStatus({ tone: "warning", text: PHOTO_FAILED }); return; }
    setReading(true); setStatus({ tone: "info", text: "Reading the photo." });
    try {
      const response = await fetch("/api/receipts/photo-text", { method: "POST", headers: { "Content-Type": file.type }, body: file, credentials: "same-origin" });
      const body: unknown = await response.json().catch(() => null);
      const found = body && typeof body === "object" ? body as { ok?: unknown; readId?: unknown; notice?: unknown; mismatch?: unknown; note?: unknown; poweredBy?: unknown; prefill?: Prefill; transcript?: { datePrinted?: unknown } } : {};
      if (found.ok === true && typeof found.readId === "string" && found.prefill && typeof found.notice === "string") {
        fill(found.prefill, found.readId, typeof found.transcript?.datePrinted === "string" ? found.transcript.datePrinted : "");
        setStatus({ tone: typeof found.mismatch === "string" ? "warning" : "info", text: found.notice, extra: typeof found.mismatch === "string" ? found.mismatch : undefined, note: typeof found.note === "string" ? found.note : undefined, poweredBy: typeof found.poweredBy === "string" && found.poweredBy.startsWith("Powered by ") ? found.poweredBy : undefined });
      } else setStatus({ tone: "warning", text: PHOTO_FAILED });
    } catch { setStatus({ tone: "warning", text: PHOTO_FAILED }); }
    finally { setReading(false); }
  }

  return <section className="photo-reader" aria-labelledby="photo-reader-title" data-testid="photo-reader">
    <h2 id="photo-reader-title">{PHOTO_CONTROL_LABEL}</h2>
    <p className="muted" id="photo-reader-hint">{PHOTO_HINT}</p>
    {(status?.poweredBy ?? poweredBy) && <p className="muted" data-testid="photo-powered-by">{status?.poweredBy ?? poweredBy}</p>}
    <input id="photo-input" ref={picker} type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} disabled={reading} aria-describedby="photo-reader-hint" data-testid="photo-input" />
    {status && <div className={status.tone === "warning" ? "notice warning" : "notice"} role="status" data-testid="photo-status"><p>{status.text}</p>{status.extra && <p data-testid="photo-mismatch">{status.extra}</p>}{status.note && <p data-testid="photo-note">{status.note}</p>}</div>}
    {preview && <figure className="photo-preview"><img src={preview} alt={PHOTO_PREVIEW_ALT} data-testid="photo-preview" /></figure>}
  </section>;
}
