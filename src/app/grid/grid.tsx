'use client';
import './grid.css';
import { AgGridReact } from 'ag-grid-react';
import type { ColDef, GetRowIdParams, GridApi, GridReadyEvent, GridState, Module, StateUpdatedEvent } from 'ag-grid-community';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { leafColumns, mapLeaves, type GridColumn } from './columns';
import { csvExportParams } from './csv';
import { gridModules } from './modules';
import { sumCents } from './money';
import { PhoneExtras } from './phone';
import { clearGridState, loadGridState, saveGridState } from './state';
import { buildGridTheme, FONT_FAMILY_KEY } from './theme';
import { SEARCH_DELAY_MS } from './timing';

/**
 * The shared read-only data grid (docs/plans/GRID_SURFACES_SCOPE.md section 2.7). Loaded with next/dynamic and ssr false by each page.
 * It offers no editing prop, sets editable false for every column and has no write path. Rows carry string cents.
 */
export interface DataGridProps<Row> {
  gridId: string;
  userId: string;
  ariaLabel: string;
  observedAt: string;
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  columns: readonly GridColumn<Row>[];
  /** Field names kept below 640 px. */
  phoneColumns: readonly string[];
  extraModules?: readonly Module[];
  csv?: { fileBase: string };
  /** A pinned bottom row summed over the rows the filter leaves visible. The label sits in the first column. */
  totals?: { label: (shown: number) => string; fields: readonly string[] };
  getRowClass?: (row: Row) => string | undefined;
  selection?: { onChange: (rows: Row[]) => void; isRowSelectable?: (row: Row) => boolean };
}

const NO_MODULES: readonly Module[] = [];
const PHONE_QUERY = '(max-width: 639px)';
const subscribeNarrow = (notify: () => void) => { const query = window.matchMedia(PHONE_QUERY); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify); };
const readNarrow = () => window.matchMedia(PHONE_QUERY).matches;

interface Derived<Row> { shown: number; pinned: Record<string, string>[]; visible: Row[] }

function displayedRows<Row>(api: GridApi<Row>): Row[] {
  const rows: Row[] = []; const count = api.getDisplayedRowCount();
  for (let index = 0; index < count; index++) { const data = api.getDisplayedRowAtIndex(index)?.data; if (data !== undefined) rows.push(data); }
  return rows;
}

