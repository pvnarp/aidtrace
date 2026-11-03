// IAC-405 step 2 PR F (docs/plans/FUND_MODES_SCOPE.md section 3; docs/ASSUMPTIONS.md section 76). The two entry points the policy sweep calls to start a SWEEP run. Only
// src/fund-modes/policy-sweep.ts (the sweep) imports this file: no module under src/server or src/app does (tests/fund-modes-static.test.ts). The web route imports runPolicyChecks
// and runModelCheck, which can build only an APPROVER run, so a web press never creates a SWEEP run. A SWEEP run has no user. It is refused unless the fund modes flag is on and the
// decision's recorded mode is Assisted or Autopilot, and it cannot approve, hold or pay anything. The environment is the flag's: a process with the flag off selects nothing here.
import type { FlagEnv } from "../fund-modes/flag";
import type { AppDatabase } from "../server/db";
import { runModelCheckAs, type ModelRunDeps, type ModelRunResult } from "./model-run";
import { runRulesCheck, type PolicyRunResult } from "./service";

export const sweepRulesCheck = (db: AppDatabase, decisionHash: string, env?: FlagEnv): Promise<PolicyRunResult> => runRulesCheck(db, decisionHash, { trigger: "SWEEP", env });
export const sweepModelCheck = (db: AppDatabase, decisionHash: string, deps: ModelRunDeps = {}): Promise<ModelRunResult> => runModelCheckAs(db, decisionHash, { trigger: "SWEEP", env: deps.env }, deps);
