/**
 * Unit tests for withdrawal-order redistribution and RMD floor
 * enforcement helpers in drawdown-engine-per-account.ts.
 */
import { describe, it, expect } from 'vitest';
import { rmdFloorEnforcePrePass, MissingCustomDrawdownOrderError } from './drawdown-engine-per-account';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import { simulateDrawdown } from './drawdown-engine';
import type { DrawdownAccountInput, DrawdownInput } from './drawdown-engine-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zeros(startYear: number, horizonYear: number): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return { startYear, startMonthIndex: 0, values: new Float64Array(months) };
}

function uniform(
  startYear: number,
  horizonYear: number,
  monthlyValue: number,
): MonthlyCashflowSeries {
  const months = (horizonYear - startYear + 1) * 12;
  return {
    startYear,
    startMonthIndex: 0,
    values: new Float64Array(months).fill(monthlyValue),
  };
}

function makeAccount(
  overrides: Partial<DrawdownAccountInput> & { id: string },
  startYear: number,
  horizonYear: number,
): DrawdownAccountInput {
  return {
    initialPre: 0,
    initialPost: 0,
    annualRatePct: 0,
    taxTreatment: 'POST_TAX',
    accountType: 'BROKERAGE',
    depositsByMonth: zeros(startYear, horizonYear),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// rmdFloorEnforcePrePass
// ---------------------------------------------------------------------------

describe('rmdFloorEnforcePrePass', () => {
  it('returns zero shortfall when no accounts present', () => {
    const r = rmdFloorEnforcePrePass({
      accounts: [],
      withdrawnByAccountId: new Map(),
      rmdFloorDollars: 10_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(0);
    expect(r.rmdShortfall).toBe(10_000);
  });

  it('shortfall is zero when eligible withdrawn meets the floor', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['ira', 20_000]]),
      rmdFloorDollars: 18_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(20_000);
    expect(r.rmdShortfall).toBe(0);
  });

  it('shortfall > 0 when eligible withdrawn is below the floor', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['ira', 10_000]]),
      rmdFloorDollars: 18_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(10_000);
    expect(r.rmdShortfall).toBe(8_000);
  });

  it('POST_TAX accounts are excluded from eligible sum', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, 2030, 2030),
      makeAccount({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['brok', 50_000], ['ira', 5_000]]),
      rmdFloorDollars: 10_000,
    });
    // Only PRE_TAX IRA counts: 5k withdrawn, floor 10k → shortfall 5k
    expect(r.rmdEligibleWithdrawn).toBe(5_000);
    expect(r.rmdShortfall).toBe(5_000);
  });

  it('ROTH (POST_TAX) account excluded from eligible sum', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['roth', 50_000]]),
      rmdFloorDollars: 20_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(0);
    expect(r.rmdShortfall).toBe(20_000);
  });

  it('rmdFloorDollars 0 → zero shortfall regardless of withdrawn', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['ira', 0]]),
      rmdFloorDollars: 0,
    });
    expect(r.rmdShortfall).toBe(0);
  });

  it('account not in withdrawnByAccountId treated as 0 withdrawn', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map(),
      rmdFloorDollars: 5_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(0);
    expect(r.rmdShortfall).toBe(5_000);
  });

  it('multiple PRE_TAX accounts sum correctly', () => {
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'ira1', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, 2030, 2030),
      makeAccount({ id: 'ira2', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }, 2030, 2030),
    ];
    const r = rmdFloorEnforcePrePass({
      accounts,
      withdrawnByAccountId: new Map([['ira1', 8_000], ['ira2', 7_000]]),
      rmdFloorDollars: 20_000,
    });
    expect(r.rmdEligibleWithdrawn).toBe(15_000);
    expect(r.rmdShortfall).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Redistribution via simulateDrawdown (integration path)
// ---------------------------------------------------------------------------

