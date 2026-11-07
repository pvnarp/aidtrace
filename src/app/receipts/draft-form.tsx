export function DraftForm({ id, reviewId, hash, vendor = "Cedar Science Shop", program = "robotics", incurredOn = "2026-10-14", source = "Science experiment kit\nBlank writing notebook\nSandwiches and apple juice", total = "6.00", photo = false, lines = [{ description: "Science experiment kit", amount: "3.00" }, { description: "Blank writing notebook", amount: "2.00" }, { description: "Sandwiches and apple juice", amount: "1.00" }] }: {
  id?: string; reviewId?: string; hash?: string; photo?: boolean; vendor?: string; program?: string; incurredOn?: string; source?: string; total?: string; lines?: { description: string; amount: string }[];
}) {
  return <form action={id ? `/api/receipts/${id}` : "/api/receipts"} method="post" className="receipt-form">
    <input type="hidden" name="action" value={id ? "edit" : "create"} />
    {photo && !id && <input type="hidden" id="photoReadId" name="photoReadId" defaultValue="" />}
    {reviewId && <input type="hidden" name="reviewId" value={reviewId} />}{hash && <input type="hidden" name="draftHash" value={hash} />}
    <div className="receipt-meta"><label htmlFor="vendor">Vendor<input id="vendor" name="vendor" defaultValue={vendor} required maxLength={120} /></label>
    <label htmlFor="program">Program<input id="program" name="program" defaultValue={program} required maxLength={64} /></label>
    <label htmlFor="incurredOn">Expense date<input id="incurredOn" type="date" name="incurredOn" defaultValue={incurredOn} required /></label>
    {photo && !id && <p id="printedDate" className="muted" data-testid="printed-date" role="status" hidden />}</div>
    {Array.from({ length: photo && !id ? 12 : Math.max(3, lines.length) }, (_, i) => <fieldset key={i} className="receipt-line" hidden={i >= Math.max(3, lines.length)} data-extra-line={i >= Math.max(3, lines.length) ? "true" : undefined}><legend>Line {i + 1}</legend>
      <label htmlFor={`description${i + 1}`}>Description {i + 1}<input id={`description${i + 1}`} name={`description${i + 1}`} defaultValue={lines[i]?.description ?? ""} maxLength={256} required={i === 0} /></label>
      <label htmlFor={`amount${i + 1}`}>USD amount {i + 1}<input id={`amount${i + 1}`} name={`amount${i + 1}`} defaultValue={lines[i]?.amount ?? ""} inputMode="decimal" pattern="[0-9]+\.[0-9]{2}" placeholder="0.00" required={i === 0} /></label>
    </fieldset>)}
    <label htmlFor="total">Receipt total in USD</label><input id="total" name="total" defaultValue={total} required inputMode="decimal" pattern="[0-9]+\.[0-9]{2}" />
    <label htmlFor="source" id="sourceLabel">Receipt text</label><textarea id="source" name="source" defaultValue={source} required rows={7} maxLength={16384} />
    <p>Amounts are entered by you, with two decimal places. Maximum total $500.00.</p>
    <label className="confirm"><input type="checkbox" name="syntheticReceipt" value="yes" required /> This receipt holds no real personal details.</label>
    <button type="submit">{id ? "Save edits and require a new review" : "Create receipt draft"}</button>
  </form>;
}
