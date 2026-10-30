# Preserve local typography: Inter 4.1

IAC-372 was adopted October 29, 2026. The application self-hosts the upstream unmodified
normal variable font through next/font/local, with swap loading and an adjusted Arial
fallback. No CDN, runtime font request to another host, native Mac font installation,
package dependency or italic asset is introduced. Receipt source text keeps its monospace
evidence treatment. Application amounts use tabular numerals.

## 1. Pin the asset: reproduce the exact bytes

Upstream tag v4.1 resolves to commit e3a3d4c57d5ecc01453a575621882a384c1995a3.
The font is src/app/fonts/InterVariable.woff2, exactly 352240 bytes.
SHA-256: 693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3.

Source: [immutable upstream font](https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/docs/font-files/InterVariable.woff2).
The normal weight range is configured as 100 through 900. Only this one binary path and
exact hash are allowed by scripts/source-assets.mjs. Another font/version needs a separate
asset, notice and export review. The build copies the WOFF2 without subsetting or renaming
its internal font identity; hashed output filenames do not change the font bytes.

## 2. Retain the license: keep the font separate from MIT application code

The upstream SIL Open Font License 1.1 is retained verbatim at
[src/app/fonts/OFL.txt](../src/app/fonts/OFL.txt), 4380 bytes.
SHA-256: 262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a.
Source: [immutable upstream license](https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/LICENSE.txt).
Copyright: 2016 The Inter Project Authors. This exact license declares no additional
Reserved Font Name after its copyright statement. Its general modified-font naming,
attribution, standalone-sale and redistribution conditions still apply. No modification or
standalone sale is proposed. The font remains under OFL; the application remains MIT.
This records the retained upstream terms, not blanket rights clearance for the project.

## 3. Bound the cost: validate both load paths

Cost: 352240 font bytes plus the 4380-byte notice and maintained source/export checks.
Next adds a generated preload and local CSS. Font fallback can still reflow if loading
fails; verify it independently. No file is installed in a system font directory.
See [IAC-372 verification](IAC372_VISUAL_POLISH.md) for actual browser evidence and limits.
