import { readFileSync } from "node:fs";

// The stylesheet model shared by tests/trust-v2-tokens.test.ts (exported) and the owner-only tests/trust-v2-token-table.test.ts (IAC-442). Moved unchanged.
export const css = readFileSync("src/app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

export const squash = (text: string) => text.replace(/\s+/g, " ").trim();
export const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: squash(match[1]!), body: match[2]! }));
export const rootBlocks = rules.filter(rule => rule.selector === ":root");
export const declarations = (body: string) => body.split(";").map(part => part.trim()).filter(Boolean).map(part => {
  const colon = part.indexOf(":");
  return [part.slice(0, colon).trim(), squash(part.slice(colon + 1))] as const;
});
export const tokens = new Map<string, string>();
for (const block of rootBlocks) for (const [name, value] of declarations(block.body)) if (name.startsWith("--")) tokens.set(name, value);
