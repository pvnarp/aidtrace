import {
  BigIntFilterModule, CellApiModule, CellStyleModule, ClientSideRowModelModule, ColumnAutoSizeModule, CsvExportModule, DateFilterModule,
  GridStateModule, PinnedRowModule, QuickFilterModule, RenderApiModule, RowApiModule, RowAutoHeightModule, RowSelectionModule, RowStyleModule, ScrollApiModule, TextFilterModule,
  TooltipModule, ValidationModule, type Module,
} from 'ag-grid-community';

/**
 * Named Community modules only, never the all-modules bundle.
 *
 * Deviation, verified against the installed 36.2.0 package: ColumnGroup and KeyboardNavigation are not public named exports there
 * (only underscore-prefixed internals exist). The grid core module lists both, with ClientSideRowModel, ColumnMove and others, in
 * its own dependency list, so they are registered for every grid. CORE_INCLUDED_MODULE_NAMES records that, and the browser test
 * proves both work (column group headers and keyboard focus).
 */
export const BASE_MODULES: readonly Module[] = [
  ClientSideRowModelModule, TextFilterModule, BigIntFilterModule, DateFilterModule, QuickFilterModule, CsvExportModule, PinnedRowModule,
  TooltipModule, ColumnAutoSizeModule, CellStyleModule, RowStyleModule, GridStateModule, RenderApiModule, ScrollApiModule, RowApiModule,
  CellApiModule,
];

export const CORE_INCLUDED_MODULE_NAMES = ['ColumnGroup', 'KeyboardNavigation'] as const;

/** The base list as the scope writes it: the public modules above plus the two the core registers. */
export const BASE_MODULE_NAMES = [
  'ClientSideRowModel', 'TextFilter', 'BigIntFilter', 'DateFilter', 'QuickFilter', 'CsvExport', 'PinnedRow', 'Tooltip', 'ColumnGroup',
  'ColumnAutoSize', 'CellStyle', 'RowStyle', 'KeyboardNavigation', 'GridState', 'RenderApi', 'ScrollApi', 'RowApi', 'CellApi',
] as const;

/** The full Community list from the owner brief. A grid may register only these. */
export const ALLOWED_MODULE_NAMES: readonly string[] = [
  'ClientSideRowModel', 'BigIntFilter', 'NumberFilter', 'TextFilter', 'DateFilter', 'QuickFilter', 'ExternalFilter', 'CustomFilter', 'CsvExport',
  'PinnedRow', 'RowSelection', 'Tooltip', 'ColumnGroup', 'ColumnAutoSize', 'ColumnMove', 'ColumnHover', 'CellStyle', 'RowStyle', 'RowAutoHeight',
  'CellSpan', 'AlignedGrids', 'GridState', 'HighlightChanges', 'InfiniteRowModel', 'Pagination', 'PaginationPageNumbers', 'KeyboardNavigation',
  'Locale', 'Validation', 'ValueCache', 'RenderApi', 'ScrollApi', 'RowApi', 'CellApi',
];

/** Development checks only. The validation module is never part of a production build. */
export const DEV_MODULES: readonly Module[] = process.env.NODE_ENV !== 'production' ? [ValidationModule] : [];

/** Throws when a module is outside the allowed list. Called on every grid mount, so a wrong extra fails in development and in tests. */
export function assertAllowedModules(modules: readonly Module[]): void {
  for (const module of modules) {
    const name = (module as { moduleName?: string }).moduleName;
    if (!name || !ALLOWED_MODULE_NAMES.includes(name)) throw new Error(`Grid module is not on the allowed list: ${name ?? 'unnamed'}`);
  }
}

export function gridModules(extra: readonly Module[] = []): Module[] {
  const modules = [...BASE_MODULES, ...DEV_MODULES, ...extra];
  assertAllowedModules(modules);
  return modules;
}

/**
 * IAC-405 PR A: the one Community module a grid adds to select rows, named on the allowed list above as RowSelection. It is not in BASE_MODULES, so a
 * grid that does not pass it as an extra module has no row selection. Only the assisted approver queue passes it.
 */
export const SELECTION_MODULES: readonly Module[] = [RowSelectionModule];

/**
 * IAC-232 (November 7): the one Community module a grid adds so a column with wrap true (columns.ts textColumn) can grow its row,
 * named on the allowed list above as RowAutoHeight. Without it AG Grid logs error #200 and the row keeps its 44 px height. Only the
 * Ledger and Donations grids wrap, so only their clients pass it (tests/grid-wrap.test.ts WR-08).
 */
export const WRAP_MODULES: readonly Module[] = [RowAutoHeightModule];
