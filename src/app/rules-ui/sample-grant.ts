// November 10 calm rules pages. The sample grant a reviewer can drop into the "Draft rules from a grant" box with one press, so a judge does not have to find a PDF.
// It is the text of the demo grant PDF (GRANT_TEXT under scripts/support); test RS-08 fails if the two differ. It names the seeded
// Lanternfield Community Alliance and fund_a, so the page offers it on that fund only. Pressing the button fills the box; nothing is sent until Draft rules.
export const SAMPLE_GRANT_FUND_ID = "fund_a";
export const SAMPLE_GRANT_TEXT = [
  "Ashmere County Education Foundation",
  "Afterschool STEM Subgrant Agreement ACEF-2026-STEM-07, Amendment 1",
  "Between the Ashmere County Education Foundation and Lanternfield Community Alliance.",
  "This amendment restates the terms of the Ashmere County Afterschool STEM Subgrant.",
  "1.1 The subgrant pays direct costs of the Eastside Robotics Club afterschool program.",
  "1.2 It may pay for robot kits, robot parts, classroom supplies and participant meals.",
  "1.3 The subgrant period begins on 2026-09-01 and ends on 2027-06-30.",
  "1.4 Spending on supplies may not exceed $500.00 in total over the subgrant period.",
  "1.5 Meals and snacks eaten by participants may not exceed $100.00 in total.",
  "1.6 Gift cards and alcoholic beverages are not allowable under any circumstances.",
  "1.7 A final report is due 30 days after the end of the subgrant period.",
].join("\n");