describe('withdrawal-order redistribution', () => {
  const retirementYear = 2030;
  const horizonYear = 2034;

  function expense5k() {
    return uniform(retirementYear, horizonYear, 5_000 / 12);
  }

  it('proportional strategy: per-account withdrawn is proportional to balance', () => {
    // Two equal-balance accounts — proportional split should be 50/50
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'post', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
    });
    // Both start at 100k; expense 5k/yr → each should contribute ~50%
    const yr0 = out.years[0];
    const preWithdrawn = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const postWithdrawn = yr0.accountBalances?.get('post')?.withdrawn ?? 0;
    expect(Math.abs(preWithdrawn - postWithdrawn)).toBeLessThan(10); // within $10
  });

  it('proportional MIXED account: preWithdrawnCents + postWithdrawnCents are populated (v48 kernel fix)', () => {
    // A MIXED 401k with $60k pre + $40k post. proportional path routes a
    // proportional share from both sub-buckets. The kernel threads
    // the per-step pre/post split into DrawdownAccountYear, so preWithdrawnCents
    // and postWithdrawnCents must be defined and sum to the cent count of
    // `withdrawn` (pre + post = total within 1 cent rounding).
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount(
          { id: 'mix401k', initialPre: 60_000, initialPost: 40_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
          retirementYear, horizonYear,
        ),
      ],
    });
    const row = out.years[0].accountBalances?.get('mix401k');
    expect(row).toBeDefined();
    expect(row!.preWithdrawnCents).toBeDefined();
    expect(row!.postWithdrawnCents).toBeDefined();
    // pre + post must equal the dollar amount converted to cents (within 1 cent).
    const withdrawnCents = Math.round(row!.withdrawn * 100);
    const splitSum = (row!.preWithdrawnCents ?? 0) + (row!.postWithdrawnCents ?? 0);
    expect(Math.abs(splitSum - withdrawnCents)).toBeLessThanOrEqual(1);
  });

  it('proportional MIXED account: pre-tax share is proportional to pre/post balance ratio', () => {
    // $60k pre, $40k post → pre ratio = 60/(60+40) = 0.6.
    // $5k/yr expense → ~$5k withdrawn from this single account; pre share ≈ $3k.
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount(
          { id: 'mix401k', initialPre: 60_000, initialPost: 40_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
          retirementYear, horizonYear,
        ),
      ],
    });
    const row = out.years[0].accountBalances?.get('mix401k');
    const preWithdrawnDollars = (row!.preWithdrawnCents ?? 0) / 100;
    const totalWithdrawn = row!.withdrawn;
    // Pre share should be ~60% of the total withdrawal (within 2%).
    const ratio = preWithdrawnDollars / totalWithdrawn;
    expect(ratio).toBeGreaterThan(0.58);
    expect(ratio).toBeLessThan(0.62);
  });

  it('proportional PRE_TAX account: preWithdrawnCents is defined and equals withdrawn*100', () => {
    // A pure PRE_TAX IRA via proportional: the kernel should record the full
    // withdrawal as pre-tax (no post tranche).
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount(
          { id: 'ira', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
          retirementYear, horizonYear,
        ),
      ],
    });
    const row = out.years[0].accountBalances?.get('ira');
    expect(row!.preWithdrawnCents).toBeDefined();
    const withdrawnCents = Math.round(row!.withdrawn * 100);
    expect(Math.abs((row!.preWithdrawnCents ?? 0) - withdrawnCents)).toBeLessThanOrEqual(1);
  });

  it('proportional HSA + MIXED: HSA row is all post, MIXED row splits pre/post (v48 HSA-present path)', () => {
    // HSA $40k + MIXED 401k ($60k pre, $40k post). proportional with an HSA uses
    // the two-pass (drawHsaPass + distributeNonHsaWithdrawal). After v48 the
    // per-step pre/post split is threaded into DrawdownAccountYear.
    // Assertions (within 1-cent rounding tolerance):
    //   HSA row:  preWithdrawnCents === 0, postWithdrawnCents === round(withdrawn*100)
    //   MIXED row: pre + post === round(withdrawn*100), both >= 0
    const out = simulateDrawdown({
      portfolioAtRetirement: 140_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount(
          { id: 'hsa', initialPost: 40_000, taxTreatment: 'HSA', accountType: 'HSA' },
          retirementYear, horizonYear,
        ),
        makeAccount(
          { id: 'mix401k', initialPre: 60_000, initialPost: 40_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
          retirementYear, horizonYear,
        ),
      ],
    });
    const hsaRow = out.years[0].accountBalances?.get('hsa');
    const mixRow = out.years[0].accountBalances?.get('mix401k');
    expect(hsaRow).toBeDefined();
    expect(mixRow).toBeDefined();
    // HSA: all post-bucket (no pre-tax sub-bucket).
    expect(hsaRow!.preWithdrawnCents ?? 0).toBe(0);
    const hsaWithdrawnCents = Math.round(hsaRow!.withdrawn * 100);
    if (hsaRow!.withdrawn > 0) {
      expect(Math.abs((hsaRow!.postWithdrawnCents ?? 0) - hsaWithdrawnCents)).toBeLessThanOrEqual(1);
    }
    // MIXED: pre + post = total within 1-cent rounding tolerance.
    const mixWithdrawnCents = Math.round(mixRow!.withdrawn * 100);
    const mixSplitSum = (mixRow!.preWithdrawnCents ?? 0) + (mixRow!.postWithdrawnCents ?? 0);
    expect(Math.abs(mixSplitSum - mixWithdrawnCents)).toBeLessThanOrEqual(1);
  });

  it('taxEfficient: POST_TAX depleted before PRE_TAX', () => {
    // POST_TAX = 50k, PRE_TAX = 150k; expense 5k/yr for 5 years
    // taxEfficient order: POST_TAX first → POST_TAX should drain first
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 150_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'post', initialPost: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
    });
    // Year 1: 5k from POST_TAX (capacity 50k), 0 from PRE_TAX
    const yr0 = out.years[0];
    const preWd = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const postWd = yr0.accountBalances?.get('post')?.withdrawn ?? 0;
    // POST_TAX has enough capacity → all withdrawal from POST_TAX
    expect(postWd).toBeCloseTo(5_000, 0);
    expect(preWd).toBeCloseTo(0, 0);
  });

  it('taxEfficient total withdrawal equals sum of per-account withdrawn', () => {
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'post', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
    });
    for (const yr of out.years) {
      const pre = yr.accountBalances?.get('pre')?.withdrawn ?? 0;
      const post = yr.accountBalances?.get('post')?.withdrawn ?? 0;
      expect(pre + post).toBeCloseTo(yr.withdrawn, 1);
    }
  });

  it('rothFirst: Roth depleted before PRE_TAX', () => {
    // Roth = 50k, PRE_TAX = 150k; expense 5k/yr
    // rothFirst: Roth first → Roth should drain first
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'rothFirst' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 150_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'roth', initialPost: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, retirementYear, horizonYear),
      ],
    });
    // Year 1: all from Roth (capacity 50k > 5k)
    const yr0 = out.years[0];
    const preWd = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const rothWd = yr0.accountBalances?.get('roth')?.withdrawn ?? 0;
    expect(rothWd).toBeCloseTo(5_000, 0);
    expect(preWd).toBeCloseTo(0, 0);
  });

  it('rothFirst total withdrawal preserved across all years', () => {
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'rothFirst' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, retirementYear, horizonYear),
      ],
    });
    for (const yr of out.years) {
      const pre = yr.accountBalances?.get('pre')?.withdrawn ?? 0;
      const roth = yr.accountBalances?.get('roth')?.withdrawn ?? 0;
      expect(pre + roth).toBeCloseTo(yr.withdrawn, 1);
    }
  });

  it('proportional strategy: per-account withdrawn is proportional (not reordered)', () => {
    // 3:1 PRE_TAX:POST_TAX → proportional should give 75%/25% split
    const out = simulateDrawdown({
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'proportional' },
      accounts: [
        makeAccount({ id: 'pre', initialPre: 150_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'post', initialPost: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
    });
    const yr0 = out.years[0];
    const preWd = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const postWd = yr0.accountBalances?.get('post')?.withdrawn ?? 0;
    // PRE_TAX starts at 3× post → should draw ~3× as much
    expect(preWd / postWd).toBeCloseTo(3, 0);
  });

  it('taxEfficient with only PRE_TAX accounts: all withdrawn from PRE_TAX', () => {
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira1', initialPre: 60_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'ira2', initialPre: 40_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_401K' }, retirementYear, horizonYear),
      ],
    });
    // Both PRE_TAX — taxEfficient places PRE_TAX in tier1; no tier0 → drawn from tier1
    for (const yr of out.years) {
      const ira1 = yr.accountBalances?.get('ira1')?.withdrawn ?? 0;
      const ira2 = yr.accountBalances?.get('ira2')?.withdrawn ?? 0;
      expect(ira1 + ira2).toBeCloseTo(yr.withdrawn, 1);
    }
  });

  it('strategy choice DIVERGES per-account balance trajectories across multi-year drawdown', () => {
    // Per-account drawdown is strategy-aware INSIDE
    // the engine (year-by-year stepping), not a label-only post-pass.
    // The same scenario under `taxEfficient` vs `proportional` MUST
    // produce different per-account balance series. Aggregate yearly
    // balance + total withdrawn remain identical (the household pulls
    // the same dollars; only WHICH account it drains changes).
    const base = {
      portfolioAtRetirement: 200_000,
      ratePct: 0,
      expensesByMonth: expense5k(),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
    };
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'pre', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
      makeAccount({ id: 'post', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
    ];
    const efficient = simulateDrawdown({ ...base, withdrawalStrategy: { kind: 'taxEfficient' }, accounts });
    const proportional = simulateDrawdown({ ...base, withdrawalStrategy: { kind: 'proportional' }, accounts });
    // Aggregate-level invariants: same household withdrawal totals.
    for (let y = 0; y < efficient.years.length; y += 1) {
      expect(efficient.years[y].balance).toBeCloseTo(proportional.years[y].balance, 1);
      expect(efficient.years[y].withdrawn).toBeCloseTo(proportional.years[y].withdrawn, 1);
    }
    // Per-account DIVERGENCE: taxEfficient drains POST_TAX first, leaving
    // PRE_TAX untouched; proportional drains both 50/50 every year. At
    // year 0 the POST_TAX balance must differ.
    const effPostY0 = efficient.years[0].accountBalances?.get('post')?.balance ?? 0;
    const propPostY0 = proportional.years[0].accountBalances?.get('post')?.balance ?? 0;
    const effPreY0 = efficient.years[0].accountBalances?.get('pre')?.balance ?? 0;
    const propPreY0 = proportional.years[0].accountBalances?.get('pre')?.balance ?? 0;
    // taxEfficient: POST drained $5k, ends at $95k. proportional: POST drained $2.5k, ends at $97.5k.
    expect(effPostY0).toBeLessThan(propPostY0 - 1000);
    expect(effPreY0).toBeGreaterThan(propPreY0 + 1000);
  });

  it('taxEfficient PRESERVES Roth longest under multi-year drawdown', () => {
    // Multi-year balance-divergence test. Setup: PRE $100k +
    // Roth $100k + POST $100k, $30k/yr expense for 5 yrs ($150k total).
    // taxEfficient: drains POST first ($100k → 0 by yr 3-4), then PRE,
    // Roth UNTOUCHED through year 5. rothFirst: drains Roth first,
    // leaving Roth empty by year 4.
    const base = {
      portfolioAtRetirement: 300_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 30_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
    };
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'pre', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
      makeAccount({ id: 'post', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, retirementYear, horizonYear),
    ];
    const efficient = simulateDrawdown({ ...base, withdrawalStrategy: { kind: 'taxEfficient' }, accounts });
    const roth = simulateDrawdown({ ...base, withdrawalStrategy: { kind: 'rothFirst' }, accounts });
    // taxEfficient: year 5 Roth still at $100k (untouched).
    const efficientLastRoth = efficient.years[4].accountBalances?.get('roth')?.balance ?? -1;
    expect(efficientLastRoth).toBeCloseTo(100_000, 0);
    // rothFirst: by year 4, Roth is depleted ($100k Roth - $30k×4 = -$20k → 0).
    const rothLastRoth = roth.years[3].accountBalances?.get('roth')?.balance ?? -1;
    expect(rothLastRoth).toBeLessThan(5_000);
  });

  it('HSA drawn STRICTLY after Roth — Roth exhausted before any HSA dollar', () => {
    // Roth $50k + HSA $50k, $40k/yr expense for 5 yrs ($200k total need).
    // Both Roth and HSA sit in the most-preserved tail. Under both
    // taxEfficient and rothFirst, HSA gets its own dedicated final tier,
    // so Roth must be fully depleted before any HSA withdrawal.
    const base = {
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 40_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
    };
    const accounts: DrawdownAccountInput[] = [
      makeAccount({ id: 'roth', initialPost: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, retirementYear, horizonYear),
      makeAccount({ id: 'hsa', initialPost: 50_000, taxTreatment: 'HSA', accountType: 'HSA' }, retirementYear, horizonYear),
    ];

    for (const kind of ['taxEfficient', 'rothFirst'] as const) {
      const out = simulateDrawdown({ ...base, withdrawalStrategy: { kind }, accounts });
      // Year 0: net need $40k; Roth ($50k) covers it alone → HSA untouched.
      const y0Hsa = out.years[0].accountBalances?.get('hsa');
      expect(y0Hsa?.withdrawn ?? 0).toBeCloseTo(0, 0);
      expect(y0Hsa?.balance ?? 0).toBeCloseTo(50_000, 0);
      // Roth is the sole source until depleted: any year with an HSA
      // withdrawal must have Roth already at $0.
      for (const yr of out.years) {
        const hsaWd = yr.accountBalances?.get('hsa')?.withdrawn ?? 0;
        if (hsaWd > 0) {
          const rothBal = yr.accountBalances?.get('roth')?.balance ?? -1;
          expect(rothBal).toBeCloseTo(0, 0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// RMD floor enforcement INSIDE simulatePerAccountMonthly
// ---------------------------------------------------------------------------

import { RMD_DIVISORS } from './rmd-divisors';
import type { RmdContextInput } from './drawdown-engine-types';

/** Build a single-owner RMD context for the tests. Owner birthdate is
 *  picked so the owner reaches the trigger age in `retirementYear`. */
function makeSingleOwnerRmdContext(
  ownerId: string,
  isoBirthdate: string,
  accountIds: ReadonlyArray<string>,
): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const id of accountIds) ownerByAccountId.set(id, ownerId);
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  // Death year far in the future so the alive-gate never fires in tests.
  ownerMeta.set(ownerId, { isoBirthdate, deathYear: 9999 });
  return {
    ownerMeta,
    ownerByAccountId,
    rmdSnapshot: RMD_DIVISORS,
  };
}

describe('RMD floor engagement inside simulatePerAccountMonthly', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;
  // Owner born 1957 → age 73 in 2030 → trigger fires; divisor 26.5.
  const ownerIsoBirthdate = '1957-06-15';

  it('spending need < RMD floor → engine forces extra PRE_TAX; surplus credits POST_TAX deposit', () => {
    // IRA balance $1.4M → RMD ≈ $52,830 (1,400,000 / 26.5, rounded).
    // Expense $30k → surplus ≈ $22,830 deposited into brokerage.
    const iraBalance = 1_400_000;
    const expectedRmd = Math.round(iraBalance / 26.5);
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'brok']);
    const out = simulateDrawdown({
      portfolioAtRetirement: iraBalance + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 30_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: iraBalance, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'brok', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    const iraWd = yr.accountBalances?.get('ira')?.withdrawn ?? 0;
    const brokDeposit = yr.accountBalances?.get('brok')?.deposit ?? 0;
    const brokWd = yr.accountBalances?.get('brok')?.withdrawn ?? 0;
    expect(iraWd).toBeCloseTo(expectedRmd, -1);
    // Surplus = forced - net need = expectedRmd - 30_000
    expect(brokDeposit).toBeCloseTo(expectedRmd - 30_000, -1);
    expect(brokWd).toBeCloseTo(0, 0);
    expect(yr.rmdOverflowToCashCents).toBeUndefined();
  });

  it('RMD surplus with NO POST_TAX-non-Roth account → rmdOverflowToCashCents surfaces overflow', () => {
    // Same IRA setup; Roth as the only post account. Surplus has nowhere
    // to land → overflows to cash.
    const iraBalance = 1_400_000;
    const expectedRmd = Math.round(iraBalance / 26.5);
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'roth']);
    const out = simulateDrawdown({
      portfolioAtRetirement: iraBalance + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 30_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: iraBalance, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'roth', initialPost: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    const expectedSurplus = expectedRmd - 30_000;
    // Tolerance ±$1 (100 cents) — the engine's per-cent RMD divisor
    // arithmetic differs from `Math.round(balance/divisor)` by a few cents.
    expect(yr.rmdOverflowToCashCents ?? 0).toBeGreaterThan(expectedSurplus * 100 - 100);
    expect(yr.rmdOverflowToCashCents ?? 0).toBeLessThan(expectedSurplus * 100 + 100);
  });

  it('RMD floor applies in deathYear and stops the year after', () => {
    // Owner born 1957 → trigger age reached well before 2030. deathYear =
    // 2031: the floor must engage in 2030 AND 2031 (alive through Dec 31
    // of deathYear) and disengage in 2032.
    const iraBalance = 1_400_000;
    const base = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'brok']);
    const ctxRmd = {
      ...base,
      ownerMeta: new Map([
        ['owner-1', { isoBirthdate: ownerIsoBirthdate, deathYear: 2031 }],
      ]),
    };
    const firstYear = 2030;
    const lastYear = 2032;
    const out = simulateDrawdown({
      portfolioAtRetirement: iraBalance + 500_000,
      ratePct: 0,
      expensesByMonth: uniform(firstYear, lastYear, 30_000 / 12),
      incomeByMonth: zeros(firstYear, lastYear),
      depositsByMonth: zeros(firstYear, lastYear),
      retirementYear: firstYear,
      horizonYear: lastYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: iraBalance, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, firstYear, lastYear),
        makeAccount({ id: 'brok', initialPost: 500_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, firstYear, lastYear),
      ],
      rmdContext: ctxRmd,
    });
    const iraWd = (i: number) => out.years[i].accountBalances?.get('ira')?.withdrawn ?? 0;
    // 2030 + 2031 (= deathYear): forced RMD ≫ the $30k spending need.
    expect(iraWd(0)).toBeGreaterThan(40_000);
    expect(iraWd(1)).toBeGreaterThan(40_000);
    // 2032 (= deathYear + 1): RMD gate off → only the $30k need is drawn,
    // routed POST_TAX-first by taxEfficient, so the IRA isn't forced.
    expect(iraWd(2)).toBeLessThan(40_000);
  });

  it('spending need ≥ RMD floor → strategy still draws full need; PRE_TAX forced to RMD floor', () => {
    // IRA $1.4M → RMD ≈ $52,830. Expense $80k > RMD.
    // taxEfficient: forced $52,830 PRE first; remaining $27,170 from POST.
    const iraBalance = 1_400_000;
    const expectedRmd = Math.round(iraBalance / 26.5);
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'brok']);
    const out = simulateDrawdown({
      portfolioAtRetirement: iraBalance + 100_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 80_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: iraBalance, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'brok', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    const brokWd = yr.accountBalances?.get('brok')?.withdrawn ?? 0;
    const iraWd = yr.accountBalances?.get('ira')?.withdrawn ?? 0;
    expect(iraWd).toBeCloseTo(expectedRmd, -1);
    expect(brokWd).toBeCloseTo(80_000 - expectedRmd, -1);
    expect(yr.accountBalances?.get('brok')?.deposit ?? 0).toBeCloseTo(0, 0);
    expect(yr.rmdOverflowToCashCents).toBeUndefined();
  });

  it('HSA + IRA — RMD only draws from IRA (HSA is not RMD-qualifying)', () => {
    // HSA is PRE_TAX-treated but NOT a qualifying RMD account type
    // (per `isQualifyingAccount`). The pre-pass must skip it entirely.
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'hsa', 'brok']);
    const out = simulateDrawdown({
      portfolioAtRetirement: 1_500_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 20_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: 1_000_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'hsa', initialPre: 400_000, taxTreatment: 'PRE_TAX', accountType: 'HSA' }, retirementYear, horizonYear),
        makeAccount({ id: 'brok', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    const hsaBal = yr.accountBalances?.get('hsa')?.balance ?? 0;
    // HSA balance untouched by the RMD pre-pass (taxEfficient won't draw
    // from PRE-treated accounts when brokerage covers the $20k need).
    expect(hsaBal).toBeCloseTo(400_000, 0);
    expect(yr.accountBalances?.get('hsa')?.withdrawn ?? 0).toBeCloseTo(0, 0);
  });

  it('year-1 RMD floor uses year-0 END balance (not retirement-start)', () => {
    // Two-year window. Year-0 large pre-tax withdrawal lowers year-1 RMD
    // basis. Owner born 1957 → age 73 in 2030, age 74 in 2031.
    // Age 74 divisor = 25.5. Year-1 RMD basis = year-0 Dec-31 IRA balance.
    //
    // Year-0: net need $100k → taxEfficient drains brokerage $200k first.
    // Strategy after brokerage exhaustion (3-month horizon assumption broken
    // here — keep small balances). Use larger setup:
    // IRA $1M (PRE), brokerage $300k (POST). Expense $100k/yr × 2 yrs.
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'brok']);
    const out = simulateDrawdown({
      portfolioAtRetirement: 1_300_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, retirementYear + 1, 100_000 / 12),
      incomeByMonth: zeros(retirementYear, retirementYear + 1),
      depositsByMonth: zeros(retirementYear, retirementYear + 1),
      retirementYear,
      horizonYear: retirementYear + 1,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: 1_000_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, retirementYear + 1),
        makeAccount({ id: 'brok', initialPost: 300_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, retirementYear + 1),
      ],
      rmdContext: ctxRmd,
    });
    // Year-0 floor: $1M / 26.5 = $37,735. Year-0 IRA after RMD = $962,265.
    // Year-1 floor: $962,265 / 25.5 = $37,736 (basis = year-0 end balance).
    // If buggy (year-0 balance for every year): year-1 floor would be $1M / 25.5 = $39,216.
    const year0IraBalEnd = out.years[0].accountBalances?.get('ira')?.balance ?? 0;
    const year1IraWd = out.years[1].accountBalances?.get('ira')?.withdrawn ?? 0;
    const expectedYear1Floor = year0IraBalEnd / 25.5;
    expect(year1IraWd).toBeGreaterThan(expectedYear1Floor - 50);
    expect(year1IraWd).toBeLessThan(expectedYear1Floor + 50);
    // Sanity: year-1 floor strictly less than the buggy "year-0 retirement balance" value.
    const buggyYear1Floor = 1_000_000 / 25.5;
    expect(year1IraWd).toBeLessThan(buggyYear1Floor - 50);
  });

  it('per-owner scoping — primary RMD does not drain secondary\'s account', () => {
    // Primary owner born 1957 → age 73 in 2030. Secondary owner born 1965 →
    // age 65 in 2030 (below trigger). Two IRAs: primary's $1.4M and
    // secondary's $1.4M. Only the primary's should be touched by the
    // forced RMD pre-pass.
    const ownerByAccountId = new Map<string, string>();
    ownerByAccountId.set('ira-primary', 'owner-primary');
    ownerByAccountId.set('ira-secondary', 'owner-secondary');
    ownerByAccountId.set('brok', 'owner-primary');
    const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
    ownerMeta.set('owner-primary', { isoBirthdate: '1957-06-15', deathYear: 9999 });
    ownerMeta.set('owner-secondary', { isoBirthdate: '1965-06-15', deathYear: 9999 });
    const ctxRmd: RmdContextInput = { ownerByAccountId, ownerMeta, rmdSnapshot: RMD_DIVISORS };
    const out = simulateDrawdown({
      portfolioAtRetirement: 2_900_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 20_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira-primary', initialPre: 1_400_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'ira-secondary', initialPre: 1_400_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'brok', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    const primIraBal = yr.accountBalances?.get('ira-primary')?.balance ?? 0;
    const secIraBal = yr.accountBalances?.get('ira-secondary')?.balance ?? 0;
    // Secondary's IRA untouched (taxEfficient draws brokerage; primary's
    // IRA forced by RMD).
    expect(secIraBal).toBeCloseTo(1_400_000, 0);
    // Primary's IRA drawn by ~$52,830 (RMD).
    expect(primIraBal).toBeLessThan(1_400_000 - 50_000);
  });

  it('MIXED account with Roth portion → RMD basis excludes the Roth bucket', () => {
    // MIXED account: $100k pre + $50k post (Roth-designated). RMD basis
    // should be $100k, not $150k. At age 73 divisor 26.5, RMD ≈ $3,774.
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['mixed-401k']);
    const expectedRmd = Math.round(100_000 / 26.5);
    const overstatedRmd = Math.round(150_000 / 26.5);
    const out = simulateDrawdown({
      portfolioAtRetirement: 150_000,
      ratePct: 0,
      expensesByMonth: zeros(retirementYear, horizonYear), // zero expense → forced draw = full RMD
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({
          id: 'mixed-401k',
          initialPre: 100_000,
          initialPost: 50_000,
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
        }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const wd = out.years[0].accountBalances?.get('mixed-401k')?.withdrawn ?? 0;
    // Tolerance large enough to ignore allocateProportional rounding,
    // tight enough to distinguish $3,774 from $5,660.
    expect(wd).toBeCloseTo(expectedRmd, -2);
    expect(Math.abs(wd - overstatedRmd)).toBeGreaterThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// MissingCustomDrawdownOrderError — guard fires before year loop
// ---------------------------------------------------------------------------

describe('MissingCustomDrawdownOrderError', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('should_throw_MissingCustomDrawdownOrderError_when_customOrder_has_no_layout', () => {
    // `customOrder` strategy with no `customDrawdownOrder` on the input
    // must throw before the year loop, not silently produce bad output.
    const input: DrawdownInput = {
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12).fill(1_000) },
      incomeByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'customOrder' },
      accounts: [
        {
          id: 'ira',
          initialPre: 100_000,
          initialPost: 0,
          annualRatePct: 0,
          taxTreatment: 'PRE_TAX',
          accountType: 'RETIREMENT_IRA',
          depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
        },
      ],
    };
    expect(() => simulateDrawdown(input)).toThrow(MissingCustomDrawdownOrderError);
  });

  it('should_not_throw_when_customOrder_has_a_layout', () => {
    // Same setup with a valid `customDrawdownOrder` — no throw.
    const input: DrawdownInput = {
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12).fill(1_000) },
      incomeByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'customOrder' },
      customDrawdownOrder: { tiers: [['ira']], excludedAccountIds: [] },
      accounts: [
        {
          id: 'ira',
          initialPre: 100_000,
          initialPost: 0,
          annualRatePct: 0,
          taxTreatment: 'PRE_TAX',
          accountType: 'RETIREMENT_IRA',
          depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
        },
      ],
    };
    expect(() => simulateDrawdown(input)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MAGI cap orthogonal to preset strategy kind
// ---------------------------------------------------------------------------

describe('MAGI cap applied to preset strategy', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('should_respect_magiCap_when_strategy_is_taxEfficient', () => {
    // taxEfficient: would normally draw from POST_TAX (brokerage) tier 0
    // first. With a MAGI cap that limits pre-tax to $5k/yr and no later
    // taxable tier redirect, the cap engages on the PRE_TAX tier when the
    // engine reaches it.
    //
    // Setup: tier order — POST_TAX brokerage first (taxEfficient), then
    // PRE_TAX IRA. Expense $8k/yr. Cap $5k/yr on pre-tax.
    // Expected: brokerage covers $8k outright (no cap impact — post-tax tier
    // is hit first and the cap is per-pre-tax, not per-post-tax). Year-1 the
    // brokerage is exhausted; IRA draws $5k under cap + breach $3k if no
    // taxable redirect. This test exercises cap-code path activation.
    //
    // Simpler verifiable case: POST_TAX $3k only, PRE_TAX $100k, cap $5k.
    // Expense $8k/yr (1 year).
    // Month-by-month: brokerage $3k covers first $3k, IRA covers remaining $5k.
    // Cap budget $5k → IRA draws exactly $5k → no breach (fits within cap).
    const input: DrawdownInput = {
      portfolioAtRetirement: 103_000,
      ratePct: 0,
      expensesByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12).fill(8_000 / 12) },
      incomeByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, magiCeilingAnnualDollars: 5_000, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
      accounts: [
        {
          id: 'brok',
          initialPre: 0,
          initialPost: 3_000,
          annualRatePct: 0,
          taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE',
          depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
        },
        {
          id: 'ira',
          initialPre: 100_000,
          initialPost: 0,
          annualRatePct: 0,
          taxTreatment: 'PRE_TAX',
          accountType: 'RETIREMENT_IRA',
          depositsByMonth: { startYear: retirementYear, startMonthIndex: 0, values: new Float64Array(12) },
        },
      ],
    };
    const out = simulateDrawdown(input);
    // Total withdrawn = $8k (covers full expense).
    expect(out.years[0].withdrawn).toBeCloseTo(8_000, 0);
    // Brokerage draws $3k (tier 0 exhausted).
    expect(out.years[0].accountBalances?.get('brok')?.withdrawn ?? 0).toBeCloseTo(3_000, 0);
    // IRA draws remaining $5k — exactly at cap limit, no breach.
    expect(out.years[0].accountBalances?.get('ira')?.withdrawn ?? 0).toBeCloseTo(5_000, 0);
  });
});

// ---------------------------------------------------------------------------
// RMD pre-pass forces pre-tax above MAGI cap → breach recorded
// ---------------------------------------------------------------------------

describe('RMD-forced pre-tax above MAGI cap records magiCapBreachDollars', () => {
  // Owner born 1957 → age 73 in 2030 → RMD divisor 26.5.
  // IRA balance = 30k × 26.5 + 10k × 26.5 = 1,060,000 → RMD ≈ 40k.
  // MAGI cap 30k/yr. RMD forces 40k pre-tax → 10k over cap.
  // Expected: magiCapBreachDollars ≈ 10k, cap remaining after pre-pass = 0.
  const retirementYear = 2030;
  const horizonYear = 2030;
  const ownerIsoBirthdate = '1957-06-15';
  // IRA balance that yields RMD ≈ $40k (40_000 × 26.5 = 1_060_000).
  const iraBalance = 1_060_000;
  const capDollars = 30_000;

  it('should_record_magiCapBreachDollars_when_rmd_floor_exceeds_cap', () => {
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira']);
    const expense = 40_000; // Same as RMD — pre-pass covers the full need.
    const out = simulateDrawdown({
      portfolioAtRetirement: iraBalance,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, expense / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      magiCapWindows: singleMagiCapWindow(
        { start: { kind: 'retirementStart' }, end: { kind: 'age', memberId: 'primary', years: 65, months: 0 }, magiCeilingAnnualDollars: capDollars, capMode: 'minimize', capMagiLine: 'irmaa' },
        9999,
      ),
      accounts: [
        makeAccount(
          {
            id: 'ira',
            initialPre: iraBalance,
            taxTreatment: 'PRE_TAX',
            accountType: 'RETIREMENT_IRA',
          },
          retirementYear,
          horizonYear,
        ),
      ],
      rmdContext: ctxRmd,
    });

    const yr = out.years[0];
    // RMD pre-pass forces ≈ $40k pre-tax (the full net need).
    // Breach = forced pre-tax ($40k) − cap ($30k) ≈ $10k.
    // Pre-fix: magiCapBreachDollars was undefined (breach never recorded
    // for the RMD pre-pass path).
    expect(yr.magiCapBreachDollars).toBeDefined();
    expect(yr.magiCapBreachDollars).toBeGreaterThan(9_000);
    expect(yr.magiCapBreachDollars).toBeLessThan(11_000);
  });
});

// ---------------------------------------------------------------------------
// RMD floor basis = drawable pre-tax sub-bucket only + targeted-deposit
// bucket routing by destination treatment. Regression for the Delayed-demo
// false RMD shortfall.
// ---------------------------------------------------------------------------

/** A single targeted deposit of `amount` in the first month of the window. */
function depositInFirstMonth(
  startYear: number,
  horizonYear: number,
  amount: number,
): MonthlyCashflowSeries {
  const series = zeros(startYear, horizonYear);
  series.values[0] = amount;
  return series;
}

describe('RMD floor counts only the drawable pre-tax pocket', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;
  // Owner born 1957 → age 73 in 2030 → trigger fires; divisor 26.5.
  const ownerIsoBirthdate = '1957-06-15';

  it('does not force a required withdrawal from after-tax dollars an account cannot use for RMD', () => {
    // A qualifying PRE_TAX IRA with NO pre-tax dollars left ($0 pre) but a
    // large after-tax (`post`) balance must NOT be force-drawn for an RMD —
    // forced RMD can only draw `pre`. Pre-fix the floor was built on
    // `pre + post`, forcing a draw the engine then could not satisfy from pre
    // (a phantom shortfall). The brokerage covers the $20k spend, so taxEfficient
    // never touches the IRA, and its post bucket stays whole.
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira', 'brok']);
    const out = simulateDrawdown({
      portfolioAtRetirement: 600_000,
      ratePct: 0,
      expensesByMonth: uniform(retirementYear, horizonYear, 20_000 / 12),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: 0, initialPost: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
        makeAccount({ id: 'brok', initialPost: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const yr = out.years[0];
    // No pre-tax dollars → no forced RMD draw from the IRA at all; its $500k
    // after-tax bucket is preserved and the $20k need is met from the brokerage.
    expect(yr.accountBalances?.get('ira')?.withdrawn ?? 0).toBeCloseTo(0, 0);
    expect(yr.accountBalances?.get('ira')?.postEnd ?? 0).toBeCloseTo(500_000, 0);
    expect(yr.accountBalances?.get('brok')?.withdrawn ?? 0).toBeCloseTo(20_000, 0);
  });

  it('forces only what the pre-tax pocket can supply, never the after-tax pocket', () => {
    // A qualifying PRE_TAX IRA with a small pre-tax pocket and a large after-tax
    // bucket: the forced RMD draws ONLY the pre-tax pocket's share (pre / 26.5),
    // never reaching into the $500k after-tax bucket. Spend $0 so only the
    // forced RMD draws. With the fix the floor = pre / 26.5 (fully drawable), so
    // no phantom shortfall and the post bucket is untouched.
    const ctxRmd = makeSingleOwnerRmdContext('owner-1', ownerIsoBirthdate, ['ira']);
    const preBucket = 26_500; // floor = 26_500 / 26.5 = exactly $1,000.
    const out = simulateDrawdown({
      portfolioAtRetirement: preBucket + 500_000,
      ratePct: 0,
      expensesByMonth: zeros(retirementYear, horizonYear),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        makeAccount({ id: 'ira', initialPre: preBucket, initialPost: 500_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
      ],
      rmdContext: ctxRmd,
    });
    const ira = out.years[0].accountBalances?.get('ira');
    // Forced RMD = pre / 26.5 = $1,000 (drawn from the pre-tax pocket only).
    // It surfaces as a deposit-back surplus, but the WITHDRAWN figure is the
    // forced draw — capped at the pre pocket, never the $500k after-tax bucket.
    expect(ira?.withdrawn ?? 0).toBeCloseTo(1_000, 0);
    // The $500k after-tax bucket is never tapped by the forced RMD.
    expect(ira?.postEnd ?? 0).toBeGreaterThanOrEqual(500_000);
  });
});

describe('targeted deposits land in the bucket matching the destination account', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('a rollover into a pre-tax retirement account is held as pre-tax money', () => {
    // Targeted deposit of $50k into a PRE_TAX IRA → increases the account's
    // pre-tax pocket, not the after-tax pocket.
    const out = simulateDrawdown({
      portfolioAtRetirement: 100_000,
      ratePct: 0,
      expensesByMonth: zeros(retirementYear, horizonYear),
      incomeByMonth: zeros(retirementYear, horizonYear),
      depositsByMonth: zeros(retirementYear, horizonYear),
      retirementYear,
      horizonYear,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        {
          ...makeAccount({ id: 'ira', initialPre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }, retirementYear, horizonYear),
          depositsByMonth: depositInFirstMonth(retirementYear, horizonYear, 50_000),
        },
      ],
    });
    const acct = out.years[0].accountBalances?.get('ira');
    expect(acct?.deposit ?? 0).toBeCloseTo(50_000, 0);
    expect(acct?.preEnd ?? 0).toBeCloseTo(150_000, 0);
    expect(acct?.postEnd ?? 0).toBeCloseTo(0, 0);
  });
});
