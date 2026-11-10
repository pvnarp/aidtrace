/**
 * The one-line caption above every grid (the owner's November 10 ask: make it obvious where AG Grid is used and what it lets a person do).
 * Derived only from the props the shared DataGrid already receives, so a grid cannot claim a feature it does not have. Search, sort and
 * column filters are on for every grid. Row selection, CSV export and a totals row are named only when the grid sets them.
 */
export interface GridCaptionInput { selection: boolean; csv: boolean; totals: boolean }

/** Every caption starts with this, so the grid can set the library name in bold without changing the text a person or a test reads. */
export const CAPTION_PREFIX = 'Table by AG Grid Community';

export function gridCaption({ selection, csv, totals }: GridCaptionInput): string {
  const abilities = ['search, sort and filter any column'];
  if (selection) abilities.push('select rows');
  if (csv) abilities.push('export CSV');
  return `${CAPTION_PREFIX}, read only: ${abilities.join(', ')}.${totals ? ' The total row follows the filter.' : ''} Your column layout is kept for you.`;
}
