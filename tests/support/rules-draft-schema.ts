import { expect } from "vitest";
import { draftSchema, flatDraftKeys, unflattenDraft } from "../../src/rules-draft/draft-request";
import type { GrantInput } from "../../src/rules-draft/draft-validate";
import { GRANT } from "./rules-draft";

// The schema model and the per-grant checks shared by tests/rules-draft-schema.test.ts (exported, runs them over planted grants) and the owner-only
// tests/rules-draft-schema-harness.test.ts (runs the same checks over every grant of the paid evaluation dataset, which needs the owner-only harness).
// Moved unchanged from tests/rules-draft-schema.test.ts (IAC-442); the docs/GATE_REPORT.md section 58 notes on that file still apply.
export const UNION_LIMIT = 16;

// Schema nodes by structure: the node, each property, each array item and each anyOf branch. A property that happens to be named like a keyword is a key
// of `properties`, never read as a keyword.
export function* nodes(node: any): Generator<any> {
  yield node;
  for (const child of Object.values(node.properties ?? {})) yield* nodes(child);
  if (node.items) yield* nodes(node.items);
  for (const branch of node.anyOf ?? []) yield* nodes(branch);
}
// One union per node that has anyOf, oneOf or a type array. This is the count the API message reports: 15 fields x 3 nullable parts + breadth = 46.
export const unionCount = (schema: unknown) => [...nodes(schema)].filter(node => "anyOf" in node || "oneOf" in node || Array.isArray(node.type)).length;

const KEYWORDS = new Set(["type", "enum", "required", "additionalProperties", "items", "properties"]);
// Keywords that the structured outputs documentation lists as unsupported for a schema, plus the ones this repository's own comments record as unsupported.
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "pattern", "format", "$ref", "allOf", "not"];

// The shapes the dataset does not cover: no program ids, an empty prohibited list and a one-category catalog.
export const plantedGrants = (): { name: string; grant: GrantInput }[] => [
  { name: "no programs", grant: { ...GRANT, programs: [] } },
  { name: "no prohibited list", grant: { ...GRANT, prohibited: [] } },
  { name: "one category", grant: { ...GRANT, categories: ["robot_kits_parts"] } },
];

// The deepest chain of objects: the root is 1, and an object inside an array item or a property is one more. v2 was 3 (root, caps, a drafted field).
export const objectDepth = (node: any): number => {
  const below = Math.max(0, ...Object.values(node.properties ?? {}).map(objectDepth), node.items ? objectDepth(node.items) : 0);
  return node.type === "object" ? below + 1 : below;
};
export const objectCount = (schema: unknown) => [...nodes(schema)].filter(node => node.type === "object").length;
// 15 drafted fields x 4 parts, plus clauses, breadth and summary.
export const PARTS = ["status", "value", "clauseId", "quote"];
export const DRAFTED_FIELDS = ["programs", "allowedCategories", "periodStart", "periodEnd",
  ...["supplies", "other", "travel", "equipment", "contractual"].map(line => `caps_${line}`),
  ...["suppliesLimitCents", "equipmentLimitCents", "claimLimitCents", "staleReceiptDays", "duplicateWindowDays", "splitWindowDays"].map(key => `thresholds_${key}`)];
export const EXPECTED_KEYS = ["clauses", ...DRAFTED_FIELDS.slice(0, 4).flatMap(name => PARTS.map(part => `${name}_${part}`)), "breadth",
  ...DRAFTED_FIELDS.slice(4).flatMap(name => PARTS.map(part => `${name}_${part}`)), "summary"];

// DR-61: zero anyOf, zero type arrays.
export function expectNoUnion(name: string, grant: GrantInput) {
  const schema = draftSchema(grant);
  expect(unionCount(schema), name).toBe(0);
  const text = JSON.stringify(schema);
  expect(text, name).not.toContain("anyOf"); expect(text, name).not.toContain("oneOf"); expect(text, name).not.toContain('"null"');
  for (const node of nodes(schema)) expect(Array.isArray(node.type), name).toBe(false);
}
// DR-61: every object closed, every property required, no unsupported keyword.
export function expectClosedObjects(name: string, grant: GrantInput) {
  let objects = 0;
  for (const node of nodes(draftSchema(grant))) {
    for (const key of Object.keys(node)) { expect(KEYWORDS.has(key), `${name}: ${key}`).toBe(true); expect(UNSUPPORTED, `${name}: ${key}`).not.toContain(key); }
    if (node.type === "object") {
      objects += 1; expect(node.additionalProperties, name).toBe(false); expect([...node.required].sort(), name).toEqual(Object.keys(node.properties).sort());
    } else expect(node.additionalProperties, name).toBeUndefined();
  }
  expect(objects, name).toBe(2); // v3 (flat): the root and the clause item. v2 had 19: the root, the clause item, 15 drafted fields, caps and thresholds
}
// DR-77: two objects, depth two, 63 required top-level properties.
export function expectFlatShape(name: string, grant: GrantInput) {
  const schema = draftSchema(grant) as any;
  expect(objectCount(schema), name).toBe(2); // the root and the clause item
  expect(objectDepth(schema), name).toBe(2);
  expect(Object.keys(schema.properties), name).toHaveLength(63);
  expect(schema.required, name).toHaveLength(63);
  expect([...schema.required].sort(), name).toEqual(Object.keys(schema.properties).sort());
  expect(schema.additionalProperties, name).toBe(false);
  expect(unionCount(schema), name).toBe(0);
}
// DR-77: the only property that holds objects is clauses.
export function expectOnlyClausesHoldObjects(name: string, grant: GrantInput) {
  const schema = draftSchema(grant) as any;
  const holders = Object.entries(schema.properties).filter(([, node]) => [...nodes(node)].some(inner => inner.type === "object")).map(([key]) => key);
  expect(holders, name).toEqual(["clauses"]);
  for (const key of Object.keys(schema.properties)) if (key !== "clauses") expect(["string", "integer", "array"], `${name}: ${key}`).toContain(schema.properties[key].type);
}
// DR-78: the schema keys, flatDraftKeys() and the written-out list agree, in order.
export function expectKeysAgree(name: string, grant: GrantInput) {
  const keys = Object.keys((draftSchema(grant) as any).properties);
  expect(keys, name).toEqual(flatDraftKeys()); expect(keys, name).toEqual(EXPECTED_KEYS);
}
// DR-78: unflattenDraft accepts exactly the schema keys and refuses one dropped or one added.
export function expectUnflattenExact(name: string, grant: GrantInput) {
  const keys = Object.keys((draftSchema(grant) as any).properties);
  const full = Object.fromEntries(keys.map(key => [key, key]));
  expect(unflattenDraft(full).ok, name).toBe(true);
  for (const key of keys) { const rest = { ...full } as Record<string, string>; delete rest[key]; expect(unflattenDraft(rest).ok, `${name}: ${key}`).toBe(false); }
  expect(unflattenDraft({ ...full, extra_status: "x" }).ok, name).toBe(false);
}
