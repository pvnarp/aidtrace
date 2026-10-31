import type { ColDef, ColGroupDef } from 'ag-grid-community';
import { reviewTime } from '../../server/display';
import { csvDate } from './csv';
import { centsColumn, fieldOf } from './money';
import { statusInfo } from './status';
import { COLUMN_FILTER_DEBOUNCE_MS } from './timing';

/** Column builders for the shared grid foundation (docs/plans/GRID_SURFACES_SCOPE.md section 2.1). centsColumn is re-exported from money.ts. */
export { centsColumn };

export type ColumnKind = 'text' | 'cents' | 'date' | 'status';
/** Kept in each column's context: how its cells export to CSV and how the phone list reads a row. */
export interface ColumnMeta<Row> { kind: ColumnKind; text: (row: Row) => string }
export type GridColumn<Row> = ColDef<Row> | ColGroupDef<Row>;

export const columnMeta = <Row>(column: ColDef<Row>): ColumnMeta<Row> | undefined => column.context as ColumnMeta<Row> | undefined;
const isGroup = <Row>(column: GridColumn<Row>): column is ColGroupDef<Row> => 'children' in column;

/** Every leaf column, in order, through any depth of column groups. */
export function leafColumns<Row>(columns: readonly GridColumn<Row>[]): ColDef<Row>[] {
  return columns.flatMap(column => (isGroup(column) ? leafColumns(column.children) : [column]));
}

/** A copy of the tree with each leaf replaced by fn(leaf). Groups keep their own settings. */
export function mapLeaves<Row>(columns: readonly GridColumn<Row>[], fn: (leaf: ColDef<Row>) => ColDef<Row>): GridColumn<Row>[] {
  return columns.map(column => (isGroup(column) ? { ...column, children: mapLeaves(column.children, fn) } : fn(column)));
}

const rawText = <Row>(row: Row | undefined, field: string): string => {
  const value = (row as Record<string, unknown> | undefined)?.[field];
  return value === null || value === undefined ? '' : String(value);
};

export interface TextColumnOptions<Row> extends Omit<ColDef<Row>, 'field' | 'headerName'> {
  field: Extract<keyof Row, string>;
  headerName: string;
  /** Tooltip text for a data row. Pinned rows never show one. */
  tip?: (row: Row) => string | undefined;
}

export function textColumn<Row>(options: TextColumnOptions<Row>): ColDef<Row> {
  const { field, headerName, tip, ...rest } = options;
  return {
    filter: 'agTextColumnFilter',
    filterParams: { debounceMs: COLUMN_FILTER_DEBOUNCE_MS },
    floatingFilter: true,
    ...rest,
    field: fieldOf<Row>(field),
    headerName,
    valueGetter: params => rawText(params.data, field),
    ...(tip ? { tooltipValueGetter: params => (params.node?.rowPinned || !params.data ? undefined : tip(params.data)) } : {}),
    context: { kind: 'text', text: (row: Row) => rawText(row, field) } satisfies ColumnMeta<Row>,
  };
}

/**
 * Compares a filter date with a cell by year, month and day only, so a time zone never shifts a day (GS-11). The filter date is the
 * local midnight Date the date picker returns. The cell is YYYY-MM-DD text or an ISO timestamp, read as written. Negative when the
 * cell is before the filter date, zero on the same day, positive after. A cell that holds no date sorts before every filter date.
 */
export function dateOnlyComparator(filterLocalDate: Date, cellValue: unknown): number {
  const found = typeof cellValue === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(cellValue) : null;
  if (!found) return -1;
  const cellKey = Number(found[1]) * 10000 + Number(found[2]) * 100 + Number(found[3]);
  const filterKey = filterLocalDate.getFullYear() * 10000 + (filterLocalDate.getMonth() + 1) * 100 + filterLocalDate.getDate();
  return cellKey < filterKey ? -1 : cellKey > filterKey ? 1 : 0;
}

export interface DateColumnOptions<Row> extends Omit<ColDef<Row>, 'field' | 'headerName'> {
  field: Extract<keyof Row, string>;
  headerName: string;
  /** True shows the full UTC time through reviewTime. False shows the date as YYYY-MM-DD. */
  withTime?: boolean;
  tip?: (row: Row) => string | undefined;
}

export function dateColumn<Row>(options: DateColumnOptions<Row>): ColDef<Row> {
  const { field, headerName, withTime = false, tip, ...rest } = options;
  const show = (value: unknown): string => {
    if (typeof value !== 'string' || value === '') return '';
    return withTime ? reviewTime(new Date(value)) : csvDate(value) || value;
  };
  return {
    filter: 'agDateColumnFilter',
    filterParams: { comparator: dateOnlyComparator, debounceMs: COLUMN_FILTER_DEBOUNCE_MS },
    floatingFilter: true,
    ...rest,
    field: fieldOf<Row>(field),
    headerName,
    valueGetter: params => rawText(params.data, field) || null,
    valueFormatter: params => show(params.value),
    getQuickFilterText: params => `${show(params.value)} ${csvDate(params.value)}`.trim(),
    ...(tip ? { tooltipValueGetter: params => (params.node?.rowPinned || !params.data ? undefined : tip(params.data)) } : {}),
    context: { kind: 'date', text: (row: Row) => show(rawText(row, field)) } satisfies ColumnMeta<Row>,
  };
}

export interface StatusColumnOptions<Row> extends Omit<ColDef<Row>, 'field' | 'headerName'> {
  field: Extract<keyof Row, string>;
  headerName: string;
}

/** A status key shown as its words with a leading dot. The dot class and the tooltip come from status.ts. */
export function statusColumn<Row>(options: StatusColumnOptions<Row>): ColDef<Row> {
  const { field, headerName, ...rest } = options;
  return {
    filter: 'agTextColumnFilter',
    filterParams: { debounceMs: COLUMN_FILTER_DEBOUNCE_MS },
    floatingFilter: true,
    ...rest,
    field: fieldOf<Row>(field),
    headerName,
    valueGetter: params => rawText(params.data, field),
    valueFormatter: params => (params.value ? statusInfo(String(params.value)).label : ''),
    cellClass: params => (params.node?.rowPinned || !params.value ? undefined : ['gx-status', statusInfo(String(params.value)).dot]),
    tooltipValueGetter: params => (params.node?.rowPinned || !params.value ? undefined : statusInfo(String(params.value)).tip),
    context: { kind: 'status', text: (row: Row) => { const key = rawText(row, field); return key ? statusInfo(key).label : ''; } } satisfies ColumnMeta<Row>,
  };
}
