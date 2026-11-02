import { SELECTABLE } from "../../src/ai/categories";
import type { GrantInput } from "../../src/rules-draft/draft-validate";
import { claudeMessage } from "./claude-stub";

// IAC-440 Package A test helpers (docs/GATE_REPORT.md section 58). A synthetic grant agreement for the robotics fund as the fixture describes it,
// the catalogs the service builds for the fixture organization, and a builder for a raw model answer. Nothing here calls a model or reads a key.
// Nothing imports vitest, so the eval harness test may use it too.
export const AGREEMENT = [
  "Grant agreement between Cedar Hollow Community Fund and the Eastside Robotics Club.",
  "Section 1. Funds may be used only for direct costs of the robotics afterschool program: robot kits, robot parts and classroom supplies.",
  "Section 2. The grant period begins on 2026-09-01 and ends on 2027-06-30.",
  "Section 3. Spending on supplies may not exceed $300.00 in total.",
  "Section 4. Gift cards and alcoholic beverages are not allowable under any circumstances.",
  "Section 5. A single claim may not exceed $1,200.00.",
  "Section 6. Check settings: supplies purchases may not exceed $250.00 per receipt and equipment purchases $500.00 per receipt; a single first claim may not exceed $1,000.00; receipts older than 60 days are stale; the same receipt may not be paid twice within 90 days; purchases from one vendor are combined over 3 days.",
].join("\n");
export const CLAUSE_SCOPE = "Section 1. Funds may be used only for direct costs of the robotics afterschool program: robot kits, robot parts and classroom supplies.";
export const CLAUSE_PERIOD = "Section 2. The grant period begins on 2026-09-01 and ends on 2027-06-30.";
export const CLAUSE_CAP = "Section 3. Spending on supplies may not exceed $300.00 in total.";
export const CLAUSE_BANNED = "Section 4. Gift cards and alcoholic beverages are not allowable under any circumstances.";
export const CLAUSE_LIMIT = "Section 5. A single claim may not exceed $1,200.00.";
export const CLAUSE_CHECKS = "Section 6. Check settings: supplies purchases may not exceed $250.00 per receipt and equipment purchases $500.00 per receipt; a single first claim may not exceed $1,000.00; receipts older than 60 days are stale; the same receipt may not be paid twice within 90 days; purchases from one vendor are combined over 3 days.";

// What the service builds for the fixture organization: every selectable category, the program ids its policy versions use, its prohibited list.
export const GRANT: GrantInput = { text: AGREEMENT, categories: [...SELECTABLE], programs: ["robotics"], prohibited: ["alcohol", "gift_cards"] };

export type Field = { status: "DRAFTED" | "UNSURE" | "EDITED"; value: unknown; clauseId: string | null; quote: string | null };
// The model output schema has no null (the API refuses more than 16 union-typed parameters), so an UNSURE part of a model answer is the empty value:
// "" for a text value, [] for a list, 0 for an integer, and "" for clauseId and quote. unsure() is the integer form (caps and thresholds), unsureList() the
// list form (programs, allowedCategories) and unsureText() the text form (the period dates). storedUnsure() is the stored shape (EDIT mode, the drafts
// table): null parts, which is never model output.
export const unsure = (empty: unknown = 0): Field => ({ status: "UNSURE", value: empty, clauseId: "", quote: "" });
export const unsureList = (): Field => unsure([]);
export const unsureText = (): Field => unsure("");
export const storedUnsure = (): Field => ({ status: "UNSURE", value: null, clauseId: null, quote: null });
export const drafted = (value: unknown, clauseId: string, quote: string): Field => ({ status: "DRAFTED", value, clauseId, quote });

