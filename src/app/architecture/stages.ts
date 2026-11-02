// IAC-403: the four stages of the locked mock's Architecture screen, with copy corrected to the app's facts.
// Pure data, no I/O. The amounts are the documented illustrative $500 scenario, not loaded claim or account data.
// Wording about AI follows the configured AI status, so it never claims AI that is not running. IAC-416 PR 2: the stages say "AI" and name no model.

export type NodeId = "browser" | "app" | "model" | "db" | "paypal";
export type ArchitectureStage = { title: string; path: string; text: string; nodes: NodeId[] };
export type ArchitectureAi = { on: boolean };

export const ARCHITECTURE_NODES: { id: NodeId; label: string; description: string }[] = [
  { id: "browser", label: "Browser", description: "Maria, Tara or Ben" },
  { id: "app", label: "AidTrace app", description: "Rules, approvals, adapter, ledger" },
  { id: "model", label: "AI model", description: "Hosted Anthropic API, no keys or tools" },
  { id: "db", label: "Postgres", description: "Separate container" },
  { id: "paypal", label: "PayPal", description: "External service" },
];

export function architectureStages(ai: ArchitectureAi): ArchitectureStage[] {
  const suggests: ArchitectureStage = ai.on
    ? { title: "AI suggests", path: "AidTrace app → AI model over the Anthropic API → validated quotes", nodes: ["app", "model", "app", "db"],
        text: "AI reads the typed receipt text and suggests a category for each line with a quote. The app validates the quotes. A person checks and confirms every category. The AI model has no PayPal tools, approval authority or ledger access." }
    : { title: "AI suggests", path: "AidTrace app → a person chooses each category", nodes: ["app", "db"],
        text: "A person chooses every category in this session. With AI connected, it would suggest categories with quotes the app validates. It never approves, chooses funds or pays." };
  return [
    suggests,
    { title: "Rules allocate", path: "AidTrace app → Postgres → exact allocation", nodes: ["app", "db", "app"],
      text: "Illustrative split: $200 kits from the Tallow Creek Robot Kit Initiative, $80 kits plus $150 notebooks from the Ashmere County Afterschool STEM Subgrant, and $70 refreshments from General Operating. Rules check categories, program, date, balances and shared caps together. A rule failure stops the allocation, and General Operating still follows organization-wide bans." },
    { title: "People approve", path: "Separate signed-in reviewers → frozen decision", nodes: ["browser", "app", "db"],
      text: "Tara and Ben review identical frozen terms. One approval is not enough, Maria cannot approve her own claim, and changed financial terms invalidate old approvals. On the second approval the app recognizes an obligation, not a payment." },
    { title: "PayPal handoff", path: "Approved terms → read-only request preview", nodes: ["browser", "app", "paypal"],
      text: "The keyless judge session stops at an unpaid PayPal handoff and submits nothing. A separately authorized payment would use the adapter and independent item verification, and only a verified success lets the ledger close the payable once. Book cash is an accounting figure, not a PayPal balance." },
  ];
}
