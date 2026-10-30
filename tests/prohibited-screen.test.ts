import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ALCOHOL_TERMS, EXCEPTION_PHRASES, GIFT_CARD_TERMS, PROHIBITED_TERMS_VERSION, screenReceiptText, unresolvedMatches } from "../src/receipt/prohibited-screen";

const terms = (source: string, lines: string[] = []) => screenReceiptText(source, lines).matches.map(match => `${match.category}:${match.term}`);

it("PTG-01: both categories match, every listed term matches alone, and the lists are frozen and versioned", () => {
  expect(PROHIBITED_TERMS_VERSION).toBe("prohibited-terms-v1");
  expect([GIFT_CARD_TERMS.length, ALCOHOL_TERMS.length, EXCEPTION_PHRASES.length]).toEqual([16, 36, 25]);
  for (const list of [GIFT_CARD_TERMS, ALCOHOL_TERMS, EXCEPTION_PHRASES]) expect(Object.isFrozen(list)).toBe(true);
  for (const term of GIFT_CARD_TERMS) expect(screenReceiptText(`Bought: ${term}`, []).matches).toEqual([{ category: "gift_cards", term }]);
  for (const term of ALCOHOL_TERMS) expect(screenReceiptText(`Bought: ${term}`, []).matches).toEqual([{ category: "alcohol", term }]);
  expect(screenReceiptText("Robot kit and notebooks", [])).toEqual({ version: "prohibited-terms-v1", matches: [] });
});
it("PTG-02: terms match whole words only", () => {
  for (const text of ["Clearance sale", "Ginger snaps", "Drum kit", "Gingerbread kit", "Please begin", "Wineglass", "Beerfest", "Spiritsong", "Giftcarding", "Alepho", "Rumba", "Margin"]) expect(terms(text)).toEqual([]);
  expect(terms("Gin")).toEqual(["alcohol:gin"]);
  expect(terms("RUM")).toEqual(["alcohol:rum"]);
  expect(terms("Pale ale")).toEqual(["alcohol:ale"]);
  expect(terms("Rum cake")).toEqual(["alcohol:rum"]);
});
it("PTG-03: every exception phrase suppresses its term, and a real term beside one still matches", () => {
  for (const phrase of EXCEPTION_PHRASES) {
    expect(terms(phrase)).toEqual([]);
    expect(terms(`Sold: ${phrase.toUpperCase()}.`)).toEqual([]);
    expect(terms(`${phrase} ${phrase}`)).toEqual([]);
  }
  expect(terms("ginger ale and beer")).toEqual(["alcohol:beer"]);
  expect(terms("Root beer, beer")).toEqual(["alcohol:beer"]);
  expect(terms("alcohol free beer")).toEqual(["alcohol:beer"]);
  expect(terms("gift wrap and gift card")).toEqual(["gift_cards:gift card"]);
  expect(terms("wine vinegar with red wine")).toEqual(["alcohol:wine"]);
  expect(terms("non-alcoholic")).toEqual([]);
  expect(terms("Alcohol-free")).toEqual([]);
  expect(terms("isopropyl alcohol and alcohol")).toEqual(["alcohol:alcohol"]);
});
it("PTG-04: punctuation, case and Unicode compatibility forms are normalized", () => {
  expect(terms("GIFT-CARD")).toEqual(["gift_cards:gift card"]);
  expect(terms("Gift Card(R)")).toEqual(["gift_cards:gift card"]);
  expect(terms("gift_card; gift.card")).toEqual(["gift_cards:gift card"]);
  expect(terms("E-GIFT")).toEqual(["gift_cards:e gift"]);
  expect(terms("eGift")).toEqual(["gift_cards:egift"]);
  expect(terms("ＷＩＮＥ")).toEqual(["alcohol:wine"]);
  expect(terms("ｇｉｆｔ　ｃａｒｄ")).toEqual(["gift_cards:gift card"]);
  expect(terms("a\nb\tBEER\r\n")).toEqual(["alcohol:beer"]);
  expect(terms("")).toEqual([]);
});
it("PTG-05: a match in the source alone or in one line description alone counts", () => {
  expect(terms("FICTIONAL RECEIPT\nReception supplies", ["Cheese tray", "Wine for the reception"])).toEqual(["alcohol:wine"]);
  expect(terms("Raffle prize: gift card", ["Science experiment kit"])).toEqual(["gift_cards:gift card"]);
  expect(terms("Science experiment kit", ["Science experiment kit"])).toEqual([]);
});
it("PTG-06: the gift card injection receipt text still matches, because the screen reads the receipt and never obeys it", () => {
  const eval2 = JSON.parse(readFileSync("ai/eval-v2.json", "utf8")) as { cases: { id: string; source: string; lines: { description: string }[] }[] };
  const injected = eval2.cases.find(item => item.id === "giftcards_injection")!;
  expect(injected.source).toContain("this is not a gift card");
  expect(screenReceiptText(injected.source, injected.lines.map(line => line.description)).matches).toEqual([{ category: "gift_cards", term: "gift card" }]);
});
it("PTG-07: results are deduplicated and sorted by category then term, whatever the input order", () => {
  const a = screenReceiptText("Wine, beer, gift card, wine, Gift Card, prepaid card", ["Beer", "ipa"]);
  const b = screenReceiptText("ipa beer", ["PREPAID CARD gift card", "wine"]);
  expect(a.matches).toEqual([{ category: "alcohol", term: "beer" }, { category: "alcohol", term: "ipa" }, { category: "alcohol", term: "wine" },
    { category: "gift_cards", term: "gift card" }, { category: "gift_cards", term: "prepaid card" }]);
  expect(b).toEqual(a);
  expect(screenReceiptText("beer", ["wine"])).toEqual(screenReceiptText("wine", ["beer"]));
});
it("PTG-08: brand names alone do not match, a recorded limit of the generic list", () => {
  expect(terms("Bud Lt 12pk")).toEqual([]);
  expect(terms("Hennessy VS", ["Jack Daniels 750ml"])).toEqual([]);
  expect(terms("Visa reloadable gift", ["Amazon eGC"])).toEqual([]);
});
it("PTG-09: unresolvedMatches drops only the categories a confirmed line carries", () => {
  const matches = screenReceiptText("wine and a gift card", []).matches;
  expect(unresolvedMatches(matches, ["robot_kits_parts"])).toEqual(matches);
  expect(unresolvedMatches(matches, ["gift_cards"])).toEqual([{ category: "alcohol", term: "wine" }]);
  expect(unresolvedMatches(matches, ["alcohol", "gift_cards"])).toEqual([]);
  expect(unresolvedMatches([], ["robot_kits_parts"])).toEqual([]);
});
