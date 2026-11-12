# Licensing

## 1. Application source: MIT

The application source is under the MIT License in [LICENSE](../LICENSE), Copyright (c) 2026
Pavan Aripakula. `package.json` also declares MIT. MIT permits commercial reuse and does not
require publishing modifications. It has no express patent grant. Third-party code is not
relicensed under these terms.

## 2. The bundled font: SIL OFL 1.1

The one bundled binary asset is the unmodified Inter 4.1 variable font. It stays under the SIL
Open Font License 1.1, retained at [src/app/fonts/OFL.txt](../src/app/fonts/OFL.txt). Exact
upstream paths, size and hashes are in [FONT_PROVENANCE.md](FONT_PROVENANCE.md). The font is not
relicensed under MIT.

## 3. Dependencies: retained notices

[DEPENDENCY_LICENSES.json](../DEPENDENCY_LICENSES.json) lists 100 installed packages, including
development dependencies, with 227 notice-file entries.
[THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt) retains the discovered notices plus five
supplemental license texts, verified against the hashes in
[UPSTREAM_LICENSE_SOURCES.json](../UPSTREAM_LICENSE_SOURCES.json). This is an inventory. It is not
a legal compatibility opinion, an image SBOM or a vulnerability scan.

Known gaps, kept rather than filled with invented text:

1. Fourteen package archives declare a license but ship no separate notice file: brocli, two
   esbuild ARM64 versions, two sharp-libvips ARM64 variants, three @next packages, two Rollup
   ARM64 variants, client-only, drizzle-kit, drizzle-orm and postgres. Supplemental texts cover
   postgres and drizzle-orm.
2. The sharp-libvips binary packages declare LGPL-3.0-or-later. The Apache-2.0 license of their
   build scripts does not replace that.
3. `THIRD_PARTY_NOTICES.txt` may still carry license texts of an earlier open-weight model and
   runtime that the project no longer uses, until it is regenerated.

This repository distributes source only. It ships no installed packages, compiled application,
browser binaries or container images. Setup pulls them from their pinned upstream sources.
Review a built image's own license obligations before distributing it.

## 4. AG Grid Community

The ledger, donations and approver queue views use ag-grid-community 36.2.0 and ag-grid-react
36.2.0, both MIT. The project uses AG Grid Community only. It uses no AG Grid Enterprise, charts
or Studio package.

## 5. Hosted services and other terms

No model weights or model runtime ship or run here. AI features call the hosted Claude API under
Anthropic's own terms; see [THIRD_PARTY_MODELS.md](THIRD_PARTY_MODELS.md). PayPal Checkout and
Payouts are used in sandbox under PayPal's terms. Node, PostgreSQL, pnpm, Chromium and operating
system image components keep their own terms. They are downloaded, not bundled. Product names
identify integrations. No sponsorship or endorsement is claimed.
