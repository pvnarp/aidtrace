import type { Page } from '@playwright/test';

/**
 * Browser measurements for a wide report grid (IAC-440 grid report polish, GE-01 to GE-10). Not a spec: Playwright runs only *.spec.ts files.
 * Everything is read from the rendered page, so a column definition that looks right but renders cut still fails.
 */

/** Pixels of rounding slack when a box edge is compared with the frame edge. */
export const EDGE_TOLERANCE = 2;
/** The least width a text or money floating filter input may have (GE-03). */
export const MIN_FILTER_INPUT = 64;

export interface EdgeReport {
  /** The grid's inner right edge in page pixels: the wrapper's right edge less its border. */
  edge: number;
  /** Headers, filter cells and data cells examined, so a vacuous pass cannot hide. */
  checked: { headers: number; groupLabels: number; filterCells: number; cells: number };
  /** Boxes that start inside the edge and end past it, each as "kind col-id". Empty is the pass. */
  crossing: string[];
  /** Right edge less the grid edge for the named leaf header, in pixels. Zero means the column ends exactly on the edge. */
  gap: Record<string, number>;
  /** Column ids of every header cell that starts at or past the edge (off screen at scroll 0). */
  offScreen: string[];
}

/** One page measurement of where every rendered header, group label, filter cell and cell sits against the grid's right edge at the current scroll. */
export function measureEdge(page: Page, leafIds: string[]): Promise<EdgeReport> {
  return page.evaluate(({ ids, tolerance }) => {
    const wrapper = document.querySelector('.ag-root-wrapper') as HTMLElement;
    const box = wrapper.getBoundingClientRect(); const edge = box.right - parseFloat(getComputedStyle(wrapper).borderRightWidth || '0');
    const crossing: string[] = []; const offScreen: string[] = []; const gap: Record<string, number> = {};
    const straddles = (rect: DOMRect) => rect.width > 0 && rect.left < edge - tolerance && rect.right > edge + tolerance;
    const named = (element: Element) => element.getAttribute('col-id') ?? element.getAttribute('aria-label') ?? element.className;
    const checked = { headers: 0, groupLabels: 0, filterCells: 0, cells: 0 };
    for (const header of document.querySelectorAll('.ag-header-row-column .ag-header-cell')) {
      const rect = header.getBoundingClientRect(); const id = header.getAttribute('col-id') ?? '';
      if (rect.left >= edge - tolerance) { offScreen.push(id); continue; }
      checked.headers++; if (straddles(rect)) crossing.push(`header ${id}`);
      if (ids.includes(id)) gap[id] = Math.round((rect.right - edge) * 100) / 100;
    }
    // A group box may run on past the edge as its columns do. Its label, the text a person reads, must not.
    for (const label of document.querySelectorAll('.ag-header-group-cell .ag-header-group-text')) {
      const rect = label.getBoundingClientRect(); if (rect.left >= edge - tolerance) continue;
      checked.groupLabels++; if (straddles(rect) || label.scrollWidth > label.clientWidth) crossing.push(`group label ${label.textContent}`);
    }
    for (const cell of document.querySelectorAll('.ag-floating-filter')) {
      const rect = cell.getBoundingClientRect(); if (rect.left >= edge - tolerance) continue;
      checked.filterCells++; if (straddles(rect)) crossing.push(`filter ${named(cell)}`);
    }
    for (const cell of document.querySelectorAll('.ag-row .ag-cell')) {
      const rect = cell.getBoundingClientRect(); if (rect.left >= edge - tolerance) continue;
      checked.cells++; if (straddles(rect)) crossing.push(`cell ${named(cell)}`);
    }
    return { edge, checked, crossing, gap, offScreen };
  }, { ids: leafIds, tolerance: EDGE_TOLERANCE });
}

export interface FilterWidths {
  /** Per column id: the floating filter input's width and, for a date, the width an unconstrained copy of the input needs for its whole placeholder. */
  inputs: { id: string; kind: 'date' | 'text'; width: number; needs: number }[];
}

/** Every rendered floating filter input, with the width a date input needs. A date input is a native field whose placeholder is clipped
 * silently, so the need is measured by putting an unconstrained copy next to it. */
export function measureFilters(page: Page): Promise<FilterWidths> {
  return page.evaluate(() => {
    const inputs: FilterWidths['inputs'] = [];
    const grid = (document.querySelector('.ag-root-wrapper') as HTMLElement).getBoundingClientRect();
    for (const cell of document.querySelectorAll('.ag-floating-filter[col-id]')) {
      // A column scrolled out of the viewport keeps a header cell in the page but no laid out input, so only a cell on screen counts.
      const box = cell.getBoundingClientRect(); if (box.right <= grid.left + 1 || box.left >= grid.right - 1) continue;
      const id = cell.getAttribute('col-id')!; const input = [...cell.querySelectorAll('input')].find(item => item.getBoundingClientRect().width > 0) as HTMLInputElement | undefined; if (!input) continue;
      const rect = input.getBoundingClientRect(); const kind = input.type === 'date' ? 'date' : 'text'; let needs = 0;
      if (kind === 'date') {
        const copy = input.cloneNode() as HTMLInputElement; copy.style.cssText = 'position:absolute;visibility:hidden;width:auto;';
        input.parentElement!.appendChild(copy); needs = copy.getBoundingClientRect().width; copy.remove();
      }
      inputs.push({ id, kind, width: Math.round(rect.width * 100) / 100, needs: Math.round(needs * 100) / 100 });
    }
    return { inputs };
  });
}

