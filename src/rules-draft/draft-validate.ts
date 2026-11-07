// IAC-440 Package A (docs/plans/AI_DRAFTED_RULES_SCOPE.md sections 3 and 4). The pure validator for an AI-drafted fund rule set.
// It reads raw model JSON (or a stored draft plus a human edit), the pasted grant text and the catalogs, and returns a normalized draft or a refusal
// code. It is pure: no client, no key, no environment, no database, no network. Nothing is ever repaired: a model answer that breaks a rule is refused.
//
// Two layers keep a draft from producing a policy that src/domain/model.ts prepare() rejects. The rules below mirror prepare() for a restricted fund
// (programs, categories, period, breadth, budget lines). Then a COMPLETE draft is run through prepare() itself with one probe claim line per allowed
// category, so the mirror cannot drift without a test failing. An incomplete draft (an UNSURE required field) is storable, but it cannot be approved.
//
// The model output schema has no null (the API refuses more than 16 union-typed parameters), so an UNSURE part of a model answer is the empty value:
// "" for a text value, [] for a list, 0 for an integer, "" for clauseId and quote, and 0 for breadth beside UNSURE categories. In MODEL mode those become
// null before anything else is decided, so the draft, the database rows and every reader keep their meaning. EDIT mode (a stored draft, never model JSON)
// is unchanged and holds null. A DRAFTED field with an empty clauseId or quote is refused exactly as one with null: CITATION_MISSING or QUOTE_INVALID.
//
// The model may only fill a field with a value it can quote. A quote is checked to be a substring of the cited clause and the clause is checked to be a
// substring of the pasted text. For the numbers and dates a mechanical support check then asks whether the quote states the value: a money value
// needs an equal dollar amount in its quote, a day count needs the number as digits or as an English word, a period date needs its four-digit year.
// A value that fails is downgraded to UNSURE and its path is recorded in quoteUnsupported, so a person must fill it. The check cannot tell whether a
// clause means what the model says (categories and programs have no mechanical check): that is the human review the scope requires.
import { BUDGET_LINE, type BudgetLine } from "../ai/categories";
import { prepare, type ClaimLine, type FundSnapshot } from "../domain/model";

export const DRAFT_INPUT_MAX_CHARS = 20_000;
export const CLAUSE_MAX_CHARS = 600;
export const CLAUSE_MAX_COUNT = 40;
export const SUMMARY_MAX_CHARS = 300;
export const CLAUSE_ID = /^[0-9]{1,2}[.][0-9]{1,2}$/;
// The same shape src/receipt/terms.ts requires of a claim program.
export const PROGRAM_ID = /^[a-z][a-z0-9_]{0,63}$/;
export const BUDGET_LINES: readonly BudgetLine[] = ["supplies", "other", "travel", "equipment", "contractual"];
export const THRESHOLD_KEYS = ["suppliesLimitCents", "equipmentLimitCents", "claimLimitCents", "staleReceiptDays", "duplicateWindowDays", "splitWindowDays"] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
const THRESHOLD_DAY_KEYS: readonly ThresholdKey[] = ["staleReceiptDays", "duplicateWindowDays", "splitWindowDays"];
// The fund_check_settings column bound (migration 0015): one to 3650 days.
const DAYS_MAX = 3650;
// Postgres has no year zero and the policy period is a grant period: a year outside this window is a model error.
const YEAR_MIN = 1990;
const YEAR_MAX = 2100;

export const DRAFT_REFUSALS = [
  "SHAPE", "NO_CLAUSES", "CLAUSE_COUNT", "CLAUSE_ID", "CLAUSE_DUPLICATE", "CLAUSE_LENGTH", "CLAUSE_NOT_SUBSTRING", "STATUS_INVALID", "UNSURE_HAS_VALUE",
  "DRAFTED_NO_VALUE", "CITATION_MISSING", "QUOTE_INVALID", "QUOTE_NOT_IN_CLAUSE", "PROGRAM_UNKNOWN", "CATEGORY_UNKNOWN", "PROHIBITED_CATEGORY", "DUPLICATE_VALUE",
  "DATE_INVALID", "DATE_ORDER", "MONEY_INVALID", "DAYS_INVALID", "BREADTH_MISMATCH", "SUMMARY_INVALID", "PREPARE_REJECTED", "NO_CHANGE",
  "MALFORMED_TEXT", "QUOTE_UNSUPPORTED",
] as const;
export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];

