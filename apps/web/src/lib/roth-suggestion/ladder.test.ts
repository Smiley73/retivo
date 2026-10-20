import { describe, expect, it } from 'vitest';
import { buildNextMagiCap } from '../magi-cap-persistence';
import { buildLadder, conversionWindow, isValidFillTarget } from './ladder';
import { toyAccount } from './test-fixtures';

describe('conversionWindow', () => {
  it('runs from the retirement year to the year before the RMD trigger age', () => {
    // Born 1977 reaches 75 in 2052.
    expect(conversionWindow({ primaryBirthYear: 1977, retirementYear: 2042, horizonYear: 2072 })).toEqual({
      startYear: 2042,
      endYear: 2051,
    });
    // Born 1955 reaches 73 in 2028.
    expect(conversionWindow({ primaryBirthYear: 1955, retirementYear: 2020, horizonYear: 2045 })).toEqual({
      startYear: 2020,
      endYear: 2027,
    });
  });

  it('is clipped to the horizon', () => {
    expect(conversionWindow({ primaryBirthYear: 1977, retirementYear: 2042, horizonYear: 2046 })).toEqual({
      startYear: 2042,
      endYear: 2046,
    });
  });

  it('is empty when retirement is at or after the RMD trigger year, or past the horizon', () => {
    expect(conversionWindow({ primaryBirthYear: 1977, retirementYear: 2052, horizonYear: 2072 })).toBeNull();
    expect(conversionWindow({ primaryBirthYear: 1977, retirementYear: 2060, horizonYear: 2072 })).toBeNull();
    expect(conversionWindow({ primaryBirthYear: 1977, retirementYear: 2042, horizonYear: 2040 })).toBeNull();
  });

  it('is empty when the birth year is unusable', () => {
    expect(conversionWindow({ primaryBirthYear: Number.NaN, retirementYear: 2042, horizonYear: 2072 })).toBeNull();
  });
});

describe('buildLadder', () => {
  const ladder = buildLadder(
    [
      { year: 2042, ceilingDollars: 150_000.9 },
      { year: 2043, ceilingDollars: 152_000 },
    ],
    'roth-1',
  );

  it('is one year-anchored Fill window per year on the IRMAA line', () => {
    expect(ladder).toEqual([
      {
        start: { kind: 'year', year: 2042 },
        end: { kind: 'year', year: 2042 },
        magiCeilingAnnualDollars: 150_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth-1',
      },
      {
        start: { kind: 'year', year: 2043 },
        end: { kind: 'year', year: 2043 },
        magiCeilingAnnualDollars: 152_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth-1',
      },
    ]);
  });

  it('is exactly what the save path would persist', () => {
    const saved = buildNextMagiCap({
      magiCapEnabled: true,
      magiCapWindows: ladder,
      localOverrides: {},
      parentCap: undefined,
    });
    expect(saved).toEqual({ magiCap: { windows: ladder } });
    expect(JSON.stringify(saved)).toBe(JSON.stringify({ magiCap: { windows: ladder } }));
  });

  it('never writes a negative ceiling', () => {
    expect(buildLadder([{ year: 2042, ceilingDollars: -5 }], 'roth-1')[0].magiCeilingAnnualDollars).toBe(0);
  });
});

describe('isValidFillTarget', () => {
  const accounts = [
    toyAccount('roth', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
    toyAccount('roth-closed', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', { active: false }),
    toyAccount('roth-inherited', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', { rmdInheritedAccount: true }),
    toyAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
    toyAccount('roth-401k', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH'),
  ];

  it('accepts an active, own Roth IRA', () => {
    expect(isValidFillTarget(accounts, 'roth')).toBe(true);
  });

  it.each(['roth-closed', 'roth-inherited', 'ira', 'roth-401k', 'missing'])('rejects %s', (id) => {
    expect(isValidFillTarget(accounts, id)).toBe(false);
  });
});
