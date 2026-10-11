/**
 * Balance Projection page — Account Balance Stack section: the
 * "Account balances over time" band plus the `accountMeta` projection
 * (the only reader of the `accounts` prop). Split out of
 * `balance-projection-page-charts.tsx` so this half — the account
 * balance stack — and the tax/RMD/QCD/Roth half each compose into a
 * single future view independently. Always rendered when there is
 * drawdown data. Heading owned by the band itself; the outer section is
 * unlabeled to avoid a redundant duplicate.
 */
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
  /** Label of the basis the resolved drawdown reflects (the MC tier when a
   *  Monte Carlo basis is active, else the deterministic method label).
   *  Suffixed onto the Account Balance Stack title so it names the basis
   *  actually driving it. */
  readonly resolvedLabel: string;
  /** True when an MC basis is the RESOLVED basis — drives the
   *  "Based on one example simulated path." sub-label below the title. False
   *  under a deterministic method. */
  readonly isMcBasisActive: boolean;
  readonly customTiers: ReadonlyArray<ReadonlyArray<string>> | null;
  readonly excludedAccountIds: ReadonlyArray<string>;
  /** Unified continuous-timeline rows for the "Account balances over time"
   *  band (historical → accumulation → drawdown, projected region deflated). */
  readonly accountStackTimeline: ReadonlyArray<StackBandYear>;
  /** Dashed actual→projected boundary year for that band (null = no history). */
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

  /** MC-only note under the resolved-source card title ("Based on one
   *  example simulated path."); absent under a deterministic method. */
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
