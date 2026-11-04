import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCategoryRequest } from "../src/ai/claude-receipt";
import { photoRequest } from "../src/ai/claude-photo";
import { analyticsRequest } from "../src/analytics/explain";
import type { AnalyticsSnapshot } from "../src/analytics/model";
import { complianceRequest } from "../src/policy/compliance";
import { draftSchema } from "../src/rules-draft/draft-request";
import { BUDGET_LINES, THRESHOLD_KEYS } from "../src/rules-draft/draft-validate";
import { GRANT } from "./support/rules-draft";
import { DRAFTED_FIELDS, EXPECTED_KEYS, PARTS, UNION_LIMIT, expectClosedObjects, expectFlatShape, expectKeysAgree, expectNoUnion, expectOnlyClausesHoldObjects, expectUnflattenExact, objectCount, objectDepth, plantedGrants, unionCount } from "./support/rules-draft-schema";

// IAC-442: the dataset-grant runs of these checks and the five donor-note harness schemas of DR-62 moved to the owner-only tests/rules-draft-schema-harness.test.ts,
// because they import scripts/support/rules-draft-eval, donor-note-eval, donor-note-reason and donor-note-3c, which the judge export omits. The schema model and the per-grant
// checks are in tests/support/rules-draft-schema.ts and run here over the planted grants and there over every dataset grant.

// IAC-440 Package A schema fix, DR-61, DR-62, DR-77 and DR-78 (docs/GATE_REPORT.md section 58): a union count and a shape guard over every JSON schema that
// is sent as a structured output.
//
// Why this file exists. The first real evaluation (November 1, 24 of 24 calls) was refused by the API before any model ran, HTTP 400 invalid_request_error:
//   "Schemas contains too many parameters with union types (46 parameters with type arrays or anyOf). This causes exponential compilation cost.
//    Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions)."
// The limit is enforced only by the API, so every stub-client test passed while the real request could not succeed. A nullable field is a union
// (anyOf with a null branch or a type array), so it counts. Counting them in the schema itself is the only defense a test can give without a real request.
//
// The second refusal (November 1, one diagnostic call per model after the union fix, the nested v2 schema with zero unions, 19 objects, 82 properties, depth 3):
// both claude-haiku-5-5 and claude-sonnet-5-5 answered HTTP 400 invalid_request_error:
//   "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools."
// The API publishes no number for this limit. Probes with max_tokens 1 and no effort compiled the flat form (every part of every drafted field a top-level key)
// on both models, so nesting and not the property count drives the compiled size. DR-77 pins the flat shape: two objects, depth two and 63 properties. These
// tests do not call the API and cannot show that the grammar compiles. They stop a nested or wider schema from returning unnoticed.
// The grants checked here are the three planted shapes (no program ids, an empty prohibited list, a one-category catalog); the dataset grants are in the owner-only file.
const grants = plantedGrants;

