/**
 * Integration tests for `applyTaxIntegrationToDrawdownYears`.
 *
 * These tests exercise the post-pass annotation layer in isolation:
 * - Tax fields appear on each DrawdownYear for every named strategy
 * - MAGI look-back: bootstrap for years 0–1, buffer for years 2+
 * - Year-0 RMD sourced from ledger balances; year 1+ from prior DrawdownYear
 * - Roth withdrawals excluded from MAGI + federal tax
 * - `taxYearExtrapolated` set when year exceeds snapshot tables
 */
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
// The MC side of the bootstrap-year IRMAA look-back parity assertion.
import { deriveMcSurvivors, type McTaxContext } from './monte-carlo-tax';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
      // Compute expected netAfterTax
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
      // 2050: beyond snapshot range (2024-2026 in current calibrations)
      // AND primary (born 1960) still alive at age 90 (under default LE 95).
      const years: DrawdownYear[] = [makeDrawdownYear(2050, 50_000)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].taxYearExtrapolated).toBe(true);
    });

    it('skips tax math when both members are past life expectancy', () => {
      // 2070: both members dead under default LE 95 (primary born 1960 → dies 2055).
      // Tax fields stay undefined; no throw.
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
      // Born 1955 → age 69 in 2024 → on Medicare
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

      // IRMAA should fire for both years 0 and 1 (stored lookback MAGI is high).
      expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[1].irmaaSurchargeCents).toBeGreaterThan(0);
      // Stored bootstrap → NOT an estimate.
      expect(years[0].magiEstimatedFromProjection).toBeUndefined();
      expect(years[1].magiEstimatedFromProjection).toBeUndefined();
    });

    it('years 0–1 with no bootstrap ESTIMATE the lookback from projected MAGI + flag', () => {
      // Born 1955 → on Medicare in 2024. Low income ($50k) → estimated MAGI is
      // below Single tier1, so the surcharge stays $0, but the disclosure flag
      // fires because the lookback was estimated (not stored).
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000),
        makeDrawdownYear(2025, 50_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
        // no stored bootstrap
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      // Below tier1 → $0 surcharge, but the estimate-from-projection flag fires.
      expect(years[0].irmaaSurchargeCents).toBe(0);
      expect(years[1].irmaaSurchargeCents).toBe(0);
      expect(years[0].magiEstimatedFromProjection).toBe(true);
      expect(years[1].magiEstimatedFromProjection).toBe(true);
    });

    it('year 2+ uses MAGI computed in year i-2 (look-back buffer)', () => {
      // Born 1955 → Medicare-eligible; run 3 years
      // Year 0 and 1 have no bootstrap → IRMAA = 0 at those years
      // Year 2 uses MAGI from year 0 → if year-0 MAGI was low, IRMAA stays 0
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 5_000),  // low income → low MAGI
        makeDrawdownYear(2025, 5_000),
        makeDrawdownYear(2026, 5_000),  // IRMAA for year 2 uses year 0's MAGI
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      // Year 0 and 1 skip IRMAA (no bootstrap)
      expect(years[0].irmaaSurchargeCents).toBe(0);
      expect(years[1].irmaaSurchargeCents).toBe(0);
      // Year 2 uses year 0's MAGI ($5k → below tier1 threshold) → IRMAA = 0
      expect(years[2].irmaaSurchargeCents).toBe(0);
    });
  });

  describe('estimate-with-disclosure for years 0–1 (no bootstrap)', () => {
    it('$300k MFJ on Medicare year 0, no bootstrap → NON-zero years 0–1 IRMAA + flag', () => {
      // Both members born 1955 → on Medicare; high all-pre-tax draw → year-0
      // projected MAGI well above the MFJ tier1 threshold, so the estimated
      // lookback fires a non-zero surcharge in BOTH first years.
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 300_000),
        makeDrawdownYear(2025, 300_000),
      ];
      const ctx = makeCtx({
        primaryBirthdate: '1955-01-01',
        secondaryBirthdate: '1955-01-01',
        // no stored bootstrap → projected-MAGI estimate path
      });
      // Rows with no accountBalances map classify the whole draw as pre-tax.
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[1].irmaaSurchargeCents).toBeGreaterThan(0);
      expect(years[0].magiEstimatedFromProjection).toBe(true);
      expect(years[1].magiEstimatedFromProjection).toBe(true);
    });

    it('below-calibration-floor year → $0 IRMAA but the disclosure flag still fires', () => {
      // A pre-snapshot tax year (below the calibration floor) throws
      // UnsupportedTaxYear inside applyTaxYear; the engine degrades to $0 tax,
      // but a Medicare member with no bootstrap still gets the disclosure flag.
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
      // accountBalances map where all withdrawn is from a ROTH account; the
      // owner's derived basis ($60k) covers the $50k draw → contribution
      // tranche, tax/penalty-free.
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
      // MAGI is zero: the whole $80k draw is recovered §408A contribution basis
      // (no SS, no pre-tax, no post-tax-non-roth, no Roth earnings excess).
      expect(years[0].magiCents).toBe(0);
    });
  });

  describe('POST_TAX classification by account type', () => {
    // Helper: run a single-account POST_TAX withdrawal and read back MAGI.
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

    it('BROKERAGE withdrawal produces LTCG proxy income (MAGI > 0)', () => {
      // $40k post-tax × (1 − 0.5 cost basis) = $20k LTCG → MAGI = $20k
      expect(magiForPostTaxAccount('BROKERAGE')).toBe(20_000 * 100);
    });

    it('OTHER withdrawal produces LTCG proxy income (MAGI > 0)', () => {
      expect(magiForPostTaxAccount('OTHER')).toBe(20_000 * 100);
    });

    it('SAVINGS withdrawal produces $0 LTCG and $0 MAGI', () => {
      expect(magiForPostTaxAccount('SAVINGS')).toBe(0);
    });

    it('MONEY_MARKET withdrawal produces $0 LTCG and $0 MAGI', () => {
      expect(magiForPostTaxAccount('MONEY_MARKET')).toBe(0);
    });

    it('CD withdrawal produces $0 LTCG and $0 MAGI', () => {
      expect(magiForPostTaxAccount('CD')).toBe(0);
    });

    it('HSA withdrawal produces $0 LTCG and $0 MAGI', () => {
      expect(magiForPostTaxAccount('HSA')).toBe(0);
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

    it('MIXED post-tax sub-bucket follows the same rule by account type — BROKERAGE is LTCG', () => {
      // MIXED account with preWithdrawnCents=0, postWithdrawnCents=$40k; type
      // BROKERAGE → post sub-bucket is LTCG proxy → MAGI > 0.
      const row: DrawdownAccountYear = {
        balance: 400_000, preEnd: 0, postEnd: 400_000, withdrawn: 40_000, deposit: 0,
        preWithdrawnCents: 0, postWithdrawnCents: 40_000 * 100,
      };
      const accountBalances = new Map([['mix1', row]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({
        costBasisFraction: 0.5,
        accountProjections: [{ id: 'mix1', taxTreatment: 'MIXED', accountType: 'BROKERAGE' }],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents).toBe(20_000 * 100);
    });

    it('MIXED post-tax sub-bucket follows the same rule by account type — SAVINGS is $0', () => {
      const row: DrawdownAccountYear = {
        balance: 400_000, preEnd: 0, postEnd: 400_000, withdrawn: 40_000, deposit: 0,
        preWithdrawnCents: 0, postWithdrawnCents: 40_000 * 100,
      };
      const accountBalances = new Map([['mix1', row]]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      const ctx = makeCtx({
        costBasisFraction: 0.5,
        accountProjections: [{ id: 'mix1', taxTreatment: 'MIXED', accountType: 'SAVINGS' }],
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents).toBe(0);
    });

    it('spending the synthetic RMD-overflow cash carrier adds $0 MAGI / $0 federal tax (return-of-principal)', () => {
      // The carrier is NOT in accountProjections (synthetic), but its withdrawal
      // must classify cash-like ($0-MAGI / tax-free) — the surplus dollars were
      // already taxed when the RMD was forced, so spending the held cash in a
      // later year does NOT raise that year's MAGI or federal tax.
      const accountBalances = new Map([
        [RMD_OVERFLOW_CASH_ACCOUNT_ID, makeAccountBalance(80_000, 40_000)],
      ]);
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000, accountBalances)];
      // No real account projection for the carrier — it is materialized by the
      // engine, not a user account.
      const ctx = makeCtx({ costBasisFraction: 0.5, accountProjections: [] });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      expect(years[0].magiCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
      // Still spendable (tax-free): the $40k counts toward net-after-tax.
      expect(years[0].netAfterTaxCents).toBe(40_000 * 100);
    });
  });

  describe('rmdShortfallCents', () => {
    it('rmdShortfallCents is max(0, rmdFloor - withdrawn)', () => {
      // For shortfall to be non-zero: we need an RMD-eligible account + member
      // at trigger age where rmdFloor > withdrawn
      // rmdFloor for $500k at age 73 ≈ $18,868; use withdrawn = $10k to force shortfall
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
      // Oracle: $500k / 26.5 divisor (age 73) = 1,886,792 cents floor;
      // withdrawn = $10k = 1,000,000 cents; shortfall = 886,792 cents.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(886_792);
    });

    it('(per-IRS-pool): one IRA covering the whole IRA-pool minimum → no shortfall', () => {
      // Two equal $500k traditional IRAs of ONE owner at age 73. The IRS pools
      // all of an owner's traditional IRAs: the owner may satisfy the WHOLE IRA
      // minimum from any one IRA. Account A draws $30k (past the combined pool
      // floor of $37,736? no — but past A's own $18,868 share); account B draws
      // $0. Under the OLD strict per-account rule B looked short its full RMD;
      // under IRS aggregation A's overshoot covers B's under-draw WITHIN the
      // pool, so the only thing that matters is poolWithdrawn vs poolRequired.
      // Here pool required ≈ $37,736 and pool withdrawn = $30k, so a GENUINE
      // pool deficit of ($37,736 − $30k) would remain — to make this the clean
      // "no shortfall" case we draw the full pool minimum from A.
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
      // The IRA pool's whole minimum was satisfied from A → NO shortfall (it would
      // be 1_886_792 under a strict per-account rule; the floor is per-pool).
      expect(y.rmdShortfallCents).toBe(0);
      // Floor unchanged (no money moved): sum of both accounts' RMDs ($37,736;
      // 1-cent rounding residue) — the no-regression anchor.
      expect(y.rmdFloorCents).toBe(3_773_585);
    });

    it('genuine IRA-pool deficit still surfaces (pool withdrawn < pool required)', () => {
      // Same two same-owner IRAs; pool minimum ≈ $37,736. Owner draws only $30k
      // total across the pool → a real pool deficit remains.
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
      // A pure pre-tax 403(b) + a MIXED 403(b), same owner, pool together (403(b)
      // qualifies MIXED — IRAs do not). The MIXED account's pre-tax tranche
      // (preWithdrawnCents) is what counts. NOTE: the RMD engine subtracts the
      // MIXED account's post-tax bucket from its RMD base (§325), so with the
      // MIXED account fully post-tax ($500k post) only the pre-tax 403(b)
      // ($500k) drives the floor. The pre-tax 403(b) draws the whole pool
      // minimum → no shortfall, even though MIXED contributes $0 pre-tax.
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('tsaPre', 500_000),
        makeLedgerAccount('tsaMix', 0, 500_000, { taxTreatment: 'MIXED' }),
      ];
      const accountBalances = new Map<string, DrawdownAccountYear>([
        // Pre-tax 403(b) draws the whole owner 403(b)-pool minimum ($18,867.92).
        ['tsaPre', makeAccountBalance(500_000, 18_867.92)],
        // MIXED account drew $20k but ALL post-tax (preWithdrawnCents = 0).
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
      // Pre-tax 403(b) satisfied the pool minimum; MIXED post dollars don't count.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(0);
    });

    it('MIXED (b): undefined preWithdrawnCents contributes 0 → a genuine pre-tax deficit surfaces', () => {
      // Single MIXED 401(k) (qualifies MIXED), pre-tax $500k + post $0 so the
      // whole balance is RMD-eligible. The kernel did NOT surface the pre/post
      // split (preWithdrawnCents undefined) → conservative 0 pre-tax withdrawn →
      // the whole RMD shows as a shortfall (Roth/post dollars cannot mask it).
      const ledger: DrawdownAccountInput[] = [
        makeLedgerAccount('kMix', 500_000, 0, { taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }),
      ];
      const accountBalances = new Map<string, DrawdownAccountYear>([
        // withdrawn $20k but NO preWithdrawnCents field → treated as 0 pre-tax.
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
      // Floor = $500k / 26.5 = 1_886_792 (post bucket is $0 so nothing excluded);
      // pre-tax withdrawn counted as 0 → full miss surfaces.
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(1_886_792);
    });

    it('orphan id (no resolvable account) → own singleton pool, full miss, no throw (direct)', () => {
      // An id present in rmdPerAccountCents but absent from accountProjections.
      // The full pipeline never surfaces such an id (the snapshot builder skips
      // unresolved ids), so this exercises the helper's defensive orphan branch
      // directly: it must key the id into its OWN singleton pool by the bare id,
      // never deref undefined, never drop the miss.
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
      // Orphan → its own singleton pool, withdrew $0 pre-tax (no resolvable
      // account) → full miss surfaces (never dropped).
      expect(result).toBe(1_886_792);
    });

    it('non-throw edges: no-accountBalances row, empty rmd map, and post-death-only year resolve cleanly', () => {
      // A row with no accountBalances map → no per-account derivation (household
      // fallback), no throw.
      const cpYears: DrawdownYear[] = [makeDrawdownYear(2024, 10_000)];
      const cpCtx = makeCtx({ withdrawalStrategy: { kind: 'taxEfficient' } });
      expect(() =>
        applyTaxIntegrationToDrawdownYears(cpYears, [], [], [], cpCtx, REAL_BUNDLE),
      ).not.toThrow();

      // Empty rmdPerAccountCents (no RMD-eligible accounts / below trigger age) →
      // shortfall stays 0, no throw.
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
      // Σ ties to the household floor within the documented ≤1¢ largest-remainder
      // tolerance (NOT exact ===).
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
      // MIXED account: half pre-tax, half Roth-designated. Only the pre-tax
      // sub-bucket carries an RMD; the §325 Roth portion is excluded.
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
      // RMD computed on the pre-tax half only ($300k / 26.5 ≈ $11,320), NOT the
      // full $600k balance.
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
      // The stamp is additive + display-only. Run the post-pass at RMD age and
      // assert the engine-set + tax-annotation fields keep their exact values
      // while the new per-account map is also present.
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
      // Unchanged engine + annotation oracles (same values the RMD-floor test
      // asserts for this exact input).
      expect(y.withdrawn).toBe(10_000);
      expect(y.balance).toBe(500_000);
      expect(y.rmdFloorCents).toBe(1_886_792);
      expect(y.rmdShortfallCents).toBe(886_792);
      // …and the additive field is present alongside them.
      expect(y.perAccountRmdCents).toBeDefined();
    });

    it('no-accountBalances row: field absent (no per-account RMD without a per-account map)', () => {
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 40_000)];
      const ctx = makeCtx({
        withdrawalStrategy: { kind: 'taxEfficient' },
        primaryBirthdate: '1951-01-01',
      });
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
      // A row with no accountBalances map carries no account ids, but the
      // deterministic floor still computes from the (empty) account set → {} or
      // absent. The page reads `accountBalances`, so no per-account line is
      // shown either way.
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
      // Basis $40k. Years 1-2 draw $15k + $15k (cumulative $30k ≤ $40k) → $0
      // tax / $0 penalty. Year 3 draws $20k (cumulative $50k): first $10k
      // consumes remaining basis (free); $10,000 earnings excess taxed as
      // ordinary income + $1,000 (10%) penalty.
      const years: DrawdownYear[] = [
        rothYear(2024, 15_000),
        rothYear(2025, 15_000),
        rothYear(2026, 20_000),
      ];
      const ctx = rothCtx(40_000);
      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      // Years 1-2: all contribution basis → $0 tax, $0 penalty, $0 MAGI.
      expect(years[0].magiCents).toBe(0);
      expect(years[0].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[0].federalTaxCents).toBe(0);
      expect(years[1].magiCents).toBe(0);
      expect(years[1].earlyWithdrawalPenaltyCents).toBe(0);
      expect(years[1].federalTaxCents).toBe(0);
      // Year 3: $10k earnings excess → MAGI $10k, $1,000 penalty. $10k ordinary
      // income is below the single standard deduction → $0 income tax, so the
      // whole federal-tax figure is the folded-in penalty.
      expect(years[2].magiCents).toBe(10_000 * 100);
      expect(years[2].earlyWithdrawalPenaltyCents).toBe(1_000 * 100);
      expect(years[2].federalTaxCents).toBe(1_000 * 100);
    });

    it('aggregates an owner two Roth IRAs (Pub 590-B): $0-basis account B draw covered by basis in A', () => {
      // One owner, two Roth IRAs: A has $40k derived basis, B has $0 basis. A
      // $20k pre-59½ draw sourced FROM account B is $0 tax / $0 penalty because
      // the owner's AGGREGATED $40k basis (all in A) covers it. An
      // accountId-keyed tracker would have taxed/penalized the whole $20k.
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
      // Same owner, two Roth IRAs ($40k aggregate basis). Year 1 draws $30k
      // from A; year 2 draws $20k from B → cumulative $50k. Year 2's first $10k
      // exhausts remaining basis ($40k − $30k), the $10k excess is earnings.
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
      // Full history: basis $40k → $20k draw is all basis → $0 penalty.
      // Short history: basis $5k → $20k draw → $15k earnings → $1,500 penalty.
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
      // One owner, two Roth IRAs, $0 derived basis. Each account draws $20k in
      // the same year (owner total $40k, all earnings). The owner's earnings
      // excess is allocated back per account proportional to each account's draw
      // ($20k each → $2,000 penalty each). Marking ONLY rothA exempt waives just
      // its $2,000 share; rothB's $2,000 penalty still applies (total $2,000),
      // proving the exempt-skip is per real account id, not the owner's whole leg
      // and not order-dependent.
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

      // Neither exempt: both accounts' $2,000 penalties apply → $4,000 total.
      expect(noExemptYears[0].earlyWithdrawalPenaltyCents).toBe(4_000 * 100);
      // Only rothA exempt: just rothB's $2,000 share is penalized.
      expect(aExemptYears[0].earlyWithdrawalPenaltyCents).toBe(2_000 * 100);
      // The $40k earnings income / MAGI is unchanged by the exemption.
      expect(aExemptYears[0].magiCents).toBe(noExemptYears[0].magiCents);
      expect(aExemptYears[0].magiCents).toBe(40_000 * 100);
    });

    it('Option A exemption waives the Roth earnings-penalty leg only (income tax on earnings unchanged)', () => {
      // $20k draw, $0 basis → $20k earnings: $2,000 penalty + $20k ordinary
      // income (MAGI). Marking the Roth IRA exempt zeroes the penalty but keeps
      // the $20k earnings income / MAGI unchanged.
      const nonExemptYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const nonExemptCtx = rothCtx(0);
      applyTaxIntegrationToDrawdownYears(nonExemptYears, [], [], [], nonExemptCtx, REAL_BUNDLE);

      const exemptYears: DrawdownYear[] = [rothYear(2024, 20_000)];
      const exemptCtx = rothCtx(0, undefined, ['roth1']);
      applyTaxIntegrationToDrawdownYears(exemptYears, [], [], [], exemptCtx, REAL_BUNDLE);

      expect(nonExemptYears[0].earlyWithdrawalPenaltyCents).toBe(2_000 * 100);
      expect(exemptYears[0].earlyWithdrawalPenaltyCents).toBe(0);
      // Income tax on the $20k earnings excess is unaffected by the exemption.
      expect(exemptYears[0].magiCents).toBe(nonExemptYears[0].magiCents);
      expect(exemptYears[0].magiCents).toBe(20_000 * 100);
    });
  });

  describe('SS income rows wired', () => {
    it('grossSsDollars from ssRows appears in magiCents', () => {
      // SS.total is an annualized run-rate ($/yr at this month) per
      // SsMonthOutput — `mean(rate_m for m in 0..11) = annual sum`.
      // A flat $20k/yr benefit shows 20_000 in every month's row, not
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

      // With SS, MAGI should be higher than without SS (taxable portion included)
      const yearsNoSs: DrawdownYear[] = [makeDrawdownYear(2024, 30_000)];
      applyTaxIntegrationToDrawdownYears(yearsNoSs, [], [], [], ctx, REAL_BUNDLE);

      expect(years[0].magiCents).toBeGreaterThanOrEqual(yearsNoSs[0].magiCents!);
    });

    it('grossSsForYear is the mean of monthly run-rates, not the 12x sum', () => {
      // Regression for the bug that surfaced once the Tax Burden chart
      // exposed the runner's per-year tax fields: summing 12 months of
      // $50k/yr SS naively produced grossSsDollars = $600k → federal tax
      // computed on income ~5–10x the real number. Annual amount for a
      // flat $/yr benefit must equal the run-rate (mean of months), not
      // 12x it.
      const flatYear = Array.from({ length: 12 }, (_, m) => ({
        year: 2024,
        month0: m,
        total: 50_000,
        primary: 50_000,
      }));
      const years: DrawdownYear[] = [makeDrawdownYear(2024, 0)];
      const ctx = makeCtx();
      applyTaxIntegrationToDrawdownYears(years, flatYear, [], [], ctx, REAL_BUNDLE);
      // MAGI on $50k SS alone (no withdrawals) ≤ $50k — taxable SS caps at
      // 85% of gross, so MAGI ≤ $42.5k. The pre-fix bug would have
      // produced MAGI > $500k (12x), which would also push the result
      // into much higher federal tax brackets.
      expect(years[0].magiCents).toBeLessThanOrEqual(50_000 * 100);
    });
  });

  describe('nonSsIncomeRows wired as otherOrdinaryIncomeDollars', () => {
    it('pension income in nonSsIncomeRows increases magiCents vs zero income', () => {
      // pensionIncome is an annualized run-rate ($/yr at this month) per
      // IncomeMonthOutput. A $30k/yr pension shows `pensionIncome: 30_000`
      // in every month's row; otherOrdinaryIncomeForYear takes the mean.
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

      // $30k pension should push magiCents higher
      expect(yearsWithPension[0].magiCents).toBeGreaterThan(yearsNoPension[0].magiCents!);
    });

    it('otherOrdinaryIncomeForYear is the mean of run-rates plus the sum of spikes', () => {
      // Pension + part-time are annualized run-rates ($/yr at this
      // month) — summing 12 months naively gives 12x the annual income
      // and dramatically over-states federal tax. oneOffIncome is the
      // literal event-month dollar amount and is summed unchanged.
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
      // MAGI ≈ $35k ($30k pension + $5k oneOff) — the pre-fix bug would
      // have produced MAGI ≈ $365k (12 × $30k + $5k), well over any
      // reasonable retirement MAGI for the test fixture.
      expect(years[0].magiCents).toBeLessThanOrEqual(40_000 * 100);
    });

    it('depositInflow in nonSsIncomeRows does NOT affect magiCents', () => {
      // depositInflow = portfolio additions — not taxable ordinary income
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
      // accountBalances map contains an ID not in accountProjections →
      // should route to postTaxNonRoth (conservative low-tax direction).
      const accountBalances = new Map([
        ['unknown-id', makeAccountBalance(400_000, 50_000)],
      ]);
      const years: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, accountBalances),
      ];
      // accountProjections is empty → 'unknown-id' won't be found
      const ctx = makeCtx({ accountProjections: [] });

      applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);

      // postTaxNonRoth withdrawal ≠ preTax withdrawal → federal tax should be lower
      // than if the same dollars were routed to preTax. We assert tax is 0 because
      // a $50k post-tax-non-roth withdrawal has zero LTCG basis fraction =
      // cost basis at 0.5 default: only gain portion is taxable.
      // Key property: magiCents reflects LTCG path (postTaxNonRoth), not preTax.
      // Concrete check: run with a known preTax account and verify tax differs.
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

      // Tax on a preTax $50k withdrawal > tax on postTaxNonRoth $50k withdrawal
      // (postTaxNonRoth applies cost basis fraction — only gain is taxable).
      expect(yearsWithPre[0].federalTaxCents).toBeGreaterThan(years[0].federalTaxCents!);
    });
  });

  describe('MIXED account withdrawal classification', () => {
    it('MIXED withdrawal with per-bucket fields → pre lands in preTax, post in postTaxNonRoth', () => {
      // MIXED account withdraws $40k pre + $10k post. Per-bucket fields
      // surface (engine populated them). Tax pass should classify $40k
      // as preTax, $10k as postTaxNonRoth — NOT $50k as postTaxNonRoth.
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
      // Compare to a hypothetical scenario where everything routes to
      // post: tax would be lower because LTCG/QDI proxy applies cost
      // basis. Here $40k routes as ordinary income → higher federal tax.
      // Run a "buggy" comparison without per-bucket fields:
      const buggyRow: DrawdownAccountYear = {
        balance: 100_000,
        preEnd: 60_000,
        postEnd: 40_000,
        withdrawn: 50_000,
        deposit: 0,
        // No preWithdrawnCents / postWithdrawnCents → fallback "all post"
      };
      const buggyBalances = new Map([['mixed-401k', buggyRow]]);
      const buggyYears: DrawdownYear[] = [
        makeDrawdownYear(2024, 50_000, buggyBalances),
      ];
      applyTaxIntegrationToDrawdownYears(buggyYears, [], [], [], ctx, REAL_BUNDLE);
      // Correctly-routed MIXED → $40k preTax → higher MAGI than buggy "all post"
      // ($50k post × 0.5 cost basis = $25k LTCG in MAGI).
      expect(years[0].magiCents!).toBeGreaterThan(buggyYears[0].magiCents!);
    });
  });

  describe('MIXED account RMD basis excludes Roth-designated portion', () => {
    it('MIXED account with $100k pre + $50k post → RMD basis $100k (not $150k)', () => {
      // Owner born 1951 → age 73 in 2024. MIXED 401k carrying $100k pre +
      // $50k post (Roth-designated). Year-0 RMD basis = $100k / 26.5 ≈
      // $3,774 (NOT $150k / 26.5 ≈ $5,660).
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
      // Floor in cents. $100,000 / 26.5 = $3,773.58 → 377358 cents.
      // Tolerance: allow ±$1 (100 cents) for engine rounding.
      const expectedFloorCents = Math.round((100_000 / 26.5) * 100);
      const overstatedFloorCents = Math.round((150_000 / 26.5) * 100);
      expect(years[0].rmdFloorCents).toBeGreaterThan(expectedFloorCents - 200);
      expect(years[0].rmdFloorCents).toBeLessThan(expectedFloorCents + 200);
      // Hard assertion: NOT close to the buggy $150k-basis value.
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

// ---------------------------------------------------------------------------
// Annual yield drag + evolving cost basis (deterministic post-pass)
// ---------------------------------------------------------------------------

describe('brokerage-like yield drag + evolving cost basis', () => {
  /** Build a chain of single-brokerage-account years with explicit per-year
   *  end balance / withdrawal / deposit. The accumulator reads each year's
   *  start balance as the prior year's end balance (year 0 falls back to the
   *  pre-withdrawal value via the seed). */
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

  /** Ledger giving the 'brk' account a year-0 start balance via initialPost so
   *  the yield drag has a base in the first projection year. */
  function brokerageLedger(initialBalance: number): DrawdownAccountInput[] {
    return [makeLedgerAccount('brk', 0, initialBalance)];
  }

  it('m5_double_count_guard_reinvested_yield_is_added_to_basis', () => {
    // Zero appreciation beyond yield: a $1,000,000 brokerage account held for two
    // years at the 2% assumed yield, then fully withdrawn in year 2. The yield is
    // taxed annually (each year) and reinvested into basis, so the withdrawal-time
    // gain is NOT taxed again on those reinvested dollars.
    const years = brokerageYears([
      { year: 2024, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2025, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2026, endBalance: 0, withdrawn: 1_000_000 },
    ]);
    applyTaxIntegrationToDrawdownYears(years, [], [], brokerageLedger(1_000_000), brokerageCtx(), REAL_BUNDLE);

    // Years 0 + 1: only the yield drag is taxed. $1M × 2% = $20k yield → MAGI $20k.
    expect(years[0].magiCents).toBe(20_000 * 100);
    expect(years[1].magiCents).toBe(20_000 * 100);

    // Year 2 full withdrawal. Basis seeded at 50% ($500k) grows by reinvested
    // yield each year (year0 $20k, year1 $20k, year2 $20k) → $560k at withdrawal.
    // Realized LTCG = $1,000,000 − $560,000 = $440,000 (the reinvested yield is
    // return of already-taxed principal, NOT re-taxed). Year-2 yield adds $20k
    // ($10k QDI + $10k interest) → MAGI = $440k + $20k = $460k.
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
    // A brokerage account appreciates every year with NO contributions. The
    // basis fraction falls (value grows faster than basis), so the gain share
    // (1 − fraction) on an identical withdrawal RISES over time. Compare the
    // LTCG realized on a $100k withdrawal in an early year vs a late year.
    // Early-withdrawal projection: withdraw $100k in year 1.
    const earlyYears = brokerageYears([
      { year: 2024, endBalance: 1_000_000, withdrawn: 0 },
      { year: 2025, endBalance: 1_100_000, withdrawn: 100_000 },
    ]);
    applyTaxIntegrationToDrawdownYears(earlyYears, [], [], [], brokerageCtx(), REAL_BUNDLE);
    const earlyGainCents = earlyYears[1].magiCents ?? 0;

    // Late-withdrawal projection: appreciate for many years, then withdraw $100k.
    const lateRows = [{ year: 2024, endBalance: 1_000_000, withdrawn: 0 }];
    let bal = 1_000_000;
    for (let y = 2025; y <= 2034; y += 1) {
      bal = Math.round(bal * 1.07); // 7% appreciation, no contributions
      lateRows.push({ year: y, endBalance: bal, withdrawn: 0 });
    }
    // Final year: withdraw $100k against the heavily-appreciated balance.
    const finalYear = 2035;
    bal = Math.round(bal * 1.07);
    lateRows.push({ year: finalYear, endBalance: bal - 100_000, withdrawn: 100_000 });
    const lateYears = brokerageYears(lateRows);
    applyTaxIntegrationToDrawdownYears(lateYears, [], [], [], brokerageCtx(), REAL_BUNDLE);
    const lateGainCents = lateYears[lateYears.length - 1].magiCents ?? 0;

    // The late withdrawal realizes a LARGER gain share (basis fraction fell).
    expect(lateGainCents).toBeGreaterThan(earlyGainCents);
  });

  it('m6_cost_basis_fraction_stays_in_0_1_every_year_no_guard_throw', () => {
    // A long pure-appreciation projection with periodic withdrawals must never
    // throw the [0,1] guard — the evolving fraction is clamped by
    // construction. Asserting the run completes + annotates every year proves
    // the guard never fired.
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

  // The rollover-year RMD carved out of a
  // linked-CBP lump-sum is taxable ordinary income, injected via the single
  // canonical `rolledRmdIncomeByYear` inlet. These tests pin that the
  // income moves every dependent surface and is taxed exactly once.
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

      // The carved RMD lifts the year's federal tax and MAGI vs the no-split run.
      expect(splitYears[0].federalTaxCents ?? 0).toBeGreaterThan(
        baseYears[0].federalTaxCents ?? 0,
      );
      expect(splitYears[0].magiCents ?? 0).toBeGreaterThan(baseYears[0].magiCents ?? 0);
      // MAGI rises by approximately the injected $40k (within tax-engine rounding).
      const magiDeltaDollars =
        ((splitYears[0].magiCents ?? 0) - (baseYears[0].magiCents ?? 0)) / 100;
      expect(magiDeltaDollars).toBeGreaterThan(39_000);
      expect(magiDeltaDollars).toBeLessThan(41_000);
    });

    it('moves taxable Social Security (§86) and IRMAA for a Medicare household', () => {
      // Born 1950 → on Medicare in 2024; a Medicare member + gross SS exercises
      // the IRMAA + §86 surfaces. Years 0–1 use the stored lookback; year 2 uses
      // the rolling MAGI ring, so a rolled RMD in year 0 funds the year-2 IRMAA.
      // Modest gross SS so §86 taxable-SS is BELOW the 85% cap in the base run —
      // the rolled RMD's extra provisional income then pushes more SS into tax.
      const ssRow = (year: number) => ({ year, month0: 0, total: 240_000, primary: 240_000 });
      const ssRows = [ssRow(2024), ssRow(2025), ssRow(2026)];
      // Low withdrawal so the base year's provisional income leaves §86 headroom.
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

      // §86 taxable SS rises in the event year (more provisional income).
      expect(split[0].taxableSsCents ?? 0).toBeGreaterThan(base[0].taxableSsCents ?? 0);
      // The event-year MAGI rose (the IRMAA 2-year-lookback basis source).
      expect(split[0].magiCents ?? 0).toBeGreaterThan(base[0].magiCents ?? 0);
      // IRMAA 2-year look-back: year 2 (2026) surcharges off year 0 (2024) MAGI,
      // which the rolled RMD raised — so the year-2 surcharge moves up.
      expect(split[2].irmaaSurchargeCents ?? 0).toBeGreaterThan(
        base[2].irmaaSurchargeCents ?? 0,
      );
    });

    it('moves the ACA-PTC MAGI surface for a pre-Medicare household', () => {
      // Born 1970 → age 54 in 2024, NOT on Medicare → ACA-PTC applies. The
      // rolled RMD raises MAGI → the FPL% (ACA-PTC MAGI surface) moves.
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
      // A qualifying pre-tax ledger account drives the per-account RMD floor.
      // The rolled-CBP SOURCE is NOT a ledger account (excluded by contract), so
      // injecting the rolled RMD via `rolledRmdIncomeByYear` must NOT also be
      // counted by the floor path: the floor (`rmdFloorCents`) is unchanged
      // between the no-injection and injection runs.
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

      // The forced-RMD floor (per-account, ledger-driven) is identical — the
      // rolled-CBP RMD never enters it (no overlap → no double-count).
      expect(split[0].rmdFloorCents).toBe(base[0].rmdFloorCents);
      // The rolled RMD is taxed once: federal tax rose by the injection's tax,
      // not by twice the injection.
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

// ---------------------------------------------------------------------------
// Cash-like interest in the deterministic annotation (savings/MM/CD
// realized growth is annual ordinary income; HSA growth stays tax-free)
// ---------------------------------------------------------------------------

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
    // $300k savings earning 4%: year-0 start from the ledger ($300k) → year-0
    // interest = 312k − 300k = $12k; year 1 grows to $324,480 while paying out
    // $5k → interest = 324,480 + 5,000 − 312,000 = $17,480? No — 312k × 1.04 =
    // 324,480 BEFORE the withdrawal; end = 319,480 → interest = 319,480 + 5,000
    // − 312,000 = $12,480. MAGI equals the interest each year (the withdrawal
    // itself stays return of already-taxed principal).
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
    // A $50k deposit into the CD is new principal, not growth: interest =
    // end + withdrawn − deposit − start = 156k + 0 − 50k − 100k = $6k.
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
    // No prior-year row AND no ledger entry for cash1: the start-of-year
    // balance is unknown. The `unknownStartIsZeroGrowth` fallback synthesizes a
    // zero-growth start (end + withdrawn − deposit) so the interest derivation
    // never fabricates income out of an unknown opening balance (a `0` start
    // would tax the ENTIRE pre-withdrawal value as one year's "interest").
    const ctx = savingsCtx('SAVINGS');
    const row = { year: 2024, endBalance: 312_000, withdrawn: 5_000, deposit: 2_000 };
    const built = buildCashLikeYearAccounts(ctx, cashYears([row])[0], undefined, []);
    expect(built).toHaveLength(1);
    // Zero-growth start = end + withdrawn − deposit = 312k + 5k − 2k = 315k.
    expect(built[0].startBalanceDollars).toBe(315_000);
    expect(computeCashLikeInterestDollars(built)).toBe(0);
    // End-to-end via the annotation pass (empty ledger): $0 interest → $0 MAGI.
    const years = cashYears([row]);
    applyTaxIntegrationToDrawdownYears(years, [], [], [], ctx, REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('hsa_growth_stays_tax_free', () => {
    // The same growth on an HSA-typed account produces NO interest income —
    // HSA source identity is preserved (§223 growth is tax-free).
    const years = cashYears([{ year: 2024, endBalance: 312_000, withdrawn: 0 }]);
    const ledger = [makeLedgerAccount('cash1', 0, 300_000, { accountType: 'HSA', taxTreatment: 'POST_TAX' })];
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, savingsCtx('HSA'), REAL_BUNDLE);
    expect(years[0].magiCents).toBe(0);
  });

  it('interest_and_yield_drag_coexist_and_sum_into_magi', () => {
    // A brokerage ($1M, 2% assumed yield → $20k) + a savings account earning
    // $12k: MAGI carries both streams ($32k) in a no-withdrawal year.
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

// ---------------------------------------------------------------------------
// Filing plan on the DETERMINISTIC runner
// ---------------------------------------------------------------------------

describe('applyTaxIntegrationToDrawdownYears — filing plan', () => {
  /** A couple both born in 1955, retiring 2024; ledger holds one pre-tax IRA
   *  each so the two returns have real, separable ownership. */
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
  /** Two years, all of the household's withdrawal drawn from the PRIMARY's IRA. */
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
    // The whole draw is the primary's, so filing apart pushes it through ONE
    // narrower MFS schedule instead of the joint one — strictly more tax.
    expect(totalTax(separate)).toBeGreaterThan(totalTax(joint));
  });

  it('should_report_each_owners_withdrawals_on_their_own_separate_return', () => {
    // Same household total, different ownership → different tax. This is the
    // owner-attribution contract, visible end-to-end at the runner.
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
    // A two-member `Single` scalar cannot be converted. The projection must
    // be IDENTICAL to the no-plan behaviour: nothing dropped, nothing guessed.
    const withScalar = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      withScalar, [], [], ledger, coupleCtx({ filingStatus: 'Single' }), REAL_BUNDLE,
    );
    expect(withScalar[0].federalTaxCents).toBeGreaterThan(0);
    const asJointPlan = lopsidedYears();
    applyTaxIntegrationToDrawdownYears(
      asJointPlan, [], [], ledger, coupleCtx({ taxFilingPlan: { kind: 'joint' } }), REAL_BUNDLE,
    );
    // It filed SINGLE (the status derived without a plan), not the joint plan default.
    expect(withScalar[0].federalTaxCents).not.toBe(asJointPlan[0].federalTaxCents);
  });

  it('should_stop_filing_jointly_after_a_projected_death', () => {
    // End to end: a joint plan files MFJ through the
    // death year, then Single. Life expectancy 70 → death in 2025.
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
    // Projection years 0–1 tier IRMAA on returns filed BEFORE the
    // projection starts, so the per-unit ring has no entry for them. The look-back
    // STATUS must resolve to `taxYear - 2`'s own plan (as MC does) rather than
    // fall back to the CURRENT year's status: otherwise a spouse dying in
    // projection year 0 would have year 1 tiered on the survivor's Single ladder
    // here and the couple's MFJ ladder in MC — off the same stored plan.
    //
    // 2024 is the death year (still filed jointly); 2025 is the survivor's
    // first Single year. Its look-back is the 2023 return, which the couple
    // filed JOINTLY. $150k sits above the Single tier-1 threshold ($106k) and
    // below the MFJ one ($212k), so the two ladders give opposite answers.
    const years = [2024, 2025].map((year) => {
      const y = makeDrawdownYear(year, 20_000);
      y.accountBalances = new Map<string, DrawdownAccountYear>([
        ['ira-p', makeAccountBalance(800_000, 20_000)],
      ]);
      return y;
    });
    const detCtx = coupleCtx({
      taxFilingPlan: { kind: 'joint' },
      // Secondary dies in 2024 (born 1955 → age 69), the FIRST projection year.
      lifeExpectancy: { primary: 95, secondary: 69 },
      magiBootstrapLookbackMinus2: 150_000,
      magiBootstrapLookbackMinus1: 150_000,
    });
    applyTaxIntegrationToDrawdownYears(years, [], [], ledger, detCtx, REAL_BUNDLE);
    // Both bootstrap years tier on a JOINT look-back return → below MFJ tier 1.
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

    // Control: the same year DOES surcharge once the look-back MAGI clears the
    // MFJ threshold, so the $0 above is the tier decision, not IRMAA being
    // skipped for this household.
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
    // A two-return bootstrap look-back must not collapse onto `units[0]`'s status:
    // in projection years 0–1 each spouse is tiered on their own Medicare
    // schedule, not both on the FIRST spouse's until the per-return ring fills.
    //
    // The couple lived together while filing apart, which puts an `MFS` return
    // on the steeper married-filing-separately schedule while a `HoH` return
    // stays on the single-filer one — the smallest household whose two returns
    // tier on genuinely different ladders. The stored $300k household look-back
    // splits to $150k per return, above tier 1 on both ladders but at very
    // different surcharges.
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
    // Both bootstrap years surcharge, and the head-of-household spouse's own
    // (lower) schedule shows up in BOTH of them — not just from year 2 on.
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
    // QSS is taxed on the MFJ schedule, so the survivor years cost LESS.
    expect(withQss[2].federalTaxCents!).toBeLessThan(years[2].federalTaxCents!);
    expect(withQss[3].federalTaxCents!).toBeLessThan(years[3].federalTaxCents!);
  });
});

// ---------------------------------------------------------------------------
// The missing-base-Medicare-premium readiness flag
// ---------------------------------------------------------------------------
//
// The warning's ENGINE half had no test at all: only the presentational prop was
// covered, so nothing proved the engine ever SETS the flag, nor that it stays
// unset in the two documented negative cases.
describe('medicareBasePremiumMissing readiness flag', () => {
  /** A household well past 65 with a large look-back MAGI, so IRMAA is charged. */
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
    // The fact is the FULL `isMedical` inventory, not the
    // HSA-qualified subset: Medicare / Medigap / drug-plan premiums are never
    // HSA-qualified, so a household that recorded exactly those premiums must
    // not be told it has no medical spending at all.
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
    // A pre-65 household is never charged IRMAA, so the warning must not fire
    // (it names a Medicare premium the household does not yet owe).
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
