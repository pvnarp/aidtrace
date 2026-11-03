/**
 * Two small pure helpers for the shared grid's right edge and empty states (IAC-440 grid report polish). They read the grid through the
 * narrow shapes below, so a unit test can feed them plain objects and grid.tsx can pass the real API.
 */

/** House copy for the grid's own empty overlays. None is no rows at all. Filtered is rows hidden by the search box or a column filter. */
export interface EmptyMessages { none?: string; filtered?: string }

/**
 * The grid's overlay parameters for the two empty states, or undefined when no copy is given, so a grid without it keeps AG Grid's own
 * default text. A missing half keeps its default too.
 */
export function overlayParamsFor(messages: EmptyMessages | undefined): { noRows?: { overlayText: string }; noMatchingRows?: { overlayText: string } } | undefined {
  if (!messages?.none && !messages?.filtered) return undefined;
  return {
    ...(messages.none ? { noRows: { overlayText: messages.none } } : {}),
    ...(messages.filtered ? { noMatchingRows: { overlayText: messages.filtered } } : {}),
  };
}

/**
 * The part of the grid's state the edge reading needs. The grid hands this out through its state module, which every report grid
 * registers. The column API is not registered (GS-01 pins the module list), so column widths come from here.
 */
export interface EdgeState {
  columnOrder?: { orderedColIds: string[] };
  columnVisibility?: { hiddenColIds: string[] };
  columnSizing?: { columnSizingModel: { colId: string; width?: number }[] };
}
export interface EdgeApi { getHorizontalPixelRange(): { left: number; right: number }; getState(): EdgeState }

/**
 * Header names of the displayed columns that do not fit inside the viewport at scroll 0, in order. Empty when every column fits or the
 * grid has no width yet. The width is the grid's own horizontal range, which is the scroll viewport's client width, so a result is
 * non-empty exactly when that viewport scrolls sideways. It does not change with the scroll position. A column with no header name
 * given is named by its id.
 */
export function columnsBeyondEdge(api: EdgeApi, headerNames: Readonly<Record<string, string>> = {}): string[] {
  const { left, right } = api.getHorizontalPixelRange();
  const width = right - left;
  if (width <= 0) return [];
  const state = api.getState();
  const hidden = new Set(state.columnVisibility?.hiddenColIds ?? []);
  const widths = new Map((state.columnSizing?.columnSizingModel ?? []).map(size => [size.colId, size.width ?? 0] as const));
  let edge = 0;
  const beyond: string[] = [];
  for (const id of state.columnOrder?.orderedColIds ?? []) {
    if (hidden.has(id)) continue;
    edge += widths.get(id) ?? 0;
    if (edge > width) beyond.push(headerNames[id] ?? id);
  }
  return beyond;
}
