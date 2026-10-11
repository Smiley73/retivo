/**
 * Tests for `projectIncomeByMonth` — pension annuity start month
 * (Jan-default given year-only data model), part-time start/end at
 * actual month, one-off windfall + lump-sum spike at receipt month
 * at `amount × 12` annualized rate.
 */
import { describe, expect, it } from 'vitest';
import {
  buildIncomeContext,
  collectPostRetirementPlainPensionPlacements,
  collectTargetedDepositEvents,
  projectIncomeByMonth,
  projectIncomeByYear,
  resolveIncomeColaPct,
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
  // Per-member retirement dates so the owner-relative `retirementStart`
  // anchors resolve correctly. Both members retire in 2030 for these
  // fixtures; sub-year `retirementMonth0` propagates per-member when
  // overridden (used by the "honors retirementMonth0" test).
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
    // Primary born March 1965 → age 65 = March 2030.
    const out = projectIncomeByMonth([p], ctxOf(), { from: 2029, to: 2030 });
    // 2029 + Jan/Feb 2030 — pre-start.
    expect(out.find((r) => r.year === 2029 && r.month0 === 11)!.pensionIncome).toBe(0);
    expect(out.find((r) => r.year === 2030 && r.month0 === 0)!.pensionIncome).toBe(0);
    expect(out.find((r) => r.year === 2030 && r.month0 === 1)!.pensionIncome).toBe(0);
    // March 2030 onward — $12k/yr rate.
    for (let m = 2; m < 12; m += 1) {
      expect(
        out.find((r) => r.year === 2030 && r.month0 === m)!.pensionIncome,
      ).toBeCloseTo(12000, 2);
    }
  });

  it('J&S survivor reduction kicks in Jan of the year after the pensioner dies', () => {
    // Primary born March 1960, life 90 → deathYear = 2050. Death = Dec 31
    // of deathYear, so the full pension is paid through Dec 2050 and the
    // J&S reduction kicks in Jan 2051.
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
    // Every month of the death year (2050) — full pension ($12k/yr).
    for (let m = 0; m < 12; m++) {
      expect(
        out.find((r) => r.year === 2050 && r.month0 === m)!.pensionIncome,
      ).toBeCloseTo(12000, 2);
    }
    // Jan 2051 — J&S 50% kicks in ($6k/yr).
    expect(
      out.find((r) => r.year === 2051 && r.month0 === 0)!.pensionIncome,
    ).toBeCloseTo(6000, 2);
  });
});

describe('projectIncomeByMonth — part-time', () => {
  it('age-anchored start fires on the resolved birthday month', () => {
    // Primary born March 1965 → age 65 → start March 2030.
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
    // Jan, Feb 2030 — pre-start.
    expect(out[0].partTimeIncome).toBe(0);
    expect(out[1].partTimeIncome).toBe(0);
    // March 2030 onward — active.
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
    // Retirement March 2030, retirementMonth0 = 2.
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
    // Year-only data → spike in Jan (month0 = 0).
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
    // Primary born March 1965 → age 65 = year 2030. Receipt resolves to
    // birthday-month: March 2030 (month0 = 2).
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
    // Primary retires 2028; secondary retires 2032. A secondary-owned
    // partTime stream with `retirementStart` should fire in 2032, not
    // 2028 (the household-level / primary's date).
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
    // 2028–2031: pre-secondary's retirement, no income.
    for (const y of [2028, 2029, 2030, 2031]) {
      expect(out.find((r) => r.year === y && r.month0 === 0)!.partTimeIncome).toBe(0);
    }
    // 2032 Jan onward — secondary retires, partTime begins.
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

// Pinned: one-off + pension-lump-sum amounts are entered as
// today's-dollar values and inflated month-precise to the event month
// when the context supplies `todayYear` + `inflationPct`. Default
// (legacy) behaviour with no inflation context produces the literal
// amount — covered above.
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
    // year=2035 (month0=0 for year-anchored), todayYear=2026 month=0 →
    // 9 years out → factor = 1.03^9.
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
    // Primary born March 1965 → age 65 = March 2030 (month0=2). Today
    // = Jan 2026 (asOfMonth = 2026*12). Months from anchor = (2030*12 + 2) − (2026*12 + 0) = 50.
    const out = projectIncomeByYear([p], ctxWithInflation(3), {
      from: 2030,
      to: 2030,
    });
    const expected = 100_000 * Math.pow(1.03, 50 / 12);
    // Pension lumpSum without `targetAccountId` is treated as untargeted
    // spendable income (engine fallback — see income-projection.ts).
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
    // Anchor June 2026 (month0=5). Event Jan 2035 (month0=0).
    // Months gap = (2035*12 + 0) − (2026*12 + 5) = 103.
    const out = projectIncomeByYear([p], ctxWithInflation(3, 2026, 5), {
      from: 2035,
      to: 2035,
    });
    expect(out[0].spendable.oneOff).toBeCloseTo(50_000 * Math.pow(1.03, 103 / 12), 1);
  });
});

