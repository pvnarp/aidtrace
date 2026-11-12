import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createClaudeBudget } from "../src/ai/budget";
import { PHOTO_PROCESS_CAP, PHOTO_TIMEOUT_MS, readReceiptPhoto } from "../src/ai/claude-photo";
import { centsOfInput, photoContentDigest } from "../src/receipt/photo-digest";
import { photoPrintedDate, PHOTO_SOURCE_LABEL, PHOTO_SOURCE_LABEL_TYPED } from "../src/app/receipts/photo-copy";
import { aiCard, paypalCard, railLines, RAIL_RECEIPT_PHOTO, type Stage } from "../src/app/shell-copy";
import { FAKE_ENV, claudeMessage, stubClient } from "./support/claude-stub";
import { goodWire, pngBytes } from "./support/photo";

// IAC-384 review round, PH-46 to PH-58: the pure and stub-client parts of the provenance fix. No network, no key, no real model.
const ENV = { ...FAKE_ENV, AI_RECEIPT_ENABLED: "true", AI_RECEIPT_PHOTO_ENABLED: "true" };
const base = { vendor: "Cedar Science Shop", lines: [{ description: "Science kit", amountCents: 600n }], totalCents: 600n, source: "Science kit $6.00\nTotal $6.00" };

describe("PH-46 the canonical content digest", () => {
  it("is a SHA-256 of the vendor, lines in order, total and source, and ignores number types, edge whitespace and CRLF", () => {
    const digest = photoContentDigest(base);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(photoContentDigest({ ...base, lines: [{ description: "  Science kit ", amountCents: 600 }], totalCents: 600, vendor: " Cedar Science Shop " })).toBe(digest);
    expect(photoContentDigest({ ...base, source: "Science kit $6.00\r\nTotal $6.00" })).toBe(digest);
    expect(photoContentDigest({ ...base, source: "Science kit $6.00\rTotal $6.00" })).toBe(digest);
  });
  it("changes for one cent, a vendor letter, a description letter, a line swap, an added line, a total and a source letter", () => {
    const digest = photoContentDigest(base);
    const two = { ...base, lines: [{ description: "A", amountCents: 100n }, { description: "B", amountCents: 500n }] };
    for (const changed of [
      { ...base, lines: [{ description: "Science kit", amountCents: 601n }] }, { ...base, totalCents: 601n }, { ...base, vendor: "Cedar Science Shopp" },
      { ...base, lines: [{ description: "Science kits", amountCents: 600n }] }, { ...base, source: "Science kit $6.00\nTotal $6.01" },
      { ...base, lines: [...base.lines, { description: "Extra", amountCents: 0n }] },
    ]) expect(photoContentDigest(changed)).not.toBe(digest);
    expect(photoContentDigest({ ...two, lines: [two.lines[1]!, two.lines[0]!] })).not.toBe(photoContentDigest(two));
  });
  it("cannot confuse a field boundary: moving text between vendor and a description changes the digest", () => {
    expect(photoContentDigest({ ...base, vendor: "AB", lines: [{ description: "C", amountCents: 1n }] })).not.toBe(photoContentDigest({ ...base, vendor: "A", lines: [{ description: "BC", amountCents: 1n }] }));
  });
  it("reads only the two-decimal amount shape the form uses", () => {
    expect(centsOfInput("12.50")).toBe(1250n); expect(centsOfInput("0.05")).toBe(5n);
    for (const bad of ["12.5", "12", "-1.00", "1,200.00", "01.00", "1e3.00", "", " 1.00"]) expect(centsOfInput(bad), bad).toBeNull();
  });
});

