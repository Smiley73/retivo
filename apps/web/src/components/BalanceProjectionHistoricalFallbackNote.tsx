/**
 * Discloses that the Historical (TWR) view mixes measured and planned returns, naming the accounts that fell back;
 * the caller gates visibility.
 */
import React from 'react';
import { Alert } from './Alert';
import { TWR_METHOD_LABEL } from '../lib/projection-method-labels';

export interface BalanceProjectionHistoricalFallbackNoteProps {
  readonly accounts: ReadonlyArray<{ id: string; name: string }>;
}

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
