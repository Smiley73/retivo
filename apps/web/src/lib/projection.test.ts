/**
 * Tests for the per-account projection helper. Companion to
 * `balance-calc.test.ts`; covers tax-bucket routing, year-range
 * arithmetic, contribution skip behavior, and the final-year
 * proration.
 *
 * Math is monthly-stepping: annual `ratePct` becomes a monthly factor
 * `(1 + ratePct/100)^(1/12)`; annual `c` contributions are spread
 * `c/12` across each accumulation month. Output is **nominal** —
 * `project()` no longer accepts an `inflationPct`; the page applies a
 * view-model deflator at display time. The closed-form
 * helpers below compute the analytical monthly-cadence nominal balance.
 */
import { project } from './projection';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

/** Closed-form: balance after `nMonths` months when contributing
 *  `annualC` per year (split /12 each month) at annual rate `annualR`,
 *  starting from `B`. Each month: add c/12, then compound by the
 *  monthly factor. */
function monthlyAccumValue(
  B: number,
  annualC: number,
  annualR: number,
  nMonths: number,
): number {
  const rm = Math.pow(1 + annualR / 100, 1 / 12);
  const cPerMonth = annualC / 12;
  if (Math.abs(rm - 1) < 1e-12) {
    // Zero rate → straight sum.
    return B + cPerMonth * nMonths;
  }
  // (B + c)·r, then ((B + c)·r + c)·r, … after n months:
  //   = B·r^n + c·(r^n + r^(n-1) + … + r^1)
  //   = B·r^n + c · r · (r^n − 1)/(r − 1)
  const rN = Math.pow(rm, nMonths);
  return B * rN + cPerMonth * rm * (rN - 1) / (rm - 1);
}

function balancePayload(
  overrides: Partial<AccountBalancePayload> = {},
): AccountBalancePayload {
  return {
    accountId: 'acc-1',
    year: 2025,
    lastUpdated: '2025-12-31T23:59:59Z',
    startingBalance: 0,
    startingBalancePreTax: null,
    startingBalancePostTax: null,
    contributionsPreTax: null,
    contributionsPostTax: null,
    companyContributions: 0,
    companyContributionsPreTax: null,
    companyContributionsPostTax: null,
    rollover: 0,
    distributions: 0,
    endingBalance: 0,
    endingBalancePreTax: null,
    endingBalancePostTax: null,
    totalContributions: 0,
    comment: null,
    ...overrides,
  };
}

function aggregate<T extends Record<string, unknown>>(id: string, body: T): Aggregate<T> {
  return {
    id,
    householdId: 'hh-1',
    aggregateType: 'accountBalance',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2025-12-31T23:59:59Z',
    deviceId: 'dev-1',
    payload: body,
  };
}

function account(overrides: Partial<AccountPayload> = {}): Aggregate<AccountPayload> {
  return {
    id: overrides.name ?? 'acc-1',
    householdId: 'hh-1',
    aggregateType: 'account',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2025-12-31T23:59:59Z',
    deviceId: 'dev-1',
    payload: {
      name: 'Acct',
      type: 'BROKERAGE',
      ownershipType: 'INDIVIDUAL',
      taxTreatment: 'POST_TAX',
      ownerId: 'hm-1',
      institution: 'Bank',
      notes: '',
      planningReturnPct: 7,
      active: true,
      plannedContributionPreTax: 0,
      plannedContributionPostTax: 0,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      ...overrides,
    },
  };
}

