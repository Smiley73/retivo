/**
 * MAGI-cap wiring helpers: custom tier indices and the runtime config for one cap window.
 * See `docs/math-withdrawals.md` ("The MAGI cap").
 */
import type { MagiCapWindow } from '../db/types';
import type { MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy';
import type {
  AccountRunState,
  MagiCapWindowRuntime,
} from './drawdown-engine-per-account-strategy-helpers';
import type { DrawdownAccountInput } from './drawdown-engine-types';

/**
 * Builds a single-window runtime list active from `startYear` (default 0, inclusive) through `capOffYear`
 * (exclusive), for engine-direct callers that bypass the runner's resolver.
 */
export function singleMagiCapWindow(
  window: MagiCapWindow,
  capOffYear: number,
  startYear = 0,
): ReadonlyArray<MagiCapWindowRuntime> {
  return [
    {
      startYear,
      endYear: capOffYear,
      originalIndex: 0,
      config: buildMagiCapConfig(window, capOffYear),
    },
  ];
}

/** Thrown when `customOrder` is selected but no custom tier layout is configured. */
export class MissingCustomDrawdownOrderError extends Error {
  constructor() {
    super(
      'drawdown-engine: strategy is "customOrder" but no custom drawdown order ' +
        'has been configured. Set customDrawdownOrder on DrawdownInput before calling ' +
        'simulatePerAccountMonthly.',
    );
    this.name = 'MissingCustomDrawdownOrderError';
  }
}

/**
 * Maps account-id tier arrays to state-index tier arrays; unknown ids are dropped and `excludedAccountIds`
 * become a set of state indices.
 */
export function buildCustomTierIndices(
  accountsIn: ReadonlyArray<DrawdownAccountInput>,
  tiersByIds: ReadonlyArray<ReadonlyArray<string>>,
  excludedIds: ReadonlyArray<string>,
): {
  customTiers: ReadonlyArray<ReadonlyArray<number>>;
  excludedIndices: ReadonlySet<number>;
} {
  const idToIdx = new Map<string, number>();
  for (let i = 0; i < accountsIn.length; i += 1) {
    idToIdx.set(accountsIn[i].id, i);
  }
  const customTiers: number[][] = tiersByIds
    .map((tier) => tier.map((id) => idToIdx.get(id) ?? -1).filter((idx) => idx !== -1))
    .filter((tier) => tier.length > 0);
  const excludedIndices = new Set<number>(
    excludedIds.map((id) => idToIdx.get(id) ?? -1).filter((idx) => idx !== -1),
  );
  return { customTiers, excludedIndices };
}

/**
 * Builds the runtime MAGI-cap config for one cap window; `capOffYear` is its exclusive `endYear` (tests pass
 * 9999).
 * `findLaterTaxableIndex` returns the first later account with a post-tax balance (taxable, MIXED or Roth): a
 * draw from it adds $0 to MAGI. `visited` lets the router find the next one, including in the same tier.
 */
export function buildMagiCapConfig(
  magiCap: MagiCapWindow,
  capOffYear: number,
): MagiCapRuntimeConfig {
  return {
    capDollars: magiCap.magiCeilingAnnualDollars,
    capOffYear,
    capMode: magiCap.capMode ?? 'minimize',
    capMagiLine: magiCap.capMagiLine ?? 'irmaa',
    targetRothAccountId: magiCap.targetRothAccountId,
    // The target Roth resolves by equality to a live own-household Roth in `state[]`; a dangling or non-Roth
    // id gives `undefined`, so Fill degrades to withdrawal-only.
    findTargetRothIndex: (
      state: ReadonlyArray<AccountRunState>,
    ): number | undefined => {
      const targetId = magiCap.targetRothAccountId;
      if (targetId === undefined) return undefined;
      for (let i = 0; i < state.length; i += 1) {
        const st = state[i];
        if (st.id !== targetId) continue;
        // Only a Roth IRA can receive Fill conversions: employer-plan Roth types cannot take an in-plan IRA
        // conversion and nothing can be rolled into an inherited IRA (§408A(e)).
        if (st.inheritedAccount === true) return undefined;
        return st.accountType === 'RETIREMENT_ROTH_IRA' ? i : undefined;
      }
      return undefined;
    },
    findLaterTaxableIndex: (
      tiers: ReadonlyArray<ReadonlyArray<number>>,
      afterTierIdx: number,
      state: ReadonlyArray<AccountRunState>,
      visited: ReadonlySet<number>,
    ): number | undefined => {
      for (let t = afterTierIdx + 1; t < tiers.length; t += 1) {
        for (const idx of tiers[t]) {
          if (visited.has(idx)) continue;
          const st = state[idx];
          if (!st) continue;
          // POST_TAX, ROTH, MIXED and HSA accounts draw from the `post` sub-bucket and add $0 to MAGI, so all
          // are cap-safe overflow targets.
          const isPostTax = st.taxTreatment === 'POST_TAX';
          const isRoth = st.taxTreatment === 'ROTH';
          const isMixed = st.taxTreatment === 'MIXED';
          const isHsa = st.taxTreatment === 'HSA';
          if ((isPostTax || isRoth || isMixed || isHsa) && st.post > 0) return idx;
        }
      }
      return undefined;
    },
  };
}
