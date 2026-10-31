import type { CsvExportParams, ProcessCellForExportParams } from 'ag-grid-community';
import { decimalCents, type CentsInput } from './money';

/**
 * CSV export for the shared grid foundation (docs/plans/GRID_SURFACES_SCOPE.md section 2.5).
 * The export never reads the clipboard and never makes a network request. It only builds parameters for the grid's own file export.
 */

// A spreadsheet reads a cell that starts with one of these as a formula. Leading spaces are skipped first, a superset of the minimum rule.
const FORMULA_START = /^ *[=+\-@\t\r]/;

/** Prefixes a single quote when a text cell could be read as a formula. Cost: a person who wants a leading minus in text sees a quote. */
export function escapeCsvText(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/** YYYY-MM-DD from a date or timestamp string, or an empty string. */
export function csvDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const found = DATE_PREFIX.exec(value);
  return found ? found[0] : '';
}

/** The file name the scope fixes: aidtrace-{fileBase}-{YYYY-MM-DD}.csv, dated from the server observation time. */
export function csvFileName(fileBase: string, observedAt: string): string {
  return `aidtrace-${fileBase}-${csvDate(observedAt) || 'undated'}.csv`;
}

/** One cell. Cents columns emit plain decimals and are never escaped. Date columns emit YYYY-MM-DD. Everything else is escaped text. */
export function csvCell(kind: string | undefined, value: unknown, formatted: string): string {
  if (kind === 'cents') return decimalCents(value as CentsInput);
  if (kind === 'date') return csvDate(value);
  return escapeCsvText(formatted);
}

export function csvExportParams(options: { fileBase: string; observedAt: string }): CsvExportParams {
  return {
    fileName: csvFileName(options.fileBase, options.observedAt),
    exportedRows: 'filteredAndSorted',
    onlySelected: false,
    skipPinnedTop: true,
    skipPinnedBottom: true,
    skipColumnGroupHeaders: true,
    processCellCallback: (params: ProcessCellForExportParams) => {
      const kind = (params.column.getColDef().context as { kind?: string } | undefined)?.kind;
      return csvCell(kind, params.value, params.formatValue(params.value) ?? '');
    },
  };
}
