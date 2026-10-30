import type { AllocationInput, FundPolicy } from "../../src/domain/model";
const general: FundPolicy = { version: 1, approvedBy: "tara", summary: "Any program and category except organization prohibitions.", programs: null, allowedCategories: null, periodStart: null, periodEnd: null, breadth: null };
export function fixture(): AllocationInput {
  return { program: "robotics", prohibitedCategories: ["alcohol", "gift_cards"], solverPriority: { version: 1, approvedBy: "tara" }, priorDebits: [], reservations: [],
    lines: [
      { id: "L1", category: "robot_kits_parts", budgetLine: "supplies", incurredOn: "2026-10-14", amountCents: 28000n },
      { id: "L2", category: "classroom_supplies", budgetLine: "supplies", incurredOn: "2026-10-14", amountCents: 15000n },
      { id: "L3", category: "participant_meals", budgetLine: "other", incurredOn: "2026-10-14", amountCents: 7000n },
    ], funds: [
      { id: "fund_a", name: "Ashmere County Afterschool STEM Subgrant", fundClass: "RESTRICTED", balanceCents: 30000n, policy: { version: 1, approvedBy: "tara", summary: "Eastside Robotics Club share: robot kits, parts and notebooks, September 2026 through June 2027; supplies cap $300.", programs: ["robotics"], allowedCategories: ["robot_kits_parts", "classroom_supplies"], periodStart: "2026-09-01", periodEnd: "2027-06-30", breadth: 2 }, budgetLines: [{ id: "supplies", capCents: 30000n }] },
      { id: "fund_b", name: "Tallow Creek Robot Kit Initiative", fundClass: "RESTRICTED", balanceCents: 20000n, policy: { version: 1, approvedBy: "tara", summary: "Eastside Robotics Club share: robot kits and parts only, October through December 2026; supplies cap $200.", programs: ["robotics"], allowedCategories: ["robot_kits_parts"], periodStart: "2026-10-01", periodEnd: "2026-12-31", breadth: 1 }, budgetLines: [{ id: "supplies", capCents: 20000n }] },
      { id: "fund_g", name: "General Operating", fundClass: "UNRESTRICTED", balanceCents: 100000n, policy: general, budgetLines: [] },
    ] };
}
