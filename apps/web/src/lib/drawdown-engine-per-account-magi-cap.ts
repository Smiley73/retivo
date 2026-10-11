/**
 * MAGI-cap wiring helpers extracted from drawdown-engine-per-account.ts.
 *
 * Exports: `MissingCustomDrawdownOrderError`, `buildCustomTierIndices`,
 * `buildMagiCapConfig`.
 *
 * See `docs/math-withdrawals.md` ("The MAGI cap") for the cap in plain words.
 */
import type { MagiCapWindow } from '../db/types';
import type { MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy';
import type {
  AccountRunState,
  MagiCapWindowRuntime,
} from './drawdown-engine-per-account-strategy-helpers';
import type { DrawdownAccountInput } from './drawdown-engine-types';

/**
 * Build a SINGLE-WINDOW runtime list active from `startYear`
 * (inclusive) through `capOffYear` (exclusive) for engine-direct callers / unit
 * tests that drive one cap window without the full runner resolver. Mirrors the
 * legacy single-cap span (active from retirement through `capOffYear - 1`).
 * `startYear` defaults to 0 so the window is active from the run's first year.
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

/**
 * Thrown when `customOrder` strategy is selected but no custom tier
 * layout has been configured (empty tiers / missing `customDrawdownOrder`).
 * Callers should catch and surface a user-readable message before simulation.
 */
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
 * Map account-ID tier arrays → state-index tier arrays.
 * Tiers that reference unknown IDs are silently dropped (unknown accounts
 * won't appear in state, so the index lookup returns -1 and is filtered).
 * `excludedAccountIds` are mapped to a `Set<number>` of state indices.
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
 * Build the runtime MAGI-cap config for ONE window of the cap schedule.
 * `capOffYear` is the window's resolved exclusive
 * `endYear` — within an active window the legacy `calendarYear < capOffYear`
 * test still holds, but the active-year SELECTION is owned by the window list
 * (`selectActiveMagiCapWindow`), not this scalar. Unit-test callers driving a
 * single window directly pass 9999 (cap never expires within the window).
 *
 * `findLaterTaxableIndex` scans tiers after `afterTierIdx` for the first
 * account that can absorb a cap-excess draw WITHOUT generating a pre-tax
 * MAGI event: POST_TAX (non-Roth), MIXED, OR Roth — any account with a
 * non-zero post-tax balance. Roth is included because a Roth withdrawal
 * adds $0 to MAGI, so paying the over-cap (incl. tax-funding) portion from
 * Roth honours the cap exactly as a taxable draw does — the sourcing
 * precedence (taxable / Roth before capped pre-tax). `visited` lets
 * the cap router iterate: after pulling from the first hit, it passes the
 * visited set back in to find the NEXT cap-safe account, including
 * additional ones in the SAME later tier as the first hit (without
 * this the engine would prematurely advance past a tier with multiple targets
 * and record a phantom cap breach).
 */
export function buildMagiCapConfig(
  magiCap: MagiCapWindow,
  capOffYear: number,
): MagiCapRuntimeConfig {
  return {
    capDollars: magiCap.magiCeilingAnnualDollars,
    capOffYear,
    // Behavior keys (read by the conversion fill step). Required on
    // the persisted window; defaulted defensively for partial unit-test inputs.
    capMode: magiCap.capMode ?? 'minimize',
    capMagiLine: magiCap.capMagiLine ?? 'irmaa',
    targetRothAccountId: magiCap.targetRothAccountId,
    // Resolve the user-designated target Roth by EQUALITY to an
    // own-household live Roth account currently present in `state[]`. A
    // dangling / deleted / non-Roth id resolves to `undefined`, so Fill mode
    // degrades to withdrawal-only fill (no conversion). The resolver
    // mirrors the `findLaterTaxableIndex` resolver-on-runtime-config idiom so
    // it always reads live state rather than a stale at-build index.
    findTargetRothIndex: (
      state: ReadonlyArray<AccountRunState>,
    ): number | undefined => {
      const targetId = magiCap.targetRothAccountId;
      if (targetId === undefined) return undefined;
      for (let i = 0; i < state.length; i += 1) {
        const st = state[i];
        if (st.id !== targetId) continue;
        // Only a Roth IRA can receive Fill-mode converted principal. The
        // employer-plan Roth types (ROTH_401K/403B/457B/TSP) are pure
        // designated-Roth plan accounts and cannot accept an in-plan IRA
        // conversion via the Fill mechanism. The exact type is matched (not a
        // type prefix) to prevent silently routing
        // conversion principal into an employer-plan account.
        //
        // An INHERITED Roth IRA is likewise not a valid target — a
        // beneficiary cannot roll into an inherited IRA (§408A(e)), and
        // `creditRothConversionToBasisCarrier` would credit the converted
        // principal to the BENEFICIARY's own §408A pool while the dollars sat in
        // the inherited account, buying tax-free basis on their own Roth IRAs.
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
          // POST_TAX, ROTH, MIXED, and HSA accounts all hold their
          // already-taxed / tax-free dollars in the `post` sub-bucket, which
          // the overflow router draws from. A draw from any of them adds $0 to
          // MAGI, so each is a cap-safe overflow target (excluding Roth
          // would force a premature pre-tax cap breach
          // while spendable Roth remained). Roth carries
          // `taxTreatment === 'ROTH'`; without the explicit
          // `|| isRoth` arm it would not match POST_TAX and would
          // cause that premature breach. HSA qualified withdrawals are
          // likewise MAGI-neutral.
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
