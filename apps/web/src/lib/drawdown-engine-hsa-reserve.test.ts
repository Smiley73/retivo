/**
 * Unit tests for the HSA medical-reserve two-pass drawdown routing.
 *
 * HSA is held OUT of the ordinary withdrawal tiers and drawn only via:
 *   (a) a medical-qualified pass — funds modeled `isMedical` demand from HSA
 *       balances tax-free, up to min(need, demand, balance), BEFORE the
 *       ordinary drain; and
 *   (b) an emergency-reserve pass — funds the remaining need from HSA ONLY
 *       after all non-HSA accounts are exhausted.
 * The committed HSA withdrawal splits into medical-qualified
 * (`medicalQualifiedWithdrawnCents`) and an emergency residual.
 */
import { describe, it, expect } from 'vitest';
import { simulateDrawdown } from './drawdown-engine';
import type { DrawdownAccountInput, DrawdownInput } from './drawdown-engine-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';

const SY = 2040;
const HY = 2040; // single year

function zeros(): MonthlyCashflowSeries {
  return { startYear: SY, startMonthIndex: 0, values: new Float64Array(12) };
}

function uniform(monthlyValue: number): MonthlyCashflowSeries {
  return { startYear: SY, startMonthIndex: 0, values: new Float64Array(12).fill(monthlyValue) };
}

function acct(o: Partial<DrawdownAccountInput> & { id: string }): DrawdownAccountInput {
  return {
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    taxTreatment: 'POST_TAX',
    accountType: 'BROKERAGE',
    depositsByMonth: zeros(),
    ...o,
  };
}

/** Cents array (length 12) with a flat per-month demand. */
function flatDemandCents(monthlyDollars: number): number[] {
  return new Array<number>(12).fill(Math.round(monthlyDollars * 100));
}

function baseInput(
  accounts: DrawdownAccountInput[],
  monthlyExpense: number,
  medicalDemandByMonth?: number[],
): DrawdownInput {
  return {
    portfolioAtRetirement: 0,
    ratePct: 0,
    expensesByMonth: uniform(monthlyExpense),
    incomeByMonth: zeros(),
    depositsByMonth: zeros(),
    retirementYear: SY,
    horizonYear: HY,
    withdrawalStrategy: { kind: 'taxEfficient' },
    accounts,
    medicalDemandByMonth,
  };
}

function hsaRow(out: ReturnType<typeof simulateDrawdown>, id: string) {
  return out.years[0].accountBalances?.get(id);
}

describe('HSA medical-reserve routing — medical-qualified pass', () => {
  it('funds modeled medical demand from HSA first, leaving non-HSA untouched', () => {
    // $1k/mo expense, all of it medical demand. Brokerage + HSA both funded.
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000, flatDemandCents(1_000)));
    const brok = hsaRow(out, 'brok');
    const hsa = hsaRow(out, 'hsa');
    // Whole 12k need is medical → funded from HSA; brokerage untouched.
    expect(hsa?.withdrawn).toBeCloseTo(12_000, 2);
    expect(hsa?.medicalQualifiedWithdrawnCents).toBe(1_200_000);
    expect(brok?.withdrawn).toBeCloseTo(0, 2);
  });

  it('caps the medical HSA draw at the medical demand (remainder from non-HSA)', () => {
    // $1k/mo expense; only $400/mo is medical demand.
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000, flatDemandCents(400)));
    const brok = hsaRow(out, 'brok');
    const hsa = hsaRow(out, 'hsa');
    expect(hsa?.withdrawn).toBeCloseTo(4_800, 2); // 400 * 12 medical
    expect(hsa?.medicalQualifiedWithdrawnCents).toBe(480_000);
    expect(brok?.withdrawn).toBeCloseTo(7_200, 2); // 600 * 12 from brokerage
  });

  it('caps the medical HSA draw at the HSA balance (remainder from non-HSA)', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 3_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000, flatDemandCents(1_000)));
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    expect(hsa?.withdrawn).toBeCloseTo(3_000, 2); // HSA fully drained
    expect(brok?.withdrawn).toBeCloseTo(9_000, 2);
  });
});

