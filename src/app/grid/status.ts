/**
 * One map from payout and policy status to words, a dot class and tooltip text.
 * Color is never the only signal: every status carries its words, and UNKNOWN and NEEDS_ATTENTION are never softened.
 */
export interface StatusInfo { label: string; dot: 'gx-dot-ok' | 'gx-dot-hold' | 'gx-dot-stop' | 'gx-dot-idle'; tip: string }

export const STATUS_INFO: Readonly<Record<string, StatusInfo>> = {
  PAID: { label: 'PAID', dot: 'gx-dot-ok', tip: 'A verified settlement exists for this payout.' },
  PROCESSING: { label: 'PROCESSING', dot: 'gx-dot-idle', tip: 'The payout was submitted and is not settled yet.' },
  UNKNOWN: { label: 'UNKNOWN', dot: 'gx-dot-hold', tip: 'The outcome is not verified. It is not paid and it is not failed. It needs reconciliation.' },
  NEEDS_ATTENTION: { label: 'NEEDS_ATTENTION', dot: 'gx-dot-stop', tip: 'The payout failed, was held for review or was rejected for funding. A person must look at it.' },
  NO_PAYMENT: { label: 'NO_PAYMENT', dot: 'gx-dot-idle', tip: 'No payment has been sent in this environment.' },
};

const FALLBACK: StatusInfo = { label: 'UNKNOWN', dot: 'gx-dot-hold', tip: STATUS_INFO.UNKNOWN!.tip };

/** An unrecognized status reads as UNKNOWN, never as paid. */
export function statusInfo(key: string | null | undefined): StatusInfo {
  return (key && Object.hasOwn(STATUS_INFO, key) ? STATUS_INFO[key] : undefined) ?? FALLBACK;
}
