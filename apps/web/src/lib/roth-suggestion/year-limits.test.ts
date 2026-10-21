/**
 * The three per-year limits, each checked against an independent hand
 * computation from the calibration tables rather than against the code that
 * produces it.
 */
import { describe, expect, it } from 'vitest';
import { computeMonthAwareIrmaa } from '../irmaa';
import { resolveFederalTaxSnapshotForYear } from '../federal-tax-extrapolation';
import { fplDollarsForRegion } from '../aca-ptc';
import {
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  resolveSnapshotYear,
  type TaxMemberInput,
} from '../tax-integration-helpers';
import type { LookbackFacts, YearFacts } from './year-facts';
import {
  acaLimit,
  bracketGeometry,
  bracketLimit,
  deriveYearLimits,
  irmaaLimit,
  pickBindingLimit,
  taxableOrdinaryBoundDollars,
  type LimitEnvironment,
  type YearLimitInputs,
} from './year-limits';
import type { AcaLimit, BracketLimit, IrmaaLimit } from './types';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;
const ENV: LimitEnvironment = { bundle: BUNDLE, inflationPct: 2.5, acaFplRegion: undefined };

function marketplaceMember(months: number): TaxMemberInput {
  return {
    memberId: 'm1',
    isoBirthdate: '1966-06-15',
    onMedicare: false,
    hasAcaCoverage: months > 0,
    marketplaceCoverageMonths: months,
  };
}

function facts(overrides: Partial<YearFacts> & { year: number }): YearFacts {
  return {
    filingStatus: 'MFJ',
    householdSize: 2,
    age65Count: 0,
    members: [marketplaceMember(12)],
    ...overrides,
  };
}

const MEDICARE_LOOKBACK = (year: number): LookbackFacts => ({
  year: year + 2,
  withinHorizon: true,
  medicareBeneficiaries: 2,
  irmaaBeneficiaries: [
    { partBMonths: 12, partDMonths: 12 },
    { partBMonths: 12, partDMonths: 12 },
  ],
});

function inputs(overrides: Partial<YearLimitInputs> & { facts: YearFacts }): YearLimitInputs {
  return {
    rate: 0.12,
    guarded: true,
    lookback: MEDICARE_LOOKBACK(overrides.facts.year),
    reference: { lookbackIrmaaTier: 'none', acaPtcTier: 'sliding' },
    grossSsDollars: 0,
    engineOffsetDollars: 0,
    ...overrides,
  };
}

/** Floor of the ordinary bracket after the one taxed at `rate`, straight off
 *  the (possibly extrapolated) federal table. */
function bracketTopFromTable(year: number, status: 'MFJ' | 'Single', rate: number): number {
  const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(
    BUNDLE.federalTax,
    year,
    ENV.inflationPct,
  );
  const brackets = snapshot.values[lookupYear].brackets[status];
  const index = brackets.findIndex((b) => Math.abs(b.rate - rate) < 1e-9);
  return brackets[index + 1].floor;
}

