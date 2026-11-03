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
