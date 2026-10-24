import { describe, expect, it } from 'vitest';
import {
  buildIncomeContext,
  collectPostRetirementPlainPensionPlacements,
  collectTargetedDepositEvents,
  projectIncomeByMonth,
  projectIncomeByYear,
} from './income-projection';
import type { ResolvedIncomeStream } from './income-resolution';
import type {
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';

const memberAgg = (
  id: string,
  payload: Partial<HouseholdMemberPayload> & { birthdate: string; isPrimary: boolean },
): Aggregate<HouseholdMemberPayload> => ({
  id,
  householdId: 'h',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deviceId: 'd',
  aggregateType: 'householdMember',
  payload: {
    firstName: 'Test',
    lastName: 'Member',
    email: 'test@example.com',
    ...payload,
  },
});

const stream = (
  id: string,
  payload: IncomeStreamPayload,
): ResolvedIncomeStream => ({
  id,
  source: 'canonical' as const,
  payload,
});

const ctxOf = (overrides: { retirementMonth0?: number } = {}) => {
  // Both members retire in 2030; `retirementMonth0` propagates per member when overridden.
  const dateByMember = new Map<string, { year: number; month0?: number }>([
    ['p', { year: 2030, month0: overrides.retirementMonth0 }],
    ['s', { year: 2030, month0: overrides.retirementMonth0 }],
  ]);
  return {
    ...buildIncomeContext(
      [
        memberAgg('p', { birthdate: '1965-03-12', isPrimary: true }),
        memberAgg('s', { birthdate: '1965-06-15', isPrimary: false }),
      ],
      {
        retirementStartYear: 2030,
        lifeExpectancyPrimary: 90,
        lifeExpectancySecondary: 92,
        retirementDateByMember: dateByMember,
      },
    ),
    retirementMonth0: overrides.retirementMonth0,
  };
};

describe('projectIncomeByMonth — pension annuity', () => {
  it('starts on the owner\'s birthday-month of the start age year', () => {
    const p = stream('pen', {
      name: 'Co Pension',
      kind: 'pension',
      payoutType: 'annuity',
      memberId: 'p',
      monthlyBenefit: 1000,
      start: { kind: 'age', years: 65, months: 0 },
      colaPct: 0,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2029, to: 2030 });
    expect(out.find((r) => r.year === 2029 && r.month0 === 11)!.pensionIncome).toBe(0);
    expect(out.find((r) => r.year === 2030 && r.month0 === 0)!.pensionIncome).toBe(0);
    expect(out.find((r) => r.year === 2030 && r.month0 === 1)!.pensionIncome).toBe(0);
    for (let m = 2; m < 12; m += 1) {
      expect(
        out.find((r) => r.year === 2030 && r.month0 === m)!.pensionIncome,
      ).toBeCloseTo(12000, 2);
    }
  });

  it('J&S survivor reduction kicks in Jan of the year after the pensioner dies', () => {
    // Death is Dec 31 of the death year (born 1960, life 90): full pension through Dec 2050, J&S reduction from Jan 2051.
    const ctx = {
      ...buildIncomeContext(
        [
          memberAgg('p', { birthdate: '1960-03-15', isPrimary: true }),
          memberAgg('s', { birthdate: '1962-03-15', isPrimary: false }),
        ],
        {
          retirementStartYear: 2025,
          lifeExpectancyPrimary: 90,
          lifeExpectancySecondary: 95,
        },
      ),
    };
    const p = stream('pen', {
      name: 'P',
      kind: 'pension',
      payoutType: 'annuity',
      memberId: 'p',
      monthlyBenefit: 1000,
      start: { kind: 'age', years: 65, months: 0 },
      colaPct: 0,
      jointAndSurvivorPct: 50,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctx, { from: 2050, to: 2051 });
    for (let m = 0; m < 12; m++) {
      expect(
        out.find((r) => r.year === 2050 && r.month0 === m)!.pensionIncome,
      ).toBeCloseTo(12000, 2);
    }
    expect(
      out.find((r) => r.year === 2051 && r.month0 === 0)!.pensionIncome,
    ).toBeCloseTo(6000, 2);
  });
});

describe('projectIncomeByMonth — part-time', () => {
  it('age-anchored start fires on the resolved birthday month', () => {
    const p = stream('pt', {
      name: 'PT',
      kind: 'partTime',
      memberId: 'p',
      annualAmount: 24000,
      start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
      end: { kind: 'age', memberId: 'primary', years: 67, months: 0 },
      colaPct: 0,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2030, to: 2030 });
    expect(out[0].partTimeIncome).toBe(0);
    expect(out[1].partTimeIncome).toBe(0);
    for (let m = 2; m < 12; m += 1) {
      expect(out[m].partTimeIncome).toBe(24000);
    }
  });

  it('honors retirementMonth0 for retirementStart-anchored part-time', () => {
    const p = stream('pt', {
      name: 'PT',
      kind: 'partTime',
      memberId: 'p',
      annualAmount: 12000,
      start: { kind: 'retirementStart' },
      end: { kind: 'durationFromStart', months: 24 },
      colaPct: 0,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf({ retirementMonth0: 2 }), {
      from: 2030,
      to: 2030,
    });
    expect(out[0].partTimeIncome).toBe(0);
    expect(out[1].partTimeIncome).toBe(0);
    expect(out[2].partTimeIncome).toBe(12000);
    expect(out[11].partTimeIncome).toBe(12000);
  });
});

describe('projectIncomeByMonth — one-off', () => {
  it('windfall renders at literal amount for exactly one month', () => {
    const p = stream('w', {
      name: 'Windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 50000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2035, to: 2035 });
    expect(out[0].oneOffIncome).toBe(50000);
    expect(out[0].total).toBe(50000);
    for (let m = 1; m < 12; m += 1) {
      expect(out[m].oneOffIncome).toBe(0);
    }
  });

  it('pension lump sum renders on resolved birthday-month at literal amount', () => {
    const p = stream('lump', {
      name: 'CBP Lump',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100000,
      start: { kind: 'age', years: 65, months: 0 },
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2030, to: 2030 });
    expect(out[2].oneOffIncome).toBe(100000);
    expect(out[2].total).toBe(100000);
    for (let m = 0; m < 12; m += 1) {
      if (m === 2) continue;
      expect(out[m].oneOffIncome).toBe(0);
    }
  });
});

describe('owner-relative retirementStart', () => {
  it('resolves to the OWNER\'s retirement year on a secondary-owned stream', () => {
    // A secondary-owned partTime stream anchored at retirementStart fires at the secondary's retirement (2032), not the primary's (2028).
    const dateByMember = new Map<string, { year: number; month0?: number }>([
      ['p', { year: 2028, month0: 0 }],
      ['s', { year: 2032, month0: 0 }],
    ]);
    const ctx = buildIncomeContext(
      [
        memberAgg('p', { birthdate: '1963-01-15', isPrimary: true }),
        memberAgg('s', { birthdate: '1967-01-15', isPrimary: false }),
      ],
      {
        retirementStartYear: 2028,
        lifeExpectancyPrimary: 90,
        lifeExpectancySecondary: 92,
        retirementDateByMember: dateByMember,
      },
    );
    const p = stream('pt', {
      name: 'Spouse consulting',
      kind: 'partTime',
      memberId: 's',
      annualAmount: 24000,
      start: { kind: 'retirementStart' },
      end: { kind: 'durationFromStart', months: 24 },
      colaPct: 0,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctx, { from: 2028, to: 2032 });
    for (const y of [2028, 2029, 2030, 2031]) {
      expect(out.find((r) => r.year === y && r.month0 === 0)!.partTimeIncome).toBe(0);
    }
    expect(out.find((r) => r.year === 2032 && r.month0 === 0)!.partTimeIncome).toBe(
      24000,
    );
  });
});

describe('projectIncomeByMonth — fractionalYear', () => {
  it('= year + month0/12', () => {
    const out = projectIncomeByMonth([], ctxOf(), { from: 2030, to: 2030 });
    expect(out[0].fractionalYear).toBeCloseTo(2030, 6);
    expect(out[6].fractionalYear).toBeCloseTo(2030.5, 6);
    expect(out[11].fractionalYear).toBeCloseTo(2030 + 11 / 12, 6);
  });
});

// One-off and pension lump-sum amounts are today's dollars, inflated month-precise to the event month when the context supplies todayYear and inflationPct.
describe('one-off + lump-sum roll forward from today', () => {
  const ctxWithInflation = (rate: number, todayYear = 2026, todayMonthIndex = 0) => ({
    ...buildIncomeContext(
      [
        memberAgg('p', { birthdate: '1965-03-12', isPrimary: true }),
        memberAgg('s', { birthdate: '1965-06-15', isPrimary: false }),
      ],
      {
        retirementStartYear: 2030,
        lifeExpectancyPrimary: 90,
        lifeExpectancySecondary: 92,
        retirementDateByMember: new Map([
          ['p', { year: 2030, month0: 0 }],
          ['s', { year: 2030, month0: 0 }],
        ]),
        todayYear,
        todayMonthIndex,
        inflationPct: rate,
      },
    ),
  });

  it('annual one-off windfall inflates from today to the receipt year', () => {
    const p = stream('w', {
      name: 'Windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 50_000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxWithInflation(3), {
      from: 2035,
      to: 2035,
    });
    expect(out[0].spendable.oneOff).toBeCloseTo(50_000 * Math.pow(1.03, 9), 1);
  });

  it('pension lump-sum on birthday month inflates month-precise', () => {
    const p = stream('lump', {
      name: 'CBP Lump',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100_000,
      start: { kind: 'age', years: 65, months: 0 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxWithInflation(3), {
      from: 2030,
      to: 2030,
    });
    const expected = 100_000 * Math.pow(1.03, 50 / 12);
    // A pension lumpSum without targetAccountId is untargeted spendable income (engine fallback).
    expect(out[0].spendable.oneOff).toBeCloseTo(expected, 1);
  });

  it('monthly one-off renders the inflated literal in its spike month', () => {
    const p = stream('w', {
      name: 'Windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 50_000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxWithInflation(3), {
      from: 2035,
      to: 2035,
    });
    expect(out[0].oneOffIncome).toBeCloseTo(50_000 * Math.pow(1.03, 9), 1);
    for (let m = 1; m < 12; m += 1) {
      expect(out[m].oneOffIncome).toBe(0);
    }
  });

  it('zero inflation collapses to literal amount (legacy behaviour preserved)', () => {
    const p = stream('w', {
      name: 'Windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 50_000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxWithInflation(0), {
      from: 2035,
      to: 2035,
    });
    expect(out[0].spendable.oneOff).toBe(50_000);
  });

  it('non-Jan asOfMonth shifts the exponent month-precise', () => {
    const p = stream('w', {
      name: 'Windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 50_000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxWithInflation(3, 2026, 5), {
      from: 2035,
      to: 2035,
    });
    expect(out[0].spendable.oneOff).toBeCloseTo(50_000 * Math.pow(1.03, 103 / 12), 1);
  });
});

// Targeted one-offs are portfolio deposits (deposits.byAccount) and never offset expenses; untargeted ones are spendable.
describe('one-off classification by targetAccountId', () => {
  it('untargeted windfall flows to spendable.oneOff, not deposits', () => {
    const p = stream('w', {
      name: 'Untargeted windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 40_000,
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxOf(), { from: 2035, to: 2035 });
    expect(out[0].spendable.oneOff).toBe(40_000);
    expect(out[0].deposits.bySource.oneOff).toBe(0);
    expect(out[0].deposits.total).toBe(0);
    expect(out[0].deposits.byAccount.size).toBe(0);
  });

  it('targeted windfall flows to deposits.byAccount, not spendable', () => {
    // Pinned defect: targeted windfalls used to land in both oneOffIncome and depositsByAccount, double-counting them.
    const p = stream('w', {
      name: 'Targeted windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 40_000,
      targetAccountId: 'acct-brokerage',
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxOf(), { from: 2035, to: 2035 });
    expect(out[0].spendable.oneOff).toBe(0);
    expect(out[0].spendable.total).toBe(0);
    expect(out[0].deposits.bySource.oneOff).toBe(40_000);
    expect(out[0].deposits.bySource.pensionLumpSum).toBe(0);
    expect(out[0].deposits.byAccount.get('acct-brokerage')).toBe(40_000);
    expect(out[0].deposits.total).toBe(40_000);
  });

  it('targeted pension lump-sum flows to deposits.bySource.pensionLumpSum', () => {
    const p = stream('lump', {
      name: 'CBP Lump',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100_000,
      targetAccountId: 'acct-ira',
      start: { kind: 'age', years: 65, months: 0 },
    } as IncomeStreamPayload);
    const out = projectIncomeByYear([p], ctxOf(), { from: 2030, to: 2030 });
    expect(out[0].spendable.oneOff).toBe(0);
    expect(out[0].deposits.bySource.oneOff).toBe(0);
    expect(out[0].deposits.bySource.pensionLumpSum).toBe(100_000);
    expect(out[0].deposits.byAccount.get('acct-ira')).toBe(100_000);
    expect(out[0].deposits.total).toBe(100_000);
  });

  it('monthly: targeted windfall emits depositInflow, not oneOffIncome', () => {
    const p = stream('w', {
      name: 'Targeted windfall',
      kind: 'oneOff',
      memberId: 'p',
      oneOffAmount: 40_000,
      targetAccountId: 'acct-brokerage',
      start: { kind: 'year', year: 2035 },
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2035, to: 2035 });
    expect(out[0].oneOffIncome).toBe(0);
    expect(out[0].depositInflow).toBe(40_000);
    for (let m = 1; m < 12; m += 1) {
      expect(out[m].oneOffIncome).toBe(0);
      expect(out[m].depositInflow).toBe(0);
    }
  });
});

describe('linked-CBP lump-sum amount derivation', () => {
  // A linked-CBP lump sum saves lumpSumAmount = 0 (the field is hidden), so the engine must read the deposit from ctx.linkedCbpBalanceLookup or the transfer vanishes.
  const linkedStream = stream('cbp-lump', {
    name: 'CBP rollover',
    kind: 'pension',
    payoutType: 'lumpSum',
    memberId: 'p',
    lumpSumAmount: 0, // intentionally 0 — UI hides the field for linked.
    targetAccountId: 'acct-ira',
    linkedCbpAccountId: 'acct-cbp',
    start: { kind: 'year', year: 2030 },
  } as IncomeStreamPayload);

  it('projectIncomeByMonth substitutes the CBP balance from the context lookup', () => {
    const baseCtx = ctxOf();
    const ctx = {
      ...baseCtx,
      linkedCbpBalanceLookup: (id: string) =>
        id === 'acct-cbp' ? 175_000 : null,
    };
    const out = projectIncomeByMonth([linkedStream], ctx, {
      from: 2030,
      to: 2030,
    });
    expect(out[0].depositInflow).toBe(175_000);
    for (let m = 1; m < 12; m += 1) expect(out[m].depositInflow).toBe(0);
  });

  it('projectIncomeByYear surfaces the CBP balance on deposits.byAccount', () => {
    const baseCtx = ctxOf();
    const ctx = {
      ...baseCtx,
      linkedCbpBalanceLookup: () => 250_000,
    };
    const out = projectIncomeByYear([linkedStream], ctx, { from: 2030, to: 2030 });
    expect(out[0].deposits.byAccount.get('acct-ira')).toBe(250_000);
    expect(out[0].deposits.bySource.pensionLumpSum).toBe(250_000);
    expect(out[0].spendable.oneOff).toBe(0);
  });

  it('drops the event silently when the lookup is omitted (no spurious $0 deposit)', () => {
    const ctx = ctxOf(); // no linkedCbpBalanceLookup
    const events = collectTargetedDepositEvents([linkedStream], ctx);
    expect(events).toHaveLength(0);
  });

  it('drops the event when the lookup returns null (event past CBP horizon)', () => {
    const ctx = {
      ...ctxOf(),
      linkedCbpBalanceLookup: () => null,
    };
    const events = collectTargetedDepositEvents([linkedStream], ctx);
    expect(events).toHaveLength(0);
  });

  it('ignores the user-entered lumpSumAmount when linkedCbpAccountId is set', () => {
    const legacyStream = stream('cbp-lump-legacy', {
      ...linkedStream.payload,
      lumpSumAmount: 999_999, // stale; should NOT be emitted.
    } as IncomeStreamPayload);
    const ctx = {
      ...ctxOf(),
      linkedCbpBalanceLookup: () => 100_000,
    };
    const out = projectIncomeByMonth([legacyStream], ctx, { from: 2030, to: 2030 });
    expect(out[0].depositInflow).toBe(100_000);
  });
});

describe('pension COLA resolution', () => {
  it.each([
    ['tracksInflation is true: scenario inflation', { tracksInflation: true }, 3.5],
    ['tracksInflation is false: the explicit colaPct', { tracksInflation: false, colaPct: 2 }, 2],
    ['tracksInflation is false and colaPct absent', { tracksInflation: false }, 0],
    ['both absent (pre-migration)', {}, 0],
  ])('grows at the rate when %s', (_name, cola, ratePct) => {
    const p = stream('pen', {
      name: 'Co Pension',
      kind: 'pension',
      payoutType: 'annuity',
      memberId: 'p',
      monthlyBenefit: 1000,
      start: { kind: 'age', years: 65, months: 0 },
      ...cola,
    } as IncomeStreamPayload);
    const out = projectIncomeByMonth([p], { ...ctxOf(), inflationPct: 3.5 }, { from: 2032, to: 2032 });
    expect(out[0].pensionIncome).toBeCloseTo(12000 * Math.pow(1 + ratePct / 100, 2), 2);
  });
});

describe('collectPostRetirementPlainPensionPlacements', () => {
  const PRIMARY_RET_ABS = 2030 * 12;

  it('INCLUDES a post-retirement plain pension lump-sum WITH a targetAccountId', () => {
    const p = stream('plain', {
      name: 'Plain pension lump-sum',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100_000,
      targetAccountId: 'acct-ira',
      start: { kind: 'year', year: 2032 },
    } as IncomeStreamPayload);
    const out = collectPostRetirementPlainPensionPlacements([p], ctxOf(), PRIMARY_RET_ABS);
    expect(out).toHaveLength(1);
    expect(out[0].accountId).toBe('acct-ira');
    expect(out[0].memberId).toBe('p');
    expect(out[0].amount).toBe(100_000);
    expect(out[0].month0).toBe(2032 * 12);
  });

  it('EXCLUDES a linked-CBP lump-sum (routes via the dedicated RMD-aware seam)', () => {
    const p = stream('linked', {
      name: 'Linked CBP lump-sum',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 0,
      linkedCbpAccountId: 'cbp-1',
      targetAccountId: 'acct-ira',
      start: { kind: 'year', year: 2032 },
    } as IncomeStreamPayload);
    const out = collectPostRetirementPlainPensionPlacements([p], ctxOf(), PRIMARY_RET_ABS);
    expect(out).toHaveLength(0);
  });

  it('EXCLUDES a pre-retirement plain pension lump-sum (placed in accumulation)', () => {
    const p = stream('pre', {
      name: 'Pre-retirement plain pension lump-sum',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100_000,
      targetAccountId: 'acct-ira',
      start: { kind: 'year', year: 2029 },
    } as IncomeStreamPayload);
    const out = collectPostRetirementPlainPensionPlacements([p], ctxOf(), PRIMARY_RET_ABS);
    expect(out).toHaveLength(0);
  });

  it('EXCLUDES a plain pension lump-sum with NO targetAccountId', () => {
    const p = stream('notarget', {
      name: 'Untargeted plain pension lump-sum',
      kind: 'pension',
      payoutType: 'lumpSum',
      memberId: 'p',
      lumpSumAmount: 100_000,
      start: { kind: 'year', year: 2032 },
    } as IncomeStreamPayload);
    const out = collectPostRetirementPlainPensionPlacements([p], ctxOf(), PRIMARY_RET_ABS);
    expect(out).toHaveLength(0);
  });
});
