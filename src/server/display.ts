// Display labels only. Never substitute these into financial terms or decision hashes.
export { CATEGORY_NAMES as categoryNames } from "../ai/categories";
export function reviewTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(value);
}
