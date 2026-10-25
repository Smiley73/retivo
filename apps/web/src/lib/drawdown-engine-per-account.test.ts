/** Unit tests for the per-account drawdown branch in `drawdown-engine-per-account.ts`. */
import { describe, it, expect } from 'vitest';
import { MissingCustomDrawdownOrderError } from './drawdown-engine-per-account';
import { singleMagiCapWindow } from './drawdown-engine-per-account-magi-cap';
import { simulateDrawdown } from './drawdown-engine';
import type { DrawdownAccountInput, DrawdownInput } from './drawdown-engine-types';
import type { MonthlyCashflowSeries } from './monthly-cashflow';

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

describe('withdrawal-order redistribution', () => {
  const retirementYear = 2030;
  const horizonYear = 2034;

  function expense5k() {
    return uniform(retirementYear, horizonYear, 5_000 / 12);
  }

  it('proportional strategy: per-account withdrawn is proportional to balance', () => {
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
    const yr0 = out.years[0];
    const preWithdrawn = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const postWithdrawn = yr0.accountBalances?.get('post')?.withdrawn ?? 0;
    expect(Math.abs(preWithdrawn - postWithdrawn)).toBeLessThan(10); // within $10
  });

  it('proportional MIXED account: preWithdrawnCents + postWithdrawnCents are populated (v48 kernel fix)', () => {
    // Proportional draw on a MIXED 401k ($60k pre, $40k post): the pre/post split must be defined and sum to the cents
    // withdrawn (within 1 cent).
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
    const withdrawnCents = Math.round(row!.withdrawn * 100);
    const splitSum = (row!.preWithdrawnCents ?? 0) + (row!.postWithdrawnCents ?? 0);
    expect(Math.abs(splitSum - withdrawnCents)).toBeLessThanOrEqual(1);
  });

  it('proportional MIXED account: pre-tax share is proportional to pre/post balance ratio', () => {
    // $60k pre / $40k post gives a pre ratio of 0.6; the $5k/yr expense draws about $3k from pre.
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
    const ratio = preWithdrawnDollars / totalWithdrawn;
    expect(ratio).toBeGreaterThan(0.58);
    expect(ratio).toBeLessThan(0.62);
  });

  it('proportional PRE_TAX account: preWithdrawnCents is defined and equals withdrawn*100', () => {
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
    // HSA $40k beside a MIXED 401k ($60k pre, $40k post) takes the two-pass path (drawHsaPass + distributeNonHsaWithdrawal),
    // within 1-cent rounding: the HSA row is all post, and the MIXED row's pre + post equals its withdrawal.
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
    expect(hsaRow!.preWithdrawnCents ?? 0).toBe(0);
    const hsaWithdrawnCents = Math.round(hsaRow!.withdrawn * 100);
    if (hsaRow!.withdrawn > 0) {
      expect(Math.abs((hsaRow!.postWithdrawnCents ?? 0) - hsaWithdrawnCents)).toBeLessThanOrEqual(1);
    }
    const mixWithdrawnCents = Math.round(mixRow!.withdrawn * 100);
    const mixSplitSum = (mixRow!.preWithdrawnCents ?? 0) + (mixRow!.postWithdrawnCents ?? 0);
    expect(Math.abs(mixSplitSum - mixWithdrawnCents)).toBeLessThanOrEqual(1);
  });

  it('taxEfficient: POST_TAX depleted before PRE_TAX', () => {
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
    const yr0 = out.years[0];
    const preWd = yr0.accountBalances?.get('pre')?.withdrawn ?? 0;
    const postWd = yr0.accountBalances?.get('post')?.withdrawn ?? 0;
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
    // 3:1 PRE_TAX:POST_TAX gives a 75%/25% split.
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
    for (const yr of out.years) {
      const ira1 = yr.accountBalances?.get('ira1')?.withdrawn ?? 0;
      const ira2 = yr.accountBalances?.get('ira2')?.withdrawn ?? 0;
      expect(ira1 + ira2).toBeCloseTo(yr.withdrawn, 1);
    }
  });

  it('strategy choice DIVERGES per-account balance trajectories across multi-year drawdown', () => {
    // Strategy-awareness lives inside the engine, not in a label-only post-pass: taxEfficient and proportional must produce
    // different per-account series while the aggregate balance and withdrawn totals stay identical.
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
    for (let y = 0; y < efficient.years.length; y += 1) {
      expect(efficient.years[y].balance).toBeCloseTo(proportional.years[y].balance, 1);
      expect(efficient.years[y].withdrawn).toBeCloseTo(proportional.years[y].withdrawn, 1);
    }
    const effPostY0 = efficient.years[0].accountBalances?.get('post')?.balance ?? 0;
    const propPostY0 = proportional.years[0].accountBalances?.get('post')?.balance ?? 0;
    const effPreY0 = efficient.years[0].accountBalances?.get('pre')?.balance ?? 0;
    const propPreY0 = proportional.years[0].accountBalances?.get('pre')?.balance ?? 0;
    // taxEfficient: POST drained $5k, ends at $95k. proportional: POST drained $2.5k, ends at $97.5k.
    expect(effPostY0).toBeLessThan(propPostY0 - 1000);
    expect(effPreY0).toBeGreaterThan(propPreY0 + 1000);
  });

  it('taxEfficient PRESERVES Roth longest under multi-year drawdown', () => {
    // PRE $100k + Roth $100k + POST $100k, $30k/yr for 5 years: taxEfficient drains POST first and leaves Roth untouched
    // through year 5; rothFirst empties Roth by year 4.
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
    const efficientLastRoth = efficient.years[4].accountBalances?.get('roth')?.balance ?? -1;
    expect(efficientLastRoth).toBeCloseTo(100_000, 0);
    const rothLastRoth = roth.years[3].accountBalances?.get('roth')?.balance ?? -1;
    expect(rothLastRoth).toBeLessThan(5_000);
  });

  it('HSA drawn STRICTLY after Roth — Roth exhausted before any HSA dollar', () => {
    // Roth and HSA both sit in the preserved tail, with HSA in its own final tier, so Roth must be fully depleted before any
    // HSA withdrawal.
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
      const y0Hsa = out.years[0].accountBalances?.get('hsa');
      expect(y0Hsa?.withdrawn ?? 0).toBeCloseTo(0, 0);
      expect(y0Hsa?.balance ?? 0).toBeCloseTo(50_000, 0);
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

import { RMD_DIVISORS } from './rmd-divisors';
import type { RmdContextInput } from './drawdown-engine-types';

function makeSingleOwnerRmdContext(
  ownerId: string,
  isoBirthdate: string,
  accountIds: ReadonlyArray<string>,
): RmdContextInput {
  const ownerByAccountId = new Map<string, string>();
  for (const id of accountIds) ownerByAccountId.set(id, ownerId);
  const ownerMeta = new Map<string, { isoBirthdate: string; deathYear: number }>();
  // Death year far in the future so the alive gate never fires.
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
  // Born 1957: age 73 in 2030 triggers the RMD; divisor 26.5.
  const ownerIsoBirthdate = '1957-06-15';

  it('spending need < RMD floor → engine forces extra PRE_TAX; surplus credits POST_TAX deposit', () => {
    // IRA $1.4M → RMD ≈ $52,830 (1,400,000 / 26.5); a $30k expense deposits the ≈ $22,830 surplus into the brokerage.
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
    expect(brokDeposit).toBeCloseTo(expectedRmd - 30_000, -1);
    expect(brokWd).toBeCloseTo(0, 0);
    expect(yr.rmdOverflowToCashCents).toBeUndefined();
  });

  it('RMD surplus with NO POST_TAX-non-Roth account → rmdOverflowToCashCents surfaces overflow', () => {
    // Roth as the only post account: the surplus has nowhere to land and overflows to cash.
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
    // ±$1: the engine's per-cent divisor arithmetic differs from Math.round(balance/divisor) by a few cents.
    expect(yr.rmdOverflowToCashCents ?? 0).toBeGreaterThan(expectedSurplus * 100 - 100);
    expect(yr.rmdOverflowToCashCents ?? 0).toBeLessThan(expectedSurplus * 100 + 100);
  });

  it('RMD floor applies in deathYear and stops the year after', () => {
    // deathYear = 2031: the floor engages in 2030 and 2031 (alive through Dec 31 of deathYear) and disengages in 2032.
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
    expect(iraWd(0)).toBeGreaterThan(40_000);
    expect(iraWd(1)).toBeGreaterThan(40_000);
    expect(iraWd(2)).toBeLessThan(40_000);
  });

  it('spending need ≥ RMD floor → strategy still draws full need; PRE_TAX forced to RMD floor', () => {
    // IRA $1.4M → RMD ≈ $52,830 on an $80k expense: taxEfficient forces the $52,830 from PRE first, the remaining $27,170 from
    // POST.
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
    // HSA is PRE_TAX-treated but not a qualifying RMD account type (isQualifyingAccount), so the pre-pass skips it.
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
    expect(hsaBal).toBeCloseTo(400_000, 0);
    expect(yr.accountBalances?.get('hsa')?.withdrawn ?? 0).toBeCloseTo(0, 0);
  });

  it('year-1 RMD floor uses year-0 END balance (not retirement-start)', () => {
    // Year 1's RMD basis is the year-0 Dec-31 IRA balance: IRA $1M, brokerage $300k, $100k/yr for 2 years; age 74 divisor 25.5.
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
    // Year-0 floor: $1M / 26.5 = $37,735, leaving $962,265; year-1 floor: $962,265 / 25.5 = $37,736 (a year-0 retirement-balance
    // basis would give $39,216).
    const year0IraBalEnd = out.years[0].accountBalances?.get('ira')?.balance ?? 0;
    const year1IraWd = out.years[1].accountBalances?.get('ira')?.withdrawn ?? 0;
    const expectedYear1Floor = year0IraBalEnd / 25.5;
    expect(year1IraWd).toBeGreaterThan(expectedYear1Floor - 50);
    expect(year1IraWd).toBeLessThan(expectedYear1Floor + 50);
    const buggyYear1Floor = 1_000_000 / 25.5;
    expect(year1IraWd).toBeLessThan(buggyYear1Floor - 50);
  });

  it('per-owner scoping — primary RMD does not drain secondary\'s account', () => {
    // Primary (born 1957) is 73 in 2030; secondary (born 1965) is 65, below trigger. Only the primary's IRA is touched by the
    // forced RMD.
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
    expect(secIraBal).toBeCloseTo(1_400_000, 0);
    expect(primIraBal).toBeLessThan(1_400_000 - 50_000);
  });

  it('MIXED account with Roth portion → RMD basis excludes the Roth bucket', () => {
    // MIXED account $100k pre + $50k post (Roth-designated): the RMD basis is $100k, not $150k; at divisor 26.5 the RMD is
    // ≈ $3,774.
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
    // Tolerance ignores allocateProportional rounding but still separates $3,774 from $5,660.
    expect(wd).toBeCloseTo(expectedRmd, -2);
    expect(Math.abs(wd - overstatedRmd)).toBeGreaterThan(1_000);
  });
});

describe('MissingCustomDrawdownOrderError', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('should_throw_MissingCustomDrawdownOrderError_when_customOrder_has_no_layout', () => {
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

describe('MAGI cap applied to preset strategy', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('should_respect_magiCap_when_strategy_is_taxEfficient', () => {
    // taxEfficient draws POST_TAX tier 0 first, so the pre-tax cap does not bind on it: a $3k brokerage and a $100k IRA with a
    // $5k pre-tax cap and an $8k expense draw $3k from the brokerage and exactly $5k from the IRA, within the cap.
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
    expect(out.years[0].withdrawn).toBeCloseTo(8_000, 0);
    expect(out.years[0].accountBalances?.get('brok')?.withdrawn ?? 0).toBeCloseTo(3_000, 0);
    expect(out.years[0].accountBalances?.get('ira')?.withdrawn ?? 0).toBeCloseTo(5_000, 0);
  });
});

describe('RMD-forced pre-tax above MAGI cap records magiCapBreachDollars', () => {
  // Born 1957 is 73 in 2030 (divisor 26.5): a $1,060,000 IRA forces a ≈ $40k RMD against a $30k cap, so ≈ $10k breaches.
  const retirementYear = 2030;
  const horizonYear = 2030;
  const ownerIsoBirthdate = '1957-06-15';
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
    // Breach = forced pre-tax ($40k) − cap ($30k) ≈ $10k, recorded for the RMD pre-pass path.
    expect(yr.magiCapBreachDollars).toBeDefined();
    expect(yr.magiCapBreachDollars).toBeGreaterThan(9_000);
    expect(yr.magiCapBreachDollars).toBeLessThan(11_000);
  });
});

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
  const ownerIsoBirthdate = '1957-06-15';

  it('does not force a required withdrawal from after-tax dollars an account cannot use for RMD', () => {
    // A qualifying IRA with $0 pre but a large after-tax balance must not be force-drawn for an RMD (the floor can only draw
    // pre); the brokerage covers the $20k spend and the IRA's post bucket stays whole.
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
    expect(yr.accountBalances?.get('ira')?.withdrawn ?? 0).toBeCloseTo(0, 0);
    expect(yr.accountBalances?.get('ira')?.postEnd ?? 0).toBeCloseTo(500_000, 0);
    expect(yr.accountBalances?.get('brok')?.withdrawn ?? 0).toBeCloseTo(20_000, 0);
  });

  it('forces only what the pre-tax pocket can supply, never the after-tax pocket', () => {
    // A small pre-tax pocket beside a $500k after-tax bucket: the forced RMD draws only pre / 26.5, never the after-tax bucket;
    // spend $0 so only the forced RMD draws.
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
    // Forced RMD = 26_500 / 26.5 = $1,000, from the pre-tax pocket only.
    expect(ira?.withdrawn ?? 0).toBeCloseTo(1_000, 0);
    expect(ira?.postEnd ?? 0).toBeGreaterThanOrEqual(500_000);
  });
});

describe('targeted deposits land in the bucket matching the destination account', () => {
  const retirementYear = 2030;
  const horizonYear = 2030;

  it('a rollover into a pre-tax retirement account is held as pre-tax money', () => {
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
