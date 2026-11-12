// IAC-405 step 2 PR F. The master flag. Off unless the value is exactly "true", so an unset variable, a
// typo or "TRUE" leaves every fund Manual, hides the mode controls and stops the sweep from starting. The environment is a parameter so a test passes
// its own object and never touches the process one. Production passes nothing and reads the process environment.
export type FlagEnv = Readonly<Record<string, string | undefined>>;
export const fundModesEnabled = (env: FlagEnv = process.env): boolean => env.FUND_MODES_ENABLED === "true";

// IAC-405 step 3 PR P. The second flag. Autopilot is on only when FUND_AUTOPILOT_ENABLED is exactly "true" AND FUND_MODES_ENABLED is exactly
// "true", so turning on Assisted never exposes Autopilot. With it off, a stored AUTOPILOT mode counts as Manual everywhere, exactly as PR F built it.
export const fundAutopilotEnabled = (env: FlagEnv = process.env): boolean => fundModesEnabled(env) && env.FUND_AUTOPILOT_ENABLED === "true";
export const automationFlagOn = fundAutopilotEnabled;
