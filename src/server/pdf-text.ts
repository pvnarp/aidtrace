// IAC-440 Package B (docs/plans/AI_DRAFTED_RULES_SCOPE.md section 7, docs/decisions.md "Take the grant as pasted text or a PDF: November 1 IAC-440 D2",
// docs/ASSUMPTIONS.md section 72). Text out of an uploaded PDF, for the approver to read and edit before anything is sent to the model.
// The bytes arrive from an approver-only route that has already enforced the size cap while streaming. This module does the rest: the %PDF- magic check,
// the encryption check, the page cap (read before any page is parsed), the character cap (reading stops the moment the text passes the cap),
// a wall-clock budget between pages and a one-at-a-time gate. It stores nothing, sends nothing, and returns a code, never a library message.
//
// The parser is unpdf 1.9.1, which bundles pdf.js (see docs/ASSUMPTIONS.md section 72 for the license, script and native-binary evidence). pdf.js is told
// not to use eval, not to build font faces, not to use system fonts, not to read XFA, not to stream or range-fetch, and is given no font, cmap or wasm
// URL, so it has nothing to fetch. Scripting is a viewer feature: the API never runs a PDF action.
// Residual risk, named: pdf.js has no CPU cap. A hostile file inside the byte and page caps can still occupy this process for one page's worth of work.
// The budget below is checked between pages only.
import { getDocumentProxy } from "unpdf";

export const PDF_MAX_BYTES = 2 * 1024 * 1024;
export const PDF_MAX_PAGES = 30;
export const PDF_TIME_BUDGET_MS = 10_000;

export type PdfRefusal = "NOT_PDF" | "ENCRYPTED" | "MALFORMED" | "TOO_MANY_PAGES" | "NO_TEXT" | "TOO_LONG" | "TOO_SLOW" | "BUSY";
export type PdfTextResult = { ok: true; text: string; pages: number } | { ok: false; code: PdfRefusal };
export type PdfTextOptions = { maxCodePoints: number; maxPages?: number; budgetMs?: number; now?: () => number };

// "%PDF-" at byte zero. The specification tolerates a header up to 1024 bytes in, and this refuses that on purpose: a file that does not start as a PDF is not one.
const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
export const hasPdfMagic = (bytes: Uint8Array): boolean => bytes.length >= MAGIC.length && MAGIC.every((byte, index) => bytes[index] === byte);

// The trailer (or the cross-reference stream dictionary) of an encrypted file names /Encrypt in plain text. A file that opens with an empty password would
// otherwise be read, and the scope says an encrypted PDF is refused. A false hit refuses a file that only mentions the word, which fails safe.
const ENCRYPT = Buffer.from("/Encrypt");
const isEncrypted = (bytes: Uint8Array): boolean => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(ENCRYPT);

// Everything that makes pdf.js reach outside the bytes it was given, or run something, is off. useSystemFonts false keeps the extraction independent of
// the host. No standardFontDataUrl, cMapUrl or wasmUrl is given, so there is no URL to fetch: a font or cmap that needs one fails and the file is refused.
const PARSER_OPTIONS = {
  isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false, disableAutoFetch: true, disableStream: true, disableRange: true,
  stopAtErrors: true, useWorkerFetch: false, verbosity: 0,
} as const;

let active = 0;
const clean = (text: string): string => text
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")
  .toWellFormed().trim();
const countCodePoints = (text: string): number => { let count = 0; for (const _ of text) count++; return count; };

type TextChunk = { items: ({ str?: string; hasEOL?: boolean } | { type: string })[] };

export async function extractPdfText(bytes: Uint8Array, options: PdfTextOptions): Promise<PdfTextResult> {
  if (!hasPdfMagic(bytes)) return { ok: false, code: "NOT_PDF" };
  if (isEncrypted(bytes)) return { ok: false, code: "ENCRYPTED" };
  // One extraction at a time per process, so repeated uploads cannot stack CPU work.
  if (active >= 1) return { ok: false, code: "BUSY" };
  active++;
  const maxPages = options.maxPages ?? PDF_MAX_PAGES, now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? PDF_TIME_BUDGET_MS);
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // pdf.js may detach the buffer it is given, so it gets a copy.
    document = await getDocumentProxy(new Uint8Array(bytes), { ...PARSER_OPTIONS });
    const pages = document.numPages;
    if (!Number.isInteger(pages) || pages < 1) return { ok: false, code: "MALFORMED" };
    // The page cap comes before any page is parsed or any text is read.
    if (pages > maxPages) return { ok: false, code: "TOO_MANY_PAGES" };
    const parts: string[] = [];
    for (let number = 1; number <= pages; number++) {
      if (now() > deadline) return { ok: false, code: "TOO_SLOW" };
      const page = await document.getPage(number);
      const reader = page.streamTextContent().getReader();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const item of (value as TextChunk).items) if ("str" in item && typeof item.str === "string") text += item.str + (item.hasEOL ? "\n" : "");
        // Stop reading the moment the cleaned text is past the cap, so the rest of a very long page is never read. The probe is cleaned the same way
        // the result is, and cleaning never makes the text longer, so a text that ends within the cap is never refused here.
        // reader.cancel() is not used: pdf.js then closes a stream that is already closed and raises an unhandled rejection. Releasing the lock and destroying the document in finally ends the work cleanly.
        if (countCodePoints(clean([...parts, text].join("\n\n"))) > options.maxCodePoints) { reader.releaseLock(); return { ok: false, code: "TOO_LONG" }; }
      }
      page.cleanup();
      parts.push(text);
    }
    const text = clean(parts.join("\n\n"));
    if (text.length === 0) return { ok: false, code: "NO_TEXT" };
    if (countCodePoints(text) > options.maxCodePoints) return { ok: false, code: "TOO_LONG" };
    return { ok: true, text, pages };
  } catch (error) {
    // Only the exception name is read, never its message, which can echo file content. A password request is the one case that gets its own code.
    return { ok: false, code: error instanceof Error && error.name === "PasswordException" ? "ENCRYPTED" : "MALFORMED" };
  } finally {
    active--;
    if (document) await document.loadingTask.destroy().catch(() => undefined);
  }
}