describe('bracketLimit', () => {
  it('is the next bracket floor plus the standard deduction when no one is 65', () => {
    const limit = bracketLimit(bracketGeometry(0.12, facts({ year: 2026 }), ENV));
    const config = BUNDLE.federalTax.values[2026];
    expect(limit.bracketTopDollars).toBe(bracketTopFromTable(2026, 'MFJ', 0.12));
    expect(limit.standardDeductionDollars).toBe(config.standardDeduction.MFJ);
    expect(limit.age65AddOnDollars).toBe(0);
    expect(limit.seniorBonusDollars).toBe(0);
    expect(limit.valueDollars).toBe(limit.bracketTopDollars + config.standardDeduction.MFJ);
  });

  it('adds one age-65 add-on per member who attains 65 and uses the Single rate for one filer', () => {
    const mfj = bracketLimit(bracketGeometry(0.22, facts({ year: 2030, age65Count: 2 }), ENV));
    const single = bracketLimit(
      bracketGeometry(0.22, facts({ year: 2030, filingStatus: 'Single', age65Count: 1 }), ENV),
    );
    const { snapshot, lookupYear } = resolveFederalTaxSnapshotForYear(BUNDLE.federalTax, 2030, 2.5);
    const live = snapshot.values[lookupYear];
    expect(mfj.age65AddOnDollars).toBe(2 * live.age65AddOn.mfj);
    expect(single.age65AddOnDollars).toBe(live.age65AddOn.singleOrHoH);
    expect(single.filingStatus).toBe('Single');
    expect(single.bracketTopDollars).toBe(bracketTopFromTable(2030, 'Single', 0.22));
  });

  it('keeps the $25 floor rounding of an extrapolated year', () => {
    const limit = bracketLimit(bracketGeometry(0.22, facts({ year: 2040 }), ENV));
    expect(limit.bracketTopDollars).toBe(bracketTopFromTable(2040, 'MFJ', 0.22));
    expect(limit.bracketTopDollars % 25).toBe(0);
  });

  describe('senior bonus deduction (2025-2028), which phases out with MAGI', () => {
    // Independent closed form of C = K + n * max(0, cap - rate * max(0, C - base)).
    function closedForm(status: 'MFJ' | 'Single', rate: number, count: number): number {
      const config = BUNDLE.federalTax.values[2026];
      const slot = config.seniorBonusDeduction;
      if (slot === undefined) throw new Error('2026 table must carry the senior bonus');
      const addOn = status === 'MFJ' ? config.age65AddOn.mfj : config.age65AddOn.singleOrHoH;
      const k =
        bracketTopFromTable(2026, status, rate) + config.standardDeduction[status] + addOn * count;
      const base = slot.phaseoutBaseMagi[status];
      const noPhaseout = k + count * slot.perFilerCap;
      if (noPhaseout <= base) return noPhaseout;
      const r = slot.phaseoutRatePct;
      const inPhaseout = (k + count * slot.perFilerCap + count * r * base) / (1 + count * r);
      return inPhaseout <= base + slot.perFilerCap / r ? inPhaseout : k;
    }

    it.each([
      ['below the phase-out base', 'MFJ', 0.12, 2],
      ['inside the phase-out', 'MFJ', 0.22, 2],
      ['past the phase-out', 'MFJ', 0.24, 2],
      ['a single filer inside the phase-out', 'Single', 0.22, 1],
    ] as const)('solves the ceiling %s', (_label, status, rate, count) => {
      const limit = bracketLimit(
        bracketGeometry(rate, facts({ year: 2026, filingStatus: status, age65Count: count }), ENV),
      );
      expect(limit.valueDollars).toBe(Math.floor(closedForm(status, rate, count)));
      // The ceiling recomputes from its own recorded pieces.
      expect(limit.valueDollars).toBe(
        Math.floor(
          limit.bracketTopDollars +
            limit.standardDeductionDollars +
            limit.age65AddOnDollars +
            limit.seniorBonusDollars,
        ),
      );
    });

    it('leaves taxable ordinary income at the bracket top at the ceiling', () => {
      const geometry = bracketGeometry(0.22, facts({ year: 2026, age65Count: 2 }), ENV);
      const limit = bracketLimit(geometry);
      expect(taxableOrdinaryBoundDollars(geometry, limit.valueDollars)).toBeLessThanOrEqual(
        limit.bracketTopDollars,
      );
      expect(taxableOrdinaryBoundDollars(geometry, limit.valueDollars)).toBeGreaterThan(
        limit.bracketTopDollars - 1,
      );
    });
  });
});

