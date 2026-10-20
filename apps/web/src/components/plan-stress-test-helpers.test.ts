/**
 * Unit tests for the pure helpers exported by `PlanStressTestSection` (cache signature, longevity anchor).
 */
import { describe, expect, it } from 'vitest';
import { longestLivedBirthYearOf } from './PlanStressTestSection';
import { taxContextFingerprint } from '../lib/monte-carlo-input-signature';
import type { Aggregate, HouseholdMemberPayload } from '../db/types';


// Hook contract tests live in
// `PlanStressTestSection.hook.test.tsx` — they mock the
// MonteCarloProvider to keep this slot-test file free of worker plumbing.

// ---------------------------------------------------------------------------
// taxContextFingerprint — auto-rerun cache signature
// ---------------------------------------------------------------------------

describe('taxContextFingerprint — every tax-context field reaches the cache signature', () => {
  const bundle = {
    federalTax: { metadata: { asOfDate: '2026-01-01' } },
    irmaa: { metadata: { asOfDate: '2026-01-01' } },
    acaPtc: { metadata: { asOfDate: '2026-01-01' } },
  };
  const baseCtx = {
    taxBundle: bundle,
    filingStatus: 'MFJ',
    householdSize: 2,
    members: [
      { memberId: 'm1', isoBirthdate: '1965-03-15', onMedicare: false, hasAcaCoverage: true },
    ],
  };
  const fp = (ctx: unknown) =>
    JSON.stringify(taxContextFingerprint(ctx as Parameters<typeof taxContextFingerprint>[0]));

  it('returns null for an absent tax context', () => {
    expect(taxContextFingerprint(undefined)).toBeNull();
  });

  it('changes when the health-coverage months change', () => {
    // The Health coverage modal writes this key; a hand-written field list
    // would omit it, so the debounced auto-rerun would never fire and the
    // panel would keep showing pre-edit numbers.
    const before = fp(baseCtx);
    const after = fp({
      ...baseCtx,
      healthCoverageMonths: { perMember: { m1: { 2030: { marketplaceMonths: 7 } } } },
    });
    expect(after).not.toBe(before);
  });

  it('changes when the FPL region or benchmark override changes', () => {
    const before = fp(baseCtx);
    expect(fp({ ...baseCtx, acaFplRegion: 'alaska' })).not.toBe(before);
    expect(
      fp({ ...baseCtx, acaPtcBenchmark: [{ taxYear: 2030, annualSlcspDollars: 12_000 }] }),
    ).not.toBe(before);
  });

  it('changes for a field the old hand-written list also omitted (MAGI bootstrap)', () => {
    expect(fp({ ...baseCtx, magiBootstrapLookbackMinus2: 120_000 })).not.toBe(fp(baseCtx));
  });

  it('is stable for an identical context and ignores the bundle tables beyond their asOfDate', () => {
    expect(fp(baseCtx)).toBe(fp({ ...baseCtx }));
    const otherTables = {
      ...baseCtx,
      taxBundle: {
        federalTax: { metadata: { asOfDate: '2026-01-01' }, values: { 2026: 'ignored' } },
        irmaa: { metadata: { asOfDate: '2026-01-01' } },
        acaPtc: { metadata: { asOfDate: '2026-01-01' } },
      },
    };
    expect(fp(otherTables)).toBe(fp(baseCtx));
    const refreshed = {
      ...baseCtx,
      taxBundle: { ...bundle, irmaa: { metadata: { asOfDate: '2027-01-01' } } },
    };
    expect(fp(refreshed)).not.toBe(fp(baseCtx));
  });
});


// ---------------------------------------------------------------------------
// The longevity cap is anchored on a member birthdate, so what counts as
// a usable one is behaviour
// ---------------------------------------------------------------------------

describe('longestLivedBirthYearOf — only a real calendar birthdate anchors the age-105 cap', () => {
  /** A member aggregate carrying nothing but the birthdate under test. Member
   *  payloads reach this code straight off an IMPORTED workspace bundle, whose
   *  validation covers the envelope and not the field shapes, so the birthdate
   *  really can be any string (or missing entirely). */
  const member = (birthdate: unknown): Aggregate<HouseholdMemberPayload> =>
    ({ id: `m-${String(birthdate)}`, payload: { birthdate } } as unknown as Aggregate<HouseholdMemberPayload>);

  it('returns the YOUNGEST member’s birth year — they are the last one alive', () => {
    expect(longestLivedBirthYearOf([member('1955-04-02'), member('1968-11-30')])).toBe(1968);
    // Order must not matter.
    expect(longestLivedBirthYearOf([member('1968-11-30'), member('1955-04-02')])).toBe(1968);
  });

  it('ignores malformed members and anchors on the youngest VALID one', () => {
    // `9999-12-31` is the dangerous one: a four-leading-digit prefix test
    // accepts it, and being the largest "year" it would WIN the max and push
    // the longevity stress thousands of years past the plan.
    expect(
      longestLivedBirthYearOf([
        member('1968-11-30'),
        member('9999-12-31'),
        member('9999-'),
        member('1955-04-02'),
      ]),
    ).toBe(1968);
  });

  it('rejects an impossible calendar date rather than reading its year prefix', () => {
    // Each of these passes a `^\d{4}` prefix test but names no real day.
    for (const impossible of ['1968-99-99', '1968-13-01', '1968-02-30', '1967-02-29']) {
      expect(longestLivedBirthYearOf([member('1955-04-02'), member(impossible)])).toBe(1955);
    }
  });

  it('rejects an incomplete date, including a bare year', () => {
    for (const incomplete of ['1968', '1968-', '1968-11', '1968-11-3', 'not-a-date']) {
      expect(longestLivedBirthYearOf([member('1955-04-02'), member(incomplete)])).toBe(1955);
    }
  });

  it('returns null when NO member has a usable birthdate, withholding the comparison', () => {
    // `null` is what makes the surface withhold rather than guess an age: a
    // bare `Number('')` would hand the stress the year 0 as its anchor.
    expect(longestLivedBirthYearOf([])).toBeNull();
    expect(longestLivedBirthYearOf([member(''), member('1968'), member(undefined)])).toBeNull();
    expect(longestLivedBirthYearOf([member('9999-12-31'), member('1968-02-30')])).toBeNull();
  });
});
