/**
 * The placeholder a grid page shows while the browser-only grid loads. Static bars shaped like the toolbar and rows, sized like the grid so nothing shifts when it mounts.
 * The loading words stay as visually hidden text for screen readers and for any test that reads them. Presentation only: no data, no request.
 */
export function GridSkeleton({ label }: { label: string }) {
  return <div className="sk-table" role="status" aria-busy="true">
    <span className="vh">{label}</span>
    <i className="sk-bar sk-caption" aria-hidden="true" />
    <div className="sk-toolbar" aria-hidden="true"><i className="sk-bar sk-search" /><i className="sk-bar sk-button" /></div>
    <div className="sk-status" aria-hidden="true"><i className="sk-bar sk-line" /></div>
    <div className="sk-frame" aria-hidden="true">{[0, 1, 2, 3, 4, 5, 6, 7].map(row => <div className="sk-row" key={row}><i className="sk-bar sk-cell wide" /><i className="sk-bar sk-cell" /><i className="sk-bar sk-cell" /><i className="sk-bar sk-cell narrow" /></div>)}</div>
  </div>;
}