describe('irmaaLimit', () => {
  const year = 2030;

  it('is the tier-1 threshold of year Y+2 times that year scaling, rounded down', () => {
    const limit = irmaaLimit(inputs({ facts: facts({ year }) }), ENV);
    expect(limit.applies).toBe(true);
    if (!limit.applies) return;
    const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(BUNDLE.irmaa, year + 2, 2.5);
    const threshold = BUNDLE.irmaa.values[effectiveYear].byMfj[0].thresholdDollars;
    expect(limit.lookbackYear).toBe(year + 2);
    expect(limit.thresholdDollars).toBe(threshold);
    expect(limit.scalingFactor).toBe(thresholdScalingFactor);
    expect(limit.valueDollars).toBe(Math.floor(threshold * thresholdScalingFactor));
  });

  it('rounds an extrapolated line down so a rounded-up ceiling cannot sit over', () => {
    const limit = irmaaLimit(inputs({ facts: facts({ year: 2040 }) }), ENV);
    if (!limit.applies) throw new Error('expected the line to apply');
    const exact = limit.thresholdDollars * limit.scalingFactor;
    expect(Number.isInteger(limit.valueDollars)).toBe(true);
    expect(limit.valueDollars).toBeLessThanOrEqual(exact);
    expect(limit.valueDollars).toBeGreaterThan(exact - 1);
  });

  it('is the line the engine tiers on: MAGI equal to it is tier none', () => {
    const limit = irmaaLimit(inputs({ facts: facts({ year: 2024 }) }), ENV);
    if (!limit.applies) throw new Error('expected the line to apply');
    expect(limit.scalingFactor).toBe(1);
    const tierAt = (magiCents: number): string =>
      computeMonthAwareIrmaa(
        {
          taxYear: limit.lookbackYear,
          lookback: { magiCents, filingStatus: 'MFJ' },
          beneficiaries: [{ partBMonths: 12, partDMonths: 12 }],
        },
        BUNDLE.irmaa,
      ).tier;
    expect(tierAt(limit.valueDollars * 100)).toBe('none');
    expect(tierAt(limit.valueDollars * 100 + 1)).toBe('tier1');
  });

  it('reads the Single schedule for a Single year', () => {
    const mfj = irmaaLimit(inputs({ facts: facts({ year }) }), ENV);
    const single = irmaaLimit(inputs({ facts: facts({ year, filingStatus: 'Single' }) }), ENV);
    if (!mfj.applies || !single.applies) throw new Error('expected both lines to apply');
    const { effectiveYear } = resolveSnapshotYear(BUNDLE.irmaa, year + 2, 2.5);
    expect(single.thresholdDollars).toBe(BUNDLE.irmaa.values[effectiveYear].bySingle[0].thresholdDollars);
    expect(single.valueDollars).toBeLessThan(mfj.valueDollars);
  });

  it.each([
    ['unguarded', { guarded: false }, 'unguarded'],
    ['beyond the horizon', { lookback: { year: year + 2, withinHorizon: false, medicareBeneficiaries: 0, irmaaBeneficiaries: [] } }, 'beyond-horizon'],
    ['no Medicare month in Y+2', { lookback: { year: year + 2, withinHorizon: true, medicareBeneficiaries: 0, irmaaBeneficiaries: [] } }, 'no-medicare'],
    ['already in the top tier in the reference', { reference: { lookbackIrmaaTier: 'tier5', acaPtcTier: 'sliding' } }, 'reference-over-line'],
  ] as const)('does not apply when %s', (_label, override, reason) => {
    const limit: IrmaaLimit = irmaaLimit(inputs({ facts: facts({ year }), ...override }), ENV);
    expect(limit).toEqual({ kind: 'irmaa', applies: false, reason });
  });

  it.each([
    ['none', 0],
    ['tier1', 1],
    ['tier2', 2],
    ['tier3', 3],
    ['tier4', 4],
  ] as const)('holds a reference in %s under the next line up', (referenceTier, index) => {
    const limit = irmaaLimit(
      inputs({ facts: facts({ year }), reference: { lookbackIrmaaTier: referenceTier, acaPtcTier: 'sliding' } }),
      ENV,
    );
    if (!limit.applies) throw new Error('expected the line to apply');
    const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(BUNDLE.irmaa, year + 2, 2.5);
    const threshold = BUNDLE.irmaa.values[effectiveYear].byMfj[index].thresholdDollars;
    expect(limit.referenceTier).toBe(referenceTier);
    expect(limit.thresholdDollars).toBe(threshold);
    expect(limit.valueDollars).toBe(Math.floor(threshold * thresholdScalingFactor));
  });
});

describe('acaLimit', () => {
  const year = 2030;

  function fplLine(householdSize: number): number {
    const { effectiveYear, thresholdScalingFactor } = resolveSnapshotYear(BUNDLE.acaPtc, year, 2.5);
    const table = BUNDLE.acaPtc.values[effectiveYear];
    return 4 * fplDollarsForRegion(table.fpl, householdSize, 'contiguous') * thresholdScalingFactor;
  }

  it('is 400 % of the poverty line for the household when there is no Social Security', () => {
    const limit = acaLimit(inputs({ facts: facts({ year }) }), ENV);
    if (!limit.applies) throw new Error('expected the line to apply');
    expect(limit.multiple).toBe(4);
    expect(limit.householdSize).toBe(2);
    expect(limit.nontaxableSsDollars).toBe(0);
    expect(limit.valueDollars).toBe(Math.floor(fplLine(2)));
  });

  it('moves onto the federal line by the Social Security the ACA MAGI adds back', () => {
    const gross = 30_000;
    const limit = acaLimit(inputs({ facts: facts({ year }), grossSsDollars: gross }), ENV);
    if (!limit.applies) throw new Error('expected the line to apply');
    // §86 by hand, MFJ: other income at the line leaves provisional income far
    // above $44,000, so 85 % of the benefit is taxable.
    const line = fplLine(2);
    expect(line - gross + gross / 2).toBeGreaterThan(44_000);
    expect(limit.taxableSsDollars).toBe(gross * 0.85);
    expect(limit.nontaxableSsDollars).toBe(gross * 0.15);
    expect(limit.valueDollars).toBe(Math.floor(line - gross * 0.15));
  });

  it('uses the household size the tax unit carries', () => {
    const one = acaLimit(inputs({ facts: facts({ year, householdSize: 1 }) }), ENV);
    const two = acaLimit(inputs({ facts: facts({ year, householdSize: 2 }) }), ENV);
    if (!one.applies || !two.applies) throw new Error('expected both lines to apply');
    expect(one.valueDollars).toBe(Math.floor(fplLine(1)));
    expect(one.valueDollars).toBeLessThan(two.valueDollars);
  });

  it.each([
    ['unguarded', { guarded: false }, 'unguarded'],
    ['no member has Marketplace months', { facts: facts({ year, members: [marketplaceMember(0)] }) }, 'no-marketplace'],
    ['already over the cliff in the reference', { reference: { lookbackIrmaaTier: 'none', acaPtcTier: 'above-400-cliff' } }, 'reference-over-line'],
    ['the year is in the ira-expanded regime', { facts: facts({ year: 2025 }) }, 'not-pre-arpa'],
  ] as const)('does not apply when %s', (_label, override, reason) => {
    const limit: AcaLimit = acaLimit(inputs({ facts: facts({ year }), ...override }), ENV);
    expect(limit).toEqual({ kind: 'aca', applies: false, reason });
  });
});

