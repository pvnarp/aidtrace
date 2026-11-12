import { describe, expect, it } from "vitest";
import { afterSubtotal, checkArithmetic, type Transcript } from "../src/ai/claude-photo";
import { photoAfterSubtotal } from "../src/app/receipts/photo-copy";

// IAC-384, PH-77 to PH-83: the "added after the subtotal" note. Pure functions over fixed transcripts.
const make = (amounts: number[], subtotalCents: number | null, totalCents: number, taxCents: number | null = null): Transcript =>
  ({ vendor: "V", datePrinted: "", lines: amounts.map((amountCents, i) => ({ text: `line ${i + 1}`, amountCents })), subtotalCents, taxCents, totalCents });
const note = (transcript: Transcript) => afterSubtotal(transcript, checkArithmetic(transcript));

describe("PH-77 the handwritten tip shape", () => {
  it("12.00, 4.00 and a hand-added 3.00 with subtotal 16.00 and total 19.00 names two printed lines and 3.00 after", () => {
    const tip = make([1200, 400, 300], 1600, 1900);
    expect(checkArithmetic(tip)).toMatchObject({ ok: false, linesPlusTaxMatchesTotal: true, subtotalMatchesLines: false });
    expect(note(tip)).toEqual({ printedCount: 2, afterCents: 300 });
  });
  it("tax in the total does not stop it", () => { expect(note(make([1200, 400, 300], 1600, 1950, 50))).toEqual({ printedCount: 2, afterCents: 300 }); });
});

describe("PH-78 a subtotal that matches no prefix", () => {
  it("gives null, so the old subtotal warning stays", () => {
    expect(note(make([1200, 400, 300], 1599, 1900))).toBeNull();
    expect(note(make([1200, 400, 300], 1700, 1900))).toBeNull();
  });
});

describe("PH-79 a total that does not add up", () => {
  it("gives null even when a prefix matches the subtotal, so the total warning stays", () => {
    const wrongTotal = make([1200, 400, 300], 1600, 1901);
    expect(checkArithmetic(wrongTotal).linesPlusTaxMatchesTotal).toBe(false);
    expect(note(wrongTotal)).toBeNull();
    expect(note(make([1200, 400, 300], 1600, 1899))).toBeNull();
  });
});

describe("PH-80 and PH-81 the subtotal that equals every line, and k below lines.length", () => {
  it("PH-80 a subtotal equal to all lines is arithmetic ok and gives null", () => {
    const all = make([1200, 400, 300], 1900, 1900);
    expect(checkArithmetic(all).ok).toBe(true);
    expect(note(all)).toBeNull();
  });
  it("PH-81 a trailing zero line never makes k equal lines.length, and a subtotal with no following amount gives null", () => {
    const zero = make([1200, 400, 0], 1600, 1600);
    expect(note(zero)).toBeNull();
    const notOk = make([1200, 400, 0], 1600, 1601);
    expect(note(notOk)).toBeNull();
    // A forced "not ok" with every line summing to the subtotal still gives null: arithmetic.ok false and lines plus tax match the total cannot both hold with subtotal equal to all lines.
    expect(afterSubtotal(make([500, 500], 1000, 1000), { ...checkArithmetic(make([500, 500], 1000, 1000)), ok: false })).toBeNull();
  });
});

describe("PH-82 the largest k wins with a zero amount line", () => {
  it("lines 12.00, 4.00, 0.00, 3.00 with subtotal 16.00 name three printed lines and 3.00 after", () => {
    expect(note(make([1200, 400, 0, 300], 1600, 1900))).toEqual({ printedCount: 3, afterCents: 300 });
  });
});

describe("PH-83 the fixed copy", () => {
  it("reads the exact sentence for several printed lines", () => {
    expect(photoAfterSubtotal(1600, 2, 300, 1900)).toBe("The subtotal $16.00 covers the first 2 lines. The $3.00 after it, such as a tip added by hand, is in the total of $19.00. Check that line against the photo.");
  });
  it("says line for one printed line", () => {
    expect(photoAfterSubtotal(1200, 1, 750, 1950)).toBe("The subtotal $12.00 covers the first 1 line. The $7.50 after it, such as a tip added by hand, is in the total of $19.50. Check that line against the photo.");
  });
  it("uses none of the D7 words and no em or en dash", () => {
    for (const text of [photoAfterSubtotal(1600, 2, 300, 1900), photoAfterSubtotal(1200, 1, 750, 1950)]) {
      expect(text).not.toMatch(/verified|approved|accurate/i);
      expect(text).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`));
    }
  });
});
