/** Fictional example receipts for the new-receipt form (IAC-415 PR 7, docs/ASSUMPTIONS.md section 67). Data only: a category is never stored here, the person or Claude chooses each one. */
export type DraftExample = { vendor: string; program: string; incurredOn: string; total: string; source: string; lines: { description: string; amount: string }[] };

/** The one USD 500.00 receipt that tells the whole flow: robot kit parts, engineering notebooks and a meal line that needs a person. Amounts are two-decimal strings, as the form takes them. */
export const WORKSHOP_EXAMPLE: DraftExample = {
  vendor: "Brightbench Supply Co.", program: "robotics", incurredOn: "2026-10-14", total: "500.00",
  lines: [
    { description: "Robot kit and parts", amount: "280.00" },
    { description: "Engineering notebooks", amount: "150.00" },
    { description: "Sandwiches and apple juice", amount: "70.00" },
  ],
  source: "Brightbench Supply Co.\nRobot kit and parts 280.00\nEngineering notebooks 150.00\nSandwiches and apple juice 70.00\nTotal 500.00",
};
