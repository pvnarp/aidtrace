import type { ColDef } from 'ag-grid-community';
import { usd } from '../../analytics/model';
import { COLUMN_FILTER_DEBOUNCE_MS } from './timing';

/**
 * Money for the shared grid foundation.
 * Cents cross the server boundary as decimal strings. Inside the grid they are bigint. Nothing here converts to a floating point value.
 */
export class InvalidCentsError extends Error {
  constructor(message = 'A whole number of cents as a canonical decimal string or a bigint is required') { super(message); this.name = 'InvalidCentsError'; }
}

const CANONICAL_CENTS = /^-?(0|[1-9][0-9]*)$/;
/** What a row field may hold: a cents string, a bigint, or nothing. */
export type CentsInput = string | bigint | null | undefined;

const isBlank = (value: CentsInput): value is null | undefined | '' => value === null || value === undefined || value === '';

export function toCents(value: string | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && CANONICAL_CENTS.test(value)) return BigInt(value);
  throw new InvalidCentsError();
}

/** Blank becomes null so a pinned row or a missing side never throws. Anything else must be canonical. */
export function centsOrNull(value: CentsInput): bigint | null {
  return isBlank(value) ? null : toCents(value);
}

/**
 * Sort comparator with the grid's argument order. Blank values sort last in both directions: the grid negates the result for a
 * descending sort, so the sign of a blank comparison is flipped when isDescending is true.
 */
export function compareCents(a: CentsInput, b: CentsInput, _nodeA?: unknown, _nodeB?: unknown, isDescending?: boolean): number {
  const aBlank = isBlank(a); const bBlank = isBlank(b);
  if (aBlank || bBlank) {
    if (aBlank && bBlank) return 0;
    const blankAfter = aBlank ? 1 : -1;
    return isDescending ? -blankAfter : blankAfter;
  }
  const left = toCents(a); const right = toCents(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

// Optional dollar sign, whole dollars with or without strict thousands groups, optional one or two decimals. At least one digit overall.
const TYPED_DOLLARS = /^\$?(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/;

/** Dollars a person typed to exact cents: 25 is 2500n, 25.5 is 2550n, $1,234.56 is 123456n, .5 is 50n. Anything else is null. */
export function parseCentsInput(text: string): bigint | null {
  if (typeof text !== 'string') return null;
  const found = TYPED_DOLLARS.exec(text.trim());
  if (!found) return null;
  const whole = (found[1] ?? '').replaceAll(',', '');
  const fraction = found[2] ?? '';
  if (whole === '' && fraction === '') return null;
  return BigInt(`${whole === '' ? '0' : whole}${fraction.padEnd(2, '0')}`);
}

/** Delegates to the application formatter so the grid and the analytics page read the same. Blank is an empty string. */
export function formatCents(value: CentsInput): string {
  return isBlank(value) ? '' : usd(toCents(value));
}

/** Plain 25.00 style text for CSV: optional minus, digits, one point, two decimals. No symbol and no grouping. */
export function decimalCents(value: CentsInput): string {
  if (isBlank(value)) return '';
  const cents = toCents(value);
  const magnitude = cents < 0n ? -cents : cents;
  return `${cents < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/** Exact sum. An empty list is 0n. */
export function sumCents(values: Iterable<CentsInput>): bigint {
  let total = 0n;
  for (const value of values) if (!isBlank(value)) total += toCents(value);
  return total;
}

/** Characters the amount filter input admits: digits, a decimal point, grouping commas, a dollar sign and spaces. */
export const CENTS_FILTER_CHARS = '[0-9.,$ ]';

/** The row field name as the column definition type expects it. Row fields here are flat names, never nested paths. */
export const fieldOf = <Row>(field: string): ColDef<Row>['field'] => field as ColDef<Row>['field'];

export interface CentsColumnOptions<Row> extends Omit<ColDef<Row>, 'field' | 'headerName'> {
  field: Extract<keyof Row, string>;
  headerName: string;
}

/**
 * A cents column. The row holds a string, the value getter yields bigint, the formatter yields dollars, the comparator is exact and
 * the filter is the Community BigInt filter with a parser that reads dollars into cents and a formatter that shows them back.
 */
export function centsColumn<Row>(options: CentsColumnOptions<Row>): ColDef<Row> {
  const { field, headerName, ...rest } = options;
  const read = (row: Row | undefined): bigint | null => centsOrNull((row as Record<string, CentsInput> | undefined)?.[field]);
  return {
    filter: 'agBigIntColumnFilter',
    filterParams: {
      allowedCharPattern: CENTS_FILTER_CHARS,
      debounceMs: COLUMN_FILTER_DEBOUNCE_MS,
      bigintParser: (text: string | null) => (text === null ? null : parseCentsInput(text)),
      bigintFormatter: (value: bigint | null) => (value === null ? null : decimalCents(value)),
    },
    floatingFilter: true, suppressFloatingFilterButton: true,
    // A column definition's cellClass replaces the one the rightAligned type brings, so the type's right-aligned cell class is
    // named again here; without it the amounts sat left under right-aligned headers.
    cellClass: ['gx-cell-num', 'ag-right-aligned-cell'],
    type: 'rightAligned',
    comparator: compareCents,
    ...rest,
    field: fieldOf<Row>(field),
    headerName,
    valueGetter: params => read(params.data),
    valueFormatter: params => formatCents(params.value as CentsInput),
    getQuickFilterText: params => { const value = params.value as CentsInput; return isBlank(value) ? '' : `${formatCents(value)} ${decimalCents(value)}`; },
    context: {
      kind: 'cents',
      text: (row: Row) => formatCents(read(row)),
    },
  };
}
