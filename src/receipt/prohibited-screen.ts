// Receipt text screen for alcohol and gift card wording (IAC-394, docs/plans/PROHIBITED_SCREEN.md).
// Pure and dependency free on purpose: no database, no framework, no network. It only reads text.
// It flags. It never blocks an allocation, relabels a line or touches money.

export const PROHIBITED_TERMS_VERSION = "prohibited-terms-v1";
export type ProhibitedCategory = "alcohol" | "gift_cards";
export type ProhibitedMatch = { category: ProhibitedCategory; term: string };
export type ProhibitedScreenResult = { version: string; matches: ProhibitedMatch[] };

// Generic English terms only, no brand names. Owner decision October 30, IAC-394.
// Terms and exceptions are written in normalized form: lowercase a to z and 0 to 9, single spaces.
export const GIFT_CARD_TERMS: readonly string[] = Object.freeze([
  "gift card", "gift cards", "giftcard", "giftcards", "egift", "e gift", "egiftcard", "gift certificate",
  "gift certificates", "gift voucher", "gift vouchers", "prepaid card", "prepaid cards", "prepaid debit",
  "stored value card", "reloadable card",
]);
export const ALCOHOL_TERMS: readonly string[] = Object.freeze([
  "alcohol", "alcoholic", "beer", "beers", "wine", "wines", "liquor", "liqueur", "spirits", "vodka", "whiskey",
  "whisky", "bourbon", "tequila", "mezcal", "rum", "gin", "brandy", "cognac", "champagne", "prosecco", "sangria",
  "hard seltzer", "hard cider", "ipa", "lager", "ale", "merlot", "cabernet", "chardonnay", "pinot", "sauvignon",
  "riesling", "malbec", "zinfandel", "moscato",
]);
// Phrases that contain a term but name something else. Removed before matching.
export const EXCEPTION_PHRASES: readonly string[] = Object.freeze([
  "root beer", "ginger beer", "birch beer", "ginger ale", "non alcoholic", "nonalcoholic", "alcohol free",
  "rubbing alcohol", "isopropyl alcohol", "alcohol wipe", "alcohol wipes", "alcohol pad", "alcohol pads",
  "alcohol swab", "alcohol swabs", "alcohol prep", "alcohol based", "wine vinegar", "gift wrap", "gift bag",
  "gift bags", "gift box", "gift boxes", "gift tag", "gift tags",
]);

const TERMS: readonly (readonly [ProhibitedCategory, readonly string[]])[] = [["alcohol", ALCOHOL_TERMS], ["gift_cards", GIFT_CARD_TERMS]];

// NFKC, lowercase, every character outside a to z and 0 to 9 becomes a space, runs collapse, one space of padding each side.
export function normalizeForScreen(text: string) {
  return ` ${text.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `.replace(/ {2,}/g, " ");
}
function withoutExceptions(padded: string) {
  let text = padded;
  for (let changed = true; changed;) {
    changed = false;
    for (const phrase of EXCEPTION_PHRASES) {
      const needle = ` ${phrase} `;
      while (text.includes(needle)) { text = text.replace(needle, " "); changed = true; }
    }
  }
  return text;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Screens the receipt source and every line description. A match in any of them counts.
// Matches are unique by category and term and sorted by category then term.
export function screenReceiptText(source: string, lineDescriptions: readonly string[]): ProhibitedScreenResult {
  const found = new Map<string, ProhibitedMatch>();
  for (const text of [source, ...lineDescriptions]) {
    const cleaned = withoutExceptions(normalizeForScreen(text));
    for (const [category, terms] of TERMS) for (const term of terms) if (cleaned.includes(` ${term} `)) found.set(`${category}:${term}`, { category, term });
  }
  const matches = [...found.values()].sort((a, b) => compare(a.category, b.category) || compare(a.term, b.term));
  return { version: PROHIBITED_TERMS_VERSION, matches };
}

// Matches whose category is not carried by any confirmed line. Those need the claimant's acknowledgement.
export function unresolvedMatches(matches: readonly ProhibitedMatch[], confirmedCategories: readonly string[]): ProhibitedMatch[] {
  return matches.filter(match => !confirmedCategories.includes(match.category));
}
