// IAC-440 Package B test helper: builds small, valid, synthetic PDF files byte for byte, so no binary fixture has to be trusted.
// Every file is ASCII, so a string offset is a byte offset and the cross-reference table is exact. Nothing here reads a network, a key or the clock.
export type PdfSpec = {
  // One entry per page: the lines of text, drawn top to bottom. A page with no lines draws one rectangle and no text, which is what an image-only scan looks like to a text extractor.
  pages: string[][];
  // Adds an open action that is a JavaScript action. A viewer that ran it would set a flag and raise an alert. The extractor must run nothing.
  javascript?: boolean;
  // Adds an /Encrypt dictionary whose user password check cannot pass with an empty password.
  encrypted?: boolean;
  // Line spacing in points. The default fits about fifty lines on a page. A small value stacks many lines on one page, so a long text needs few pages.
  leading?: number;
  // Font size in points. The default is 12. Observed with these fixtures: text drawn past the page edge did not come out of the extractor (19 lines of 1,000 characters at size 12 gave 1,620 characters),
  // and lines drawn closer together than the font size came out joined with no newline. A size of 1 with a leading of 1.5 keeps a line of 900 characters on the page and ends each line with a newline.
  fontSize?: number;
};

const escapeText = (line: string) => line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function buildPdf(spec: PdfSpec): Uint8Array {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // Object 1 is the catalog, object 2 the page tree, object 3 the font. Page and content objects follow in pairs. The JavaScript action and the
  // encryption dictionary, when present, come after them.
  const count = spec.pages.length;
  const first = 4;
  for (let index = 0; index < count; index++) pageIds.push(first + index * 2);
  const actionId = first + count * 2;
  const encryptId = actionId + (spec.javascript ? 1 : 0);
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${spec.javascript ? ` /OpenAction ${actionId} 0 R` : ""} >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${count} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  spec.pages.forEach((lines, index) => {
    const id = pageIds[index]!;
    const content = lines.length
      ? `BT /F1 ${spec.fontSize ?? 12} Tf ${spec.leading ?? 14} TL 72 720 Td ${lines.map(line => `(${escapeText(line)}) Tj T*`).join(" ")} ET`
      : "0.5 g 72 600 200 100 re f";
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  if (spec.javascript) objects[actionId] = "<< /S /JavaScript /JS (globalThis.__pdfActionRan = true; app.alert\\(1\\);) >>";
  if (spec.encrypted) objects[encryptId] = `<< /Filter /Standard /V 1 /R 2 /P -4 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`;

  const size = objects.length;
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < size; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${size} /Root 1 0 R${spec.encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : ""} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

// The grant text of the smallest fixture and of the committed file tests/fixtures/grant-two-pages.pdf.
export const FIXTURE_LINES: string[][] = [
  ["Grant agreement between Cedar Hollow Community Fund and the Eastside Robotics Club.", "Section 1. Funds may be used only for direct costs of the robotics afterschool program."],
  ["Section 2. The grant period begins on 2026-09-01 and ends on 2027-06-30.", "Section 3. Spending on supplies may not exceed $300.00 in total."],
];
export const FIXTURE_TEXT = `${FIXTURE_LINES[0]!.join("\n")}\n\n${FIXTURE_LINES[1]!.join("\n")}`;
