import type { ApproverQueueRow } from "../../server/approver-queue";
import { formatCents } from "../grid/money";
import { progressLabel, queueSteps } from "./progress";

// IAC-414 Q1: the three cells that need markup. Each is a plain function component the grid mounts in the browser. None holds state, calls
// the server or writes anything. The Review cell is a link to the claim page, where approval stays: there is no approve button here.
type CellProps = { data?: ApproverQueueRow };

/** The vendor with its fund beneath. */
export function VendorCell({ data }: CellProps) {
  if (!data) return null;
  return <span className="aq-vendor"><span className="aq-vendor-name">{data.vendor}</span><small>{data.fund}</small></span>;
}

/** Six dots, one per trace step. The words are in the label and in the Status column. */
export function ProgressCell({ data }: CellProps) {
  if (!data) return null;
  const steps = queueSteps(data.approvalCount);
  return <span className="aq-mini" role="img" aria-label={progressLabel(steps)} data-testid="aq-mini">{steps.map(step => <i key={step.name} data-state={step.state} />)}</span>;
}

/** A link to the claim. The name carries the vendor and the amount so several Review links are told apart. */
export function ReviewCell({ data }: CellProps) {
  if (!data) return null;
  return <a className="aq-review" href={data.href} aria-label={`Review ${data.vendor}, ${formatCents(data.amountCents)}`}>Review</a>;
}
