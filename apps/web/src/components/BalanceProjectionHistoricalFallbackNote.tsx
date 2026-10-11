/**
 * Historical (TWR) planned-rate fallback disclosure for the Balance
 * Projection page's per-year line chart.
 *
 * The Historical view projects each account on its own empirical
 * time-weighted return — but an account without 2+ years of balance
 * history has no empirical rate, so it falls back to its PLANNED return
 * inside the Historical view (so a single empty / new account does not
 * blank the whole chart). The Historical line is then a mix:
 * measured returns where history exists, planned returns where it doesn't.
 * This note discloses that mix in plain English, naming the accounts that
 * fell back (names only) so the blended basis is not silent.
 *
 * Rendered via the typed `Alert` (`tone="info"`, polite `role="status"`) —
 * an informational disclosure that should not interrupt assistive tech.
 * The caller gates visibility on `activeMethod === 'twr'` AND a non-empty
 * fallback set.
 */
import React from 'react';
import { Alert } from './Alert';
import { TWR_METHOD_LABEL } from '../lib/projection-method-labels';

export interface BalanceProjectionHistoricalFallbackNoteProps {
  /** Accounts projecting on their planned rate under the Historical view.
   *  Caller guarantees a non-empty list (the gate is a length check). */
  readonly accounts: ReadonlyArray<{ id: string; name: string }>;
}

/** Join account names into a readable, plain-English list:
 *  "A", "A and B", "A, B, and C". */
function joinNames(names: ReadonlyArray<string>): string {
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

export const BalanceProjectionHistoricalFallbackNote: React.FC<
  BalanceProjectionHistoricalFallbackNoteProps
> = ({ accounts }) => {
  const names = joinNames(accounts.map((a) => a.name));
  const isSingle = accounts.length === 1;
  return (
    <Alert tone="info" role="status">
      <strong>
        {TWR_METHOD_LABEL} uses your planned return for {names}.
      </strong>{' '}
      {isSingle ? 'This account' : 'These accounts'} don&rsquo;t have 2+ years
      of balance history yet, so the {TWR_METHOD_LABEL} view projects{' '}
      {isSingle ? 'it' : 'them'} at the planned return instead of an actual
      one. The rest of your accounts still use their own measured returns.
    </Alert>
  );
};
