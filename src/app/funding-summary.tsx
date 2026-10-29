export function FundingSummary({ total, general, edges, funds }: {
  total: bigint; general: bigint; edges: readonly { fundId: string; amountCents: string | bigint }[];
  funds: readonly { id: string; name: string }[];
}) {
  if (total <= 0n || edges.reduce((sum, edge) => sum + BigInt(edge.amountCents), 0n) !== total) return null;
  const rows = funds.map(fund => ({ ...fund, amount: edges.filter(e => e.fundId === fund.id).reduce((sum, e) => sum + BigInt(e.amountCents), 0n) })).filter(r => r.amount > 0n);
  if (rows.reduce((sum, row) => sum + row.amount, 0n) !== total || general < 0n || general > total) return null;
  const money = (cents: bigint) => `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return <div className="funding-summary" aria-label={`Computed split: ${money(total - general)} restricted, ${money(general)} General`}>
    <div className="funding-bar" aria-hidden="true">{rows.map(row => <span key={row.id} data-fund={row.id} style={{ width: `${Number(row.amount) / Number(total) * 100}%` }} />)}</div>
    <ul className="funding-legend">{rows.map(row => <li key={row.id} data-fund={row.id}><span>{row.name}</span><strong>{money(row.amount)}</strong></li>)}</ul>
    <p className="muted">General is flexible funding. The rule engine computes this split from the confirmed categories and fund limits.</p>
  </div>;
}
