import { aiCard, paypalCard } from "../shell-copy";
import { currentTraceStep, traceSteps, type TraceName, type TraceState } from "../trace";

// IAC-414 Q1: the mini trace in the approver queue. It reuses traceSteps from the Trust v2 trace so the six step names and the step order
// are the ones every claim page shows. A claim in this queue is always at stage 4 (frozen and awaiting approval): the first four steps are
// done, Approvals is current and the PayPal payout is not reached. The count of approvals changes no step state, so the dots stay honest
// and the count lives in the Status column. Presentation only: nothing here stores state or grants authority.
export interface QueueStep { name: TraceName; state: TraceState }

// A confirmed receipt: stage 4 cannot be reached before the claimant confirms. The model, quote and configuration play no part in step states.
const CONFIRMED_AI = aiCard({ applicable: true, suggestion: "NONE", confirmed: true, aiAccepted: false, savedModel: null, configured: null });

export function queueSteps(approvals: number): QueueStep[] {
  const steps = traceSteps({
    stage: 4, typedReceipt: true, ai: CONFIRMED_AI, approvals,
    paypal: paypalCard({ claimStatus: "AWAITING_APPROVAL", approvals, payout: null }),
  });
  return steps.map(step => ({ name: step.name, state: step.state }));
}

/** "Step 5 of 6, Approvals": the same words the claim page's compact trace line uses. */
export function progressText(steps: readonly QueueStep[]): string {
  const now = currentTraceStep(steps.map(step => ({ ...step, stage: 4 as const })));
  return `Step ${steps.findIndex(step => step.name === now.name) + 1} of ${steps.length}, ${now.name}`;
}

const STATE_WORDS: Record<TraceState, string> = { done: "done", current: "current", future: "not reached", blocked: "blocked" };

/** The spoken form of the dots, one clause per step, so the state is never carried by color alone. */
export function progressLabel(steps: readonly QueueStep[]): string {
  return `${progressText(steps)}. ${steps.map(step => `${step.name} ${STATE_WORDS[step.state]}`).join(", ")}.`;
}
