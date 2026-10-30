/** Display only. Marks the fictional demo recipient as non-payable. It never changes payee data or masking. */
export function RecipientNote({ recipient }: { recipient: string }) {
  return recipient.endsWith(".invalid") ? <span className="recipient-note">Fictional non-payable recipient for Maria</span> : null;
}

export function PayPalHandoff({ amount, recipient }: { amount: bigint; recipient: string }) {
  const [local, domain] = recipient.split("@");
  const masked = `${local?.slice(0, 2)}***@${domain ?? "withheld"}`;
  const value = `${amount / 100n}.${(amount % 100n).toString().padStart(2, "0")}`;
  return <div className="paypal-handoff" aria-label="Unpaid PayPal handoff">
    <h3>Ready for a PayPal handoff. Still unpaid.</h3>
    <p>Two people approved this receipt. This review has no payment access, so no request has been sent.</p>
    <dl className="payment-details"><dt>Approved reimbursement</dt><dd>${value} USD</dd><dt>Recipient</dt><dd>{masked}<RecipientNote recipient={recipient} /></dd><dt>PayPal batch / item IDs</dt><dd>Unassigned: no payment attempt</dd><dt>Current payment result</dt><dd>Not submitted</dd></dl>
    <details><summary>Inspect the proposed request structure</summary><p>Read-only structure, not a submitted request. Private receiver and future sender IDs are withheld or unassigned.</p><pre>{JSON.stringify({ sender_batch_header: { sender_batch_id: "<unassigned>" }, items: [{ recipient_type: "EMAIL", receiver: masked, amount: { value, currency: "USD" }, sender_item_id: "<unassigned>" }] }, null, 2)}</pre></details>
    <details><summary>How a separately authorized payment would finish</summary><ol><li>An explicit Send would persist sender IDs before a PayPal request.</li><li>Batch acceptance or PENDING would remain unpaid.</li><li>Only independently verified item SUCCESS would settle the payable once, with the reported fee.</li><li>An unknown outcome would require reconciliation, without another send.</li></ol><p>This describes possible future states. It does not change this receipt or report a provider result.</p></details>
  </div>;
}
