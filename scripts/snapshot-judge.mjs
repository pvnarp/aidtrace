import { readFileSync, mkdirSync, copyFileSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
const folder = process.argv[2];
if (!/^local\/ui-source-[A-Za-z0-9]+$/.test(folder ?? "")) throw new Error("Use the private judge UI runner");
const manifest = JSON.parse(readFileSync("SOURCE_MANIFEST.json", "utf8"));
for (const file of [...manifest.files.map(item => item.path), "SOURCE_MANIFEST.json"]) {
  const source = resolve(file); if (!source.startsWith(`${process.cwd()}/`) || !lstatSync(source).isFile()) throw new Error("Unsafe source entry");
  const target = resolve(folder, file); if (!target.startsWith(`${resolve(folder)}/`)) throw new Error("Unsafe target entry");
  mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target);
}
console.log("Created sanitized judge UI snapshot from manifest paths only.");
