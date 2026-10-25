import { describe, it, expect } from 'vitest';
import {
  qcdFirstEligibleTaxYear,
  computeQcdForOwnerYear,
  dollarsToCents,
  type QcdEntryForOwnerYear,
} from './qcd';

describe('qcdFirstEligibleTaxYear', () => {
  it('first-half birthday is eligible in the SAME calendar year (age 70½)', () => {
    // born 1954-01-15 → +70y6m = 2024-07-15 → 2024
    expect(qcdFirstEligibleTaxYear('1954-01-15')).toBe(2024);
  });

  it('second-half birthday spills the eligibility to year+1', () => {
    // born 1954-08-10 → +70y6m = 2025-02-10 → 2025
    expect(qcdFirstEligibleTaxYear('1954-08-10')).toBe(2025);
  });

  it('December birthday spills to the following June year', () => {
    // born 1954-12-01 → +70y6m = 2025-06-01 → 2025
    expect(qcdFirstEligibleTaxYear('1954-12-01')).toBe(2025);
  });

  it('born July 1 exactly → eligible Jan 1 of that year', () => {
    // born 1954-07-01 → +70y6m = 2025-01-01 → 2025
    expect(qcdFirstEligibleTaxYear('1954-07-01')).toBe(2025);
  });

  it('born June 30 → +70y6m lands in December of year 70 → same year', () => {
    // born 1954-06-30 → +70y6m = 2024-12-30 → 2024
    expect(qcdFirstEligibleTaxYear('1954-06-30')).toBe(2024);
  });

  it('throws on a malformed birthdate', () => {
    expect(() => qcdFirstEligibleTaxYear('not-a-date')).toThrow();
  });

  it('throws for an invalid month', () => {
    expect(() => qcdFirstEligibleTaxYear('1954-13-15')).toThrow(/invalid month/);
  });

  it('throws for February 30', () => {
    expect(() => qcdFirstEligibleTaxYear('1954-02-30')).toThrow(/invalid day/);
  });

  it('throws for February 29 on a non-leap year', () => {
    expect(() => qcdFirstEligibleTaxYear('1954-02-29')).toThrow(/invalid day/);
  });

  it('accepts February 29 on a leap year', () => {
    // 1956 is a leap year. 1956-02-29 + 70.5yr → eligible 2026 (Aug 29).
    expect(qcdFirstEligibleTaxYear('1956-02-29')).toBe(2026);
  });
});

describe('dollarsToCents', () => {
  it('rounds to integer cents', () => {
    expect(dollarsToCents(100.005)).toBe(10001);
    expect(dollarsToCents(100.004)).toBe(10000);
  });
});

