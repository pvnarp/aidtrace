/**
 * Per-user saved grid state, kept in this browser only (docs/plans/GRID_SURFACES_SCOPE.md section 2.6).
 * Stores column order, widths, sort and filter models. It never stores row data, selection or focus.
 */
export const GRID_STATE_VERSION = 1;
export const GRID_STATE_MAX_CHARACTERS = 20_000;

export interface SavedGridState {
  columnOrder?: unknown;
  columnSizing?: unknown;
  sort?: unknown;
  filter?: unknown;
}
const KEPT_KEYS = ['columnOrder', 'columnSizing', 'sort', 'filter'] as const;

export const gridStateKey = (userId: string, gridId: string) => `aidtrace.grid.v1.${userId}.${gridId}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const browserStore = (): Store | null => { try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; } };

/** Keeps only the four allowed keys, so a grid state object carrying more never leaks row data. */
export function pickGridState(state: Record<string, unknown>): SavedGridState {
  const kept: Record<string, unknown> = {};
  for (const key of KEPT_KEYS) if (state[key] !== undefined) kept[key] = state[key];
  return kept as SavedGridState;
}

/** Null for a missing key, bad JSON, a wrong version or an oversize value. The grid then uses its defaults. */
export function loadGridState(userId: string, gridId: string, store: Store | null = browserStore()): SavedGridState | null {
  if (!store) return null;
  let raw: string | null;
  try { raw = store.getItem(gridStateKey(userId, gridId)); } catch { return null; }
  if (raw === null || raw.length > GRID_STATE_MAX_CHARACTERS) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== GRID_STATE_VERSION) return null;
    const state = (parsed as { state?: unknown }).state;
    return typeof state === 'object' && state !== null ? pickGridState(state as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Returns false when the value is too large or storage refuses it. Nothing is stored in that case. */
export function saveGridState(userId: string, gridId: string, state: Record<string, unknown>, store: Store | null = browserStore()): boolean {
  if (!store) return false;
  const text = JSON.stringify({ version: GRID_STATE_VERSION, state: pickGridState(state) });
  if (text.length > GRID_STATE_MAX_CHARACTERS) return false;
  try { store.setItem(gridStateKey(userId, gridId), text); return true; } catch { return false; }
}

export function clearGridState(userId: string, gridId: string, store: Store | null = browserStore()): void {
  try { store?.removeItem(gridStateKey(userId, gridId)); } catch { /* storage refused: nothing to clear */ }
}
