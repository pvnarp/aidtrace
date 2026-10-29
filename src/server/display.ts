// Display labels only. Never substitute these into financial terms or decision hashes.
export const categoryNames: Record<string, string> = {
  science_kits: "Science kits", notebooks: "Notebooks", hospitality: "Food and refreshments", alcohol: "Alcohol: prohibited",
};
export function reviewTime(value: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(value);
}