export function DataGrid<Row extends object>(props: DataGridProps<Row>) {
  const { gridId, userId, ariaLabel, observedAt, rows, getRowId, columns, phoneColumns, csv, totals, getRowClass, selection } = props;
  const extraModules = props.extraModules ?? NO_MODULES;
  const rootRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<GridApi<Row> | null>(null);
  const searchId = useId();
  const narrow = useSyncExternalStore(subscribeNarrow, readNarrow, () => false);
  const [theme, setTheme] = useState<ReturnType<typeof buildGridTheme>['theme'] | null>(null);
  const [search, setSearch] = useState('');
  // The grid gets the search text SEARCH_DELAY_MS after the last keystroke, so a column filter edit made just before always applies
  // first (timing.ts, LG-05b).
  const [appliedSearch, setAppliedSearch] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setAppliedSearch(search), SEARCH_DELAY_MS); return () => window.clearTimeout(timer); }, [search]);
  const [resets, setResets] = useState(0);
  const [derived, setDerived] = useState<Derived<Row>>({ shown: rows.length, pinned: [], visible: [] });
  const saved = useMemo(() => loadGridState(userId, gridId), [userId, gridId, resets]);
  const modules = useMemo(() => gridModules(extraModules), [extraModules]);
  const labelField = useMemo(() => leafColumns(columns).find(column => column.field)?.field as string | undefined, [columns]);

  // Resolve the theme once at mount from computed styles. Resolved values are concrete colors.
  useLayoutEffect(() => {
    const root = rootRef.current; if (!root) return;
    const computed = getComputedStyle(root);
    setTheme(buildGridTheme(name => (name === FONT_FAMILY_KEY ? computed.fontFamily : computed.getPropertyValue(name))).theme);
  }, []);

  // The grid shows every column in a restored column order unless the state also names the hidden ones, so a saved order alone would
  // bring the phone-hidden columns back. The layout therefore supplies its own visibility with the saved state. Hide is always set
  // explicitly in the column definitions, so a flip between phone and wide also shows the columns again.
  const layoutHidden = useMemo(() => new Set(leafColumns(columns).flatMap(leaf => {
    const field = leaf.field as string | undefined;
    return field && (narrow ? !phoneColumns.includes(field) : !!leaf.hide) ? [field] : [];
  })), [columns, narrow, phoneColumns]);
  // Read once per saved state: the grid takes its initial state only when it mounts, and a reset remounts it.
  const initialState = useMemo(() => (saved ? ({ ...saved, columnVisibility: { hiddenColIds: [...layoutHidden] } } as GridState) : undefined), [saved]);

  const columnDefs = useMemo(() => mapLeaves(columns, leaf => {
    const field = leaf.field as string | undefined;
    const base: ColDef<Row> = { ...leaf, editable: false, hide: field ? layoutHidden.has(field) : leaf.hide };
    if (!totals || !field || field !== labelField) return base;
    // The pinned totals row keeps its label in the first column as plain text, so the column's own formatting never reads it.
    const read = leaf.valueGetter; const format = leaf.valueFormatter;
    return {
      ...base,
      valueGetter: params => (params.node?.rowPinned ? ((params.data as Record<string, unknown> | undefined)?.[field] ?? null) : typeof read === 'function' ? read(params) : (params.data as Record<string, unknown> | undefined)?.[field]),
      valueFormatter: params => (params.node?.rowPinned ? String(params.value ?? '') : typeof format === 'function' ? format(params) : String(params.value ?? '')),
    };
  }), [columns, layoutHidden, totals, labelField]);

  const defaultColDef = useMemo<ColDef<Row>>(() => ({ editable: false, resizable: true, sortable: true, minWidth: 90 }), []);

  const recompute = useCallback((api: GridApi<Row>) => {
    const visible = displayedRows(api);
    const pinned: Record<string, string>[] = [];
    if (totals && labelField) {
      const row: Record<string, string> = { [labelField]: totals.label(visible.length) };
      for (const field of totals.fields) row[field] = sumCents(visible.map(item => (item as Record<string, string>)[field])).toString();
      pinned.push(row);
    }
    setDerived(previous => (previous.shown === visible.length && JSON.stringify(previous.pinned) === JSON.stringify(pinned) && (!narrow || previous.visible.length === visible.length) ? previous : { shown: visible.length, pinned, visible: narrow ? visible : [] }));
  }, [totals, labelField, narrow]);

  const onGridReady = (event: GridReadyEvent<Row>) => { apiRef.current = event.api; recompute(event.api); };
  const onStateUpdated = (event: StateUpdatedEvent<Row>) => { if (event.sources.some(source => source !== 'gridInitializing')) saveGridState(userId, gridId, event.state as Record<string, unknown>); };
  const resetView = () => { clearGridState(userId, gridId); setSearch(''); setAppliedSearch(''); setResets(count => count + 1); };

  return <div ref={rootRef} className="gx-root" role="region" aria-label={ariaLabel} data-testid={`gx-${gridId}`}>
    <div className="gx-toolbar">
      <div className="gx-search"><label htmlFor={searchId}>Search this table</label>
        <input id={searchId} type="search" value={search} onChange={event => setSearch(event.target.value)} autoComplete="off" spellCheck={false} /></div>
      {csv && <button type="button" className="secondary" onClick={() => apiRef.current?.exportDataAsCsv(csvExportParams({ fileBase: csv.fileBase, observedAt }))}>Export CSV</button>}
      <button type="button" className="secondary" onClick={resetView}>Reset view</button>
    </div>
    <p className="gx-status-line" role="status" aria-live="polite" data-testid="gx-status">Showing {derived.shown} of {rows.length}</p>
    <div className="gx-frame">
      {theme && <AgGridReact<Row>
        key={`${gridId}:${resets}`}
        theme={theme}
        modules={modules as Module[]}
        rowData={rows as Row[]}
        getRowId={(params: GetRowIdParams<Row>) => (params.rowPinned ? `gx-total-${params.rowPinned}` : getRowId(params.data))}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        quickFilterText={appliedSearch}
        includeHiddenColumnsInQuickFilter
        pinnedBottomRowData={derived.pinned}
        getRowClass={params => (params.node?.rowPinned ? 'gx-row-total' : params.data ? getRowClass?.(params.data) : undefined)}
        initialState={initialState}
        rowHeight={44}
        headerHeight={44}
        tooltipShowDelay={300}
        rowSelection={selection ? { mode: 'multiRow', isRowSelectable: selection.isRowSelectable ? node => (node.data ? selection.isRowSelectable!(node.data) : false) : undefined } : undefined}
        onSelectionChanged={selection ? event => selection.onChange(event.api.getSelectedRows()) : undefined}
        onGridReady={onGridReady}
        onModelUpdated={event => recompute(event.api)}
        onStateUpdated={onStateUpdated}
      />}
    </div>
    {narrow && <PhoneExtras rows={derived.visible} columns={columns} phoneColumns={phoneColumns} />}
  </div>;
}

export default DataGrid;