// A raw answer that satisfies every rule. A test copies it and breaks one thing.
export function goodAnswer(): Record<string, any> {
  return {
    clauses: [{ id: "1.1", text: CLAUSE_SCOPE }, { id: "1.2", text: CLAUSE_PERIOD }, { id: "1.3", text: CLAUSE_CAP }],
    programs: drafted(["robotics"], "1.1", "robotics afterschool program"),
    allowedCategories: drafted(["robot_kits_parts", "classroom_supplies"], "1.1", "robot kits, robot parts and classroom supplies"),
    periodStart: drafted("2026-09-01", "1.2", "begins on 2026-09-01"),
    periodEnd: drafted("2027-06-30", "1.2", "ends on 2027-06-30"),
    breadth: 2,
    caps: { supplies: drafted(30000, "1.3", "$300.00"), other: unsure(), travel: unsure(), equipment: unsure(), contractual: unsure() },
    thresholds: { suppliesLimitCents: unsure(), equipmentLimitCents: unsure(), claimLimitCents: unsure(), staleReceiptDays: unsure(), duplicateWindowDays: unsure(), splitWindowDays: unsure() },
    summary: "Pays direct costs of the robotics afterschool program: robot kits, robot parts and classroom supplies.",
  };
}

// The same answer with a threshold the agreement states (section 5), for the paths that write a check settings version.
export function answerWithThresholds(): Record<string, any> {
  const answer = goodAnswer();
  answer.clauses.push({ id: "1.4", text: CLAUSE_LIMIT });
  answer.thresholds.claimLimitCents = drafted(120000, "1.4", "$1,200.00");
  return answer;
}

// The answer with all six thresholds, each quoted from section 6 of the agreement (clause 1.5), so every one passes the support check.
export const STATED_THRESHOLDS = { suppliesLimitCents: 25000, equipmentLimitCents: 50000, claimLimitCents: 100000, staleReceiptDays: 60, duplicateWindowDays: 90, splitWindowDays: 3 } as const;
export function answerWithAllThresholds(): Record<string, any> {
  const answer = goodAnswer();
  answer.clauses.push({ id: "1.5", text: CLAUSE_CHECKS });
  const quotes = { suppliesLimitCents: "$250.00", equipmentLimitCents: "$500.00", claimLimitCents: "$1,000.00", staleReceiptDays: "60 days", duplicateWindowDays: "90 days", splitWindowDays: "3 days" };
  for (const [key, value] of Object.entries(STATED_THRESHOLDS)) answer.thresholds[key] = drafted(value, "1.5", quotes[key as keyof typeof quotes]);
  return answer;
}

// The model answers in the flat wire shape: every part of every drafted field is a top-level key, programs_status, programs_value, caps_supplies_quote and
// so on (src/rules-draft/draft-request.ts). Tests keep writing the nested answer, which is what the validator reads, and flatAnswer() turns it into the
// wire shape. It is written here on purpose and does not import src/rules-draft: a round trip through the real unflattenDraft would otherwise be circular.
// It never repairs anything: a missing or extra part becomes a missing or extra flat key, and anything that is not a plain object passes through.
const WIRE_PLAIN = ["programs", "allowedCategories", "periodStart", "periodEnd"];
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function flatAnswer(answer: unknown): unknown {
  if (!isPlain(answer)) return answer;
  const flat: Record<string, unknown> = {};
  const spread = (name: string, field: unknown) => { if (isPlain(field)) for (const [part, value] of Object.entries(field)) flat[`${name}_${part}`] = value; else flat[name] = field; };
  for (const [key, value] of Object.entries(answer)) {
    if (WIRE_PLAIN.includes(key)) spread(key, value);
    else if ((key === "caps" || key === "thresholds") && isPlain(value)) for (const [name, field] of Object.entries(value)) spread(`${key}_${name}`, field);
    else flat[key] = value;
  }
  return flat;
}

// An Anthropic Message holding a draft answer, as the API returns a structured output: the nested answer a test writes, sent in the flat wire shape.
export const draftMessage = (answer: unknown, model = "claude-sonnet-5-5", over: Record<string, unknown> = {}) => claudeMessage(flatAnswer(answer), model, over);
export const RULE_ENV = { AI_RULE_DRAFTS_ENABLED: "true", ANTHROPIC_API_KEY: "test-key-not-real" };