describe("DR-61 the draft output schema has no union type, for every grant", () => {
  it("has zero anyOf and zero type arrays for the planted grants: a grant with no programs and the other planted shapes", () => {
    const list = grants();
    expect(list.length).toBe(3);
    for (const { name, grant } of list) expectNoUnion(name, grant);
  });
  it("closes every object, requires every property, and uses no keyword the API documents as unsupported", () => {
    for (const { name, grant } of grants()) expectClosedObjects(name, grant);
  });
  it("every drafted field is the same four plain top-level parts, and breadth is a plain integer", () => {
    const schema = draftSchema(GRANT) as any;
    const flatNames = ["programs", "allowedCategories", "periodStart", "periodEnd", ...BUDGET_LINES.map(line => `caps_${line}`), ...THRESHOLD_KEYS.map(key => `thresholds_${key}`)];
    expect(flatNames).toHaveLength(15);
    for (const name of flatNames) {
      expect(Object.keys(schema.properties).filter(key => key.startsWith(`${name}_`) && ["status", "value", "clauseId", "quote"].includes(key.slice(name.length + 1))), name)
        .toEqual(["status", "value", "clauseId", "quote"].map(part => `${name}_${part}`));
      expect(schema.properties[`${name}_status`], name).toEqual({ type: "string", enum: ["DRAFTED", "UNSURE"] });
      expect(schema.properties[`${name}_clauseId`], name).toEqual({ type: "string" }); expect(schema.properties[`${name}_quote`], name).toEqual({ type: "string" });
    }
    expect(schema.properties.breadth).toEqual({ type: "integer" });
    expect(schema.properties.summary).toEqual({ type: "string" });
    expect(flatNames.map(name => schema.properties[`${name}_value`].type)).toEqual(["array", "array", "string", "string", ...Array(5).fill("integer"), ...Array(6).fill("integer")]);
    expect(schema.properties.clauses).toEqual({ type: "array", items: { type: "object", additionalProperties: false, required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" } } } });
  });
  it("the counter reproduces the API's number: the schema as it was before the fix counts exactly 46 and the new one counts 0", () => {
    // Rebuild the pre-fix shape from the current schema: value, clauseId and quote of every drafted field become nullable, and so does breadth.
    const nullable = (node: unknown) => ({ anyOf: [node, { type: "null" }] });
    // A JSON round trip, as on the wire: draftSchema shares one object between the caps and the thresholds, and a structured clone would keep that sharing.
    const wire = () => JSON.parse(JSON.stringify(draftSchema(GRANT))) as any;
    const before = wire();
    const flatNames = ["programs", "allowedCategories", "periodStart", "periodEnd", ...BUDGET_LINES.map(line => `caps_${line}`), ...THRESHOLD_KEYS.map(key => `thresholds_${key}`)];
    for (const name of flatNames) for (const part of ["value", "clauseId", "quote"]) before.properties[`${name}_${part}`] = nullable(before.properties[`${name}_${part}`]);
    before.properties.breadth = nullable(before.properties.breadth);
    expect(unionCount(before)).toBe(46);
    expect(unionCount(before)).toBeGreaterThan(UNION_LIMIT);
    expect(unionCount(draftSchema(GRANT))).toBe(0);
    // One nullable quote on one field is what the mutation proof plants: the count moves off zero.
    const one = wire(); one.properties.caps_supplies_quote = nullable({ type: "string" });
    expect(unionCount(one)).toBe(1);
    expect(unionCount({ type: "object", properties: { a: { type: ["string", "null"] } } })).toBe(1);
  });
});

describe("DR-77 the draft output schema is flat, for every grant: two objects, depth two and 63 required top-level properties", () => {
  it("has exactly two objects, a maximum object depth of 2, 63 properties and every property required, for the planted shapes", () => {
    for (const { name, grant } of grants()) expectFlatShape(name, grant);
  });
  it("the only property that holds objects is clauses, and no drafted part is an object", () => {
    for (const { name, grant } of grants()) expectOnlyClausesHoldObjects(name, grant);
  });
  it("the 63 properties are 15 fields of four parts plus clauses, breadth and summary: the constants give 15 fields", () => {
    expect(BUDGET_LINES).toHaveLength(5); expect(THRESHOLD_KEYS).toHaveLength(6);
    expect(4 + BUDGET_LINES.length + THRESHOLD_KEYS.length).toBe(15);
    expect(15 * 4 + 3).toBe(63);
    expect(DRAFTED_FIELDS).toHaveLength(15);
  });
  it("the guard sees a nested schema: re-nesting the caps as one object moves the object count, the depth and the property count", () => {
    const wire = JSON.parse(JSON.stringify(draftSchema(GRANT))) as any;
    const caps = DRAFTED_FIELDS.filter(name => name.startsWith("caps_")).flatMap(name => PARTS.map(part => `${name}_${part}`));
    const nested = { type: "object", additionalProperties: false, required: caps, properties: Object.fromEntries(caps.map(key => [key, wire.properties[key]])) };
    for (const key of caps) delete wire.properties[key];
    wire.properties.caps = nested; wire.required = Object.keys(wire.properties);
    expect(objectCount(wire)).toBe(3); expect(objectDepth(wire)).toBe(2); expect(Object.keys(wire.properties)).toHaveLength(44); // 63 minus the 20 caps keys plus one caps object
    // Depth moves only with a second level: a drafted part that is itself an object inside caps.
    wire.properties.caps.properties.caps_supplies_value = { type: "object", additionalProperties: false, required: [], properties: {} };
    expect(objectDepth(wire)).toBe(3);
  });
});

describe("DR-78 the schema keys and the keys the unflatten step accepts are the same list, for every grant", () => {
  it("the test's own written-out list has 63 unique keys", () => {
    expect(EXPECTED_KEYS).toHaveLength(63); expect(new Set(EXPECTED_KEYS).size).toBe(63);
  });
  it("Object.keys of the schema properties equals flatDraftKeys() and the written-out list, in order, for each grant", () => {
    for (const { name, grant } of grants()) expectKeysAgree(name, grant);
  });
  it("unflattenDraft accepts an object built from exactly the schema keys for each grant, and refuses it with one key dropped or one key added", () => {
    for (const { name, grant } of grants()) expectUnflattenExact(name, grant);
  });
});

describe("DR-62 every other Claude output schema stays within the documented union limit of 16", () => {
  const snapshot: AnalyticsSnapshot = { digest: "a".repeat(64), observedAt: "2026-11-01T12:00:00Z", source: "LOCAL_APPLICATION_DATABASE", organization: "Invented fixture", fixture: true, matches: true,
    funds: [], cash: { openingCents: "150000", providerDeltaCents: "0", bookCents: "150000", payableCents: "0" },
    facts: [{ id: "cash", text: "Book cash is $1,500.00.", source: "local journals" }, { id: "opening", text: "Opening cash was $1,500.00.", source: "local journals" }] };
  // The request builders type output_config as optional, so it is read through a cast here.
  const schemaOf = (config: unknown) => (config as { format: { schema: unknown } }).format.schema;
  const schemas: [string, unknown][] = [
    ["receipt categorizer (src/ai/claude-receipt.ts)", schemaOf(claudeCategoryRequest("claude-haiku-5-5", { source: "RECEIPT\nRobot kit", lines: [{ id: "L1", description: "Robot kit" }] }).output_config)],
    ["compliance check (src/policy/compliance.ts)", complianceRequest("claude-sonnet-5-5", { fundName: "Robotics", clauses: [{ id: "1.1", text: "Funds pay robot kits." }], vendor: "Shop", date: "2026-11-01", lines: [{ id: "L1", description: "Robot kit", amountCents: 1000 }] }).output_config.format.schema],
    ["receipt photo reader (src/ai/claude-photo.ts)", schemaOf(photoRequest("claude-haiku-5-5", "image/png", "AAAA").output_config)],
    ["analytics selector (src/analytics/explain.ts)", schemaOf(analyticsRequest("claude-haiku-5-5", snapshot, "cash").output_config)],
  ];
  it("counts each schema's unions against the limit, read only: none of these schemas was changed by the fix (the donor note harness schemas are counted in the owner-only file)", () => {
    for (const [name, schema] of schemas) expect(unionCount(schema), name).toBeLessThanOrEqual(UNION_LIMIT);
  });
  it("pins today's counts so a new union in any of them is noticed: only the compliance clauseId is nullable", () => {
    expect(Object.fromEntries(schemas.map(([name, schema]) => [name.split(" (")[0], unionCount(schema)]))).toEqual({
      "receipt categorizer": 0, "receipt photo reader": 0, "compliance check": 1, "analytics selector": 0,
    });
  });
  it("finds every json_schema request builder in src, so a new Claude schema cannot be added without being counted here", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
    const builders = walk("src").filter(file => file.endsWith(".ts") && /type:\s*["']json_schema["']/.test(readFileSync(file, "utf8"))).sort();
    expect(builders).toEqual(["src/ai/claude-photo.ts", "src/ai/claude-receipt.ts", "src/analytics/explain.ts", "src/policy/compliance.ts", "src/rules-draft/draft-request.ts"]);
  });
});
