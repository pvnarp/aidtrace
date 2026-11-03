import type { AssistedQueueRow } from './columns';

type CellProps = { data?: AssistedQueueRow };
const stateOf = (checks: string) => (checks === 'No holds found' ? 'none-found' : checks === 'Not checked yet' ? 'not-yet' : 'holds');

/** The Checks words. The state is in the words, and the color only repeats it. The words state what was found and give no verdict on the claim. */
export function ChecksCell({ data }: CellProps) {
  if (!data?.checks) return null;
  return <span className="aq-check" data-state={stateOf(data.checks)}>{data.checks}</span>;
}
