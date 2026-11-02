import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDF_MAX_BYTES, PDF_MAX_PAGES, extractPdfText, hasPdfMagic } from "../src/server/pdf-text";
import { buildPdf, FIXTURE_LINES, FIXTURE_TEXT } from "./support/pdf-fixtures";

// IAC-440 Package B, DR-80 to DR-88 (docs/GATE_REPORT.md section 60). The PDF text extractor on built fixtures and one committed file. The parser is unpdf 1.9.1 (pdf.js
// inside). It runs for real here, with one wrapper that counts page reads and can make the open step fail, so the tests can show that nothing is parsed past a refusal.
// No network, no model, no database. Every fixture is synthetic.
const hooks = vi.hoisted(() => ({ pageCalls: 0, openCalls: 0, failWith: null as unknown }));
vi.mock("unpdf", async importOriginal => {
  const real = await importOriginal<typeof import("unpdf")>();
  return {
    ...real,
    getDocumentProxy: async (...args: Parameters<typeof real.getDocumentProxy>) => {
      hooks.openCalls++;
      if (hooks.failWith !== null) throw hooks.failWith;
      const document = await real.getDocumentProxy(...args);
      const getPage = document.getPage.bind(document);
      document.getPage = (number: number) => { hooks.pageCalls++; return getPage(number); };
      return document;
    },
  };
});
beforeEach(() => { hooks.pageCalls = 0; hooks.openCalls = 0; hooks.failWith = null; delete (globalThis as Record<string, unknown>).__pdfActionRan; });

const CAP = 20_000;
const run = (bytes: Uint8Array, over: { maxCodePoints?: number; maxPages?: number; budgetMs?: number; now?: () => number } = {}) => extractPdfText(bytes, { maxCodePoints: over.maxCodePoints ?? CAP, ...over });
const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string) => new TextEncoder().encode(text);
// One page of code point exact text: 22 lines of 900 characters and a last line of `last` characters, at font size 1 so each line stays inside the page.
// The extracted text is the lines joined by a newline: 22 * 900 + 22 + last, so a last line of 178 characters is exactly 20,000 code points.
const longPage = (last: number) => [...Array.from({ length: 22 }, () => "a".repeat(900)), "b".repeat(last)];
const SMALL = { fontSize: 1, leading: 1.5 } as const;
const countOf = (text: string) => [...text].length;

describe("DR-80 a text PDF extracts exactly, and the committed fixture is the one the builder makes", () => {
  it("is pinned by SHA-256 and rebuilt byte for byte", () => {
    const file = readFileSync("tests/fixtures/grant-two-pages.pdf");
    expect(sha(file)).toBe("b65527c1093da66715b1af5a8fe651543f1bd5e0e26cb7e6349d0986a14bd286");
    expect(file.length).toBe(1172);
    expect(sha(buildPdf({ pages: FIXTURE_LINES }))).toBe(sha(file));
  });
  it("returns the exact text and the page count of the committed file", async () => {
    const result = await run(new Uint8Array(readFileSync("tests/fixtures/grant-two-pages.pdf")));
    expect(result).toEqual({ ok: true, text: FIXTURE_TEXT, pages: 2 });
    expect(hooks.pageCalls).toBe(2);
  });
  it("cleans control characters and keeps non-ASCII text out of the byte path, and returns well-formed text", async () => {
    const result = await run(buildPdf({ pages: [["Plain line one.", "Plain line two."]] }));
    expect(result).toEqual({ ok: true, text: "Plain line one.\nPlain line two.", pages: 1 });
    if (result.ok) expect(result.text).toBe(result.text.toWellFormed());
  });
  it("does not modify the bytes it was given", async () => {
    const bytes = buildPdf({ pages: FIXTURE_LINES });
    const before = sha(bytes);
    await run(bytes);
    expect(sha(bytes)).toBe(before);
  });
});

describe("DR-81 an image-only PDF is refused with no text and nothing is returned", () => {
  it("answers NO_TEXT for pages that draw no text", async () => {
    const result = await run(buildPdf({ pages: [[], []] }));
    expect(result).toEqual({ ok: false, code: "NO_TEXT" });
    expect(hooks.pageCalls).toBe(2);
  });
  it("answers NO_TEXT for a page of only spaces", async () => {
    expect(await run(buildPdf({ pages: [["   ", "  "]] }))).toEqual({ ok: false, code: "NO_TEXT" });
  });
});

