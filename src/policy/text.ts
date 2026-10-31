import { normalizeForScreen } from "../receipt/prohibited-screen";

// Vendor, description and stored screen terms are data. They are cleaned and bounded before they reach a flag sentence.
// Control characters, zero-width characters, line separators and bidirectional overrides are replaced by a space so a vendor
// cannot reorder or break the line it sits in. Ranges are code points, written as numbers so no raw control character is in this file.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const isUnsafe = (point: number) => UNSAFE_RANGES.some(([low, high]) => point >= low && point <= high);
export function boundedText(value: string, max: number): string {
  const clean = Array.from(value, char => isUnsafe(char.codePointAt(0)!) ? " " : char).join("").replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length > max ? `${points.slice(0, max - 3).join("")}...` : clean;
}
// Same normalization the receipt screen uses: case, punctuation and spacing differences do not hide a repeated vendor.
// An empty result (a vendor with no Latin letters or digits) never matches anything.
export const normalizeVendor = (vendor: string) => normalizeForScreen(vendor).trim();

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
export function dayNumber(isoDate: string): number {
  const match = DAY.exec(isoDate);
  if (!match) throw new TypeError("Dates must be YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, day);
  const check = new Date(time);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new TypeError("Dates must be real calendar days");
  return time / 86_400_000;
}
export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
