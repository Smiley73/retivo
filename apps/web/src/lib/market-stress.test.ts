import { describe, expect, it } from 'vitest';
import {
  STRESS_CASES,
  STRESS_CASE_COPY,
  STRESS_CASE_IDS,
  STRESS_MAX_AGE,
  longerLifeChangedText,
  stressExtendsHorizon,
} from './market-stress';

describe('stressExtendsHorizon — which cases lengthen the plan', () => {
  it.each(['longerLife'] as const)(
    'flags %s, whose extra years draw fresh markets',
    (caseId) => {
      // The flag turns on the longevity disclosure: the added years use fresh market draws, so the "same simulated market histories" claim holds only up to the original horizon.
      expect(stressExtendsHorizon(caseId)).toBe(true);
    },
  );

  it.each(['higherFees', 'lowerReturns', 'higherInflation'] as const)(
    'does NOT flag %s, which only re-prices the same horizon',
    (caseId) => {
      expect(stressExtendsHorizon(caseId)).toBe(false);
    },
  );

  it('classifies every named case, so a new one cannot slip through unflagged', () => {
    expect(STRESS_CASE_IDS.filter(stressExtendsHorizon)).toEqual(['longerLife']);
  });
});

describe('STRESS_CASE_COPY — magnitudes cannot go stale', () => {
  it('keeps the "bonds and cash" reading honest by pinning the two shocks equal', () => {
    // `lowerReturns.changed` renders one number for both sleeves from `returnShockBondsPct`, which is accurate only while the two magnitudes are identical.
    expect(STRESS_CASES.lowerReturns.returnShockCashPct).toBe(
      STRESS_CASES.lowerReturns.returnShockBondsPct,
    );
    expect(STRESS_CASE_COPY.lowerReturns.changed).toContain(
      `bonds and cash ${STRESS_CASES.lowerReturns.returnShockBondsPct}% a year lower`,
    );
  });

  it('interpolates every named magnitude it states from STRESS_CASES', () => {
    expect(STRESS_CASE_COPY.higherFees.changed).toContain(
      `${STRESS_CASES.higherFees.investmentCostPctDelta}%`,
    );
    expect(STRESS_CASE_COPY.lowerReturns.changed).toContain(
      `Stocks ${STRESS_CASES.lowerReturns.returnShockStocksPct}%`,
    );
    expect(STRESS_CASE_COPY.higherInflation.changed).toContain(
      `${STRESS_CASES.higherInflation.inflationShockPct}%`,
    );
    expect(STRESS_CASE_COPY.longerLife.changed).toContain(
      `${STRESS_CASES.longerLife.longevityShockYears} more years`,
    );
  });
});

describe('longerLifeChangedText — the age reached, not the abstract ceiling', () => {
  it('reports the uncapped age when the +5 extension stays under the cap', () => {
    expect(longerLifeChangedText(2060, 1968, { firstName: 'John', birthYear: 1968 })).toBe(
      '5 more years of retirement (John age 97)',
    );
  });

  it('reports the CAPPED age when the extension would run past 105', () => {
    // Born 1968, plan ends 2070: +5 would be 2075 (age 107), but the cap holds the horizon at 2073; the row must read the age simulated.
    expect(longerLifeChangedText(2070, 1968, { firstName: 'John', birthYear: 1968 })).toBe(
      '3 more years of retirement (John age 105)',
    );
    expect(longerLifeChangedText(2070, 1968, { firstName: 'John', birthYear: 1968 })).toContain(
      `age ${STRESS_MAX_AGE}`,
    );
  });

  it('states the years the cap actually allowed, not the approved +5', () => {
    // Plan ends 2072: the cap stops the horizon at 2073, so one year was added (singular); "5 more years" would promise four never simulated.
    expect(longerLifeChangedText(2072, 1968, { firstName: 'John', birthYear: 1968 })).toBe(
      '1 more year of retirement (John age 105)',
    );
    expect(longerLifeChangedText(2071, 1968, { firstName: 'John', birthYear: 1968 })).toBe(
      '2 more years of retirement (John age 105)',
    );
  });

  it('claims no added years at all when the plan already reaches the cap', () => {
    expect(longerLifeChangedText(2073, 1968, { firstName: 'John', birthYear: 1968 })).toBe(
      'No added years — John already at age 105',
    );
    expect(longerLifeChangedText(2073, 1968, { firstName: null, birthYear: 1968 })).toBe(
      'No added years — already at age 105',
    );
  });

  it('states the age without attributing it when the anchor has no single name', () => {
    expect(longerLifeChangedText(2060, 1968, { firstName: null, birthYear: 1968 })).toBe(
      '5 more years of retirement (to age 97)',
    );
  });

  it('ages the LAST SURVIVOR, not the age-105 cap anchor', () => {
    // The cap anchors on the youngest member (born 1985) while the horizon belongs to Ann (born 1958, dies last): 2065 − 1958 = 107 is the age the added years reach.
    expect(
      longerLifeChangedText(2060, 1985, { firstName: 'Ann', birthYear: 1958 }),
    ).toBe('5 more years of retirement (Ann age 107)');
  });

  it('names both members when the row credits a tied pair', () => {
    expect(
      longerLifeChangedText(2060, 1965, { firstName: 'Ann and John', birthYear: 1965 }),
    ).toBe('5 more years of retirement (Ann and John age 100)');
  });

  it('drops the age entirely rather than inventing one with no birthdates', () => {
    expect(longerLifeChangedText(2060, 1968, null)).toBe(
      '5 more years of retirement',
    );
  });
});
