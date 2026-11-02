import { fundRulesPath } from "../server/fund-rules-links";
import type { FundMeter } from "./fund-meter";

/**
 * One fund on the approver home: name, the stored restriction, the snapshot figures and a reserved-share meter.
 * Presentation only. Every figure arrives formatted by fundMeter from the analytics snapshot. The fill width is the integer percent.
 * IAC-440 Package B: an approver sees a "Draft rules from a grant" link on a restricted fund's row, found by the fund's name (see FundRulesLink).
 */
export function FundRow({ meter }: { meter: FundMeter }) {
  return <div className="fund-r" data-testid="fund-meter">
    <div className="fund-r-head"><b className="fund-r-name">{meter.name}</b><span className="fund-type">{meter.label}</span></div>
    <p className="fund-r-line">Available <strong>{meter.available}</strong> of {meter.book} book balance, {meter.reserved} reserved</p>
    <span className="meter" role="img" aria-label={meter.ariaLabel}><i style={{ width: `${meter.percent}%` }} /></span>
    {meter.label === "Restricted" && <FundRulesLink name={meter.name} />}
  </div>;
}

// Renders nothing for a claimant, a signed-out visitor, an unrestricted fund or a name that does not match exactly one restricted fund of the viewer's organization.
async function FundRulesLink({ name }: { name: string }) {
  const path = await fundRulesPath(name);
  return path ? <p className="fund-r-link"><a href={path} data-testid="fund-rules-link">Draft rules from a grant</a></p> : null;
}
