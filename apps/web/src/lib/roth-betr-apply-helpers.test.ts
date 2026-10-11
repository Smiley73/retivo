/**
 * Unit tests for the Roth conversion comparison Apply write-back helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  buildWorkingYearsConversionWindow,
  buildRetirementFillWindow,
} from './roth-betr-apply-helpers';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration-helpers';
import type { ConversionTranche } from './betr-calculator';
import type { ScenarioOverrides } from '../db/types';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;

function tranche(amountCents: number, verdict: 'convert' | 'hold'): ConversionTranche {
  return { amountCents, T_now: 0.22, betr: 0.22, verdict };
}

describe('buildWorkingYearsConversionWindow', () => {
  it('should_sum_only_convert_verdict_tranches_into_annualAmountDollars', () => {
    const win = buildWorkingYearsConversionWindow({
      convertTranches: [
        tranche(20_000_00, 'convert'),
        tranche(30_000_00, 'hold'),
        tranche(5_000_00, 'convert'),
      ],
      sourceAccountId: 'acc-pretax',
      targetRothId: 'acc-roth',
      currentYear: 2026,
      retirementAge: 65,
    });
    expect(win.annualAmountDollars).toBe(25_000);
    expect(win.sourceAccountId).toBe('acc-pretax');
    expect(win.targetRothAccountId).toBe('acc-roth');
    expect(win.start).toEqual({ kind: 'year', year: 2026 });
    expect(win.end).toEqual({ kind: 'age', memberId: 'primary', years: 65, months: 0 });
  });

  it('should_yield_zero_amount_when_no_tranche_is_convert', () => {
    const win = buildWorkingYearsConversionWindow({
      convertTranches: [tranche(20_000_00, 'hold')],
      sourceAccountId: 'a',
      targetRothId: 'r',
      currentYear: 2026,
      retirementAge: 67,
    });
    expect(win.annualAmountDollars).toBe(0);
  });
});

describe('buildRetirementFillWindow', () => {
  const base = {
    ownerBirthYear: 1958, // ≤1959 → trigger age 73
    retirementYear: 2030,
    targetRothId: 'roth-1',
    filingStatus: 'MFJ' as const,
    householdSize: 2,
    inflationRatePct: 0,
    localOverrides: {} as ScenarioOverrides,
    parentCap: undefined,
    bundle: BUNDLE,
  };

  it('should_build_a_fill_window_to_age_73_for_a_born_pre_1960_owner', () => {
    const frag = buildRetirementFillWindow({ ...base, magiLine: 'irmaa' });
    expect('magiCap' in frag && frag.magiCap !== undefined).toBe(true);
    const cap = (frag as { magiCap: { windows: unknown[] } }).magiCap;
    const window = (cap.windows as Array<{
      start: unknown;
      end: unknown;
      capMode: string;
      capMagiLine: string;
      targetRothAccountId?: string;
      magiCeilingAnnualDollars: number;
    }>)[0];
    expect(window.start).toEqual({ kind: 'retirementStart' });
    expect(window.end).toEqual({ kind: 'age', memberId: 'primary', years: 73, months: 0 });
    expect(window.capMode).toBe('fill');
    expect(window.capMagiLine).toBe('irmaa');
    expect(window.targetRothAccountId).toBe('roth-1');
    expect(window.magiCeilingAnnualDollars).toBeGreaterThan(0);
  });

  it('should_use_age_75_for_a_born_1960_or_later_owner', () => {
    const frag = buildRetirementFillWindow({
      ...base,
      ownerBirthYear: 1965,
      magiLine: 'aca',
    });
    const cap = (frag as { magiCap: { windows: Array<{ end: { years: number }; capMagiLine: string }> } }).magiCap;
    expect(cap.windows[0].end.years).toBe(75);
    expect(cap.windows[0].capMagiLine).toBe('aca');
  });

  it('should_price_the_aca_ceiling_above_the_irmaa_ceiling_for_a_2_person_household', () => {
    const irmaa = buildRetirementFillWindow({ ...base, magiLine: 'irmaa' }) as {
      magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> };
    };
    const aca = buildRetirementFillWindow({ ...base, magiLine: 'aca' }) as {
      magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> };
    };
    // IRMAA tier-1 (~$206k MFJ) sits well above 400% FPL for a 2-person
    // household (~$80k), so the two ceilings differ and both are positive.
    expect(irmaa.magiCap.windows[0].magiCeilingAnnualDollars).toBeGreaterThan(0);
    expect(aca.magiCap.windows[0].magiCeilingAnnualDollars).toBeGreaterThan(0);
    expect(irmaa.magiCap.windows[0].magiCeilingAnnualDollars).not.toBe(
      aca.magiCap.windows[0].magiCeilingAnnualDollars,
    );
  });

  it('should_resolve_the_single_irmaa_threshold_for_a_single_filer', () => {
    // The Single IRMAA tier-1 threshold (~$103k) is below the MFJ tier-1
    // (~$206k), so the Single fill ceiling must come in below the MFJ one and
    // exercise the `bySingle` branch of `fillCeilingDollars`.
    const single = buildRetirementFillWindow({
      ...base,
      filingStatus: 'Single',
      householdSize: 1,
      magiLine: 'irmaa',
    }) as { magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> } };
    const mfj = buildRetirementFillWindow({ ...base, magiLine: 'irmaa' }) as {
      magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> };
    };
    expect(single.magiCap.windows[0].magiCeilingAnnualDollars).toBeGreaterThan(0);
    expect(single.magiCap.windows[0].magiCeilingAnnualDollars).toBeLessThan(
      mfj.magiCap.windows[0].magiCeilingAnnualDollars,
    );
  });

  it('should_inflate_the_ceiling_forward_for_a_future_year_with_nonzero_inflation', () => {
    // A retirement year far past the latest IRMAA snapshot key with positive
    // inflation must scale the base-year threshold FORWARD: the future ceiling
    // strictly exceeds the same line at the snapshot base year.
    const future = buildRetirementFillWindow({
      ...base,
      retirementYear: 2050,
      inflationRatePct: 3,
      magiLine: 'irmaa',
    }) as { magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> } };
    const base0 = buildRetirementFillWindow({
      ...base,
      retirementYear: 2030,
      inflationRatePct: 0,
      magiLine: 'irmaa',
    }) as { magiCap: { windows: Array<{ magiCeilingAnnualDollars: number }> } };
    expect(future.magiCap.windows[0].magiCeilingAnnualDollars).toBeGreaterThan(
      base0.magiCap.windows[0].magiCeilingAnnualDollars,
    );
  });

  it('should_preserve_inheritance_by_returning_an_empty_fragment_when_the_draft_equals_the_parent_cap', () => {
    // With no local override and a parent cap whose ladder deep-equals the
    // built fill window, `buildNextMagiCap` omits the key → `{}` (inheritance
    // preserved). Build the window once to capture the exact parent ladder.
    const seed = buildRetirementFillWindow({ ...base, magiLine: 'irmaa' }) as {
      magiCap: { windows: unknown[] };
    };
    const frag = buildRetirementFillWindow({
      ...base,
      magiLine: 'irmaa',
      parentCap: { windows: seed.magiCap.windows } as never,
      localOverrides: {} as ScenarioOverrides,
    });
    expect(frag).toEqual({});
  });
});