export interface Overflow { scrollWidth: number; clientWidth: number; overflows: boolean }

/** The center viewport: the part of the grid that scrolls sideways. */
export function centerOverflow(page: Page): Promise<Overflow> {
  return page.evaluate(() => {
    const viewport = document.querySelector('.ag-body-horizontal-scroll-viewport') as HTMLElement;
    return { scrollWidth: viewport.scrollWidth, clientWidth: viewport.clientWidth, overflows: viewport.scrollWidth > viewport.clientWidth };
  });
}

/** Scrolls the grid fully left or right and waits one frame for the grid to render the columns that came into view. */
export async function scrollSideways(page: Page, to: 'left' | 'right') {
  await page.evaluate(side => { const viewport = document.querySelector('.ag-body-horizontal-scroll-viewport') as HTMLElement; viewport.scrollLeft = side === 'right' ? viewport.scrollWidth : 0; }, to);
  await page.waitForTimeout(250);
}

export interface WrapReport {
  /** Data rows rendered, and wrapped data cells examined per column id, so a column the grid did not render cannot pass vacuously. */
  rows: number;
  cells: Record<string, number>;
  /** Cells whose text is cut sideways or vertically (content past the cell box, or the cell past its row), each as "col-id: text". Empty is the pass. */
  overflowing: string[];
  /** Data rows shorter than 44 px, each as "row-index: height". Empty is the pass. */
  short: string[];
  /** The tallest data row in pixels, and the number of rows taller than the 44 px default. */
  tallest: number; grown: number;
}

/** WR-05 and WR-06: every rendered cell in the wrapped columns shows its text whole, sideways and vertically, and no data row is shorter than 44 px. */
export function measureWrap(page: Page, ids: string[]): Promise<WrapReport> {
  return page.evaluate(wrapIds => {
    const overflowing: string[] = []; const short: string[] = []; const cells: Record<string, number> = {}; let tallest = 0; let grown = 0;
    const rowHeights = new Map<string, number>();
    for (const row of document.querySelectorAll('.ag-row[row-id]:not(.ag-row-pinned)')) {
      const height = row.getBoundingClientRect().height; const key = row.getAttribute('row-index') ?? '';
      if (rowHeights.has(key)) continue; rowHeights.set(key, height);
      if (height < 43.5) short.push(`${key}: ${height}`); if (height > 44.5) grown++; tallest = Math.max(tallest, height);
    }
    const cut = (node: Element) => node.clientWidth > 0 && (node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1);
    for (const id of wrapIds) {
      cells[id] = 0;
      for (const cell of document.querySelectorAll(`.ag-row[row-id]:not(.ag-row-pinned) .ag-cell[col-id="${id}"]`)) {
        cells[id]++;
        const row = cell.closest('.ag-row')!.getBoundingClientRect(); const box = cell.getBoundingClientRect();
        if ([cell, ...cell.querySelectorAll('*')].some(cut) || box.bottom > row.bottom + 1 || box.top < row.top - 1) overflowing.push(`${id}: ${cell.textContent}`);
      }
    }
    return { rows: rowHeights.size, cells, overflowing, short, tallest, grown };
  }, ids);
}

export interface LongCell { found: boolean; rowHeight: number; textHeight: number; lineHeight: number }

/** WR-05 and WR-06: the data cell in a column whose text includes a known long value, its row height and the height of its rendered text. */
export function measureLongCell(page: Page, id: string, text: string): Promise<LongCell> {
  return page.evaluate(({ id, text }) => {
    const cell = [...document.querySelectorAll(`.ag-row[row-id]:not(.ag-row-pinned) .ag-cell[col-id="${id}"]`)].find(node => (node.textContent ?? '').includes(text));
    if (!cell) return { found: false, rowHeight: 0, textHeight: 0, lineHeight: 0 };
    const range = document.createRange(); range.selectNodeContents(cell);
    return { found: true, rowHeight: cell.closest('.ag-row')!.getBoundingClientRect().height, textHeight: range.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(cell).lineHeight) };
  }, { id, text });
}

/**
 * WR-05 and WR-06: data rows that overlap the next row ("row-index: bottom > next top") or still move ("row-index: moving"). AG Grid
 * slides rows to their grown positions over about 0.4 s, so this samples twice 450 ms apart and a caller polls until it is empty;
 * a layout that never settles, or settles overlapped, fails by name.
 */
export function rowOverlaps(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const sample = () => {
      const boxes = new Map<number, DOMRect>();
      for (const row of document.querySelectorAll('.ag-row[row-id]:not(.ag-row-pinned)')) {
        const index = Number(row.getAttribute('row-index')); if (!boxes.has(index)) boxes.set(index, row.getBoundingClientRect());
      }
      return boxes;
    };
    const first = sample(); await new Promise(resolve => setTimeout(resolve, 450)); const second = sample();
    const problems: string[] = [];
    for (const [index, box] of second) { const before = first.get(index); if (!before || Math.abs(before.top - box.top) > 0.5 || Math.abs(before.height - box.height) > 0.5) problems.push(`${index}: moving`); }
    const sorted = [...second.entries()].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      const [index, above] = sorted[i - 1]; const below = sorted[i][1];
      if (above.bottom > below.top + 1) problems.push(`${index}: ${Math.round(above.bottom)} > ${Math.round(below.top)}`);
    }
    return problems;
  });
}