export type FieldStatus = "DRAFTED" | "UNSURE" | "EDITED";
// DRAFTED: the model filled it with a cited, quoted value. UNSURE: the text does not settle it (no value, no citation). EDITED: a person set it
// (EDIT mode only). An edited value has no citation unless the person kept a valid one.
export type DraftField<T> = { status: FieldStatus; value: T | null; clauseId: string | null; quote: string | null };
export type DraftClause = { id: string; text: string };
export type RulesDraft = {
  clauses: DraftClause[];
  programs: DraftField<string[]>;
  allowedCategories: DraftField<string[]>;
  periodStart: DraftField<string>;
  periodEnd: DraftField<string>;
  breadth: number | null;
  caps: Record<BudgetLine, DraftField<number>>;
  thresholds: Record<ThresholdKey, DraftField<number>>;
  summary: string;
  // Paths whose model value was downgraded to UNSURE because its quote did not state it. Absent when none. Only the validator sets it.
  quoteUnsupported?: string[];
};
// The grant text and the three lists the request sends. The validator checks against exactly what the model was shown.
export type GrantInput = { text: string; categories: readonly string[]; programs: readonly string[]; prohibited: readonly string[] };
export type DraftMode = "MODEL" | "EDIT";
// What a person may change. null clears a field back to UNSURE (a threshold left UNSURE carries the previous version's value when the draft binds).
export type DraftEdit = {
  programs?: string[] | null; allowedCategories?: string[] | null; periodStart?: string | null; periodEnd?: string | null;
  caps?: Partial<Record<BudgetLine, number | null>>; thresholds?: Partial<Record<ThresholdKey, number | null>>; summary?: string;
};
export type Analysis = { complete: boolean; missing: string[]; carried: ThresholdKey[]; quoteUnsupported: string[] };
export type Validated = { ok: true; draft: RulesDraft; analysis: Analysis } | { ok: false; reason: DraftRefusal; path: string };
export type BindablePolicy = {
  programs: string[]; allowedCategories: string[]; periodStart: string; periodEnd: string; breadth: number; summary: string;
  budgetLines: { budgetLine: BudgetLine; capCents: bigint }[];
};

class Refuse extends Error {
  constructor(readonly reason: DraftRefusal, readonly path: string) { super(reason); }
}
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
// Postgres char_length counts code points, not UTF-16 units.
export const codePoints = (text: string) => [...text].length;
function exactKeys(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Refuse("SHAPE", path);
  return value;
}

// The text an approver may paste: one to 20,000 code points, some non-space character, and no NUL (Postgres text cannot hold one).
export const validInputText = (text: unknown): text is string =>
  typeof text === "string" && text.trim().length > 0 && !text.includes("\u0000") && text.isWellFormed() && codePoints(text) <= DRAFT_INPUT_MAX_CHARS;

function isoDate(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Refuse("DATE_INVALID", path);
  const year = Number(value.slice(0, 4));
  if (year < YEAR_MIN || year > YEAR_MAX) throw new Refuse("DATE_INVALID", path);
  return value;
}
const centsValue = (path: string) => (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Refuse("MONEY_INVALID", path);
  return value;
};
const daysValue = (path: string) => (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > DAYS_MAX) throw new Refuse("DAYS_INVALID", path);
  return value;
};

// Every string of a model answer or a human edit must be well formed: no lone UTF-16 surrogate and no NUL. A lone surrogate can be a "substring" of
// the pasted text in UTF-16 terms and would then reach the database insert and throw a raw error, so the whole document is walked before any other rule.
const MALFORMED_WALK_DEPTH = 8;
function assertWellFormed(value: unknown, path: string, depth = 0): void {
  if (typeof value === "string") {
    if (!value.isWellFormed() || value.includes("\u0000")) throw new Refuse("MALFORMED_TEXT", path);
    return;
  }
  if (depth >= MALFORMED_WALK_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach((item, index) => assertWellFormed(item, `${path}.${index}`, depth + 1)); return; }
  for (const [key, item] of Object.entries(value)) {
    assertWellFormed(key, path, depth + 1);
    assertWellFormed(item, `${path}.${key}`, depth + 1);
  }
}

