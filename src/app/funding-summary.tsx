type Edge = { fundId: string; amountCents: string | bigint };
type Fund = { id: string; name: string };

/** The per-fund rows of a frozen or computed split, or null when the existing validity rule fails (totals must tie to the cent). */
function splitRows(total: bigint, general: bigint, edges: readonly Edge[], funds: readonly Fund[]) {
  if (total <= 0n || edges.reduce((sum, edge) => sum + BigInt(edge.amountCents), 0n) !== total) return null;
  const rows = funds.map(fund => ({ ...fund, amount: edges.filter(e => e.fundId === fund.id).reduce((sum, e) => sum + BigInt(e.amountCents), 0n) })).filter(r => r.amount > 0n);
  if (rows.reduce((sum, row) => sum + row.amount, 0n) !== total || general < 0n || general > total) return null;
  return rows;
}

/** True when FundingSummary would render. The Decision panel uses it to hide the "Fund split" label with the summary. */
export const hasFundingSummary = (total: bigint, general: bigint, edges: readonly Edge[], funds: readonly Fund[]) => splitRows(total, general, edges, funds) !== null;

export function FundingSummary({ total, general, edges, funds }: { total: bigint; general: bigint; edges: readonly Edge[]; funds: readonly Fund[] }) {
  const rows = splitRows(total, general, edges, funds);
  if (!rows) return null;
  const money = (cents: bigint) => `$${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return <div className="funding-summary" aria-label={`Computed split: ${money(total - general)} restricted, ${money(general)} General`}>
    <div className="funding-bar" aria-hidden="true">{rows.map(row => <span key={row.id} data-fund={row.id} style={{ width: `${Number(row.amount) / Number(total) * 100}%` }} />)}</div>
    <ul className="funding-legend">{rows.map(row => <li key={row.id} data-fund={row.id}><span>{row.name}</span><strong>{money(row.amount)}</strong></li>)}</ul>
  </div>;
}