describe('project', () => {
  it('should_return_null_when_no_balance_history', () => {
    const acc = account();
    expect(
      project({
        account: acc,
        balances: [],
        ratePct: 7,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      }),
    ).toBeNull();
  });

  it('should_project_pre_only_account_into_pre_bucket_only', () => {
    const acc = account({ taxTreatment: 'PRE_TAX', plannedContributionPreTax: 5_000 });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 5,
      retirementDate: '2027-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    expect(r!.postTax).toBe(0);
    // 12 months of accumulation in 2026 + retirement at Jan 1, 2027.
    // Retirement-date balance reflects end of 2026 accumulation only.
    const expected = monthlyAccumValue(100_000, 5_000, 5, 12);
    expect(r!.preTax).toBeCloseTo(expected, 2);
    expect(r!.total).toBeCloseTo(expected, 2);
  });

  it('should_project_post_only_account_into_post_bucket_only', () => {
    const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 5_000 });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 5,
      retirementDate: '2027-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    expect(r!.preTax).toBe(0);
    expect(r!.postTax).toBeCloseTo(monthlyAccumValue(100_000, 5_000, 5, 12), 2);
  });

  it('should_project_roth_account_into_post_bucket_with_post_tax_contributions', () => {
    // Roth seeds the whole balance into the post (tax-free) bucket and routes
    // contributions as post-tax — identical to POST_TAX in seedBuckets /
    // contribAdds.
    const acc = account({ taxTreatment: 'ROTH', plannedContributionPostTax: 5_000 });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 5,
      retirementDate: '2027-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    expect(r!.preTax).toBe(0);
    expect(r!.postTax).toBeCloseTo(monthlyAccumValue(100_000, 5_000, 5, 12), 2);
  });

  it('should_split_mixed_account_using_stored_pre_post_balances_and_contributions', () => {
    const acc = account({
      taxTreatment: 'MIXED',
      plannedContributionPreTax: 3_000,
      plannedContributionPostTax: 2_000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const balances = [
      aggregate(
        'bal-1',
        balancePayload({
          year: 2025,
          endingBalance: 100_000,
          endingBalancePreTax: 60_000,
          endingBalancePostTax: 40_000,
          companyContributionsPreTax: 1_000,
          companyContributionsPostTax: 0,
        }),
      ),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 5,
      retirementDate: '2027-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // Pre: 60k + (3k planned + 1k company) annual /12 monthly, 12 mo.
    expect(r!.preTax).toBeCloseTo(monthlyAccumValue(60_000, 4_000, 5, 12), 2);
    // Post: 40k + 2k annual /12 monthly, 12 mo.
    expect(r!.postTax).toBeCloseTo(monthlyAccumValue(40_000, 2_000, 5, 12), 2);
  });

  it('should_skip_contributions_when_stopContributionsToday_true', () => {
    const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 5_000 });
    const balances = [
      aggregate(
        'bal-1',
        balancePayload({ year: 2025, endingBalance: 100_000, companyContributions: 2_000 }),
      ),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 5,
      retirementDate: '2028-01-01',
      stopContributionsToday: true,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // Pure compound, 24 months at monthly equivalent of 5% → 100k * 1.05^2.
    expect(r!.postTax).toBeCloseTo(110_250, 2);
    expect(r!.preTax).toBe(0);
  });

  it('should_extrapolate_company_contributions_from_latest_year', () => {
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate(
        'bal-1',
        balancePayload({ year: 2025, endingBalance: 100_000, companyContributions: 5_000 }),
      ),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 0,
      retirementDate: '2028-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // 0% rate → 24 monthly contribs of 5_000/12 each → 100k + 10k = 110k.
    expect(r!.postTax).toBeCloseTo(110_000, 2);
  });

  it('should_prorate_final_year_by_retirement_months', () => {
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    // Retirement 2026-07-01 → monthIdx 6, m = 6/12 = 0.5.
    // 6 monthly steps at 7%, no contribs → 100k · (1.07)^(1/12)^6 = 100k · 1.07^0.5.
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2026-07-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    expect(r!.postTax).toBeCloseTo(100_000 * Math.pow(1.07, 0.5), 2);
  });

  it('should_handle_latest_balance_year_equals_retirement_year', () => {
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2026, endingBalance: 100_000 })),
    ];
    // Retirement 2026-06-30 → monthIdx 5, but day-1 / 30 ≈ 0.9667 → m ≈ 0.49722.
    // Engine uses retirementStepIdx = monthIdx = 5 → 5 monthly steps of compound only.
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2026-06-30',
      stopContributionsToday: true,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    const m = 5 / 12; // 5 whole monthly steps before retirement
    expect(r!.postTax).toBeCloseTo(100_000 * Math.pow(1.07, m), 2);
    expect(r!.yearlyTotals).toHaveLength(1);
    expect(r!.yearlyTotals[0].year).toBe(2026);
  });

  it('should_handle_zero_year_history_account_by_returning_null', () => {
    const r = project({
      account: account(),
      balances: [],
      ratePct: 7,
      retirementDate: '2030-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).toBeNull();
  });

  it('returns latest balance when retirement is already past', () => {
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2027, endingBalance: 200_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2025-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r!.postTax).toBe(200_000);
    expect(r!.yearlyTotals).toHaveLength(1);
  });

  it('does not double-add contributions when latestBalanceYear is after todayYear', () => {
    const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 1_000 });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2027, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 0,
      retirementDate: '2030-01-01',
      stopContributionsToday: false,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // 2028 + 2029 = 24 months × 1000/12 = 2000 contributed, 0% rate → 102_000.
    expect(r!.postTax).toBeCloseTo(102_000, 2);
  });

  it('should_emit_growth_and_contributions_per_year', () => {
    // 100k seed, 1k/yr contributions, 10% annual return, monthly cadence.
    const acc = account({
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 1_000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 10,
      retirementDate: '2028-01-01',
      stopContributionsToday: false,
      todayYear: 2025,
    });
    expect(r).not.toBeNull();
    expect(r!.yearlyTotals).toHaveLength(3);
    expect(r!.yearlyTotals[0].year).toBe(2026);
    expect(r!.yearlyTotals[0].contributions).toBeCloseTo(1_000, 2);
    expect(r!.yearlyTotals[1].year).toBe(2027);
    expect(r!.yearlyTotals[1].contributions).toBeCloseTo(1_000, 2);
    // 2028 retirement at m=0 → no contributions in retirement year.
    expect(r!.yearlyTotals[2].year).toBe(2028);
    expect(r!.yearlyTotals[2].contributions).toBe(0);
    // Pre-retirement growth dollars > 0 and consistent with monthly compounding.
    expect(r!.yearlyTotals[0].growth).toBeGreaterThan(9_000);
    expect(r!.yearlyTotals[1].growth).toBeGreaterThan(r!.yearlyTotals[0].growth);
  });

  it('should_emit_zero_contributions_when_stopContributionsToday', () => {
    const acc = account({
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 5_000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2030-01-01',
      stopContributionsToday: true,
      todayYear: 2025,
    });
    expect(r).not.toBeNull();
    for (const yt of r!.yearlyTotals) {
      expect(yt.contributions).toBe(0);
    }
    // Year-1 monthly compound of 100k at 7%/yr → 7_000 growth.
    expect(r!.yearlyTotals[0].growth).toBeCloseTo(7_000, 0);
  });

  it('should_prorate_contributions_in_retirement_year', () => {
    const acc = account({
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 12_000,
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 0,
      retirementDate: '2026-06-30',
      stopContributionsToday: false,
      todayYear: 2025,
    });
    expect(r).not.toBeNull();
    expect(r!.yearlyTotals).toHaveLength(1);
    // retirementStepIdx = 5 (June, month index 5). 5 months of 1k contribs.
    expect(r!.yearlyTotals[0].contributions).toBeCloseTo(5_000, 2);
  });

  it('emits nominal balances — no deflation applied at the engine boundary', () => {
    // Pinned defect: the engine once accepted an
    // `inflationPct` and deflated at year-emit. The
    // engine is now nominal-only; the page deflates at display time.
    // Verify the output is the raw compounded balance with no
    // deflator applied.
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 0,
      retirementDate: '2028-01-01',
      stopContributionsToday: true,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // 0 % return, 2 years compound → 100k untouched. A real-dollar
    // emit would have divided by (1.03)^2 = 1.0609; we deliberately do
    // not.
    expect(r!.postTax).toBeCloseTo(100_000, 2);
    expect(r!.yearlyTotals[r!.yearlyTotals.length - 1].postTax).toBeCloseTo(
      100_000,
      2,
    );
  });

  it('grows nominally with rate, independent of any prior deflator assumption', () => {
    // Pinned defect (companion): the same inputs at non-zero
    // return rate compound exactly per `monthlyAccumValue`; if a stray
    // deflator slipped back in this number would shift.
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2030-01-01',
      stopContributionsToday: true,
      todayYear: 2026,
    });
    expect(r).not.toBeNull();
    // Retirement Jan 1, 2030 reads balance at end of Dec 2029 — 48
    // monthly steps from Jan 2026 = exactly 4 years of compound at
    // the monthly equivalent of 7 %/yr.
    expect(r!.postTax).toBeCloseTo(100_000 * Math.pow(1.07, 4), 2);
  });

  it('drift vs annual-cadence engine stays under 2% on the 30y/7%/$100k+$10k/yr fixture', () => {
    const acc = account({
      taxTreatment: 'POST_TAX',
      plannedContributionPostTax: 10_000,
    });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2024, endingBalance: 100_000 })),
    ];
    const r = project({
      account: acc,
      balances,
      ratePct: 7,
      retirementDate: '2055-01-01',
      stopContributionsToday: false,
      todayYear: 2025,
    });
    expect(r).not.toBeNull();
    // Annual-cadence reference: every year add 10k then × 1.07. 30 years.
    let annual = 100_000;
    for (let i = 0; i < 30; i += 1) annual = (annual + 10_000) * 1.07;
    const drift = Math.abs(r!.postTax - annual) / annual;
    expect(drift).toBeLessThan(0.02);
  });

  // Per-account contribution stop month +
  // pre-retirement deposit routing.
  describe('accumulationEndDate (split-retirement contribution stop)', () => {
    it('zeroes contributions at accumulationEndDate but compounds balance through retirementDate', () => {
      // Owner retires 2028-01-01 → contributions stop end of 2027.
      // Household drawdown starts at primary's 2030-01-01 → balance
      // keeps growing growth-only for 2028 + 2029 (24 months).
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 12_000 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2028-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      // 24 mo of contrib (2026 + 2027), then 24 mo of pure compound.
      const atOwnerStop = monthlyAccumValue(100_000, 12_000, 7, 24);
      const expected = atOwnerStop * Math.pow(1.07, 2);
      expect(r!.postTax).toBeCloseTo(expected, 2);
    });

    it('defaults to retirementDate (legacy contract) when accumulationEndDate omitted', () => {
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 12_000 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      // Full 48 months of contributions through to retirementDate.
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(100_000, 12_000, 7, 48), 2);
    });

    it('clamps accumulationEndDate past retirementDate to retirementDate (joint accounts)', () => {
      // Joint account: caller passes secondary's later date but the
      // engine must not exceed retirementDate. Equivalent to omitting.
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 12_000 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2035-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(100_000, 12_000, 7, 48), 2);
    });

    it('honours stopContributionsToday over accumulationEndDate (zero contribs throughout)', () => {
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 12_000 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2028-01-01',
        stopContributionsToday: true,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.postTax).toBeCloseTo(100_000 * Math.pow(1.07, 4), 2);
    });
  });

  describe('preRetirementDeposits (routing)', () => {
    it('drops a $40k Sept 2028 deposit at month 8 of 2028 and compounds it through retirement', () => {
      // Primary retires 2030-01-01; targeted windfall of $40k lands in
      // post-tax bucket in Sept 2028. 16 months of compounding from
      // event month to retirement boundary.
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementDeposits: [{ year: 2028, month0: 8, preTax: 0, postTax: 40_000 }],
      });
      expect(r).not.toBeNull();
      // Base portfolio (zero contribs): 48 mo of pure compound.
      const baseBalance = 100_000 * Math.pow(1.07, 4);
      // Deposit landed in step 32 (Sept 2028). It then receives 16
      // remaining steps of monthly compounding (Oct 2028 → Dec 2029).
      const depositGrown = 40_000 * Math.pow(Math.pow(1.07, 1 / 12), 16);
      expect(r!.postTax).toBeCloseTo(baseBalance + depositGrown, 2);
    });

    it('routes preTax deposits into the pre-tax bucket independently', () => {
      const acc = account({
        taxTreatment: 'MIXED',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
      });
      const balances = [
        aggregate(
          'bal-1',
          balancePayload({
            year: 2025,
            endingBalance: 100_000,
            endingBalancePreTax: 50_000,
            endingBalancePostTax: 50_000,
          }),
        ),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2027-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementDeposits: [{ year: 2026, month0: 5, preTax: 10_000, postTax: 5_000 }],
      });
      expect(r).not.toBeNull();
      // 0% rate; deposits just add to their buckets.
      expect(r!.preTax).toBeCloseTo(60_000, 2);
      expect(r!.postTax).toBeCloseTo(55_000, 2);
    });

    it('silently drops deposits dated at-or-after accumulationEndDate (post-primary go to drawdown)', () => {
      const acc = account({ taxTreatment: 'POST_TAX', plannedContributionPostTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2028-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementDeposits: [
          { year: 2027, month0: 0, preTax: 0, postTax: 10_000 }, // before stop → in
          { year: 2028, month0: 5, preTax: 0, postTax: 99_999 }, // after stop → drop
          { year: 2029, month0: 0, preTax: 0, postTax: 99_999 }, // after stop → drop
        ],
      });
      expect(r).not.toBeNull();
      expect(r!.postTax).toBeCloseTo(110_000, 2);
    });
  });

  describe('preRetirementWithdrawals (working-years Roth-conversion source leg)', () => {
    it('reduces the source pre-tax bucket by the withdrawal at the pinned event month', () => {
      // Pre-tax source, no contributions. A $10k withdrawal lands at the same
      // pinned event month a conversion deposit would. Balance after = (seed −
      // withdrawal) compounded from the event month to the retirement boundary.
      const acc = account({ taxTreatment: 'PRE_TAX', plannedContributionPreTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 7,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementWithdrawals: [{ year: 2028, month0: 8, preTax: 10_000 }],
      });
      expect(r).not.toBeNull();
      // Base portfolio (zero contribs): 48 mo of pure compound.
      const baseBalance = 100_000 * Math.pow(1.07, 4);
      // The withdrawal is removed at step 32 (Sept 2028); its avoided 16 months
      // of remaining compounding is subtracted from the base.
      const withdrawalGrown = 10_000 * Math.pow(Math.pow(1.07, 1 / 12), 16);
      expect(r!.preTax).toBeCloseTo(baseBalance - withdrawalGrown, 2);
      expect(r!.postTax).toBe(0);
    });

    it('clamps a withdrawal larger than the source pre-tax balance (no negative)', () => {
      // 0% rate, no contributions: pre-tax balance at the event month is 50k.
      // A 99,999 withdrawal clamps to 50k → pre-tax ends at 0, never negative.
      const acc = account({ taxTreatment: 'PRE_TAX', plannedContributionPreTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 50_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementWithdrawals: [{ year: 2027, month0: 0, preTax: 99_999 }],
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBeCloseTo(0, 2);
      expect(r!.preTax).toBeGreaterThanOrEqual(0);
    });

    it('applies multiple same-source same-year withdrawals in stored array order', () => {
      // 0% rate, seed 30k. Two withdrawals in the same month: 20k then 20k.
      // The first clamps to 20k (10k remains), the second clamps to 10k.
      const acc = account({ taxTreatment: 'PRE_TAX', plannedContributionPreTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 30_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementWithdrawals: [
          { year: 2027, month0: 0, preTax: 20_000 },
          { year: 2027, month0: 0, preTax: 20_000 },
        ],
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBeCloseTo(0, 2);
    });

    it('silently drops withdrawals dated at-or-after accumulationEndDate', () => {
      const acc = account({ taxTreatment: 'PRE_TAX', plannedContributionPreTax: 0 });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2028-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        preRetirementWithdrawals: [
          { year: 2027, month0: 0, preTax: 10_000 }, // before stop → applied
          { year: 2029, month0: 0, preTax: 99_999 }, // after stop → dropped
        ],
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBeCloseTo(90_000, 2);
    });
  });

  describe('HSA tax-free treatment (single-sided post bucket)', () => {
    // HSA is single-sided (contribution
    // routing): the whole balance + every contribution land in the
    // post-tax / tax-free bucket; the pre-tax bucket is always 0. The
    // contribution AMOUNT is sourced from the pre-tax field
    // (`plannedContributionPreTax`, because HSA contributions are made
    // pre-tax) but grows in the post (tax-free) bucket — the contribution
    // field and the growth bucket are decoupled. The no-income-tax character
    // of qualified withdrawals is applied later in the drawdown tax pass,
    // independent of this bucket routing.
    it('seeds the whole HSA balance into the post bucket (pre bucket stays 0)', () => {
      const acc = account({
        taxTreatment: 'HSA',
        type: 'HSA',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
      });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 29_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2027-01-01',
        stopContributionsToday: true,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBe(0);
      expect(r!.postTax).toBeCloseTo(29_000, 2);
    });

    it('routes the pre-tax-field HSA contribution into the post bucket only', () => {
      const acc = account({
        taxTreatment: 'HSA',
        type: 'HSA',
        plannedContributionPreTax: 4_150,
        plannedContributionPostTax: 0,
      });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 29_000 })),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 5,
        retirementDate: '2027-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBe(0);
      // 29k seed + 4_150/yr pre-tax-field planned routed to the tax-free (post)
      // bucket, 12 mo at 5%/yr monthly cadence.
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(29_000, 4_150, 5, 12), 2);
    });

    it('routes HSA company contributions into the post bucket only', () => {
      const acc = account({
        taxTreatment: 'HSA',
        type: 'HSA',
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
      });
      const balances = [
        aggregate(
          'bal-1',
          balancePayload({
            year: 2025,
            endingBalance: 29_000,
            companyContributions: 1_200,
          }),
        ),
      ];
      const r = project({
        account: acc,
        balances,
        ratePct: 0,
        retirementDate: '2027-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBe(0);
      // 0% rate → 12 monthly company contribs of 1_200/12 → 29k + 1.2k.
      expect(r!.postTax).toBeCloseTo(30_200, 2);
    });

    it('ignores a stray plannedContributionPostTax on an HSA (single-sided invariant)', () => {
      // HSA stores its contribution on the pre-tax side
      // (`plannedContributionPreTax`). The post-tax field is hidden in the UI
      // for HSA, so any stored `plannedContributionPostTax` is stray data: the
      // engine must keep HSA single-sided and drop it (NOT add it to post),
      // matching the HSA contribution-routing rule.
      const withStrayPost = account({
        taxTreatment: 'HSA',
        type: 'HSA',
        plannedContributionPreTax: 4_150,
        plannedContributionPostTax: 3_000,
      });
      const balances = [
        aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 29_000 })),
      ];
      const r = project({
        account: withStrayPost,
        balances,
        ratePct: 5,
        retirementDate: '2027-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
      });
      expect(r).not.toBeNull();
      expect(r!.preTax).toBe(0);
      // Only the pre-tax-field planned (4_150) accumulates into the tax-free
      // bucket — the stray 3_000 post-tax value is dropped, identical to the
      // same account with post-tax = 0.
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(29_000, 4_150, 5, 12), 2);
    });
  });

  describe('indexed contribution semantics (supersedes the old flat-nominal contract)', () => {
    // This INVERTS the prior flat-nominal contract (projection-
    // contributions-shrink-yoy). The configured contribution figure is
    // now the TODAY'S-dollars amount: `project()` grows each accumulation
    // step month-precise, today-anchored via `contributionGrowthFactor`
    // (`asOfMonth = todayYear*12 + todayMonthIndex`) when a
    // `contributionGrowthPct` is threaded in. The runner passes the
    // resolved rate (tracks-inflation = scenario inflation rate; explicit =
    // fixed COLA). `0` / absent at the `project()` boundary = flat-nominal
    // (legacy). Output stays nominal; the display deflator —
    // built with the SAME today anchor — cancels the tracks-inflation
    // growth so the Today's-dollars view shows the configured number flat.

    /** The display deflator (today's dollars), reciprocal of the growth
     *  factor — month-precise, today-anchored at `(todayYear, monthIndex)`. */
    function deflator(
      year: number,
      monthIndex: number,
      inflationPct: number,
      todayYear: number,
      todayMonthIndex: number,
    ): number {
      const asOfMonth = todayYear * 12 + todayMonthIndex;
      return Math.pow(
        1 + inflationPct / 100,
        -(year * 12 + monthIndex - asOfMonth) / 12,
      );
    }

    function postTaxAcct(): Aggregate<AccountPayload> {
      return account({
        taxTreatment: 'POST_TAX',
        plannedContributionPostTax: 12_000,
      });
    }

    it('(a) absent→tracks-inflation: the Dec-anchored today-dollars series is flat even when latestBalanceYear ≥ todayYear', () => {
      // firstProjectionYear > todayYear edge: latest balance is 2026, today
      // is 2026 → firstProjectionYear = 2027 (> todayYear). The growth must
      // be anchored at TODAY (2026), not firstProjectionYear, so deflating
      // each Dec step back to today's dollars yields the flat $12k/yr.
      const inflationPct = 4;
      const todayYear = 2026;
      const todayMonthIndex = 0;
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2026, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2031-01-01',
        stopContributionsToday: false,
        todayYear,
        todayMonthIndex,
        contributionGrowthPct: inflationPct, // tracks-inflation resolved rate
      });
      expect(r).not.toBeNull();
      const perStep = r!.perStep!;
      expect(perStep).toBeDefined();
      // Per-YEAR today's-dollars contribution (sum of 12 monthly steps each
      // deflated at its own month) must equal the flat configured $12k.
      const firstYear = perStep.firstYear; // 2027
      const years = r!.yearlyTotals.length;
      for (let y = 0; y < years; y += 1) {
        const calYear = firstYear + y;
        let realSum = 0;
        for (let m = 0; m < 12; m += 1) {
          const step = y * 12 + m;
          if (step >= perStep.contributions.length) break;
          realSum +=
            perStep.contributions[step] *
            deflator(calYear, m, inflationPct, todayYear, todayMonthIndex);
        }
        if (calYear < 2031) {
          // Full accumulation years → flat $12k in today's dollars.
          expect(realSum).toBeCloseTo(12_000, 4);
        }
      }
    });

    it('(b) explicit 0 → flat-nominal (today-dollars view shrinks)', () => {
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        contributionGrowthPct: 0,
      });
      const perStep = r!.perStep!;
      // Nominal stays flat at $1000/mo; the today-dollars value erodes.
      for (let i = 0; i < (2030 - 2026) * 12; i += 1) {
        expect(perStep.contributions[i]).toBeCloseTo(1000, 9);
      }
    });

    it('(c) explicit > inflation → real growth (rises in today-dollars)', () => {
      const inflationPct = 2;
      const growthPct = 5; // above inflation
      const todayYear = 2026;
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear,
        contributionGrowthPct: growthPct,
      });
      const perStep = r!.perStep!;
      const firstYear = perStep.firstYear;
      // Dec-step real value strictly increases year over year.
      let prevReal = -Infinity;
      for (let y = 0; y < r!.yearlyTotals.length - 1; y += 1) {
        const step = y * 12 + 11;
        const real =
          perStep.contributions[step] *
          deflator(firstYear + y, 11, inflationPct, todayYear, 0);
        expect(real).toBeGreaterThan(prevReal);
        prevReal = real;
      }
    });

    it('(d) rate below inflation + negative rate → no implicit clamping', () => {
      // Negative growth shrinks the nominal series; the engine passes it
      // through (no floor at 0). Below-inflation positive likewise.
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: false,
        todayYear: 2026,
        contributionGrowthPct: -3,
      });
      const perStep = r!.perStep!;
      // Year 2 nominal contribution < year 1 (shrinking, not clamped).
      const y1 = perStep.contributions[11];
      const y2 = perStep.contributions[23];
      expect(y2).toBeLessThan(y1);
      expect(y2).toBeGreaterThan(0);
    });

    it('(e) three accounts spanning absent / 0 / >inflation grow independently', () => {
      // Run three separate projections (each account is projected
      // independently before aggregation) and confirm divergent series.
      const todayYear = 2026;
      const mk = (pct: number): Float64Array => {
        const r = project({
          account: postTaxAcct(),
          balances: [
            aggregate('b', balancePayload({ year: 2025, endingBalance: 0 })),
          ],
          ratePct: 0,
          retirementDate: '2030-01-01',
          stopContributionsToday: false,
          todayYear,
          contributionGrowthPct: pct,
        });
        return r!.perStep!.contributions;
      };
      const tracks = mk(3); // absent→3% inflation
      const flat = mk(0); // explicit 0
      const raise = mk(6); // >inflation
      const lastStep = (2030 - 2026) * 12 - 1;
      expect(flat[lastStep]).toBeCloseTo(1000, 6);
      expect(tracks[lastStep]).toBeGreaterThan(flat[lastStep]);
      expect(raise[lastStep]).toBeGreaterThan(tracks[lastStep]);
    });

    it('(f) stopContributionsToday → 0 even with a growth rate', () => {
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2030-01-01',
        stopContributionsToday: true,
        todayYear: 2026,
        contributionGrowthPct: 5,
      });
      const perStep = r!.perStep!;
      for (let i = 0; i < perStep.contributions.length; i += 1) {
        expect(perStep.contributions[i]).toBe(0);
      }
    });

    it('(g) accumulationEndDate mid-window stops grown contributions at the end step', () => {
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2032-01-01',
        accumulationEndDate: '2028-07-01', // mid-window
        stopContributionsToday: false,
        todayYear: 2026,
        contributionGrowthPct: 5,
      });
      const perStep = r!.perStep!;
      // firstProjectionYear = 2026. accumulationEnd step = (2028-2026)*12 + 6 = 30.
      const endStep = (2028 - 2026) * 12 + 6;
      expect(perStep.contributions[endStep - 1]).toBeGreaterThan(0);
      for (let i = endStep; i < perStep.contributions.length; i += 1) {
        expect(perStep.contributions[i]).toBe(0);
      }
    });

    it('(g2) accumulationEndDate past the projection window → 0 contributions throughout', () => {
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2030-01-01',
        accumulationEndDate: '2024-01-01', // before the window
        stopContributionsToday: false,
        todayYear: 2026,
        contributionGrowthPct: 5,
      });
      const perStep = r!.perStep!;
      for (let i = 0; i < perStep.contributions.length; i += 1) {
        expect(perStep.contributions[i]).toBe(0);
      }
    });

    it('(h) a deposit month carries the deposit + the grown recurring (deposit NOT × growth)', () => {
      // One-off deposits are explicit dated amounts — they are added on top
      // of the grown recurring fill, never multiplied by the growth factor.
      const todayYear = 2026;
      const growthPct = 10;
      const depositMonthYear = 2028;
      const r = project({
        account: postTaxAcct(),
        balances: [
          aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 0 })),
        ],
        ratePct: 0,
        retirementDate: '2031-01-01',
        stopContributionsToday: false,
        todayYear,
        contributionGrowthPct: growthPct,
        preRetirementDeposits: [
          { year: depositMonthYear, month0: 3, preTax: 0, postTax: 5_000 },
        ],
      });
      const perStep = r!.perStep!;
      const firstYear = perStep.firstYear; // 2026
      const depStep = (depositMonthYear - firstYear) * 12 + 3;
      const asOfMonth = todayYear * 12;
      const grownRecurring =
        1000 *
        Math.pow(1 + growthPct / 100, (firstYear * 12 + depStep - asOfMonth) / 12);
      // The deposit-month step = grown recurring + the raw $5000 deposit.
      expect(perStep.contributions[depStep]).toBeCloseTo(
        grownRecurring + 5_000,
        4,
      );
      // A neighbouring non-deposit month carries only the grown recurring.
      const grownNext =
        1000 *
        Math.pow(
          1 + growthPct / 100,
          (firstYear * 12 + (depStep + 1) - asOfMonth) / 12,
        );
      expect(perStep.contributions[depStep + 1]).toBeCloseTo(grownNext, 4);
    });
  });
});
