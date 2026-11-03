'use client';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import '../approver-queue/approver-queue.css';
import './assisted-queue.css';
import { BULK_LIMIT, BULK_SAVED_TEXT, BULK_SKIP_REASONS, BULK_SKIP_TEXT, type BulkSkipReason } from '../../fund-modes/bulk-reasons';
import type { ApproverQueueRow } from '../../server/approver-queue';
import type { AssistedChecks } from '../../server/assisted-checks';
import type { DataGrid as DataGridComponent } from '../grid/grid';
import { SELECTION_MODULES } from '../grid/modules';
import { assistedColumns, type AssistedQueueRow } from './columns';
import { QUEUE_PHONE_COLUMNS } from '../approver-queue/columns';

// IAC-405 PR A (docs/plans/FUND_MODES_SCOPE.md section 4, docs/ASSUMPTIONS.md section 77): the approver queue when the fund modes flag is on and at least one waiting claim is Assisted. It adds the Checks
// column and row selection, and one button that posts claim ids and claim versions to /api/approvals/bulk. A row can be selected only when the server read "No holds found" for it. The browser sends no hash,
// no mode and no check result: the route decides every one of those again. There is no send button here: a payment stays one click per claim on the claim page.
const DataGrid = dynamic(() => import('../grid/grid'), { ssr: false, loading: () => <p role="status">Loading approval queue...</p> }) as unknown as typeof DataGridComponent;

const rowId = (row: AssistedQueueRow) => row.id;
const EMPTY = { filtered: 'No queued claims match this search or filter.' };
const frameRows = (count: number) => Math.max(1, Math.min(count, 12));
const isRowSelectable = (row: AssistedQueueRow) => row.selectable === true;

type Result = { approved: string[]; saved: { claimId: string; text: string }[]; skipped: { claimId: string; reason: BulkSkipReason; text: string }[] } | 'failed';
const isReason = (value: unknown): value is BulkSkipReason => typeof value === 'string' && (BULK_SKIP_REASONS as readonly string[]).includes(value);
// Only the shape the route sends is kept, and each sentence is read from the fixed table here instead of from the answer.
function readResult(value: unknown): Result {
  if (!value || typeof value !== 'object') return 'failed';
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.approved) || !Array.isArray(body.saved) || !Array.isArray(body.skipped)) return 'failed';
  const id = (item: unknown): string | null => (typeof item === 'string' ? item : null);
  return {
    approved: body.approved.flatMap(item => { const found = id(item); return found ? [found] : []; }),
    saved: body.saved.flatMap(item => { const found = id((item as { claimId?: unknown } | null)?.claimId); return found ? [{ claimId: found, text: BULK_SAVED_TEXT }] : []; }),
    skipped: body.skipped.flatMap(item => { const entry = item as { claimId?: unknown; reason?: unknown } | null; const found = id(entry?.claimId); return found && isReason(entry?.reason) ? [{ claimId: found, reason: entry.reason, text: BULK_SKIP_TEXT[entry.reason] }] : []; }),
  };
}

export function AssistedQueueClient({ rows, observedAt, userId, assisted }: { rows: ApproverQueueRow[]; observedAt: string; userId: string; assisted: Record<string, AssistedChecks> }) {
  const router = useRouter();
  const merged = useMemo<AssistedQueueRow[]>(() => rows.map(row => {
    const found = assisted[row.id];
    return found ? { ...row, claimVersion: found.claimVersion, checks: found.checks, selectable: found.selectable, approvals: found.approvals ?? row.approvals } : row;
  }), [rows, assisted]);
  const columns = useMemo(() => assistedColumns(), []);
  const [selected, setSelected] = useState<AssistedQueueRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // A new generation remounts the grid, which clears the selection after a request. The saved column view returns with it.
  const [generation, setGeneration] = useState(0);
  const selection = useMemo(() => ({ onChange: (picked: AssistedQueueRow[]) => setSelected(picked), isRowSelectable }), []);
  const vendorOf = useCallback((claimId: string) => rows.find(row => row.id === claimId)?.vendor ?? 'A claim', [rows]);
  const count = selected.length;
  const tooMany = count > BULK_LIMIT;

  const approve = async () => {
    if (busy || count === 0 || tooMany) return;
    const body = new URLSearchParams();
    for (const row of selected) if (row.claimVersion !== undefined) body.append('claim', `${row.id}:${row.claimVersion}`);
    setBusy(true); setResult(null);
    try {
      const response = await fetch('/api/approvals/bulk', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      setResult(response.ok ? readResult(await response.json()) : 'failed');
    } catch { setResult('failed'); }
    setSelected([]); setGeneration(value => value + 1); setBusy(false);
    router.refresh();
  };

  return <section className="aq-queue" aria-labelledby="aq-heading" style={{ '--aq-rows': frameRows(rows.length) } as CSSProperties} data-testid="aq-queue">
    <h2 id="aq-heading">Awaiting your approval</h2>
    <p className="aq-note">A claim you approved waits for the second approver and is not listed.</p>
    <div className="aq-bulk">
      <button type="button" onClick={approve} disabled={busy || count === 0 || tooMany} data-testid="aq-bulk-approve">Approve {count} selected</button>
      <p className="aq-bulk-hint">{tooMany ? `Select at most ${BULK_LIMIT} claims at a time.` : 'Only a claim with "No holds found" can be selected. You approve each selected claim yourself; nothing is sent to PayPal.'}</p>
    </div>
    {result && <div className="aq-bulk-result" role="status" data-testid="aq-bulk-result">
      {result === 'failed' ? <p>That request could not be completed. Reload the page to see what changed.</p> : <>
        <p>{result.approved.length === 1 ? 'Approved 1 claim.' : `Approved ${result.approved.length} claims.`}</p>
        {result.saved.length > 0 && <ul>{result.saved.map(item => <li key={item.claimId}>{vendorOf(item.claimId)}: {item.text}</li>)}</ul>}
        {result.skipped.length > 0 && <><p>{result.skipped.length === 1 ? 'Skipped 1 claim.' : `Skipped ${result.skipped.length} claims.`}</p>
          <ul>{result.skipped.map(item => <li key={item.claimId}>{vendorOf(item.claimId)}: {item.text}</li>)}</ul></>}
      </>}
    </div>}
    <DataGrid<AssistedQueueRow>
      key={generation}
      gridId="approver-queue-assisted"
      userId={userId}
      ariaLabel="Expenses awaiting your approval"
      observedAt={observedAt}
      rows={merged}
      getRowId={rowId}
      columns={columns}
      phoneColumns={QUEUE_PHONE_COLUMNS}
      extraModules={SELECTION_MODULES}
      selection={selection}
      emptyMessages={EMPTY}
    />
  </section>;
}
