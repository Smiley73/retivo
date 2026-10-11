/**
 * Tests for balance-projection-bundle — pins the series builders
 * + the MC bundle factory so they
 * remain unit-testable independent of the BalanceProjectionPage host.
 */
import { describe, expect, it } from 'vitest';
import {
  buildMonthlyExpenseSeries,
  buildMonthlyIncomeSeries,
  buildMonthlyDepositSeries,
  buildBalanceProjectionMcBundle,
  type MonthlyExpenseRow,
  type MonthlyIncomeRow,
  type MonthlySsRow,
  type BalanceProjectionMcBundleArgs,
} from './balance-projection-bundle';
import { mcInputFromBundle } from './balance-projection-runner-mc';
import { annualRollup } from './monthly-cashflow';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers';
import type {
  AccountPayload,
  AccountBalancePayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  SocialSecurityBenefitPayload,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';
import type { CbpValidationResult, ResolvedCbpElection } from './cbp-resolution';

describe('buildMonthlyExpenseSeries', () => {
  it('divides the recurring run-rate by 12', () => {
    const rows: MonthlyExpenseRow[] = [
      { year: 2030, month0: 0, total: 60_000, oneOffEssential: 0, oneOffDiscretionary: 0 },
      { year: 2030, month0: 6, total: 36_000, oneOffEssential: 0, oneOffDiscretionary: 0 },
    ];
    const series = buildMonthlyExpenseSeries({
      rows,
      retirementYear: 2030,
      horizonYear: 2030,
    });
    expect(series.values[0]).toBeCloseTo(60_000 / 12, 6);
    expect(series.values[6]).toBeCloseTo(36_000 / 12, 6);
    expect(series.values[11]).toBe(0);
  });

  it('charges one-off spikes at full event-month dollars (not /12)', () => {
    // 80k recurring run-rate mixed with a 40k one-off in March. `total`
    // is the projection helper's sum of both — split out the one-off
    // share before scaling the rest.
    const rows: MonthlyExpenseRow[] = [
      {
        year: 2030,
        month0: 2,
        total: 80_000 + 40_000,
        oneOffEssential: 40_000,
        oneOffDiscretionary: 0,
      },
    ];
    const series = buildMonthlyExpenseSeries({
      rows,
      retirementYear: 2030,
      horizonYear: 2030,
    });
    // Recurring 80k → 6,666.67 / month. One-off 40k stays whole.
    expect(series.values[2]).toBeCloseTo(80_000 / 12 + 40_000, 6);
  });

  it('drops rows outside the horizon window', () => {
    const rows: MonthlyExpenseRow[] = [
      { year: 2029, month0: 0, total: 999_999, oneOffEssential: 0, oneOffDiscretionary: 0 },
      { year: 2031, month0: 0, total: 999_999, oneOffEssential: 0, oneOffDiscretionary: 0 },
    ];
    const series = buildMonthlyExpenseSeries({
      rows,
      retirementYear: 2030,
      horizonYear: 2030,
    });
    expect(annualRollup(series, 2030)).toBe(0);
  });
});

describe('buildMonthlyIncomeSeries', () => {
  it('divides SS + pension + part-time run-rates by 12; keeps spendable one-off literal', () => {
    const ssRows: MonthlySsRow[] = [
      { year: 2030, month0: 0, total: 30_000 },
    ];
    const incomeRows: MonthlyIncomeRow[] = [
      {
        year: 2030,
        month0: 0,
        pensionIncome: 12_000,
        partTimeIncome: 24_000,
        oneOffIncome: 6_000,
        depositInflow: 999_999, // must NOT appear in income series
      },
    ];
    const series = buildMonthlyIncomeSeries({
      ssRows,
      incomeRows,
      retirementYear: 2030,
      horizonYear: 2030,
    });
    // Run-rate share: (30000 + 12000 + 24000) / 12 = 5500. One-off
    // literal: 6000. Combined: 11500 in Jan.
    expect(series.values[0]).toBeCloseTo(11_500, 6);
    expect(series.values[1]).toBe(0);
  });

  it('keeps depositInflow out of income', () => {
    const incomeRows: MonthlyIncomeRow[] = [
      {
        year: 2030,
        month0: 5,
        pensionIncome: 0,
        partTimeIncome: 0,
        oneOffIncome: 0,
        depositInflow: 50_000,
      },
    ];
    const series = buildMonthlyIncomeSeries({
      ssRows: [],
      incomeRows,
      retirementYear: 2030,
      horizonYear: 2030,
    });
    expect(annualRollup(series, 2030)).toBe(0);
  });
});

describe('buildMonthlyDepositSeries', () => {
  const primaryAbs = 2030 * 12 + 0; // primary retires Jan 2030.

  it('places a September windfall in September, not Jan', () => {
    const incomeRows: MonthlyIncomeRow[] = [
      {
        year: 2030,
        month0: 8,
        pensionIncome: 0,
        partTimeIncome: 0,
        oneOffIncome: 0,
        depositInflow: 40_000,
      },
    ];
    const series = buildMonthlyDepositSeries({
      incomeRows,
      retirementYear: 2030,
      horizonYear: 2030,
      primaryRetirementAbsMonth: primaryAbs,
    });
    expect(series.values[0]).toBe(0);
    expect(series.values[8]).toBe(40_000);
  });

  it('drops deposits that land before primary retirement', () => {
    const incomeRows: MonthlyIncomeRow[] = [
      {
        year: 2029,
        month0: 6,
        pensionIncome: 0,
        partTimeIncome: 0,
        oneOffIncome: 0,
        depositInflow: 25_000,
      },
    ];
    const series = buildMonthlyDepositSeries({
      incomeRows,
      retirementYear: 2030,
      horizonYear: 2030,
      primaryRetirementAbsMonth: primaryAbs,
    });
    expect(annualRollup(series, 2030)).toBe(0);
  });

  it('does NOT fold post-primary contributions into the household pool', () => {
    // Post-primary spouse contributions route per-account (carrying their
    // pre/post split) via the per-account ledger — never the household pool.
    // `buildMonthlyDepositSeries` carries ONLY the one-off / pension-lump-sum
    // `depositInflow`. A household-pool series built from an
    // income row with a $1,000 deposit carries exactly $1,000 — no post-primary
    // dollars are summed in.
    const series = buildMonthlyDepositSeries({
      incomeRows: [
        {
          year: 2030,
          month0: 0,
          pensionIncome: 0,
          partTimeIncome: 0,
          oneOffIncome: 0,
          depositInflow: 1_000,
        },
      ],
      retirementYear: 2030,
      horizonYear: 2030,
      primaryRetirementAbsMonth: primaryAbs,
    });
    expect(series.values[0]).toBe(1_000);
  });
});

// --- buildBalanceProjectionMcBundle fixtures ----------------------------

function aggregateBase(id: string, type: string) {
  return {
    id,
    householdId: 'hh',
    schemaVersion: 1,
    version: 1,
    updatedAt: '2026-01-01T00:00:00Z',
    deviceId: 'test',
    aggregateType: type,
  } as const;
}

function makeMember(
  id: string,
  isPrimary: boolean,
): Aggregate<HouseholdMemberPayload> {
  return {
    ...aggregateBase(id, 'householdMember'),
    payload: {
      isPrimary,
      firstName: isPrimary ? 'P' : 'S',
      lastName: '',
      email: '',
      birthdate: '1980-01-01',
    },
  } as Aggregate<HouseholdMemberPayload>;
}

function makeAccount(args: {
  id: string;
  type: AccountPayload['type'];
  active?: boolean;
  planningReturnPct?: number;
  assetMix?: AccountPayload['assetMix'];
  preTaxContrib?: number;
  postTaxContrib?: number;
  taxTreatment?: AccountPayload['taxTreatment'];
}): Aggregate<AccountPayload> {
  return {
    ...aggregateBase(args.id, 'account'),
    payload: {
      name: args.id,
      type: args.type,
      ownerId: 'p',
      ownershipType: 'JOINT',
      taxTreatment: args.taxTreatment ?? 'MIXED',
      institution: '',
      notes: '',
      active: args.active ?? true,
      planningReturnPct: args.planningReturnPct ?? 6,
      plannedContributionPreTax: args.preTaxContrib ?? 0,
      plannedContributionPostTax: args.postTaxContrib ?? 0,
      assetMix: args.assetMix ?? { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    },
  } as Aggregate<AccountPayload>;
}

function bundleArgs(
  overrides: Partial<BalanceProjectionMcBundleArgs> = {},
): BalanceProjectionMcBundleArgs {
  return {
    scenarioId: 'scn-1',
    scenarios: [] as ReadonlyArray<ScenarioAggregate>,
    accounts: [],
    balances: [] as ReadonlyArray<Aggregate<AccountBalancePayload>>,
    incomeStreams: [] as ReadonlyArray<Aggregate<IncomeStreamPayload>>,
    members: [makeMember('p', true)],
    expenses: [] as ReadonlyArray<Aggregate<ExpensePayload>>,
    ssBenefits: [] as ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>,
    cbpElections: null,
    cbpValidation: {
      ok: true,
      unconfigured: [],
      annuityMissingStream: [],
      annuityDuplicateStream: [],
    },
    todayYear: 2026,
    retirementYear: 2046,
    primaryRetirementMonth0: 0,
    horizonYear: 2086,
    retirementFractionalYear: 2046,
    lifeMarkers: [],
    accountBundles: [],
    monthlyExpenseBase: makeMonthlyExpenseBase(80_000, (2086 - 2026 + 1) * 12),
    // Year-indexed nominal arrays (firstYear=todayYear=2026, 61 years to 2086)
    ssByYear: Array.from({ length: 2086 - 2026 + 1 }, (_, i) =>
      2026 + i >= 2046 ? 30_000 : 0,
    ),
    incomeByYear: new Array<number>(2086 - 2026 + 1).fill(0),
    scenarioInflationPct: 3,
    targetedOneOffEvents: [],
    postPrimaryContributionEvents: [],
    ...overrides,
  };
}

describe('buildBalanceProjectionMcBundle', () => {
  it('blends asset mix across non-CBP accounts by balance weight', () => {
    const stockHeavy = makeAccount({
      id: 'a',
      type: 'BROKERAGE',
      assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
    });
    const bondHeavy = makeAccount({
      id: 'b',
      type: 'BROKERAGE',
      assetMix: { stocksPct: 0, bondsPct: 100, cashPct: 0 },
    });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        accountBundles: [
          { account: stockHeavy, latestBalance: 300_000 },
          { account: bondHeavy, latestBalance: 100_000 },
        ],
      }),
    );
    expect(out.portfolioToday).toBe(400_000);
    // 75% / 25% split by balance weight.
    expect(out.blendedMix.stocksPct).toBeCloseTo(75, 5);
    expect(out.blendedMix.bondsPct).toBeCloseTo(25, 5);
    expect(out.blendedMix.cashPct).toBe(0);
  });

  it('sums planned contributions across active accounts only', () => {
    const active = makeAccount({
      id: 'a',
      type: 'BROKERAGE',
      preTaxContrib: 10_000,
      postTaxContrib: 5_000,
    });
    const inactive = makeAccount({
      id: 'b',
      type: 'BROKERAGE',
      active: false,
      preTaxContrib: 999_999,
      postTaxContrib: 999_999,
    });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        accountBundles: [
          { account: active, latestBalance: 100_000 },
          { account: inactive, latestBalance: 100_000 },
        ],
      }),
    );
    expect(out.annualContribution).toBe(15_000);
  });

  it('lump-sum CBP emits a cbpLumpSum event at primary retirement month', () => {
    const cbpAccount = makeAccount({
      id: 'cbp-1',
      type: 'RETIREMENT_CASH_BALANCE',
      planningReturnPct: 4,
    });
    const elections = new Map<string, ResolvedCbpElection>([
      ['cbp-1', { kind: 'lumpSum', streamId: 's-1', targetAccountId: 'a' }],
    ]);
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2036,
        primaryRetirementMonth0: 3,
        accountBundles: [{ account: cbpAccount, latestBalance: 100_000 }],
        cbpElections: elections,
      }),
    );
    expect(out.cbpLumpSumEvents).toHaveLength(1);
    const event = out.cbpLumpSumEvents[0];
    // (2036 - 2026) * 12 + 3 = 123 months from firstYear.
    expect(event.month).toBe(123);
    // Fractional-year compounding through the actual retirement month
    // (April = month 3 → 10.25 years), not whole years.
    expect(event.amount).toBeCloseTo(100_000 * Math.pow(1.04, 123 / 12), 2);
    // CBP balance does NOT contribute to portfolioToday.
    expect(out.portfolioToday).toBe(0);
  });

  it('annuity CBP emits NO cbpLumpSum event and excludes balance', () => {
    const cbpAccount = makeAccount({
      id: 'cbp-1',
      type: 'RETIREMENT_CASH_BALANCE',
      planningReturnPct: 4,
    });
    const elections = new Map<string, ResolvedCbpElection>([
      ['cbp-1', { kind: 'annuity', streamId: 's-1' }],
    ]);
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        accountBundles: [{ account: cbpAccount, latestBalance: 100_000 }],
        cbpElections: elections,
      }),
    );
    expect(out.cbpLumpSumEvents).toHaveLength(0);
    expect(out.portfolioToday).toBe(0);
  });

  it('passes through targetedOneOff + postPrimaryContribution events unchanged', () => {
    const targeted = [{ month: 100, amount: 5_000, accountId: 'a' }];
    const postPrimary = [{ month: 200, amount: 1_500 }];
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        targetedOneOffEvents: targeted,
        postPrimaryContributionEvents: postPrimary,
      }),
    );
    expect(out.targetedOneOffEvents).toEqual(targeted);
    expect(out.postPrimaryContributionEvents).toEqual(postPrimary);
  });

  it('routes a post-primary contribution split into the ledger depositPre/depositPost slots', () => {
    // retirementStepIdx = (2046 - 2026) * 12 = 240. A post-retirement (month
    // 250) post-primary contribution targeting the MIXED account 'a' must route
    // its pre slice → depositPre, its Roth slice → depositPost, and the summed
    // `deposit` slot must equal pre + post (kernel byte-identical). No
    // double-count: the contribution appears ONLY on the ledger entry, never in
    // a household-pool series.
    const acct = makeAccount({ id: 'a', type: 'RETIREMENT_401K', taxTreatment: 'MIXED' });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        accountBundles: [{ account: acct, latestBalance: 100_000 }],
        postPrimaryContributionEvents: [
          { month: 250, amount: 1_500, amountPre: 900, amountPost: 600, accountId: 'a' },
        ],
      }),
    );
    const entry = out.accountMcLedger.find((e) => e.id === 'a')!;
    expect(entry.depositPre[250]).toBe(900);
    expect(entry.depositPost[250]).toBe(600);
    expect(entry.deposit[250]).toBe(1_500); // summed = pre + post
  });

  it('clamps already-retired CBP lump-sum event to step 0 (today)', () => {
    // Pinned defect: `retirementAbsMonth` goes negative when
    // `retirementYear < todayYear`; the MC kernel drops events with
    // `month < 0` and CBP balances are excluded from `portfolioToday`,
    // so the lump-sum value would disappear entirely. The factory
    // clamps the event month to step 0 so the balance still lands.
    const cbpAccount = makeAccount({
      id: 'cbp-1',
      type: 'RETIREMENT_CASH_BALANCE',
      planningReturnPct: 4,
    });
    const elections = new Map<string, ResolvedCbpElection>([
      ['cbp-1', { kind: 'lumpSum', streamId: 's-1', targetAccountId: 'a' }],
    ]);
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2030,
        retirementYear: 2025, // already retired
        primaryRetirementMonth0: 0,
        accountBundles: [{ account: cbpAccount, latestBalance: 100_000 }],
        cbpElections: elections,
      }),
    );
    expect(out.cbpLumpSumEvents).toHaveLength(1);
    const event = out.cbpLumpSumEvents[0];
    expect(event.month).toBe(0);
    // `yearsToRetirement` clamps to 0 → no further growth applied.
    expect(event.amount).toBeCloseTo(100_000, 2);
  });

  it('emits a per-account MC ledger with per-account asset mix', () => {
    const stockHeavy = makeAccount({
      id: 'a',
      type: 'BROKERAGE',
      assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
      preTaxContrib: 0,
      postTaxContrib: 12_000,
    });
    const bondHeavy = makeAccount({
      id: 'b',
      type: 'BROKERAGE',
      assetMix: { stocksPct: 0, bondsPct: 100, cashPct: 0 },
      preTaxContrib: 6_000,
      postTaxContrib: 0,
    });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2046,
        primaryRetirementMonth0: 0,
        horizonYear: 2086,
        accountBundles: [
          { account: stockHeavy, latestBalance: 300_000 },
          { account: bondHeavy, latestBalance: 100_000 },
        ],
      }),
    );
    expect(out.accountMcLedger).toHaveLength(2);
    const a = out.accountMcLedger[0];
    const b = out.accountMcLedger[1];
    // Each entry surfaces its own asset mix (no household blending).
    expect(a.assetMix).toEqual({ stocksPct: 100, bondsPct: 0, cashPct: 0 });
    expect(b.assetMix).toEqual({ stocksPct: 0, bondsPct: 100, cashPct: 0 });
    // MIXED-tax default split (makeAccount default) lands as 50/50.
    expect(a.initialPre).toBeCloseTo(150_000);
    expect(a.initialPost).toBeCloseTo(150_000);
    // Pre-retirement contributions split /12 across each accumulation step.
    const retirementStep = (2046 - 2026) * 12;
    expect(a.contribPost[0]).toBeCloseTo(12_000 / 12);
    expect(a.contribPost[retirementStep - 1]).toBeCloseTo(12_000 / 12);
    // After retirement step the contribution arrays drop to zero.
    expect(a.contribPost[retirementStep]).toBe(0);
    expect(b.contribPre[0]).toBeCloseTo(6_000 / 12);
    // Non-CBP accounts have no planning-return override.
    expect(a.cbpPlanningReturnPct).toBeNull();
    expect(b.cbpPlanningReturnPct).toBeNull();
  });

  it('routes HSA planned contributions single-sided into the post bucket (MC ledger)', () => {
    // HSA is single-sided: the whole balance + the contribution land in the post
    // (tax-free) bucket. The HSA contribution is sourced from the pre-tax
    // field (`plannedContributionPreTax`, because HSA contributions are made
    // pre-tax) but routed to the post bucket; the post-tax field is hidden in
    // the UI for HSA, so any stored `plannedContributionPostTax` is stray data
    // the MC ledger must drop — keeping the MC and deterministic surfaces in
    // agreement.
    const hsa = makeAccount({
      id: 'hsa',
      type: 'HSA',
      taxTreatment: 'HSA',
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      preTaxContrib: 4_150, // HSA contribution lives on the pre-tax field
      postTaxContrib: 3_000, // stray post-tax value — must be ignored
    });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2046,
        primaryRetirementMonth0: 0,
        horizonYear: 2086,
        accountBundles: [{ account: hsa, latestBalance: 29_000 }],
      }),
    );
    expect(out.accountMcLedger).toHaveLength(1);
    const entry = out.accountMcLedger[0];
    // Whole balance seeds the post bucket; pre bucket stays 0.
    expect(entry.initialPre).toBe(0);
    expect(entry.initialPost).toBeCloseTo(29_000);
    // The pre-tax-field contribution (4_150) streams into the post bucket; the
    // stray post-tax value is dropped on every accumulation step.
    const retirementStep = (2046 - 2026) * 12;
    expect(entry.contribPost[0]).toBeCloseTo(4_150 / 12);
    expect(entry.contribPost[retirementStep - 1]).toBeCloseTo(4_150 / 12);
    expect(entry.contribPre[0]).toBe(0);
    expect(entry.contribPre[retirementStep - 1]).toBe(0);
  });

  it('annuity-elected CBP is excluded from the per-account MC ledger', () => {
    const cbp = makeAccount({
      id: 'cbp-1',
      type: 'RETIREMENT_CASH_BALANCE',
      planningReturnPct: 4,
    });
    const brokerage = makeAccount({ id: 'a', type: 'BROKERAGE' });
    const elections = new Map<string, ResolvedCbpElection>([
      ['cbp-1', { kind: 'annuity', streamId: 's-1' }],
    ]);
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        accountBundles: [
          { account: cbp, latestBalance: 100_000 },
          { account: brokerage, latestBalance: 50_000 },
        ],
        cbpElections: elections,
      }),
    );
    expect(out.accountMcLedger).toHaveLength(1);
    expect(out.accountMcLedger[0].id).toBe('a');
  });

  it('targeted one-off event routes into the per-account ledger deposit slot', () => {
    const acct = makeAccount({ id: 'a', type: 'BROKERAGE' });
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2046,
        primaryRetirementMonth0: 0,
        horizonYear: 2086,
        accountBundles: [{ account: acct, latestBalance: 100_000 }],
        // Post-retirement month (year 22 month 8) — routes to deposit.
        targetedOneOffEvents: [{ month: 22 * 12 + 8, amount: 40_000, accountId: 'a' }],
      }),
    );
    expect(out.accountMcLedger).toHaveLength(1);
    const entry = out.accountMcLedger[0];
    expect(entry.deposit[22 * 12 + 8]).toBe(40_000);
    // No leakage to other steps.
    expect(entry.deposit[22 * 12 + 7]).toBe(0);
  });

  it('a matched plain-pension is credited per-account exactly ONCE', () => {
    // The plain-pension lump-sum dollars are in BOTH the per-account placement
    // (plainPensionPlacementEvents) AND the household-spread targetedOneOffEvents
    // (sourced from depositInflow). A matched target must be credited once: the
    // per-account ledger deposit slot, with the household-spread amount subtracted
    // to zero by mcInputFromBundle so the kernel does not also spread it.
    const acct = makeAccount({ id: 'a', type: 'BROKERAGE' });
    const month = 22 * 12 + 8; // post-retirement (retirement = year 20, month 0)
    const bundle = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2046,
        primaryRetirementMonth0: 0,
        horizonYear: 2086,
        accountBundles: [{ account: acct, latestBalance: 100_000 }],
        // Same dollars present in both seams (the production cashflow builder
        // emits both: depositInflow → targetedOneOff, and the per-account
        // placement → plainPensionPlacementEvents).
        targetedOneOffEvents: [{ month, amount: 50_000 }],
        plainPensionPlacementEvents: [{ month, amount: 50_000, accountId: 'a' }],
      }),
    );
    // Per-account ledger: credited once.
    const entry = bundle.accountMcLedger.find((e) => e.id === 'a')!;
    expect(entry.deposit[month]).toBe(50_000);
    // Household spread: the matched amount is subtracted to zero in the MC input
    // events, so it is NOT applied a second time via the proportional spread.
    const input = mcInputFromBundle(bundle);
    const spreadAtMonth = (input.events ?? [])
      .filter((e) => e.source === 'targetedOneOff' && e.month === month)
      .reduce((s, e) => s + e.amount, 0);
    expect(spreadAtMonth).toBe(0);
  });

  it('an UNMATCHED plain-pension stays in the household spread ONCE', () => {
    // Target not in the ledger → the dollars are NOT placed per-account; they
    // must remain in the household-spread targetedOneOff events exactly once
    // (no double-count from a redundant fallback re-append).
    const acct = makeAccount({ id: 'a', type: 'BROKERAGE' });
    const month = 22 * 12 + 8;
    const bundle = buildBalanceProjectionMcBundle(
      bundleArgs({
        todayYear: 2026,
        retirementYear: 2046,
        primaryRetirementMonth0: 0,
        horizonYear: 2086,
        accountBundles: [{ account: acct, latestBalance: 100_000 }],
        targetedOneOffEvents: [{ month, amount: 50_000 }],
        // Target 'missing' is not an account in the ledger.
        plainPensionPlacementEvents: [{ month, amount: 50_000, accountId: 'missing' }],
      }),
    );
    const entry = bundle.accountMcLedger.find((e) => e.id === 'a')!;
    expect(entry.deposit[month]).toBe(0); // not placed per-account
    const input = mcInputFromBundle(bundle);
    const spreadAtMonth = (input.events ?? [])
      .filter((e) => e.source === 'targetedOneOff' && e.month === month)
      .reduce((s, e) => s + e.amount, 0);
    expect(spreadAtMonth).toBe(50_000); // stays in the spread, exactly once
  });

  it('reflects cbpValidation through the bundle when validation fails', () => {
    const validation: CbpValidationResult = {
      ok: false,
      unconfigured: ['cbp-1'],
      annuityMissingStream: [],
      annuityDuplicateStream: [],
    };
    const out = buildBalanceProjectionMcBundle(
      bundleArgs({ cbpValidation: validation }),
    );
    expect(out.cbpValidation.ok).toBe(false);
    expect(out.cbpValidation.unconfigured).toEqual(['cbp-1']);
  });
});