// Mechanical support of a quoted value. Each checker answers one question: does the quote state this number or year. A false answer is never a
// refusal in MODEL mode: the value becomes UNSURE and a person fills it. A quote that states a different number is never repaired.
type Support<T> = { holds: (value: T, quote: string) => boolean; failed: string[] };
const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?!\d|[,.]\d)`;
// Forms: $1,500  $1,500.00  $1500  1,500 dollars  USD 1,500. Anything else (a spelled-out amount, "1.5 thousand") is not recognized, which fails safe.
const MONEY_FORMS = [
  new RegExp(String.raw`\$\s?${AMOUNT}`, "g"),
  new RegExp(String.raw`\bUSD\s?${AMOUNT}`, "gi"),
  new RegExp(String.raw`(?<![\d,.$])${AMOUNT}\s?(?:dollars?|USD)\b`, "gi"),
];
const amountCents = (whole: string, fraction: string | undefined) => BigInt(whole.replace(/,/g, "")) * 100n + BigInt((fraction ?? "").padEnd(2, "0"));
export const dollarAmountsInCents = (quote: string): bigint[] => MONEY_FORMS.flatMap(form => [...quote.matchAll(form)].map(match => amountCents(match[1]!, match[2])));
const moneySupport = (failed: string[]): Support<number> => ({ failed, holds: (value, quote) => dollarAmountsInCents(quote).includes(BigInt(value)) });

const NUMBER_WORDS = new Map<string, number>([
  ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11],
  ["twelve", 12], ["thirteen", 13], ["fourteen", 14], ["fifteen", 15], ["sixteen", 16], ["seventeen", 17], ["eighteen", 18], ["nineteen", 19], ["twenty", 20],
  ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80], ["ninety", 90], ["hundred", 100], ["thousand", 1000],
]);
function wordRunValue(words: readonly string[]): number {
  let total = 0, current = 0;
  for (const word of words) {
    const value = NUMBER_WORDS.get(word)!;
    if (word === "hundred") current = (current || 1) * 100;
    else if (word === "thousand") { total += (current || 1) * 1000; current = 0; }
    else current += value;
  }
  return total + current;
}
// Numbers spelled as English words, read as runs: "thirty", "forty-five", "one hundred and twenty". A run joins words by spaces or hyphens only
// ("and" only after hundred or thousand), so "ten and twenty" is two numbers and "thirty (30)" ends the run at the parenthesis.
export function wordNumbersIn(quote: string): Set<number> {
  const found = new Set<number>();
  let run: string[] = [];
  const flush = () => { if (run.length) found.add(wordRunValue(run)); run = []; };
  for (const token of quote.toLowerCase().match(/[a-z]+|[^a-z]+/g) ?? []) {
    if (/^[a-z]/.test(token)) {
      if (NUMBER_WORDS.has(token)) run.push(token);
      else if (token === "and" && (run.at(-1) === "hundred" || run.at(-1) === "thousand")) continue;
      else flush();
    } else if (!/^[\s-]+$/.test(token)) flush();
  }
  flush();
  return found;
}
// Plain digit runs only: "30" and "30-day" count, "$30", "1,500" and "30.5" do not, so a dollar amount cannot pass as a day count.
export const digitNumbersIn = (quote: string): Set<number> => new Set([...quote.matchAll(/\$?\d+(?:[,.]\d+)*/g)].map(match => match[0]).filter(token => /^\d+$/.test(token)).map(Number));
const daysSupport = (failed: string[]): Support<number> => ({ failed, holds: (value, quote) => digitNumbersIn(quote).has(value) || wordNumbersIn(quote).has(value) });
// A full ISO date (YYYY-MM-DD) is supported by the quote only when the quote states that exact date: the ISO string as a whole token ("2026-09-011" and
// "12026-09-01" do not count) or an English month name with the same day and year ("October 1, 2026", "October 1st, 2026", "1 October 2026"). A right year
// with a wrong month or day does not hold, and numeric slashes such as 10/01/2026 are ambiguous, so they do not count either (the human fills the date).
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const dateSupport = (failed: string[]): Support<string> => ({ failed, holds: (value, quote) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  if (new RegExp(String.raw`(?<!\d)${value}(?!\d)`).test(quote)) return true;
  const name = MONTH_NAMES[Number(month) - 1];
  if (!name) return false;
  const dayText = String.raw`(?<!\d)0?${Number(day)}(?:st|nd|rd|th)?(?!\d)`;
  const written = [String.raw`${name}\s+${dayText},?\s+${year}`, String.raw`${dayText}\s+${name},?\s+${year}`];
  return written.some(pattern => new RegExp(String.raw`\b${pattern}(?!\d)`, "i").test(quote));
} });

function readField<T>(raw: unknown, path: string, mode: DraftMode, clauses: ReadonlyMap<string, string>, parse: (value: unknown) => T, support?: Support<T>): DraftField<T> {
  const field = exactKeys(raw, ["status", "value", "clauseId", "quote"], path);
  if (field.status === "UNSURE") {
    // MODEL mode: the output schema has no null (see the schema comment in draft-request.ts), so a model writes the empty value ("", [], 0) for an UNSURE
    // part. Whatever an UNSURE field carries is discarded and the field becomes the stored UNSURE with null parts. UNSURE never binds, so a value left
    // here (a guess the model labelled UNSURE) has no effect: it is not kept, not shown and not counted. Nothing new is recorded for it.
    if (mode === "MODEL") return { status: "UNSURE", value: null, clauseId: null, quote: null };
    // EDIT mode (a stored draft, which always holds null parts): a field the text does not settle has no value and no source.
    if (field.value !== null || field.clauseId !== null || field.quote !== null) throw new Refuse("UNSURE_HAS_VALUE", path);
    return { status: "UNSURE", value: null, clauseId: null, quote: null };
  }
  const status = field.status === "DRAFTED" ? "DRAFTED" : field.status === "EDITED" && mode === "EDIT" ? "EDITED" : null;
  if (!status) throw new Refuse("STATUS_INVALID", path);
  if (field.value === null || field.value === undefined) throw new Refuse("DRAFTED_NO_VALUE", path);
  const value = parse(field.value);
  if (status === "EDITED" && field.clauseId === null && field.quote === null) return { status, value, clauseId: null, quote: null };
  if (typeof field.clauseId !== "string" || !clauses.has(field.clauseId)) throw new Refuse("CITATION_MISSING", path);
  if (typeof field.quote !== "string" || field.quote.trim().length === 0 || codePoints(field.quote) > CLAUSE_MAX_CHARS) throw new Refuse("QUOTE_INVALID", path);
  // The quote must be text of the clause it cites.
  if (!clauses.get(field.clauseId)!.includes(field.quote)) throw new Refuse("QUOTE_NOT_IN_CLAUSE", path);
  if (support && !support.holds(value, field.quote)) {
    // A stored draft already went through this check, so a failure in EDIT mode means the document changed after it was made: refuse it.
    if (mode === "EDIT") throw new Refuse("QUOTE_UNSUPPORTED", path);
    support.failed.push(path);
    return { status: "UNSURE", value: null, clauseId: null, quote: null };
  }
  return { status, value, clauseId: field.clauseId, quote: field.quote };
}

function stringList(path: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(item => typeof item !== "string")) throw new Refuse("SHAPE", path);
  if (new Set(value).size !== value.length) throw new Refuse("DUPLICATE_VALUE", path);
  return [...value] as string[];
}

// The categories a fund policy may allow. A category that is prohibited by the organization, or that the app maps to the "prohibited" sentinel
// (alcohol, gift cards), never appears in an allowed list, whatever the grant text or any instruction inside it says.
const budgetLineOf = (category: string): BudgetLine | null => {
  if (!hasOwn(BUDGET_LINE, category)) return null;
  const line = (BUDGET_LINE as Record<string, BudgetLine | "prohibited">)[category]!;
  return line === "prohibited" ? null : line;
};
export const requiredBudgetLines = (categories: readonly string[]): BudgetLine[] =>
  BUDGET_LINES.filter(line => categories.some(category => budgetLineOf(category) === line));

export function validateDraft(raw: unknown, input: GrantInput, mode: DraftMode): Validated {
  try {
    return build(raw, input, mode);
  } catch (error) {
    if (error instanceof Refuse) return { ok: false, reason: error.reason, path: error.path };
    throw error;
  }
}

// The paths a model value can be downgraded at: exactly the fields that have a mechanical support check.
const SUPPORT_PATHS: readonly string[] = ["periodStart", "periodEnd", ...BUDGET_LINES.map(line => `caps.${line}`), ...THRESHOLD_KEYS.map(key => `thresholds.${key}`)];
const TOP_KEYS = ["clauses", "programs", "allowedCategories", "periodStart", "periodEnd", "breadth", "caps", "thresholds", "summary"];

function build(raw: unknown, input: GrantInput, mode: DraftMode): Validated {
  assertWellFormed(raw, "draft");
  // A stored draft may carry quoteUnsupported. A model answer never may: the validator is the only writer.
  const stored = mode === "EDIT" && isRecord(raw) && hasOwn(raw, "quoteUnsupported");
  const top = exactKeys(raw, stored ? [...TOP_KEYS, "quoteUnsupported"] : TOP_KEYS, "draft");
  let carriedUnsupported: string[] = [];
  if (stored) {
    const list = top.quoteUnsupported;
    if (!Array.isArray(list) || list.length < 1 || list.some(path => typeof path !== "string" || !SUPPORT_PATHS.includes(path)) || new Set(list).size !== list.length) throw new Refuse("SHAPE", "quoteUnsupported");
    carriedUnsupported = list as string[];
  }
  const failed: string[] = [];

  // Clauses: verbatim from the pasted text, numbered, unique, bounded.
  if (!Array.isArray(top.clauses)) throw new Refuse("SHAPE", "clauses");
  if (top.clauses.length < 1) throw new Refuse("NO_CLAUSES", "clauses");
  if (top.clauses.length > CLAUSE_MAX_COUNT) throw new Refuse("CLAUSE_COUNT", "clauses");
  const clauses: DraftClause[] = [];
  const clauseText = new Map<string, string>();
  top.clauses.forEach((entry, index) => {
    const path = `clauses.${index}`;
    const clause = exactKeys(entry, ["id", "text"], path);
    if (typeof clause.id !== "string" || !CLAUSE_ID.test(clause.id)) throw new Refuse("CLAUSE_ID", path);
    if (clauseText.has(clause.id)) throw new Refuse("CLAUSE_DUPLICATE", path);
    if (typeof clause.text !== "string") throw new Refuse("SHAPE", path);
    // An exact substring of the pasted text. Only surrounding whitespace is dropped afterwards, which keeps it a substring.
    if (!input.text.includes(clause.text)) throw new Refuse("CLAUSE_NOT_SUBSTRING", path);
    const text = clause.text.trim();
    if (codePoints(text) < 1 || codePoints(text) > CLAUSE_MAX_CHARS) throw new Refuse("CLAUSE_LENGTH", path);
    clauseText.set(clause.id, text);
    clauses.push({ id: clause.id, text });
  });

  const programs = readField(top.programs, "programs", mode, clauseText, value => {
    const list = stringList("programs", value);
    for (const program of list) if (!PROGRAM_ID.test(program) || !input.programs.includes(program)) throw new Refuse("PROGRAM_UNKNOWN", "programs");
    return list;
  });
  const allowedCategories = readField(top.allowedCategories, "allowedCategories", mode, clauseText, value => {
    const list = stringList("allowedCategories", value);
    for (const category of list) {
      if (input.prohibited.includes(category) || (hasOwn(BUDGET_LINE, category) && budgetLineOf(category) === null)) throw new Refuse("PROHIBITED_CATEGORY", "allowedCategories");
      if (!input.categories.includes(category) || budgetLineOf(category) === null) throw new Refuse("CATEGORY_UNKNOWN", "allowedCategories");
    }
    return list;
  });
  const periodStart = readField(top.periodStart, "periodStart", mode, clauseText, value => isoDate(value, "periodStart"), dateSupport(failed));
  const periodEnd = readField(top.periodEnd, "periodEnd", mode, clauseText, value => isoDate(value, "periodEnd"), dateSupport(failed));
  if (periodStart.value !== null && periodEnd.value !== null && periodStart.value > periodEnd.value) throw new Refuse("DATE_ORDER", "periodEnd");

  // Breadth is the category count, and it is null exactly when the categories are UNSURE. The model schema has no null, so in MODEL mode a breadth of 0
  // with UNSURE categories is that null. Any other breadth, including 0 beside drafted categories, is compared as before.
  const count = allowedCategories.value === null ? null : allowedCategories.value.length;
  const breadth = mode === "MODEL" && count === null && top.breadth === 0 ? null : top.breadth;
  if (breadth !== count) throw new Refuse("BREADTH_MISMATCH", "breadth");

  const capsRaw = exactKeys(top.caps, BUDGET_LINES, "caps");
  const caps = {} as Record<BudgetLine, DraftField<number>>;
  for (const line of BUDGET_LINES) caps[line] = readField(capsRaw[line], `caps.${line}`, mode, clauseText, centsValue(`caps.${line}`), moneySupport(failed));
  const thresholdsRaw = exactKeys(top.thresholds, THRESHOLD_KEYS, "thresholds");
  const thresholds = {} as Record<ThresholdKey, DraftField<number>>;
  for (const key of THRESHOLD_KEYS) {
    const days = THRESHOLD_DAY_KEYS.includes(key);
    thresholds[key] = readField(thresholdsRaw[key], `thresholds.${key}`, mode, clauseText, (days ? daysValue : centsValue)(`thresholds.${key}`), days ? daysSupport(failed) : moneySupport(failed));
  }

  if (typeof top.summary !== "string") throw new Refuse("SHAPE", "summary");
  const summary = top.summary.trim();
  if (codePoints(summary) < 1 || codePoints(summary) > SUMMARY_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(summary)) throw new Refuse("SUMMARY_INVALID", "summary");

  // In MODEL mode the list is what this pass downgraded. In EDIT mode it is the stored list minus any path a person has since filled.
  const valueAt = (path: string): unknown => (path === "periodStart" ? periodStart.value : path === "periodEnd" ? periodEnd.value
    : path.startsWith("caps.") ? caps[path.slice(5) as BudgetLine].value : thresholds[path.slice(11) as ThresholdKey].value);
  const unsupported = mode === "MODEL" ? failed : carriedUnsupported.filter(path => valueAt(path) === null);
  const draft: RulesDraft = { clauses, programs, allowedCategories, periodStart, periodEnd, breadth: count, caps, thresholds, summary, ...(unsupported.length ? { quoteUnsupported: unsupported } : {}) };
  const analysis = analyze(draft);
  // A complete draft must be a policy prepare() accepts. This is the check that the mirror above is complete.
  if (analysis.complete) {
    try { probePrepare(toPolicy(draft)!, input.prohibited); } catch { throw new Refuse("PREPARE_REJECTED", "draft"); }
  }
  return { ok: true, draft, analysis };
}

// What still needs a person. Thresholds are not required: an UNSURE threshold carries the previous version's value when the draft binds.
export function analyze(draft: RulesDraft): Analysis {
  const missing: string[] = [];
  const categories = draft.allowedCategories.value;
  if (draft.programs.value === null) missing.push("programs");
  if (categories === null) missing.push("allowedCategories");
  if (draft.periodStart.value === null) missing.push("periodStart");
  if (draft.periodEnd.value === null) missing.push("periodEnd");
  if (categories !== null) for (const line of requiredBudgetLines(categories)) if (draft.caps[line].value === null) missing.push(`caps.${line}`);
  return { complete: missing.length === 0, missing, carried: THRESHOLD_KEYS.filter(key => draft.thresholds[key].value === null), quoteUnsupported: [...(draft.quoteUnsupported ?? [])] };
}

// The policy row values and budget lines a complete draft binds. Null when anything required is missing.
export function toPolicy(draft: RulesDraft): BindablePolicy | null {
  const { programs, allowedCategories, periodStart, periodEnd } = { programs: draft.programs.value, allowedCategories: draft.allowedCategories.value, periodStart: draft.periodStart.value, periodEnd: draft.periodEnd.value };
  if (!programs || !allowedCategories || !periodStart || !periodEnd || !analyze(draft).complete) return null;
  const budgetLines = BUDGET_LINES.flatMap(line => { const cap = draft.caps[line].value; return cap === null ? [] : [{ budgetLine: line, capCents: BigInt(cap) }]; });
  return { programs: [...programs], allowedCategories: [...allowedCategories], periodStart, periodEnd, breadth: allowedCategories.length, summary: draft.summary, budgetLines };
}

// Runs src/domain/model.ts prepare() over the policy with one eligible probe line per allowed category. It throws exactly when prepare() would
// reject a real claim against this policy for a structural reason (shape, period, breadth, a missing budget line).
export function probePrepare(policy: BindablePolicy, prohibited: readonly string[]) {
  const fund: FundSnapshot = {
    id: "probe", name: "Probe fund", fundClass: "RESTRICTED", balanceCents: 0n,
    policy: { version: 1, approvedBy: "probe", summary: policy.summary, programs: policy.programs, allowedCategories: policy.allowedCategories, periodStart: policy.periodStart, periodEnd: policy.periodEnd, breadth: policy.breadth },
    budgetLines: policy.budgetLines.map(line => ({ id: line.budgetLine, capCents: line.capCents })),
  };
  const lines: ClaimLine[] = policy.allowedCategories.map((category, index) => ({ id: `P${index + 1}`, category, budgetLine: budgetLineOf(category) ?? "prohibited", incurredOn: policy.periodStart, amountCents: 1n }));
  prepare({ program: policy.programs[0]!, prohibitedCategories: prohibited, solverPriority: { version: 1, approvedBy: "probe" }, lines, funds: [fund], priorDebits: [], reservations: [] });
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// A person changes values. The new document is built from the parent and revalidated whole, so an edit can never skip a rule the model draft met.
// Only fields whose value differs from the parent count as changed. A changed field loses its citation: the old quote no longer supports the new value.
export function applyEdit(parent: RulesDraft, edit: unknown, input: GrantInput): (Validated & { changed: string[] }) {
  try {
    const patch = exactKeysSubset(edit, ["programs", "allowedCategories", "periodStart", "periodEnd", "caps", "thresholds", "summary"], "edit");
    const next = structuredClone(parent);
    const changed: string[] = [];
    const set = <T>(path: string, current: DraftField<T>, value: unknown): DraftField<T> => {
      if (value === null) { if (current.value === null) return current; changed.push(path); return { status: "UNSURE", value: null, clauseId: null, quote: null }; }
      if (current.value !== null && same(current.value, value)) return current;
      changed.push(path);
      return { status: "EDITED", value: value as T, clauseId: null, quote: null };
    };
    if ("programs" in patch) next.programs = set("programs", next.programs, patch.programs);
    if ("allowedCategories" in patch) next.allowedCategories = set("allowedCategories", next.allowedCategories, patch.allowedCategories);
    if ("periodStart" in patch) next.periodStart = set("periodStart", next.periodStart, patch.periodStart);
    if ("periodEnd" in patch) next.periodEnd = set("periodEnd", next.periodEnd, patch.periodEnd);
    if ("caps" in patch) {
      const caps = exactKeysSubset(patch.caps, BUDGET_LINES, "edit.caps");
      for (const line of BUDGET_LINES) if (line in caps) next.caps[line] = set(`caps.${line}`, next.caps[line], caps[line]);
    }
    if ("thresholds" in patch) {
      const thresholds = exactKeysSubset(patch.thresholds, THRESHOLD_KEYS, "edit.thresholds");
      for (const key of THRESHOLD_KEYS) if (key in thresholds) next.thresholds[key] = set(`thresholds.${key}`, next.thresholds[key], thresholds[key]);
    }
    if ("summary" in patch) {
      if (typeof patch.summary !== "string") throw new Refuse("SUMMARY_INVALID", "summary");
      if (patch.summary !== next.summary) { next.summary = patch.summary; changed.push("summary"); }
    }
    if (changed.length === 0) throw new Refuse("NO_CHANGE", "edit");
    next.breadth = next.allowedCategories.value === null ? null : Array.isArray(next.allowedCategories.value) ? next.allowedCategories.value.length : -1;
    const result = validateDraft(next, input, "EDIT");
    return result.ok ? { ...result, changed } : { ...result, changed: [] };
  } catch (error) {
    if (error instanceof Refuse) return { ok: false, reason: error.reason, path: error.path, changed: [] };
    throw error;
  }
}
function exactKeysSubset(value: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some(key => !allowed.includes(key))) throw new Refuse("SHAPE", path);
  return value;
}
