// The twenty receipt categories (IAC-382 step 7.2, docs/plans/CATEGORY_RELABEL.md).
// Dependency free on purpose: the model containers mount only ./src/ai, and the chooser is a
// client component. No node imports, no JSON import, no import from outside src/ai.

export const CATEGORIES = [
  "robot_kits_parts", "classroom_supplies", "books", "food_for_distribution", "participant_meals",
  "volunteer_meals", "kitchen_supplies", "refrigeration_equipment", "weatherization_materials",
  "household_kits", "hygiene_health_supplies", "transit_passes", "group_transport", "mileage",
  "vehicle_rental", "background_checks", "program_fees", "gift_cards", "alcohol", "UNKNOWN",
] as const;
export type Category = typeof CATEGORIES[number];
export type BudgetLine = "supplies" | "other" | "travel" | "equipment" | "contractual";
export const isCategory = (value: unknown): value is Category =>
  typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);

// Categories a person may choose. UNKNOWN is a model answer, never a confirmed category.
export const SELECTABLE = CATEGORIES.filter((category): category is Exclude<Category, "UNKNOWN"> => category !== "UNKNOWN");

// SF-424A object classes. The sentinel "prohibited" is stored for alcohol and gift_cards (ruling 2);
// user-facing wording keys on the category, never on the sentinel.
export const BUDGET_LINE: Record<Exclude<Category, "UNKNOWN">, BudgetLine | "prohibited"> = {
  robot_kits_parts: "supplies", classroom_supplies: "supplies", books: "supplies",
  food_for_distribution: "supplies", kitchen_supplies: "supplies", weatherization_materials: "supplies",
  household_kits: "supplies", hygiene_health_supplies: "supplies",
  participant_meals: "other", volunteer_meals: "other", transit_passes: "other",
  group_transport: "travel", mileage: "travel", vehicle_rental: "travel",
  refrigeration_equipment: "equipment",
  background_checks: "contractual", program_fees: "contractual",
  gift_cards: "prohibited", alcohol: "prohibited",
};

// Legacy ids exist only on preserved rows. They are display-only and never confirmable.
export const LEGACY_NAMES: Record<string, string> = {
  science_kits: "Science kits (legacy)", notebooks: "Notebooks (legacy)", hospitality: "Food and refreshments (legacy)",
};
export const CATEGORY_NAMES: Record<string, string> = {
  robot_kits_parts: "Robot kits and parts", classroom_supplies: "Classroom supplies", books: "Books",
  food_for_distribution: "Food for distribution", participant_meals: "Participant meals",
  volunteer_meals: "Volunteer meals", kitchen_supplies: "Kitchen supplies",
  refrigeration_equipment: "Refrigeration equipment", weatherization_materials: "Weatherization materials",
  household_kits: "Household kits", hygiene_health_supplies: "Hygiene and health supplies",
  transit_passes: "Transit passes", group_transport: "Group transport", mileage: "Mileage",
  vehicle_rental: "Vehicle rental", background_checks: "Background checks", program_fees: "Program fees",
  gift_cards: "Gift cards: needs pre-approval", alcohol: "Alcohol: prohibited", UNKNOWN: "Unknown",
  ...LEGACY_NAMES,
};
export const BUDGET_NAMES: Record<string, string> = {
  supplies: "Supplies", other: "Other", travel: "Travel", equipment: "Equipment", contractual: "Contractual",
  prohibited: "Prohibited", hospitality: "Food and refreshments (legacy)",
};

const DEFINITIONS: Record<Category, string> = {
  robot_kits_parts: "robotics kits, motors, sensors, controllers and build parts",
  classroom_supplies: "pens, paper, notebooks, craft and teaching materials",
  books: "printed books and workbooks",
  food_for_distribution: "groceries and food given to clients or families",
  participant_meals: "meals or snacks eaten by students, teams or program participants",
  volunteer_meals: "meals or snacks eaten by volunteers or staff",
  kitchen_supplies: "trays, containers, utensils, cookware and food-service disposables",
  refrigeration_equipment: "coolers, freezers, compressors and their repair",
  weatherization_materials: "insulation, weatherstripping, caulk and window film",
  household_kits: "prepackaged home or emergency kits, cleaning and household goods",
  hygiene_health_supplies: "soap, toothbrushes, socks, bandages and over-the-counter items, never prescription drugs",
  transit_passes: "bus or rail passes and fare cards",
  group_transport: "charter bus, shuttle or van service for a group",
  mileage: "miles driven in a personal vehicle",
  vehicle_rental: "a rented truck, van or car and its fuel",
  background_checks: "screening and background check fees",
  program_fees: "registration, enrollment or event fees paid to a third party",
  gift_cards: "gift cards or prepaid cards of any kind",
  alcohol: "wine, beer or spirits",
  UNKNOWN: "unsupported, ambiguous, a mixed bundle or unrelated",
};
// One source for both prompts. Who ate decides participant_meals versus volunteer_meals.
export const CATEGORY_DEFINITIONS = CATEGORIES.map(category => `${category} = ${DEFINITIONS[category]}`).join("; ");
