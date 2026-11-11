import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// MO-01 to MO-05 (November 10 motion pass, docs/DESIGN_LANGUAGE.md section 3 rule 8, docs/GATE_REPORT.md section 116). Static checks of src/app/style.css and
// src/app/template.tsx. No database, no network, no browser. MO-06 is the browser check in e2e/motion.spec.ts.
const css = readFileSync("src/app/style.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const NO_PREFERENCE = "@media (prefers-reduced-motion: no-preference) {";
const REDUCE = "@media (prefers-reduced-motion: reduce) {";

/** The inner text of every block that opens with the given at-rule, and the stylesheet with those blocks removed. */
function split(text: string, opener: string): { inner: string[]; outside: string } {
  const inner: string[] = []; let outside = ""; let from = 0;
  for (let at = text.indexOf(opener); at !== -1; at = text.indexOf(opener, from)) {
    outside += text.slice(from, at); let depth = 1, i = at + opener.length;
    for (; i < text.length && depth > 0; i++) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; }
    inner.push(text.slice(at + opener.length, i - 1)); from = i;
  }
  return { inner, outside: outside + text.slice(from) };
}
const declarationsOf = (text: string, property: string) => [...text.matchAll(new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`, "g"))].map(match => match[1]!.trim());
const seconds = (value: string) => [...value.matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map(match => Number(match[1]) / (match[2] === "ms" ? 1000 : 1));
const motion = split(css, NO_PREFERENCE);
const inside = motion.inner.join("\n");
const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map(match => ({ name: match[1]!, body: match[2]! }));

describe("MO-01 outside prefers-reduced-motion: no-preference the app only fades colors", () => {
  it("finds the motion block", () => expect(motion.inner).toHaveLength(1));
  it("has no animation outside it except the reduce block's none", () => {
    expect(declarationsOf(motion.outside, "animation").filter(value => value !== "none !important")).toEqual([]);
  });
  it("transitions only color and background-color, at 150 ms or less, outside it", () => {
    for (const value of declarationsOf(motion.outside, "transition").filter(value => value !== "none !important")) {
      for (const part of value.split(",")) expect(["color", "background-color"], part).toContain(part.trim().split(/\s+/)[0]);
      for (const time of seconds(value)) expect(time, value).toBeLessThanOrEqual(0.15);
    }
  });
});

describe("MO-02 inside it, motion is short", () => {
  it("keeps every transition at 240 ms or less", () => {
    const values = declarationsOf(inside, "transition"); expect(values.length).toBeGreaterThanOrEqual(3);
    for (const value of values) for (const time of seconds(value)) expect(time, value).toBeLessThanOrEqual(0.24);
  });
  it("keeps every animation at 240 ms or less, except the one-time meter fill, the pending spinner, the AI wait dot and the skeleton shimmer", () => {
    const values = declarationsOf(inside, "animation"); expect(values.length).toBeGreaterThanOrEqual(4);
    for (const value of values) {
      const [duration = 0, delay = 0] = seconds(value);
      if (/\bat-fill\b/.test(value)) { expect(duration).toBeLessThanOrEqual(0.6); expect(delay).toBeLessThanOrEqual(0.1); expect(value).not.toMatch(/infinite/); }
      else if (/\bat-spin\b/.test(value)) expect(duration).toBeLessThanOrEqual(1);
      else if (/\bat-(wait|shimmer)\b/.test(value)) { expect(duration, value).toBeLessThanOrEqual(1.6); expect(value, "the two named loops are the only others that loop").toMatch(/infinite/); } // November 10 (CL, rule 8): at-wait and at-shimmer, capped at 1.6 s
      else { expect(duration, value).toBeLessThanOrEqual(0.24); expect(value, "only the spinner, at-wait and at-shimmer loop").not.toMatch(/infinite/); }
    }
  });
});

describe("MO-03 reduced motion turns every transition and animation off", () => {
  it("keeps the reduce block", () => {
    const reduce = split(css, REDUCE).inner.join("\n").replace(/\s+/g, " ");
    expect(reduce).toContain("*, *::before, *::after { transition: none !important; animation: none !important; }");
  });
});

describe("MO-04 no whole-screen wash", () => {
  it("animates only opacity and transform in keyframes", () => {
    const names = keyframes.map(frame => frame.name); expect(names).toEqual(expect.arrayContaining(["at-page-in", "at-rise", "at-fill", "at-spin", "at-wait", "at-shimmer", "at-row-in"]));
    for (const frame of keyframes) for (const match of frame.body.matchAll(/([\w-]+)\s*:/g)) expect(["opacity", "transform"], frame.name).toContain(match[1]);
  });
  it("never animates or fades html, body, :root or the page wrapper itself", () => {
    for (const rule of inside.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\b(animation|opacity)\s*:/.test(rule[2]!)) continue;
      for (const selector of rule[1]!.split(",").map(part => part.trim())) expect(["html", "body", ":root", ".page-shell"], selector).not.toContain(selector);
    }
  });
});

describe("MO-05 the template wrapper changes no layout", () => {
  const template = readFileSync("src/app/template.tsx", "utf8");
  it("wraps each page in one div.page-shell", () => expect(template).toContain('return <div className="page-shell">{children}</div>;'));
  it("gives .page-shell no box styles of its own", () => {
    const own = [...css.matchAll(/([^{}]+)\{/g)].flatMap(match => match[1]!.split(",").map(part => part.trim())).filter(selector => selector === ".page-shell");
    expect(own).toEqual([]);
  });
});

describe("MO-07 the header never sits inside main", () => {
  // The page-in fade plays on main, and main caps its width, so a header inside it fades with each page and wraps (found on ledger, donations and the rules pages, November 10).
  const files = (readdirSync("src/app", { recursive: true }) as string[]).filter(name => name.endsWith(".tsx")).map(name => `src/app/${name}`);
  it("reads the app pages", () => expect(files.length).toBeGreaterThan(40));
  it("renders AppHeader before main, never inside it", () => {
    const inside = files.filter(file => /<main\b[^>]*>\s*<AppHeader\b/.test(readFileSync(file, "utf8")));
    expect(inside).toEqual([]);
  });
});

describe("MO-08 the trace connector fill and current-step settle (judge thread, docs/DESIGN_LANGUAGE.md section 3 rule 8)", () => {
  const rules = [...inside.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(match => ({ selector: match[1]!.trim(), body: match[2]! }));
  it("defines both keyframes with opacity and transform only, scaleX and a scale from .8", () => {
    const connect = keyframes.find(frame => frame.name === "at-connect"), settle = keyframes.find(frame => frame.name === "at-settle");
    expect(connect?.body.replace(/\s+/g, " ")).toContain("transform: scaleX(0)"); expect(settle?.body.replace(/\s+/g, " ")).toContain("transform: scale(.8)");
  });
  it("plays each once, inside the no-preference block, at 240 ms or less, on the trace marks only", () => {
    const connect = rules.filter(rule => /\bat-connect\b/.test(rule.body)), settle = rules.filter(rule => /\bat-settle\b/.test(rule.body));
    expect(connect).toHaveLength(1); expect(settle).toHaveLength(1);
    expect(connect[0]!.selector).toContain(".trace li[data-state=done]"); expect(connect[0]!.selector).toContain("[data-state=current])::after");
    expect(settle[0]!.selector).toBe(".trace li[data-state=current]::before");
    for (const rule of [...connect, ...settle]) { const [duration = 0, delay = 0] = seconds(declarationsOf(rule.body, "animation")[0]!); expect(duration).toBeLessThanOrEqual(0.24); expect(delay).toBe(0); expect(rule.body).not.toMatch(/infinite/); }
  });
  it("is named in rule 8 of the design language", () => expect(readFileSync("docs/DESIGN_LANGUAGE.md", "utf8").replace(/\s+/g, " ")).toContain("a trace connector fill and current-step settle"));
});
