import type { AllocationInput, FundPolicy } from "../../src/domain/model";
const general: FundPolicy = { version: 1, approvedBy: "tara", summary: "Any program and category except organization prohibitions.", programs: null, allowedCategories: null, periodStart: null, periodEnd: null, breadth: null };
export function fixture(): AllocationInput {
  return { program: "robotics", prohibitedCategories: ["alcohol"], solverPriority: { version: 1, approvedBy: "tara" }, priorDebits: [], reservations: [],
    lines: [
      { id: "L1", category: "science_kits", budgetLine: "supplies", incurredOn: "2026-10-14", amountCents: 28000n },
      { id: "L2", category: "notebooks", budgetLine: "supplies", incurredOn: "2026-10-14", amountCents: 15000n },
      { id: "L3", category: "hospitality", budgetLine: "hospitality", incurredOn: "2026-10-14", amountCents: 7000n },
    ], funds: [
      { id: "fund_a", name: "Education A", fundClass: "RESTRICTED", balanceCents: 30000n, policy: { version: 1, approvedBy: "tara", summary: "Robotics science kits and notebooks, September 2026 through June 2027.", programs: ["robotics"], allowedCategories: ["science_kits", "notebooks"], periodStart: "2026-09-01", periodEnd: "2027-06-30", breadth: 2 }, budgetLines: [{ id: "supplies", capCents: 30000n }] },
      { id: "fund_b", name: "STEM B", fundClass: "RESTRICTED", balanceCents: 20000n, policy: { version: 1, approvedBy: "tara", summary: "Robotics science kits only, October through December 2026.", programs: ["robotics"], allowedCategories: ["science_kits"], periodStart: "2026-10-01", periodEnd: "2026-12-31", breadth: 1 }, budgetLines: [{ id: "supplies", capCents: 20000n }] },
      { id: "fund_g", name: "General", fundClass: "UNRESTRICTED", balanceCents: 100000n, policy: general, budgetLines: [] },
    ] };
}
