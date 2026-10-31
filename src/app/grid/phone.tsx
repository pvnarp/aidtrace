import { columnMeta, leafColumns, type GridColumn } from './columns';

/**
 * The columns the grid hides below 640 px, shown as a native details list under the grid from the same rows
 * (docs/plans/GRID_SURFACES_SCOPE.md section 2.8). Presentation only: no state, no script, nothing editable.
 */
export const PHONE_EXTRAS_LIMIT = 200;

export function PhoneExtras<Row>({ rows, columns, phoneColumns, limit = PHONE_EXTRAS_LIMIT }: { rows: readonly Row[]; columns: readonly GridColumn<Row>[]; phoneColumns: readonly string[]; limit?: number }) {
  const leaves = leafColumns(columns).filter(column => column.field && columnMeta(column));
  const hidden = leaves.filter(column => !phoneColumns.includes(column.field as string));
  const shownLeaves = leaves.filter(column => phoneColumns.includes(column.field as string));
  if (hidden.length === 0) return null;
  const shown = rows.slice(0, limit);
  // An amount alone does not say which side it is on, so a money column's header goes in front of it: "Debit $50.00".
  const title = (row: Row) => shownLeaves.map(column => {
    const meta = columnMeta(column)!; const text = meta.text(row);
    return text && meta.kind === 'cents' ? `${column.headerName} ${text}` : text;
  }).filter(Boolean).join(', ');
  return <section className="gx-phone-extras" aria-label="More details by row" data-testid="gx-phone-extras">
    <h3>More details by row</h3>
    {shown.map((row, index) => <details key={index}><summary>{title(row) || `Row ${index + 1}`}</summary>
      <dl>{hidden.map(column => <div key={column.field} style={{ display: 'contents' }}><dt>{column.headerName}</dt><dd>{columnMeta(column)!.text(row) || 'None'}</dd></div>)}</dl></details>)}
    {rows.length > shown.length && <p>Showing details for the first {shown.length} of {rows.length} rows. Search or filter to narrow the list.</p>}
  </section>;
}
