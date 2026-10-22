import { describe, expect, it } from 'vitest';
import type { DrawdownYear } from '../drawdown-engine-types';
import { guardCrossings } from './candidate-passes';
import type { IrmaaGuardTier, IrmaaLimit, YearLimits } from './types';

function limits(year: number, referenceTier: IrmaaGuardTier): YearLimits {
  const irmaa: IrmaaLimit = {
    kind: 'irmaa',
    applies: true,
    valueDollars: 200_000,
    lookbackYear: year + 2,
    filingStatus: 'MFJ',
    referenceTier,
    thresholdDollars: 200_000,
    scalingFactor: 1,
  };
  return {
    year,
    irmaa,
    aca: { kind: 'aca', applies: false, reason: 'unguarded' },
  } as YearLimits;
}

function rowsWithTier(year: number, tier: DrawdownYear['irmaaTier']): Map<number, DrawdownYear> {
  return new Map([[year, { year, irmaaTier: tier } as DrawdownYear]]);
}

describe('guardCrossings', () => {
  it('flags a Y+2 tier above the reference tier, not a tier equal to it', () => {
    expect(guardCrossings([limits(2030, 'tier1')], rowsWithTier(2032, 'tier1'))).toEqual([]);
    expect(guardCrossings([limits(2030, 'tier1')], rowsWithTier(2032, 'tier2'))).toEqual([
      { year: 2030, line: 'irmaa' },
    ]);
    expect(guardCrossings([limits(2030, 'tier3')], rowsWithTier(2032, 'tier5'))).toEqual([
      { year: 2030, line: 'irmaa' },
    ]);
  });

  it('flags any surcharge for a reference under every line', () => {
    expect(guardCrossings([limits(2030, 'none')], rowsWithTier(2032, 'none'))).toEqual([]);
    expect(guardCrossings([limits(2030, 'none')], rowsWithTier(2032, 'tier1'))).toEqual([
      { year: 2030, line: 'irmaa' },
    ]);
  });
});
