import { PayPalText } from "./brand";
import { railLines, type AiCard, type PayPalCard, type Stage } from "./shell-copy";

/**
 * The trace stepper (docs/plans/TRUST_V2_PORT_SCOPE.md section 3.2). Six steps derived from the five saved stages
 * plus the claim page's policy-block flag. It stores nothing and does not change claimStage.
 * Presentation only: the page supplies authorized saved state, never query-string progress.
 */
export const TRACE_NAMES = ["Receipt", "AI review", "Rule checks", "Fund split", "Approvals", "PayPal payout"] as const;
export type TraceName = (typeof TRACE_NAMES)[number];
export type TraceState = "done" | "current" | "future" | "blocked";
export type TraceStep = { name: TraceName; state: TraceState; detail?: string; stage: Stage };
export type TraceLinks = Partial<Record<Stage, string>>;

/** Which saved stage each trace step belongs to. Stage 3 covers both Rule checks and Fund split. */
const STEP_STAGE: readonly Stage[] = [1, 2, 3, 3, 4, 5];
const PREFIX: Record<TraceState, string> = { done: "Done: ", current: "Current step: ", future: "Not reached: ", blocked: "Blocked: " };
const LEGEND: readonly (readonly [TraceName, string])[] = [
  ["Receipt", "Typed text and amounts"], ["AI review", "Suggests categories with quotes"], ["Rule checks", "Rules, not AI"],
  ["Fund split", "Computed from fund policy"], ["Approvals", "Two different people"], ["PayPal payout", "Separate decision"],
];

export type TraceInput = { stage: Stage; typedReceipt: boolean; photoReceipt?: boolean; ai: AiCard; approvals: number | null; paypal: PayPalCard; policyBlocked?: boolean; required?: 1 | "auto" };

/** The six steps with their state and detail text. A step is blocked only when the claim sits at stage 3 and organization policy stops it. */
export function traceSteps(input: TraceInput): TraceStep[] {
  const { stage } = input;
  const blocked = Boolean(input.policyBlocked) && stage === 3;
  const lines = railLines({ stage, typedReceipt: input.typedReceipt, ...(input.photoReceipt ? { photoReceipt: true } : {}), ai: input.ai, approvals: input.approvals, paypal: input.paypal, ...(input.required ? { required: input.required } : {}) });
  const state = (index: number): TraceState => {
    if (index === 2) return blocked ? "blocked" : stage >= 3 ? "done" : "future";
    if (index === 3) return stage >= 4 ? "done" : stage === 3 && !blocked ? "current" : "future";
    const at = STEP_STAGE[index]!;
    return at < stage ? "done" : at === stage ? "current" : "future";
  };
  const detail = (index: number): string | undefined => {
    if (index === 2) return blocked ? "Stopped by organization policy" : lines[2]!.state;
    if (index === 3) return stage >= 4 ? undefined : stage === 3 && !blocked ? "Check, then freeze" : "Locked. Rules, not AI";
    return lines[index < 2 ? index : index - 1]!.state;
  };
  return TRACE_NAMES.map((name, index) => {
    const step: TraceStep = { name, state: state(index), stage: STEP_STAGE[index]! };
    const text = detail(index);
    return text === undefined ? step : { ...step, detail: text };
  });
}

/** The step to name in a page kicker: the current step, or the blocked one when policy stops the claim. */
export function currentTraceStep(steps: readonly TraceStep[]): TraceStep {
  return steps.find(step => step.state === "current") ?? steps.find(step => step.state === "blocked") ?? steps[0]!;
}

function StepText({ step }: { step: TraceStep }) {
  return <><span className="vh">{PREFIX[step.state]}</span>
    <span className="t"><PayPalText text={step.name} /></span>
    {step.detail !== undefined && <span className="d"><PayPalText text={step.detail} /></span>}</>;
}

/**
 * The stepper for a claim. A done step is a link only where the page supplies one for its stage (the old rail rule).
 * At 900 px and below the labels clip to the dots row and the compact line names the current step. All six names stay readable.
 */
export function TraceStepper({ stage, state, reviews, links = {}, policyBlocked = false, required }: {
  stage: Stage; state: { ai: AiCard; paypal: PayPalCard; typedReceipt: boolean; photoReceipt?: boolean }; reviews: number | null; links?: TraceLinks; policyBlocked?: boolean; required?: 1 | "auto";
}) {
  const steps = traceSteps({ stage, typedReceipt: state.typedReceipt, ...(state.photoReceipt ? { photoReceipt: true } : {}), ai: state.ai, approvals: reviews, paypal: state.paypal, policyBlocked, ...(required ? { required } : {}) });
  const now = currentTraceStep(steps); const position = steps.indexOf(now) + 1;
  return <nav aria-label="Expense trace" className="trace-nav">
    <ol className="trace">{steps.map(step => {
      const href = step.state === "done" && step.stage < stage ? links[step.stage] : undefined;
      return <li key={step.name} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
        {href ? <a className="trace-body" href={href}><StepText step={step} /></a> : <span className="trace-body"><StepText step={step} /></span>}</li>;
    })}</ol>
    <p className="trace-now" aria-hidden="true" data-state={now.state}>Step {position} of 6, {now.name}{now.detail !== undefined && <span className="now-d">. <PayPalText text={now.detail} /></span>}</p>
  </nav>;
}

/** The sign-in legend: the same six steps, all not reached, with fixed descriptions. No claim, name, count or amount. */
export function TraceLegend() {
  return <nav aria-label="How a claim moves" className="trace-nav trace-legend">
    <ol className="trace">{LEGEND.map(([name, text]) => <li key={name} data-state="future"><span className="trace-body">
      <span className="t"><PayPalText text={name} /></span><span className="d">{text}</span></span></li>)}</ol></nav>;
}

/** The page kicker: the current trace step name, then an optional suffix. Replaces the old "Stage n / name" kicker. */
export function TraceKicker({ stage, state, reviews, policyBlocked = false, suffix = "" }: {
  stage: Stage; state: { ai: AiCard; paypal: PayPalCard; typedReceipt: boolean; photoReceipt?: boolean }; reviews: number | null; policyBlocked?: boolean; suffix?: string;
}) {
  const now = currentTraceStep(traceSteps({ stage, typedReceipt: state.typedReceipt, ...(state.photoReceipt ? { photoReceipt: true } : {}), ai: state.ai, approvals: reviews, paypal: state.paypal, policyBlocked }));
  return <p className="kicker"><PayPalText text={now.name} />{suffix}</p>;
}