describe("PH-47 the photo sub-cap", () => {
  it("is 20, a constant, with no environment name or request field that can raise it", () => {
    expect(PHOTO_PROCESS_CAP).toBe(20);
    const text = readFileSync("src/ai/claude-photo.ts", "utf8").split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
    expect(text).toMatch(/PHOTO_PROCESS_CAP = 20;/);
    expect(text.match(/PHOTO_PROCESS_CAP\s*=/g)).toHaveLength(1); expect(text).not.toMatch(/env\.[A-Z_]*CAP|Number\(env|parseInt\(env/);
  });
  it("lets 20 reads through, refuses the 21st with no request and leaves the shared budget at 20", async () => {
    const stub = stubClient(() => claudeMessage(goodWire()));
    const budget = createClaudeBudget(); const photoBudget = createClaudeBudget(PHOTO_PROCESS_CAP);
    for (let i = 0; i < 20; i++) expect((await readReceiptPhoto(pngBytes(), "image/png", { env: ENV, client: stub.client, budget, photoBudget })).status).toBe("DONE");
    expect(stub.calls).toHaveLength(20); expect(budget.used()).toBe(20); expect(photoBudget.used()).toBe(20);
    const refused = await readReceiptPhoto(pngBytes(), "image/png", { env: { ...ENV, PHOTO_PROCESS_CAP: "1000" }, client: stub.client, budget, photoBudget });
    expect(refused).toEqual({ status: "UNAVAILABLE" });
    expect(stub.calls).toHaveLength(20); expect(budget.used()).toBe(20); expect(photoBudget.used()).toBe(20);
  });
  it("does not reserve the shared budget when the sub-cap refuses, and an unused sub-cap is untouched by the shared check", async () => {
    const stub = stubClient(() => claudeMessage(goodWire()));
    const photoBudget = createClaudeBudget(1); photoBudget.reserve();
    const budget = createClaudeBudget(5);
    expect(await readReceiptPhoto(pngBytes(), "image/png", { env: ENV, client: stub.client, budget, photoBudget })).toEqual({ status: "UNAVAILABLE" });
    expect(budget.used()).toBe(0); expect(stub.calls).toHaveLength(0);
  });
  it("an exhausted shared budget also gives UNAVAILABLE with no request", async () => {
    const stub = stubClient(() => claudeMessage(goodWire()));
    const budget = createClaudeBudget(1); budget.reserve();
    expect(await readReceiptPhoto(pngBytes(), "image/png", { env: ENV, client: stub.client, budget, photoBudget: createClaudeBudget(PHOTO_PROCESS_CAP) })).toEqual({ status: "UNAVAILABLE" });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("PH-48 the internal 30 second timeout", () => {
  it("aborts the request at 30 seconds, not before, and gives FAILED with no stop reason and no tokens", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const stub = stubClient((_request, options) => new Promise((_resolve, reject) => { signal = options?.signal ?? undefined; signal?.addEventListener("abort", () => reject(new Error("aborted"))); }));
      let settled = false;
      const pending = readReceiptPhoto(pngBytes(), "image/png", { env: ENV, client: stub.client, budget: createClaudeBudget(), photoBudget: createClaudeBudget(PHOTO_PROCESS_CAP) }).then(result => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(PHOTO_TIMEOUT_MS - 1);
      expect(settled).toBe(false); expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(signal?.aborted).toBe(true);
      expect(result).toMatchObject({ status: "DONE", outcome: "FAILED", facts: { stopReason: null, inputTokens: 0, outputTokens: 0 } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("PH-49 the printed date note and the text box label are fixed copy", () => {
  it("builds the printed date note from the fixed words and the model text, as plain text", () => {
    expect(photoPrintedDate("12 Oct 26")).toBe("Printed date: 12 Oct 26. Enter it as a date.");
    expect(photoPrintedDate("<b>x</b>")).toBe("Printed date: <b>x</b>. Enter it as a date.");
  });
  it("labels the text box from the photo, and back to the typed words", () => {
    expect(PHOTO_SOURCE_LABEL).toBe("Receipt text read from the photo");
    expect(PHOTO_SOURCE_LABEL_TYPED).not.toBe(PHOTO_SOURCE_LABEL);
  });
  it("photo-reader.tsx sets the note through textContent and never as markup", () => {
    const text = readFileSync("src/app/receipts/photo-reader.tsx", "utf8");
    expect(text).toMatch(/node\.textContent = text/); expect(text).not.toMatch(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/);
    expect(text).toMatch(/put\("incurredOn", prefill\.incurredOn \?\? ""\)/);
  });
});

describe("PH-50 the trace rail names a photo receipt and changes nothing else", () => {
  const ai = aiCard({ applicable: true, suggestion: "READY", confirmed: true, aiAccepted: false, savedModel: "Claude Haiku 5.5", configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } });
  const paypal = paypalCard({ claimStatus: "AWAITING_APPROVAL", approvals: 0, payout: null });
  it("says Read from a photo only when the current receipt links a read, for every stage", () => {
    expect(RAIL_RECEIPT_PHOTO).toBe("Read from a photo");
    for (const stage of [1, 2, 3, 4, 5] as Stage[]) {
      const typed = railLines({ stage, typedReceipt: true, ai, approvals: 0, paypal });
      const photo = railLines({ stage, typedReceipt: true, photoReceipt: true, ai, approvals: 0, paypal });
      expect(typed[0]!.name).toBe("Receipt"); expect(typed[0]!.state).toBe("Typed text and amounts"); expect(photo[0]!.state).toBe("Read from a photo");
      expect(photo.slice(1)).toEqual(typed.slice(1));
    }
  });
  it("every page that does not link a read is byte-identical to before: an explicit false or an absent flag change nothing", () => {
    for (const typedReceipt of [true, false]) {
      const without = railLines({ stage: 2, typedReceipt, ai, approvals: 0, paypal });
      expect(railLines({ stage: 2, typedReceipt, photoReceipt: false, ai, approvals: 0, paypal })).toEqual(without);
      expect(JSON.stringify(without)).not.toContain("photo");
    }
    expect(railLines({ stage: 2, typedReceipt: false, ai, approvals: 0, paypal })[0]!.state).toBe("Preclassified example");
  });
  it("only the two claim pages pass the flag, and only when a read is linked", () => {
    for (const file of ["src/app/claims/[claimId]/page.tsx", "src/app/claims/[claimId]/receipt/page.tsx"]) expect(readFileSync(file, "utf8"), file).toMatch(/\.\.\.\((?:photoLinked|review\.photoReadId) \? \{ photoReceipt: true \} : \{\}\)/);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name: string) => { const path = `${dir}/${name}`; return statSync(path).isDirectory() ? walk(path) : [path]; });
    const users = walk("src/app").filter(path => /\.tsx?$/.test(path) && /photoReceipt/.test(readFileSync(path, "utf8"))).sort();
    expect(users).toEqual(["src/app/claims/[claimId]/page.tsx", "src/app/claims/[claimId]/receipt/page.tsx", "src/app/shell-copy.ts", "src/app/trace.tsx", "src/app/workspace.tsx"]);
  });
});
