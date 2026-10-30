# Preserve licensing boundaries

The one bundled unmodified Inter 4.1 WOFF2 retains SIL OFL 1.1 at src/app/fonts/OFL.txt.
Exact immutable upstream paths, size and hashes are in docs/FONT_PROVENANCE.md. This is a
font-only exception to historical source-only/binary inventory statements below. It does
not relicense the font under MIT or grant clearance for other binary/image distribution.

## 1. Retain MIT: application source

The repository already contained an MIT LICENSE, Copyright (c) 2026 Pavan Aripakula,
introduced during AidTrace bootstrap. This candidate retains that exact file and records
MIT in package.json. Earlier private judge exports omitted LICENSE; this candidate corrects
the omission. Final publication remains subject to owner review and explicit direction.

Pavan approved MIT with "yeah MIT works". This is the selected application license:
simple reuse terms and continuity with the existing file. It permits commercial reuse and does not require users
to publish modifications. That permissiveness is the cost. MIT contains no express patent
grant; Apache-2.0 provides one with additional redistribution/notice terms. If an explicit
patent grant becomes the priority, reconsider Apache-2.0 before public release. Do not
describe third-party code or model weights as relicensed under the application MIT terms.

Primary terms: https://opensource.org/license/mit and
https://www.apache.org/licenses/LICENSE-2.0 . Rules requiring a visible open-source license:
https://paypalaihackathon.devpost.com/rules . These were checked October 22, 2026.

## 2. Retain dependency notices: bounded inventory

The fallback's fresh offline Linux ARM64 install recorded 82 installed packages, including
development dependencies, and 208 discovered license/notice files. The lockfile, fresh named
dependency volume and compiled browser assets are checked separately for named AG package
references. The original Studio inventory of 98 packages and 224 notices remains in its
preserved source. THIRD_PARTY_NOTICES.txt retains discovered fallback notices and the five
previously fetched supplemental texts, verified against their recorded hashes in
UPSTREAM_LICENSE_SOURCES.json. This is an inventory, not an exhaustive legal compatibility
opinion, source-ownership certification, image filesystem SBOM or vulnerability scan.

Fourteen package archives contain declared license metadata but no discovered separate
notice file. Preserve that gap rather than inventing copyright text. They are brocli,
two esbuild ARM64 versions, two sharp-libvips ARM64 variants, three @next packages, two
Rollup ARM64 variants, client-only, drizzle-kit, drizzle-orm and postgres. Supplemental
pinned texts cover postgres and drizzle-orm; absent notices are not silently marked found.
Two guessed versioned license URLs for brocli/drizzle-kit returned 404 and are recorded.
Parent-package notices are also retained for Next, esbuild and Rollup, without claiming
that they exhaust the native binaries' embedded third-party content.

In particular sharp-libvips binary packages declare LGPL-3.0-or-later. The fetched
sharp-libvips build repository LICENSE is Apache-2.0; that build-script license does not
replace the binaries' LGPL terms. This source-only candidate distributes no installed
packages, compiled application, browser binaries, container images or weights. Setup pulls
them from their original pinned sources. Before distributing any built image or binary,
review that artifact's complete license/source/notice obligations separately. Do not treat
this package inventory as approval to redistribute an image.

## 3. Preserve runtime terms: separate downloads

Qwen weights are Apache-2.0 and the pinned llama.cpp runtime is MIT. Their exact official
revision license texts are retained as supplemental notices; artifact pins are in
docs/THIRD_PARTY_MODELS.md. Downloaded weights retain the model license in their volume.
Node, PostgreSQL, pnpm, Chromium and operating-system image components retain their own
terms. They are downloaded, not bundled here. No logo or screenshot permissions are implied.

## 4. Review before public release: owner authority

The MIT choice is approved. Confirm authority to license the original application, the
exact candidate hash and destination, third-party/AI-assistance attribution and judging
access. The source inventory cannot determine employment or other ownership obligations.
Public repository creation, push, hosting, video upload and submission are unperformed.

## 5. Separate the variants: no fabricated clearance

The owner authorized this separate Studio-free fallback on October 23, 2026. Ordinary React
replaces the Studio presentation and client harness; server authentication, exact snapshots,
model validators and financial boundaries remain unchanged. The locked dependency tree and
installed declared-license inventory contain no named AG packages or Commercial declarations.
That bounded inspection is not exhaustive provenance, legal or binary/image clearance.

The original Studio checkout retains its packages, notices, private evaluation and unresolved
IAC-240 licensing question. Its export guard continues to refuse absent clearance. This
fallback does not set publicJudgingApproved, fabricate sponsor evidence or claim AG prize
eligibility. It needs no Studio key. Its source preparation still requires final owner
review, a separately selected public destination and independent judging-access validation.