describe('computeQcdForOwnerYear', () => {
  const entry = (
    sourceAccountId: string,
    annualAmountDollars: number,
  ): QcdEntryForOwnerYear => ({ sourceAccountId, annualAmountDollars });

  it('zero entries → all zeros', () => {
    const r = computeQcdForOwnerYear({
      entries: [],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map(),
      grossIraPoolRmdCents: 50_000_00,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(0);
    expect(r.rmdOffsetCents).toBe(0);
    expect(r.incomeExclusionCents).toBe(0);
    expect(r.perEntry).toEqual([]);
  });

  it('amount cap binds (amount < limit and balance)', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 10_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(10_000_00);
  });

  it('per-person limit cap binds (limit < amount and balance)', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 200_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(111_000_00);
  });

  it('balance cap binds (balance < amount and limit)', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 50_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 7_500_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(7_500_00);
  });

  it('per-person limit is consumed once across two same-owner entries', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('iraA', 80_000), entry('iraB', 80_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([
        ['iraA', 500_000_00],
        ['iraB', 500_000_00],
      ]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(111_000_00);
    expect(r.perEntry[0].qcdCents).toBe(80_000_00);
    expect(r.perEntry[1].qcdCents).toBe(111_000_00 - 80_000_00);
  });

  it('RMD offset: Q < grossRMD → offset = Q', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 10_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 40_000_00,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.rmdOffsetCents).toBe(10_000_00);
  });

  it('RMD offset: Q == grossRMD → offset = Q', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 40_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 40_000_00,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.rmdOffsetCents).toBe(40_000_00);
  });

  it('RMD offset: Q > grossRMD → offset capped at grossRMD; full Q excluded', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 60_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 40_000_00,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(60_000_00);
    expect(r.rmdOffsetCents).toBe(40_000_00);
    expect(r.incomeExclusionCents).toBe(60_000_00);
  });

  it('pre-RMD-age (grossRMD = 0): QCD > 0 but offset = 0; still excluded', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 10_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(10_000_00);
    expect(r.rmdOffsetCents).toBe(0);
    expect(r.incomeExclusionCents).toBe(10_000_00);
  });

  it('depleted source → qCents = 0 for that entry', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 10_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 0]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.perEntry[0].qcdCents).toBe(0);
    expect(r.totalQcdCents).toBe(0);
  });

  it('missing source balance entry → qCents = 0', () => {
    const r = computeQcdForOwnerYear({
      entries: [entry('ghost', 10_000)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map(),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(0);
  });

  it('inflation factor is applied to the real amount in integer cents', () => {
    // $10,000 real × 1.03 = $10,300.00 → 1_030_000 cents
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 10_000)],
      year: 2027,
      inflationFactor: 1.03,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(dollarsToCents(10_000 * 1.03));
  });

  it('rounding seam: a fractional-cent inflated amount rounds with Math.round', () => {
    // $100.005 real × 1 = $100.005 → rounds to 10001 cents.
    const r = computeQcdForOwnerYear({
      entries: [entry('ira', 100.005)],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira', 500_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 111_000_00,
    });
    expect(r.totalQcdCents).toBe(10001);
  });

  it('depletes source IRA balance across two same-source entries', () => {
    // IRA balance: 50_000_00 cents. Two entries each wanting 40_000_00.
    const result = computeQcdForOwnerYear({
      entries: [
        { sourceAccountId: 'ira-a', annualAmountDollars: 40_000 },
        { sourceAccountId: 'ira-a', annualAmountDollars: 40_000 },
      ],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira-a', 50_000_00]]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 115_000_00,
    });
    expect(result.perEntry[0].qcdCents).toBe(40_000_00);
    expect(result.perEntry[1].qcdCents).toBe(10_000_00);
    expect(result.totalQcdCents).toBe(50_000_00);
  });

  it('clamps rmdOffsetCents to 0 when grossIraPoolRmdCents is negative', () => {
    const result = computeQcdForOwnerYear({
      entries: [{ sourceAccountId: 'ira-a', annualAmountDollars: 10_000 }],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([['ira-a', 100_000_00]]),
      grossIraPoolRmdCents: -5_000_00,
      qcdLimitCentsForYear: 115_000_00,
    });
    expect(result.rmdOffsetCents).toBe(0);
    expect(result.totalQcdCents).toBe(10_000_00);
    expect(result.incomeExclusionCents).toBe(10_000_00);
  });

  it('third entry gets $0 when per-person limit is already exhausted', () => {
    // Limit: 115_000_00. Entry A: $80k, Entry B: $35k (consumes remainder exactly).
    // Entry C: $20k → remainingLimit = 0 → qCents = 0.
    const result = computeQcdForOwnerYear({
      entries: [
        { sourceAccountId: 'ira-a', annualAmountDollars: 80_000 },
        { sourceAccountId: 'ira-b', annualAmountDollars: 35_000 },
        { sourceAccountId: 'ira-c', annualAmountDollars: 20_000 },
      ],
      year: 2026,
      inflationFactor: 1,
      sourceBalancesPreTaxCents: new Map([
        ['ira-a', 200_000_00],
        ['ira-b', 200_000_00],
        ['ira-c', 200_000_00],
      ]),
      grossIraPoolRmdCents: 0,
      qcdLimitCentsForYear: 115_000_00,
    });
    expect(result.perEntry[0].qcdCents).toBe(80_000_00);
    expect(result.perEntry[1].qcdCents).toBe(35_000_00);
    expect(result.perEntry[2].qcdCents).toBe(0);
    expect(result.totalQcdCents).toBe(115_000_00);
  });
});
