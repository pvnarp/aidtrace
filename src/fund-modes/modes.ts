// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 2.1; docs/ASSUMPTIONS.md section 76). Fund modes and the strictest-mode rule. Read helpers and the one
// decision_modes write that freezeDecision calls. Nothing here approves, posts to the ledger or calls a provider. Manual is the strictest mode, then Assisted, then
// Autopilot. A fund with no approved fund_modes row is Manual. With the flag off every function answers Manual, and no query touches a table that a database below
// migration 0019 lacks.
import { asc, eq, inArray } from "drizzle-orm";
import * as s from "../../db/schema";
import type { FundMode } from "../../db/schema";
import type { AppDatabase } from "../server/db";
import { fundAutopilotEnabled, fundModesEnabled, type FlagEnv } from "./flag";

type Tx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];
export type ModeReader = Pick<Tx, "select">;

// Lower is stricter. The order is the plan's: Manual, then Assisted, then Autopilot.
const STRICTNESS: Record<FundMode, number> = { MANUAL: 0, ASSISTED: 1, AUTOPILOT: 2 };
export const stricter = (a: FundMode, b: FundMode): FundMode => STRICTNESS[a] <= STRICTNESS[b] ? a : b;
// The strictest of the given modes. No mode at all is Manual, never a looser default.
export const strictest = (modes: readonly FundMode[]): FundMode => modes.length === 0 ? "MANUAL" : modes.reduce(stricter);
// Autopilot counts only when the second flag is on (fundAutopilotEnabled). With it off a fund row that says AUTOPILOT counts as Manual,
// including inside a split (an Assisted fund plus an Autopilot fund is Manual, never Assisted). Every effective mode goes through this before it is compared or stored.
export const effectiveOf = (mode: FundMode, env: FlagEnv = process.env): FundMode => mode === "AUTOPILOT" && !fundAutopilotEnabled(env) ? "MANUAL" : mode;

export type FundModeState = { mode: FundMode; version: number };
// The latest approved mode of each fund. Version 0 means no fund_modes row, which is Manual.
export async function currentFundModes(tx: ModeReader, fundIds: readonly string[]): Promise<Map<string, FundModeState>> {
  const result = new Map<string, FundModeState>([...new Set(fundIds)].map(id => [id, { mode: "MANUAL", version: 0 }]));
  if (result.size === 0) return result;
  const rows = await tx.select().from(s.fundModes).where(inArray(s.fundModes.fundId, [...result.keys()])).orderBy(asc(s.fundModes.version));
  for (const row of rows) result.set(row.fundId, { mode: row.mode, version: row.version });
  return result;
}

// The funds that pay any part of a decision: its nonzero edges.
export const payingFunds = (edges: readonly { fundId: string; amountCents: bigint }[]): string[] => [...new Set(edges.filter(edge => edge.amountCents > 0n).map(edge => edge.fundId))];

// Written once by freezeDecision, in the decision's own transaction and only when it creates a new decision. The mode is not part of the decision hash payload.
export async function recordDecisionMode(tx: Tx, decisionHash: string, edges: readonly { fundId: string; amountCents: bigint }[], env?: FlagEnv): Promise<FundMode> {
  const funds = await currentFundModes(tx, payingFunds(edges));
  const effectiveMode = strictest([...funds.values()].map(state => effectiveOf(state.mode, env)));
  await tx.insert(s.decisionModes).values({ decisionHash, effectiveMode, fundModeVersions: Object.fromEntries([...funds].map(([fundId, state]) => [fundId, state.version])) });
  return effectiveMode;
}

// The mode a recognition uses: the stricter of what the decision recorded at freeze (Manual when it has no row) and the strictest current mode of the paying
// funds. A fund moved to a looser mode after freeze never loosens a waiting claim. A fund moved back to Manual tightens it at once.
export async function modeAtRecognition(tx: ModeReader, decisionHash: string, edges: readonly { fundId: string; amountCents: bigint }[], env?: FlagEnv): Promise<FundMode> {
  if (!fundModesEnabled(env)) return "MANUAL";
  const [recorded] = await tx.select({ mode: s.decisionModes.effectiveMode }).from(s.decisionModes).where(eq(s.decisionModes.decisionHash, decisionHash));
  const current = await currentFundModes(tx, payingFunds(edges));
  return strictest([effectiveOf(recorded?.mode ?? "MANUAL", env), ...[...current.values()].map(state => effectiveOf(state.mode, env))]);
}

// The stored mode of one decision, as the sweep reads it. Null when the decision has no row (Manual).
export async function recordedMode(tx: ModeReader, decisionHash: string): Promise<FundMode | null> {
  const [row] = await tx.select({ mode: s.decisionModes.effectiveMode }).from(s.decisionModes).where(eq(s.decisionModes.decisionHash, decisionHash));
  return row?.mode ?? null;
}
