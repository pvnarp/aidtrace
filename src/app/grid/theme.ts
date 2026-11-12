import { themeQuartz, type Theme } from 'ag-grid-community';

/**
 * Grid theme from the application tokens.
 * Pure given a resolver. The wrapper resolves each alias once at mount from computed styles, so the theme holds concrete colors
 * and nothing depends on whether the theming API accepts var() references.
 */
export const GRID_ALIASES = ['--gx-ink', '--gx-muted', '--gx-paper', '--gx-soft', '--gx-line', '--gx-accent', '--gx-tint', '--gx-hold', '--gx-stop', '--gx-ok'] as const;
/** The pseudo-name the resolver answers with the computed font-family of the grid root. */
export const FONT_FAMILY_KEY = 'font-family';
export type GridResolver = (name: string) => string | null | undefined;

export const PANEL_RADIUS_PX = 14;

export function buildGridTheme(resolve: GridResolver): { theme: Theme; missing: string[] } {
  const values = new Map<string, string>(); const missing: string[] = [];
  for (const name of [...GRID_ALIASES, FONT_FAMILY_KEY]) {
    const value = resolve(name)?.trim();
    if (value) values.set(name, value); else missing.push(name);
  }
  const ink = values.get('--gx-ink'); const muted = values.get('--gx-muted'); const paper = values.get('--gx-paper'); const soft = values.get('--gx-soft');
  const line = values.get('--gx-line'); const accent = values.get('--gx-accent'); const tint = values.get('--gx-tint'); const font = values.get(FONT_FAMILY_KEY);
  // A missing value is left out, so the vendor default stays and the name is reported in missing.
  const params: Record<string, unknown> = { wrapperBorderRadius: PANEL_RADIUS_PX };
  if (ink) params.foregroundColor = ink;
  if (muted) params.headerTextColor = muted;
  if (paper) params.backgroundColor = paper;
  if (soft) { params.headerBackgroundColor = soft; params.pinnedRowBackgroundColor = soft; }
  if (line) { params.borderColor = line; params.wrapperBorder = { style: 'solid', width: 1, color: line }; }
  if (accent) params.accentColor = accent;
  if (tint) { params.rowHoverColor = tint; params.selectedRowBackgroundColor = tint; }
  if (font) params.fontFamily = font;
  return { theme: themeQuartz.withParams(params), missing };
}