// Classify one-off / lump-sum receipts by
// `targetAccountId`. Untargeted → spendable income (offsets expenses).
// Targeted → portfolio addition (`deposits.byAccount[accountId]`),
// never offsets expenses. Pinned defect: prior behaviour put targeted
// windfalls in BOTH the spendable bucket AND the deposit bucket,
// which double-counted them (offset expenses + grew portfolio).
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
    // Pinned defect: prior shape had `oneOffIncome` populated from
    // targeted windfalls AND `depositsByAccount` — same dollar counted
    // twice (offset expenses + portfolio grew). New contract: targeted
    // amount sits exclusively in deposits.
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
  // When a `payoutType: 'lumpSum'` stream sets `linkedCbpAccountId`,
  // the UI saves `lumpSumAmount = 0` (the field is hidden). The
  // engine must substitute the deposit amount from
  // `ctx.linkedCbpBalanceLookup` instead — otherwise the transfer
  // disappears entirely.
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
    // Even if the payload still carries a non-zero `lumpSumAmount`
    // (legacy data, future bug, etc.), the linked-CBP path must read
    // from the lookup. The user-entered value is intentionally ignored.
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

// resolveIncomeColaPct — single resolution rule converting
// tracksInflation / colaPct pairs into an effective rate.
describe('resolveIncomeColaPct', () => {
  it('returns scenarioInflationPct when tracksInflation=true', () => {
    expect(resolveIncomeColaPct({ tracksInflation: true }, 3.5)).toBe(3.5);
  });

  it('returns explicit colaPct when tracksInflation=false', () => {
    expect(resolveIncomeColaPct({ tracksInflation: false, colaPct: 2 }, 3.5)).toBe(2);
  });

  it('returns 0 when tracksInflation=false and colaPct absent', () => {
    expect(resolveIncomeColaPct({ tracksInflation: false }, 3.5)).toBe(0);
  });

  it('returns 0 when tracksInflation absent and colaPct absent (pre-migration)', () => {
    // tracksInflation === undefined → not strictly true → falls back to colaPct ?? 0
    expect(resolveIncomeColaPct({}, 3.5)).toBe(0);
  });
});

// Direct coverage for collectPostRetirementPlainPensionPlacements — the
// per-account placement filter has 4 distinct paths (included + 3 exclusions).
// Both members retire in 2030 (ctxOf), so primaryRetirementAbsMonth = 2030*12.
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
      // 2032 ≥ retirement (2030) → post-retirement.
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
      // Linked-CBP elections force lumpSumAmount to 0 on save; the amount would
      // come from the CBP balance lookup. The placement collector excludes them
      // regardless of amount because linkedCbpAccountId is set.
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
      // 2029 < retirement (2030) → pre-retirement, excluded.
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
      // targetAccountId omitted → not a per-account placement.
      start: { kind: 'year', year: 2032 },
    } as IncomeStreamPayload);
    const out = collectPostRetirementPlainPensionPlacements([p], ctxOf(), PRIMARY_RET_ABS);
    expect(out).toHaveLength(0);
  });
});
