/** Account Balance Stack section: the "Account balances over time" band plus the accountMeta projection (the only reader of `accounts`).
* Always rendered when there is drawdown data; the band owns the heading and the outer section is unlabeled to avoid a duplicate. */
import React, { useMemo } from 'react';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { TooltipMember } from '../components/tooltip-member';
import type { AccountPayload, Aggregate } from '../db/types';
import {
  AccountBalanceStackBand,
  type StackBandYear,
} from './balance-projection-page-account-balance-stack';
import {
  CARD_SECTION_CLASS,
  MC_REPRESENTATIVE_RUN_SUBLABEL,
} from './balance-projection-page-constants';

export interface BalanceProjectionAccountStackSectionProps {
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly resolvedLabel: string;
  readonly isMcBasisActive: boolean;
  readonly customTiers: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly excludedAccountIds: ReadonlyArray<string>;
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
  readonly accountStackBoundaryYear: number | null;
  readonly markers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
}

export const BalanceProjectionAccountStackSection: React.FC<
  BalanceProjectionAccountStackSectionProps
> = ({
  accounts,
  resolvedLabel,
  isMcBasisActive,
  customTiers,
  excludedAccountIds,
  accountStackTimeline,
  accountStackBoundaryYear,
  markers,
  tooltipMembers,
}) => {
  const accountMeta = useMemo(
    () =>
      accounts.map((a) => ({
        id: a.id,
        name: a.payload.name,
        type: a.payload.type,
        taxTreatment: a.payload.taxTreatment,
      })),
    [accounts],
  );

  const mcSubLabel = isMcBasisActive ? MC_REPRESENTATIVE_RUN_SUBLABEL : undefined;

  if (accountStackTimeline.length === 0) return null;

  return (
    <section
      className={CARD_SECTION_CLASS}
      aria-labelledby="acct-balance-stack-heading"
    >
      <AccountBalanceStackBand
        accounts={accountMeta}
        rows={accountStackTimeline}
        boundaryYear={accountStackBoundaryYear}
        customTiers={customTiers}
        excludedAccountIds={excludedAccountIds}
        markers={markers}
        members={tooltipMembers}
        methodLabel={resolvedLabel}
        subLabel={mcSubLabel}
      />
    </section>
  );
};