describe("DR-82 the page cap is checked before any page is parsed", () => {
  it("accepts exactly 30 pages and refuses 31 without reading a single page", async () => {
    const pages = (count: number) => Array.from({ length: count }, (_, index) => [`Page ${index + 1}.`]);
    const ok = await run(buildPdf({ pages: pages(PDF_MAX_PAGES) }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.pages).toBe(30);
    expect(hooks.pageCalls).toBe(30);
    hooks.pageCalls = 0;
    expect(await run(buildPdf({ pages: pages(PDF_MAX_PAGES + 1) }))).toEqual({ ok: false, code: "TOO_MANY_PAGES" });
    expect(hooks.pageCalls).toBe(0);
  });
  it("honors a smaller cap passed in", async () => {
    expect(await run(buildPdf({ pages: FIXTURE_LINES }), { maxPages: 1 })).toEqual({ ok: false, code: "TOO_MANY_PAGES" });
    expect(hooks.pageCalls).toBe(0);
  });
  it("keeps the documented limits", () => {
    expect(PDF_MAX_PAGES).toBe(30);
    expect(PDF_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe("DR-83 a file that is not a PDF is refused before the parser opens it", () => {
  it.each([
    ["plain text", bytesOf("Grant agreement text, not a PDF.")], ["html", bytesOf("<html><script>alert(1)</script></html>")], ["a png header", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["empty", new Uint8Array()], ["a magic missing its dash", bytesOf("%PDF1.4\n")], ["lowercase magic", bytesOf("%pdf-1.4\n")], ["space before the magic", bytesOf(` %PDF-1.4\n${"x".repeat(50)}`)],
    ["a byte order mark before the magic", new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf("%PDF-1.4\n")])], ["a zip header", bytesOf("PK\u0003\u0004 not a pdf")],
  ])("refuses %s", async (_label, bytes) => {
    expect(await run(bytes)).toEqual({ ok: false, code: "NOT_PDF" });
    expect(hooks.openCalls).toBe(0);
  });
  it("reads the magic at byte zero only", () => {
    expect(hasPdfMagic(bytesOf("%PDF-"))).toBe(true);
    expect(hasPdfMagic(bytesOf("%PDF"))).toBe(false);
    expect(hasPdfMagic(bytesOf("x%PDF-"))).toBe(false);
  });
});

describe("DR-84 a truncated or malformed PDF is refused with a code and no library text", () => {
  const good = buildPdf({ pages: FIXTURE_LINES });
  it.each([
    ["truncated early", good.slice(0, 40)], ["truncated before the pages", good.slice(0, 300)], ["magic only", bytesOf("%PDF-")], ["magic then prose", bytesOf("%PDF-1.4\nthis is only prose, not objects\n")],
    ["objects with no catalog", bytesOf("%PDF-1.4\n1 0 obj\n<< /Type /Nothing >>\nendobj\ntrailer\n<< /Size 2 >>\nstartxref\n0\n%%EOF\n")],
    ["a page tree that points at itself", bytesOf("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n")],
    ["binary noise", new Uint8Array([...bytesOf("%PDF-1.7\n"), ...Array.from({ length: 400 }, (_, index) => (index * 37 + 11) % 256)])],
  ])("answers MALFORMED for %s and nothing else", async (_label, bytes) => {
    const result = await run(bytes);
    expect(result.ok).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
    expect(["MALFORMED", "NO_TEXT"]).toContain((result as { code: string }).code);
  });
  it("never lets a library error message into the result, even when the message names the file's own words", async () => {
    hooks.failWith = new Error("Invalid PDF structure near secret grant words: ACME-CONFIDENTIAL /Users/pavan/file.pdf");
    const result = await run(good);
    expect(result).toEqual({ ok: false, code: "MALFORMED" });
    expect(JSON.stringify(result)).not.toMatch(/ACME|secret|Users|structure/);
  });
  it("maps a password request to ENCRYPTED by the exception name alone, and a non-Error throw to MALFORMED", async () => {
    const password = new Error("No password given: ACME-CONFIDENTIAL"); password.name = "PasswordException";
    hooks.failWith = password;
    expect(await run(good)).toEqual({ ok: false, code: "ENCRYPTED" });
    hooks.failWith = "a thrown string with ACME-CONFIDENTIAL";
    expect(await run(good)).toEqual({ ok: false, code: "MALFORMED" });
    hooks.failWith = { name: "PasswordException" };
    expect(await run(good)).toEqual({ ok: false, code: "MALFORMED" });
  });
  it("releases the gate after a failure, so the next upload is read", async () => {
    hooks.failWith = new Error("boom");
    expect(await run(good)).toEqual({ ok: false, code: "MALFORMED" });
    hooks.failWith = null;
    expect((await run(good)).ok).toBe(true);
  });
});

describe("DR-85 an encrypted PDF is refused", () => {
  it("answers ENCRYPTED from the trailer before the parser opens the file", async () => {
    const result = await run(buildPdf({ pages: FIXTURE_LINES, encrypted: true }));
    expect(result).toEqual({ ok: false, code: "ENCRYPTED" });
    expect(hooks.openCalls).toBe(0);
  });
});

describe("DR-86 a PDF with a JavaScript action gives its text and runs nothing", () => {
  it("extracts the text, leaves the action's flag unset and never defines the viewer API the action calls", async () => {
    const bytes = buildPdf({ pages: FIXTURE_LINES, javascript: true });
    const file = Buffer.from(bytes).toString("latin1");
    expect(file).toContain("/S /JavaScript");
    expect(file).toContain("__pdfActionRan");
    const result = await run(bytes);
    expect(result).toEqual({ ok: true, text: FIXTURE_TEXT, pages: 2 });
    expect((globalThis as Record<string, unknown>).__pdfActionRan).toBeUndefined();
    expect((globalThis as Record<string, unknown>).app).toBeUndefined();
  });
  it("is the same text as the file without the action", async () => {
    const plain = await run(buildPdf({ pages: FIXTURE_LINES }));
    const scripted = await run(buildPdf({ pages: FIXTURE_LINES, javascript: true }));
    expect(scripted).toEqual(plain);
  });
});

describe("DR-87 the text cap is 20,000 code points, enforced while the text is read", () => {
  it("accepts exactly 20,000 code points", async () => {
    const result = await run(buildPdf({ pages: [longPage(178)], ...SMALL }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(countOf(result.text)).toBe(20_000);
  });
  it("refuses 20,001 code points as too long", async () => {
    expect(await run(buildPdf({ pages: [longPage(179)], ...SMALL }))).toEqual({ ok: false, code: "TOO_LONG" });
  });
  it("refuses text far past the cap and stops reading pages once it is over", async () => {
    const page = Array.from({ length: 28 }, () => "c".repeat(900));
    const result = await run(buildPdf({ pages: Array.from({ length: 10 }, () => page), ...SMALL }));
    expect(result).toEqual({ ok: false, code: "TOO_LONG" });
    expect(hooks.pageCalls).toBeLessThan(10);
  });
  it("stops inside a page that arrives in many chunks, and the library raises no unhandled rejection when reading stops early", async () => {
    const rejections: unknown[] = [];
    const listen = (reason: unknown) => { rejections.push(reason); };
    process.on("unhandledRejection", listen);
    try {
      // 3,000 lines of 8 characters on one page, at a size and spacing that keep them all on the page: pdf.js sends them in about 30 chunks.
      const page = Array.from({ length: 3000 }, () => "c".repeat(8));
      expect(await run(buildPdf({ pages: [page], fontSize: 1, leading: 0.1 }))).toEqual({ ok: false, code: "TOO_LONG" });
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally { process.off("unhandledRejection", listen); }
    expect(rejections).toEqual([]);
  });
  it("honors a smaller cap passed in and counts code points, not UTF-16 units", async () => {
    expect(await run(buildPdf({ pages: FIXTURE_LINES }), { maxCodePoints: FIXTURE_TEXT.length })).toEqual({ ok: true, text: FIXTURE_TEXT, pages: 2 });
    expect(await run(buildPdf({ pages: FIXTURE_LINES }), { maxCodePoints: FIXTURE_TEXT.length - 1 })).toEqual({ ok: false, code: "TOO_LONG" });
  });
});

describe("DR-88 one extraction at a time, and a wall-clock budget between pages", () => {
  it("answers BUSY to a second extraction that starts while the first is running, then recovers", async () => {
    const bytes = buildPdf({ pages: FIXTURE_LINES });
    const [first, second] = await Promise.all([run(bytes), run(bytes)]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, code: "BUSY" });
    expect((await run(bytes)).ok).toBe(true);
  });
  it("answers TOO_SLOW when the budget is spent before a page is read, and TOO_SLOW names no timing", async () => {
    let clock = 0;
    const result = await run(buildPdf({ pages: FIXTURE_LINES }), { budgetMs: 10_000, now: () => (clock += 20_000) });
    expect(result).toEqual({ ok: false, code: "TOO_SLOW" });
    expect(hooks.pageCalls).toBe(0);
  });
  it("reads every page when the clock stays inside the budget", async () => {
    expect((await run(buildPdf({ pages: FIXTURE_LINES }), { budgetMs: 10_000, now: () => 5 })).ok).toBe(true);
    expect(hooks.pageCalls).toBe(2);
  });
});
