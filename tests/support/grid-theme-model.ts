import { readFileSync } from "node:fs";
import { join } from "node:path";

// Models the browser's var() fallback chain. A real browser computes the same values: the e2e suite reads them from the page.
// Shared by tests/grid-foundation.test.ts (GS-03, exported) and the owner-only tests/grid-foundation-owner.test.ts (GS-04, IAC-442). Moved unchanged.
export const rootBlocks = (css: string) => [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map(match => match[1]!);
export const declarations = (blocks: string[]) => {
  const map = new Map<string, string>();
  for (const block of blocks) for (const part of block.split(";")) { const at = part.indexOf(":"); if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim()); }
  return map;
};
export function evaluate(value: string, vars: Map<string, string>): string {
  const call = /^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/.exec(value.trim());
  if (!call) return value.trim();
  const found = vars.get(call[1]!);
  if (found !== undefined && found !== "") return evaluate(found, vars);
  return call[2] === undefined ? "" : evaluate(call[2], vars);
}
export const aliasBlock = (() => { const css = readFileSync(join("src", "app", "grid", "grid.css"), "utf8"); return declarations([/\.gx-root\s*\{([^}]*)\}/.exec(css)![1]!]); })();
export const resolverFor = (css: string, font: string) => {
  const vars = declarations(rootBlocks(css));
  for (const [name, value] of aliasBlock) vars.set(name, evaluate(value, vars));
  return (name: string) => (name === "font-family" ? font : vars.get(name));
};
