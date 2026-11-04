import { and, eq, isNotNull } from 'drizzle-orm';
import * as s from '../../db/schema';
import type { AppDatabase } from '../server/db';
import type { WhyRecognized, WhyRows } from './why-facts';

// IAC-405 step 5. Read-only queries that feed whyFacts. Select statements only, run inside the caller's read only transaction.
type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];
export async function loadWhyRows(tx: Tx, organizationId: string): Promise<WhyRows> {
  const automated = await tx.select({ hash: s.automatedDecisions.decisionHash, kind: s.automatedDecisions.kind, ruleSetVersion: s.automatedDecisions.ruleSetVersion, model: s.automatedDecisions.model, promptVersion: s.automatedDecisions.promptVersion, recordedAt: s.automatedDecisions.recordedAt })
    .from(s.automatedDecisions).innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.automatedDecisions.decisionHash))
    .where(eq(s.allocationDecisions.organizationId, organizationId));
  const debits = await tx.select({ hash: s.allocationDecisions.decisionHash, cents: s.fundDebits.amountCents }).from(s.fundDebits)
    .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.id, s.fundDebits.decisionId))
    .where(and(eq(s.allocationDecisions.organizationId, organizationId), isNotNull(s.allocationDecisions.recognizedAt)));
  const cents = new Map<string, bigint>();
  for (const debit of debits) cents.set(debit.hash, (cents.get(debit.hash) ?? 0n) + debit.cents);
  const byHash = new Map<string, { kinds: string[]; recognized: WhyRecognized | null }>();
  for (const row of automated) {
    const entry = byHash.get(row.hash) ?? { kinds: [], recognized: null };
    entry.kinds.push(row.kind);
    if (row.kind === 'AUTO_RECOGNIZED') entry.recognized = { cents: cents.get(row.hash) ?? 0n, ruleSetVersion: row.ruleSetVersion, model: row.model, promptVersion: row.promptVersion, recordedAtMs: row.recordedAt.getTime() };
    byHash.set(row.hash, entry);
  }
  const signed = await tx.select({ amountCents: s.disbursements.amountCents }).from(s.disbursementOrigins)
    .innerJoin(s.disbursements, eq(s.disbursements.id, s.disbursementOrigins.disbursementId))
    .innerJoin(s.allocationDecisions, eq(s.allocationDecisions.decisionHash, s.disbursements.decisionHash))
    .where(and(isNotNull(s.disbursementOrigins.signedBy), eq(s.allocationDecisions.organizationId, organizationId)));
  const off = await tx.select({ reason: s.automationSwitchEvents.reason }).from(s.automationSwitchEvents)
    .where(and(eq(s.automationSwitchEvents.organizationId, organizationId), eq(s.automationSwitchEvents.event, 'OFF')));
  return { decisions: [...byHash.values()], signedPayouts: signed, switchOff: off };
}
