import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { WORKSHOP_EXAMPLE } from "../src/app/receipts/examples";
import { EXPORT_MODE } from "./support/export-mode";

// IAC-384 demo receipt photo, DR-01 to DR-04. The generator is owner-only: the judge export omits scripts/, so
// these checks run where the module exists (the owner tree) and skip elsewhere, as tests/rules-draft-static.test.ts does for the export script.
const MODULE = "scripts/support/demo-receipt-photo.mjs", ENTRY = "scripts/demo-receipt-photo.mjs";
// In the owner tree both files must exist (a missing one fails the tests below by path); only an export stands down.
const owner = !EXPORT_MODE;
const source = (path: string) => readFileSync(path, "utf8");
const code = (path: string) => source(path).split("\n").map(line => line.replace(/^\s*\/\/.*$/, "")).join("\n");
const imports = (text: string) => [...text.matchAll(/^\s*import\s+(?:type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].map(match => match[1]!);
const cents = (amount: string) => { const [whole, fraction] = amount.split("."); return Number(whole) * 100 + Number(fraction); };

let receipt: { vendor: string; date: string; lines: [string, string][]; total: string };
let html = "";
beforeAll(async () => {
  if (!owner) return;
  const loaded: any = await import(/* @vite-ignore */ pathToFileURL(resolve(MODULE)).href);
  receipt = loaded.DEMO_RECEIPT;
  html = loaded.demoReceiptHtml();
});

describe.skipIf(!owner)("DR demo receipt photo generator", () => {
  it("DR-01 the receipt equals the workshop example: vendor, date, descriptions, amounts and total", () => {
    expect(receipt.vendor).toBe(WORKSHOP_EXAMPLE.vendor);
    expect(receipt.date).toBe(WORKSHOP_EXAMPLE.incurredOn);
    expect(receipt.lines.map(([text, amount]) => ({ description: text, amount }))).toEqual(WORKSHOP_EXAMPLE.lines);
    expect(receipt.total).toBe(WORKSHOP_EXAMPLE.total);
  });
  it("DR-02 the line amounts sum to the total in integer cents", () => {
    expect(receipt.lines.map(([, amount]) => amount)).toEqual(["280.00", "150.00", "70.00"]);
    expect(receipt.lines.reduce((sum, [, amount]) => sum + cents(amount), 0)).toBe(cents(receipt.total));
    expect(cents(receipt.total)).toBe(50000);
  });
  it("DR-03 the HTML shows every line, the rule and the total, and carries no subtotal, tax, tip, injection, URL, address mark or long digit run", () => {
    expect(html).toContain(receipt.vendor);
    expect(html).toContain(receipt.date);
    for (const [text, amount] of receipt.lines) { expect(html).toContain(text); expect(html).toContain(amount); }
    expect(html).toContain('class="rule"');
    expect(html).toContain("<span>Total</span><span>500.00</span>");
    expect(html).not.toMatch(/Subtotal|Tax|Tip|IGNORE/i);
    expect(html).not.toMatch(/https?:|www\.|@|[0-9]{7,}|rotate|filter|blur|cursive/i);
  });
  it("DR-04 the module imports nothing and the entry imports only node built-ins, playwright and the module, and writes only into its argument directory", () => {
    expect(imports(source(MODULE))).toEqual([]);
    expect(code(MODULE)).not.toMatch(/process\b|\bDate\b|fetch\(|Math\.random|node:|child_process|eval\(|require\(|import\(|ANTHROPIC|PAYPAL|\.env\b|writeFile|mkdir/);
    expect(imports(source(ENTRY)).sort()).toEqual(["./support/demo-receipt-photo.mjs", "@playwright/test", "node:crypto", "node:fs"]);
    const text = code(ENTRY);
    expect(text).not.toMatch(/process\.env|fetch\(|child_process|ANTHROPIC|PAYPAL|\.env\b|rmSync|unlinkSync|renameSync|copyFileSync|goto\(/);
    const writes = text.split("\n").filter(line => /\b(writeFileSync|appendFileSync|openSync|createWriteStream|mkdirSync)\(/.test(line)).map(line => line.trim());
    expect(writes).toEqual(["mkdirSync(out, { recursive: true });", "writeFileSync(`${out}/brightbench-receipt.png`, png);"]);
    expect(text).toContain("const out = process.argv[2];");
  });
});
