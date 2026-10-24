// Monthly-stepping math: annual `ratePct` becomes a monthly factor `(1 + ratePct/100)^(1/12)` and annual contributions spread c/12 per accumulation month. Output is nominal; the page deflates at display time.
import { project } from './projection';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

// Closed-form balance after `nMonths`: each month adds c/12, then compounds by the monthly factor.
function monthlyAccumValue(
  B: number,
  annualC: number,
  annualR: number,
  nMonths: number,
): number {
  const rm = Math.pow(1 + annualR / 100, 1 / 12);
  const cPerMonth = annualC / 12;
  if (Math.abs(rm - 1) < 1e-12) {
    return B + cPerMonth * nMonths;
  }
  // After n months: B·r^n + c · r · (r^n − 1)/(r − 1).
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
    expect(r!.preTax).toBeCloseTo(monthlyAccumValue(60_000, 4_000, 5, 12), 2);
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
    expect(r!.postTax).toBeCloseTo(110_000, 2);
  });

  it('should_prorate_final_year_by_retirement_months', () => {
    const acc = account({ taxTreatment: 'POST_TAX' });
    const balances = [
      aggregate('bal-1', balancePayload({ year: 2025, endingBalance: 100_000 })),
    ];
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
    // June 30 gives monthIdx 5; the engine uses retirementStepIdx = monthIdx, so 5 compound-only steps.
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
    expect(r!.postTax).toBeCloseTo(102_000, 2);
  });

  it('should_emit_growth_and_contributions_per_year', () => {
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
    expect(r!.yearlyTotals[2].year).toBe(2028);
    expect(r!.yearlyTotals[2].contributions).toBe(0);
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
    expect(r!.yearlyTotals[0].contributions).toBeCloseTo(5_000, 2);
  });

  it('emits nominal balances — no deflation applied at the engine boundary', () => {
    // Pinned defect: the engine once accepted an `inflationPct` and deflated at year-emit; it is nominal-only now, so the output is the raw compounded balance.
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
    expect(r!.postTax).toBeCloseTo(100_000, 2);
    expect(r!.yearlyTotals[r!.yearlyTotals.length - 1].postTax).toBeCloseTo(
      100_000,
      2,
    );
  });

  it('grows nominally with rate, independent of any prior deflator assumption', () => {
    // Companion: at a non-zero rate the number compounds exactly per `monthlyAccumValue`; a stray deflator would shift it.
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
    let annual = 100_000;
    for (let i = 0; i < 30; i += 1) annual = (annual + 10_000) * 1.07;
    const drift = Math.abs(r!.postTax - annual) / annual;
    expect(drift).toBeLessThan(0.02);
  });

  describe('accumulationEndDate (split-retirement contribution stop)', () => {
    it('zeroes contributions at accumulationEndDate but compounds balance through retirementDate', () => {
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
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(100_000, 12_000, 7, 48), 2);
    });

    it('clamps accumulationEndDate past retirementDate to retirementDate (joint accounts)', () => {
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
      const baseBalance = 100_000 * Math.pow(1.07, 4);
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
      const baseBalance = 100_000 * Math.pow(1.07, 4);
      const withdrawalGrown = 10_000 * Math.pow(Math.pow(1.07, 1 / 12), 16);
      expect(r!.preTax).toBeCloseTo(baseBalance - withdrawalGrown, 2);
      expect(r!.postTax).toBe(0);
    });

    it('clamps a withdrawal larger than the source pre-tax balance (no negative)', () => {
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
    // HSA is single-sided: the whole balance and every contribution land in the post (tax-free) bucket, with the amount read from the pre-tax field (HSA contributions are made pre-tax); the no-income-tax character of qualified withdrawals applies later in the drawdown tax pass.
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
      expect(r!.postTax).toBeCloseTo(30_200, 2);
    });

    it('ignores a stray plannedContributionPostTax on an HSA (single-sided invariant)', () => {
      // The post-tax field is hidden for HSA, so a stored `plannedContributionPostTax` is stray data the engine must drop, keeping HSA single-sided.
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
      expect(r!.postTax).toBeCloseTo(monthlyAccumValue(29_000, 4_150, 5, 12), 2);
    });
  });

  describe('indexed contribution semantics (supersedes the old flat-nominal contract)', () => {
    // `project()` grows each accumulation step month-precise, today-anchored via `contributionGrowthFactor` when a `contributionGrowthPct` is threaded in (tracks-inflation = scenario inflation, explicit = fixed COLA); 0/absent is flat-nominal. The display deflator with the same anchor cancels the growth so Today's dollars shows the configured number flat.

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
      // firstProjectionYear (2027) > todayYear (2026): growth must anchor at today, not firstProjectionYear, so deflating each Dec step yields the flat $12k/yr.
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
      const y1 = perStep.contributions[11];
      const y2 = perStep.contributions[23];
      expect(y2).toBeLessThan(y1);
      expect(y2).toBeGreaterThan(0);
    });

    it('(e) three accounts spanning absent / 0 / >inflation grow independently', () => {
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
      // One-off deposits are explicit dated amounts added on top of the grown recurring fill, never multiplied by the growth factor.
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
      expect(perStep.contributions[depStep]).toBeCloseTo(
        grownRecurring + 5_000,
        4,
      );
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
