import { expect, test } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aidtrace-font-"));
  const font = readFileSync("src/app/fonts/InterVariable.woff2");
  const license = readFileSync("src/app/fonts/OFL.txt");
  mkdirSync(join(root, "src/app/fonts"), { recursive: true });
  writeFileSync(join(root, "src/app/fonts/OFL.txt"), license);
  const helper = pathToFileURL(resolve("scripts/source-assets.mjs")).href;
  const check = (name: string, bytes: Buffer) => {
    writeFileSync(join(root, "input"), bytes);
    return spawnSync(process.execPath, ["--input-type=module", "-e", `import {assertSourceAsset} from ${JSON.stringify(helper)}; import {readFileSync} from 'node:fs'; console.log(assertSourceAsset(process.argv[1],readFileSync(process.argv[2]+'/input'),process.argv[2]));`, name, root], { encoding: "utf8" });
  };
  return { root, font, license, check };
}
test("FONT-01: only the exact pinned font with its exact license passes", () => {
  const { font, check } = fixture();
  const valid = check("src/app/fonts/InterVariable.woff2", font);
  expect(valid.status).toBe(0); expect(valid.stdout.trim()).toBe("reviewed-font");
  const changed = Buffer.from(font); changed[changed.length - 1] ^= 1;
  expect(check("src/app/fonts/InterVariable.woff2", changed).status).not.toBe(0);
  expect(check("src/app/fonts/InterVariable.woff2", font.subarray(0, -1)).status).not.toBe(0);
  expect(check("other.woff2", font).status).not.toBe(0);
  expect(check("other.woff2", Buffer.from("text masquerading as font")).status).not.toBe(0);
});
test("FONT-02: missing, modified or linked license fails closed", () => {
  const { root, font, license, check } = fixture();
  const path = join(root, "src/app/fonts/OFL.txt");
  unlinkSync(path);
  expect(check("src/app/fonts/InterVariable.woff2", font).status).not.toBe(0);
  writeFileSync(path, "missing copyright");
  expect(check("src/app/fonts/InterVariable.woff2", font).status).not.toBe(0);
  const linked = join(root, "src/app/fonts/linked"); writeFileSync(linked, license);
  unlinkSync(path); symlinkSync(linked, path);
  expect(check("src/app/fonts/InterVariable.woff2", font).status).not.toBe(0);
  unlinkSync(path); writeFileSync(path, license);
  // A parent directory link is also refused by canonical containment.
  const other = mkdtempSync(join(tmpdir(), "aidtrace-font-license-"));
  mkdirSync(join(other, "src/app"), { recursive: true });
  symlinkSync(join(root, "src/app/fonts"), join(other, "src/app/fonts"));
  writeFileSync(path, license);
  writeFileSync(join(other, "input"), font);
  const helper = pathToFileURL(resolve("scripts/source-assets.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {assertSourceAsset} from ${JSON.stringify(helper)}; import {readFileSync} from 'node:fs'; assertSourceAsset('src/app/fonts/InterVariable.woff2',readFileSync(process.argv[1]+'/input'),process.argv[1]);`, other], { encoding: "utf8" });
  expect(result.status).not.toBe(0);
});
test("FONT-03: the font exception leaves generic binary and invalid UTF-8 refusals intact", () => {
  const { check } = fixture();
  expect(check("safe.md", Buffer.from("ordinary source")).status).toBe(0);
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([255, 254])]) {
    expect(check("asset.bin", bytes).status).not.toBe(0);
  }
});