describe('pickBindingLimit', () => {
  const bracket = (valueDollars: number): BracketLimit => ({
    kind: 'bracket',
    valueDollars,
    bracketRate: 0.12,
    filingStatus: 'MFJ',
    bracketTopDollars: 0,
    standardDeductionDollars: 0,
    age65AddOnDollars: 0,
    seniorBonusDollars: 0,
  });
  const irmaa = (valueDollars: number): IrmaaLimit => ({
    kind: 'irmaa',
    applies: true,
    valueDollars,
    lookbackYear: 2032,
    filingStatus: 'MFJ',
    referenceTier: 'none',
    thresholdDollars: valueDollars,
    scalingFactor: 1,
  });
  const aca = (valueDollars: number): AcaLimit => ({
    kind: 'aca',
    applies: true,
    valueDollars,
    multiple: 4,
    fplDollars: valueDollars / 4,
    householdSize: 2,
    scalingFactor: 1,
    grossSsDollars: 0,
    taxableSsDollars: 0,
    nontaxableSsDollars: 0,
  });
  const off = (kind: 'irmaa' | 'aca'): IrmaaLimit & AcaLimit =>
    ({ kind, applies: false, reason: 'unguarded' }) as IrmaaLimit & AcaLimit;

  it('labels a three-way tie bracket first', () => {
    expect(pickBindingLimit(bracket(100), irmaa(100), aca(100))).toEqual({ limitDollars: 100, binding: 'bracket' });
  });

  it('labels an IRMAA and ACA tie IRMAA', () => {
    expect(pickBindingLimit(bracket(120), irmaa(100), aca(100))).toEqual({ limitDollars: 100, binding: 'irmaa' });
  });

  it('labels the strictly smallest limit', () => {
    expect(pickBindingLimit(bracket(120), irmaa(110), aca(100))).toEqual({ limitDollars: 100, binding: 'aca' });
    expect(pickBindingLimit(bracket(90), irmaa(110), aca(100))).toEqual({ limitDollars: 90, binding: 'bracket' });
  });

  it('ignores a limit that does not apply', () => {
    expect(pickBindingLimit(bracket(120), off('irmaa'), off('aca'))).toEqual({ limitDollars: 120, binding: 'bracket' });
  });
});

describe('deriveYearLimits', () => {
  it('writes the limit less the engine offset, floored at zero, as the ceiling', () => {
    const base = deriveYearLimits(inputs({ facts: facts({ year: 2030 }) }), ENV);
    const shifted = deriveYearLimits(inputs({ facts: facts({ year: 2030 }), engineOffsetDollars: 1_234.6 }), ENV);
    expect(base.ceilingDollars).toBe(base.limitDollars);
    expect(shifted.limitDollars).toBe(base.limitDollars);
    expect(shifted.ceilingDollars).toBe(Math.floor(base.limitDollars - 1_234.6));
    expect(
      deriveYearLimits(inputs({ facts: facts({ year: 2030 }), engineOffsetDollars: 1e9 }), ENV).ceilingDollars,
    ).toBe(0);
  });

  it('never raises the ceiling above the limit for a negative offset', () => {
    const limits = deriveYearLimits(inputs({ facts: facts({ year: 2030 }), engineOffsetDollars: -500 }), ENV);
    expect(limits.engineOffsetDollars).toBe(0);
    expect(limits.ceilingDollars).toBe(limits.limitDollars);
  });
});