describe('HSA medical-reserve routing — emergency pass', () => {
  it('does NOT tap HSA for non-medical spending while non-HSA funds exist', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    // No medical demand at all.
    const out = simulateDrawdown(baseInput(accounts, 1_000));
    const hsa = hsaRow(out, 'hsa');
    expect(hsa?.withdrawn).toBeCloseTo(0, 2);
    expect(hsa?.medicalQualifiedWithdrawnCents).toBeUndefined();
  });

  it('taps HSA as emergency reserve only after non-HSA is exhausted', () => {
    // Brokerage holds 6k; need is 12k for the year; no medical demand.
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 6_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000));
    const brok = hsaRow(out, 'brok');
    const hsa = hsaRow(out, 'hsa');
    expect(brok?.withdrawn).toBeCloseTo(6_000, 2);
    expect(hsa?.withdrawn).toBeCloseTo(6_000, 2); // emergency residual
    // Emergency dollars are NOT medical-qualified.
    expect(hsa?.medicalQualifiedWithdrawnCents).toBeUndefined();
  });
});

describe('HSA medical-reserve routing — surplus + fallback', () => {
  it('leaves HSA untouched in a surplus-income year (no positive need)', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const input = baseInput(accounts, 1_000, flatDemandCents(1_000));
    // Income covers all expense → no positive portfolio need.
    const withIncome: DrawdownInput = { ...input, incomeByMonth: uniform(2_000) };
    const out = simulateDrawdown(withIncome);
    const hsa = hsaRow(out, 'hsa');
    expect(hsa?.withdrawn).toBeCloseTo(0, 2);
  });

  it('degrades to emergency-only when no medical demand series is supplied', () => {
    // No medicalDemandByMonth: HSA pass a is a no-op, only emergency remains.
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 3_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000));
    const hsa = hsaRow(out, 'hsa');
    expect(hsa?.withdrawn).toBeCloseTo(9_000, 2); // 12k need − 3k brokerage
  });

  it('proportional strategy also holds HSA out of the pool', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const input: DrawdownInput = {
      ...baseInput(accounts, 1_000),
      withdrawalStrategy: { kind: 'proportional' },
    };
    const out = simulateDrawdown(input);
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    // No medical demand → HSA untouched; brokerage funds the whole need.
    expect(hsa?.withdrawn).toBeCloseTo(0, 2);
    expect(brok?.withdrawn).toBeCloseTo(12_000, 2);
  });
});

/** With `withdrawalStrategy` absent the engine defaults to taxEfficient. The
 *  default path must stamp the medical/emergency split on the HSA row exactly
 *  as an explicit named strategy does. */
function defaultStrategyInput(
  accounts: DrawdownAccountInput[],
  monthlyExpense: number,
  medicalDemandByMonth?: number[],
): DrawdownInput {
  const input = baseInput(accounts, monthlyExpense, medicalDemandByMonth);
  // Absent strategy → engine default (taxEfficient).
  const rest = { ...input };
  delete rest.withdrawalStrategy;
  return rest;
}

describe('HSA medical-reserve routing — default strategy (absent) row split', () => {
  it('stamps the medical-qualified split on the default-strategy HSA row', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    // $1k/mo expense; $400/mo medical → 4.8k medical-qualified, 7.2k from brokerage.
    const out = simulateDrawdown(defaultStrategyInput(accounts, 1_000, flatDemandCents(400)));
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    expect(hsa?.withdrawn).toBeCloseTo(4_800, 2);
    expect(hsa?.medicalQualifiedWithdrawnCents).toBe(480_000);
    expect(brok?.withdrawn).toBeCloseTo(7_200, 2);
    // Medical + emergency residual sum EXACTLY to the committed HSA cents.
    const committedCents = Math.round((hsa?.withdrawn ?? 0) * 100);
    const emergencyCents = committedCents - (hsa?.medicalQualifiedWithdrawnCents ?? 0);
    expect(emergencyCents).toBe(0);
  });

  it('leaves the default-strategy HSA medical field undefined on a pure emergency draw', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 6_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    // No medical demand → HSA only draws as emergency residual after brokerage.
    const out = simulateDrawdown(defaultStrategyInput(accounts, 1_000));
    const hsa = hsaRow(out, 'hsa');
    expect(hsa?.withdrawn).toBeCloseTo(6_000, 2);
    expect(hsa?.medicalQualifiedWithdrawnCents).toBeUndefined();
  });
});

