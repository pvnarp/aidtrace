# Review the same type everywhere: IAC-372

Pavan adopted local typography and visual polish on October 29, with commit/push/merge
requested before another review. The light guided design, server authority, schema, solver,
caps, approval hashes, financial semantics, packages and lockfile are unchanged by IAC-372.
Its dependency PR16/17/18 merged in order with exact expected-head checks. Their final main
checkpoint is 34697489ca22ac5de5f5943a19416ef3c1800c2e. The focused typography PR and final
merged SHA are linked from live IAC-372 after source closeout. No new owner gate PASS.

## 1. Render consistently: retain a single local font

One unmodified normal Inter 4.1 variable font covers weights 100 through 900. It loads
through next/font/local, with swap and an adjusted Arial fallback. Analytics inherits it;
receipt evidence keeps its monospace treatment. Hero tracking is less tight. The exact
352240-byte font and 4380-byte OFL notice are pinned in [provenance](FONT_PROVENANCE.md).
No CDN, native font install, package update or alternate visual identity is introduced.

## 2. Protect exports: refuse everything outside the reviewed exception

Only the exact font path/size/signature/hash with its exact notice passes the shared asset
guard. Both inventories must include the license when including the font. Private-value
and credential-pattern scans still run on font bytes. Other fonts, altered assets, generic
binary/non-UTF-8 data and linked/missing/changed notices remain refused. The generated JSON
manifest is normalized to bytes before the same check. Both judge/source notices identify
the font-only exception; application MIT and font OFL remain separate.

Twenty-three private-source refusal cases and three positive cases pass, including exact
font/license copying and omitted-license refusal. Five judge-export refusal cases and one
exact positive fixture pass. Eight existing Studio-inclusive terms refusal cases also pass;
no Studio grant is inferred. These are bounded guard checks, not legal clearance or an
exhaustive secret detector. Other notice investigation entries and release-source selection
remain open. No immutable RC3 files are edited.

## 3. Verify the actual interface: keep test types separate

OrbStack production build and final TypeScript passed. The full suite passed 297 tests
across 34 files. Twenty-three synthetic Chromium checks passed: eleven main workflow,
ten proposal/font and two analytics. The separately selected actual-model case is skipped
in that synthetic suite, not counted as passed. FONT-01/02/03 cover asset boundaries;
FONT-04 checks the actual served hash, rendered custom font, same-length currency widths,
390/1440 layout and usable login/form when WOFF2 loading is deliberately blocked.

A fresh database exercised the actual pinned Qwen model through the production UI. The same
USD 500 receipt had three source highlights, USD 430 restricted / USD 70 General, a fixed
USD 200 General comparison, freeze and two separately authenticated approvals. It ends
APPROVED with USD 500 payable, zero payout attempts and an explicitly unpaid handoff.
Analytics, architecture and forced-font-failure views left a seventeen-table fingerprint
unchanged. The twenty-eight private stills cover ten normal pages/states and three fallback
states at 1440/390, plus two home folds. All measured states had no horizontal overflow and
visible text at least 12 px. Rendered heading fonts are custom Inter in normal states and
system fallback when blocked. Three representative captures were visually inspected.
Page errors and external browser requests were zero. These are Linux ARM64 container
Chromium results, not independent-machine access, full accessibility proof or physical
macOS/Windows rendering. Automated approvals are not owner design acceptance.

## 4. Explain failures and cost: retain the evidence

Initial Vitest startup needed a private writable .vite-temp cache beside read-only
dependencies. Font-test harness corrections read the response before navigation, enabled
the CSS inspection domain, used the actual viewport width and matched generated lowercase
font-family names. The private capture also needed string-based browser measurements to
avoid a TypeScript helper and explicit navigation before reading the claim URL. Failed
runs/databases were retained; none reset owner work. No failed harness run is a test pass.

The real numeric check found unequal advances under Chromium's default hinting despite
tnum being present and requested. Geometric text rendering measured 99.0625 px for both
same-length currency samples in the app. It now accompanies tabular numerals. Cost:
different hinting, maintained browser checks and potentially changed fallback line wraps.
Physical browser/OS review remains necessary. The exact source font and built served font
hashes match; no font binary modification was used to fix rendering.

Cost also includes the font/notice bytes, generated local CSS/preload, retained proof data
and bounded validation. Verification containers are stopped after checks; storage remains.
Current proof paths are in the Codex task's private work/iac372-polish, outside Git.
The source working folder remains the canonical Hackathon folder. Studio, previous sessions,
the retained port 3100 preview and the separate port 3101 wireframes stay intact.

## 5. Review the merged source: keep release authority separate

The next review should use the final private main SHA recorded in Linear, not the old
retained preview or wireframes. IAC-365/366/370/371/372 keep technical review distinct from
owner comprehension and independent access. November 2 rights/access, November 3 preflight,
November 4 media preparation and conditional November 5 eligibility planning are unchanged.
Publishing, recording, contact, hosting, new payment and preview replacement remain
unauthorized. The font record does not settle other dependency or publication rights.
