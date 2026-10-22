/** Integration tests for `applyTaxIntegrationToDrawdownYears`, the post-pass annotation layer. */
import { describe, it, expect } from 'vitest';
import { applyTaxIntegrationToDrawdownYears } from './balance-projection-runner-tax';
import {
  buildCashLikeYearAccounts,
  computeCashLikeInterestDollars,
  derivePerAccountRmdShortfallCents,
} from './balance-projection-runner-tax-helpers';
import type { DrawdownYear, DrawdownAccountInput, DrawdownAccountYear } from './drawdown-engine-types';
import type { MonthlyIncomeRow } from './balance-projection-bundle';
import {
  REAL_BUNDLE,
  makeAccountBalance,
  makeCtx,
  makeDrawdownYear,
  makeLedgerAccount,
  type MakeCtxAccountProjections,
} from './balance-projection-runner-tax-test-fixtures';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';
import type { PipelineContext } from './balance-projection-runner-types';
import type { TaxFilingPlan } from './filing-status';
import { deriveMcSurvivors, type McTaxContext } from './monte-carlo-tax';

describe('applyTaxIntegrationToDrawdownYears', () => {
  describe('basic annotation (named strategy)', () => {
    it('annotates each year with all 15 tax fields', () => {
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000),
        makeDrawdownYear(2025, 50_000),
      ];
      const ctx = makeCtx({ withdrawalStrategy: { kind: 'taxEfficient' } });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      for (const y of years) {
        expect(y.federalTaxCents).toBeDefined();
        expect(y.taxableSsCents).toBeDefined();
        expect(y.ssTaxationTier).toBeDefined();
        expect(y.rmdFloorCents).toBeDefined();
        expect(y.rmdShortfallCents).toBeDefined();
        expect(y.rmdOverflowToCashCents).toBeDefined();
        expect(y.irmaaSurchargeCents).toBeDefined();
        expect(y.irmaaTier).toBeDefined();
        expect(y.acaPtcSubsidyCents).toBeDefined();
        expect(y.acaPtcTier).toBeDefined();
        expect(y.magiCents).toBeDefined();
        expect(y.fplPercentage).toBeDefined();
        expect(y.effectiveTaxRate).toBeDefined();
        expect(y.netAfterTaxCents).toBeDefined();
        expect(y.taxYearExtrapolated).toBeDefined();
      }
    });

    it('federalTaxCents is non-negative for typical income', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 60_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].federalTaxCents).toBeGreaterThanOrEqual(0);
    });

    it('netAfterTaxCents = max(0, grossIncome - federalTax - irmaa + acaPtc)', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      const y = years[0];
      const grossIncomeCents = 50_000 * 100; // preTax = withdrawn (no accountBalances map)
      const expected = Math.max(
        0,
        grossIncomeCents - (y.federalTaxCents ?? 0) - (y.irmaaSurchargeCents ?? 0) + (y.acaPtcSubsidyCents ?? 0),
      );
      expect(y.netAfterTaxCents).toBe(expected);
    });

    it('taxYearExtrapolated is false for a supported year', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].taxYearExtrapolated).toBe(false);
    });

    it('taxYearExtrapolated is true for a far-future year', () => {
      // 2050 is beyond the snapshot range, and the primary (born 1960) is alive at 90 under the default life expectancy of 95.
      const years: DrawdownYear[] = [makeDrawdownYear(2050, 50_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].taxYearExtrapolated).toBe(true);
    });

    it('skips tax math when both members are past life expectancy', () => {
      // 2070: both members are dead under the default life expectancy (primary born 1960 dies 2055); tax fields stay undefined.
      const years: DrawdownYear[] = [makeDrawdownYear(2070, 50_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].federalTaxCents).toBeUndefined();
      expect(years[0].taxYearExtrapolated).toBeUndefined();
    });

    it('empty years array does not throw', () => {
      const ctx = makeCtx();
      expect(() =>
        applyTaxIntegrationToDrawdownYears([], [], [], [], ctx, REAL_BUNDLE),
      ).not.toThrow();
    });
  });

  describe('MAGI look-back', () => {
    it('years 0–1 use the two split lookback fields when set (IRMAA fires)', () => {
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000),
        makeDrawdownYear(2025, 50_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
        magiBootstrapLookbackMinus2: 200_000, // year 0 lookback — above Single tier1
        magiBootstrapLookbackMinus1: 200_000, // year 1 lookback — above Single tier1
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[1].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[0].magiEstimatedFromProjection).toBeUndefined();
      expect(years[1].magiEstimatedFromProjection).toBeUndefined();
    });

    it('years 0–1 with no bootstrap ESTIMATE the lookback from projected MAGI + flag', () => {
      // Born 1955 is on Medicare. Low income puts the estimated MAGI below Single tier1, so the surcharge is $0, but the
      // disclosure flag fires because the lookback was estimated rather than stored.
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000),
        makeDrawdownYear(2025, 50_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].irmaaSurchargeCents).toBe(0);
      expect(years[1].irmaaSurchargeCents).toBe(0);
      expect(years[0].magiEstimatedFromProjection).toBe(true);
      expect(years[1].magiEstimatedFromProjection).toBe(true);
    });

    it('year 2+ uses MAGI computed in year i-2 (look-back buffer)', () => {
      // Born 1955 is Medicare-eligible; years 0 and 1 have no bootstrap, so year 2 uses year 0's MAGI, which stays below tier1.
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 5_000),  // low income → low MAGI
        makeDrawdownYear(2025, 5_000),
        makeDrawdownYear(2026, 5_000),  // IRMAA for year 2 uses year 0's MAGI
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].irmaaSurchargeCents).toBe(0);
      expect(years[1].irmaaSurchargeCents).toBe(0);
      expect(years[2].irmaaSurchargeCents).toBe(0);
    });
  });

  describe('estimate-with-disclosure for years 0–1 (no bootstrap)', () => {
    it('$300k MFJ on Medicare year 0, no bootstrap → NON-zero years 0–1 IRMAA + flag', () => {
      // Both members born 1955 are on Medicare; a high all-pre-tax draw puts year-0 projected MAGI above the MFJ tier1
      // threshold, so the estimated lookback surcharges both first years.
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 300_000),
        makeDrawdownYear(2025, 300_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
        secondaryBirthdate: '1955-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[1].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[0].magiEstimatedFromProjection).toBe(true);
      expect(years[1].magiEstimatedFromProjection).toBe(true);
    });

    it('below-calibration-floor year → $0 IRMAA but the disclosure flag still fires', () => {
      // A pre-snapshot tax year throws UnsupportedTaxYear inside applyTaxYear and degrades to $0 tax, but a Medicare member
      // with no bootstrap still gets the disclosure flag.
      const years: DrawdownYear[] = [makeDrawdownYear(2000, 300_000)];
      const ctx = makeCtx({
        primaryBirthdate: '1930-01-01', // age 70 in 2000 → on Medicare
        primaryRetirementYear: 2000,
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].irmaaSurchargeCents).toBeUndefined(); // no annotation (below floor)
      expect(years[0].magiEstimatedFromProjection).toBe(true);
    });
  });

  describe('Roth contribution-tranche exclusion (§408A ordering)', () => {
    it('Roth withdrawal within the owner basis produces zero federal tax', () => {
      // The owner's derived basis ($60k) covers the $50k Roth draw, so it is tax- and penalty-free.
      const accountBalances = new Map([
        ['roth1', makeAccountBalance(400_000, 50_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, accountBalances),
      ];
      const ctx = makeCtx({
        accountProjections: [
          { id: 'roth1', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        ],
        rothBasisCentsByOwner: new Map([['member-primary', 60_000 * 100]]),
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].federalTaxCents).toBe(0);
    });

    it('Roth withdrawal within the owner basis is excluded from MAGI', () => {
      const accountBalances = new Map([
        ['roth1', makeAccountBalance(400_000, 80_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 80_000, accountBalances),
      ];
      const ctx = makeCtx({
        accountProjections: [
          { id: 'roth1', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        ],
        rothBasisCentsByOwner: new Map([['member-primary', 100_000 * 100]]),
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      // MAGI is zero: the whole $80k draw is recovered §408A contribution basis.
      expect(years[0].magiCents).toBe(0);
    });
  });

  describe('POST_TAX classification by account type', () => {
    function magiForPostTaxAccount(accountType: string, taxTreatment: 'POST_TAX' | 'MIXED' = 'POST_TAX'): number {
      const accountBalances = new Map([
        ['acct1', makeAccountBalance(400_000, 40_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({
        costBasisFraction: 0.5,
        accountProjections: [{ id: 'acct1', taxTreatment, accountType }],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      return years[0].magiCents ?? 0;
    }

    // $40k post-tax × (1 − 0.5 cost basis) = $20k LTCG proxy income for BROKERAGE and OTHER
    it.each([
      ['BROKERAGE', 20_000 * 100],
      ['OTHER', 20_000 * 100],
      ['SAVINGS', 0],
      ['MONEY_MARKET', 0],
      ['CD', 0],
      ['HSA', 0],
    ])('%s withdrawal produces %i cents of MAGI', (accountType, magiCents) => {
      expect(magiForPostTaxAccount(accountType)).toBe(magiCents);
    });

    it('cash-like withdrawal still counts toward net-after-tax (tax-free spendable)', () => {
      const accountBalances = new Map([
        ['sav1', makeAccountBalance(400_000, 40_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({
        accountProjections: [{ id: 'sav1', taxTreatment: 'POST_TAX', accountType: 'SAVINGS' }],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      // $0 tax, but the $40k is spendable → netAfterTaxCents = $40k
      expect(years[0].magiCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
      expect(years[0].netAfterTaxCents).toBe(40_000 * 100);
    });

    it.each([
      ['BROKERAGE', 20_000 * 100],
      ['SAVINGS', 0],
    ])('MIXED post-tax sub-bucket follows the same rule by account type — %s is %i cents', (accountType, magiCents) => {
      const row: DrawdownAccountYear = {
        balance: 400_000, preEnd: 0, postEnd: 400_000, withdrawn: 40_000, deposit: 0,
        preWithdrawnCents: 0, postWithdrawnCents: 40_000 * 100,
      };
      const accountBalances = new Map([['mix1', row]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({
        costBasisFraction: 0.5,
        accountProjections: [{ id: 'mix1', taxTreatment: 'MIXED', accountType }],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents).toBe(magiCents);
    });

    it('spending the synthetic RMD-overflow cash carrier adds $0 MAGI / $0 federal tax (return-of-principal)', () => {
      // The carrier is synthetic, not in accountProjections, but its withdrawal must classify cash-like: the surplus was
      // already taxed when the RMD was forced, so spending it later raises neither MAGI nor federal tax.
      const accountBalances = new Map([
        [RMD_OVERFLOW_CASH_ACCOUNT_ID, makeAccountBalance(80_000, 40_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({ costBasisFraction: 0.5, accountProjections: [] });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
      expect(years[0].netAfterTaxCents).toBe(40_000 * 100);
    });
  });

  describe('rmdShortfallCents', () => {
    it('rmdShortfallCents is max(0, rmdFloor - withdrawn)', () => {
      // rmdFloor for $500k at age 73 ≈ $18,868; a $10k draw forces a shortfall.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('ira1', 500_000),
      ];
      const accountBalances = new Map([
        ['ira1', makeAccountBalance(500_000, 10_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 10_000, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01', // age 73 in 2024 → RMD applies
        accountProjections: [
          { id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      // $500k / 26.5 divisor (age 73) = 1,886,792 cents floor; withdrawn $10k = 1,000,000 cents; shortfall = 886,792 cents.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(886_792);
    });

    it('(per-IRS-pool): one IRA covering the whole IRA-pool minimum → no shortfall', () => {
      // The IRS pools an owner's traditional IRAs: the owner may satisfy the whole IRA minimum from any one IRA, so only pool
      // withdrawn against pool required matters. The pool minimum is about $37,736, and A alone draws all of it.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('iraA', 500_000),
        makeLedgerAccount('iraB', 500_000),
      ];
      const accountBalances = new Map([
        // A alone draws the entire owner IRA-pool minimum ($37,735.85); B = $0.
        ['iraA', makeAccountBalance(500_000, 37_735.85)],
        ['iraB', makeAccountBalance(500_000, 0)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 37_735.85, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01', // age 73 in 2024 → RMD applies
        accountProjections: [
          { id: 'iraA', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
          { id: 'iraB', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      // The pool minimum was satisfied from A, so no shortfall (a strict per-account rule would show 1_886_792).
      expect(y.rmdShortfallCents).toBe(0);
      // The floor is the sum of both accounts' RMDs ($37,736, with 1-cent rounding residue).
      expect(y.rmdFloorCents).toBe(3_773_585);
    });

    it('genuine IRA-pool deficit still surfaces (pool withdrawn < pool required)', () => {
      // Same two IRAs; the owner draws only $30k against the ~$37,736 pool minimum, so a real pool deficit remains.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('iraA', 500_000),
        makeLedgerAccount('iraB', 500_000),
      ];
      const accountBalances = new Map([
        ['iraA', makeAccountBalance(500_000, 30_000)],
        ['iraB', makeAccountBalance(500_000, 0)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 30_000, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'iraA', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
          { id: 'iraB', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      // poolRequired (3_773_585) − poolWithdrawn ($30k = 3_000_000) = 773_585.
      expect(y.rmdFloorCents).toBe(3_773_585);
      expect(y.rmdShortfallCents).toBe(3_773_585 - 3_000_000);
    });

    it('MIXED (a): the pre-tax tranche pools with its 403(b) type and forgives within the pool', () => {
      // A pure pre-tax 403(b) and a MIXED 403(b) of one owner pool together (403(b) qualifies MIXED, IRAs do not), counting the
      // MIXED account's pre-tax tranche. The RMD engine subtracts the MIXED post-tax bucket from its RMD base (§325), so with
      // it fully post-tax only the $500k pre-tax 403(b) drives the floor; it draws the whole pool minimum, so no shortfall.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('tsaPre', 500_000),
        makeLedgerAccount('tsaMix', 0, 500_000, { taxTreatment: 'MIXED' }),
      ];
      const accountBalances = new Map<string, DrawdownAccountYear>([
        // Pre-tax 403(b) draws the whole owner 403(b)-pool minimum ($18,867.92).
        ['tsaPre', makeAccountBalance(500_000, 18_867.92)],
        // MIXED account drew $20k but all post-tax (preWithdrawnCents = 0).
        ['tsaMix', { ...makeAccountBalance(500_000, 20_000), preWithdrawnCents: 0 }],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 38_867.92, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'tsaPre', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_403B' },
          { id: 'tsaMix', taxTreatment: 'MIXED', accountType: 'RETIREMENT_403B' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      // The pre-tax 403(b) satisfied the pool minimum; MIXED post dollars don't count.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(0);
    });

    it('MIXED (b): undefined preWithdrawnCents contributes 0 → a genuine pre-tax deficit surfaces', () => {
      // A single MIXED 401(k) with $500k pre-tax and $0 post is wholly RMD-eligible. With no pre/post split surfaced
      // (preWithdrawnCents undefined) pre-tax withdrawn is conservatively 0, so the whole RMD shows as a shortfall.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('kMix', 500_000, 0, { taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }),
      ];
      const accountBalances = new Map<string, DrawdownAccountYear>([
        // Withdrawn $20k with no preWithdrawnCents field is treated as 0 pre-tax.
        ['kMix', makeAccountBalance(500_000, 20_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 20_000, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'kMix', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      // Floor = $500k / 26.5 = 1_886_792 (the post bucket is $0); pre-tax withdrawn counts as 0, so the full miss surfaces.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(1_886_792);
    });

    it('orphan id (no resolvable account) → own singleton pool, full miss, no throw (direct)', () => {
      // An id in rmdPerAccountCents but absent from accountProjections: the full pipeline never surfaces one, so this exercises
      // the defensive orphan branch, which keys it into its own singleton pool by the bare id and never drops the miss.
      const ctx = makeCtx({ accountProjections: [] }); // nothing resolvable
      const year = makeDrawdownYear(
        2024,
        0,
        new Map([['orphan', makeAccountBalance(500_000, 0)]]),
      );
      let result: number | null = 0;
      expect(() => {
        result = derivePerAccountRmdShortfallCents(ctx, year, { orphan: 1_886_792 });
      }).not.toThrow();
      // Orphan: its own singleton pool, $0 pre-tax withdrawn, so the full miss surfaces.
      expect(result).toBe(1_886_792);
    });

    it('non-throw edges: no-accountBalances row, empty rmd map, and post-death-only year resolve cleanly', () => {
      const cpYears: DrawdownYear[] = [makeDrawdownYear(2024, 10_000)];
      const cpCtx = makeCtx({ withdrawalStrategy: { kind: 'taxEfficient' } });
      expect(() =>
        applyTaxIntegrationToDrawdownYears(cpYears, [], [], [], cpCtx, REAL_BUNDLE),
      ).not.toThrow();

      const youngLedger: DrawdownAccountInput[] = [makeLedgerAccount('ira1', 500_000)];
      const youngBalances = new Map([['ira1', makeAccountBalance(500_000, 0)]]);
      const youngYears: DrawdownYear[] = [makeDrawdownYear(2024, 0, youngBalances)];
      const youngCtx = makeCtx({
        primaryBirthdate: '1990-01-01', // far below trigger age → no RMD
        accountProjections: [
          { id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      expect(() =>
        applyTaxIntegrationToDrawdownYears(youngYears, [], [], youngLedger, youngCtx, REAL_BUNDLE),
      ).not.toThrow();
      expect(youngYears[0].rmdShortfallCents).toBe(0);
    });
  });

  describe('perAccountRmdCents stamp', () => {
    it('stamps the per-account RMD map at trigger age, summing to rmdFloorCents (≤1¢)', () => {
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('iraA', 500_000),
        makeLedgerAccount('iraB', 250_000),
      ];
      const accountBalances = new Map([
        ['iraA', makeAccountBalance(500_000, 20_000)],
        ['iraB', makeAccountBalance(250_000, 10_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 30_000, accountBalances)];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01', // age 73 in 2024 → RMD applies
        accountProjections: [
          { id: 'iraA', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
          { id: 'iraB', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      expect(y.perAccountRmdCents).toBeDefined();
      const map = y.perAccountRmdCents as Record<string, number>;
      expect(map['iraA']).toBeGreaterThan(0);
      expect(map['iraB']).toBeGreaterThan(0);
      const sum = Object.values(map).reduce((a, b) => a + b, 0);
      // The sum ties to the household floor within the documented largest-remainder tolerance of 1¢, not exactly.
      expect(Math.abs(sum - (y.rmdFloorCents ?? 0))).toBeLessThanOrEqual(1);
    });

    it('merges BOTH owners (MFJ) and still ties to the household floor (≤1¢)', () => {
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('iraP', 400_000),
        makeLedgerAccount('iraS', 300_000),
      ];
      const accountBalances = new Map([
        ['iraP', makeAccountBalance(400_000, 15_000)],
        ['iraS', makeAccountBalance(300_000, 12_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 27_000, accountBalances)];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        secondaryBirthdate: '1951-01-01', // both at trigger age
        accountProjections: [
          { id: 'iraP', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', ownerId: 'member-primary' },
          { id: 'iraS', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', ownerId: 'member-secondary' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      const map = y.perAccountRmdCents as Record<string, number>;
      expect(map['iraP']).toBeGreaterThan(0);
      expect(map['iraS']).toBeGreaterThan(0);
      const sum = Object.values(map).reduce((a, b) => a + b, 0);
      expect(Math.abs(sum - (y.rmdFloorCents ?? 0))).toBeLessThanOrEqual(1);
    });

    it('excludes the Roth-designated portion of a MIXED account (§325)', () => {
      // MIXED account: half pre-tax, half Roth-designated. Only the pre-tax sub-bucket carries an RMD (§325).
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('mix1', 300_000, 300_000, { taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }),
      ];
      const balances = new Map([
        // preEnd carries the pre-tax sub-bucket; postEnd the Roth-designated half.
        ['mix1', { balance: 600_000, preEnd: 300_000, postEnd: 300_000, withdrawn: 5_000, deposit: 0 }],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 5_000, balances)];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'mix1', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);

      const y = years[0];
      const map = y.perAccountRmdCents as Record<string, number>;
      // RMD on the pre-tax half only ($300k / 26.5 ≈ $11,320), not the full $600k balance.
      expect(map['mix1']).toBeGreaterThan(1_000_000);
      expect(map['mix1']).toBeLessThan(1_300_000);
    });

    it('leaves the field ABSENT below the trigger age', () => {
      const ledger: DrawdownAccountInput[] = [makeLedgerAccount('ira1', 500_000)];
      const balances = new Map([['ira1', makeAccountBalance(500_000, 10_000)]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2026, 10_000, balances)];
      const ctx = makeCtx({
        primaryBirthdate: '1960-01-01', // age 66 in 2026 → below trigger 75
        accountProjections: [
          { id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);
      expect(years[0].perAccountRmdCents).toBeUndefined();
    });

    it('is present but {} when applicable with zero qualifying balance', () => {
      const ledger: DrawdownAccountInput[] = [makeLedgerAccount('ira1', 0)];
      const balances = new Map([['ira1', makeAccountBalance(0, 0)]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 0, balances)];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01', // applicable, but $0 balance
        accountProjections: [
          { id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);
      expect(years[0].perAccountRmdCents).toBeDefined();
      expect(Object.keys(years[0].perAccountRmdCents as object).length).toBe(0);
    });

    it('is behavior-neutral: stamping the field does not move withdrawn/balance/tax', () => {
      // The stamp is additive and display-only: engine-set and tax-annotation fields keep their exact values beside the new map.
      const ledger: DrawdownAccountInput[] = [makeLedgerAccount('ira1', 500_000)];
      const balances = new Map([['ira1', makeAccountBalance(500_000, 10_000)]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 10_000, balances)];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);
      const y = years[0];
      // Same values the RMD-floor test asserts for this exact input.
      expect(y.withdrawn).toBe(10_000);
      expect(y.balance).toBe(500_000);
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(886_792);
      expect(y.perAccountRmdCents).toBeDefined();
    });

    it('no-accountBalances row: field absent (no per-account RMD without a per-account map)', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000)];
      const ctx = makeCtx({
        withdrawalStrategy: { kind: 'taxEfficient' },
        primaryBirthdate: '1951-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      const map = years[0].perAccountRmdCents;
      expect(map === undefined || Object.keys(map).length === 0).toBe(true);
    });
  });

  describe('cumulative owner-level Roth §408A ordering', () => {
    // Owner age 55 in 2024 (born 1969). Derived basis $40,000.
    function rothCtx(
      basisDollars: number,
      ownerProjections?: MakeCtxAccountProjections,
      exemptIds?: readonly string[],
    ): ReturnType<typeof makeCtx> {
      return makeCtx({
        primaryBirthdate: '1969-01-01', // age 55 in 2024 → pre-59½
        accountProjections: ownerProjections ?? [
          { id: 'roth1', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        ],
        rothBasisCentsByOwner: new Map([['member-primary', basisDollars * 100]]),
        earlyWithdrawalPenaltyExemptAccountIds: exemptIds,
      });
    }

    function rothYear(year: number, withdrawn: number, accountId = 'roth1'): DrawdownYear {
      const accountBalances = new Map([
        [accountId, makeAccountBalance(400_000, withdrawn)],
      ]);
      return makeDrawdownYear(year, withdrawn, accountBalances);
    }

    it('cumulative basis recovers tax/penalty-free until exhausted, then taxes earnings + 10%', () => {
      // Basis $40k. Years 1-2 draw $15k + $15k (cumulative $30k ≤ $40k) → $0 tax and penalty. Year 3 draws $20k (cumulative
      // $50k): the first $10k consumes remaining basis; $10,000 earnings excess is ordinary income + $1,000 (10%) penalty.
      const years: DrawdownYear[] = [
        rothYear(2024, 15_000),
        rothYear(2025, 15_000),
        rothYear(2026, 20_000),
      ];
      const ctx = rothCtx(40_000);
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].magiCents).toBe(0);
      expect(years[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
      expect(years[1].magiCents).toBe(0);
      expect(years[1].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[1].federalTaxCents).toBe(0);
      // Year 3: $10k earnings excess → MAGI $10k, $1,000 penalty; $10k is below the single standard deduction, so the whole
      // federal-tax figure is the folded-in penalty.
      expect(years[2].magiCents).toBe(10_000 * 100);
      expect(years[2].earlyWithdrawalPenaltyCents).toBe(1_000 * 100);
      expect(years[2].federalTaxCents).toBe(1_000 * 100);
    });

    it('aggregates an owner two Roth IRAs (Pub 590-B): $0-basis account B draw covered by basis in A', () => {
      // Two Roth IRAs: A has $40k derived basis, B $0. A $20k pre-59½ draw from B is $0 tax and penalty because the owner's
      // aggregated $40k basis covers it; an accountId-keyed tracker would tax and penalize the whole $20k.
      const projections: MakeCtxAccountProjections = [
        { id: 'rothA', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        { id: 'rothB', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ];
      const years: DrawdownYear[] = [rothYear(2024, 20_000, 'rothB')];
      const ctx = rothCtx(40_000, projections);
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].magiCents).toBe(0);
      expect(years[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
    });

    it('owner-aggregated cumulative draws above $40k basis are taxed + penalized regardless of source account', () => {
      // Same owner, two Roth IRAs ($40k aggregate basis): year 1 draws $30k from A, year 2 $20k from B. Year 2's first $10k
      // exhausts the remaining basis ($40k − $30k); the other $10k is earnings.
      const projections: MakeCtxAccountProjections = [
        { id: 'rothA', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        { id: 'rothB', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ];
      const years: DrawdownYear[] = [
        rothYear(2024, 30_000, 'rothA'),
        rothYear(2025, 20_000, 'rothB'),
      ];
      const ctx = rothCtx(40_000, projections);
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[1].magiCents).toBe(10_000 * 100);
      expect(years[1].earlyWithdrawalPenaltyCents).toBe(1_000 * 100);
    });

    it('conservative undercount: lower derived basis taxes MORE earnings (penalty ≥ full-history case)', () => {
      // Full history: basis $40k → $20k draw is all basis → $0 penalty. Short history: basis $5k → $15k earnings → $1,500 penalty.
      const fullYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const fullCtx = rothCtx(40_000);
      applyTaxIntegrationToDrawdownYears(fullYears, [], [], [], fullCtx, REAL_BUNDLE);

      const shortYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const shortCtx = rothCtx(5_000);
      applyTaxIntegrationToDrawdownYears(shortYears, [], [], [], shortCtx, REAL_BUNDLE);

      expect(fullYears[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(shortYears[0].earlyWithdrawalPenaltyCents).toBe(1_500 * 100);
      expect(shortYears[0].earlyWithdrawalPenaltyCents ?? 0).toBeGreaterThanOrEqual(
        fullYears[0].earlyWithdrawalPenaltyCents ?? 0,
      );
    });

    it('two Roth IRAs, one exempt → penalty waived only for the exempt account share', () => {
      // Two Roth IRAs, $0 basis, each drawing $20k: the $40k earnings are allocated per account ($2,000 penalty each). Exempting
      // only rothA waives just its share, proving the exempt skip is per real account id, not the owner's whole leg.
      const projections: MakeCtxAccountProjections = [
        { id: 'rothA', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        { id: 'rothB', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ];
      const twoRothYear = (): DrawdownYear => {
        const accountBalances = new Map([
          ['rothA', makeAccountBalance(400_000, 20_000)],
          ['rothB', makeAccountBalance(400_000, 20_000)],
        ]);
        return makeDrawdownYear(2024, 40_000, accountBalances);
      };

      const noExemptYears: DrawdownYear[] = [twoRothYear()];
      applyTaxIntegrationToDrawdownYears(noExemptYears, [], [], [], rothCtx(0, projections), REAL_BUNDLE);

      const aExemptYears: DrawdownYear[] = [twoRothYear()];
      applyTaxIntegrationToDrawdownYears(
        aExemptYears,
        [], [], [],
        rothCtx(0, projections, ['rothA']),
        REAL_BUNDLE,
      );

      // Neither exempt: both $2,000 penalties apply → $4,000.
      expect(noExemptYears[0].earlyWithdrawalPenaltyCents).toBe(4_000 * 100);
      // Only rothA exempt: just rothB's $2,000 share is penalized.
      expect(aExemptYears[0].earlyWithdrawalPenaltyCents).toBe(2_000 * 100);
      expect(aExemptYears[0].magiCents).toBe(noExemptYears[0].magiCents);
      expect(aExemptYears[0].magiCents).toBe(40_000 * 100);
    });

    it('Option A exemption waives the Roth earnings-penalty leg only (income tax on earnings unchanged)', () => {
      // $20k draw, $0 basis → $20k earnings: $2,000 penalty + $20k MAGI. Exempting the Roth IRA zeroes the penalty only.
      const nonExemptYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const nonExemptCtx = rothCtx(0);
      applyTaxIntegrationToDrawdownYears(nonExemptYears, [], [], [], nonExemptCtx, REAL_BUNDLE);

      const exemptYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const exemptCtx = rothCtx(0, undefined, ['roth1']);
      applyTaxIntegrationToDrawdownYears(exemptYears, [], [], [], exemptCtx, REAL_BUNDLE);

      expect(nonExemptYears[0].earlyWithdrawalPenaltyCents).toBe(2_000 * 100);
      expect(exemptYears[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(exemptYears[0].magiCents).toBe(nonExemptYears[0].magiCents);
      expect(exemptYears[0].magiCents).toBe(20_000 * 100);
    });
  });

  describe('SS income rows wired', () => {
    it('grossSsDollars from ssRows appears in magiCents', () => {
      // SS.total is an annualized run-rate ($/yr at this month), so a flat $20k/yr benefit shows 20_000 in every month, not
      // 20_000/12.
      const ssRows = Array.from({ length: 12 }, (_, m) => ({
        year: 2024,
        month0: m,
        total: 20_000,
        primary: 20_000,
      }));
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 30_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, ssRows, [], [], ctx, REAL_BUNDLE);

      const yearsNoSs: DrawdownYear[] = [makeDrawdownYear(2024, 30_000)];
      applyTaxIntegrationToDrawdownYears(yearsNoSs, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].magiCents).toBeGreaterThanOrEqual(yearsNoSs[0].magiCents!);
    });

    it('grossSsForYear is the mean of monthly run-rates, not the 12x sum', () => {
      // Summing 12 months of $50k/yr SS naively gave grossSsDollars = $600k and federal tax on 5-10x the real income; the
      // annual amount for a flat $/yr benefit must equal the run-rate (mean of months), not 12x it.
      const flatYear = Array.from({ length: 12 }, (_, m) => ({
        year: 2024,
        month0: m,
        total: 50_000,
        primary: 50_000,
      }));
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, flatYear, [], [], ctx, REAL_BUNDLE);
      // MAGI on $50k SS alone is at most $42.5k (taxable SS caps at 85%), where the 12x bug gave over $500k.
      expect(years[0].magiCents).toBeLessThanOrEqual(50_000 * 100);
    });
  });

  describe('nonSsIncomeRows wired as otherOrdinaryIncomeDollars', () => {
    it('pension income in nonSsIncomeRows increases magiCents vs zero income', () => {
      // pensionIncome is an annualized run-rate, so a $30k/yr pension shows 30_000 in every month; otherOrdinaryIncomeForYear
      // takes the mean.
      const pensionRows: MonthlyIncomeRow[] = Array.from({ length: 12 }, (_, m) => ({
        year: 2024,
        month0: m,
        pensionIncome: 30_000,
        partTimeIncome: 0,
        oneOffIncome: 0,
        depositInflow: 0,
      }));
      const yearsWithPension: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const yearsNoPension: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const ctx = makeCtx();

      applyTaxIntegrationToDrawdownYears(yearsWithPension, [], pensionRows, [], ctx, REAL_BUNDLE);
      applyTaxIntegrationToDrawdownYears(yearsNoPension, [], [], [], ctx, REAL_BUNDLE);

      expect(yearsWithPension[0].magiCents).toBeGreaterThan(yearsNoPension[0].magiCents!);
    });

    it('otherOrdinaryIncomeForYear is the mean of run-rates plus the sum of spikes', () => {
      // Pension and part-time are annualized run-rates, so summing 12 months gives 12x the annual income; oneOffIncome is the
      // literal event-month amount and is summed unchanged.
      const rows: MonthlyIncomeRow[] = Array.from({ length: 12 }, (_, m) => ({
        year: 2024,
        month0: m,
        pensionIncome: 30_000, // $30k/yr run-rate
        partTimeIncome: 0,
        oneOffIncome: m === 3 ? 5_000 : 0, // $5k Apr spike
        depositInflow: 0,
      }));
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], rows, [], ctx, REAL_BUNDLE);
      // MAGI ≈ $35k ($30k pension + $5k oneOff); the 12x bug gave about $365k.
      expect(years[0].magiCents).toBeLessThanOrEqual(40_000 * 100);
    });

    it('depositInflow in nonSsIncomeRows does NOT affect magiCents', () => {
      const depositRows: MonthlyIncomeRow[] = [{
        year: 2024, month0: 0,
        pensionIncome: 0, partTimeIncome: 0, oneOffIncome: 0,
        depositInflow: 50_000, // large portfolio deposit — not ordinary income
      }];
      const yearsWithDeposit: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const yearsNone: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const ctx = makeCtx();

      applyTaxIntegrationToDrawdownYears(yearsWithDeposit, [], depositRows, [], ctx, REAL_BUNDLE);
      applyTaxIntegrationToDrawdownYears(yearsNone, [], [], [], ctx, REAL_BUNDLE);

      expect(yearsWithDeposit[0].magiCents).toBe(yearsNone[0].magiCents);
    });
  });

  describe('unknown account ID routes to postTaxNonRoth', () => {
    it('unknown account ID: withdrawal treated as postTaxNonRoth (not preTax)', () => {
      // An id not in accountProjections routes to postTaxNonRoth (the conservative low-tax direction).
      const accountBalances = new Map([
        ['unknown-id', makeAccountBalance(400_000, 50_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, accountBalances),
      ];
      const ctx = makeCtx({ accountProjections: [] });

      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      // A postTaxNonRoth draw applies the cost-basis fraction (only the gain is taxable), so it taxes less than the same dollars
      // routed as preTax; compare with a known preTax account.
      const accountBalancesPre = new Map([
        ['known-pre', makeAccountBalance(400_000, 50_000)],
      ]);
      const yearsWithPre: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, accountBalancesPre),
      ];
      const ctxWithPre = makeCtx({
        accountProjections: [
          { id: 'known-pre', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(yearsWithPre, [], [], [], ctxWithPre, REAL_BUNDLE);

      expect(yearsWithPre[0].federalTaxCents).toBeGreaterThan(years[0].federalTaxCents!);
    });
  });

  describe('MIXED account withdrawal classification', () => {
    it('MIXED withdrawal with per-bucket fields → pre lands in preTax, post in postTaxNonRoth', () => {
      // A MIXED account withdraws $40k pre + $10k post: the tax pass must classify $40k as preTax and $10k as postTaxNonRoth,
      // not $50k as postTaxNonRoth.
      const mixedRow: DrawdownAccountYear = {
        balance: 100_000,
        preEnd: 60_000,
        postEnd: 40_000,
        withdrawn: 50_000,
        deposit: 0,
        preWithdrawnCents: 40_000 * 100,
        postWithdrawnCents: 10_000 * 100,
      };
      const accountBalances = new Map([['mixed-401k', mixedRow]]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, accountBalances),
      ];
      const ctx = makeCtx({
        accountProjections: [
          { id: 'mixed-401k', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      // Without per-bucket fields the row falls back to all post: tax would be lower because the LTCG proxy applies cost basis.
      const buggyRow: DrawdownAccountYear = {
        balance: 100_000,
        preEnd: 60_000,
        postEnd: 40_000,
        withdrawn: 50_000,
        deposit: 0,
      };
      const buggyBalances = new Map([['mixed-401k', buggyRow]]);
      const buggyYears: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, buggyBalances),
      ];
      applyTaxIntegrationToDrawdownYears(buggyYears, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents!).toBeGreaterThan(buggyYears[0].magiCents!);
    });
  });

  describe('MIXED account RMD basis excludes Roth-designated portion', () => {
    it('MIXED account with $100k pre + $50k post → RMD basis $100k (not $150k)', () => {
      // Born 1951 is 73 in 2024. A MIXED 401k with $100k pre + $50k post (Roth-designated): the year-0 RMD basis is $100k / 26.5
      // ≈ $3,774, not $150k / 26.5 ≈ $5,660.
      const ledger: DrawdownAccountInput[] = [
        {
          id: 'mixed-401k',
          initialPre: 100_000,
          initialPost: 50_000,
          annualRatePct: 5,
          depositsByMonth: [] as unknown as DrawdownAccountInput['depositsByMonth'],
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
        },
      ];
      const accountBalances = new Map([
        ['mixed-401k', { balance: 150_000, preEnd: 100_000, postEnd: 50_000, withdrawn: 0, deposit: 0 } as DrawdownAccountYear],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 0, accountBalances),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1951-01-01',
        accountProjections: [
          { id: 'mixed-401k', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        ],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);
      // $100,000 / 26.5 = $3,773.58 → 377358 cents, allowing ±$1 for engine rounding.
      const expectedFloorCents = Math.round((100_000 / 26.5) * 100);
      const overstatedFloorCents = Math.round((150_000 / 26.5) * 100);
      expect(years[0].rmdFloorCents).toBeGreaterThan(expectedFloorCents - 200);
      expect(years[0].rmdFloorCents).toBeLessThan(expectedFloorCents + 200);
      expect(Math.abs((years[0].rmdFloorCents ?? 0) - overstatedFloorCents)).toBeGreaterThan(100_000);
    });
  });

  describe('proportional strategy annotates same as taxEfficient (tax fields present)', () => {
    it('proportional strategy: tax fields annotated', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx({ withdrawalStrategy: { kind: 'proportional' } });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].federalTaxCents).toBeDefined();
    });

    it('rothFirst strategy: tax fields annotated', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx({ withdrawalStrategy: { kind: 'rothFirst' } });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].federalTaxCents).toBeDefined();
    });
  });
});

describe('brokerage-like yield drag + evolving cost basis', () => {
  function brokerageYears(
    rows: ReadonlyArray<{ year: number; endBalance: number; withdrawn: number; deposit?: number }>,
  ): DrawdownYear[] {
    return rows.map((r) => {
      const accountBalances = new Map<string, DrawdownAccountYear>([
        ['brk', { balance: r.endBalance, preEnd: 0, postEnd: r.endBalance, withdrawn: r.withdrawn, deposit: r.deposit ?? 0 }],
      ]);
      return makeDrawdownYear(r.year, r.withdrawn, accountBalances);
    });
  }

  function brokerageCtx() {
    return makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      costBasisFraction: 0.5,
      accountProjections: [{ id: 'brk', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }],
    });
  }

  function brokerageLedger(initialBalance: number): DrawdownAccountInput[] {
    return [makeLedgerAccount('brk', 0, initialBalance)];
  }

  it('m5_double_count_guard_reinvested_yield_is_added_to_basis', () => {
    // A $1M brokerage held two years at the 2% assumed yield, then fully withdrawn in year 2: the yield is taxed annually and
    // reinvested into basis, so the withdrawal-time gain is not taxed again on those dollars.
    const years = brokerageYears([
      { year: 2024, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2025, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2026, endBalance: 0, withdrawn: 1_000_000 },
    ]);
    applyTaxIntegrationToDrawdownYears(years, [], [], brokerageLedger(1_000_000), brokerageCtx(), REAL_BUNDLE);

    // Years 0 + 1: only the yield drag is taxed. $1M × 2% = $20k yield → MAGI $20k.
    expect(years[0].magiCents).toBe(20_000 * 100);
    expect(years[1].magiCents).toBe(20_000 * 100);

    // Year 2 withdrawal: basis seeded at 50% ($500k) plus $20k reinvested yield each year = $560k, so realized LTCG is $440k;
    // the year-2 yield adds $20k ($10k QDI + $10k interest) → MAGI $460k.
    expect(years[2].magiCents).toBe(460_000 * 100);
  });

  it('zero_taxable_accounts_control_no_drag', () => {
    // Pre-tax + Roth only → no brokerage-like balance → $0 yield drag.
    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['ira', makeAccountBalance(500_000, 0)],
      ['roth', makeAccountBalance(200_000, 0)],
    ]);
    const years: DrawdownYear[] = [makeDrawdownYear(2024, 0, accountBalances)];
    const ctx = makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      accountProjections: [
        { id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        { id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
      ],
    });
    applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('cash_like_only_savings_hsa_no_drag', () => {
    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['sav', makeAccountBalance(300_000, 0)],
      ['hsa', makeAccountBalance(100_000, 0)],
    ]);
    const years: DrawdownYear[] = [makeDrawdownYear(2024, 0, accountBalances)];
    const ctx = makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      accountProjections: [
        { id: 'sav', taxTreatment: 'POST_TAX', accountType: 'SAVINGS' },
        { id: 'hsa', taxTreatment: 'POST_TAX', accountType: 'HSA' },
      ],
    });
    applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('m6_pure_appreciation_basis_fraction_falls_gain_share_rises', () => {
    // An appreciating brokerage account with no contributions has a falling basis fraction, so the gain share of an identical
    // $100k withdrawal rises over time: compare an early year against a late one.
    const earlyYears = brokerageYears([
      { year: 2024, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2025, endBalance: 1_100_000, withdrawn: 100_000 },
    ]);
    applyTaxIntegrationToDrawdownYears(earlyYears, [], [], [], brokerageCtx(), REAL_BUNDLE);
    const earlyGainCents = earlyYears[1].magiCents ?? 0;

    const lateRows = [{ year: 2024, endBalance: 1_000_000, withdrawn: 0 }];
    let bal = 1_000_000;
    for (let y = 2025; y <= 2034; y += 1) {
      bal = Math.round(bal * 1.07); // 7% appreciation, no contributions
      lateRows.push({ year: y, endBalance: bal, withdrawn: 0 });
    }
    const finalYear = 2035;
    bal = Math.round(bal * 1.07);
    lateRows.push({ year: finalYear, endBalance: bal - 100_000, withdrawn: 100_000 });
    const lateYears = brokerageYears(lateRows);
    applyTaxIntegrationToDrawdownYears(lateYears, [], [], [], brokerageCtx(), REAL_BUNDLE);
    const lateGainCents = lateYears[lateYears.length - 1].magiCents ?? 0;

    expect(lateGainCents).toBeGreaterThan(earlyGainCents);
  });

  it('m6_cost_basis_fraction_stays_in_0_1_every_year_no_guard_throw', () => {
    // A long pure-appreciation projection with periodic withdrawals must never throw the [0,1] guard; completing and annotating
    // every year proves it did not fire.
    const rows = [{ year: 2024, endBalance: 1_000_000, withdrawn: 0 }];
    let bal = 1_000_000;
    for (let y = 2025; y <= 2050; y += 1) {
      bal = Math.round(bal * 1.06);
      const withdrawn = y % 3 === 0 ? 50_000 : 0;
      rows.push({ year: y, endBalance: bal - withdrawn, withdrawn });
    }
    const years = brokerageYears(rows);
    expect(() =>
      applyTaxIntegrationToDrawdownYears(years, [], [], [], brokerageCtx(), REAL_BUNDLE),
    ).not.toThrow();
    for (const y of years) expect(y.magiCents).toBeDefined();
  });

  // The rollover-year RMD carved out of a linked-CBP lump sum is taxable ordinary income injected via rolledRmdIncomeByYear;
  // the income must move every dependent surface and be taxed exactly once.
  describe('rollover-year RMD ordinary income (linked-CBP split)', () => {
    it('raises the event year federal tax + MAGI when the rolled RMD is injected', () => {
      const baseYears: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx({ primaryBirthdate: '1950-01-01', primaryRetirementYear: 2024 });
      applyTaxIntegrationToDrawdownYears(baseYears, [], [], [], ctx, REAL_BUNDLE);

      const splitYears: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      applyTaxIntegrationToDrawdownYears(
        splitYears,
        [],
        [],
        [],
        ctx,
        REAL_BUNDLE,
        new Map([[2024, 40_000]]),
      );

      expect(splitYears[0].federalTaxCents ?? 0).toBeGreaterThan(
        baseYears[0].federalTaxCents ?? 0,
      );
      expect(splitYears[0].magiCents ?? 0).toBeGreaterThan(baseYears[0].magiCents ?? 0);
      // MAGI rises by about the injected $40k (within tax-engine rounding).
      const magiDeltaDollars =
        ((splitYears[0].magiCents ?? 0) - (baseYears[0].magiCents ?? 0)) / 100;
      expect(magiDeltaDollars).toBeGreaterThan(39_000);
      expect(magiDeltaDollars).toBeLessThan(41_000);
    });

    it('moves taxable Social Security (§86) and IRMAA for a Medicare household', () => {
      // Born 1950 is on Medicare; gross SS exercises IRMAA and §86. Years 0-1 use the stored lookback and year 2 the rolling
      // MAGI ring, so a rolled RMD in year 0 funds the year-2 IRMAA. Modest SS keeps §86 below the 85% cap in the base run.
      const ssRow = (year: number) => ({ year, month0: 0, total: 240_000, primary: 240_000 });
      const ssRows = [ssRow(2024), ssRow(2025), ssRow(2026)];
      const makeYears = (): DrawdownYear[] => [
        makeDrawdownYear(2024, 5_000),
        makeDrawdownYear(2025, 5_000),
        makeDrawdownYear(2026, 5_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1950-01-01',
        primaryRetirementYear: 2024,
      });

      const base = makeYears();
      applyTaxIntegrationToDrawdownYears(base, ssRows, [], [], ctx, REAL_BUNDLE);
      const split = makeYears();
      applyTaxIntegrationToDrawdownYears(
        split,
        ssRows,
        [],
        [],
        ctx,
        REAL_BUNDLE,
        new Map([[2024, 200_000]]),
      );

      expect(split[0].taxableSsCents ?? 0).toBeGreaterThan(base[0].taxableSsCents ?? 0);
      expect(split[0].magiCents ?? 0).toBeGreaterThan(base[0].magiCents ?? 0);
      // IRMAA 2-year look-back: year 2 (2026) surcharges off year 0 (2024) MAGI, which the rolled RMD raised.
      expect(split[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(
        base[2].irmaaSurchargeCents ?? 0,
      );
    });

    it('moves the ACA-PTC MAGI surface for a pre-Medicare household', () => {
      // Born 1970 is 54 in 2024, not on Medicare → ACA-PTC applies: the rolled RMD raises MAGI and moves the FPL%.
      const makeYears = (): DrawdownYear[] => [makeDrawdownYear(2024, 30_000)];
      const ctx = makeCtx({
        primaryBirthdate: '1970-01-01',
        primaryRetirementYear: 2024,
      });
      const base = makeYears();
      applyTaxIntegrationToDrawdownYears(base, [], [], [], ctx, REAL_BUNDLE);
      const split = makeYears();
      applyTaxIntegrationToDrawdownYears(
        split,
        [],
        [],
        [],
        ctx,
        REAL_BUNDLE,
        new Map([[2024, 20_000]]),
      );
      expect(split[0].fplPercentage ?? 0).toBeGreaterThan(base[0].fplPercentage ?? 0);
      expect(split[0].magiCents ?? 0).toBeGreaterThan(base[0].magiCents ?? 0);
    });

    it('taxes the rolled RMD exactly once — no double-tax with the forced-RMD floor', () => {
      // The rolled-CBP source is not a ledger account, so injecting the rolled RMD via rolledRmdIncomeByYear must not also be
      // counted by the RMD floor: rmdFloorCents is unchanged between the two runs.
      const ledger = [makeLedgerAccount('ira-1', 1_000_000)];
      const accBal = new Map([['ira-1', makeAccountBalance(1_000_000, 50_000)]]);
      const ctx = makeCtx({ primaryBirthdate: '1950-01-01', primaryRetirementYear: 2024 });

      const base: DrawdownYear[] = [makeDrawdownYear(2024, 50_000, accBal)];
      applyTaxIntegrationToDrawdownYears(base, [], [], ledger, ctx, REAL_BUNDLE);
      const split: DrawdownYear[] = [makeDrawdownYear(2024, 50_000, accBal)];
      applyTaxIntegrationToDrawdownYears(
        split,
        [],
        [],
        ledger,
        ctx,
        REAL_BUNDLE,
        new Map([[2024, 40_000]]),
      );

      expect(split[0].rmdFloorCents).toBe(base[0].rmdFloorCents);
      // The rolled RMD is taxed once: federal tax rose by the injection's tax, not twice it.
      expect(split[0].federalTaxCents ?? 0).toBeGreaterThan(base[0].federalTaxCents ?? 0);
    });

    it('an empty rolled-RMD map leaves every tax field byte-identical (no-op)', () => {
      const withMap: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      const ctx = makeCtx({ primaryBirthdate: '1950-01-01', primaryRetirementYear: 2024 });
      applyTaxIntegrationToDrawdownYears(
        withMap,
        [],
        [],
        [],
        ctx,
        REAL_BUNDLE,
        new Map(),
      );
      const without: DrawdownYear[] = [makeDrawdownYear(2024, 50_000)];
      applyTaxIntegrationToDrawdownYears(without, [], [], [], ctx, REAL_BUNDLE);
      expect(withMap[0].federalTaxCents).toBe(without[0].federalTaxCents);
      expect(withMap[0].magiCents).toBe(without[0].magiCents);
    });
  });
});

describe('cash-like interest annotation', () => {
  function savingsCtx(accountType: 'SAVINGS' | 'MONEY_MARKET' | 'CD' | 'HSA') {
    return makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      accountProjections: [{ id: 'cash1', taxTreatment: 'POST_TAX', accountType }],
    });
  }
  function cashYears(
    rows: ReadonlyArray<{ year: number; endBalance: number; withdrawn: number; deposit?: number }>,
  ): DrawdownYear[] {
    return rows.map((r) => {
      const accountBalances = new Map<string, DrawdownAccountYear>([
        ['cash1', { balance: r.endBalance, preEnd: 0, postEnd: r.endBalance, withdrawn: r.withdrawn, deposit: r.deposit ?? 0 }],
      ]);
      return makeDrawdownYear(r.year, r.withdrawn, accountBalances);
    });
  }

  it('savings_growth_is_annual_ordinary_interest_income', () => {
    // $300k savings earning 4%: year-0 interest = 312k − 300k = $12k; year 1 grows 312k × 1.04 = 324,480 before the $5k
    // withdrawal, ending 319,480, so interest = 319,480 + 5,000 − 312,000 = $12,480. MAGI equals the interest each year.
    const years = cashYears([
      { year: 2024, endBalance: 312_000, withdrawn: 0 },
      { year: 2025, endBalance: 319_480, withdrawn: 5_000 },
    ]);
    const ledger = [makeLedgerAccount('cash1', 0, 300_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' })];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, savingsCtx('SAVINGS'), REAL_BUNDLE);
    expect(years[0].magiCents).toBe(12_000 * 100);
    expect(years[1].magiCents).toBe(12_480 * 100);
  });

  it('cd_deposits_are_not_interest', () => {
    // A $50k deposit is new principal, not growth: interest = end + withdrawn − deposit − start = 156k − 50k − 100k = $6k.
    const years = cashYears([{ year: 2024, endBalance: 156_000, withdrawn: 0, deposit: 50_000 }]);
    const ledger = [makeLedgerAccount('cash1', 0, 100_000, { accountType: 'CD', taxTreatment: 'POST_TAX' })];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, savingsCtx('CD'), REAL_BUNDLE);
    expect(years[0].magiCents).toBe(6_000 * 100);
  });

  it('negative_cash_growth_produces_no_negative_income', () => {
    const years = cashYears([{ year: 2024, endBalance: 295_000, withdrawn: 0 }]);
    const ledger = [makeLedgerAccount('cash1', 0, 300_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' })];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, savingsCtx('SAVINGS'), REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('unknown_start_synthesizes_zero_growth_start_and_zero_interest', () => {
    // With no prior-year row and no ledger entry the start balance is unknown; unknownStartIsZeroGrowth synthesizes a zero-growth
    // start (end + withdrawn − deposit) so the opening balance never fabricates income.
    const ctx = savingsCtx('SAVINGS');
    const row = { year: 2024, endBalance: 312_000, withdrawn: 5_000, deposit: 2_000 };
    const built = buildCashLikeYearAccounts(ctx, cashYears([row])[0], undefined, []);
    expect(built).toHaveLength(1);
    // Zero-growth start = end + withdrawn − deposit = 312k + 5k − 2k = 315k.
    expect(built[0].startBalanceDollars).toBe(315_000);
    expect(computeCashLikeInterestDollars(built)).toBe(0);
    const years = cashYears([row]);
    applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('hsa_growth_stays_tax_free', () => {
    // The same growth on an HSA-typed account produces no interest income (§223 growth is tax-free).
    const years = cashYears([{ year: 2024, endBalance: 312_000, withdrawn: 0 }]);
    const ledger = [makeLedgerAccount('cash1', 0, 300_000, { accountType: 'HSA', taxTreatment: 'POST_TAX' })];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, savingsCtx('HSA'), REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('interest_and_yield_drag_coexist_and_sum_into_magi', () => {
    // A brokerage ($1M at the 2% assumed yield → $20k) plus a savings account earning $12k: MAGI carries both ($32k).
    const accountBalances = new Map<string, DrawdownAccountYear>([
      ['brk', { balance: 1_000_000, preEnd: 0, postEnd: 1_000_000, withdrawn: 0, deposit: 0 }],
      ['cash1', { balance: 312_000, preEnd: 0, postEnd: 312_000, withdrawn: 0, deposit: 0 }],
    ]);
    const years: DrawdownYear[] = [makeDrawdownYear(2024, 0, accountBalances)];
    const ctx = makeCtx({
      withdrawalStrategy: { kind: 'taxEfficient' },
      costBasisFraction: 0.5,
      accountProjections: [
        { id: 'brk', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' },
        { id: 'cash1', taxTreatment: 'POST_TAX', accountType: 'SAVINGS' },
      ],
    });
    const ledger = [
      makeLedgerAccount('brk', 0, 1_000_000, { accountType: 'BROKERAGE', taxTreatment: 'POST_TAX' }),
      makeLedgerAccount('cash1', 0, 300_000, { accountType: 'SAVINGS', taxTreatment: 'POST_TAX' }),
    ];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, ctx, REAL_BUNDLE);
    expect(years[0].magiCents).toBe(32_000 * 100);
  });
});

describe('applyTaxIntegrationToDrawdownYears — filing plan', () => {
  const coupleCtx = (
    resolvedOverrides: Partial<PipelineContext['resolvedScenario']>,
  ): PipelineContext => {
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1955-01-01',
      primaryRetirementYear: 2024,
      accountProjections: [
        { id: 'ira-p', accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'member-primary' },
        { id: 'ira-s', accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX', ownerId: 'member-secondary' },
      ],
    });
    return {
      ...ctx,
      resolvedScenario: { ...ctx.resolvedScenario, ...resolvedOverrides },
    } as PipelineContext;
  };
  const lopsidedYears = (): DrawdownYear[] =>
    [2024, 2025].map((year) => {
      const y = makeDrawdownYear(year, 150_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 150_000)],
        ['ira-s', makeAccountBalance(800_000, 0)],
      ]);
      return y;
    });
  const ledger: DrawdownAccountInput[] = [
    makeLedgerAccount('ira-p', 950_000),
    makeLedgerAccount('ira-s', 950_000),
  ];
  const totalTax = (years: readonly DrawdownYear[]): number =>
    years.reduce((sum, y) => sum + (y.federalTaxCents ?? 0), 0);

  it('should_file_two_separate_returns_when_the_plan_says_separate', () => {
    const joint = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      joint, [], [], ledger, coupleCtx({ taxFilingPlan: { kind: 'joint' } }), REAL_BUNDLE,
    );
    const separate = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      separate, [], [], ledger,
      coupleCtx({
        taxFilingPlan: {
          kind: 'separate',
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
          ],
        },
      }),
      REAL_BUNDLE,
    );
    // The whole draw is the primary's, so filing apart pushes it through one narrower MFS schedule: strictly more tax.
    expect(totalTax(separate)).toBeGreaterThan(totalTax(joint));
  });

  it('should_report_each_owners_withdrawals_on_their_own_separate_return', () => {
    // Same household total, different ownership → different tax: the owner-attribution contract.
    const plan: TaxFilingPlan = {
      kind: 'separate',
      units: [
        { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
        { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
      ],
    };
    const lopsided = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      lopsided, [], [], ledger, coupleCtx({ taxFilingPlan: plan }), REAL_BUNDLE,
    );
    const even = [2024, 2025].map((year) => {
      const y = makeDrawdownYear(year, 150_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 75_000)],
        ['ira-s', makeAccountBalance(800_000, 75_000)],
      ]);
      return y;
    });
    applyTaxIntegrationToDrawdownYears(
      even, [], [], ledger, coupleCtx({ taxFilingPlan: plan }), REAL_BUNDLE,
    );
    expect(totalTax(lopsided)).toBeGreaterThan(totalTax(even));
  });

  it('should_keep_the_legacy_scalar_path_for_an_unresolvable_conversion', () => {
    // A two-member `Single` scalar cannot be converted: the projection must match the no-plan behaviour.
    const withScalar = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      withScalar, [], [], ledger, coupleCtx({ filingStatus: 'Single' }), REAL_BUNDLE,
    );
    expect(withScalar[0].federalTaxCents).toBeGreaterThan(0);
    const asJointPlan = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      asJointPlan, [], [], ledger, coupleCtx({ taxFilingPlan: { kind: 'joint' } }), REAL_BUNDLE,
    );
    // It filed Single (the status derived without a plan), not the joint plan default.
    expect(withScalar[0].federalTaxCents).not.toBe(asJointPlan[0].federalTaxCents);
  });

  it('should_stop_filing_jointly_after_a_projected_death', () => {
    // A joint plan files MFJ through the death year, then Single. Life expectancy 70 → death in 2025.
    const years = [2024, 2025, 2026, 2027].map((year) => {
      const y = makeDrawdownYear(year, 150_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 150_000)],
      ]);
      return y;
    });
    applyTaxIntegrationToDrawdownYears(
      years, [], [], ledger,
      coupleCtx({
        taxFilingPlan: { kind: 'joint' },
        lifeExpectancy: { primary: 95, secondary: 70 },
      }),
      REAL_BUNDLE,
    );
    // 2025 is the death year → still joint; 2026 is the first survivor year.
    expect(years[2].federalTaxCents!).toBeGreaterThan(years[1].federalTaxCents!);
  });

  it('should_tier_a_bootstrap_year_on_the_look_back_return_status_like_MC_does', () => {
    // Projection years 0-1 tier IRMAA on returns filed before the projection starts, so the look-back status must resolve to
    // taxYear - 2's own plan (as MC does), not the current year's: a spouse dying in year 0 would otherwise tier year 1 on the
    // survivor's Single ladder here and the couple's MFJ ladder in MC. Here 2024 is the death year; 2025's look-back is the
    // jointly filed 2023 return, and $150k sits above Single tier 1 ($106k) and below MFJ tier 1 ($212k).
    const years = [2024, 2025].map((year) => {
      const y = makeDrawdownYear(year, 20_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 20_000)],
      ]);
      return y;
    });
    const detCtx = coupleCtx({
      taxFilingPlan: { kind: 'joint' },
      // Secondary dies in 2024 (born 1955 → age 69), the first projection year.
      lifeExpectancy: { primary: 95, secondary: 69 },
      magiBootstrapLookbackMinus2: 150_000,
      magiBootstrapLookbackMinus1: 150_000,
    });
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, detCtx, REAL_BUNDLE);
    // Both bootstrap years tier on a joint look-back return → below MFJ tier 1.
    expect(years[0].irmaaSurchargeCents).toBe(0);
    expect(years[1].irmaaSurchargeCents).toBe(0);

    // The MC engine resolves the same look-back year off the same plan.
    const mcTaxCtx: McTaxContext = {
      taxBundle: REAL_BUNDLE,
      filingStatus: 'MFJ',
      members: [
        { memberId: 'member-primary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
        { memberId: 'member-secondary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
      ],
      householdSize: 2,
      secondaryDeathYear: 2024,
      taxFilingPlan: { kind: 'joint' },
    };
    const mcYear1 = deriveMcSurvivors(mcTaxCtx, 2025, 2024);
    expect(mcYear1?.filingStatus).toBe('Single');
    expect(mcYear1?.irmaaLookbackFilingStatus).toBe('MFJ');

    // Control: the same year surcharges once the look-back MAGI clears the MFJ threshold, so $0 above is the tier decision.
    const aboveMfjTier1 = [2024, 2025].map((year) => {
      const y = makeDrawdownYear(year, 20_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 20_000)],
      ]);
      return y;
    });
    applyTaxIntegrationToDrawdownYears(
      aboveMfjTier1, [], [], ledger,
      coupleCtx({
        taxFilingPlan: { kind: 'joint' },
        lifeExpectancy: { primary: 95, secondary: 69 },
        magiBootstrapLookbackMinus2: 300_000,
        magiBootstrapLookbackMinus1: 300_000,
      }),
      REAL_BUNDLE,
    );
    expect(aboveMfjTier1[1].irmaaSurchargeCents!).toBeGreaterThan(0);
  });

  it('should_tier_each_bootstrap_year_return_on_its_OWN_schedule', () => {
    // A two-return bootstrap look-back must not collapse onto units[0]'s status: in years 0-1 each spouse tiers on their own
    // schedule. MFS (steeper) beside HoH (single-filer ladder) is the smallest household whose returns tier on different
    // ladders; the $300k look-back splits to $150k per return, above tier 1 on both but at very different surcharges.
    const runWith = (secondStatus: 'MFS' | 'HoH'): DrawdownYear[] => {
      const years = [2024, 2025].map((year) => {
        const y = makeDrawdownYear(year, 20_000);
        y.accountBalances = new Map<string, DrawdownAccountYear>([
          ['ira-p', makeAccountBalance(800_000, 10_000)],
          ['ira-s', makeAccountBalance(800_000, 10_000)],
        ]);
        return y;
      });
      applyTaxIntegrationToDrawdownYears(
        years, [], [], ledger,
        coupleCtx({
          taxFilingPlan: {
            kind: 'separate',
            livedTogether: true,
            units: [
              { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
              { memberId: 'secondary', filingStatus: secondStatus, householdSize: 1 },
            ],
          },
          magiBootstrapLookbackMinus2: 300_000,
          magiBootstrapLookbackMinus1: 300_000,
        }),
        REAL_BUNDLE,
      );
      return years;
    };
    const bothMfs = runWith('MFS');
    const mixed = runWith('HoH');
    // Both bootstrap years surcharge, and the head-of-household spouse's own lower schedule shows in both, not just from year 2.
    for (const i of [0, 1]) {
      expect(bothMfs[i].irmaaSurchargeCents!).toBeGreaterThan(0);
      expect(mixed[i].irmaaSurchargeCents!).toBeGreaterThan(0);
      expect(mixed[i].irmaaSurchargeCents!).toBeLessThan(bothMfs[i].irmaaSurchargeCents!);
    }
    // Cross-engine: MC resolves the same look-back returns off the same plan.
    const mcState = deriveMcSurvivors(
      {
        taxBundle: REAL_BUNDLE,
        filingStatus: 'MFJ',
        members: [
          { memberId: 'member-primary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
          { memberId: 'member-secondary', isoBirthdate: '1955-01-01', onMedicare: true, hasAcaCoverage: false },
        ],
        householdSize: 2,
        taxFilingPlan: {
          kind: 'separate',
          livedTogether: true,
          units: [
            { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
            { memberId: 'secondary', filingStatus: 'HoH', householdSize: 1 },
          ],
        },
      },
      2024,
      2024,
    );
    expect(mcState?.bootstrapLookbackUnits).toEqual([
      { memberIds: ['member-primary'], filingStatus: 'MFS', mfsLivedWithSpouse: true },
      { memberIds: ['member-secondary'], filingStatus: 'HoH', mfsLivedWithSpouse: false },
    ]);
  });

  it('should_apply_a_QSS_window_over_the_post_death_Single_default', () => {
    const years = [2024, 2025, 2026, 2027].map((year) => {
      const y = makeDrawdownYear(year, 150_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 150_000)],
      ]);
      return y;
    });
    const base = coupleCtx({
      taxFilingPlan: { kind: 'joint' },
      lifeExpectancy: { primary: 95, secondary: 70 },
    });
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, base, REAL_BUNDLE);
    const withQss = [2024, 2025, 2026, 2027].map((year) => {
      const y = makeDrawdownYear(year, 150_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 150_000)],
      ]);
      return y;
    });
    applyTaxIntegrationToDrawdownYears(
      withQss, [], [], ledger,
      coupleCtx({
        taxFilingPlan: {
          kind: 'joint',
          statusWindows: [
            { status: 'QSS', start: { kind: 'year', year: 2026 }, end: { kind: 'year', year: 2028 } },
          ],
        },
        lifeExpectancy: { primary: 95, secondary: 70 },
      }),
      REAL_BUNDLE,
    );
    // QSS is taxed on the MFJ schedule, so the survivor years cost less.
    expect(withQss[2].federalTaxCents!).toBeLessThan(years[2].federalTaxCents!);
    expect(withQss[3].federalTaxCents!).toBeLessThan(years[3].federalTaxCents!);
  });
});

describe('medicareBasePremiumMissing readiness flag', () => {
  const irmaaHousehold = (): PipelineContext =>
    makeCtx({
      primaryBirthdate: '1950-03-15',
      primaryRetirementYear: 2024,
      magiBootstrapLookbackMinus2: 400_000,
      magiBootstrapLookbackMinus1: 400_000,
    });

  it('raises the flag when a surcharge is charged and NO medical spending is modeled', () => {
    const years: DrawdownYear[] = [makeDrawdownYear(2026, 60_000)];
    applyTaxIntegrationToDrawdownYears(
      years,
      [],
      [],
      [],
      irmaaHousehold(),
      REAL_BUNDLE,
      new Map(),
      /* anyMedicalSpendingModeled */ false,
    );
    expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
    expect(years[0].medicareBasePremiumMissing).toBe(true);
  });

  it('leaves the flag unset when the plan DOES model medical spending', () => {
    // The fact is the full isMedical inventory, not the HSA-qualified subset: Medicare, Medigap and drug-plan premiums are never
    // HSA-qualified, so a household recording only those must not be told it has no medical spending.
    const years: DrawdownYear[] = [makeDrawdownYear(2026, 60_000)];
    applyTaxIntegrationToDrawdownYears(
      years,
      [],
      [],
      [],
      irmaaHousehold(),
      REAL_BUNDLE,
      new Map(),
      /* anyMedicalSpendingModeled */ true,
    );
    expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
    expect(years[0].medicareBasePremiumMissing).toBeUndefined();
  });

  it('leaves the flag unset when NO surcharge is charged, even with no medical spending', () => {
    // A pre-65 household is never charged IRMAA, so the warning (naming a Medicare premium not yet owed) must not fire.
    const years: DrawdownYear[] = [makeDrawdownYear(2026, 60_000)];
    const ctx = makeCtx({ primaryBirthdate: '1975-03-15', primaryRetirementYear: 2024 });
    applyTaxIntegrationToDrawdownYears(
      years,
      [],
      [],
      [],
      ctx,
      REAL_BUNDLE,
      new Map(),
      /* anyMedicalSpendingModeled */ false,
    );
    expect(years[0].irmaaSurchargeCents).toBe(0);
    expect(years[0].medicareBasePremiumMissing).toBeUndefined();
  });

  it('omitting the argument never raises the flag (the default suppresses)', () => {
    const years: DrawdownYear[] = [makeDrawdownYear(2026, 60_000)];
    applyTaxIntegrationToDrawdownYears(years, [], [], [], irmaaHousehold(), REAL_BUNDLE);
    expect(years[0].medicareBasePremiumMissing).toBeUndefined();
  });
});