describe('HSA emergency boundary', () => {
  it('leaves HSA untouched when non-HSA balance exactly equals the year need', () => {
    // Brokerage exactly funds the 12k need; no medical demand.
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 12_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000));
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    expect(brok?.withdrawn).toBeCloseTo(12_000, 2);
    expect(hsa?.withdrawn).toBeCloseTo(0, 2);
  });

  it('draws the single cent from HSA when need exceeds non-HSA by $0.01', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 11_999.99 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const out = simulateDrawdown(baseInput(accounts, 1_000));
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    expect(brok?.withdrawn).toBeCloseTo(11_999.99, 2);
    expect(hsa?.withdrawn).toBeCloseTo(0.01, 2);
    expect(hsa?.medicalQualifiedWithdrawnCents).toBeUndefined();
  });
});

describe('HSA × customOrder two-pass', () => {
  it('routes HSA via the two-pass when HSA is excluded by default from the tiers', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 6_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const input: DrawdownInput = {
      ...baseInput(accounts, 1_000, flatDemandCents(300)),
      withdrawalStrategy: { kind: 'customOrder' },
      // Only the brokerage is tiered; HSA is implicitly excluded → two-pass.
      customDrawdownOrder: { tiers: [['brok']], excludedAccountIds: [] },
    };
    const out = simulateDrawdown(input);
    const hsa = hsaRow(out, 'hsa');
    const brok = hsaRow(out, 'brok');
    // 300/mo medical (3.6k) from HSA medical pass; brokerage funds the rest
    // (6k), then HSA emergency covers the residual to the 12k need.
    expect(hsa?.medicalQualifiedWithdrawnCents).toBe(360_000);
    expect(brok?.withdrawn).toBeCloseTo(6_000, 2);
    // Total need 12k = 3.6k medical + 6k brokerage + 2.4k HSA emergency.
    expect(hsa?.withdrawn).toBeCloseTo(6_000, 2);
  });

  it('does NOT double-draw when a custom tier lists HSA explicitly', () => {
    const accounts = [
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const input: DrawdownInput = {
      ...baseInput(accounts, 1_000, flatDemandCents(400)),
      withdrawalStrategy: { kind: 'customOrder' },
      // HSA explicitly listed in a tier — it is NOT excluded; medical pass still
      // runs first, but the committed HSA withdrawn must never exceed its draw.
      customDrawdownOrder: { tiers: [['hsa'], ['brok']], excludedAccountIds: [] },
    };
    const out = simulateDrawdown(input);
    const hsa = hsaRow(out, 'hsa');
    // Medical-qualified cents never exceed the committed HSA withdrawal cents.
    const committedCents = Math.round((hsa?.withdrawn ?? 0) * 100);
    expect(hsa?.medicalQualifiedWithdrawnCents ?? 0).toBeLessThanOrEqual(committedCents);
  });
});

describe('HSA × rothFirst end-to-end', () => {
  it('keeps HSA out of ordinary funds and still funds the medical/emergency passes', () => {
    const accounts = [
      acct({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA', initialPost: 5_000 }),
      acct({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE', initialPost: 100_000 }),
      acct({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA', initialPost: 100_000 }),
    ];
    const input: DrawdownInput = {
      ...baseInput(accounts, 1_000, flatDemandCents(500)),
      withdrawalStrategy: { kind: 'rothFirst' },
    };
    const out = simulateDrawdown(input);
    const hsa = hsaRow(out, 'hsa');
    const roth = hsaRow(out, 'roth');
    // 500/mo medical (6k) funded from HSA tax-free first; rothFirst then drains
    // the 5k Roth before brokerage. HSA stays out of the ordinary tiers.
    expect(hsa?.medicalQualifiedWithdrawnCents).toBe(600_000);
    expect(roth?.withdrawn).toBeCloseTo(5_000, 2);
  });
});
