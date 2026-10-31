/**
 * Filter timing for the shared grid (LG-05b). A quick filter change makes AG Grid 36.2.0 rewrite every unfocused text and BigInt
 * floating filter input from its applied model, so a column edit still waiting for its debounce (500 ms by default) is lost: a
 * cleared Fund filter came back when the search box changed at once. Column filters therefore apply at once, and the search box
 * waits longer than that before it reaches the grid. Both are timers, and timers fire in deadline order, so a pending column edit
 * always lands first.
 */
export const COLUMN_FILTER_DEBOUNCE_MS = 0;
export const SEARCH_DELAY_MS = 150;
